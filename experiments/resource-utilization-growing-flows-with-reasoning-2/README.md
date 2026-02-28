# Experiment Logbook --- Lightweight Semantic Reasoning Scalability

This document describes a coherent set of experiments conducted to
understand how the lightweight semantic reasoning system behaves when
the size of the Node-RED application increases.

------------------------------------------------------------------------

## Setup

We started from:

-   5 Node-RED flows (20 nodes per flow)
-   5 rules:
    -   3 SPARQL-only
    -   2 SPARQL + N3

To test scalability, we created replicated versions of the original
flows.

Scaling factors tested:

| Factor | Meaning            |
|--------|--------------------|
| 1      | Original flows     |
| 2      | Double the flows   |
| 4      | 4× flows           |
| 8      | 8× flows           |
| 16     | 16× flows          |
| 32     | 32× flows          |
| 48     | 48× flows          |
| 64     | 64× flows          |

------------------------------------------------------------------------

## Problem in Initial Tests: Inference Explosion

### What happened

In the first attempt, flows were duplicated without modifying their
names.

A rule stating that resources with identical names are `sameAs` caused
cross-replica equivalence relations and combinatorial growth of inferred
triples.

### Why this was wrong

We were not measuring scalability of reasoning. We were measuring the
side effects of name collisions.

### Fix

Each replica prefixes:
- Flow label → `[rK] original_label`
- Node name → `[rK] original_name`

This restored semantic independence.

------------------------------------------------------------------------

## Experimental Procedure

For each scaling factor:

1.  Generate scaled flows with prefixed names.
2.  Deploy via Node-RED Admin API.
3.  Deployment triggers full semantic regeneration and reasoning.
4.  Measure:
    -   End-to-end reload time (`t_reload_ms`)
    -   Rule execution times (`t_rule_ms`)
    -   Triple counts via `/urdf/size`:
        -   Application graph size
        -   Inferred graph size

------------------------------------------------------------------------

## How App Data Scales

| Factor | size_app |
|--------|----------|
| 1      | 662      |
| 2      | 1323     |
| 4      | 2645     |
| 8      | 5289     |
| 16     | 10577    |

Observation: Application triples grow linearly with application size.

------------------------------------------------------------------------

## How Inferred Graph Scales

| Factor | size_inferred |
|--------|---------------|
| 1      | 142           |
| 2      | 284           |
| 4      | 568           |
| 8      | 1136          |
| 16     | 2272          |

| Factor | inferred/app |
|--------|--------------|
| 1      | 0.21         |
| 2      | 0.21         |
| 4      | 0.21         |
| 8      | 0.21         |
| 16     | 0.21         |

Observation:
- Inferred triples grow linearly.
- Ratio remains constant.
- No cross-replica explosion.
- Full regeneration remains structurally stable.

------------------------------------------------------------------------

## End-to-End Reasoning Time (Original Resource Budget)

| Factor | size_app | t_reload_ms |
|--------|----------|-------------|
| 1      | 662      | 85.9        |
| 2      | 1323     | 94.7        |
| 4      | 2645     | 109.8       |
| 8      | 5289     | 135.2       |
| 16     | 10577    | 186.4       |

Observations:
- Smooth growth.
- No instability.
- < 200 ms up to ~10k triples.
- Per-triple cost decreases with scale (fixed overhead amortization).

------------------------------------------------------------------------

# Extended Resource Envelope Experiments

To further analyze scalability limits, additional experiments were
conducted under constrained container configurations:

-   1 CPU / 1 GB RAM
-   1 CPU / 2 GB RAM
-   2 CPU / 1 GB RAM
-   2 CPU / 2 GB RAM

Scaling extended up to factor 64 (~6400 nodes).

## Observed Reload Times at Largest Scale (x64)

| Configuration | t_reload_ms |
|---------------|-------------|
| 1CPU-1GB      | ~203 s      |
| 1CPU-2GB      | ~185 s      |
| 2CPU-1GB      | ~155 s      |
| 2CPU-2GB      | ~139 s      |

### Interpretation

-   No inference explosion observed.
-   Triple counts remained linear.
-   Memory increase alone provides limited improvement.
-   Increasing CPU yields more significant reduction in reload time.
-   Regeneration cost is primarily CPU-bound.
-   Scaling remains stable but latency grows superlinearly.

------------------------------------------------------------------------

## Scalability Characterization

Across all configurations:

-   Application graph growth: Linear.
-   Inferred graph growth: Linear.
-   Inference ratio: Constant.
-   Memory behavior: Stable.
-   Primary bottleneck: CPU-bound reasoning cost.
-   No structural instability observed even at 6400 nodes.

------------------------------------------------------------------------

## Architectural Insight

These experiments support the design decision of **full semantic
regeneration** instead of incremental diff-based updates.

Results indicate:

-   Structural stability.
-   Predictable scaling.
-   No accumulation drift.
-   No inference explosion under controlled rule isolation.
-   Scalability limitations are computational, not structural.

------------------------------------------------------------------------

## What This Experiment Demonstrates

-   Full regeneration can scale predictably.
-   Runtime-embedded reasoning remains structurally stable.
-   Scalability limits arise from CPU cost, not graph explosion.
-   The architectural design is robust under realistic and stress-tested
    scales.

------------------------------------------------------------------------

## What This Experiment Does NOT Demonstrate

-   Worst-case theoretical complexity.
-   Behavior under arbitrary recursive rule patterns.
-   Performance beyond tested scales.
-   Formal guarantees of soundness or completeness.
