# Benchmark Methodology

The benchmark compares Ceryn Vault, Tsyringe, Inversify, TypeDI, and Needle using the dependency versions in the repository lockfile. It deliberately separates warm-process microbenchmarks from process-level startup and memory measurements.

## Commands

Run the Tinybench warm-process suite:

```bash
npm run bench -w packages/vault
# equivalent explicit name
npm run bench:warm -w packages/vault
```

Run independent process-level timing, semantic-contract, and retained-memory measurements:

```bash
npm run bench:isolated -w packages/vault
```

The isolated command builds Ceryn first so each plain Node child imports the distributable package in the same way as a consumer.

## Shared graph and registrations

Every adapter registers 23 entries: Logger, Database, Cache, six Repository/Service/Controller chains, one scoped service, and one unused asynchronous database entry. The resolved graph is:

```text
Controller -> Service -> Repository -> Database -> Logger
```

The semantic contract checks the `db:users` result, controller singleton identity, parent/imported Logger identity, stability inside one request scope, isolation across request scopes, and the request-ID override. Capability output separately describes decorators, async resolution, child containers, and disposal because those APIs are not identical across libraries.

## Warm-process Tinybench suite

All frameworks are imported into one Node process. Adapter classes and decorator metadata are declared before Tinybench records samples. Adapter setup and 200 warmup requests run in `beforeAll`; Tinybench then performs its own per-task warmup.

| Phase                                            | Timed work                                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fresh container + first request (warm process)   | Build fresh parent and application containers, register the graph, resolve one controller, and consume its result inside an already-warm V8 process.         |
| Warm 1k requests                                 | Resolve and consume 1,000 controllers from a pre-built, warmed container.                                                                                    |
| Burst 10k                                        | Resolve and consume 10,000 controllers from a pre-built, warmed container.                                                                                   |
| Parent lookup 5k                                 | Resolve a cached Logger singleton from the parent/imported container 5,000 times.                                                                            |
| Scoped 1k                                        | Create 1,000 child scopes, provide a request ID, resolve one request-scoped service, consume it, and perform idiomatic synchronous teardown where available.  |
| Async cached singleton 100                       | Await a pre-created async singleton 100 times. Only adapters with native asynchronous resolution participate.                                                |

This suite does not measure process startup, module import, or a cold V8 runtime. The focused `BENCH_PROFILE=ceryn-cold` compatibility profile is also a warmed-process container/first-resolution split; `BENCH_FRESH_ITERATIONS` sets its sample count (`BENCH_COLD_ITERATIONS` remains accepted).

Tinybench reports task latency in milliseconds. The suite converts samples to nanoseconds and reports both batch and per-operation medians. Tail values require at least ten expected observations in the tail:

| Percentile | Minimum samples |
| ---------- | --------------- |
| p90        | 100             |
| p95        | 200             |
| p99        | 1,000           |
| p99.9      | 10,000          |

Lower-sample tails are labelled `insufficient samples`. Set `BENCH_SEED` to reproduce task order, `BENCH_HISTOGRAM=1` to print power-of-two histograms, and `BENCH_OUTPUT_JSON=/absolute/or/relative/path.json` to retain every raw Tinybench sample. `BENCH_TIME_MS` and `BENCH_WARMUP_MS` can shorten diagnostic smoke runs; published comparisons should use the printed duration settings and enough samples for the statistics they report.

## Isolated process suite

The orchestrator imports no DI framework. For each adapter and repetition it starts a fresh plain Node child. The child reports ready before dynamically importing exactly one framework fixture.

Timing mode records:

1. process spawn to child ready;
2. framework import, graph declaration, and decorator/metadata initialization;
3. container creation and registration;
4. first graph resolution plus result consumption;
5. subsequent graph resolutions plus result consumption;
6. process spawn to timing-result receipt.

Memory mode is a separate `--expose-gc` process. It imports the adapter, performs three forced collections to establish a post-import baseline, builds and first-resolves the graph, performs three more collections, and reports retained heap delta.

The default is 20 independent processes per adapter for timing and 20 for memory. Results are summarized across process runs with median, interquartile range, minimum, and maximum. Process-level p99 values are intentionally not reported.

Configuration:

- `BENCH_ISOLATED_RUNS=20` sets independent timing and memory repetitions.
- `BENCH_ISOLATED_SUBSEQUENT=1000` sets subsequent resolutions per timing process.
- `BENCH_ISOLATED_ADAPTERS=ceryn,tsyringe` limits adapters for smoke or diagnostic runs.
- `BENCH_SEED=42` reproduces per-run adapter ordering.
- `BENCH_OUTPUT_JSON=/tmp/ceryn-isolated.json` writes process-level timings, memory deltas, capabilities, semantic results, and observed GC events.

For GC diagnostics, raw JSON includes `PerformanceObserver` GC entries when Node exposes them. OS-level tracing such as `NODE_OPTIONS=--trace-gc` can provide additional evidence, but trace output must not be confused with benchmark samples.

## Interpretation rules

- Treat results as measurements of this graph and these semantics, not universal rankings.
- Compare only runs from the same machine, Node version, dependency lockfile, power state, and background-load conditions.
- Use the warm suite for hot-path microbenchmarks and the isolated suite for startup/module-import claims.
- Inspect raw distributions or histograms when percentiles show a latency cliff; a median alone cannot diagnose GC, allocation, or scheduler effects.
- Retained heap is a GC-assisted directional estimate, not a stable memory limit. Repeat it and report the process-level distribution.
- Disposal and lifecycle capabilities differ. Publish the capability matrix with performance results.
- Do not describe the async warm phase as factory-creation cost because singleton creation completes outside timed samples.
- Do not publish a headline multiplier without raw results, environment, variance, exact workload, and semantic-contract status.
