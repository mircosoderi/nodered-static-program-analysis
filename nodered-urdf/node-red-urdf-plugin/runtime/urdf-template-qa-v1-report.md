# Output A — Final supported intents in V1

| Intent id | Purpose | Required parameters | Output type |
|---|---|---|---|
| `warning.listFlaggedEntities` | List nodes or flows that have at least one inferred warning comment. | `entity_kind` = `node` or `flow` | `compact_entity_list` |
| `warning.explainFlaggedEntityByName` | Explain why a named node or flow is flagged, using inferred warning comments and linked imported knowledge counts. | `entity_kind`, `entity_name` | `structured_explanation_list` |
| `inspect.describeEntityByName` | Tell the user about a named node or flow using the application graph and inferred graph. | `entity_kind`, `entity_name` | `structured_entity_detail_list` |
| `related.listImportedDocumentsForEntityByName` | List imported issues or forum posts linked to a named node or flow through inferred `schema:seeAlso` relations. | `entity_kind`, `entity_name`, `source_kind` = `issues` or `forum` | `structured_related_knowledge_list` |
| `related.showImportedKnowledgeForEntityByName` | Show all imported knowledge linked to a named node or flow, grouped by issues, forum posts, and community flows. | `entity_kind`, `entity_name` | `structured_related_knowledge_list` |
| `matching.listApplicationFlowsWithCommunityMatches` | List application flows that have inferred matches to imported community flows. | none | `compact_entity_list` |
| `matching.showCommunityFlowMatchesForFlowByName` | Show imported community flows matched to a named application flow. | `flow_name` | `structured_related_knowledge_list` |
| `inventory.countImportedKnowledge` | Count imported issues, forum posts, or community flows inside their source graph. | `source_kind` | `compact_count` |
| `topic.listImportedKnowledgeByTitleSubstring` | List imported issues, forum posts, or community flows whose `schema:title` contains the given topic substring, case-insensitively. | `source_kind`, `topic` | `compact_entity_list` |

# Output B — Concrete JSON configuration structure proposal

The runtime-loadable JSON configuration is a single document with these top-level sections:

- `catalogId`, `catalogVersion`, `title`, `description`
- `runtimeCompatibility`
- `graphRegistry`
- `namespaceRegistry`
- `sourceCatalog`
- `matchingPolicies`
- `entityDisplayPolicies`
- `answerTypeRegistry`
- `intentRegistry`
- `templates`

Concrete structure:

