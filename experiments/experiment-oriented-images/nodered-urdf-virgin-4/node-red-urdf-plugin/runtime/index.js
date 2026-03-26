module.exports = function (RED) {
  "use strict";

  // ============================================================================
  // Runtime plugin entrypoint
  // ============================================================================
  // Node-RED loads this module once at startup. Everything here runs in-process
  // inside Node-RED, so error handling must be defensive: failures should be
  // logged and surfaced, but must not crash the runtime.
  // ============================================================================

  // ----------------------------------------------------------------------------
  // Editor event push channel
  // ----------------------------------------------------------------------------
  // The runtime emits structured events (startup loads, inference, API calls)
  // to the Node-RED editor using RED.comms when available.
  //
  // This creates a "runtime → editor" visibility path without requiring the
  // editor to poll runtime endpoints.
  const TOPIC = "urdf/events";

  const express = require("express");
  const jsonParser = express.json();
  const fs = require("fs");
  const path = require("path");

  // ----------------------------------------------------------------------------
  // Optional reasoning engine (Eyeling)
  // ----------------------------------------------------------------------------
  // Eyeling is treated as an optional dependency: the runtime remains usable
  // without it (e.g., SPARQL-only operation). If Eyeling is missing or does not
  // expose the expected API, N3 execution is skipped and a warning is logged.
  let eyeling;
try {
  eyeling = require("eyeling/eyeling.js");
} catch (e) {
  eyeling = null;
}

if (eyeling && typeof eyeling.reasonStream === "function") {
  RED.log.info("[uRDF] Eyeling reasonStream loaded");
} else {
  RED.log.warn("[uRDF] Eyeling not available (reasonStream missing)");
}

  // ----------------------------------------------------------------------------
  // RDF store (uRDF)
  // ----------------------------------------------------------------------------
  // uRDF provides the in-memory RDF store and the query/load APIs used by all
  // runtime endpoints and by startup loaders. This module is required for the
  // plugin to operate meaningfully.
  let urdf;
  try {
    urdf = require("urdf/src/urdf-module-strict.js");
    RED.log.info("[uRDF] module loaded");
  } catch (e) {
    RED.log.error("[uRDF] failed to load module 'urdf': " + e.message);
  }

  let qaRuntime = null;
  try {
    const createQaRuntime = require("./qa-runtime");
    qaRuntime = createQaRuntime({ RED, urdf, publish });
    RED.log.info("[uRDF] QA runtime loaded");
  } catch (e) {
    RED.log.warn("[uRDF] QA runtime not available: " + e.message);
  }

  // ----------------------------------------------------------------------------
  // Runtime → editor event emitter
  // ----------------------------------------------------------------------------
  // Never allow event-push failures to break the Node-RED runtime.
  // If the comms channel is unavailable (headless deployments), publishing is
  // simply skipped.
  function publish(event) {
    try {
      if (RED.comms && typeof RED.comms.publish === "function") {
        RED.comms.publish(TOPIC, event);
      }
    } catch (_) {
      // Intentionally ignored: observability must not impact availability.
    }
  }

  // ----------------------------------------------------------------------------
  // Local Admin API fetch helper
  // ----------------------------------------------------------------------------
  // This runtime relies on Node-RED's Admin HTTP API to obtain:
  // - diagnostics and settings for environment modeling
  // - /flows for building an application knowledge graph
  //
  // Using localhost HTTP keeps a clean boundary: the runtime consumes the same
  // API an external admin client would, rather than reaching into internals.
  async function fetchAdminJson(path) {
    const port = Number(process.env.PORT || 1880);
    const p = path.startsWith("/") ? path : `/${path}`;
    const url = `http://127.0.0.1:${port}${p}`;

    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(
        `Admin API fetch failed: ${url} -> HTTP ${r.status}${text ? `; body=${text.slice(0, 200)}` : ""}`
      );
    }
    return await r.json();
  }

    // ------------------------------------------------------------------------
    // IRI compress/decompress helpers.
    // ------------------------------------------------------------------------
    function expandCompressedInString(s) {
      if (typeof s !== "string") return s;

      s = s.replace(/<z:(\d+)>/g, (_, n) => {
        const idx = Number(n);
        const iri = ZURL[idx];
        return iri ? `<${iri}>` : `<z:${n}>`;
      });

      s = s.replace(/\bz:(\d+)\b/g, (_, n) => {
        const idx = Number(n);
        const iri = ZURL[idx];
        return iri ? iri : `z:${n}`;
      });

      return s;
    }

    function expandZToken(s) {
      if (typeof s !== "string") return s;
      const m = /^z:(\d+)$/.exec(s);
      if (!m) return s;
      const idx = Number(m[1]);
      const iri = ZURL[idx];
      return iri ? iri : s;
    }

    function expandCompressedQueryDeep(x) {
      if (x == null) return x;

      if (typeof x === "string") return expandCompressedInString(x);

      if (typeof x === "object" && x.termType === "NamedNode" && typeof x.value === "string") {
        const m = /^z:(\d+)$/.exec(x.value);
        if (m) {
          const idx = Number(m[1]);
          const iri = ZURL[idx];
          if (iri) return { termType: "NamedNode", value: iri };
        }
        return { ...x, value: expandCompressedInString(x.value) };
      }

      if (Array.isArray(x)) return x.map(expandCompressedQueryDeep);

      if (typeof x === "object") {
        const out = {};
        for (const k of Object.keys(x)) out[k] = expandCompressedQueryDeep(x[k]);
        return out;
      }

      return x;
    }

function expandCompressedGraphDeep(x) {
  if (x == null) return x;

  if (typeof x === "string") {
    // Expand exact z:N tokens (JSON-LD uses these for @type and predicate keys/ids).
    return expandZToken(x);
  }

  // Expand RDFJS NamedNode terms when present.
  if (typeof x === "object" && x.termType === "NamedNode" && typeof x.value === "string") {
    const expanded = expandZToken(x.value);
    return expanded === x.value ? x : { termType: "NamedNode", value: expanded };
  }

  if (Array.isArray(x)) return x.map(expandCompressedGraphDeep);

  if (typeof x === "object") {
    const out = {};
    for (const k of Object.keys(x)) {
      // Expand predicate keys (e.g., "z:35") to full IRIs.
      const newKey = expandZToken(k);
      out[newKey] = expandCompressedGraphDeep(x[k]);
    }
    return out;
  }

  return x;
}

function rewriteQuery(sparql) {
    const zIndexByIri = new Map();
    for (let i = 0; i < ZURL.length; i++) zIndexByIri.set(ZURL[i], i);
	let rewrittenSparql = sparql;
rewrittenSparql = rewrittenSparql.replace(
  /<([^>\s]+)>/g,
  (match, iri) => {
    const idx = zIndexByIri.get(iri);
    return idx === undefined ? match : `<z:${idx}>`;
  }
);
rewrittenSparql = rewrittenSparql.replace(
  /<z:0>(?=(?:[^()]*\([^()]*\))*[^()]*$)/g,
  "a"
);

return rewrittenSparql;

}

function flattenJsonLd(input) {
  // --- Helpers ---------------------------------------------------------------

  const isObject = (x) => x && typeof x === "object" && !Array.isArray(x);

  const isValueObject = (o) => isObject(o) && ("@value" in o);

  const hasOnlyId = (o) => isObject(o) && typeof o["@id"] === "string" && Object.keys(o).every(k => k === "@id");

  const isNodeLike = (o) => {
    // “node-like” means: not a value object, and has at least @type or a non-@ key
    if (!isObject(o) || isValueObject(o)) return false;
    if (typeof o["@id"] === "string") return true;
    if ("@type" in o) return true;
    return Object.keys(o).some((k) => !k.startsWith("@"));
  };

  // Determine if input is your container shape or a plain graph array
  const containers = Array.isArray(input) ? input : [input];
  const isContainerDoc =
    containers.length > 0 &&
    containers.every(c => isObject(c) && Array.isArray(c["@graph"]));

  const docs = isContainerDoc ? containers : [{ "@graph": containers }];

  // Collect existing ids so we don’t collide when generating _:bX
  const existingIds = new Set();
  for (const d of docs) {
    for (const n of d["@graph"]) {
      if (isObject(n) && typeof n["@id"] === "string") existingIds.add(n["@id"]);
    }
  }

  let bCounter = 0;
  const newBNodeId = () => {
    let id;
    do { id = `_:b${bCounter++}`; } while (existingIds.has(id));
    existingIds.add(id);
    return id;
  };

  // Graph accumulator (preserve order: existing first, newly extracted later)
  const nodesById = new Map();
  const order = [];

  const ensureNode = (id) => {
    if (!nodesById.has(id)) {
      nodesById.set(id, { "@id": id });
      order.push(id);
    }
    return nodesById.get(id);
  };

  // Merge: arrays get concatenated; scalars overwritten only if target missing
  const mergeNode = (id, patch) => {
    const tgt = ensureNode(id);
    for (const [k, v] of Object.entries(patch)) {
      if (k === "@id") continue;

      if (Array.isArray(tgt[k]) && Array.isArray(v)) {
        tgt[k] = tgt[k].concat(v);
      } else if (tgt[k] === undefined) {
        tgt[k] = v;
      } else {
        // keep existing by default (conservative)
      }
    }
  };

  // Normalize @type to array form
  const normalizeType = (t) => {
    if (typeof t === "string") return [t];
    if (Array.isArray(t)) return t.filter(x => typeof x === "string");
    return undefined;
  };

  // Normalize a predicate object value into your canonical item object
  const normalizeItem = (item) => {
    // Keep proper value objects as-is
    if (isValueObject(item)) return item;

    // If it's a ref object {"@id": "..."} keep as-is
    if (hasOnlyId(item)) return item;

    // If it's node-like (embedded) => extract node and return {"@id": "..."}
    if (isNodeLike(item)) {
      const id = typeof item["@id"] === "string" ? item["@id"] : newBNodeId();
      const normalizedNode = normalizeNode({ ...item, "@id": id });
      mergeNode(id, normalizedNode);
      return { "@id": id };
    }

    // Scalars become value objects
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      return { "@value": item };
    }

    // null / other: keep as a value object-ish (rare)
    return { "@value": item };
  };

  // Normalize predicate value to array-of-items
  const normalizePredicateValue = (v) => {
    if (Array.isArray(v)) return v.map(normalizeItem);
    return [normalizeItem(v)];
  };

  // Normalize a node object to your convention (does not require it was already extracted)
  const normalizeNode = (node) => {
    const out = { "@id": node["@id"] };

    for (const [k, v] of Object.entries(node)) {
      if (k === "@id") continue;

      if (k === "@type") {
        const t = normalizeType(v);
        if (t && t.length) out["@type"] = t;
        continue;
      }

      // JSON-LD keywords other than @id/@type: keep (rare in your data)
      if (k.startsWith("@")) {
        out[k] = v;
        continue;
      }

      // All predicates normalized to array of objects
      out[k] = normalizePredicateValue(v);
    }

    return out;
  };

  // Walk the graph and extract nodes
  const processTopLevelNode = (n) => {
    if (!isObject(n) || typeof n["@id"] !== "string") return;
    const id = n["@id"];
    const normalized = normalizeNode(n);
    mergeNode(id, normalized);
  };

  // --- Execute for each doc --------------------------------------------------

  const outputs = docs.map((doc) => {
    nodesById.clear();
    order.length = 0;

    // First pass: seed top-level nodes in original order
    for (const n of doc["@graph"]) processTopLevelNode(n);

    // Output as a graph array
    const flattenedGraph = order.map((id) => nodesById.get(id));

    // Return in the same wrapping shape as input
    if (isContainerDoc) {
      return { ...doc, "@graph": flattenedGraph };
    }
    return flattenedGraph;
  });

  return isContainerDoc ? outputs : outputs[0];
}

