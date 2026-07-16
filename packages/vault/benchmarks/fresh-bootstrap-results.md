# Vault fresh-bootstrap performance

## Result

The only retained implementation is Task 1's profiler contract at
`02c6195eb3d2e060ea96ccde9cf8187eaba95e2f` (`perf(vault): expose fresh bootstrap
samples`). It adds raw JSON samples for container boot, first request, and their combined path;
it does not alter provider runtime behavior.

Task 2's provider-blueprint implementation was an uncommitted experiment on top of `02c6195`.
It passed candidate correctness and protected-path gates, but was rejected because the combined
fresh-container target regressed from `6,458 ns` to `24,938 ns` (ratio
`3.8615670486218643`). Its source, tests, and generated output were removed completely. The final
correctness, warm, and isolated runs in this report measure the restored retained source at
`02c6195`, not the rejected candidate.

## Environment and protocol

- Design commit: `a78b8bb9fad6756ca3abf46a040bd6264c86307f`.
- Retained profiler and final measured source: `02c6195eb3d2e060ea96ccde9cf8187eaba95e2f`.
- Candidate commit: none; the rejected Task 2 experiment was measured uncommitted and removed.
- Baseline evidence head: `02c6195eb3d2e060ea96ccde9cf8187eaba95e2f`.
- Node: `v22.22.2`; npm: `10.9.7`.
- Platform: `darwin x64`.
- CPU: `Intel(R) Core(TM) i5-8500B CPU @ 3.00GHz`, 6 logical cores.
- Package-lock SHA-256:
  `5ac39ca93b7924bf1c7b9f08b297e0b1e9fe46887c618ba753bf153eb43c47d1`.
- Profile comparisons: seed `42`, 20,000 iterations in each of five independent npm/Node
  processes. Each process is reduced to its upper-middle sample median, and the phase result is
  the upper-middle median of those five process medians. Raw samples are never pooled.
- Focused candidate comparisons: seed `42`, 300 ms measured and 75 ms warmup per task, five
  independent npm/Node processes.
- Candidate warm comparisons and final warm runs: seed `42`, 1,200 ms measured and 250 ms
  warmup per task, five independent npm/Node processes.
- Final isolated runs: seed `42`, 20 independent timing processes and 20 independent memory
  processes per adapter and orchestrator invocation, with 1,000 subsequent resolutions per
  timing process.

The acceptance rule requires both an inclusive target ratio of at most `0.95` and at least three
after-process medians strictly below the best before-process median. A protected regression
requires both an inclusive ratio of at least `1.05` and at least three after-process medians
strictly above the worst before-process median.

## Correctness

The final commands were run from `packages/vault` on the restored retained source:

```bash
npm run typecheck
npm run build
npm test
npx tsc -p tsconfig.test.json --noEmit
```

| Gate | Result |
| --- | --- |
| `npm run typecheck` | PASS, exit 0 |
| `npm run build` | PASS, exit 0 |
| `npm test` | PASS, 38/38 files and 308/308 tests |
| `npx tsc -p tsconfig.test.json --noEmit` | PASS, exit 0 |

Raw command logs are in `final/typecheck.log`, `final/build.log`, `final/test.log`,
`final/test-typecheck.log`, and the fresh completion run `final/test-final.log` under the
evidence root.

## Rejected provider-blueprint evidence

All profile values are nanoseconds. Each bracket contains the five sorted independent-process
medians; the last column is their median-of-medians.

| Metric | Before process medians | Before MoM | Candidate process medians | Candidate MoM |
| --- | --- | ---: | --- | ---: |
| Container boot | `[4982, 4984, 5013, 5274, 5357]` | `5013` | `[23117, 23202, 23280, 23820, 24153]` | `23280` |
| First request | `[1408, 1435, 1444, 1461, 1484]` | `1444` | `[1543, 1551, 1561, 1628, 1641]` | `1561` |
| Combined fresh container + first request | `[6389, 6438, 6458, 6745, 6846]` | `6458` | `[24687, 24759, 24938, 25461, 25732]` | `24938` |