```json
{
  "catalogId": "string",
  "catalogVersion": "string",
  "title": "string",
  "description": "string",
  "runtimeCompatibility": {
    "host": "string",
    "interactionModel": "stateless",
    "requiresLLM": false,
    "matchingPolicy": "deterministic-only"
  },
  "graphRegistry": {
    "application": "graph id",
    "inferred": "graph id",
    "ontology": "graph id",
    "rules": "graph id",
    "environment": "graph id",
    "importedIssues": "graph id",
    "importedForum": "graph id",
    "importedCommunityFlows": "graph id"
  },
  "namespaceRegistry": {
    "alias": "full IRI"
  },
  "sourceCatalog": {
    "issues|forum|communityFlows": {
      "graphId": "graph id",
      "entityClass": "full IRI",
      "label": "developer-facing label",
      "titlePredicate": "full IRI",
      "urlPredicate": "full IRI",
      "datePredicate": "full IRI",
      "identifierPredicate": "full IRI, when applicable",
      "keywordsPredicate": "full IRI, when applicable",
      "notes": ["optional grounded assumptions"]
    }
  },
  "matchingPolicies": {
    "namedEntityResolution": {
      "field": "full IRI",
      "mode": "exact",
      "caseSensitive": false,
      "trimWhitespace": true,
      "allowMultipleMatches": true,
      "notFoundBehavior": "return_not_found_result"
    },
    "topicLookup": {
      "field": "full IRI",
      "mode": "substring",
      "caseSensitive": false,
      "trimWhitespace": true,
      "allowMultipleMatches": true,
      "notFoundBehavior": "return_not_found_result"
    },
    "importedKnowledgeJoin": {
      "fromGraph": "graph id",
      "predicate": "full IRI",
      "targetMustExistInSourceGraph": true
    }
  },
  "entityDisplayPolicies": {
    "node|flow": {
      "entityClass": "full IRI",
      "displayNameField": "full IRI",
      "identifierField": "full IRI",
      "nodeTypeField": "full IRI, node only",
      "flowLinkField": "full IRI, node only",
      "keywordsField": "full IRI, flow only",
      "fallbackDisplayFormat": "string template"
    }
  },
  "answerTypeRegistry": {
    "answer_type_id": {
      "description": "string",
      "resultShape": { "...": "..." }
    }
  },
  "intentRegistry": [
    {
      "intentId": "string",
      "purpose": "string",
      "requiredParameters": ["..."],
      "outputType": "answer_type_id"
    }
  ],
  "templates": [
    {
      "templateId": "string",
      "label": "string",
      "canonicalTemplate": "string",
      "parameterDefinitions": [
        {
          "name": "string",
          "type": "string",
          "required": true,
          "matchField": "full IRI",
          "matchMode": "exact_case_insensitive|substring_case_insensitive"
        }
      ],
      "intentId": "string",
      "answerType": "string",
      "execution": {
        "strategy": "string",
        "...": "runtime-specific execution metadata"
      },
      "graphHints": ["graphRegistry key"],
      "sourceFilters": ["issues|forum|communityFlows"]
    }
  ]
}
```

# Output C — Complete populated JSON configuration file

The complete populated JSON file is here:

- `urdf-template-qa-v1.json`

# Output D — How runtime and editor should use this JSON

## Runtime use

The runtime should load the JSON once at startup and treat it as the single source of truth for the closed QA catalogue.

For each user request:

1. Match the request only against `templates[].canonicalTemplate` and the declared parameter positions for that template family.
2. Read `intentId`, `answerType`, and `execution` from the matched template.
3. Resolve entities using `matchingPolicies` and `entityDisplayPolicies`.
4. Read only the graphs listed by the template’s `graphHints` and `sourceFilters`.
5. Execute the strategy named in `execution.strategy` deterministically.
6. Return a result object shaped according to `answerTypeRegistry[answerType]`.
7. If entity lookup or topic lookup finds no match, return a clear `not_found` result.
8. If entity lookup finds multiple matches, return all matching entities in one result.

## Editor use

The editor should load the same JSON and use it to render the exact same template catalogue shown to the user.

Specifically, the editor should:

1. Read `templates[]` to build the visible list of supported questions.
2. Use `label`, `canonicalTemplate`, and `parameterDefinitions` to render form controls and help text.
3. Use parameter `type` values to decide whether an input field is a node name, flow name, or topic field.
4. Never invent templates not present in this JSON.
5. Send the selected `templateId` plus concrete parameter values to the runtime.
6. Use `answerType` to decide how to render the returned result shape.

# Grounded assumptions kept intentionally small

1. Named node/flow lookup is configured as exact, case-insensitive match on `schema:name`. This is a design choice because the prompt requires deterministic behavior and forbids fuzzy matching.
2. Some nodes in the application graph do not have `schema:name`. The configuration therefore includes explicit fallback display formats for list answers.
3. The imported GitHub graph contains both issues and pull requests in the sample file. V1 treats all `schema:DigitalDocument` entries in `urn:graph:issues` as imported issue records because the provided project files do not expose a clean dedicated type split.
4. The current provided example inference graph contains node warnings and one flow-to-community-flow match, but no direct flow warning examples. The flow-warning templates remain valid because they are grounded in the same inferred `schema:comment` pattern and can operate when such triples exist.