function compressGraph(input) {
  if (!Array.isArray(ZURL)) {
    throw new Error("ZURL must be an array of IRIs (strings).");
  }

  // Build stable IRI -> index map (first occurrence wins)
  const iriMap = new Map();
  for (let i = 0; i < ZURL.length; i++) {
    const iri = ZURL[i];
    if (typeof iri === "string" && !iriMap.has(iri)) iriMap.set(iri, i);
  }

  const toZ = (iri) => {
    const idx = iriMap.get(iri);
    return idx === undefined ? iri : `z:${idx}`;
  };

  const transform = (node) => {
    if (Array.isArray(node)) return node.map(transform);

    if (node && typeof node === "object") {
      const out = {};
      for (const [key, value] of Object.entries(node)) {
        // Rewrite predicate keys unless JSON-LD keyword
        const newKey = key.startsWith("@") ? key : toZ(key);

        if (key === "@type") {
          if (typeof value === "string") out[newKey] = toZ(value);
          else if (Array.isArray(value)) {
            out[newKey] = value.map((t) => (typeof t === "string" ? toZ(t) : t));
          } else {
            out[newKey] = value;
          }
          continue;
        }

        if (key === "@id" && typeof value === "string") {
          out[newKey] = toZ(value);
          continue;
        }

        // Recurse into objects/arrays; leave primitives untouched
        if (value && typeof value === "object") {
          out[newKey] = transform(value);
        } else {
          out[newKey] = value;
        }
      }
      return out;
    }

    // primitives unchanged
    return node;
  };

  return transform(input);
}

  // ----------------------------------------------------------------------------
  // Startup loader: zurl
  // ----------------------------------------------------------------------------

  let ZURL = [];

  async function loadZurlJsonOnStartup() {
    try {
      const filePath = process.env.URDF_ZURL_PATH || "/opt/urdf/zurl.json";
      ZURL = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!Array.isArray(ZURL)) {
        throw new Error("[uRDF] ZURL list must be a JSON array.");
      }
      else {
        RED.log.info("[uRDF] ZURL list loaded from " + filePath);
      }
    } catch (err) {
      RED.log.error(`[uRDF] Failed to load ZURL list: ${err.message}`);
      ZURL = [];
    }
  }

  loadZurlJsonOnStartup();

  function z(iri) { 
    if(ZURL.includes(iri)) return "z:"+ZURL.indexOf(iri);
    else return iri;
  }

  RED.httpAdmin.get(
    "/urdf/zurl",
    (req, res) => {
      res.set("Content-Type", "application/json; charset=utf-8");
      res.status(200).json(ZURL);
    }
  );

async function urdfQueryViaPluginApiContract(sparql) {
  const ts = now();

  if (!sparql || typeof sparql !== "string" || !sparql.trim()) {
    return { ok: false, ts, error: 'Body must be JSON: { "sparql": "..." }' };
  }

  const summary = summarizeSparql(sparql);

  try {
    const rewritten = (ZMAP && ZMAP.size > 0)
      ? rewriteSparqlPredicatesAndTypes(sparql, ZMAP)
      : sparql;

    const result = await urdf.query(rewritten);

    const payload =
      typeof result === "boolean"
        ? { ok: true, ts, type: "ASK", result }
        : { ok: true, ts, type: "SELECT", results: result };

    // Keep your existing publish/log behavior consistent
    publish({
      ts,
      type: "query",
      request: { method: "POST", path: "/urdf/query", summary },
      response: payload
    });

    return payload;
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    const payload = { ok: false, ts, error: message };

    publish({
      ts,
      type: "query",
      request: { method: "POST", path: "/urdf/query", summary },
      response: payload
    });

    return payload;
  }
}


  // ----------------------------------------------------------------------------
  // Startup loader: ontology graph
  // ----------------------------------------------------------------------------
  // On container start, a default ontology (JSON-LD) can be loaded into a named
  // graph to bootstrap the knowledge base.
  //
  // - URDF_ONTOLOGY_PATH selects the source file
  // - URDF_ONTOLOGY_GID selects the target named graph id (gid)
  //
  // This loader is designed to be safe:
  // - missing files are not fatal
  // - parse/load errors are logged
  // - success is published to the editor event channel
  async function loadOntologyJsonLdOnStartup() {
    if (!urdf) return;

    const filePath = process.env.URDF_ONTOLOGY_PATH || "/opt/urdf/nodered-user-application-ontology.jsonld";
    const gid = z(process.env.URDF_ONTOLOGY_GID || "urn:nrua:ontology");

    if (!fs.existsSync(filePath)) {
      RED.log.warn("[uRDF] Ontology file not found: " + filePath);
      return;
    }

    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const doc = flattenJsonLd(compressGraph(JSON.parse(raw)));

      let dataset;

      if (Array.isArray(doc)) {
        // If it's [ { "@graph": [...] } ] already, keep it (and optionally enforce gid)
        if (doc.length === 1 && doc[0] && typeof doc[0] === "object" && "@graph" in doc[0]) {
          dataset = [{ ...doc[0], "@id": gid }];
        } else {
          // It's an array of nodes -> wrap into one graph object, then wrap in dataset array
          dataset = [{ "@id": gid, "@graph": doc }];
        }
      } else {
        // It's a single object -> ensure it becomes a graph object and then dataset array
        if ("@graph" in doc) dataset = [{ ...doc, "@id": gid }];
        else dataset = [{ "@id": gid, "@graph": [doc] }];
      }

      await urdf.load(dataset);

      RED.log.info("[uRDF] Ontology JSON-LD loaded into gid=" + gid + " from " + filePath);

      publish({
        ts: Date.now(),
        type: "startupLoad",
        request: { method: "INIT", path: "ontology", summary: filePath },
        response: { ok: true, gid, filePath, totalSize: urdf.size() }
      });
    } catch (e) {
      RED.log.error("[uRDF] Failed to load ontology JSON-LD: " + (e?.message || String(e)));
    }
  }

  loadOntologyJsonLdOnStartup();

  // ----------------------------------------------------------------------------
  // Startup loader: rules graph
  // ----------------------------------------------------------------------------
  // On container start, a default rule set (JSON-LD) can be loaded into a named
  // graph. These rule resources are later read by the inference orchestration.
  //
  // - URDF_RULES_PATH selects the source file
  // - URDF_RULES_GID selects the target named graph id (gid)
async function loadRulesJsonLdOnStartup() {
  if (!urdf) return;

  const filePath = process.env.URDF_RULES_PATH || "/opt/urdf/rules.jsonld";
  const gid = z(process.env.URDF_RULES_GID || "urn:nrua:rules");

  if (!fs.existsSync(filePath)) {
    RED.log.warn("[uRDF] Rules file not found: " + filePath);
    return;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const doc = flattenJsonLd(compressGraph(JSON.parse(raw)));

    let dataset;

    // [ { @id, @graph } ] : pass-through
    if (
      Array.isArray(doc) &&
      doc.length === 1 &&
      doc[0] &&
      typeof doc[0] === "object" &&
      Array.isArray(doc[0]["@graph"])
    ) {
      dataset = doc; // keep as-is
    }
    // { @id, @graph } : wrap
    else if (doc && typeof doc === "object" && Array.isArray(doc["@graph"])) {
      dataset = [doc];
    }
    // nodes[] or single node: wrap into gid graph
    else {
      const graphNodes = Array.isArray(doc) ? doc : [doc];
      dataset = [{ "@id": gid, "@graph": graphNodes }];
    }

    await urdf.load(dataset);

    const loadedGid = dataset?.[0]?.["@id"] ?? gid;
    RED.log.info("[uRDF] Rules JSON-LD loaded into gid=" + loadedGid + " from " + filePath);

    publish({
      ts: Date.now(),
      type: "startupLoad",
      request: { method: "INIT", path: "rules", summary: filePath },
      response: { ok: true, gid: loadedGid, filePath, totalSize: urdf.size() }
    });
  } catch (e) {
    RED.log.error("[uRDF] Failed to load rules JSON-LD: " + (e?.message || String(e)));
  }
}

  loadRulesJsonLdOnStartup();

  // ----------------------------------------------------------------------------
  // Startup loader: runtime environment model (from Node-RED Admin API)
  // ----------------------------------------------------------------------------
  // This section builds a small "environment knowledge graph" that describes:
  // - the Operating System details (platform/release/containerised/etc.)
  // - the Node.js runtime version
  // - the Node-RED runtime version
  //
  // The data source is the local Node-RED Admin API:
  //   - GET /diagnostics
  //   - GET /settings
  //
  // Because the plugin is loaded during Node-RED startup, those endpoints may
  // not be immediately reachable. The loader therefore includes a retry loop
  // that waits until the Admin API is ready.
  const NRUA = "https://w3id.org/nodered-ontology-based-program-analysis/nodered-user-application-ontology#";
  const SCHEMA = "https://schema.org/";
  const GID_ENV = z(process.env.URDF_ENV_GID || "urn:nrua:env");

  // ----------------------------------------------------------------------------
  // Small helpers used by the environment mapping
  // ----------------------------------------------------------------------------
  function notUnset(v) {
    return typeof v !== "undefined" && v !== null && v !== "UNSET";
  }

  // Deterministic JSON serialization helper (stable key ordering).
  // Note: kept as-is even if not used elsewhere, to preserve behavior and
  // because it may be referenced in future extensions.
  function stableJson(obj) {
    if (!obj || typeof obj !== "object") return JSON.stringify(obj);
    const out = {};
    Object.keys(obj)
      .sort()
      .forEach((k) => {
        out[k] = obj[k];
      });
    return JSON.stringify(out);
  }

  // ----------------------------------------------------------------------------
  // Build JSON-LD environment graph
  // ----------------------------------------------------------------------------
  // Converts Node-RED Admin API responses into a JSON-LD document that can be
  // loaded into uRDF as a named graph. The model uses:
  // - schema.org types/properties for broadly understandable runtime metadata
  // - NRUA-specific types for Node-RED / Node.js concepts
  //
  // The returned document is shaped as:
  //   { "@context": ..., "@id": <GID_ENV>, "@graph": [ ...nodes... ] }
