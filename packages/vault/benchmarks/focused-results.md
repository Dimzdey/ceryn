# Vault focused performance follow-ups

## Result

Five candidates were evaluated independently. Two are retained in the final tree:

- Candidate 1, the cached `Scope.tryResolve()` fast path.
- Candidate 5, bound-Scope Promise reuse in `Scope.resolveAsync()`.

Candidates 2–4 were rejected and their production/test changes were removed. Candidate 2's
implementation, review-fix, and cleanup commits are retained in history for auditability, but the
sequence has zero net tree diff from `13787d2` to `cfadabd`; those commits are evaluation/cleanup
history, not retained optimization code. Candidates 3 and 4 were never committed.

## Environment and protocol

- Baseline/harness commit recorded by the evidence manifest:
  `2654592970a04e73d50ec413a7fccf2c24b4a08c`.
- Final measured implementation: `0aa5e6efd53a60a01421b435de7b377ba3da4350`.
- Node: `v22.22.2`; npm: `10.9.7`.
- Platform: `darwin x64`.
- CPU: `Intel(R) Core(TM) i5-8500B CPU @ 3.00GHz`, 6 logical cores.
- Package-lock SHA-256:
  `5ac39ca93b7924bf1c7b9f08b297e0b1e9fe46887c618ba753bf153eb43c47d1`.
- Focused runs: seed `42`, 300 ms measured, 75 ms warmup, one fresh npm/Node process per
  replicate. Each process was reduced to one sample median; samples were not pooled. The phase
  result is the median of five process medians.
- Final warm runs: seed `42`, 1200 ms measured, 250 ms warmup, one fresh npm/Node process per
  replicate.
- Final isolated runs: seed `42`, 20 independent timing processes and 20 independent memory
  processes per adapter and orchestrator invocation, 1000 subsequent resolutions per timing
  process.

The final correctness commands, run from `packages/vault`, were:

```bash
npm run typecheck
npm run build
npm test
npx tsc -p tsconfig.test.json --noEmit
```

The final external-validation commands were:

```bash
for run in 1 2 3 4 5; do
  BENCH_SEED=42 BENCH_TIME_MS=1200 BENCH_WARMUP_MS=250 BENCH_OUTPUT_JSON="/tmp/ceryn-vault-followups-20260715/final/warm-$run.json" npm run bench:warm
done

for run in 1 2 3 4 5; do
  BENCH_SEED=42 BENCH_ISOLATED_ADAPTERS=ceryn BENCH_ISOLATED_RUNS=20 BENCH_ISOLATED_SUBSEQUENT=1000 BENCH_OUTPUT_JSON="/tmp/ceryn-vault-followups-20260715/final/isolated-$run.json" npm run bench:isolated
done

BENCH_SEED=42 BENCH_ISOLATED_RUNS=20 BENCH_ISOLATED_SUBSEQUENT=1000 BENCH_OUTPUT_JSON=/tmp/ceryn-vault-followups-20260715/final/isolated-all.json npm run bench:isolated
```

The first sandboxed warm launcher loop was denied at `tsx` IPC setup before the harness emitted
benchmark output or created any JSON. Per the evidence protocol, it was not counted. The identical
loop was rerun with scoped execution permission and produced exactly the five successful warm
artifacts listed below. The isolated suite uses built JavaScript and did not require that rerun.

## Correctness

| Gate                                     | Result                              |
| ---------------------------------------- | ----------------------------------- |
| `npm run typecheck`                      | PASS, exit 0                        |
| `npm run build`                          | PASS, exit 0                        |
| `npm test`                               | PASS, 38/38 files and 307/307 tests |
| `npx tsc -p tsconfig.test.json --noEmit` | PASS, exit 0                        |

## Decision rule

A target improvement requires both an inclusive median-of-medians ratio of at most `0.95` and at
least three after-process medians strictly below the best before-process median. A protected-path
regression requires both an inclusive ratio of at least `1.05` and at least three after-process
medians strictly above the worst before-process median. All correctness/structural gates must also
pass.

## Candidate target evidence

