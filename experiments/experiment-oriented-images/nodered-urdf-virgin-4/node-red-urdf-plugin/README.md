# Node-RED uRDF Plugin

This repository provides a **Node-RED extension composed of two tightly coupled plugins**:

- a **runtime node** that embeds an RDF store and reasoning engine into the Node-RED runtime
- an **editor sidebar plugin** that exposes inspection and interaction capabilities directly in the Node-RED editor UI

Both plugins are distributed together as a single Node-RED package and share the same `package.json`.

---

## What this plugin provides

At a high level, this package integrates:

- **uRDF** — a lightweight, embeddable RDF store
- **Eyeling** — a rule-based reasoning engine
- **Node-RED runtime integration** — for data ingestion, storage, and reasoning
- **Node-RED editor integration** — for interactive inspection and control via a custom sidebar

The goal is to make **semantic data storage and rule-based reasoning first-class citizens** inside a Node-RED flow-based environment, without requiring external triple stores or reasoning services.

---

## Repository structure

```
.
├── editor/
│   └── urdf-sidebar.html      # Editor (sidebar) plugin
│
├── runtime/
│   └── index.js               # Runtime node implementation
│
├── package.json               # Shared Node-RED package definition
└── README.md                  # This file
```

- The **runtime plugin** lives under `runtime/` and is loaded by Node-RED as a runtime node.
- The **editor plugin** lives under `editor/` and is loaded by Node-RED as an editor sidebar extension.
- Both are declared and wired together through the same `package.json`.

---

## Runtime plugin (overview)

The runtime plugin:

- Instantiates and manages an embedded **uRDF store**
- Integrates the **Eyeling reasoning engine**
- Exposes the store and reasoning capabilities through a Node-RED node
- Manages lifecycle concerns (initialization, reuse, teardown) within the Node-RED runtime

This plugin is responsible for **all execution-time behavior** and does not contain any UI code.

> Detailed runtime behavior is documented inline in the runtime source code.

---

## Editor sidebar plugin (overview)

The editor plugin:

- Registers a custom **Node-RED sidebar tab**
- Provides a UI for inspecting and interacting with the embedded RDF store
- Communicates with the runtime plugin via Node-RED APIs
- Is designed to be read-only / exploratory by default, with explicit actions where mutations occur

This plugin is loaded **only in the Node-RED editor**, not in the runtime.

> Detailed UI behavior and data flow are documented inline in the editor source code.

---

## Installation

From a Node-RED user directory:

```bash
npm install <path-or-git-url-to-this-repo>
```

Then restart Node-RED.

Both the runtime node and the editor sidebar will be automatically registered.

---

## Dependencies

This package depends on the following upstream projects:

- **uRDF**  
  Lightweight RDF store used as the embedded semantic data layer.

- **Eyeling**  
  Rule-based reasoning engine used for inference over RDF data.

The exact versions are pinned via Git commit hashes in `package.json` to ensure deterministic behavior.

---

## Node-RED integration

The `package.json` declares:

- one **runtime node**
- one **editor plugin**

using Node-RED’s standard extension mechanisms.

No additional configuration is required beyond installing the package.

---

## Design notes

- Runtime and editor code are **strictly separated**
- The editor plugin never directly accesses runtime internals
- Communication follows Node-RED’s supported APIs
- The package is intended to be **self-contained**, embeddable, and predictable

This structure is intentional to keep reasoning logic, UI concerns, and Node-RED integration boundaries clean.