function buildEnvJsonLdFromAdmin({ diagnostics, settings }) {
  const osId = "n:os";
  const nodeJsId = "n:njs";
  const nodeRedId = "n:nr";

  const d = diagnostics || {};
  const s = settings || {};

  const osInfo = d.os || {};
  const nodeInfo = d.nodejs || {};
  const rt = d.runtime || {};
  const rtSettings = rt.settings && typeof rt.settings === "object" ? rt.settings : {};

  const graph = [];

  graph.push({
    "@id": osId,
    "@type": [z("https://schema.org/OperatingSystem")],
    ...(notUnset(osInfo.platform)
      ? { [z("https://schema.org/name")]: [{ "@value": String(osInfo.platform) }] }
      : {}),
    ...(notUnset(osInfo.release)
      ? { [z("https://schema.org/softwareVersion")]: [{ "@value": String(osInfo.release) }] }
      : {}),
    ...(notUnset(osInfo.version)
      ? { [z("https://schema.org/description")]: [{ "@value": String(osInfo.version) }] }
      : {}),
    ...(typeof osInfo.containerised === "boolean"
      ? {
          [z("https://w3id.org/nodered-ontology-based-program-analysis/nodered-user-application-ontology#isContainerised")]:
            [{ "@value": osInfo.containerised }]
        }
      : {}),
    ...(typeof osInfo.wsl === "boolean"
      ? {
          [z("https://w3id.org/nodered-ontology-based-program-analysis/nodered-user-application-ontology#isWsl")]:
            [{ "@value": osInfo.wsl }]
        }
      : {})
  });

  graph.push({
    "@id": nodeJsId,
    "@type": [z("https://w3id.org/nodered-ontology-based-program-analysis/nodered-user-application-ontology#NodeJs")],
    ...(notUnset(nodeInfo.version)
      ? { [z("https://schema.org/version")]: [{ "@value": String(nodeInfo.version) }] }
      : {}),
    [z("https://schema.org/operatingSystem")]: [{ "@id": osId }]
  });

  graph.push({
    "@id": nodeRedId,
    "@type": [z("https://w3id.org/nodered-ontology-based-program-analysis/nodered-user-application-ontology#NodeRed")],
    ...(notUnset(rt.version)
      ? { [z("https://schema.org/version")]: [{ "@value": String(rt.version) }] }
      : {}),
    [z("https://schema.org/runtimePlatform")]: [{ "@id": nodeJsId }]
  });

  return [
    {
      "@context": {},
      "@id": GID_ENV,
      "@graph": graph
    }
  ];
}

  // ----------------------------------------------------------------------------
  // Load environment graph into uRDF
  // ----------------------------------------------------------------------------
  // Reads Admin API JSON, builds the JSON-LD environment document, loads it into
  // uRDF, then publishes an event for observability.
  async function loadEnvironmentOnStartupFromAdminApi() {
    if (!urdf) return;

    const ts = Date.now();
    try {
      const diagnostics = await fetchAdminJson("/diagnostics");
      const settings = await fetchAdminJson("/settings");

      const envDoc = buildEnvJsonLdFromAdmin({ diagnostics, settings });
      await urdf.load(envDoc);

      const payload = { ok: true, ts, gid: GID_ENV, size: urdf.size(GID_ENV), totalSize: urdf.size() };
      publish({
        ts,
        type: "envLoad",
        request: { method: "INIT", path: "env", summary: "from /diagnostics + /settings" },
        response: payload
      });
      RED.log.info("[uRDF] Environment loaded from Node-RED Admin API into gid=" + GID_ENV);
    } catch (e) {
      const payload = { ok: false, ts, gid: GID_ENV, error: e?.message || String(e) };
      publish({
        ts,
        type: "envLoad",
        request: { method: "INIT", path: "env", summary: "from /diagnostics + /settings" },
        response: payload
      });
      RED.log.error("[uRDF] Environment load failed: " + payload.error);
      RED.log.error(
        "[uRDF] fetch error details: " +
          JSON.stringify({ message: e?.message, cause: e?.cause ? String(e.cause) : undefined })
      );
    }
  }

  // ----------------------------------------------------------------------------
  // Admin API readiness wait loop
  // ----------------------------------------------------------------------------
  // The Admin API may not be available at the instant this plugin is loaded.
  // This loop probes /diagnostics until it is reachable, then performs the
  // environment load exactly once.
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function loadEnvironmentWhenAdminApiReady() {
    const ts0 = Date.now();
    const maxAttempts = 30;
    const delayMs = 1000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await fetchAdminJson("/diagnostics");
        await loadEnvironmentOnStartupFromAdminApi();
        RED.log.info(`[uRDF] Environment load succeeded after attempt ${attempt} (${Date.now() - ts0}ms)`);
        return;
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        RED.log.warn(`[uRDF] Env load attempt ${attempt}/${maxAttempts} failed: ${msg}`);
        await sleep(delayMs);
      }
    }
    RED.log.error("[uRDF] Env load aborted: Admin API never became reachable");
  }

  loadEnvironmentWhenAdminApiReady();

  // ----------------------------------------------------------------------------
  // Inference and rules management
  // ----------------------------------------------------------------------------
  // This section provides the "bridge layer" between:
  //   - uRDF: storage, named graphs, SPARQL querying
  //   - eyeling: N3 rule execution (optional)
  //
  // The key output is an "inferred" named graph rebuilt deterministically from:
  //   - rules stored in GID_RULES
  //   - facts computed either via SPARQL (direct) or via N3 reasoning (eyeling)
  //
  // Note: the actual orchestration that executes rules and replaces the inferred
  // graph appears later; this chunk focuses on the utilities and rule decoding.

  const GID_RULES = z(process.env.URDF_RULES_GID || "urn:nrua:rules");
  const GID_INFERRED = z(process.env.URDF_INFERRED_GID || "urn:graph:inferred");

  // ----------------------------------------------------------------------------
  // Rule encoding vocabulary (schema.org + NRUA)
  // ----------------------------------------------------------------------------
  // Rules are represented as JSON-LD resources of type NRUA_RULE.
  // Their executable program is stored in schema:text, and metadata indicates
  // the "language" and "format" of that program. Some rules may also contain
  // parts (schema:hasPart) to store auxiliary code such as a projection query.
  const SCHEMA_TEXT = z("https://schema.org/text");
  const NRUA_RULE = "https://w3id.org/nodered-ontology-based-program-analysis/nodered-user-application-ontology#Rule";
  const SCHEMA_PROGRAMMING_LANGUAGE = z("https://schema.org/programmingLanguage");
  const SCHEMA_ENCODING_FORMAT = z("https://schema.org/encodingFormat");
  const SCHEMA_HASPART = z("https://schema.org/hasPart");
  const SCHEMA_SOFTWARE_SOURCE_CODE = z("https://schema.org/SoftwareSourceCode");

  // ----------------------------------------------------------------------------
  // Eyeling output normalization
  // ----------------------------------------------------------------------------
  // Eyeling emits derived facts through callbacks. The values representing
  // literals may arrive as quoted N3-like strings (e.g. "\"Flow 1\"").
  // These helpers normalize those shapes into JSON-LD objects suitable for
  // loading into uRDF.
function stripN3Quotes(v) {
  if (typeof v !== "string") return String(v ?? "");

  const s = v.trim();

  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    const inner = s.slice(1, -1);
    return inner
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t");
  }

  return s;
}

function looksLikeIri(v) {
  return typeof v === "string" && (v.startsWith("urn:") || v.startsWith("http://") || v.startsWith("https://") || v.startsWith("_:"));
}

function eyelingDfToSpo(df) {
  const f = df && df.fact;
  const s = f && f.s && f.s.value;
  const p = f && f.p && f.p.value;
  const o = f && f.o && f.o.value;

  if (!s || !p || o == null) return null;
  return { s, p, o };
}

function eyelingObjectToJsonLd(oVal) {
  if (looksLikeIri(oVal)) return { "@id": oVal };
  return { "@value": stripN3Quotes(oVal) };
}

  // ----------------------------------------------------------------------------
  // RDFJS term -> JSON-LD conversion
  // ----------------------------------------------------------------------------
  // Some uRDF or binding paths can expose RDFJS-like terms. This conversion
  // preserves:
  // - IRIs as {"@id": "..."}
  // - Blank nodes as {"@id": "_:..."}
  // - Literals with language or datatype annotations when present
function rdfjsTermToJsonLd(term) {
  if (!term || typeof term !== "object") {
    throw new Error("Invalid RDFJS term: " + JSON.stringify(term));
  }

  if (term.termType === "NamedNode") {
    return { "@id": term.value };
  }

  if (term.termType === "BlankNode") {
    return { "@id": "_:" + term.value };
  }

  if (term.termType === "Literal") {
    const out = { "@value": term.value };

    if (term.language) {
      out["@language"] = term.language;
    } else if (term.datatype && term.datatype.value && term.datatype.value !== z("http://www.w3.org/2001/XMLSchema#string")) {
      out["@type"] = term.datatype.value;
    }

    return out;
  }

  throw new Error("Unsupported RDFJS termType: " + term.termType);
}

  // ----------------------------------------------------------------------------
  // JSON-LD graph assembly helper
  // ----------------------------------------------------------------------------
  // Inference results are assembled by grouping triples by subject into JSON-LD
  // node objects. This helper ensures:
  // - each subject node exists once
  // - predicate values are stored as arrays (JSON-LD multi-valued properties)
function addToBySubject(bySubject, sId, pIri, oJsonLd) {
  let node = bySubject.get(sId);
  if (!node) {
    node = { "@id": sId };
    bySubject.set(sId, node);
  }
  if (!node[pIri]) node[pIri] = [];
  node[pIri].push(oJsonLd);
}

  // ----------------------------------------------------------------------------
  // SPARQL binding -> N-Triples serialization (for Eyeling input)
  // ----------------------------------------------------------------------------
  // The N3 execution path uses a two-step approach:
  //   1) run a SPARQL "projection" query over uRDF to produce a set of facts
  //   2) serialize those facts as N-Triples lines
  //   3) concatenate facts + the N3 program text and pass it to eyeling
  //
  // These functions normalize common binding shapes into N-Triples safely.
