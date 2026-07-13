# Design: Focused Vault Performance Fixes

**Date:** 2026-07-13

**Package:** `packages/vault` (`@ceryn/vault`)

**Status:** Approved design; awaiting written-spec review

**Working-tree constraint:** Implement in the current dirty checkout without reverting, overwriting, or folding unrelated user changes into this work.

## Context

The warm and isolated benchmark suites show that Vault's steady-state singleton lookup is already strong, while registration, first resolution, scoped resolution, and cached async resolution still contain measurable work that can be removed. Profiling also exposed a correctness defect: an owned async singleton that finishes after its Vault begins disposal can repopulate disposed state and escape cleanup.

One machine-specific reference capture, with task ordering seeded at 42, produced the following values. The seed reproduces ordering, not timings; independent-process variability must be measured before these values are used as acceptance thresholds.

| Scenario | Observations | Median (IQR) | Interpretation |
| --- | ---: | ---: | --- |
| Warm fresh container + first request | 53,905 in-process samples | 11.31 us (9.33–18.46 us) | Registration and first-resolution work are combined. |
| Warm cached 1k, amortized | 10,456 in-process batches | 106 ns (105–110 ns) per request iteration | Protect this already-fast resolve + application-chain path from regression. |
| Warm scoped 1k, amortized | 1,981 in-process batches | 476 ns (467–523 ns) per scope iteration | Includes Ceryn's scope teardown semantics. |
| Warm cached async 100, amortized | 104,178 in-process batches | 93 ns (91–98 ns) per async resolve iteration | Measures an already-created singleton, not async factory creation. |
| Isolated build/registration | 20 child processes | 2.11 ms (2.03–2.35 ms) | Cross-library ratios are descriptive only because fixtures differ. |
| Isolated first graph | 20 child processes | 845.86 us (800.63–919.36 us) | Includes resolution plus application-chain execution. |
| Isolated subsequent graph, amortized | 20 child processes | 470 ns (456–485 ns) per resolve + `handle()` iteration | Protect this path from regression. |
| Isolated retained heap delta | 20 child processes | +101.6 KiB | Directional only; the live container remains referenced. |

Baseline artifacts:

- `/tmp/ceryn-vault-benchmark-warm-seed42.json`
- `/tmp/ceryn-vault-benchmark-seed42-r20.json`
- `/tmp/ceryn-vault-build-only.cpuprofile`
- `/tmp/ceryn-vault-first-resolution.cpuprofile`

These `/tmp` files are ephemeral. The capture used Node v22.22.2 on macOS x64 with an Intel i5-8500B, repository base `1a81b3a37d76ba3b06596a9f46e6efc0fd4b0e9b`, and `package-lock.json` SHA-256 `5ac39ca93b7924bf1c7b9f08b297e0b1e9fe46887c618ba753bf153eb43c47d1`. Before implementation, save a manifest containing the dirty package diff, untracked-file list, commands, explicit benchmark durations/counts, environment, and checksums for the raw artifacts so the exact pre-performance package state remains identifiable.

The sampled CPU profiles contain stacks through `EntryStore.add`, metadata registration/definition building, exposure computation, container construction, and lifecycle validation during build. First-resolution samples contain stacks through resolver entry, singleton priming, activation, resolution-path entry, cross-Vault checks, registry lookup, and ownership tracking. Sampling guides investigation but does not by itself prove allocation removal or causal attribution.

## Goals

1. Fix the async singleton/disposal race without making `dispose()` wait indefinitely for user factories.
2. Remove repeated metadata-store validation and default-bag lookup from registration.
3. Remove duplicate entry lookups and unnecessary root lifecycle checks from cold resolution.
4. Reduce activation and ownership-tracking allocation for common zero/one-dependency and no-hook cases.
5. Remove duplicate scope probes/options allocation and reuse fulfilled async singleton promises internally.
6. Preserve public APIs, token precedence, lifecycle validation, cycle diagnostics, hooks, ownership, disposal order, abort semantics, and error types except for the explicitly approved late-creation outcome.
7. Keep only changes supported by correctness tests and before/after benchmark or profile evidence.

## Non-Goals

- No compiled registration/module plan or startup architecture redesign.
- No public API expansion or dependency-injection semantic change.
- No broad rewrite of resolvers, scopes, exposure indexing, or disposal.
- No change to `clear()` semantics for factories already in flight.
- No optimization of abort-listener fan-out, lazy import resolution, or general disposal complexity in this batch.
- No benchmark fairness/methodology rewrite; comparisons used for acceptance are Ceryn-before versus Ceryn-after under the same harness.
- No hard memory target from the current retained-heap measurement.

