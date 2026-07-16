# Vault Performance Follow-ups Design

## Objective

Evaluate the remaining Vault performance findings independently, retain only repeatable gains, and commit accepted changes locally without pushing.

The already-verified Vault optimization set is the comparison baseline. Each follow-up candidate must preserve existing resolution, lifecycle, ownership, disposal, error-timing, and cancellation semantics.

## Evaluation Strategy

Use sequential candidate isolation. For each finding:

1. Capture five independent before-process measurements.
2. Add semantic and structural tests and observe the intended RED failure.
3. Implement the smallest production change.
4. Run focused tests, the full Vault suite, source and test typechecks, and the build.
5. Capture five independent after-process measurements.
6. Calculate the acceptance decision from process-level medians.
7. Commit accepted candidates separately. Remove rejected or inconclusive candidates without committing their implementation.

This takes longer than bundling candidates, but it makes each gain attributable and prevents one optimization from hiding another candidate's regression.

## Acceptance Rule

A candidate is a supported improvement only when all conditions hold:

- The target median-of-medians improves by at least 5%: the after median-of-medians is less than or equal to `before * 0.95`.
- At least three after-process medians are strictly lower than the best before-process median.
- No protected path satisfies the inverse supported-regression rule: its after median-of-medians is greater than or equal to `before * 1.05` and at least three after-process medians are strictly worse than the worst before-process median.
- All correctness and structural gates pass.

Results that satisfy only one performance predicate are inconclusive. Unsupported or inconclusive production changes are removed.

## Focused Benchmark Suite

Add a Ceryn-only focused benchmark suite that emits raw JSON and runs quickly enough for repeated candidate isolation. It covers:

- Cached `resolve()`.
- Cached `Scope.tryResolve()`.
- `canResolve()` followed by `resolve()`.
- Scope creation, local `provide()`, scoped construction, and disposal.
- Metadata registration and Vault construction.
- Cached bound-Scope asynchronous resolution.
- Protected direct sync, scoped, and cached-async paths.

Each replicate is a fresh Node process. Tinybench samples remain inside their process; acceptance compares one median per process and never pools autocorrelated samples across processes.

The existing warm and isolated benchmark suites remain the final external validation. The focused suite is additive and does not replace them.

## Candidate Sequence

### 1. Cached `tryResolve()` Fast Path

`Scope.tryResolve()` currently validates the complete dependency graph before resolving even a materialized singleton or scoped value. Add an allocation-free cached lookup that checks scope-local, Vault singleton, and scope-cache state before graph validation.

The fast path must retain cached `undefined`, disposed-scope behavior, token validation, local-first Scope precedence, and producer ownership across Vault boundaries. Cache misses continue through the existing non-instantiating validation before resolution, avoiding partial graph construction.

### 2. Successful `canResolve()` Certification

Cache successful graph-validation results instead of traversing a sealed dependency graph on every call. Certification must be keyed by all state that can affect resolvability:

- Local registration and metadata state.
- Lazy attachment and exposure state.
- Imported Vault graph state.
- Scope-local registration generation for scope-aware checks.

Failures are not cached. Any mutation that can affect visibility, dependency availability, lifecycle validity, or scope precedence invalidates the relevant certificate. If complete invalidation cannot be made explicit and testable, reject this candidate.

### 3. Compact Scope State

Measure replacing full `Entry` allocations for scope-local values and scoped cache clones with compact internal records. The design must avoid polymorphic cache shapes on a hot lookup and retain access to the authoritative provider `Entry` when lifecycle diagnostics or creation metadata are required.

It must preserve cached `undefined`, aliases, ownership, LIFO disposal, overrides, async pending creation deduplication, retry, abort detachment, and post-await disposed-scope checks. If the type branching or adaptation cost offsets allocation savings, reject the candidate.

### 4. Metadata Registry Identity Fast Path

Measure reducing repeated full-shape validation in `ensureStore()` when the global registry identity is unchanged. External store replacement, legacy migration, and malformed in-place repair are existing contracts and cannot be weakened.

An optimization is acceptable only if its invalidation or validation mechanism preserves those contracts. If arbitrary in-place repair necessarily requires the current checks and no safe amortization is faster, retain the existing implementation and record the candidate as rejected.

### 5. Bound-Scope Async Promise Wrappers

Measure replacing avoidable `async` wrapper allocation in bound `Scope.resolveAsync()` and related cached paths with explicit `try`/`catch` adoption. Synchronous validation and disposed-state failures must still be delivered as rejected Promises. Promise identity is retained only where already supported, and abort behavior must remain unchanged.

## Testing

Every production change follows strict RED-GREEN-REFACTOR:

- A test must fail for the intended missing optimization or contract before production editing.
- Structural tests count cache probes, graph traversals, allocations, or returned Promise identity without asserting elapsed time.
- Semantic tests cover invalid input, missing providers, lifecycle violations, cycles, undefined values, disposal, override invalidation, cross-Vault ownership, retries, and cancellation as applicable.
- Timing assertions never enter the normal test suite.

Each candidate runs its focused tests plus `npm test`, `npm run typecheck`, `npm run build`, and `npx tsc -p tsconfig.test.json --noEmit` before acceptance.

## Commit and Evidence Policy

Create local commits only; never push.

1. Commit this design specification.
2. Commit the currently verified Vault optimization set as the immutable baseline.
3. Commit the focused benchmark harness.
4. Commit each accepted candidate separately with its tests.
5. Commit the final benchmark report.

Raw benchmark artifacts live outside Git under a dedicated `/tmp` evidence directory. The committed report records commands, environment, process medians, decision predicates, retained/rejected candidates, and artifact checksums.

## Final Validation

After all candidate decisions:

- Run five original warm-process replicates.
- Run five Ceryn-only isolated-process replicates.
- Run the all-adapter isolated semantic contract.
- Run source/test typechecks, build, and the full test suite.
- Verify no benchmark contract regressions or unsupported protected-path regressions.
- Request a read-only review of the final diff.
- Commit the evidence-backed report locally and leave the repository unpushed.

Generated numeric-slot or code-generated resolver plans are explicitly excluded. They are a separate architectural project after these targeted candidates are exhausted.