function escapeNTriplesString(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function termToNTriples(term) {
  if (term == null) throw new Error("Null term");

  if (typeof term === "object") {
    const t = (term.type || "").toLowerCase();
    const v = term.value;

    if (t === "uri") {
      if (!v) throw new Error("URI term missing value");
      return `<${v}>`;
    }

    if (t === "bnode" || t === "blanknode") {
      if (!v) throw new Error("Blank node term missing value");
      return v.startsWith("_:") ? v : `_:${v}`;
    }

    if (t === "literal") {
      const lex = escapeNTriplesString(v ?? "");
      if (term["xml:lang"] || term.lang) {
        const lang = term["xml:lang"] || term.lang;
        return `"${lex}"@${lang}`;
      }
      if (term.datatype) {
        return `"${lex}"^^<${term.datatype}>`;
      }
      return `"${lex}"`;
    }

    if (typeof term["@id"] === "string") {
      const id = term["@id"];
      if (id.startsWith("_:")) return id;
      return `<${id}>`;
    }
  }

  if (typeof term === "string") {
    if (term.startsWith("_:")) return term;
    return `<${term}>`;
  }

  throw new Error("Unsupported term shape: " + JSON.stringify(term));
}

function bindingToNTripleLine(b) {
  const s = termToNTriples(b.s);
  const p = termToNTriples(b.p);
  const o = termToNTriples(b.o);
  return `${s} ${p} ${o} .`;
}

function normalizeQueryResults(qres) {
  if (Array.isArray(qres)) return qres;
  if (qres && Array.isArray(qres.results)) return qres.results;
  return [];
}

function hasSpo(binding) {
  if (!binding || typeof binding !== "object") return false;
  return binding.s != null && binding.p != null && binding.o != null;
}

  // ----------------------------------------------------------------------------
  // Rule decoding helpers
  // ----------------------------------------------------------------------------
  // Rules can be executed in two main modes:
  //   - SPARQL: schema:text contains a SPARQL query, executed directly via urdf.query
  //   - N3: schema:text contains a Notation3 program executed by eyeling
  //
  // For N3 rules, an additional SPARQL "projection" query is expected in a part
  // resource referenced by schema:hasPart. That query is executed to generate
  // the facts passed as input to the N3 program.
function normalizeLang(x) {
  if (!x) return "";
  return String(x).trim().toLowerCase();
}

function isN3Rule(rule) {
  const lang = normalizeLang(getPropFirstValue(rule, expandZToken(SCHEMA_PROGRAMMING_LANGUAGE)));
  const fmt  = normalizeLang(getPropFirstValue(rule, expandZToken(SCHEMA_ENCODING_FORMAT)));

  return (
    lang === "n3" ||
    lang === "notation3" ||
    lang.includes("n3") ||
    fmt.includes("n3") ||
    fmt.includes("notation3")
  );
}

function extractN3ProjectionSparql(rule, nodesById) {
  const parts = rule && rule[expandZToken(SCHEMA_HASPART)];
  if (!Array.isArray(parts) || parts.length === 0) return undefined;

  for (const partRef of parts) {
    if (!partRef || typeof partRef !== "object") continue;

    let part = partRef;
    const pid = partRef["@id"];
    if (pid && nodesById && nodesById.has(pid)) {
      part = nodesById.get(pid);
    }

    const pl = normalizeLang(getPropFirstValue(part, expandZToken(SCHEMA_PROGRAMMING_LANGUAGE)));
    const types = part["@type"];
    const t = Array.isArray(types) ? types : (types ? [types] : []);
    const hasSoftwareSourceCodeType = t.includes(expandZToken(SCHEMA_SOFTWARE_SOURCE_CODE));

    if (hasSoftwareSourceCodeType || pl === "sparql") {
      const q = getPropFirstValue(part, expandZToken(SCHEMA_TEXT));
      if (typeof q === "string" && q.trim()) return q;
    }
  }
  return undefined;
}

function getPropFirstValue(node, iri) {
  const arr = node && node[iri];
  if (!Array.isArray(arr) || arr.length === 0) return undefined;
  const v = arr[0];
  if (v && typeof v === "object") {
    if (typeof v["@value"] !== "undefined") return v["@value"];
    if (typeof v["@id"] !== "undefined") return v["@id"];
  }
  return v;
}

  // ----------------------------------------------------------------------------
  // SPARQL binding normalization to JSON-LD
  // ----------------------------------------------------------------------------
  // In the SPARQL rule path, urdf.query results are interpreted as bindings for
  // {s,p,o}. These helpers normalize the different shapes seen in practice into:
  // - a subject IRI (string)
  // - a predicate IRI (string)
  // - an object as JSON-LD ({ "@id": ... } or { "@value": ... } ...)
function bindingToJsonLdObject(term) {
  if (term == null) return null;

  if (typeof term === "string") {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(term)) return { "@id": term };
    return { "@value": term };
  }

  if (typeof term === "object") {
    if (term.termType === "NamedNode") return { "@id": term.value };
    if (term.termType === "BlankNode") return { "@id": "_:" + term.value };
    if (term.termType === "Literal") {
      const lit = { "@value": term.value };
      if (term.language) lit["@language"] = term.language;
      const dt = term.datatype && (term.datatype.value || term.datatype);
      if (dt && typeof dt === "string" && dt !== "http://www.w3.org/2001/XMLSchema#string") {
        lit["@type"] = dt;
      }
      return lit;
    }

    const value = term.value ?? term["@value"] ?? term["@id"];
    const type = term.type;
    if (type === "uri") return { "@id": value };
    if (type === "bnode") return { "@id": "_:" + value };
    if (type === "literal") {
      const lit = { "@value": value };
      if (term["xml:lang"]) lit["@language"] = term["xml:lang"];
      if (term.datatype && term.datatype !== "http://www.w3.org/2001/XMLSchema#string") lit["@type"] = term.datatype;
      return lit;
    }

    if (typeof term["@id"] === "string") return { "@id": term["@id"] };
    if (typeof term["@value"] !== "undefined") {
      const lit = { "@value": term["@value"] };
      if (term["@language"]) lit["@language"] = term["@language"];
      if (term["@type"]) lit["@type"] = term["@type"];
      return lit;
    }

    if (typeof value === "string") {
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return { "@id": value };
      return { "@value": value };
    }
  }

  return { "@value": String(term) };
}

function bindingToIri(term) {
  if (term == null) return null;
  if (typeof term === "string") return term;
  if (typeof term === "object") {
    if (term.termType === "NamedNode") return term.value;
    if (term.type === "uri") return term.value;
    if (typeof term["@id"] === "string") return term["@id"];
    if (typeof term.value === "string") return term.value;
  }
  return null;
}

  // ----------------------------------------------------------------------------
  // Inference orchestration: rebuild inferred graph from rules
  // ----------------------------------------------------------------------------
  // This function recomputes the inferred knowledge graph deterministically.
  //
  // Inputs:
  //   - Rules are read from the named graph GID_RULES
  //   - Facts are read from the rest of the uRDF store via SPARQL queries
  //
  // Execution modes:
  //   - SPARQL rule: schema:text is executed directly as SPARQL
  //   - N3 rule: schema:text is an N3 program executed by eyeling, and a separate
  //     "projection" SPARQL query (from schema:hasPart) is used to generate the
  //     facts fed into the reasoner
  //
  // Output:
  //   - The inferred named graph (GID_INFERRED) is cleared and replaced entirely
  //     with the new inferred graph (graph replacement is deterministic and
  //     avoids incremental drift).
