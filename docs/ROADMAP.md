# @ceryn Roadmap

## Current State (June 2026)

- `@ceryn/vault` v2.2.0 — published, stable, all features working
- `@ceryn/fastify` v0.1.0 — source-only, 4 tests, basic plugin
- No docs site, no examples, no framework beyond Fastify

---

## Phase 1: Developer Experience (Q3 2026)

Goal: Make it easy for developers to adopt ceryn in real projects.

### 1.1 Example Project

**Package:** `examples/fastify-app/`

A complete Fastify application demonstrating:
- Layered architecture: `Controllers → Services → Repositories → Database`
- Request-scoped injection (one `UserContext` per request)
- Singleton services (database pool, config, logger)
- Factory providers (connection pool creation)
- Error handling with proper scope disposal
- Graceful shutdown

**Files:**
- `src/modules/` — AppModule, DatabaseModule, UserModule
- `src/services/` — UserService, AuthService
- `src/repositories/` — UserRepository
- `src/controllers/` — UserController, HealthController
- `src/main.ts` — Fastify bootstrap with cerynPlugin
- `docker-compose.yml` — PostgreSQL for demo
- `README.md` — how to run

**Effort:** ~2 hours

### 1.2 Documentation Site

**Tool:** Vitepress (lightweight, markdown-based, deploys to GitHub Pages)

**Pages:**
| Page | Content |
|------|---------|
| `/` | Hero + feature highlights + benchmark table |
| `/guide/getting-started` | Install, first module, resolve a service |
| `/guide/modules` | @Module, providers, imports, exports, global |
| `/guide/scopes` | Lifecycle types, createScope, per-request pattern |
| `/guide/async-factories` | Async providers, AbortSignal, promise dedup |
| `/guide/testing` | MetadataRegistry.resetForTests, mock providers |
| `/api/` | Auto-generated from TSDoc (typedoc or api-extractor) |
| `/comparison` | Side-by-side with NestJS, Inversify, tsyringe |
| `/migration/nestjs` | NestJS → ceryn translation table |
| `/migration/inversify` | Inversify → ceryn translation table |

**Deploy:** GitHub Pages via `docs:build` + `docs:deploy` scripts

**Effort:** ~4-6 hours

### 1.3 Fastify Adapter 1.0

**What's needed before publishing:**
- [ ] Decorator-based route injection: `app.get('/users', { inject: [UserServiceT] }, handler)`
- [ ] Auto-provide `RequestToken` and `ReplyToken` without user configuration
- [ ] `onModuleInit` / `onModuleDestroy` lifecycle interfaces on providers
- [ ] Error handling test (scope disposes even when route throws)
- [ ] README with production usage patterns
- [ ] Publish as `@ceryn/fastify@1.0.0`

**Effort:** ~3-4 hours

---

## Phase 2: Core Features (Q3-Q4 2026)

Goal: Close the feature gap with NestJS/Inversify for production use cases.

### 2.1 Optional Injection

**API:**
```typescript
@Injectable({ provide: ServiceT })
class MyService {
  constructor(@Inject(LoggerT, { optional: true }) private logger?: Logger) {}
}
```

**Implementation:**
- Add `options` parameter to `@Inject()` decorator
- Store `optional` flag in metadata alongside token
- In `Activator.instantiateSync/Async`: if token not found and `optional: true`, pass `undefined` instead of throwing
- New error: skip `MissingInjectDecoratorError` for optional params

**Effort:** ~1-2 hours

### 2.2 Multi-Binding (Token Arrays)

**API:**
```typescript
const PluginT = token<Plugin>('Plugin');

@Injectable({ provide: PluginT, multi: true })
class AuthPlugin implements Plugin {}

@Injectable({ provide: PluginT, multi: true })
class LogPlugin implements Plugin {}

// Resolves all implementations
const plugins = container.resolveAll(PluginT); // [AuthPlugin, LogPlugin]
```

**Implementation:**
- Add `multi: boolean` to `InjectableOptions`
- In `EntryStore`: support multiple entries per canonical token (array-backed)
- Add `Vault.resolveAll<T>(token): T[]` method
- Multi-tokens are always resolved as array (never cached as single)

**Effort:** ~3-4 hours

### 2.3 Lazy Injection