Exact target decision:

- Ratio: `3.8615670486218643` (`24,938 / 6,458`).
- Five-percent improvement predicate: `false`.
- Candidate medians below the best before median (`6,389 ns`): `0`.
- At least three below best-before predicate: `false`.
- Decision: `reject`.

The exact reason for rejection is that the implementation failed both binding target predicates
and made the combined path 3.86 times slower. The experiment cloned dependency arrays, summon
arrays, aliases, metadata, and Entry records per Vault; that allocation/materialization cost
overwhelmed the existing registration path. Correctness and protected-path results cannot retain
an implementation that fails the target.

### Protected decisions

All five protected decisions remained below the conjunctive rejection threshold. Values are
candidate-after compared with before.

| Protected task | Before medians ns; MoM | Candidate medians ns; MoM | Ratio | `>= 1.05` | Beyond worst before | Reject |
| --- | --- | --- | ---: | --- | ---: | --- |
| Warm 1k requests | `[99517.00000237906, 101199.99999733409, 101317.00000056298, 103661.999994074, 106150.99999995437]`; `101317.00000056298` | `[98294.00000307942, 104532.99999790033, 104593.00000366056, 104954.00000218069, 107165.99999432219]`; `104593.00000366056` | `1.032334159154726` | false | 1 | false |
| Scoped 1k | `[362836.0000002431, 364111.0000007757, 375040.0000008085, 383368.0000007007, 403835.9999995009]`; `375040.0000008085` | `[371863.00000030315, 378346.9999998488, 383697.99999964016, 384476.99999960605, 406612.00000067765]`; `383697.99999964016` | `1.0230855375394972` | false | 1 | false |
| Async cached singleton 100 | `[6395.000000338769, 6585.999999515479, 6642.000000283588, 6720.999997924082, 6762.9999975906685]`; `6642.000000283588` | `[6550.999998580664, 6674.0000002027955, 6686.000000627246, 6703.000002744375, 6761.000000551576]`; `6686.000000627246` | `1.0066245107410086` | false | 0 | false |
| Cached `tryResolve` 1k | `[17835.999999988417, 17848.000000185493, 17855.99999993792, 18348.99999994377, 18804.000000045562]`; `17855.99999993792` | `[17869.000000018787, 17935.000000079526, 17961.000000013883, 18238.000000110333, 18363.0000001358]`; `17961.000000013883` | `1.0058803763483606` | false | 0 | false |
| Bound-Scope async cached 100 | `[5963.99999994901, 5981.999999676191, 6037.999999989552, 6048.000000191678, 6139.000000075612]`; `6037.999999989552` | `[6048.999999620719, 6092.0000000805885, 6133.999999747175, 6202.000000030239, 6264.000000101078]`; `6133.999999747175` | `1.015899304365318` | false | 2 | false |

The executable checks were:

```bash
jq -e '
  .decision == "reject" and
  .atLeastFivePercent == false and
  .atLeastThreeBeyondBestBefore == false
' /tmp/ceryn-vault-fresh-bootstrap-20260716/decision.json

jq -e 'length == 5 and all(.[]; .reject == false)' \
  /tmp/ceryn-vault-fresh-bootstrap-20260716/protected-decisions.json
```

Both printed `true` and exited 0.

## Candidate correctness coverage and cleanup

The uncommitted Task 2 candidate was tested before measurement. Its full suite passed 38 files and
319 tests; its exact eight-file gate passed 117 tests. Candidate-specific tests covered:

- mutation invalidation for provider lifecycle, ownership, implementation, dependency contents,
  provider-array push/reorder/removal/replacement, and metadata changes;