async function recomputeInferencesFromRules(triggerReason) {
  if (!urdf) return;

  const ts = Date.now();

  try {
    // ------------------------------------------------------------------------
    // Step 1: read the rules graph
    // ------------------------------------------------------------------------
     const compressedRulesGraph = urdf.findGraph(GID_RULES);
    if (!Array.isArray(compressedRulesGraph) || compressedRulesGraph.length === 0) {
      await urdf.clear(GID_INFERRED);
      publish({
        ts,
        type: "inference",
        request: { method: "AUTO", path: "rules", summary: `no rules (${triggerReason || ""})` },
        response: { ok: true, ts, rules: 0, triples: 0, gid: GID_INFERRED }
      });
      return;
    }

    // Build a lookup of nodes by @id to allow dereferencing schema:hasPart refs.
	  const rulesGraph = expandCompressedGraphDeep(compressedRulesGraph);
	  const nodesById = new Map();
for (const n of rulesGraph) {
  if (n && typeof n === "object" && typeof n["@id"] === "string") {
    nodesById.set(n["@id"], n);
  }
}

    // ------------------------------------------------------------------------
    // Step 2: extract rule resources
    // ------------------------------------------------------------------------
    const rules = rulesGraph.filter(isRuleNode);
    
    // ------------------------------------------------------------------------
    // Step 3: execute rules and aggregate inferred triples
    // ------------------------------------------------------------------------
    // Inferred results are assembled as JSON-LD node objects grouped by subject.
    // This makes it easy to load the inferred graph as JSON-LD afterward.
    const bySubject = new Map();

    let firedTriples = 0;
for (const rule of rules) {
  const programText = getPropFirstValue(rule, expandZToken(SCHEMA_TEXT));
  if (!programText || typeof programText !== "string" || !programText.trim()) continue;

  // ----------------------------------------------------------------------
  // N3 rule path (Eyeling)
  // ----------------------------------------------------------------------
if (isN3Rule(rule)) {
  const projection = extractN3ProjectionSparql(rule, nodesById);
  if (!projection) {
    RED.log.warn("[uRDF] N3 rule found but missing schema:hasPart projection SPARQL query: " + (rule["@id"] || "(no @id)"));
    continue;
  }

  // Execute the projection query to produce bindings of {s,p,o} facts.
  let projRes;
  try {
    // projRes = await urdf.query(projection);
    // projRes = await urdfQueryViaPluginApiContract(projection);
    const projResCompressed = await urdf.query(rewriteQuery(projection));
    projRes = expandCompressedQueryDeep(projResCompressed);
  } catch (e) {
    RED.log.warn("[uRDF] N3 projection query failed for rule " + (rule["@id"] || "(no @id)") + ": " + (e && e.message ? e.message : e));
    continue;
  }

  const bindings = normalizeQueryResults(projRes);
  const ok = bindings.filter(hasSpo);
  const bad = bindings.length - ok.length;

  // Serialize projection bindings into N-Triples facts to feed the reasoner.
  let factsLines = [];
for (const b of ok) {
  try {
    factsLines.push(bindingToNTripleLine(b));
  } catch (e) {
    RED.log.warn("[uRDF] Failed to serialize binding to N-Triples for rule " + (rule["@id"] || "(no @id)") +
      ": " + (e && e.message ? e.message : e) +
      " binding=" + JSON.stringify(b)
    );
  }
}

const factsText = factsLines.join("\n");

const previewCount = Math.min(10, factsLines.length);

  // Prepare the N3 input as:
  //   <facts as N-Triples>
  //   <blank line>
  //   <N3 program text>
  const n3Program = programText;
  const n3Input = factsText + "\n\n" + n3Program;


  // If Eyeling is unavailable at runtime, N3 execution is skipped safely.
  if (!eyeling || typeof eyeling.reasonStream !== "function") {
    RED.log.warn("[uRDF] Eyeling reasonStream not available at runtime, skipping N3 execution for " + (rule["@id"] || "(no @id)"));
    continue;
  }

  let derivedCount = 0;
  const maxPreview = 10;

  const derivedDF = [];
  const derivedPreview = [];

  let loggedFirstDf = false;

  // Callback invoked by Eyeling when new facts are derived.
  function onDerived(ev) {
    derivedCount++;

    if (ev && ev.df) {
      derivedDF.push(ev.df);

      if (!loggedFirstDf) {
        loggedFirstDf = true;
      }
    }

    if (derivedPreview.length < 2 && ev && typeof ev.triple === "string") {
      derivedPreview.push(ev.triple);
    }
  }

  try {
    const out = eyeling.reasonStream(n3Input, { onDerived });

for (const df of derivedDF) {
  const spo = eyelingDfToSpo(df);
  if (!spo) {
    RED.log.warn("[uRDF] Derived df missing fact.s/p/o: " + JSON.stringify(df));
    continue;
  }

  const sId = spo.s;
  const pIri = spo.p;
  const oJson = eyelingObjectToJsonLd(spo.o);

	const INTERNAL_PRED_PREFIX = "urn:nrua:pv:";
if (pIri.startsWith(INTERNAL_PRED_PREFIX)) {
  continue;
}

  addToBySubject(bySubject, sId, pIri, oJson);
}

  } catch (e) {
    RED.log.warn("[uRDF] Eyeling failed for rule " + (rule["@id"] || "(no @id)") + ": " + (e && e.message ? e.message : e));
  }

  // N3 path ends here; results are already merged into bySubject.
  continue;

}

  // ----------------------------------------------------------------------
  // SPARQL rule path (direct)
  // ----------------------------------------------------------------------
  const q = programText;
  const qresCompressed = await urdf.query(rewriteQuery(q));
  const qres = expandCompressedQueryDeep(qresCompressed);
  const bindings = Array.isArray(qres) ? qres : (qres && Array.isArray(qres.results) ? qres.results : []);
  for (const b of bindings) {
        const sTerm = b.s ?? b["?s"] ?? b.subject ?? b.S;
        const pTerm = b.p ?? b["?p"] ?? b.predicate ?? b.P;
        const oTerm = b.o ?? b["?o"] ?? b.object ?? b.O;

        const sIri = bindingToIri(sTerm);
        const pIri = bindingToIri(pTerm);
        const oJson = bindingToJsonLdObject(oTerm);

        if (!sIri || !pIri || !oJson) continue;

        let subjNode = bySubject.get(sIri);
        if (!subjNode) {
          subjNode = { "@id": sIri };
          bySubject.set(sIri, subjNode);
        }

        subjNode[pIri] = subjNode[pIri] || [];
        subjNode[pIri].push(oJson);

        firedTriples++;
  }
}

    // ------------------------------------------------------------------------
    // Step 4: replace inferred graph deterministically
    // ------------------------------------------------------------------------
const inferredGraphToLoad = Array.from(bySubject.values());

for (const n of inferredGraphToLoad) {
  if (n && typeof n === "object" && n["@type"] && !Array.isArray(n["@type"])) {
    n["@type"] = [n["@type"]];
  }
}


await urdf.clear(GID_INFERRED);
await urdf.load([{
  "@id": GID_INFERRED,
  "@graph": compressGraph(inferredGraphToLoad)
}]);

    const payload = {
      ok: true,
      ts,
      rules: rules.length,
      triples: firedTriples,
      gid: GID_INFERRED,
      reason: triggerReason || "manual",
      size: urdf.size(GID_INFERRED),
      totalSize: urdf.size()
    };

    publish({
      ts,
      type: "inference",
      request: { method: "AUTO", path: "rules", summary: `applied ${rules.length} rule(s)` },
      response: payload
    });

  } catch (e) {
    const payload = { ok: false, ts, gid: GID_INFERRED, error: e?.message || String(e) };
    publish({
      ts,
      type: "inference",
      request: { method: "AUTO", path: "rules", summary: "FAILED" },
      response: payload
    });
    RED.log.error("[uRDF] Rule inference failed: " + payload.error);
  }
}

  // ----------------------------------------------------------------------------
  // Rule graph utilities and rule CRUD endpoints
  // ----------------------------------------------------------------------------
  // The rules graph (GID_RULES) is stored as JSON-LD in uRDF. These helpers and
  // endpoints provide a minimal management API to:
  //   - create a new rule resource
  //   - update an existing rule resource
  //   - delete a rule by @id
  //
  // The API operates on full rule objects (no patching): create/update replace
  // the entire rule resource entry in the rules graph.
function asArray(x) {
  return Array.isArray(x) ? x : (x ? [x] : []);
}

function isRuleNode(n) {
  const t = asArray(n && n["@type"]);
  return t.includes(NRUA_RULE) || t.includes(z(NRUA_RULE));
}

function getGraphSafe(gid) {
  const g = urdf.findGraph(gid);
  return Array.isArray(g) ? g : [];
}

  // Replace a named graph deterministically by clearing and loading a new graph.
  // This avoids partial updates and keeps the stored graph consistent.
async function replaceNamedGraph(gid, graphArray) {
  await urdf.clear(gid);
  await urdf.load([{ "@id": gid, "@graph": graphArray }]);
}

  // ----------------------------------------------------------------------------
  // POST /urdf/rules/create
  // ----------------------------------------------------------------------------
  // Body: { "rule": <JSON-LD rule resource> }
  // Constraints:
  //   - rule["@id"] is required
  //   - rule["@type"] must include NRUA_RULE
  //   - conflicts return HTTP 409
RED.httpAdmin.post("/urdf/rules/create", jsonParser, async (req, res) => {
  const ts = Date.now();
  if (!requireUrdf(ts, "rulesCreate", { method: "POST", path: "/urdf/rules/create" }, res)) return;

  const rule = req.body && req.body.rule;
  if (!rule || typeof rule !== "object") return res.status(400).json({ ok: false, ts, error: 'Body must be { "rule": { ... } }' });
  if (!rule["@id"] || typeof rule["@id"] !== "string") return res.status(400).json({ ok: false, ts, error: 'rule["@id"] is required' });
  if (!isRuleNode(rule)) return res.status(400).json({ ok: false, ts, error: `rule["@type"] must include ${NRUA_RULE}` });

  try {
    const graph = getGraphSafe(GID_RULES);

    if (graph.some(n => n && n["@id"] === rule["@id"])) {
      return res.status(409).json({ ok: false, ts, error: "Rule already exists", id: rule["@id"] });
    }

    graph.push(rule);
    await replaceNamedGraph(GID_RULES, flattenJsonLd(compressGraph(graph)));

    return res.status(200).json({ ok: true, ts, gid: GID_RULES, created: rule["@id"], count: graph.length });
  } catch (e) {
    return res.status(500).json({ ok: false, ts, error: e?.message || String(e) });
  }
});

  // ----------------------------------------------------------------------------
  // POST /urdf/rules/update
  // ----------------------------------------------------------------------------
  // Body: { "rule": <JSON-LD rule resource> }
  // Constraints:
  //   - rule["@id"] is required
  //   - rule["@type"] must include NRUA_RULE
  //   - missing rules return HTTP 404
RED.httpAdmin.post("/urdf/rules/update", jsonParser, async (req, res) => {
  const ts = Date.now();
  if (!requireUrdf(ts, "rulesUpdate", { method: "POST", path: "/urdf/rules/update" }, res)) return;

  const rule = req.body && req.body.rule;
  if (!rule || typeof rule !== "object") return res.status(400).json({ ok: false, ts, error: 'Body must be { "rule": { ... } }' });
  if (!rule["@id"] || typeof rule["@id"] !== "string") return res.status(400).json({ ok: false, ts, error: 'rule["@id"] is required' });
  if (!isRuleNode(rule)) return res.status(400).json({ ok: false, ts, error: `rule["@type"] must include ${NRUA_RULE}` });

  try {
    const graph = getGraphSafe(GID_RULES);
    const idx = graph.findIndex(n => n && n["@id"] === rule["@id"]);
    if (idx < 0) return res.status(404).json({ ok: false, ts, error: "Rule not found", id: rule["@id"] });

    graph[idx] = rule;
    await replaceNamedGraph(GID_RULES, flattenJsonLd(compressGraph(graph)));

    return res.status(200).json({ ok: true, ts, gid: GID_RULES, updated: rule["@id"], count: graph.length });
  } catch (e) {
    return res.status(500).json({ ok: false, ts, error: e?.message || String(e) });
  }
});

  // ----------------------------------------------------------------------------
  // POST /urdf/rules/delete
  // ----------------------------------------------------------------------------
  // Body: { "id": "<rule @id>" }
  // Behavior:
  //   - removes any rule node whose "@id" matches the provided id
  //   - missing rules return HTTP 404
RED.httpAdmin.post("/urdf/rules/delete", jsonParser, async (req, res) => {
  const ts = Date.now();
  if (!requireUrdf(ts, "rulesDelete", { method: "POST", path: "/urdf/rules/delete" }, res)) return;

  const id = req.body && req.body.id ? String(req.body.id) : "";
  if (!id.trim()) return res.status(400).json({ ok: false, ts, error: 'Body must be { "id": "..." }' });

  try {
    const graph = getGraphSafe(GID_RULES);
    const next = graph.filter(n => !(n && n["@id"] === id));
    if (next.length === graph.length) return res.status(404).json({ ok: false, ts, error: "Rule not found", id });

    await replaceNamedGraph(GID_RULES, compressGraph(next));

    return res.status(200).json({ ok: true, ts, gid: GID_RULES, deleted: id, count: next.length });
  } catch (e) {
    return res.status(500).json({ ok: false, ts, error: e?.message || String(e) });
  }
});

  // ----------------------------------------------------------------------------
  // Application model extraction from Node-RED flows
  // ----------------------------------------------------------------------------
  // This section converts the Node-RED flow configuration (GET /flows) into a
  // JSON-LD knowledge graph describing:
  //   - the application as a whole
  //   - each flow/tab
  //   - each node (including config nodes)
  //   - wiring structure (node outputs and their targets)
  //   - node configuration properties (captured losslessly)
  //
  // The resulting graph is stored in the named graph GID_APP and is refreshed
  // whenever flows are deployed/updated.
  const GID_APP = z(process.env.URDF_APP_GID || "urn:nrua:app");

  // ----------------------------------------------------------------------------
  // Stable identifiers (URNs) for app/flow/node entities
  // ----------------------------------------------------------------------------
  // These helpers produce stable IDs derived from Node-RED ids so that repeated
  // loads replace the same resources rather than creating new ones.
  function appId() {
    return `urn:nrua:a${process.env.NODE_RED_INSTANCE_ID}`;
  }
  function flowId(tabId) {
    return `urn:nrua:f${tabId}`;
  }
  function nodeId(id) {
    return `urn:nrua:n${id}`;
  }
  function outId(id, gate) {
    return `urn:nrua:o${id}${gate}`;
  }

  // ----------------------------------------------------------------------------
  // Node property capture rules
  // ----------------------------------------------------------------------------
  // Node-RED nodes include many keys that are either universal editor metadata
  // or not relevant to a semantic configuration graph. Those keys are excluded.
  //
  // All remaining keys are stored as schema:PropertyValue entries linked via
  // schema:additionalProperty to preserve configuration losslessly.
  const EXCLUDE_NODE_KEYS = new Set([
    "id",
    "type",
    "z",
    "x",
    "y",
    "wires",
    "info",
    "d",
    "g"
  ]);

  function isPrimitive(v) {
    return v === null || ["string", "number", "boolean"].includes(typeof v);
  }

  // ----------------------------------------------------------------------------
  // Deterministic ID encoding for structured values
  // ----------------------------------------------------------------------------
  // Structured values (arrays/objects) are represented as additional JSON-LD
  // nodes and linked from the owning PropertyValue. makeId ensures stable,
  // URN-safe identifiers so that the same flow configuration always yields the
  // same resource ids.
  function makeId(...parts) {
    const enc = (s) =>
      encodeURIComponent(String(s))
        .replace(/%/g, "_");
    return parts.map(enc).join(":");
  }

  // ----------------------------------------------------------------------------
  // Encode structured configuration values
  // ----------------------------------------------------------------------------
  // Arrays are encoded as schema:ItemList with schema:ListItem elements.
  // Objects are encoded as schema:StructuredValue with schema:additionalProperty
  // entries (schema:PropertyValue).
  //
  // The function returns the @id of the created structured resource node.
