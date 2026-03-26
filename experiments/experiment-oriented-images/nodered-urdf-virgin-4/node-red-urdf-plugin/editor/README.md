# uRDF Node-RED Editor Sidebar Plugin

This folder contains the **editor-side (frontend) plugin** for the uRDF Node-RED package.

The editor plugin runs **in the browser inside the Node-RED editor UI** and provides an interactive sidebar tab for:

- inspecting the embedded RDF store managed by the runtime plugin
- running SPARQL queries against the runtime store
- browsing named graphs (ontology, rules, app/env, inferred)
- managing reasoning rules (create / update / delete)
- observing runtime events published to the editor

> The runtime node implementation lives under `../runtime/`. This editor plugin does not embed uRDF or Eyeling itself; it calls the runtime’s Admin HTTP API.

---

## Entry point

**`urdf-sidebar.html`** is the editor plugin entry point declared in the top-level `package.json` (under `node-red.plugins`).

Node-RED loads this file into the editor and executes its `<script>` section in the browser context.

---

## What the sidebar does

### 1) Presents a dedicated uRDF sidebar tab

The plugin registers a **Node-RED sidebar tab** and renders a small UI “control surface” that stays lightweight and dependency-free.

The UI is built dynamically using standard browser/Node-RED editor APIs, and is designed to avoid heavy frameworks.

### 2) Talks to the runtime via Admin HTTP API calls

All data comes from the runtime plugin via **Admin HTTP endpoints** (typically served from the same Node-RED host/port).

The editor never directly accesses runtime internals. It only:

- calls HTTP endpoints
- renders responses
- triggers explicit actions (e.g., load graph, clear graph, run query)

### 3) Subscribes to runtime events (best-effort)

When available, the plugin subscribes to runtime-published events (via `RED.comms`) and renders them in an “events” view for quick debugging and observability.

---

## Runtime endpoints used by this editor

This plugin calls the following runtime endpoints (as implemented by the runtime plugin):

- `/urdf/clear`
- `/urdf/graph`
- `/urdf/health`
- `/urdf/load`
- `/urdf/loadFile`
- `/urdf/node`
- `/urdf/query`
- `/urdf/rules/create`
- `/urdf/rules/delete`
- `/urdf/rules/update`
- `/urdf/size`

Notes:

- Some endpoints are **read-only** (health, size, graph export).
- Others are **mutating** (clear/load/loadFile/rules CRUD).
- All endpoints are expected to return JSON and to fail safely with structured error payloads.

---

## Typical workflows

### Check runtime health

The sidebar can call the runtime health endpoint and render a small status panel (store size, module availability, etc.).

### Browse graphs

The sidebar allows selecting a graph and viewing its JSON-LD content using the runtime graph/size endpoints.

### Run SPARQL queries

The sidebar exposes a SPARQL input area that posts queries to the runtime and renders the returned bindings/results.

### Manage rules

The sidebar supports rule CRUD operations through the runtime’s rule endpoints:

- create rule resources
- update existing rule resources
- delete rules by `@id`

Rules are stored in the runtime’s rules graph; the editor acts purely as a client.

### Display the results of reasoning

The plugin allows to display under the *Reason* action the results of the reasoning, presented in a developer-friendly manner.

### Watch runtime events

When the runtime publishes structured events, the sidebar displays them as an event stream useful for debugging (startup loads, API calls, inference runs, errors).

---

## Installation

This editor plugin is installed as part of the overall package.

From a Node-RED user directory:

```bash
npm install <path-or-git-url-to-this-repo>
```

Then restart Node-RED. The sidebar tab should appear in the editor.

---

## Design notes (for contributors)

- The editor plugin must remain **browser-safe** and should not rely on Node.js-only APIs.
- Do not assume `RED.comms` is always present; event streaming is best-effort.
- UI updates should be defensive:
  - treat runtime responses as untrusted input
  - prefer setting text content rather than injecting raw HTML
- Keep runtime/editor boundaries strict:
  - no “hidden coupling” via implicit global state
  - all interactions go through the documented endpoints

---

## Troubleshooting

- **Sidebar tab does not appear**
  - Ensure the package is installed in the Node-RED user directory.
  - Verify the top-level `package.json` includes `node-red.plugins.urdf-editor` pointing to this file.
  - Restart Node-RED after installation.

- **Requests fail with 401/403**
  - Node-RED Admin HTTP endpoints are subject to Node-RED’s admin auth configuration.
  - Confirm you are logged into the editor and have permission to access Admin endpoints.

- **Health is OK but graphs are empty**
  - The runtime may not have loaded ontology/rules yet (or file paths may be missing).
  - Inspect the runtime logs and/or the sidebar events stream.

---

## License

Apache License 2.0