**API:**
```typescript
@Injectable({ provide: ServiceT })
class MyService {
  constructor(@Inject(HeavyServiceT, { lazy: true }) private heavy: Lazy<HeavyService>) {}

  doWork() {
    // Resolves on first access
    this.heavy.value.process();
  }
}
```

**Implementation:**
- `Lazy<T>` wrapper class with `.value` getter that triggers resolution
- Store vault + token reference in Lazy, resolve on first `.value` access
- Useful for breaking circular dependencies and deferring expensive init

**Effort:** ~2 hours

### 2.4 Interceptors / Resolution Middleware

**API:**
```typescript
@Module({
  providers: [...],
  interceptors: [LoggingInterceptor, TimingInterceptor],
})
class AppModule {}

class LoggingInterceptor implements ResolutionInterceptor {
  intercept(token: Token, next: () => unknown) {
    console.log(`Resolving ${token.label}`);
    return next();
  }
}
```

**Implementation:**
- `ResolutionInterceptor` interface with `intercept(token, next)` method
- Module config accepts `interceptors` array
- Resolver wraps instantiation in interceptor chain (onion model)
- Interceptors run per-resolution (can cache, log, transform, reject)

**Effort:** ~3 hours

---

## Phase 3: Ecosystem (Q4 2026)

Goal: Framework adapters and tooling that make ceryn a real alternative to NestJS.

### 3.1 Additional Framework Adapters

| Package | Framework | Scope model |
|---------|-----------|-------------|
| `@ceryn/express` | Express 5.x | Middleware creates/disposes scope |
| `@ceryn/hono` | Hono | Middleware-based, Bun + Node |
| `@ceryn/koa` | Koa | ctx-based scope |

Each adapter: ~50-100 lines, same pattern as fastify plugin.

### 3.2 CLI / Code Generator

**`@ceryn/cli`** — scaffolding tool:
```bash
npx @ceryn/cli new my-app       # scaffold fastify app with ceryn
npx @ceryn/cli g module users   # generate module + service + controller
npx @ceryn/cli g provider cache # generate provider with token
```

### 3.3 DevTools

**`@ceryn/devtools`** — runtime introspection:
- Dependency graph visualization (mermaid/d3)
- Resolution timing dashboard (uses `onInstantiate` hook)
- Scope leak detection (warns on undisposed scopes)
- Export as JSON for CI analysis

### 3.4 Compiler Plugin (optional, aspirational)

**`@ceryn/compiler`** — build-time optimization:
- Static analysis of module graph at build time
- Pre-compute resolution order (skip runtime DFS)
- Validate all tokens are satisfiable at compile time (vs runtime)
- Emit `__CERYN_MANIFEST__` for near-zero cold start

---

## Phase 4: Maturity (2027)

### 4.1 Stability & Trust
- [ ] 6+ months of stable releases with no breaking changes
- [ ] 90%+ test coverage across all packages
- [ ] Security audit (singleton leak detection, prototype pollution guards)
- [ ] Performance regression CI (benchmark runs on every PR, alerts on degradation)

### 4.2 Community
- [ ] Contributing guide + PR templates
- [ ] Discord or GitHub Discussions
- [ ] 2-3 blog posts (zero-reflection architecture, benchmark methodology, migration guide)
- [ ] Conference talk or video demo

### 4.3 Enterprise Features
- [ ] Multi-tenant module isolation (namespace-scoped registries)
- [ ] Hot module replacement support (re-register providers without restart)
- [ ] Distributed tracing integration (OpenTelemetry span per resolution)

---

## Version Strategy

| Package | Current | Next milestone |
|---------|---------|---------------|
| `@ceryn/vault` | 2.2.0 | 2.3.0 (optional injection) |
| `@ceryn/fastify` | 0.1.0 (source) | 1.0.0 (after lifecycle hooks) |
| `@ceryn/express` | — | 0.1.0 (Phase 3) |
| `@ceryn/cli` | — | 0.1.0 (Phase 3) |
| `@ceryn/devtools` | — | 0.1.0 (Phase 3) |

---

## Priorities (immediate next actions)

1. Example project (`examples/fastify-app`)
2. Docs site (Vitepress, 10 pages)
3. Optional injection (`@Inject(T, { optional: true })`)
4. Fastify adapter 1.0 (lifecycle hooks + auto-provide tokens)
5. Multi-binding (`resolveAll`)