function encodeStructuredValue(graph, value, idBase) {
  // Arrays -> schema:ItemList + schema:ListItem
  if (Array.isArray(value)) {
    const listId = makeId(idBase, "list");
    const list = {
      "@id": listId,
      "@type": [z("https://schema.org/ItemList")],
      [z("https://schema.org/itemListElement")]: []
    };

    for (let idx = 0; idx < value.length; idx++) {
      const item = value[idx];

      const liId = makeId(listId, "li", String(idx));
      const li = {
        "@id": liId,
        "@type": [z("https://schema.org/ListItem")],
        [z("https://schema.org/position")]: [{ "@value": idx }]
      };

      if (isPrimitive(item)) {
        li[z("https://schema.org/item")] = [{ "@value": item }];
      } else {
        const itemId = encodeStructuredValue(graph, item, makeId(liId, "item"));
        li[z("https://schema.org/item")] = [{ "@id": itemId }];
      }

      graph.push(li);
      list[z("https://schema.org/itemListElement")].push({ "@id": liId });
    }

    graph.push(list);
    return listId;
  }

  // Objects -> schema:StructuredValue + schema:PropertyValue(s)
  const objId = makeId(idBase, "obj");
  const objNode = {
    "@id": objId,
    "@type": [z("https://schema.org/StructuredValue")],
    [z("https://schema.org/additionalProperty")]: []
  };

  graph.push(objNode);

  const keys = Object.keys(value || {}).sort();
  for (const k of keys) {
    const v = value[k];

    const pvId = makeId(objId, "pv", k);
    const pv = {
      "@id": pvId,
      "@type": [z("https://schema.org/PropertyValue")],
      [z("https://schema.org/name")]: [{ "@value": String(k) }]
    };

    if (isPrimitive(v)) {
      pv[z("https://schema.org/value")] = [{ "@value": v }];
    } else {
      const nestedId = encodeStructuredValue(graph, v, makeId(objId, "v", k));
      pv[z("https://schema.org/valueReference")] = [{ "@id": nestedId }];
    }

    graph.push(pv);
    objNode[z("https://schema.org/additionalProperty")].push({ "@id": pvId });
  }

  return objId;
}

  // ----------------------------------------------------------------------------
  // Attach a schema:PropertyValue to an existing subject node
  // ----------------------------------------------------------------------------
  // The subject node must already exist in the graph array. This function:
  //   1) creates a PropertyValue node with stable @id
  //   2) pushes it into the graph
  //   3) links it from the subject via schema:additionalProperty