## Chosen Approach

Implement five staged fast paths. Each stage has an isolated behavioral boundary, begins with a failing or strengthened test where behavior changes, and is benchmarked before the next stage is accepted. This limits the blast radius in the dirty checkout and makes a neutral or regressing optimization removable without disturbing the rest.

A compiled module plan was rejected for this batch because it changes bootstrap architecture and invalidation semantics. A single coordinated resolver rewrite was also rejected because it would couple lifecycle, scope, activation, and async behavior too tightly to attribute regressions safely.

## Stage 1: Async Lifecycle Commit Guard

### Problem

Async singleton creation publishes a pending promise, then unconditionally commits the fulfilled value to the entry and singleton cache. `Vault.dispose()` clears current state but intentionally does not await a possibly unbounded user factory. If that factory settles later, the completion handler can restore an instance to the disposed Vault and leave an owned value undisposed.

### Design

- Treat both `disposing` and `disposed` as states in which an async creation may not commit.
- Immediately before a singleton completion mutates its entry, check whether the Vault is still eligible to accept the value.
- A stale completion must not write `entry.instance`, `FLAG_HAS_INSTANCE`, ownership/disposal-order state, or singleton-cache entries. After Stages 4 and 5 introduce their new fields, this prohibition also covers `FLAG_DISPOSAL_TRACKED` and `entry.resolvedPromise`.
- For an owned stale value, select `dispose` before `close`, bind it to the value, invoke it no more than once, await a returned thenable, and normalize thrown or rejected non-`Error` reasons exactly as normal Vault disposal does. A non-owned value, or an owned value without either method, requires no cleanup and counts as successful cleanup.
- After cleanup succeeds, every non-aborted caller waiting on that shared creation rejects with the same `ContainerDisposedError` reason.
- If cleanup fails, every non-aborted waiter rejects with the same `AggregateDisposalError` containing the normalized cleanup error or errors. Do not hide the cleanup failure behind a generic disposed error.
- Late cleanup cannot revise a `dispose()` call that has already completed. Its result is observable through the still-running shared creation promise; an abandoned rejecting promise retains ordinary unhandled-rejection behavior.
- `dispose()` remains independent of unresolved user factories and therefore cannot hang waiting for them. The completion path performs cleanup whenever the factory eventually settles.
- Concurrent callers continue to share one creation attempt. A caller that already detached through its `AbortSignal` retains its abort outcome; other callers observe the shared creation outcome.
- Factory rejection after disposal remains the factory rejection because no value exists to clean up or commit.
- `clear()` behavior is unchanged by this guard.

The eligibility check and commit are synchronous within one promise continuation, so disposal cannot interleave between the check and the state writes.

## Stage 2: Metadata Registry Fast Path

### Problem

Metadata registration repeatedly validates or migrates the global registry store, and several default-namespace operations call the validation path more than once. This contributes directly to registration time.

### Design

- Retain a module-local pointer to the last validated registry store.
- `ensureStore()` returns that pointer only while the global symbol still refers to the same object and the cheap current-store invariants remain valid: `defaultBag`, `namespaces`, and `generation` are present with their expected container/value types.
- If external code, HMR, a second bundle, or tests replace the global symbol value, re-run the existing validation/migration logic and refresh the pointer.
- Registry reset continues replacing only the selected bag inside the current store. It must leave the cached store pointer and global symbol referring to that same store.
- Registration operations increment `store.generation` on the validated store they already hold. Registration and definition-building operations then access that store's `defaultBag` directly instead of calling `ensureStore()` again.
- Namespaced bags, sealing, collision behavior, legacy migration, and public reset behavior remain unchanged.

This is a cache of validation, not a second source of registry truth.

## Stage 3: Entry-Passing Resolver Fast Path

### Problem

Vault lookup code often retrieves or proves the existence of an entry and then passes only its canonical token to a resolver, which retrieves the same entry again. Root resolution also enters the path and invokes lifecycle-edge validation before discovering that there is no parent edge to validate.

### Design

- Change internal sync and async resolver entry points to receive an already-found `Entry`.
- The caller performs one `getByCanonical()` and passes that object forward. Recursive local lookup similarly uses one `get()` result instead of `has()` followed by `get()`.
- Resolvers use `entry.token` as the canonical identifier for cycle paths, diagnostics, cache priming, and activation.
- Before entering `entry.token`, capture `hadParent = path.length !== 0`. Skip runtime lifecycle-edge validation only when `hadParent` is false. The independent `boundaryAlreadyValidated` signal remains available for cross-Vault or otherwise prevalidated edges.
- For an edge that still needs validation, pass the already-found dependency entry into `_validateLifecycleRulesForEntry`; validation must not reload that dependency. Looking up the immediate consumer entry remains necessary.
- Imported edges, scoped overrides, deferred registration-order validation, and every actual dependency edge retain their existing checks.
- Cross-Vault lookup and exposure rules continue to validate at their current ownership boundary.
- Missing-provider, cycle, lifecycle, and factory error types/messages remain unchanged.