- `Container.clearCache()` reuse versus `Container.reset()` forced recompilation;
- fresh Entry, singleton, scoped-instance, and scope-local/cache isolation across Vaults;
- per-Vault owned class/factory disposal, LIFO order, and exactly-once tracking;
- independent pending async singleton promises, fulfillment/rejection, retry, cancellation,
  disposal, and error identity;
- fresh imports/exports and a failed-bootstrap retry that proved no partial blueprint was cached.

Because the candidate was rejected, these implementation-specific tests were removed with it.
The restored original suite then passed 38 files and 308 tests. Its retained coverage continues to
exercise provider-configuration and metadata mutation invalidation; clear-cache/reset lifecycle
certification; scoped isolation and overrides; owned/unowned disposal and LIFO behavior; async
deduplication, retry, cancellation, error identity, and disposal; and failed factory/retry behavior.
The post-rejection eight-file gate passed 106 tests, and source/test/generated cleanup checks found
zero Task 2 diff.

## Final original warm suite

The exact final command was:

```bash
mkdir -p /tmp/ceryn-vault-fresh-bootstrap-20260716/final
for run in 1 2 3 4 5; do
  BENCH_SEED=42 BENCH_TIME_MS=1200 BENCH_WARMUP_MS=250 \
  BENCH_OUTPUT_JSON="/tmp/ceryn-vault-fresh-bootstrap-20260716/final/warm-$run.json" \
  npm run bench:warm
done
```

The first sandboxed loop was denied before the harness by `tsx` IPC socket permissions and
created no JSON; it was excluded. The identical command then completed under scoped execution
permission and produced exactly five successful artifacts.

The table reports Ceryn's five process medians and median-of-medians, in nanoseconds per named
batch. These are final observations on the restored source. There is no original-suite before set
for this final phase, so no before/after claim is made.

| Ceryn task | Process medians | Median-of-medians |
| --- | --- | ---: |
| Fresh container + first request | `[8850.999998685438, 8855.000000039581, 9095.000001252629, 9266.000000934582, 9662.999997090083]` | `9095.000001252629` |
| Warm 1k requests | `[101147.00000121957, 101310.99999853177, 101391.99999684934, 102706.00000512786, 104856.99999844655]` | `101391.99999684934` |
| Burst 10k | `[1006908.9999997232, 1018258.0000000598, 1032705.0000014424, 1057540.9999983094, 1079682.0000032312]` | `1032705.0000014424` |
| Parent lookup 5k | `[38656.00000426639, 38665.00000003725, 38681.9999985164, 82544.99999748077, 83102.00000414625]` | `38681.9999985164` |
| Scoped 1k | `[364405.00000026077, 384538.00000024785, 388779.00000079535, 390145.99999973143, 404251.0000017501]` | `388779.00000079535` |
| Async cached singleton 100 | `[6595.999999262858, 6617.00000273413, 6746.999999450054, 6760.00000021304, 6774.999998015119]` | `6746.999999450054` |

Within these final observations, Ceryn has the lowest median-of-medians for warm 1k, burst 10k,
parent lookup 5k, scoped 1k, and async cached singleton 100. Tsyringe has the lowest final fresh
container plus first-request median-of-medians (`5364.00000055437 ns`).

## Final original isolated suite and semantics

The exact commands were:

```bash
for run in 1 2 3 4 5; do
  BENCH_SEED=42 BENCH_ISOLATED_ADAPTERS=ceryn BENCH_ISOLATED_RUNS=20 \
  BENCH_ISOLATED_SUBSEQUENT=1000 \
  BENCH_OUTPUT_JSON="/tmp/ceryn-vault-fresh-bootstrap-20260716/final/isolated-$run.json" \
  npm run bench:isolated
done

BENCH_SEED=42 BENCH_ISOLATED_RUNS=20 BENCH_ISOLATED_SUBSEQUENT=1000 \
BENCH_OUTPUT_JSON=/tmp/ceryn-vault-fresh-bootstrap-20260716/final/isolated-all.json \
npm run bench:isolated
```