function addPropertyValue(graph, subjectId, key, value, baseId) {
  const pvId = makeId(baseId, "pv", key);

  const pv = {
    "@id": pvId,
    "@type": [z("https://schema.org/PropertyValue")],
    [z("https://schema.org/name")]: [{ "@value": String(key) }]
  };

  if (isPrimitive(value)) {
    // Store primitives as JSON-LD value objects (still wrapped in an array)
    pv[z("https://schema.org/value")] = [{ "@value": value }];
  } else {
    const structuredId = encodeStructuredValue(graph, value, makeId(baseId, "v", key));
    pv[z("https://schema.org/valueReference")] = [{ "@id": structuredId }];
  }

  graph.push(pv);

  const subj = graph.find((x) => x && x["@id"] === subjectId);
  if (subj) {
    subj[z("https://schema.org/additionalProperty")] = subj[z("https://schema.org/additionalProperty")] || [];
    // Ensure it's an array (paranoia for mixed producers)
    if (!Array.isArray(subj[z("https://schema.org/additionalProperty")])) {
      subj[z("https://schema.org/additionalProperty")] = [subj[z("https://schema.org/additionalProperty")]];
    }
    subj[z("https://schema.org/additionalProperty")].push({ "@id": pvId });
  }
}

  // ----------------------------------------------------------------------------
  // Flow configuration -> JSON-LD application document
  // ----------------------------------------------------------------------------
  // Takes the raw array returned by GET /flows and builds a JSON-LD document:
  //   { "@context": ..., "@id": <GID_APP>, "@graph": [...] }
  //
  // The graph contains:
  //   - schema:Application root
  //   - nrua:Flow nodes derived from "tab" entries
  //   - nrua:Node nodes for all non-tab entries
  //   - nrua:NodeOutput wiring nodes for each output gate
  //   - schema:PropertyValue nodes for configuration keys
  //
  // Additionally, each flow collects a keyword list from node types as a compact
  // summary under schema:keywords.
  function buildAppJsonLdFromFlows(flowsArray) {
  const graph = [];

  // Root application node
  graph.push({
    "@id": appId(),
    "@type": [z("https://schema.org/Application")]
  });

  const flowKeywords = new Map();

  function addKw(flowIri, kw) {
    if (!kw) return;
    const k = String(kw).trim();
    if (!k) return;
    let set = flowKeywords.get(flowIri);
    if (!set) {
      set = new Set();
      flowKeywords.set(flowIri, set);
    }
    set.add(k);
  }

  // Tabs -> Flows
  const tabs = (Array.isArray(flowsArray) ? flowsArray : []).filter((n) => n && n.type === "tab");
  for (const t of tabs) {
    const fid = flowId(t.id);

    graph.push({
      "@id": fid,
      "@type": [z("https://w3id.org/nodered-ontology-based-program-analysis/nodered-user-application-ontology#Flow")],
      [z("https://schema.org/identifier")]: [{ "@value": String(t.id) }],
      ...(t.label ? { [z("https://schema.org/name")]: [{ "@value": String(t.label) }] } : {}),
      [z("https://w3id.org/nodered-ontology-based-program-analysis/nodered-user-application-ontology#isPartOfApp")]: [{ "@id": appId() }]
    });

    flowKeywords.set(fid, flowKeywords.get(fid) || new Set());
  }

  // All non-tab nodes
  for (const n of (Array.isArray(flowsArray) ? flowsArray : [])) {
    if (!n || typeof n !== "object") continue;
    if (!n.id || !n.type) continue;
    if (n.type === "tab") continue;

    const thisNodeId = nodeId(n.id);
    const partOf = n.z ? flowId(String(n.z)) : appId();
    const isPartOf = n.z ? "https://w3id.org/nodered-ontology-based-program-analysis/nodered-user-application-ontology#isPartOfFlow" : "https://w3id.org/nodered-ontology-based-program-analysis/nodered-user-application-ontology#isPartOfApp";

    if (n.z) addKw(partOf, n.type);

    const node = {
      "@id": thisNodeId,
      "@type": [z("https://w3id.org/nodered-ontology-based-program-analysis/nodered-user-application-ontology#Node")],
      [z("https://schema.org/identifier")]: [{ "@value": String(n.id) }],
      [z("https://w3id.org/nodered-ontology-based-program-analysis/nodered-user-application-ontology#type")]: [{ "@value": String(n.type) }],
      ...(n.name ? { [z("https://schema.org/name")]: [{ "@value": String(n.name) }] } : {}),
      [z(isPartOf)]: [{ "@id": partOf }]
    };

    graph.push(node);

    // Add remaining properties from the Node-RED node object
    for (const [k, v] of Object.entries(n)) {
      if (EXCLUDE_NODE_KEYS.has(k)) continue;
      if (k === "name") continue;
      if (k === "label" || k === "disabled" || k === "env") continue;
      addPropertyValue(graph, thisNodeId, k, v, thisNodeId);
    }

    // Wires -> NodeOutputs
    if (Array.isArray(n.wires)) {
      for (let gate = 0; gate < n.wires.length; gate++) {
        const targets = n.wires[gate];
        if (!Array.isArray(targets) || targets.length === 0) continue;

        const outIri = outId(n.id, gate);

        graph.push({
          "@id": outIri,
          "@type": [z("https://w3id.org/nodered-ontology-based-program-analysis/nodered-user-application-ontology#NodeOutput")],
          [z("https://w3id.org/nodered-ontology-based-program-analysis/nodered-user-application-ontology#fromGate")]: [{ "@value": gate }],
          [z("https://w3id.org/nodered-ontology-based-program-analysis/nodered-user-application-ontology#toNode")]: targets.map((tid) => ({ "@id": nodeId(String(tid)) }))
        });

        node[z("https://w3id.org/nodered-ontology-based-program-analysis/nodered-user-application-ontology#hasOutput")] = node[z("https://w3id.org/nodered-ontology-based-program-analysis/nodered-user-application-ontology#hasOutput")] || [];
        node[z("https://w3id.org/nodered-ontology-based-program-analysis/nodered-user-application-ontology#hasOutput")].push({ "@id": outIri });
      }
    }
  }

  // Add keywords to each flow
  for (const [flowIri, set] of flowKeywords.entries()) {
    if (!set || set.size === 0) continue;
    const flowNode = graph.find((x) => x && x["@id"] === flowIri);
    if (!flowNode) continue;

    flowNode[z("https://schema.org/keywords")] = [
      {
        "@value": Array.from(set)
          .map((kw) => String(kw).trim())
          .filter(Boolean)
          .sort()
          .join(",")
      }
    ];
  }

  // IMPORTANT: urdf.load() expects an ARRAY so json.filter(...) works
  return [
    {
      "@context": { },
      "@id": GID_APP,
      "@graph": graph
    }
  ];
}

  // ----------------------------------------------------------------------------
  // Refresh scheduling (debounce)
  // ----------------------------------------------------------------------------
  // Flow events can fire in quick succession during deployments. A short debounce
  // avoids redundant reload work.
  let appReloadTimer = null;

  function scheduleAppReload(reason) {
    if (appReloadTimer) clearTimeout(appReloadTimer);
    appReloadTimer = setTimeout(() => {
      loadApplicationFromFlows(reason).catch((e) => {
        RED.log.error("[uRDF] Application load failed: " + (e?.message || String(e)));
        publish({
          ts: Date.now(),
          type: "appLoad",
          request: { method: "INIT", path: "app", summary: `failed (${reason})` },
          response: { ok: false, error: e?.message || String(e) }
        });
      });
    }, 250);
  }

  // ----------------------------------------------------------------------------
  // Load application graph from /flows and trigger inference
  // ----------------------------------------------------------------------------
  // This performs a full replace of the application graph to keep state
  // deterministic across deploys/updates.
  async function loadApplicationFromFlows(reason) {
    if (!urdf) return;

    const ts = Date.now();
    const flows = await fetchAdminJson("/flows");

    if (!Array.isArray(flows)) {
      throw new Error("Expected /flows to return an array; got " + typeof flows);
    }

    const appDoc = buildAppJsonLdFromFlows(flows);

    function findFirstNonArrayPredicate(dataset) {
  const graphs = Array.isArray(dataset) ? dataset : [dataset];

  for (const g of graphs) {
    const nodes = g && Array.isArray(g["@graph"]) ? g["@graph"] : [];
    for (const n of nodes) {
      if (!n || typeof n !== "object") continue;

      for (const p of Object.keys(n)) {
        // allow JSON-LD keywords to be non-array? (your rename probably doesn't)
        // but we check everything except @id
        if (p === "@id") continue;

        if (!Array.isArray(n[p])) {
          return { gid: g["@id"], nodeId: n["@id"], p, value: n[p], type: typeof n[p], node: n };
        }
      }
    }
  }
  return null;
  }

    const bad = findFirstNonArrayPredicate(appDoc);

    if (bad) {
       console.error("[uRDF] Non-array predicate value detected BEFORE load:", {
         gid: bad.gid,
         nodeId: bad.nodeId,
         predicate: bad.p,
         valueType: bad.type,
         value: bad.value
       });
       console.error("[uRDF] Full offending node:", bad.node);
       throw new Error("Non-array predicate value detected; aborting before urdf.load()");
    }

    await urdf.clear(GID_APP);
    await urdf.load(appDoc);
    await recomputeInferencesFromRules(reason);

    const payload = {
      ok: true,
      ts,
      gid: GID_APP,
      reason,
      size: urdf.size(GID_APP),
      totalSize: urdf.size()
    };

    publish({
      ts,
      type: "appUpdate",
      request: { method: "REPLACE", path: "/flows", summary: reason },
      response: payload
    });

    RED.log.info(`[uRDF] Application graph updated from /flows into gid=${GID_APP} (${reason})`);
  }

  // ----------------------------------------------------------------------------
  // Hook into Node-RED flow lifecycle events
  // ----------------------------------------------------------------------------
  // When flows start/deploy/update, refresh the application graph and recompute
  // inferred knowledge derived from rules.
  if (RED.events && typeof RED.events.on === "function") {
    RED.events.on("flows:started", () => scheduleAppReload("flows:started"));
    RED.events.on("flows:deployed", () => scheduleAppReload("flows:deployed"));
    RED.events.on("flows:updated", () => scheduleAppReload("flows:updated"));
    RED.log.info("[uRDF] Registered flow lifecycle hooks");
  } else {
    RED.log.warn("[uRDF] RED.events not available; deploy hook not registered");
  }

  // ----------------------------------------------------------------------------
  // Admin HTTP API: uRDF store access and management
  // ----------------------------------------------------------------------------
  // These endpoints expose a minimal HTTP interface over the uRDF store via
  // Node-RED's admin server (RED.httpAdmin).
  //
  // Design notes:
  // - Endpoints are intentionally operational and diagnostic in nature.
  // - All calls publish a structured event when possible (editor visibility).
  // - The handler logic is defensive: failures return explicit errors and do not
  //   crash the Node-RED runtime.
  function now() {
    return Date.now();
  }

  // Reduce SPARQL text to a compact one-line preview for event logs.
  function summarizeSparql(s) {
    if (!s || typeof s !== "string") return "";
    const oneLine = s.replace(/\s+/g, " ").trim();
    return oneLine.length > 140 ? oneLine.slice(0, 137) + "..." : oneLine;
  }

  // Convenience response helper: ok=true -> 200, ok=false -> 500.
  function okOr500(res, payload) {
    return res.status(payload.ok ? 200 : 500).json(payload);
  }

  // Ensure uRDF is available before servicing a request. If not, publish an
  // event and respond with 500.
  function requireUrdf(ts, type, reqMeta, res) {
    if (urdf) return true;
    const payload = { ok: false, ts, error: "uRDF module not loaded" };
    publish({ ts, type, request: reqMeta, response: payload });
    res.status(500).json(payload);
    return false;
  }

  // ----------------------------------------------------------------------------
  // GET /urdf/qa/config
  // ----------------------------------------------------------------------------
  // Returns the executable QA JSON contract used by the QA runtime.
  RED.httpAdmin.get("/urdf/qa/config", function (req, res) {
    const ts = now();

    if (!qaRuntime) {
      const payload = { ok: false, ts, error: "QA runtime not loaded" };
      publish({
        ts,
        type: "qaConfig",
        request: { method: "GET", path: "/urdf/qa/config" },
        response: payload
      });
      return res.status(500).json(payload);
    }

    try {
      const configPath = path.join(__dirname, qaRuntime.CONFIG_FILENAME);
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

      publish({
        ts,
        type: "qaConfig",
        request: { method: "GET", path: "/urdf/qa/config" },
        response: { ok: true, ts }
      });

      return res.status(200).json(config);
    } catch (e) {
      const payload = { ok: false, ts, error: e && e.message ? e.message : String(e) };
      publish({
        ts,
        type: "qaConfig",
        request: { method: "GET", path: "/urdf/qa/config" },
        response: payload
      });
      return res.status(500).json(payload);
    }
  });

  if (qaRuntime && typeof qaRuntime.handleHttpRequest === "function") {
    RED.httpAdmin.post("/urdf/qa", jsonParser, function (req, res) {
      return qaRuntime.handleHttpRequest(req, res);
    });
  }

  // ----------------------------------------------------------------------------
  // GET /urdf/health
  // ----------------------------------------------------------------------------
  // Basic runtime check: confirms uRDF module load and reports store size.
  RED.httpAdmin.get("/urdf/health", function (req, res) {
    const ts = now();
    const ok = !!urdf;
    const payload = {
      ok,
      ts,
      module: "urdf",
      size: ok && typeof urdf.size === "function" ? urdf.size() : undefined
    };

    publish({
      ts,
      type: "health",
      request: { method: "GET", path: "/urdf/health" },
      response: payload
    });

    okOr500(res, payload);
  });

  // ----------------------------------------------------------------------------
  // GET /urdf/size?gid=...
  // ----------------------------------------------------------------------------
  // Returns either:
  // - total store size (no gid)
  // - size of a named graph (gid provided)
  RED.httpAdmin.get("/urdf/size", function (req, res) {
    const ts = now();
    if (!requireUrdf(ts, "size", { method: "GET", path: "/urdf/size" }, res)) return;

    const gid = req.query && req.query.gid ? String(req.query.gid) : undefined;

    try {
      if (!gid) {
        const totalSize = urdf.size();
        const payload = { ok: true, ts, totalSize };

        publish({
          ts,
          type: "size",
          request: { method: "GET", path: "/urdf/size", summary: "total size" },
          response: payload
        });

        return res.status(200).json(payload);
      }

      const size = urdf.size(gid);
      const payload = { ok: true, ts, gid, size };

      publish({
        ts,
        type: "size",
        request: { method: "GET", path: "/urdf/size", summary: `gid=${gid}` },
        response: payload
      });

      return res.status(200).json(payload);
    } catch (e) {
      const payload = { ok: false, ts, error: e && e.message ? e.message : String(e) };

      publish({
        ts,
        type: "size",
        request: { method: "GET", path: "/urdf/size", summary: gid ? `gid=${gid}` : "total size" },
        response: payload
      });

      return res.status(500).json(payload);
    }
  });

  // ----------------------------------------------------------------------------
  // GET /urdf/graph?gid=...
  // ----------------------------------------------------------------------------
  // Returns the JSON-LD graph array for:
  // - the default graph (no gid)
  // - a named graph (gid provided)
  RED.httpAdmin.get("/urdf/graph", function (req, res) {
    const ts = now();
    if (!requireUrdf(ts, "graph", { method: "GET", path: "/urdf/graph" }, res)) return;

    const gid = req.query && req.query.gid ? String(req.query.gid) : undefined;

    try {
      const graph = expandCompressedGraphDeep( gid ? urdf.findGraph(gid) : urdf.findGraph() );

      if (gid && graph == null) {
        const payload = { ok: false, ts, gid, error: "Graph not found" };

        publish({
          ts,
          type: "graph",
          request: { method: "GET", path: "/urdf/graph", summary: `gid=${gid}` },
          response: payload
        });

        return res.status(404).json(payload);
      }

      const payload = { ok: true, ts, gid: gid || null, graph };

      publish({
        ts,
        type: "graph",
        request: { method: "GET", path: "/urdf/graph", summary: gid ? `gid=${gid}` : "default graph" },
        response: payload
      });

      return res.status(200).json(payload);
    } catch (e) {
      const payload = { ok: false, ts, error: e && e.message ? e.message : String(e) };

      publish({
        ts,
        type: "graph",
        request: { method: "GET", path: "/urdf/graph", summary: gid ? `gid=${gid}` : "default graph" },
        response: payload
      });

      return res.status(500).json(payload);
    }
  });

  // ----------------------------------------------------------------------------
  // GET /urdf/export?gid=...
  // ----------------------------------------------------------------------------
  // Downloads a JSON-LD document containing either:
  // - the whole store (no gid)
  // - one named graph (gid provided)