No `Entry` object is exposed publicly; this only tightens internal data flow.

## Stage 4: Activation and Ownership Fast Paths

### Activation

- Preserve the existing zero-dependency constructor behavior and add an analogous one-summon constructor branch.
- For factories, branch explicitly on `factoryDeps.length === 0`, `=== 1`, or greater than one. Do not use `FLAG_HAS_NO_DEPS` to classify factory dependencies because current factory registration does not encode that distinction.
- The zero/one-dependency factory branches avoid mapped argument arrays and general fan-out machinery.
- Keep the general multi-dependency path unchanged, including async sibling concurrency and independent forked cycle paths.
- Async factory branches preserve the current `factory.length === dependencyCount + 1` rule for passing `{ signal }`, curried-factory handling, and factory-error wrapping.
- Branch on instrumentation-hook presence before allocating timing wrapper closures. When a hook exists, preserve its current start/end boundaries, token identity, and error behavior.
- Preserve constructor argument order, missing-injection diagnostics, factory error wrapping, and sync-versus-async restrictions.

### Ownership

- Allocate reserved entry bit 7 as `FLAG_DISPOSAL_TRACKED`.
- Replace the per-Vault `Set` used only for uniqueness with this flag; keep the token array that supplies LIFO order.
- Tracking an owned materialized singleton sets the flag and appends its token only once.
- Whenever `disposalOrder` is emptied—during `clear()` or the synchronous state-clearing portion of `dispose()`—clear `FLAG_DISPOSAL_TRACKED` on every listed entry in the same operation. Do not retain the bit until asynchronous disposer settlement.
- After `clear()`, re-track retained owned `useValue` registrations. This preserves value-provider retention and later LIFO disposal.
- Clearing a non-value instance and failed/rematerialized creation leave the flag consistent with whether the token is present in the disposal-order array.
- Scope ownership/disposer behavior is not converted to this flag in this batch.

## Stage 5: Scope and Fulfilled-Async Fast Paths

### Scope resolution

- Add internal Vault entry points used by `Scope.resolve()` and `Scope.resolveAsync()` so the scope does not allocate `{ scope: this }` merely to call the public API.
- Those entry points retain token validation and the Vault usability check; bypassing the public wrapper must not bypass either error surface.
- The internal call records that scope-local registration has already been checked, preventing a duplicate local-map probe.
- Add a non-creating scope-cache peek that returns `Entry | undefined`. A cache miss must not instantiate a `SingletonCache` and backing `Map`; the cache is created only when an entry must be stored or public `scope.cache` is explicitly requested.
- The root internal call carries separate `localChecked` and `scopeCacheChecked` booleans plus any entries found by those probes. A scoped-cache entry may be fulfilled or in flight, and the resolver reuses either state without probing again. These root-token probe facts are not propagated to recursive dependency resolution.
- Determine cache presence from the returned entry and `FLAG_HAS_INSTANCE`, never from `entry.instance !== undefined`, so cached `undefined` remains valid.
- The non-creating peek performs the same disposed-scope check as public `scope.cache`. Calls originating in `Scope.resolve*()` may pass an already-validated-active hint, while public `vault.resolve*(token, { scope })` retains its current disposed-scope behavior.
- Preserve cached `undefined`, local override precedence, alias behavior, scope disposal errors, ownership, and concurrent scoped-creation deduplication.
- `Scope.resolveAsync()` continues returning a Promise rather than synchronously throwing for disposed-scope, invalid-token, or missing-Vault failures. It may retain its async wrapper or convert synchronous failures with explicit `try`/`catch` and `Promise.reject`.

### Fulfilled async singleton reuse