All values below are nanoseconds. Brackets contain the five sorted fresh-process medians. The
Candidate 2 after set is the required fresh replacement captured after both review fixes; the
earlier stale after set is not used. Candidate 3's after set likewise replaces its provisional set
and measures the reviewed ownership-authority fix. Candidate 4 measures the final safe snapshot
variant.

| Candidate and target                                          | Before process medians; median-of-medians                                                                                   | After process medians; median-of-medians                                                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1. Cached `tryResolve()` — `cached tryResolve 1k`             | `[5855735.999999979, 5862632.000000076, 5922819.000000117, 6087661.99999991, 6255652.000000055]`; `5922819.000000117`       | `[17853.000000059183, 17858.000000160246, 17867.000000023836, 17880.0000001047, 17882.99999998344]`; `17867.000000023836`   |
| 2. `canResolve()` certification — `canResolve + resolve 1k`   | `[5913092.000000006, 6232103.999999936, 6287818.999999899, 6336094.999999886, 7048677.999999882]`; `6287818.999999899`      | `[26219.999999966603, 26391.000000103304, 26927.999999998065, 27498.00000015057, 33335.99999996295]`; `26927.999999998065`  |
| 3. Compact Scope state — `scoped cycle 1k`                    | `[362551.0000001668, 363698.0000001131, 364209.9999999573, 365072.0000000547, 388300.00000007206]`; `364209.9999999573`     | `[359997.0000000212, 376375.0000002801, 390194.9999999488, 391274.9999999505, 399006.99999998324]`; `390194.9999999488`     |
| 4. Metadata identity — `metadata + build 100`                 | `[1860873.0000000834, 1883325.9999996698, 1896192.0000001555, 1916449.9999997134, 2182803.000000149]`; `1896192.0000001555` | `[1889642.999999978, 1905650.0000001506, 1906175.9999999595, 2033554.0000000948, 2069030.0000001115]`; `1906175.9999999595` |
| 5. Bound-Scope Promise reuse — `bound scope async cached 100` | `[12580.000000070868, 12706.99999986391, 12813.999999707448, 12875.999999778287, 12945.999999828928]`; `12813.999999707448` | `[6520.9999997932755, 6594.000000404776, 6679.999999960273, 6693.000000268512, 6707.99999988958]`; `6679.999999960273`      |

| Candidate |            Effect ratio | Ratio predicate | Replicate predicate           | Target result | Final decision                                                  |
| --------- | ----------------------: | --------------- | ----------------------------- | ------------- | --------------------------------------------------------------- |
| 1         | `0.0030166378543770257` | true            | true, 5/5 beyond best before  | supported     | Retain (`2f440ab`)                                              |
| 2         |  `0.004282566021699813` | true            | true, 5/5 beyond best before  | supported     | Reject: two protected regressions; net code removed (`cfadabd`) |
| 3         |     `1.071346201367328` | false           | false, 1/5 beyond best before | reject        | Reject and remove                                               |
| 4         |    `1.0052652895908236` | false           | false, 0/5 beyond best before | reject        | Reject and remove                                               |
| 5         |    `0.5213048228588093` | true            | true, 5/5 beyond best before  | supported     | Retain (`0aa5e6e`)                                              |

## Protected paths

The three protected tasks were evaluated independently for every candidate. `5% regression` and
`3 beyond worst` are the two conjunctive inverse predicates.