RED.httpAdmin.get("/urdf/export", function (req, res) {
  const ts = now();
  if (!requireUrdf(ts, "export", { method: "GET", path: "/urdf/export" }, res)) return;

  try {
    const graph = req.query && req.query.gid ? urdf.findGraph(String(req.query.gid)) : urdf.findGraph();
    const doc = {
      "@context": {
      },
      "@id": req.query && req.query.gid ? req.query.gid : "",
      "@graph": graph
    };

    const filename = `urdf-export-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonld`;

    res.setHeader("Content-Type", "application/ld+json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.status(200).send(JSON.stringify(expandCompressedGraphDeep(doc), null, 2));

    publish({
      ts,
      type: "export",
      request: { method: "GET", path: "/urdf/export" },
      response: { ok: true, ts, filename }
    });
  } catch (e) {
    const payload = { ok: false, ts, error: e?.message || String(e) };
    publish({
      ts,
      type: "export",
      request: { method: "GET", path: "/urdf/export" },
      response: payload
    });
    res.status(500).json(payload);
  }
});

  // ----------------------------------------------------------------------------
  // GET /urdf/node?id=...&gid=...
  // ----------------------------------------------------------------------------
  // Retrieves a single node/resource by @id, optionally scoped to a named graph.
  RED.httpAdmin.get("/urdf/node", async function (req, res) {
    const ts = now();
    if (!requireUrdf(ts, "node", { method: "GET", path: "/urdf/node" }, res)) return;

    const id = req.query && req.query.id ? String(req.query.id) : "";
    const gid = req.query && req.query.gid ? String(req.query.gid) : undefined;

    if (!id.trim()) {
      const payload = { ok: false, ts, error: "Missing required query param: id" };
      publish({
        ts,
        type: "node",
        request: { method: "GET", path: "/urdf/node", summary: "missing id" },
        response: payload
      });
      return res.status(400).json(payload);
    }

    try {
      const node = expandCompressedGraphDeep( gid ? await urdf.find(id, gid) : await urdf.find(id) ) ;
      const payload = { ok: true, ts, id, gid: gid || null, node };

      publish({
        ts,
        type: "node",
        request: { method: "GET", path: "/urdf/node", summary: gid ? `id=${id} gid=${gid}` : `id=${id}` },
        response: payload
      });

      res.status(200).json(payload);
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      const status = /not found/i.test(message) ? 404 : 500;
      const payload = { ok: false, ts, error: message };

      publish({
        ts,
        type: "node",
        request: { method: "GET", path: "/urdf/node", summary: gid ? `id=${id} gid=${gid}` : `id=${id}` },
        response: payload
      });

      res.status(status).json(payload);
    }
  });

  // ----------------------------------------------------------------------------
  // POST /urdf/clear
  // ----------------------------------------------------------------------------
  // Body: { "gid": "optional" }
  // Clears either:
  // - a named graph (gid present)
  // - the whole store/default (gid absent)
  RED.httpAdmin.post("/urdf/clear", jsonParser, async function (req, res) {
    const ts = now();
    if (!requireUrdf(ts, "clear", { method: "POST", path: "/urdf/clear" }, res)) return;

    const gid = req.body && req.body.gid ? String(req.body.gid) : undefined;

    try {
      if (gid) {
        await urdf.clear(gid);
      } else {
        await urdf.clear();
      }

      const payload = gid ? { ok: true, ts, gid } : { ok: true, ts };

      publish({
        ts,
        type: "clear",
        request: { method: "POST", path: "/urdf/clear", summary: gid ? `gid=${gid}` : "default/all" },
        response: payload
      });

      res.status(200).json(payload);
    } catch (e) {
      const payload = { ok: false, ts, error: e && e.message ? e.message : String(e) };

      publish({
        ts,
        type: "clear",
        request: { method: "POST", path: "/urdf/clear", summary: gid ? `gid=${gid}` : "default/all" },
        response: payload
      });

      res.status(500).json(payload);
    }
  });

  // ----------------------------------------------------------------------------
  // POST /urdf/load
  // ----------------------------------------------------------------------------
  // Loads a JSON-LD document into the store (append semantics).
  // Body: a JSON object or array representing JSON-LD.
  RED.httpAdmin.post("/urdf/load", jsonParser, async function (req, res) {
    const ts = now();
    if (!requireUrdf(ts, "load", { method: "POST", path: "/urdf/load", summary: "JSON-LD" }, res)) return;

    const body = req.body;

    const isValid =
      body !== null &&
      typeof body !== "undefined" &&
      (Array.isArray(body) || (typeof body === "object" && !Array.isArray(body)));

    if (!isValid) {
      const payload = { ok: false, ts, error: "Request body must be JSON-LD (a JSON object or array)." };
      publish({
        ts,
        type: "load",
        request: { method: "POST", path: "/urdf/load", summary: "invalid body" },
        response: payload
      });
      return res.status(400).json(payload);
    }

    try {
      // await urdf.load(body);
      await urdf.load(flattenJsonLd(compressGraph(body)));

      const payload = { ok: true, ts, size: urdf.size() };

      publish({
        ts,
        type: "load",
        request: {
          method: "POST",
          path: "/urdf/load",
          summary: Array.isArray(body) ? `JSON-LD array (${body.length})` : "JSON-LD object"
        },
        response: payload
      });

      res.status(200).json(payload);
    } catch (e) {
      const payload = { ok: false, ts, error: e && e.message ? e.message : String(e) };

      publish({
        ts,
        type: "load",
        request: { method: "POST", path: "/urdf/load", summary: "JSON-LD" },
        response: payload
      });

      res.status(500).json(payload);
    }
  });

  // ----------------------------------------------------------------------------
  // POST /urdf/loadFile
  // ----------------------------------------------------------------------------
  // Body: { "doc": <JSON-LD> }
  // Behavior:
  // - doc["@id"] is required and is used as the target named graph (gid)
  // - the named graph is cleared then replaced with the provided doc
RED.httpAdmin.post("/urdf/loadFile", jsonParser, async function (req, res) {
  const ts = now();
  if (!requireUrdf(ts, "loadFile", { method: "POST", path: "/urdf/loadFile" }, res)) return;

  const doc = req.body && req.body.doc;

  const isValid =
    doc !== null &&
    typeof doc !== "undefined" &&
    (Array.isArray(doc) || (typeof doc === "object" && !Array.isArray(doc)));

  if (!isValid) {
    const payload = { ok: false, ts, error: 'Body must be JSON: { "doc": <JSON-LD object/array> }' };
    publish({ ts, type: "loadFile", request: { method: "POST", path: "/urdf/loadFile", summary: "invalid body" }, response: payload });
    return res.status(400).json(payload);
  }

  // --- FIX 1: extract gid from either object doc OR first element of array doc
  let gid = null;

  if (Array.isArray(doc)) {
    const first = doc[0];
    if (first && typeof first === "object" && typeof first["@id"] === "string" && first["@id"].trim()) {
      gid = first["@id"].trim();
    }
  } else if (doc && typeof doc === "object" && typeof doc["@id"] === "string" && doc["@id"].trim()) {
    gid = doc["@id"].trim();
  }

  if (!gid) {
    const payload = { ok: false, ts, error: 'Uploaded JSON-LD must contain an "@id" to identify the named graph (gid).' };
    publish({ ts, type: "loadFile", request: { method: "POST", path: "/urdf/loadFile", summary: "missing @id" }, response: payload });
    return res.status(400).json(payload);
  }

  try {
    await urdf.clear(gid);

    // --- FIX 2: normalize before calling urdf.load() so json.filter(...) works
    const dataset = Array.isArray(doc) ? doc : [doc];
    await urdf.load(dataset);

    const payload = { ok: true, ts, gid, size: urdf.size(gid), totalSize: urdf.size() };
    publish({ ts, type: "loadFile", request: { method: "POST", path: "/urdf/loadFile", summary: `gid=${gid}` }, response: payload });
    return res.status(200).json(payload);
  } catch (e) {
    const payload = { ok: false, ts, gid, error: e?.message || String(e) };
    publish({ ts, type: "loadFile", request: { method: "POST", path: "/urdf/loadFile", summary: `gid=${gid}` }, response: payload });
    return res.status(500).json(payload);
  }
});

// ----------------------------------------------------------------------------
// POST /urdf/query
// ----------------------------------------------------------------------------
// Body: { "sparql": "..." }
// Executes a SPARQL query against the store.
// Response:
// - ASK queries -> { ok:true, ts, type:"ASK", result:boolean }
// - SELECT queries -> { ok:true, ts, type:"SELECT", results:[...] }
RED.httpAdmin.post("/urdf/query", jsonParser, async function (req, res) {
  const ts = now();
  if (!requireUrdf(ts, "query", { method: "POST", path: "/urdf/query" }, res)) return;

  const sparql = req.body && req.body.sparql;

  if (!sparql || typeof sparql !== "string" || !sparql.trim()) {
    const payload = { ok: false, ts, error: 'Body must be JSON: { "sparql": "..." }' };
    publish({
      ts,
      type: "query",
      request: { method: "POST", path: "/urdf/query", summary: "missing sparql" },
      response: payload
    });
    return res.status(400).json(payload);
  }

  const summary = summarizeSparql(sparql);

  try {
    // ------------------------------------------------------------------------
    // Contract enforcement:
    // PREFIX and BASE declarations are forbidden in input queries.
    // Reject if they appear anywhere as standalone SPARQL keywords.
    // ------------------------------------------------------------------------
    // Note: this is intentionally simple and fast; it may reject edge cases
    // where "prefix" or "base" appear in comments/strings. If that matters,
    // a tokenizer would be required.
    if (/(^|\s)(prefix|base)\s+/i.test(sparql)) {
      const payload = {
        ok: false,
        ts,
        error: "Rejected: PREFIX/BASE declarations are not allowed by contract for /urdf/query."
      };
      publish({
        ts,
        type: "query",
        request: { method: "POST", path: "/urdf/query", summary },
        response: payload
      });
      return res.status(400).json(payload);
    }

let rewrittenSparql = rewriteQuery(sparql);

    // Execute the rewritten query against the store.
    const result = await urdf.query(rewrittenSparql);

    const payload =
      typeof result === "boolean"
        ? { ok: true, ts, type: "ASK", result }
        : { ok: true, ts, type: "SELECT", results: expandCompressedQueryDeep(result) };

    publish({
      ts,
      type: "query",
      request: { method: "POST", path: "/urdf/query", summary },
      response: payload
    });

    res.status(200).json(payload);
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    const status = /not implemented/i.test(message) ? 501 : 500;
    const payload = { ok: false, ts, error: message };

    publish({
      ts,
      type: "query",
      request: { method: "POST", path: "/urdf/query", summary },
      response: payload
    });

    res.status(status).json(payload);
  }
});

  // ----------------------------------------------------------------------------
  // Startup log summary
  // ----------------------------------------------------------------------------
  // One-line overview of the runtime endpoints exposed by this plugin.
  RED.log.info(
    "[uRDF] runtime plugin loaded: /urdf/health /urdf/size /urdf/graph /urdf/node /urdf/clear /urdf/load /urdf/query /urdf/qa/config /urdf/qa"
  );
};

