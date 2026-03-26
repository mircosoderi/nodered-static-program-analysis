"use strict";

const fs = require("fs");
const path = require("path");

module.exports = function createQaRuntime(deps) {
  const RED = deps && deps.RED;
  const urdf = deps && deps.urdf;
  const publish =
    deps && typeof deps.publish === "function" ? deps.publish : function () {};

  const CONFIG_FILENAME = "urdf-template-qa-v1-executable.json";
  const CONFIG_PATH = path.join(__dirname, CONFIG_FILENAME);
  const DEFAULT_ZURL_PATH = process.env.URDF_ZURL_PATH || "/opt/urdf/zurl.json";

  let configCache = null;
  let zurlCache = null;

  function log(level, message) {
    try {
      if (RED && RED.log && typeof RED.log[level] === "function") {
        RED.log[level](message);
      }
    } catch (_) {}
  }

  function loadJsonFile(filePath, fallbackValue) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
      if (fallbackValue !== undefined) {
        log("warn", `[uRDF][qa] Failed to load JSON file ${filePath}: ${e.message}`);
        return fallbackValue;
      }
      throw e;
    }
  }

  function getConfig() {
    if (!configCache) configCache = loadJsonFile(CONFIG_PATH);
    return configCache;
  }

  function getZurl() {
    if (!zurlCache) zurlCache = loadJsonFile(DEFAULT_ZURL_PATH, []);
    return Array.isArray(zurlCache) ? zurlCache : [];
  }

  function getLineBreak() {
    return (getConfig().runtimeResponseContract || {}).lineBreak || "\n";
  }

  function getSectionSeparator() {
    return (getConfig().runtimeResponseContract || {}).sectionSeparator || "\n\n";
  }

  function now() {
    return Date.now();
  }

  function isPlainObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
  }

  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    return [value];
  }

  function expandZToken(value) {
    if (typeof value !== "string") return value;
    const match = /^z:(\d+)$/.exec(value);
    if (!match) return value;
    const iri = getZurl()[Number(match[1])];
    return iri || value;
  }

  function deepExpand(value) {
    if (value == null) return value;

    if (typeof value === "string") return expandZToken(value);

    if (Array.isArray(value)) return value.map(deepExpand);

    if (typeof value === "object" && value.termType === "NamedNode" && typeof value.value === "string") {
      const expandedValue = expandZToken(value.value);
      return expandedValue === value.value ? value : { termType: "NamedNode", value: expandedValue };
    }

    if (typeof value === "object") {
      const out = {};
      for (const key of Object.keys(value)) {
        out[expandZToken(key)] = deepExpand(value[key]);
      }
      return out;
    }

    return value;
  }

  function replaceTokens(text, vars) {
    return String(text).replace(/\{([^}]+)\}/g, function (_, key) {
      const value = vars[key];
      return value == null ? "" : String(value);
    });
  }

  function textResponse(res, status, text) {
    res.status(status);
    res.set("Content-Type", "text/plain; charset=utf-8");
    res.send(text);
  }

  function getTemplateById(templateId) {
    return asArray(getConfig().templates).find(function (template) {
      return template && template.templateId === templateId;
    }) || null;
  }

  function buildValidationError(kind, vars) {
    const cfg = getConfig();
    return replaceTokens(cfg.runtimeRequestContract.validationFailureText[kind], vars || {});
  }

  function normalizeString(value, normalization) {
    let out = String(value == null ? "" : value);
    const norm = normalization || {};
    if (norm.trimWhitespace !== false) out = out.trim();
    if (norm.collapseInternalWhitespace) out = out.replace(/\s+/g, " ");
    if (norm.caseSensitive === false) out = out.toLowerCase();
    return out;
  }

  function resolveMatchingPolicy(ctx, strategyMatching) {
    const cfg = ctx ? ctx.config : getConfig();
    if (!strategyMatching) return null;

    if (strategyMatching.mode && strategyMatching.mode.indexOf("substring_case_insensitive_after_trim") >= 0) {
      return cfg.matchingPolicies && cfg.matchingPolicies.topicLookup;
    }

    return cfg.matchingPolicies && cfg.matchingPolicies.namedEntityResolution;
  }

  function uniqueSortedStrings(values) {
    return Array.from(new Set(values.filter(function (value) {
      return typeof value === "string" && value.length > 0;
    }))).sort(function (a, b) {
      return a.localeCompare(b, undefined, { sensitivity: "base" });
    });
  }

  function mergeNodeInto(target, patch) {
    if (!patch || typeof patch !== "object") return target;

    if (patch["@id"] && !target["@id"]) target["@id"] = patch["@id"];

    if (patch["@type"] != null) {
      const mergedTypes = asArray(target["@type"]).concat(asArray(patch["@type"]));
      target["@type"] = Array.from(new Set(mergedTypes));
    }

    for (const key of Object.keys(patch)) {
      if (key === "@id" || key === "@type") continue;
      target[key] = asArray(target[key]).concat(asArray(patch[key]));
    }

    return target;
  }

  function graphToNormalized(rawGraph) {
    const expandedGraph = deepExpand(Array.isArray(rawGraph) ? rawGraph : []);
    const mergedById = new Map();
    const orderedIds = [];
    const anonymousNodes = [];

    for (const rawNode of expandedGraph) {
      if (!rawNode || typeof rawNode !== "object") continue;

      const normalizedNode = {};
      if (rawNode["@id"] != null) normalizedNode["@id"] = expandZToken(rawNode["@id"]);
      if (rawNode["@type"] != null) normalizedNode["@type"] = asArray(rawNode["@type"]).map(expandZToken);

      for (const key of Object.keys(rawNode)) {
        if (key === "@id" || key === "@type") continue;
        normalizedNode[key] = asArray(rawNode[key]);
      }

      if (normalizedNode["@id"]) {
        if (!mergedById.has(normalizedNode["@id"])) {
          mergedById.set(normalizedNode["@id"], { "@id": normalizedNode["@id"] });
          orderedIds.push(normalizedNode["@id"]);
        }
        mergeNodeInto(mergedById.get(normalizedNode["@id"]), normalizedNode);
      } else {
        anonymousNodes.push(normalizedNode);
      }
    }

    return orderedIds.map(function (id) {
      return mergedById.get(id);
    }).concat(anonymousNodes);
  }

  function createGraphStore(requiredGraphKeys) {
    const cfg = getConfig();
    const graphRegistry = cfg.graphRegistry || {};
    const store = { byKey: {} };

    for (const graphKey of requiredGraphKeys) {
      const gid = graphRegistry[graphKey];
      const rawGraph =
        gid && urdf && typeof urdf.findGraph === "function" ? urdf.findGraph(gid) : [];
      const nodes = graphToNormalized(rawGraph);
      const byId = new Map();

      for (const node of nodes) {
        if (node && node["@id"]) byId.set(node["@id"], node);
      }

      store.byKey[graphKey] = { gid: gid, nodes: nodes, byId: byId };
    }

    return store;
  }

  function hasType(node, classIri) {
    return asArray(node && node["@type"]).includes(classIri);
  }

  function getLiteralStrings(node, predicate) {
    const values = [];
    for (const item of asArray(node && node[predicate])) {
      if (typeof item === "string") {
        values.push(item);
      } else if (isPlainObject(item) && typeof item["@value"] === "string") {
        values.push(item["@value"]);
      } else if (isPlainObject(item) && typeof item.value === "string" && !item.termType) {
        values.push(item.value);
      }
    }
    return values;
  }

  function getFirstLiteral(node, predicate) {
    const values = getLiteralStrings(node, predicate);
    return values.length ? values[0] : null;
  }

  function getRefIds(node, predicate) {
    const values = [];
    for (const item of asArray(node && node[predicate])) {
      if (typeof item === "string") {
        values.push(expandZToken(item));
      } else if (isPlainObject(item) && typeof item["@id"] === "string") {
        values.push(expandZToken(item["@id"]));
      } else if (isPlainObject(item) && item.termType === "NamedNode" && typeof item.value === "string") {
        values.push(expandZToken(item.value));
      }
    }
    return values;
  }

  function getNodeById(ctx, graphKey, id) {
    const graph = ctx.graphs.byKey[graphKey];
    return graph ? graph.byId.get(id) || null : null;
  }

  function getNodesByClass(ctx, graphKey, classIri) {
    const graph = ctx.graphs.byKey[graphKey];
    return graph ? graph.nodes.filter(function (node) {
      return hasType(node, classIri);
    }) : [];
  }

  function getDisplayPolicy(ctx, entityKind) {
    return ctx.config.entityDisplayPolicies[entityKind];
  }

  function resolveEntityDisplayLabel(ctx, entityKind, node) {
    const policy = getDisplayPolicy(ctx, entityKind);
    const schemaName = getFirstLiteral(node, policy.displayNameField);
    const identifier = getFirstLiteral(node, policy.identifierField);
    const nodeType = policy.nodeTypeField ? getFirstLiteral(node, policy.nodeTypeField) : null;

    for (const priority of asArray(policy.displayLabelPriority)) {
      if (priority === "schema:name" && schemaName) return schemaName;
      if (priority === "schema:identifier" && identifier) return identifier;
      if (priority === "nrua:type" && nodeType) return nodeType;
      if (priority === "@id" && node && node["@id"]) return node["@id"];
    }

    return replaceTokens(policy.fallbackDisplayFormat || "{identifier}", {
      identifier: identifier || "-",
      nodeType: nodeType || "-"
    });
  }

  function getFlowNameForNode(ctx, node) {
    const policy = getDisplayPolicy(ctx, "node");
    const flowId = getRefIds(node, policy.flowLinkField)[0];
    if (!flowId) return "-";

    const flowNode = getNodeById(ctx, "application", flowId);
    const flowPolicy = getDisplayPolicy(ctx, "flow");

    return flowNode
      ? getFirstLiteral(flowNode, flowPolicy.displayNameField) || resolveEntityDisplayLabel(ctx, "flow", flowNode)
      : "-";
  }

  function getKeywordsDisplay(node, predicate) {
    const values = uniqueSortedStrings(getLiteralStrings(node, predicate));
    return values.length ? values.join(", ") : "-";
  }

  function getWarningsForSubject(ctx, subjectId) {
    const predicate = ctx.strategy.reasonCollection
      ? ctx.strategy.reasonCollection.warningPredicate
      : ctx.strategy.entitySelection && ctx.strategy.entitySelection.flagPredicate
        ? ctx.strategy.entitySelection.flagPredicate
        : "https://schema.org/comment";

    return uniqueSortedStrings(getLiteralStrings(getNodeById(ctx, "inferred", subjectId), predicate));
  }

  function getSameAsDisplayValues(ctx, subjectId) {
    const sameAsPredicate = "https://schema.org/sameAs";
    const inferredNode = getNodeById(ctx, "inferred", subjectId);
    const sameAsIds = Array.from(new Set(getRefIds(inferredNode, sameAsPredicate)));

    return uniqueSortedStrings(sameAsIds.map(function (targetId) {
      const target = getNodeById(ctx, "application", targetId);
      if (!target) return targetId;

      const nodePolicy = getDisplayPolicy(ctx, "node");
      const flowPolicy = getDisplayPolicy(ctx, "flow");

      if (hasType(target, nodePolicy.entityClass)) return resolveEntityDisplayLabel(ctx, "node", target);
      if (hasType(target, flowPolicy.entityClass)) return resolveEntityDisplayLabel(ctx, "flow", target);
      return targetId;
    }));
  }

  function getSourceKindToGraphKeyMap(ctx) {
    const out = {};
    for (const sourceKind of Object.keys(ctx.config.sourceCatalog || {})) {
      const graphId = ctx.config.sourceCatalog[sourceKind].graphId;
      out[sourceKind] = Object.keys(ctx.config.graphRegistry).find(function (graphKey) {
        return ctx.config.graphRegistry[graphKey] === graphId;
      }) || null;
    }
    return out;
  }

  function getIncludedSourcesForTemplate(ctx) {
    const fixedArgs = (ctx.template.execution && ctx.template.execution.fixedArguments) || {};
    const sourceFilters = (ctx.template.execution && ctx.template.execution.sourceFilters) || [];
    if (Array.isArray(fixedArgs.includedSources) && fixedArgs.includedSources.length) {
      return fixedArgs.includedSources.slice();
    }
    return sourceFilters.slice();
  }

  function getImportedTargetsBySource(ctx, subjectId, includedSources) {
    const joinPredicate =
      (ctx.strategy.joinAndFilter && ctx.strategy.joinAndFilter.joinPredicate) ||
      (ctx.strategy.relatedKnowledgeCounts && ctx.strategy.relatedKnowledgeCounts.joinPredicate) ||
      (ctx.config.matchingPolicies && ctx.config.matchingPolicies.importedKnowledgeJoin && ctx.config.matchingPolicies.importedKnowledgeJoin.predicate) ||
      "https://schema.org/seeAlso";

    const inferredNode = getNodeById(ctx, "inferred", subjectId);
    const seeAlsoIds = Array.from(new Set(getRefIds(inferredNode, joinPredicate)));
    const sourceMap = getSourceKindToGraphKeyMap(ctx);
    const out = {};

    for (const sourceKind of includedSources) {
      out[sourceKind] = [];
      const graphKey = sourceMap[sourceKind];
      const graph = graphKey ? ctx.graphs.byKey[graphKey] : null;
      if (!graph) continue;

      const deduped = new Map();
      for (const targetId of seeAlsoIds) {
        if (graph.byId.has(targetId)) deduped.set(targetId, graph.byId.get(targetId));
      }

      out[sourceKind] = Array.from(deduped.values()).sort(function (a, b) {
        const sourceDef = ctx.config.sourceCatalog[sourceKind];
        const titleA = normalizeString(getFirstLiteral(a, sourceDef.titlePredicate) || "", { trimWhitespace: true, caseSensitive: false });
        const titleB = normalizeString(getFirstLiteral(b, sourceDef.titlePredicate) || "", { trimWhitespace: true, caseSensitive: false });
        if (titleA !== titleB) return titleA.localeCompare(titleB);
        return String(a["@id"] || "").localeCompare(String(b["@id"] || ""));
      });
    }

    return out;
  }

  function getRelatedKnowledgeCounts(ctx, subjectId) {
    const includedSources = ["issues", "forum", "communityFlows"];
    const grouped = getImportedTargetsBySource(ctx, subjectId, includedSources);
    return {
      relatedIssueCount: (grouped.issues || []).length,
      relatedForumCount: (grouped.forum || []).length,
      relatedCommunityFlowCount: (grouped.communityFlows || []).length
    };
  }

  function buildEntityRecord(ctx, entityKind, node) {
    const displayLabel = resolveEntityDisplayLabel(ctx, entityKind, node);
    const policy = getDisplayPolicy(ctx, entityKind);
    const identifier = getFirstLiteral(node, policy.identifierField) || "-";
    const name = getFirstLiteral(node, policy.displayNameField) || displayLabel;

    const record = {
      subjectId: node["@id"],
      displayLabel: displayLabel,
      nameOrDash: name || "-",
      identifier: identifier,
      identifierOrDash: identifier,
      nodeTypeOrDash: "-",
      flowNameOrDash: "-",
      keywordsOrDash: "-",
      warningComments: getWarningsForSubject(ctx, node["@id"]),
      sameAsDisplayValues: getSameAsDisplayValues(ctx, node["@id"])
    };

    if (entityKind === "node") {
      record.nodeTypeOrDash = getFirstLiteral(node, policy.nodeTypeField) || "-";
      record.flowNameOrDash = getFlowNameForNode(ctx, node);
    }

    if (entityKind === "flow") {
      record.keywordsOrDash = getKeywordsDisplay(node, policy.keywordsField);
    }

    return Object.assign(record, getRelatedKnowledgeCounts(ctx, node["@id"]));
  }

  function sortSubjectRecords(records) {
    records.sort(function (a, b) {
      const aLabel = normalizeString(a.displayLabel, { trimWhitespace: true, caseSensitive: false });
      const bLabel = normalizeString(b.displayLabel, { trimWhitespace: true, caseSensitive: false });
      if (aLabel !== bLabel) return aLabel.localeCompare(bLabel);

      const aId = normalizeString(a.identifier || "", { trimWhitespace: true, caseSensitive: false });
      const bId = normalizeString(b.identifier || "", { trimWhitespace: true, caseSensitive: false });
      if (aId !== bId) return aId.localeCompare(bId);

      return String(a.subjectId || "").localeCompare(String(b.subjectId || ""));
    });
    return records;
  }

  function findApplicationEntitiesByName(ctx, entityKind, name) {
    const matching = ctx.strategy.matching || {};
    const globalPolicy = resolveMatchingPolicy(ctx, matching) || {
      field: matching.field || "https://schema.org/name",
      normalization: { trimWhitespace: true, caseSensitive: false, collapseInternalWhitespace: false }
    };

    const candidateClass = matching.candidateClassByEntityKind
      ? matching.candidateClassByEntityKind[entityKind]
      : matching.candidateClass;

    const nodes = getNodesByClass(ctx, matching.sourceGraph || "application", candidateClass);
    const wanted = normalizeString(name, globalPolicy.normalization);

    return sortSubjectRecords(nodes.filter(function (node) {
      return normalizeString(getFirstLiteral(node, globalPolicy.field) || "", globalPolicy.normalization) === wanted;
    }).map(function (node) {
      return buildEntityRecord(ctx, entityKind, node);
    }));
  }

  function findImportedKnowledgeByTopic(ctx, sourceKind, topic) {
    const matching = ctx.strategy.matching || {};
    const globalPolicy = resolveMatchingPolicy(ctx, matching) || {
      normalization: { trimWhitespace: true, caseSensitive: false, collapseInternalWhitespace: false }
    };
    const sourceDef = ctx.config.sourceCatalog[sourceKind];
    const field = (matching.fieldBySource && matching.fieldBySource[sourceKind]) || sourceDef.titlePredicate;
    const candidateClass = (matching.candidateClassBySource && matching.candidateClassBySource[sourceKind]) || sourceDef.entityClass;
    const sourceMap = getSourceKindToGraphKeyMap(ctx);
    const graphKey = sourceMap[sourceKind];
    const graphNodes = getNodesByClass(ctx, graphKey, candidateClass);
    const wanted = normalizeString(topic, globalPolicy.normalization);

    return graphNodes.filter(function (node) {
      const haystack = normalizeString(getFirstLiteral(node, field) || "", globalPolicy.normalization);
      return haystack.includes(wanted);
    }).sort(function (a, b) {
      const titleA = normalizeString(getFirstLiteral(a, sourceDef.titlePredicate) || "", { trimWhitespace: true, caseSensitive: false });
      const titleB = normalizeString(getFirstLiteral(b, sourceDef.titlePredicate) || "", { trimWhitespace: true, caseSensitive: false });
      if (titleA !== titleB) return titleA.localeCompare(titleB);
      return String(a["@id"] || "").localeCompare(String(b["@id"] || ""));
    });
  }

  function validateRequest(body) {
    const templateId = body && typeof body.templateId === "string" ? body.templateId : "";
    const template = getTemplateById(templateId);

    if (!template) {
      return {
        ok: false,
        status: 400,
        text: buildValidationError("unknownTemplateId", { templateId: templateId })
      };
    }

    const providedParameters = isPlainObject(body && body.parameters) ? body.parameters : {};
    const parameterDefinitions = asArray(template.parameterDefinitions);
    const allowedNames = new Set(parameterDefinitions.map(function (def) { return def.name; }));

    for (const providedName of Object.keys(providedParameters)) {
      if (!allowedNames.has(providedName)) {
        return {
          ok: false,
          status: 400,
          text: buildValidationError("unexpectedParameter", {
            parameterName: providedName,
            templateId: template.templateId
          })
        };
      }
    }

    const normalizedParameters = {};
    for (const def of parameterDefinitions) {
      const present = Object.prototype.hasOwnProperty.call(providedParameters, def.name);
      const rawValue = providedParameters[def.name];

      if (def.required && !present) {
        return {
          ok: false,
          status: 400,
          text: buildValidationError("missingParameter", {
            parameterName: def.name,
            templateId: template.templateId
          })
        };
      }

      if (!present) continue;

      if (typeof rawValue !== "string") {
        return {
          ok: false,
          status: 400,
          text: buildValidationError("wrongType", { parameterName: def.name })
        };
      }

      const normalizedValue = def.trimWhitespace ? rawValue.trim() : rawValue;
      if ((def.minLength || 0) > 0 && normalizedValue.length < def.minLength) {
        return {
          ok: false,
          status: 400,
          text: buildValidationError("emptyString", { parameterName: def.name })
        };
      }

      normalizedParameters[def.name] = normalizedValue;
    }

    return { ok: true, template: template, parameters: normalizedParameters };
  }

  function makeStrategyContext(template, requestParameters) {
    const cfg = getConfig();
    const strategyId = template.execution && template.execution.strategyId;
    const strategy = cfg.executionStrategyRegistry && cfg.executionStrategyRegistry[strategyId];
    const parameters = Object.assign({}, (template.execution && template.execution.fixedArguments) || {}, requestParameters);

    for (const paramDef of asArray(strategy && strategy.requiredInputs && strategy.requiredInputs.parameters)) {
      const value = parameters[paramDef.name];

      if (paramDef.type === "enum") {
        if (typeof value !== "string" || !paramDef.allowedValues.includes(value)) {
          throw {
            kind: "validation",
            status: 400,
            text: buildValidationError("invalidEnumValue", {
              parameterName: paramDef.name,
              allowedValues: paramDef.allowedValues.join(", ")
            })
          };
        }
      } else if (paramDef.type === "string") {
        if (typeof value !== "string") {
          throw {
            kind: "validation",
            status: 400,
            text: buildValidationError("wrongType", { parameterName: paramDef.name })
          };
        }

        const trimmed = value.trim();
        if ((paramDef.minLengthAfterTrim || 0) > 0 && trimmed.length < paramDef.minLengthAfterTrim) {
          throw {
            kind: "validation",
            status: 400,
            text: buildValidationError("emptyString", { parameterName: paramDef.name })
          };
        }
        parameters[paramDef.name] = trimmed;
      }
    }

    const requiredGraphKeys = Array.from(new Set(
      asArray(template.execution && template.execution.graphHints).concat(
        asArray(strategy && strategy.requiredInputs && strategy.requiredInputs.graphs)
      )
    ));

    return {
      config: cfg,
      template: template,
      strategy: strategy,
      parameters: parameters,
      graphs: createGraphStore(requiredGraphKeys)
    };
  }

  function renderFlaggedEntityList(ctx, templateId, items, kindOverride) {
    const contract = ctx.config.textAnswerContracts.flagged_entity_list;
    if (!items.length) return replaceTokens(contract.emptyTextsByTemplate[templateId], ctx.parameters);

    const lines = [replaceTokens(contract.headingsByTemplate[templateId], ctx.parameters)];
    for (const item of items) {
      const itemKind = kindOverride || ctx.parameters.entity_kind || item.kind;
      lines.push(replaceTokens(contract.itemFormats[itemKind], item));
    }
    return lines.join(getLineBreak());
  }

  function renderFlaggedEntityExplanation(ctx, templateId, records) {
    const contract = ctx.config.textAnswerContracts.flagged_entity_explanation;
    if (!records.length) return replaceTokens(contract.notFoundTextsByTemplate[templateId], ctx.parameters);

    return records.map(function (record) {
      const lines = [replaceTokens(contract.subjectHeadingsByTemplate[templateId], record)];
      const warningSection = contract.sections[0];

      if (record.warningComments.length) {
        for (const warning of record.warningComments) lines.push("- " + warning);
      } else {
        lines.push(warningSection.emptyBullet);
      }

      const countSection = contract.sections[1];
      lines.push(countSection.heading);
      for (const line of countSection.fixedLines) lines.push(replaceTokens(line, record));
      return lines.join(getLineBreak());
    }).join(contract.subjectBlockSeparator || getSectionSeparator());
  }

  function renderEntityDetail(ctx, templateId, entityKind, records) {
    const contract = ctx.config.textAnswerContracts.entity_detail;
    if (!records.length) return replaceTokens(contract.notFoundTextsByTemplate[templateId], ctx.parameters);

    const sections = contract.sectionsByEntityKind[entityKind];
    return records.map(function (record) {
      const lines = [replaceTokens(contract.subjectHeadingsByTemplate[templateId], record)];

      for (const section of sections) {
        lines.push(section.heading);
        if (section.fixedLines) {
          for (const line of section.fixedLines) lines.push(replaceTokens(line, record));
        } else if (section.bulletListSource) {
          const values = asArray(record[section.bulletListSource]);
          if (values.length) {
            for (const value of values) lines.push("- " + value);
          } else {
            lines.push(section.emptyBullet);
          }
        }
      }

      return lines.join(getLineBreak());
    }).join(contract.subjectBlockSeparator || getSectionSeparator());
  }

  function makeImportedItemRecord(ctx, sourceKind, node) {
    const sourceDef = ctx.config.sourceCatalog[sourceKind];
    return {
      title: getFirstLiteral(node, sourceDef.titlePredicate) || "-",
      urlOrDash: sourceDef.urlPredicate ? getFirstLiteral(node, sourceDef.urlPredicate) || "-" : "-",
      identifierOrDash: sourceDef.identifierPredicate ? getFirstLiteral(node, sourceDef.identifierPredicate) || "-" : "-"
    };
  }

  function renderRelatedKnowledge(ctx, templateId, records, sourceKinds) {
    const contract = ctx.config.textAnswerContracts.related_knowledge;
    if (!records.length) return replaceTokens(contract.notFoundTextsByTemplate[templateId], ctx.parameters);

    return records.map(function (record) {
      const lines = [replaceTokens(contract.subjectHeadingsByTemplate[templateId], record)];
      const grouped = getImportedTargetsBySource(ctx, record.subjectId, sourceKinds);

      for (const sourceKind of sourceKinds) {
        lines.push(contract.sectionHeadings[sourceKind]);
        const items = grouped[sourceKind] || [];

        if (!items.length) {
          lines.push(contract.emptySectionTexts[sourceKind]);
          continue;
        }

        for (const item of items) {
          lines.push(replaceTokens(contract.itemFormats[sourceKind], makeImportedItemRecord(ctx, sourceKind, item)));
        }
      }

      return lines.join(getLineBreak());
    }).join(contract.subjectBlockSeparator || getSectionSeparator());
  }

  function renderCount(ctx, templateId, count) {
    return replaceTokens(ctx.config.textAnswerContracts.count.lineFormatsByTemplate[templateId], { count: count });
  }

  const strategies = {
    list_flagged_entities_by_kind: function (ctx) {
      const selection = ctx.strategy.entitySelection;
      const classIri = selection.applicationEntityClassByEntityKind[ctx.parameters.entity_kind];
      const records = getNodesByClass(ctx, "application", classIri).filter(function (node) {
        return getWarningsForSubject(ctx, node["@id"]).length > 0;
      }).map(function (node) {
        return buildEntityRecord(ctx, ctx.parameters.entity_kind, node);
      });

      return renderFlaggedEntityList(ctx, ctx.template.templateId, sortSubjectRecords(records));
    },

    explain_flagged_entity_by_name: function (ctx) {
      const records = findApplicationEntitiesByName(ctx, ctx.parameters.entity_kind, ctx.parameters.entity_name);
      return renderFlaggedEntityExplanation(ctx, ctx.template.templateId, records);
    },

    describe_entity_by_name: function (ctx) {
      const records = findApplicationEntitiesByName(ctx, ctx.parameters.entity_kind, ctx.parameters.entity_name);
      return renderEntityDetail(ctx, ctx.template.templateId, ctx.parameters.entity_kind, records);
    },

    list_related_imported_knowledge_for_entity_by_name: function (ctx) {
      const records = findApplicationEntitiesByName(ctx, ctx.parameters.entity_kind, ctx.parameters.entity_name);
      return renderRelatedKnowledge(ctx, ctx.template.templateId, records, getIncludedSourcesForTemplate(ctx));
    },

    list_application_flows_with_community_matches: function (ctx) {
      const flowClass = ctx.strategy.selection.candidateClass;
      const communityGraph = ctx.graphs.byKey.importedCommunityFlows;
      const joinPredicate =
        (ctx.config.matchingPolicies && ctx.config.matchingPolicies.importedKnowledgeJoin && ctx.config.matchingPolicies.importedKnowledgeJoin.predicate) ||
        "https://schema.org/seeAlso";

      const records = getNodesByClass(ctx, "application", flowClass).filter(function (flowNode) {
        const seeAlsoIds = Array.from(new Set(getRefIds(getNodeById(ctx, "inferred", flowNode["@id"]), joinPredicate)));
        return seeAlsoIds.some(function (id) { return communityGraph && communityGraph.byId.has(id); });
      }).map(function (node) {
        return buildEntityRecord(ctx, "flow", node);
      });

      // return renderFlaggedEntityList(ctx, ctx.template.templateId, sortSubjectRecords(records));
      return renderFlaggedEntityList(ctx, ctx.template.templateId, sortSubjectRecords(records), "flow");
    },

    show_community_flow_matches_for_flow_by_name: function (ctx) {
      const records = findApplicationEntitiesByName(ctx, "flow", ctx.parameters.flow_name);
      return renderRelatedKnowledge(ctx, ctx.template.templateId, records, ["communityFlows"]);
    },

    count_imported_source_entities: function (ctx) {
      const sourceKind = ctx.parameters.source_kind;
      const sourceDef = ctx.config.sourceCatalog[sourceKind];
      const graphKey = getSourceKindToGraphKeyMap(ctx)[sourceKind];
      const count = getNodesByClass(ctx, graphKey, sourceDef.entityClass).length;
      return renderCount(ctx, ctx.template.templateId, count);
    },

    topic_lookup_imported_knowledge: function (ctx) {
      const sourceKind = ctx.parameters.source_kind;
      const nodes = findImportedKnowledgeByTopic(ctx, sourceKind, ctx.parameters.topic);
      const items = nodes.map(function (node) {
        return Object.assign(
          {
            kind: sourceKind === "forum" ? "forum_post" : sourceKind === "communityFlows" ? "community_flow" : "issue"
          },
          makeImportedItemRecord(ctx, sourceKind, node)
        );
      });

      return renderFlaggedEntityList(
        ctx,
        ctx.template.templateId,
        items,
        items.length ? items[0].kind : (sourceKind === "forum" ? "forum_post" : sourceKind === "communityFlows" ? "community_flow" : "issue")
      );
    }
  };

  async function executeRequest(body) {
    const validated = validateRequest(body);
    if (!validated.ok) return validated;

    try {
      if (!urdf || typeof urdf.findGraph !== "function") {
        return { ok: false, status: 500, text: "uRDF module not loaded." };
      }

      const ctx = makeStrategyContext(validated.template, validated.parameters);
      const strategyId = validated.template.execution.strategyId;
      const strategyFn = strategies[strategyId];

      if (typeof strategyFn !== "function") {
        return {
          ok: false,
          status: 500,
          text: 'QA runtime misconfiguration: unknown strategyId "' + strategyId + '".'
        };
      }

      return { ok: true, status: 200, text: strategyFn(ctx) };
    } catch (e) {
      if (e && e.kind === "validation") {
        return { ok: false, status: e.status || 400, text: e.text };
      }

      const message = e && e.message ? e.message : String(e);
      log("error", "[uRDF][qa] " + message);
      return { ok: false, status: 500, text: "QA runtime error: " + message };
    }
  }

  async function handleHttpRequest(req, res) {
    const ts = now();
    const result = await executeRequest(req && req.body);

    publish({
      ts: ts,
      type: "qa",
      request: {
        method: "POST",
        path: "/urdf/qa",
        summary: req && req.body && req.body.templateId ? String(req.body.templateId) : "missing templateId"
      },
      response: { ok: result.ok, status: result.status }
    });

    return textResponse(res, result.status, result.text);
  }

  return {
    CONFIG_FILENAME: CONFIG_FILENAME,
    executeRequest: executeRequest,
    handleHttpRequest: handleHttpRequest
  };
};
