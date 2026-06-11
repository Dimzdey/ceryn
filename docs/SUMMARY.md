# @ceryn/vault — Development Summary

## Session: June 10, 2026

### Starting state
- `@ceryn/vault` v1.1.0, published on npm
- 16 bugs/issues identified during code analysis
- Package failed to load under Node native ESM
- Themed API naming (Relic, Summon, Vault, Genesis, etc.)
- 96 tests, 7 benchmark files (most broken/stale)

### Ending state
- `@ceryn/vault` v2.2.0, published on npm
- `@ceryn/fastify` v0.1.0, source-only (pending 1.0 for publishing)
- All 16 issues fixed
- Standard DI naming (`@Injectable`, `@Inject`, `@Module`, `Container`)
- 109 tests (24 files), all passing
- 1 consolidated benchmark (6 phases, 5 comparison libraries)
- Monorepo-aware semantic-release (path-based filtering)

---

## Changes Made

### 1. Critical Fixes

| Fix | Description |
|-----|-------------|
| ESM packaging | Switched to `moduleResolution: "NodeNext"`, fixed all 18 extensionless imports. Package now loads under Node native ESM. |
| Broken `./testing` export | Removed (no source existed) |
| Shadow-policy enforcement | `_enforceShadowPolicy()` now called at construction — the documented feature works |
| Lifecycle validation | `_validateLifecycleRules()` wired at resolution time — catches violations regardless of registration order |
| VaultDisposedError | `resolve()`/`resolveAsync()` now throw after `dispose()` |
| scratchStack re-entrancy | Eliminated shared mutable buffer — each `resolve()` allocates a fresh stack |

### 2. Correctness Improvements

| Fix | Description |
|-----|-------------|
| Disposer order | Changed from `Set` (FIFO) to `Array` iterated in reverse (documented LIFO) |
| Metadata immutability | `Object.freeze()` always applied (was dev-only) |
| Config validation | `_validateAndFreezeConfig` now validates `onInstantiate`, `shadowPolicy` and freezes the config |
| beginScope removal | Removed misleading `@Vault` decorator injection and `Host` class |

### 3. API Rename (v2.0.0 — BREAKING)

| Old | New |
|-----|-----|
| `@Relic()` | `@Injectable()` |
| `@Summon()` | `@Inject()` |
| `@Vault()` | `@Module()` |
| `Genesis.from()` | `Container.from()` |
| `relics` | `providers` |
| `reveal` | `exports` |
| `fuse` | `imports` |
| `aether` | `global` |
| `StaticRelicRegistry` | `MetadataRegistry` |
| `VaultConfig` | `ModuleConfig` |

Backward-compatible aliases preserved for all old names.

### 4. Performance

| Optimization | Result |
|-------------|--------|
| Scoped lifecycle hot path | 3.4x faster — eliminated closure allocations in `createScope()`, shared frozen constants in `provide()`, skip disposable check for primitives |
| MRU → SingletonCache | Renamed for clarity, removed unused `mruSize` config |

**Benchmark results (median, Node v22):**

| Scenario | Ceryn | Best competitor | Margin |
|----------|-------|----------------|--------|
| Cold boot | 0.24 ms | 14 ms (Needle) | 57x faster |
| Warm 1k | 129 ms | 217 ms (Inversify) | 1.7x faster |
| Burst 10k | 1.09 s | 1.85 s (Inversify) | 1.7x faster |
| Cross-module 5k | 81 ms | 98 ms (TypeDI) | 1.2x faster |
| Scoped 1k | 494 ms | 1.01 s (Tsyringe) | 2x faster |
| Async factory 100 | 24 ms | — (no competitor) | unique |

### 5. Cleanup & Documentation

- Deleted 7 stale benchmark files, created 1 consolidated comparison benchmark
- Exported all error classes from public API
- Removed unimplemented `__CERYN_MANIFEST__` declarations
- Deleted dead `AliasCollisionError`
- Fixed all JSDoc (Genesis→Container, Token.for→token(), finalizeEntries removal)
- Updated README with benchmark table and v2.0 API examples
- Added ESM smoke test

### 6. New Package: `@ceryn/fastify`

Per-request scoped DI plugin for Fastify:
- `onRequest`: creates scope, provides request-specific values
- `onResponse`/`onError`: auto-disposes scope (prevents leaks)
- `onClose`: disposes container singletons on shutdown
- Built-in `RequestToken` and `ReplyToken`
- 4 integration tests passing

### 7. CI/CD Improvements

| Change | Purpose |
|--------|---------|
| Build order | Vault builds before fastify (fastify depends on vault types) |
| `semantic-release-monorepo` | Only vault-path commits trigger vault releases |
| Bridging tag `@ceryn/vault-v2.2.0` | Continues version history under new tag format |
| Release rules | Standard `feat`/`fix`/`perf`/`breaking` with path filtering |

---

## Current Architecture

```
ceryn/
├── packages/
│   ├── vault/          (@ceryn/vault v2.2.0 — published)
│   │   ├── src/
│   │   │   ├── core/          vault.ts, scope.ts, resolvers, activator, etc.
│   │   │   ├── decorators/    injectable.ts, inject.ts, module.ts
│   │   │   ├── registry/      metadata-registry.ts
│   │   │   ├── api/           container.ts, token-utils.ts
│   │   │   ├── errors/        errors.ts (20 error classes)
│   │   │   └── types/         types.ts
│   │   ├── tests/             24 test files, 109 tests
│   │   └── benchmarks/        benchmark.ts (6 phases, 5 libs)
│   └── fastify/        (@ceryn/fastify v0.1.0 — source only)
│       ├── src/               index.ts, tokens.ts, augment.d.ts
│       └── tests/             4 integration tests
├── .github/workflows/
│   ├── ci.yml                 typecheck → lint → format → build → test
│   └── release.yml            semantic-release (vault only, path-filtered)
└── tsconfig.base.json         NodeNext module resolution
```

---

## Next Steps (prioritized)

1. **Example project** — `examples/fastify-app` showing real layered architecture
2. **Docs site** — Vitepress with intro, quick-start, modules, scopes, API reference
3. **Optional injection** — `@Inject(Token, { optional: true })` returns undefined if not registered
4. **Multi-binding** — resolve all implementations of a token (plugin systems)
5. **Migration guide** — NestJS/Inversify/tsyringe comparison page
6. **Publish `@ceryn/fastify` 1.0** when adapter is stable