| Candidate | Protected task          |                Ratio | 5% regression | 3 beyond worst | Established regression |
| --------- | ----------------------- | -------------------: | ------------- | -------------- | ---------------------- |
| 1         | `cached resolve 1k`     | `0.9780614500430734` | false         | false          | no                     |
| 1         | `scoped cycle 1k`       | `0.9773270429236606` | false         | false          | no                     |
| 1         | `root async cached 100` | `1.0158289817389559` | false         | false          | no                     |
| 2         | `cached resolve 1k`     | `1.0620549338733998` | true          | true           | **yes**                |
| 2         | `scoped cycle 1k`       | `1.0799481800456212` | true          | true           | **yes**                |
| 2         | `root async cached 100` | `1.0398797277758318` | false         | true           | no                     |
| 3         | `cached resolve 1k`     | `1.0047159090789983` | false         | true           | no                     |
| 3         | `scoped cycle 1k`       |  `1.071346201367328` | true          | true           | **yes**                |
| 3         | `root async cached 100` | `1.0711886097671837` | true          | true           | **yes**                |
| 4         | `cached resolve 1k`     | `1.0006250355182627` | false         | false          | no                     |
| 4         | `scoped cycle 1k`       | `1.0442834778016312` | false         | false          | no                     |
| 4         | `root async cached 100` | `1.0028515683041626` | false         | false          | no                     |
| 5         | `cached resolve 1k`     | `0.9744626634183103` | false         | false          | no                     |
| 5         | `scoped cycle 1k`       | `0.9827742770568735` | false         | false          | no                     |
| 5         | `root async cached 100` | `1.0021055798153384` | false         | false          | no                     |

Candidate 1 retains cached `undefined`, local-first Scope precedence, disposed-state and token
validation, cross-Vault ownership, and miss-path graph validation while eliminating graph
validation for materialized hits. Candidate 5 returns the existing Vault-owned Promise on bound
success paths while preserving Promise-based synchronous failure delivery through explicit
`try`/`catch` adoption. Both passed their structural and semantic gates and established no
protected regression.

Candidate 2's target gain did not override the binding cached-resolve and scoped-cycle regressions.
Candidate 3 both missed its target and regressed scoped and root-async protected paths. Candidate
4's safety-preserving snapshot was slightly slower and failed both target predicates.

## Final original warm suite

The table reports Ceryn's five process medians and their median-of-medians. Medians use the warm
harness's nearest-rank p50 calculation. Values are nanoseconds per named batch.

| Ceryn task                      | Process medians                                                                                        |    Median-of-medians |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------: |
| Fresh container + first request | `[9738.000000652391, 9789.0000033658, 10154.99999630265, 10195.000002568122, 10427.000001072884]`      |  `10154.99999630265` |
| Warm 1k requests                | `[103694.00000490714, 105415.99999851314, 106799.0000010468, 107953.9999991539, 110790.99999915343]`   |  `106799.0000010468` |
| Burst 10k                       | `[1059305.9999991965, 1069267.9999992833, 1079038.9999965555, 1094896.9999990368, 1102342.0000019541]` | `1079038.9999965555` |
| Parent lookup 5k                | `[40269.99999769032, 42608.000003383495, 49876.000004587695, 71425.99999497179, 73284.9999985774]`     | `49876.000004587695` |
| Scoped 1k                       | `[402775.0000004744, 414011.99999927485, 414353.0000001192, 424375.99999902886, 428958.9999989403]`    |  `414353.0000001192` |
| Async cached singleton 100      | `[6846.000000223285, 6846.9999969238415, 6878.000000142492, 6885.9999992128, 7009.000000834931]`       |  `6878.000000142492` |

Across the five warm replicates, Ceryn was fastest in warm 1k, burst 10k, parent lookup 5k,
scoped 1k, and async cached singleton 100. Tsyringe was fastest for fresh-container creation.

## Final original isolated suite

Each value below is first the median of 20 independent child processes within one orchestrator
replicate, then the median of those five process-level summaries. Timing values are nanoseconds;
the subsequent row is nanoseconds per resolution and retained heap is bytes.

| Ceryn metric                         | Five orchestrator medians                                |     Median-of-medians |
| ------------------------------------ | -------------------------------------------------------- | --------------------: |
| Spawn to child ready                 | `[77807367, 78851248, 78986685, 80348510, 80884683]`     |            `78986685` |
| Framework + fixture import           | `[17652032, 17691634, 18099773, 18148863, 18424484]`     |            `18099773` |
| Container creation + registration    | `[2132593, 2137307, 2176322, 2187029, 2244044]`          |             `2176322` |
| First graph resolution + consumption | `[788596, 791696, 797306, 812447, 815477]`               |              `797306` |
| Subsequent resolution + consumption  | `[418.268, 419.569, 421.07, 421.482, 426.495]`           |              `421.07` |
| Spawn to timing result               | `[99707750, 101878617, 102360784, 103159206, 103528271]` |           `102360784` |
| Directional retained heap            | `[108512, 108512, 108512, 108512, 108512]`               | `108512` (+106.0 KiB) |

