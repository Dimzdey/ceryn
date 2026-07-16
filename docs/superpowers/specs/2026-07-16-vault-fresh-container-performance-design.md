# Vault Fresh-Container Performance Design

## Goal

Reduce `Ceryn: Fresh container + first request (warm process)` without changing public APIs or observable container, module, lifecycle, scope, HMR, reset, ownership, disposal, or diagnostic behavior.

The current split profile on Node `v22.22.2` is:

- Container boot: p50 `5.11 µs`, p95 `10.29 µs`.
- First request: p50 `1.45 µs`, p95 `3.00 µs`.

Container/module bootstrap is about 78% of the measured combined path, so it is the primary target.

## Existing Contract

`Container.clearCache()` discards live Vault instances but deliberately preserves decorated bootstrap summaries. `Container.reset()` additionally discards bootstrap summaries and the shared lazy resolver for tests, HMR, and multi-app hosts.

Decorated module configuration and provider metadata are externally mutable today. A new Vault created after `clearCache()` must observe changes to:

- provider array length, order, and element identity;
- provider implementation kind and implementation identity;
- provider token, lifecycle, ownership, and dependency contents;
- `@Injectable()` metadata and constructor injection metadata;
- imports, exports, shadow policy, lazy resolution, hooks, and other module options.

This is lifecycle-sensitive. Reusing stale validation after a dependency changes from singleton to scoped or transient could let a singleton capture an invalid dependency. Existing snapshot checks and `MetadataRegistry.stamp` invalidation therefore remain mandatory.

Request scopes are not shared across Vaults. Every Vault and Scope must continue to own independent instances, promises, caches, disposal order, cancellation state, and lifecycle state.

## Considered Approaches

### 1. Compile immutable provider blueprints after validation — selected

After a decorated Vault bootstraps successfully, retain immutable provider templates alongside the existing provider snapshot, metadata stamp, and lifecycle certification. On a later construction:

1. Re-run the existing provider snapshot comparison and metadata-stamp check.
2. If either changed, use the full registration path.
3. If both match, materialize fresh mutable Entry records from the templates.
4. Continue processing imports, exports, exposure, shadow policy, and module options normally.

This preserves arbitrary mutation detection while avoiding repeated provider classification, metadata lookup, dependency normalization, Entry assembly, and already-certified lifecycle-edge validation.

### 2. Treat decorated configuration as immutable

This would allow direct O(1) blueprint reuse with explicit reset/invalidation for HMR. It offers the largest theoretical gain but breaks the tested direct-mutation contract. It is rejected for this work.

### 3. Constructor allocation micro-optimizations

Lazy allocation of unused helpers, especially `ResolverAsync`, may reduce sync-only bootstrap cost. However, changing a public own property into an accessor is observable through reflection. Such changes are excluded unless they can preserve property shape and behavior exactly. Small allocation candidates may be measured separately only when they are demonstrably noninvasive.

## Selected Architecture

### Decorated bootstrap summary

Extend the private decorated-module summary with immutable provider templates. The summary remains stored in a module-level `WeakMap`, keyed by decorated module configuration identity, and remains clearable through `Vault.resetBootstrapCaches()`.

Each template contains only registration-time facts needed to create a fresh Entry:

- canonical token and diagnostic metadata;
- constructor or factory identity;
- normalized constructor and factory dependency IDs;
- aliases required at registration;
- lifecycle, ownership, value-provider, no-dependency, and lifecycle-certification flags;
- the value for a value provider, when applicable.

Templates contain no live Vault, Scope, Entry, cache, promise, disposal, resolution-path, cancellation, or instantiated class/factory state.

### Fresh Entry materialization

Every new Vault receives a new Entry object for every provider. Runtime fields are initialized exactly as the full registration path would initialize them:

- class/factory instances and promises start absent;
- value providers start materialized with the current configured value;
- disposal tracking is rebuilt per Vault and never copied as already tracked;
- mutable arrays that are currently per-Vault remain per-Vault;
- lifecycle-certification bits are copied only from a summary produced by a completely successful bootstrap.

EntryStore collision and diagnostic behavior must remain equivalent. A failed bootstrap never publishes or partially updates a blueprint.