- Keep in-flight creation (`entry.promise`) distinct from a fulfilled singleton promise (`entry.resolvedPromise`).
- After successful async creation commits, promote that same shared creation promise to `entry.resolvedPromise`; do not allocate a second fulfilled promise. A singleton materialized synchronously, including a `useValue`, creates `resolvedPromise` lazily on its first async access, never during registration or synchronous resolution.
- Stale or rejected creation never populates `resolvedPromise`.
- The fulfilled-cache branch returns the reused promise without racing it against `signal`, preserving current behavior for already-materialized values even when the supplied signal is already aborted.
- `clear()` resets `resolvedPromise` before the `FLAG_VALUE_PROVIDER` early return, and `dispose()` resets it during state clearing. Retained value providers lazily recreate it on their next async access. Only entries owned by that Vault are reset; imported producer entries retain producer-owned state.
- Fulfilled-promise reuse is limited to singleton entries in this batch. Every scoped clone explicitly initializes `promise` and `resolvedPromise` to `undefined`, so it cannot inherit root-entry async state through object spread. Existing in-flight scoped-promise deduplication remains unchanged.
- Public callers must not rely on promise object identity. Existing `async` API wrappers may still return adopting promises, and internal reuse may make identity more stable in some paths; fulfillment value, rejection, and scheduling contracts remain the supported behavior.

## Error and State Semantics

The intended async singleton state transitions are:

```text
empty --resolveAsync----------------> pending
pending --fulfill while active------> committed
pending --reject while active-------> empty/retryable + factory rejection

pending --dispose-------------------> stale-pending
                                      entry/cache/tracking state cleared;
                                      shared creation continues externally
stale-pending --reject--------------> disposed + original factory rejection
stale-pending --fulfill-------------> late-cleanup-pending
late-cleanup-pending --success------> disposed + ContainerDisposedError
late-cleanup-pending --failure------> disposed + AggregateDisposalError
```

`dispose()` remains irreversible and rejects new resolution immediately through `ContainerDisposedError`. Abort signals still detach only the requesting waiter; they do not cancel shared singleton creation. A caller aborting before the late completion continues to observe its abort result, while remaining waiters observe the disposed or cleanup result.

## Test Strategy

Performance thresholds do not belong in unit tests. Tests may validate that timing fields are present and positive, while behavior/state tests and benchmark/profile evidence remain separate.

### New or strengthened behavioral tests

1. Dispose while an owned async singleton factory is pending, then fulfill it:
   - pending resolution rejects with `ContainerDisposedError`;
   - the late value is disposed exactly once;
   - at Stage 1, the entry has no materialized instance or pending promise, the singleton cache remains empty, and the current disposal-order/`Set` state is not repopulated;
   - after Stages 4 and 5, strengthen the same assertion to cover no tracking flag and no fulfilled promise.
2. Repeat the race with concurrent waiters, an async disposer, a non-owned provider, factory rejection, and cleanup rejection.
3. Verify aborting one waiter remains caller-local during the disposal race.
4. Verify value providers survive repeated `clear()`, remain tracked once, and dispose in LIFO order.
5. Verify failed creation followed by successful rematerialization does not corrupt ownership tracking.
6. Verify metadata reset, sealing, namespaced bags, legacy migration, and external replacement of the global registry-store value.
7. Exercise resolver behavior for root, dependency, scoped override, imported, missing, cyclic, and reverse-registration lifecycle cases.
8. Exercise zero-, one-, and multiple-dependency constructors/factories with hooks disabled and enabled; async multi-dependency factories must remain concurrent.
9. Verify scope cache misses do not create cache state, cached `undefined` remains distinguishable from a miss, and local override lookup occurs with unchanged precedence.
10. Verify fulfilled async state is reused internally, never survives clear/dispose, and never caches rejection.

### Verification commands

Run from `packages/vault`:

```bash
npm run typecheck
npm run build
npm test
```

Targeted tests run after each stage; the full suite runs before benchmarking and again before completion. The current pre-change baseline is 36 files and 268 passing tests.

## Benchmark Strategy and Acceptance Gates

Use the existing seed-42 capture as orientation, then collect the defined independent-process baseline before production edits. Acceptance comparisons are Ceryn-before versus Ceryn-after because cross-container fixtures contain known semantic and teardown differences.

### Fast feedback: diagnostic only

These smoke commands catch harness or contract failures. Their short durations and single isolated process must not accept or reject an optimization.

```bash
BENCH_SEED=42 BENCH_TIME_MS=50 BENCH_WARMUP_MS=10 npm run bench:warm

BENCH_SEED=42 BENCH_ISOLATED_ADAPTERS=ceryn \
  BENCH_ISOLATED_RUNS=1 BENCH_ISOLATED_SUBSEQUENT=10 \
  npm run bench:isolated
```

### Before/after replicate protocol

Run each command five times before production edits and five times after the final candidate. Replace `<phase>` with `before` or `after` and `<replicate>` with `1` through `5`; every invocation gets a unique raw-output path.