Each value below is first the median of 20 independent child processes within one Ceryn-only
orchestrator replicate, then the median of those five summaries. Timing values are nanoseconds;
retained heap is bytes. As with the final warm suite, this is a final restored-source summary and
not an original-suite before/after comparison.

| Ceryn metric | Five orchestrator medians | Median-of-medians |
| --- | --- | ---: |
| Spawn to child ready | `[74399953, 75132532, 75983940, 76745336, 77876156]` | `75983940` |
| Framework + fixture import | `[16140447, 16376648, 16954463, 17122210, 17309310]` | `16954463` |
| Container creation + registration | `[2169850, 2207938, 2222295, 2258674, 2310503]` | `2222295` |
| First graph resolution + consumption | `[790835, 798294, 802959, 833439, 846122]` | `802959` |
| Subsequent resolution + consumption | `[417.563, 431.461, 433.652, 437.51, 439.015]` | `433.652` |
| Spawn to timing result | `[94742550, 95383568, 97145365, 98431806, 99321279]` | `97145365` |
| Directional retained heap | `[108512, 108512, 108512, 108512, 108512]` | `108512` (+106.0 KiB) |

Every Ceryn-only replicate reported `Semantic contract: PASS` with 23 registrations. The separate
all-adapter invocation also reported PASS for every adapter and every checked semantic:
consumed result, controller singleton identity, parent/imported singleton identity, stability
within one request scope, isolation across request scopes, and request-ID override.

| Adapter | Contract | Registrations | Decorators | Async resolution | Child containers | Request scopes | Sync disposal | Async disposal |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- |
| Ceryn | PASS | 23 | explicit-token metadata | true | false | true | true | true |
| Tsyringe | PASS | 23 | reflect-metadata injection tokens | false | true | container-scoped | reset only | true |
| Inversify | PASS | 23 | reflect-metadata injection tokens | true | true | resolution request plus child override | false | unbind deactivation |
| TypeDI | PASS | 23 | false | false | named containers with global inheritance | named-container override | container reset | false |
| Needle | PASS | 23 | false | true | true | child-container override | unbind only | false |

The JSON validations required five warm artifacts with 28 populated numeric tasks each, five
Ceryn isolated artifacts with 20 timing and 20 memory processes each, and one all-adapter artifact
with five passing 23-registration contracts plus 100 timing and 100 memory processes. All three
validations printed `true` and exited 0.

## Raw evidence and archive

Evidence root: `/tmp/ceryn-vault-fresh-bootstrap-20260716`.

- Environment: `baseline-head.txt`, `node-version.txt`, `npm-version.txt`,
  `package-lock.sha256`.
- Immutable before profile/focused/warm evidence: `before/{profile,focused,warm}/run-{1..5}.json`
  and each suite's `summary.json`.
- Rejected candidate evidence: `after/{profile,focused,warm}/run-{1..5}.json` and each suite's
  `summary.json`.
- Decisions: `decision.json` and `protected-decisions.json`.
- Final correctness logs: `final/{typecheck,build,test,test-typecheck,test-final}.log`.
- Final warm evidence: `final/warm-{1..5}.json` and `final/warm-summary.json`.
- Final Ceryn isolated evidence: `final/isolated-{1..5}.json` and
  `final/isolated-summary.json`.
- Final all-adapter evidence: `final/isolated-all.json`.
- Non-self-hashing manifest:
  `/tmp/ceryn-vault-fresh-bootstrap-20260716/SHA256SUMS`.
- Archive: `/tmp/ceryn-vault-fresh-bootstrap-20260716.tar.gz`.
- Archive checksum file: `/tmp/ceryn-vault-fresh-bootstrap-20260716.tar.gz.sha256`.
- Manifest entries: `60`; archived regular files: `61` (the 60 hashed files plus the
  non-self-hashed manifest). The archive has 71 total tar entries including directories.
