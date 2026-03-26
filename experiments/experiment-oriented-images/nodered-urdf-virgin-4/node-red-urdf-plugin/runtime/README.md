# uRDF Node-RED Runtime Plugin

This folder contains the **runtime-side implementation** of the Node-RED uRDF integration.

The runtime plugin runs **in-process inside Node-RED** and is responsible for:

- creating and managing the embedded **uRDF RDF store**
- (optionally) running **Eyeling** rule-based reasoning to maintain an inferred graph
- exposing a small **Admin HTTP API** (under `/urdf/*`) used by the editor sidebar and by power users
- pushing **structured runtime events** to the editor via `RED.comms` (when available)

> The editor sidebar plugin is implemented separately under `../editor/` and consumes the APIs/events provided here.

---

## Entry point

**`index.js`** is the Node-RED runtime entry point declared in the top-level `package.json`:

- Node-RED loads this module once at startup.
- All logic executes within the Node-RED runtime process.
- Failures must be handled defensively to avoid impacting Node-RED availability.

---

## Core responsibilities

### 1) Embedded RDF store (uRDF)

The runtime requires the uRDF module and uses it as the single in-memory RDF store for:

- loading JSON-LD graphs
- executing SPARQL queries
- exporting graphs for inspection/debugging
- resolving resources by `@id`

### 2) Optional reasoning (Eyeling)

Eyeling is treated as an **optional dependency**:

- if Eyeling is present and provides the expected API, inference is enabled
- if not, the runtime still operates in **SPARQL-only** mode (store + query + export)

Inference is orchestrated from rule resources stored in the *rules graph* (see “Named graphs”).

### 3) Admin HTTP API (`/urdf/*`)

The runtime registers a set of **Admin HTTP endpoints** via `RED.httpAdmin`.

These endpoints are designed to be used by:

- the editor sidebar plugin
- CLI tools / scripts
- advanced users for debugging and automation

### 4) Runtime → editor event stream

When `RED.comms.publish` is available, the runtime publishes structured events on:

- **Topic:** `urdf/events`

This provides editor visibility into runtime activity (startup loads, API calls, inference runs, errors) without requiring aggressive polling.

---

## Named graphs and default graph IDs

The runtime uses multiple graphs to keep concerns separate. Graph IDs are configurable via environment variables (defaults shown).

- **Ontology graph**
  - `URDF_ONTOLOGY_GID` (default: `urn:nrua:ontology`)
  - loaded from `URDF_ONTOLOGY_PATH` at startup

- **Rules graph**
  - `URDF_RULES_GID` (default: `urn:nrua:rules`)
  - loaded from `URDF_RULES_PATH` at startup
  - holds rule resources used for inference orchestration

- **Application graph**
  - `URDF_APP_GID` (default: `urn:nrua:app`)
  - derived from Node-RED Admin API data (not from a static file)

- **Environment graph**
  - `URDF_ENV_GID` (default: `urn:nrua:env`)
  - derived from Node-RED runtime/admin diagnostics and settings

- **Inferred graph**
  - `URDF_INFERRED_GID` (default: `urn:graph:inferred`)
  - deterministic “replacement graph” produced by reasoning runs

---

## Startup behavior (high level)

On runtime startup, the plugin follows an initialization sequence conceptually similar to:

1. load the **ZURL dictionary** (used for IRI compression) if present
2. load the **ontology** JSON-LD file into the ontology graph
3. load the **rules** JSON-LD file into the rules graph
4. derive/update the **environment** and **application** graphs from Node-RED Admin API data
5. run inference (if enabled) to populate the inferred graph

All of these steps emit events to the `urdf/events` channel (when editor comms are available).

---

## IRI compression (ZURL / `z:<n>` tokens)

This runtime supports an IRI compression scheme to reduce payload sizes and keep documents stable:

- a dictionary of IRIs is stored in **ZURL**
- IRIs can be represented as compact tokens `z:<index>`
- query/graph payloads are expanded where appropriate for editor consumption