### Cache validation

Blueprint reuse requires all of:

- identical decorated configuration identity;
- unchanged `MetadataRegistry.stamp`;
- successful `providersMatchSnapshot()` across provider order, identities, fields, and dependency contents;
- a summary produced by a prior successful complete bootstrap.

The existing O(n) snapshot comparison is retained. The optimization targets the more expensive work after that comparison.

Imports, exports, shadow policy, global mode, lazy resolver, instantiate hook, and module name are processed from the current configuration on every construction. They are intentionally excluded from the initial provider blueprint so mutations remain naturally visible.

### Reset and invalidation

- `Container.clearCache()` preserves blueprints, matching current lifecycle-summary behavior.
- `Container.reset()` clears blueprints through `Vault.resetBootstrapCaches()`.
- metadata registration changes invalidate reuse through `MetadataRegistry.stamp`.
- provider configuration changes invalidate reuse through the existing deep provider snapshot.
- failed bootstraps do not create reusable summaries.

No new public invalidation API is introduced.

## Correctness and Compatibility Tests

Tests must cover real behavior plus narrow structural assertions. No elapsed-time assertions belong in Vitest.

### Reuse behavior

- A second `Container.from()` after `clearCache()` reuses compiled provider facts.
- The reuse path skips provider-shape classification, metadata definition lookup, dependency normalization, and already-certified lifecycle validation.
- `Container.reset()` forces the full path again.
- Failed first bootstraps are not cached and repeat full validation on retry.

### Mutation invalidation

- Provider array push, removal, reorder, and replacement invalidate reuse.
- In-place changes to `provide`, `useClass`, `useFactory`, `useValue`, `lifecycle`, `owned`, and dependency array contents invalidate reuse.
- Reapplying `@Injectable()` or `@Inject()` invalidates reuse through the metadata stamp.
- A singleton-to-scoped or singleton-to-transient dependency mutation still throws `LifecycleViolationError` after `clearCache()`.
- Imports, exports, shadow policy, hooks, and lazy resolver changes are observed because those fields are processed fresh.

### Isolation and lifecycle safety

- Two fresh Vaults never share Entry identity.
- Singleton and scoped instances are distinct across fresh Vaults.
- Scope-local overrides and scoped-provider caches remain isolated.
- Pending async singleton creation, retry state, cancellation detachment, and error identity are not shared.
- Owned value/class/factory instances are tracked and disposed independently with the same LIFO and idempotency behavior.
- Cached `undefined`, aliases, diagnostics, cross-Vault exposure, and Candidate 1/5 hot paths remain unchanged.

### Public and generated output

- No new public export or declaration is emitted.
- Existing public field and method shapes remain unchanged.
- Built `dist` matches retained source; rejected candidates are rebuilt out of `dist`.

## Performance Measurement

Extend the existing Ceryn fresh-container split profiler to optionally emit raw JSON for:

- container boot;
- first request;
- combined boot plus first request.

Use five independent npm/Node processes before and after, seed `42`, identical warmup, and at least 20,000 measured iterations per process. Samples are reduced to one median per process and then a median-of-medians; raw samples are not pooled across processes.

The target is combined fresh container plus first request. Container boot and first request are diagnostic submetrics.

Retain an optimization only when:

- combined median-of-medians is at least 5% lower;
- at least three after-process medians are below the best before-process median;
- no protected task establishes a regression using the existing inclusive 5% plus three-beyond-worst rule;
- all correctness and compatibility gates pass.

Protected paths are:

- warm 1,000 requests;
- scoped 1,000 lifecycle cycles;
- cached async singleton 100;
- cached `tryResolve` 1,000;
- bound-Scope async cached 100.

Run the original five-process warm suite and isolated semantic suite after retaining any candidate.

## Delivery

Evaluate the compiled provider blueprint first. Any smaller constructor-allocation optimization is a separate candidate with independent before/after evidence and cleanup on rejection.

Accepted candidates receive separate local commits. Rejected code and stale generated output are removed. Final correctness, evidence, generated-output, and broad code reviews are required. Nothing is pushed.