```bash
BENCH_SEED=42 BENCH_TIME_MS=1200 BENCH_WARMUP_MS=250 \
  BENCH_OUTPUT_JSON=/tmp/ceryn-vault-warm-<phase>-<replicate>.json \
  npm run bench:warm

BENCH_SEED=42 BENCH_ISOLATED_ADAPTERS=ceryn \
  BENCH_ISOLATED_RUNS=20 BENCH_ISOLATED_SUBSEQUENT=1000 \
  BENCH_OUTPUT_JSON=/tmp/ceryn-vault-isolated-<phase>-<replicate>.json \
  npm run bench:isolated
```

Tinybench samples within one warm process are autocorrelated; the five process-level task medians are the warm replicates. Each isolated child row is an independent process, and each 20-run invocation also produces one process-level phase median. Record per-invocation medians/IQRs, the median of process-level medians, observed between-invocation range, and before/after effect ratio.

Capture build and first-resolution CPU profiles before and after into unique, pre-created `/tmp` directories. Use the focused cold profile for registration/build and a Ceryn-only isolated run for first resolution:

```bash
NODE_OPTIONS="--cpu-prof --cpu-prof-dir=/tmp/ceryn-vault-profile-<phase>-cold" \
  BENCH_PROFILE=ceryn-cold BENCH_COLD_ITERATIONS=20000 \
  npm run bench:warm

NODE_OPTIONS="--cpu-prof --cpu-prof-dir=/tmp/ceryn-vault-profile-<phase>-first" \
  BENCH_SEED=42 BENCH_ISOLATED_ADAPTERS=ceryn \
  BENCH_ISOLATED_RUNS=1 BENCH_ISOLATED_SUBSEQUENT=10 \
  npm run bench:isolated
```

After acceptance, run the all-adapter 20-run command requested by the benchmark README for descriptive context and save it separately:

```bash
BENCH_SEED=42 BENCH_ISOLATED_RUNS=20 BENCH_ISOLATED_SUBSEQUENT=1000 \
  BENCH_OUTPUT_JSON=/tmp/ceryn-vault-isolated-all-after.json \
  npm run bench:isolated
```

Acceptance rules:

- Correctness, typecheck, and build are hard gates.
- For each non-correctness optimization, first verify structurally—through source inspection, a targeted counter, or an allocation profile—that the intended call or allocation is absent. Then require either a practically meaningful target improvement outside the observed baseline noise range or supporting sampled-profile reduction. A consistently neutral change that adds complexity is removed. The lifecycle fix is exempt from the performance-improvement requirement.
- Treat a protected path as regressed only when the after median-of-medians is more than 5% slower than the before median-of-medians and at least three of five after medians exceed the maximum before median. If results overlap both no change and a 5% regression, report the result as inconclusive and do not silently classify it as neutral.
- Evaluate metadata changes with isolated `importNs`, isolated `buildNs`, and the focused cold profile because warm fixture declaration occurs before task timing. Evaluate resolver/activation with isolated `firstResolutionNs`; scope and fulfilled-async changes use their warm Ceryn tasks. Combined fresh-container timing is supporting evidence only.
- Retained heap and tail figures are reviewed directionally. They are not hard gates because the harness keeps the container alive and low-sample tails are noisy.
- Save warm task names/raw batch samples and isolated process rows/contracts/GC observations. Record settings, dependency/code-state metadata, and checksums separately because current JSON does not contain all of them and isolated GC events are not phase-timestamped.

## Implementation Boundaries and Risks

- **Dirty checkout:** Inspect every target diff before editing and patch only the approved paths. Never reset or overwrite existing user work.
- **Late cleanup:** Centralize or reuse the existing disposer-selection logic so normal and late cleanup cannot drift.
- **Global metadata/HMR:** The fast pointer is valid only under an identity check against the global symbol plus cheap shape/type invariants for the current store.
- **Lifecycle validation:** Root-only skipping must be derived from path shape, never from provider lifecycle alone.
- **Entry flags:** Bit 7 must be documented, masked independently of lifecycle bits, and reset on every path that removes disposal-order membership.
- **Promise state:** In-flight and fulfilled promises must remain separate; neither rejected nor stale creations may populate fulfilled state.
- **Scope misses:** Non-creating cache lookup must still distinguish a cached entry containing `undefined` from absence.
- **Instrumentation:** Direct branches must preserve hook timing and exception propagation exactly.
- **Benchmark noise:** Optimize against repeated Ceryn-before/Ceryn-after evidence, not a single cross-library ranking.

## Delivery

Implementation proceeds stage by stage using test-driven development. Each stage is reviewed against this document, its targeted tests, the full suite, and the relevant benchmark/profile. Final delivery reports changed files, correctness verification, before/after performance, any optimization removed for lack of evidence, and remaining opportunities explicitly left out of scope.
