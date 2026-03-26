# Resource Utilization at Rest (v3 — With Question-Answering Functionality)

## What this experiment is about

This experiment re-runs the [resource-utilization-at-rest experiment](https://github.com/mircosoderi/nodered-ontology-based-program-analysis/tree/main/experiments/resource-utilization-at-rest), but this time it compares:

- **imgA**: [nodered-urdf-virgin-4:4.1.3-22](https://github.com/mircosoderi/nodered-ontology-based-program-analysis/tree/main/experiments/experiment-oriented-images/nodered-urdf-virgin-4) (custom Node-RED image, generated from the nodered-urdf-virgin-3 image, by adding the Question-Answering Functionality)
- **imgB**: [nodered/node-red:4.1.3-22](https://hub.docker.com/layers/nodered/node-red/4.1.3-22/images/sha256-1655a8ccebd6fe3465d1aab932599ad7ece2085c7c1e11135e0f0d323ce26d7f) (stock upstream Node-RED)

The goal is to answer:

> *After adding the question-answering functionality, what is the steady-state CPU and RAM overhead of the semantic Node-RED runtime compared to vanilla Node-RED, when doing nothing?*

## How the experiment works

### Measurement approach

The script measures resource usage from outside the containers using:

- `docker stats`

This is intentionally “minimally intrusive”:
- no in-container agents,
- no app instrumentation.

### Cold vs Warm scenarios

Each run measures both:

1. **COLD start**
   - containers start with **fresh /data volumes**
   - captures first-run initialization costs

2. **WARM start**
   - containers start again reusing the same volumes
   - captures steady operational conditions

### Phases

Within each scenario, samples are grouped into:

- **startup** (60 seconds at 1 Hz)
- **idle** (300 seconds at 0.2 Hz)

### Controlled constraints

Both containers are run with identical limits:

- CPU limit: **1 core**
- Memory limit: **1 GiB**

(Defined in `test-runner.sh`.)

## How to run it

### Prerequisites

- Docker installed
- Images available locally:
  - [nodered/node-red:4.1.3-22](https://hub.do

---

## Results

### Table 1 — Baseline resource usage (mean over 3 runs)

CPU is percent of the **1-core** limit.  
Memory is in **MiB**.

| Scenario | Phase | Container | CPU avg (%) | CPU max (%) | RAM avg (MiB) | RAM max (MiB) |
|---|---|---|---:|---:|---:|---:|
| cold | idle | imgA (custom) | 0.1896 | 7.2700 | 56.7326 | 57.2600 |
| cold | idle | imgB (stock) | 0.3534 | 7.3667 | 47.2506 | 47.7733 |
| cold | startup | imgA (custom) | 0.7810 | 21.0867 | 56.2801 | 64.4033 |
| cold | startup | imgB (stock) | 1.7724 | 89.9767 | 46.8355 | 53.9475 |
| warm | idle | imgA (custom) | 0.2336 | 7.1433 | 52.8983 | 53.3767 |
| warm | idle | imgB (stock) | 0.1542 | 4.1400 | 47.0961 | 47.6200 |
| warm | startup | imgA (custom) | 0.5664 | 15.3767 | 52.5181 | 60.1200 |
| warm | startup | imgB (stock) | 1.7804 | 89.5967 | 46.4701 | 53.9083 |

### Table 2 — “At rest” memory overhead of the custom image

Computed from **idle RAM avg** in Table 1:

| Scenario | Idle RAM avg imgA (MiB) | Idle RAM avg imgB (MiB) | Overhead (MiB) |
|---|---:|---:|---:|
| cold | 56.7326 | 47.2506 | **+9.4820** |
| warm | 52.8983 | 47.0961 | **+5.8022** |

### How these tables were produced

1. Each `results/runX/summary.txt` includes two CSV blocks (COLD and WARM) with:
   - `cpu_avg_pct`, `cpu_max_pct`
   - `mem_avg_bytes`, `mem_max_bytes`

2. For each run:
   - `mem_*_bytes` values were converted to MiB (divide by 1024²)

3. Values were then averaged across the three runs:
   - grouped by `(scenario, phase, container)`

No smoothing or filtering was applied beyond averaging across repeats.

## Interpretation

### 1) Idle CPU remains negligible
Both images continue to show very low idle CPU usage (well below 1% of one core), confirming that both runtimes behave as expected when idle. Minor fluctuations are visible across runs, but remain within a negligible range.

### 2) Memory overhead remains stable and consistent with expectations
The custom image shows an idle RAM overhead of approximately:

- **+9.48 MiB** (cold idle)
- **+5.80 MiB** (warm idle)

These values are very close to the previously reported estimates and confirm that the added question-answering functionality introduces a modest and stable memory footprint.

The warm scenario continues to demonstrate a reduced overhead compared to cold, suggesting that part of the additional memory usage is linked to initialization artifacts that are amortized once the system stabilizes.

Overall, the results reinforce the conclusion that the semantic extensions remain lightweight and operationally efficient, keeping the runtime footprint close to that of vanilla Node-RED.

## This experiment in context

You may be interested in understanding more about the place that this experiment occupies in the project.

In that case, the [README file of the experiments folder](https://github.com/mircosoderi/nodered-ontology-based-program-analysis/blob/main/experiments/README.md) would be a good starting point.