### ZURL path

The dictionary is loaded from:

- `URDF_ZURL_PATH` (default: `/opt/urdf/zurl.json`)

and can be fetched at runtime via:

- `GET /urdf/zurl`

---

## Admin HTTP API

All endpoints are registered under `RED.httpAdmin`.

> Exact contracts are enforced defensively (types, required fields) and errors are returned as JSON with `ok: false`.

### Read endpoints

- `GET /urdf/health`  
  Runtime health check (module presence + store size)

- `GET /urdf/size?gid=<graphId>`  
  Total store size, or size of a specific named graph

- `GET /urdf/graph?gid=<graphId>`  
  Return the JSON-LD graph array for the default graph or a named graph

- `GET /urdf/export?gid=<graphId>`  
  Download a JSON-LD document containing the default graph or a named graph

- `GET /urdf/node?id=<iri>&gid=<graphId>`  
  Fetch a single resource by `@id`, optionally scoped to a named graph

- `GET /urdf/zurl`  
  Return the current ZURL dictionary

### Mutating endpoints

- `POST /urdf/clear`  
  Body: `{ "gid": "optional" }`  
  Clears the specified named graph, or clears the default store when omitted.

- `POST /urdf/load`  
  Body: `<JSON-LD object or array>`  
  Appends a JSON-LD document into the store (append semantics).

- `POST /urdf/loadFile`  
  Body: `{ "doc": <JSON-LD object or array> }`  
  Replaces a named graph using `doc["@id"]` as the target graph id (clear + load).

- `POST /urdf/query`  
  Body: `{ "sparql": "..." }`  
  Executes a SPARQL query (ASK/SELECT supported) and returns structured results.

### Rule management endpoints

Rules are stored as JSON-LD resources inside the rules graph and are managed via:

- `POST /urdf/rules/create`  
  Body: `{ "rule": <JSON-LD rule resource> }`

- `POST /urdf/rules/update`  
  Body: `{ "rule": <JSON-LD rule resource> }`

- `POST /urdf/rules/delete`  
  Body: `{ "id": "<rule @id>" }`

These endpoints validate rule shape (including required `@id` and expected rule type) and are intended to support UI-driven rule editing.

---

## Environment variables

The runtime supports the following environment variables (defaults shown):

- `URDF_ZURL_PATH=/opt/urdf/zurl.json`
- `URDF_ONTOLOGY_PATH=/opt/urdf/nodered-user-application-ontology.flattened.compressed.jsonld`
- `URDF_RULES_PATH=/opt/urdf/rules.flattened.compressed.jsonld`

- `URDF_ONTOLOGY_GID=urn:nrua:ontology`
- `URDF_RULES_GID=urn:nrua:rules`
- `URDF_APP_GID=urn:nrua:app`
- `URDF_ENV_GID=urn:nrua:env`
- `URDF_INFERRED_GID=urn:graph:inferred`

---

## Example usage (curl)

### Health check

```bash
curl -s http://localhost:1880/urdf/health | jq
```

### Run a SELECT query

```bash
curl -s -X POST http://localhost:1880/urdf/query   -H 'Content-Type: application/json'   -d '{"sparql":"SELECT * WHERE { ?s ?p ?o } LIMIT 10"}' | jq
```

### Replace a named graph from a JSON-LD document

```bash
curl -s -X POST http://localhost:1880/urdf/loadFile   -H 'Content-Type: application/json'   -d '{"doc":{"@id":"urn:example:graph","@graph":[{"@id":"urn:x","@type":["urn:t"]}]}}' | jq
```

---

## Design notes (for contributors)

- The runtime is intentionally **self-contained** and avoids relying on private Node-RED internals.
- Runtime → editor communication uses `RED.comms` when present and is treated as best-effort.
- Inference uses deterministic replacement of the inferred graph to avoid incremental drift.
- API handlers are expected to be conservative: reject malformed input early, return structured error payloads, never crash the host process.