- Manifest SHA-256: `4be509bbda0143bdcbb6d4a7928a6599d46dbee05caa2c2996095d71e96c814f`.
- Archive SHA-256: `11e4d63ccd932f8e490769b7eaba5095399068e0ac464c38efc1fa1aefa5346a`.

The manifest excludes `SHA256SUMS` itself. Every manifest entry and the archive checksum were
validated with `shasum -a 256 -c` before publication.

## Commands used to produce final summaries and archive

Warm and isolated summaries use the same upper-middle median protocol as the candidate decision.
They were derived with `jq -s`: first reduce each raw artifact independently, then sort the five
artifact medians and take their upper-middle median. The artifact shape and semantic checks were:

```bash
jq -e -s '
  length == 5 and
  all(.[];
    .suite == "warm-process" and .seed == 42 and
    (.environment.node == "v22.22.2") and
    (.tasks | length) == 28 and
    all(.tasks[]; (.samplesNs | length) > 0 and all(.samplesNs[]; type == "number")))
' /tmp/ceryn-vault-fresh-bootstrap-20260716/final/warm-{1,2,3,4,5}.json

jq -e -s '
  length == 5 and
  all(.[];
    .suite == "isolated-process" and .seed == 42 and .runs == 20 and
    .subsequentCount == 1000 and
    (.contracts | length) == 1 and
    (.contracts[0].adapter == "Ceryn") and
    (.contracts[0].contract.registrationCount == 23) and
    ([.contracts[0].contract[] | select(type == "boolean")] | all) and
    (.timing | length) == 20 and (.memory | length) == 20)
' /tmp/ceryn-vault-fresh-bootstrap-20260716/final/isolated-{1,2,3,4,5}.json

jq -e '
  .suite == "isolated-process" and .seed == 42 and .runs == 20 and
  .subsequentCount == 1000 and
  (.contracts | length) == 5 and
  (([.contracts[].adapter] | sort) == ["Ceryn","Inversify","Needle","Tsyringe","TypeDI"]) and
  all(.contracts[];
    .contract.registrationCount == 23 and
    ([.contract[] | select(type == "boolean")] | all)) and
  (.timing | length) == 100 and (.memory | length) == 100
' /tmp/ceryn-vault-fresh-bootstrap-20260716/final/isolated-all.json
```

The archive was built and validated exactly as follows:

```bash
find /tmp/ceryn-vault-fresh-bootstrap-20260716 -type f ! -name SHA256SUMS \
  -exec shasum -a 256 {} \; | LC_ALL=C sort \
  > /tmp/ceryn-vault-fresh-bootstrap-20260716.SHA256SUMS.tmp
mv /tmp/ceryn-vault-fresh-bootstrap-20260716.SHA256SUMS.tmp \
  /tmp/ceryn-vault-fresh-bootstrap-20260716/SHA256SUMS
shasum -a 256 -c /tmp/ceryn-vault-fresh-bootstrap-20260716/SHA256SUMS
tar -czf /tmp/ceryn-vault-fresh-bootstrap-20260716.tar.gz -C /tmp \
  ceryn-vault-fresh-bootstrap-20260716
shasum -a 256 /tmp/ceryn-vault-fresh-bootstrap-20260716.tar.gz \
  > /tmp/ceryn-vault-fresh-bootstrap-20260716.tar.gz.sha256
shasum -a 256 -c /tmp/ceryn-vault-fresh-bootstrap-20260716.tar.gz.sha256
```

## Scope and review

Task 1 changed only the benchmark implementation, methodology contract test, and benchmark
documentation. Task 2 has zero final source, test, public-export, or generated-output diff. The
final report is the only Task 3 tracked change. No runtime production change is retained from the
provider-blueprint experiment.

Task-scoped self-review confirmed that the report separates the retained profiler, the rejected
candidate after evidence, and the final restored-source benchmarks; reports all binding target
and protected predicates; does not claim an unavailable final original-suite comparison; and
publishes semantic capabilities alongside isolated results. Broad whole-branch review is a
separate required handoff after this task.
