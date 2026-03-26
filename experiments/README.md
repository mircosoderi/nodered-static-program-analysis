# Experiments

This folder documents the experiments conducted during a research project whose objective is to explore the feasibility of embedding **semantic reasoning capabilities directly into the Node-RED runtime** via plugins, while remaining **resource-efficient (lightweight)**.

The overarching goal is to support Node-RED developers with **inline, context-aware insights** derived from semantic reasoning over:

- the Node-RED application under development, represented as a **knowledge graph**, and  
- multiple forms of **community knowledge** (e.g. reusable flows, bug reports, forum discussions), also represented as knowledge graphs.

Joint reasoning over these sources enables capabilities such as:
- detection of reusable, ready-to-use flows,
- identification of nodes known to be buggy (e.g. referenced in GitHub issues or forum posts),
- static analyses based on N3 reasoning, such as:
  - detection of connection loops that may cause runtime instability,
  - identification of data-processing nodes not connected to any output or sink.

## Proof of Concept Architecture

The proof-of-concept system is packaged as a [**Docker image**](https://github.com/mircosoderi/nodered-ontology-based-program-analysis/tree/main/nodered-urdf), built on top of the [most recent](https://hub.docker.com/layers/nodered/node-red/4.1.3-22/images/sha256-1655a8ccebd6fe3465d1aab932599ad7ece2085c7c1e11135e0f0d323ce26d7f) official Node-RED image available at project start.

Two Node-RED plugins were added:

### Runtime plugin
- Integrates a lightweight RDF store ([**uRDF**](https://github.com/vcharpenay/uRDF.js/))
- Integrates a lightweight N3 reasoner ([**eyeling**](https://github.com/eyereasoner/eyeling))
- Automatically generates and maintains a semantic representation of the user application at startup and on every update

[Link to runtime plugin folder](https://github.com/mircosoderi/nodered-ontology-based-program-analysis/tree/main/nodered-urdf/node-red-urdf-plugin/runtime)

### Editor plugin
- Adds a new sidebar panel to the Node-RED editor
- Allows inspection and management of semantic data (graphs, rules)
- Displays reasoning results inline

[Link to editor plugin folder](https://github.com/mircosoderi/nodered-ontology-based-program-analysis/tree/main/nodered-urdf/node-red-urdf-plugin/editor)

## Technology Choices

### uRDF
uRDF was selected because it is:
- lightweight,
- designed for resource-constrained environments,
- modular,
- open source, 
- npm package (JavaScript, same as Node-RED).

This combination is rare according to the state of the art described in a [recent PhD thesis](https://theses.hal.science/tel-03697222/document) on resource-constrained knowledge graphs.

### eyeling
Eyeling was selected because it is:
- a recent initiative (started November 2025),
- led by the authors of the EYE reasoner,
- specifically aimed at creating a **lightweight N3 reasoner** usable:
  - as a Node.js application,
  - as a client-side component in web frontends.
- npm package or standalone JavaScript file (same langauge of Node-RED).

[Link to the eyeling repository](https://github.com/eyereasoner/eyeling)

## Correctness evaluation

Correctness was validated manually by:
1. Running the container 
2. Inspecting the automatically generated semantic representation of the application
3. Loading external semantic data 
4. Defining rules
5. Verifying that inference results matched expectations and that no major defects emerged

## Docker Image Size Optimization

A first objective was minimizing the **Docker image size at rest**.

After optimizing the [Dockerfile](https://github.com/mircosoderi/nodered-ontology-based-program-analysis/blob/main/nodered-urdf/Dockerfile), the resulting image size closely matched the original Node-RED image:

```
IMAGE                         ID             DISK USAGE   CONTENT SIZE
nodered-urdf:4.1.3-22         7cdc8bf004cd     975MB        223MB
nodered/node-red:4.1.3-22     f1e535b16135     950MB        219MB
```

The enriched image is only **4 MB larger**, corresponding to a **1.8% increase**, despite including:
- RDF store,
- N3 reasoner,
- runtime and editor plugins,
- ontology,
- example flows and rules.

This was considered a first successful result.

## Resource Utilization at Rest (Baseline Measurement)

The next question was:

> *What is the CPU and RAM overhead of adding semantic capabilities to Node-RED, even when they are not actively used?*

To answer this, an experimental image without preloaded data was created and compared against the original Node-RED image.

Measurements were collected:
- from cold start and warm start,
- during startup (first minute) and during idle operation (subsequent five minutes),
- in all cases, with no user activity.

Results showed:
- no significant CPU overhead,
- ~20 MB additional RAM usage at rest, corresponding to nearly **+50%** relative to vanilla Node-RED.

[Link to experiment folder](https://github.com/mircosoderi/nodered-ontology-based-program-analysis/tree/main/experiments/resource-utilization-at-rest)

## Isolating Memory Overhead: uRDF Memory Occupation at Rest 

A hypothesis was formulated that **uRDF was responsible** for most of the memory overhead.

A minimal Node.js application was built:
- initially without uRDF,
- dynamically loading uRDF on an external trigger.

Using Docker memory statistics, instantiating uRDF increased memory usage by **~22 MB**, confirming the hypothesis.

[Link to experiment folder](https://github.com/mircosoderi/nodered-ontology-based-program-analysis/tree/main/experiments/urdf-memory-occupation-at-rest)

## Decomposing uRDF Memory Usage

A decomposition experiment tested individual components:
- `jsonld`
- `sparqljs`
- `io`
- SPARQL parser
- uRDF store instantiation

Results showed that **`jsonld` and `io` accounted for most of the baseline memory overhead**.

[Link to experiment folder](https://github.com/mircosoderi/nodered-ontology-based-program-analysis/tree/main/experiments/decompose-urdf-memory-occupation-at-rest)

## uRDF Optimization via Forking

Design decisions:
- Recommend **already flattened JSON-LD documents** as input
- Run a best-effort resource-efficient flattening if the input is not flattened. 
- Remove support for loading data from external URLs

This reduced flexibility but significantly improved baseline memory usage.

uRDF was [**forked**](https://github.com/mircosoderi/uRDF.js), and all subsequent changes were made in the fork used by this project.

Validation showed:
- baseline memory overhead reduced from **~20 MB to ~3 MB** ([link to experiment folder](https://github.com/mircosoderi/nodered-ontology-based-program-analysis/tree/main/experiments/urdf-memory-occupation-at-rest-2)),
- total Node-RED overhead of about 5 MB (+10%) ([link to experiment folder](https://github.com/mircosoderi/nodered-ontology-based-program-analysis/tree/main/experiments/resource-utilization-at-rest-2)).

## Ablation: Cost of Supporting N3 Reasoning (measured at rest)

An ablation experiment evaluated the cost of enabling eyeling:
- Cold start: ~+2 MB RAM overhead
- Warm start: negligible difference
- CPU impact: negligible

[Link to experiment folder](https://github.com/mircosoderi/nodered-ontology-based-program-analysis/tree/main/experiments/resource-utilization-at-rest-2-without-eyeling)

## Memory Scaling with Growing Applications

Scaling experiments evaluated how memory usage grows as application size increases.

Initial results showed:
- semantic Node-RED: ~60% memory increase for 100× application size,
- vanilla Node-RED: ~30% increase.

Most importantly, they showed a significant gap in memory usage (avg, peak) between semantic and vanilla Node-RED:
- semantic Node-RED: avg memory usage 90 M, peak memory usage 110 M
- vanilla Node-RED:  avg memory usage 60 M, peak memory usage  70 M  

[Link to experiment folder](https://github.com/mircosoderi/nodered-ontology-based-program-analysis/tree/main/experiments/resource-utilization-growing-flows-no-reasoning)

## Semantic Compression Strategy

To improve scaling:
- IRIs were indexed and internally compacted (e.g. `<z:0>`),
- compression/decompression is transparent to users,
- no prefixes, base IRIs, or JSON-LD contexts are supported.

This favors simplicity and efficiency over expressiveness.

## Improved Scaling Results

With compression:
- scalability with respect to application size did not improve significantly
- gap in memory usage (avg, peak) between semantic and vanilla Node-RED reduced by ~50%
- CPU peaks increased slightly (~10%), acceptable in practice.

[Link to experiment folder](https://github.com/mircosoderi/nodered-ontology-based-program-analysis/tree/main/experiments/resource-utilization-growing-flows-no-reasoning-2)

Ablation without eyeling showed minor, inconsistent differences ([link to experiment folder](https://github.com/mircosoderi/nodered-ontology-based-program-analysis/tree/main/experiments/resource-utilization-growing-flows-no-reasoning-2-without-eyeling)).

## Scalability and Execution Time Analysis Under Double Stress

Final experiments showed:
- linear scaling of application and inferred graphs,
- end-to-end reasoning time <200 ms at ~10k triples,
- SPARQL evaluation dominates runtime,
- N3 reasoning remains bounded and proportional.

[Link to experiment folder](https://github.com/mircosoderi/nodered-ontology-based-program-analysis/tree/main/experiments/resource-utilization-growing-flows-with-reasoning-2)

## Integration of a lightweight question-answering component

A question answering component co-designed with Chat-GPT 5 was added. The language model is only involved at design-time, and it produces a configuration and resource-aware client-server software that deterministically executes that configuration, without heavy dependencies or AI models involved at execution time. The configuration includes the list of the parametric questions that are supported (the user needs to pick one of those throught the Web interface), the corresponding parametric SPARQL queries, and the templates for the composition of the textual answers to be returned to the user. The client-server software in this case is integrated as extensions of the pre-existing runtime and editor plugins. The outlined approach allowed to balance the power of LLMs with the necessity to keep the overhead. A dedicated experiment demonstrates that after the introduction of this specific question-answering component, the overhead in terms of resource utilizations remains low, perfectly aligned to the resource overhead that was observed before that the question answering component was introduced. 

[link to experiment folder](https://github.com/mircosoderi/nodered-ontology-based-program-analysis/tree/main/experiments/resource-utilization-at-rest-3)
 
## Conclusion

The experiments demonstrate that **hybrid SPARQL + N3 reasoning can be embedded into the Node-RED runtime in a predictable, scalable, and lightweight manner**, provided that:
- semantic scope is controlled,
- internal representations are compact,
- RDF store and reasoning strategies are designed for constrained environments.