Every Ceryn-only orchestrator replicate reported `Semantic contract: PASS` with 23 registrations.
The separate all-adapter invocation also reported PASS for all five adapters:

| Adapter   | Contract | Registrations | Decorator mode                    |
| --------- | -------- | ------------: | --------------------------------- |
| Ceryn     | PASS     |            23 | explicit-token metadata           |
| Tsyringe  | PASS     |            23 | reflect-metadata injection tokens |
| Inversify | PASS     |            23 | reflect-metadata injection tokens |
| TypeDI    | PASS     |            23 | false                             |
| Needle    | PASS     |            23 | false                             |

## Evidence and archive

Raw evidence root: `/tmp/ceryn-vault-followups-20260715`.

- Manifest: `baseline-head.txt`, `node-version.txt`, `npm-version.txt`,
  `package-lock.sha256`.
- Candidate 1: `try-resolve/{before,after}/run-{1..5}.json`, both summaries,
  `decision.json`, `protected-decisions.json`.
- Candidate 2: `can-resolve/{before,after}/run-{1..5}.json`, both summaries,
  `decision.json`, `protected-decisions.json`.
- Candidate 3: `compact-scope/{before,after}/run-{1..5}.json`, both summaries,
  `decision.json`, `protected-decisions.json`.
- Candidate 4: `metadata-identity/{before,after}/run-{1..5}.json`, both summaries,
  `decision.json`, `protected-decision.json`.
- Candidate 5: `scope-async-wrapper/{before,after}/run-{1..5}.json`, both summaries,
  `decision.json`, `protected-decisions.json`.
- Final warm: `final/warm-{1..5}.json`.
- Final Ceryn isolated: `final/isolated-{1..5}.json`.
- Final all-adapter semantic context: `final/isolated-all.json`.
- Artifact manifest: `/tmp/ceryn-vault-followups-20260715/SHA256SUMS`.
- Archive: `/tmp/ceryn-vault-followups-20260715.tar.gz`.
- Archive checksum file: `/tmp/ceryn-vault-followups-20260715.tar.gz.sha256`.
- Archive SHA-256: `427cc560d8110f976a97df3265005dd5fcaf57337eef7803fa37e0810d08c80b`.

The brief's literal `find ... | sort > evidence-root/SHA256SUMS` pipeline has a shell-redirection
defect: the shell creates `SHA256SUMS` before `find` starts, so the manifest can hash its own empty
pre-write state. That invalid self-entry was discarded; no raw evidence changed. The final
85-entry manifest excludes itself, and every listed checksum passes `shasum -a 256 -c`. It was
generated reproducibly with:

```bash
find /tmp/ceryn-vault-followups-20260715 -type f ! -name SHA256SUMS -exec shasum -a 256 {} \; | LC_ALL=C sort > /tmp/ceryn-vault-followups-20260715.SHA256SUMS.tmp
mv /tmp/ceryn-vault-followups-20260715.SHA256SUMS.tmp /tmp/ceryn-vault-followups-20260715/SHA256SUMS
shasum -a 256 -c /tmp/ceryn-vault-followups-20260715/SHA256SUMS
tar -czf /tmp/ceryn-vault-followups-20260715.tar.gz -C /tmp ceryn-vault-followups-20260715
shasum -a 256 /tmp/ceryn-vault-followups-20260715.tar.gz > /tmp/ceryn-vault-followups-20260715.tar.gz.sha256
shasum -a 256 -c /tmp/ceryn-vault-followups-20260715.tar.gz.sha256
```

The committed summaries were re-derived from every raw focused JSON. All ten stored phase
summaries, five target decisions, and fifteen protected decisions matched the recomputation
exactly. Final warm and isolated file counts, seeds, environment, task/run counts, numeric sample
shapes, registration count, and every semantic-contract field were checked directly against raw
JSON before archiving.
