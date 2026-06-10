# @ceryn/vault

A **zero-reflection** dependency injection container for TypeScript that prioritizes performance, type safety, and explicit design over magic.

## Why Ceryn Vault?

- **Zero Reflection**: No runtime reflection overhead - all metadata captured at decorator evaluation time
- **Blazingly Fast**: 57x faster cold boot than nearest competitor, 1.5–2x faster warm resolution
- **Type-Safe**: Full TypeScript support with compile-time type checking via phantom types
- **Explicit Over Implicit**: Every dependency must be explicitly declared with `@Inject()`
- **Modular Architecture**: Compose modules with imports for clean separation of concerns
- **Modern**: Built for ES modules, Node.js 18+, and contemporary TypeScript

## Installation

```bash
npm install @ceryn/vault
```

## Quick Start

```typescript
import { Container, Injectable, Inject, Module, token } from '@ceryn/vault';

// 1. Create type-safe tokens
const DatabaseT = token<Database>('Database');
const UserServiceT = token<UserService>('UserService');

// 2. Define injectable providers with explicit dependencies
@Injectable({ provide: DatabaseT })
class Database {
  query(sql: string) {
    return `Result: ${sql}`;
  }
}

@Injectable({ provide: UserServiceT })
class UserService {
  constructor(@Inject(DatabaseT) private db: Database) {}

  getUser(id: number) {
    return this.db.query(`SELECT * FROM users WHERE id = ${id}`);
  }
}

// 3. Create a module to compose your dependencies
@Module({
  providers: [Database, UserService],
  exports: [UserServiceT],
})
class AppModule {}

// 4. Bootstrap and resolve
const container = Container.create(AppModule);
const userService = container.resolve(UserServiceT);

console.log(userService.getUser(1));
// Output: Result: SELECT * FROM users WHERE id = 1
```

## Core Concepts

### Tokens

Tokens are type-safe identifiers for your dependencies. They carry compile-time type information and provide runtime identity.

```typescript
import { token } from '@ceryn/vault';

// Create tokens with type information
const LoggerT = token<Logger>('Logger');
const ConfigT = token<AppConfig>('AppConfig');
const CacheT = token<Cache>('Cache');
```

### Providers

Providers are injectable classes registered with the DI container. Use the `@Injectable()` decorator to mark classes as injectable.

```typescript
import { Injectable, Inject, Lifecycle } from '@ceryn/vault';

@Injectable({ provide: LoggerT })
class Logger {
  log(message: string) {
    console.log(`[LOG] ${message}`);
  }
}

// With explicit lifecycle
@Injectable({
  provide: RequestHandlerT,
  lifecycle: Lifecycle.Transient,
})
class RequestHandler {
  constructor(
    @Inject(LoggerT) private logger: Logger,
    @Inject(ConfigT) private config: AppConfig
  ) {}
}
```

### Lifecycles

Ceryn Vault supports three lifecycle strategies:

- **Singleton** (default): One instance per module, shared across all resolutions
- **Scoped**: One instance per logical scope (e.g., per HTTP request)
- **Transient**: Fresh instance for every resolution

```typescript
import { Lifecycle } from '@ceryn/vault';

@Injectable({ provide: ConfigT, lifecycle: Lifecycle.Singleton })
class Config {}

@Injectable({ provide: RequestContextT, lifecycle: Lifecycle.Scoped })
class RequestContext {}

@Injectable({ provide: FactoryT, lifecycle: Lifecycle.Transient })
class Factory {}
```

### Modules

Modules are containers that organize and compose your dependencies. They support modular architecture through module composition.

```typescript
import { Module } from '@ceryn/vault';

@Module({
  providers: [Logger, Config], // Classes to register
  exports: [LoggerT, ConfigT], // Tokens to expose
  name: 'CoreModule', // Optional name for debugging
})
class CoreModule {}
```

### Module Composition

Compose modules together to create modular, maintainable architectures. Only exported tokens are accessible to importing modules.

```typescript
// Core module with shared services
@Module({
  providers: [Logger, Config],
  exports: [LoggerT, ConfigT],
  global: true, // Transitive accessibility
})
class CoreModule {}

// Database module that uses core services
@Module({
  providers: [Database, DatabaseConfig],
  exports: [DatabaseT],
  imports: [CoreModule], // Import core services
})
class DatabaseModule {}

// Application module composing everything
@Module({
  providers: [UserService, UserRepository],
  exports: [UserServiceT],
  imports: [CoreModule, DatabaseModule],
})
class AppModule {}
```

### Container

Container is the entry point for bootstrapping module instances with lazy instantiation and caching.

```typescript
import { Container } from '@ceryn/vault';

// Create module instance (cached)
const container = Container.create(AppModule);

// Resolve singleton dependencies
const userService = container.resolve(UserServiceT);

// Create scopes for request-level dependencies
const scope = container.createScope();
const handler = scope.resolve(HandlerT);
await scope.dispose();

// Clear cache for testing
Container.clearCache();
```

## Advanced Features

### Scoped Dependencies

Create isolated scopes for request-level dependencies:

```typescript
import { Lifecycle } from '@ceryn/vault';

@Injectable({ provide: RequestContextT, lifecycle: Lifecycle.Scoped })
class RequestContext {
  constructor(@Inject(ConfigT) private config: Config) {}
}

@Injectable({ provide: HandlerT, lifecycle: Lifecycle.Scoped })
class RequestHandler {
  constructor(@Inject(RequestContextT) private ctx: RequestContext) {}

  handle() {
    // ... handle request
  }
}

// Create a scope for each request
async function handleRequest(req: Request) {
  const scope = container.createScope();

  try {
    // Scoped instances are automatically created and isolated per scope
    const handler = scope.resolve(HandlerT);
    await handler.handle();
  } finally {
    await scope.dispose(); // Clean up scoped resources
  }
}
```

### Dynamic Scope Registration

Dynamically provide values to scopes at runtime. Scope-local registrations override module registrations:

```typescript
// Define tokens for runtime values
const HttpRequestT = token<Request>('HttpRequest');
const HttpResponseT = token<Response>('HttpResponse');
const RequestIdT = token<string>('RequestId');

// Create a handler that depends on runtime values
@Injectable({ provide: HandlerT })
class RequestHandler {
  constructor(
    @Inject(HttpRequestT) private req: Request,
    @Inject(HttpResponseT) private res: Response,
    @Inject(RequestIdT) private requestId: string
  ) {}

  handle() {
    this.res.setHeader('X-Request-ID', this.requestId);
    // ... process request
  }
}

// In your HTTP server
app.use(async (req, res) => {
  const scope = container.createScope();

  try {
    // Provide runtime values to the scope
    scope.provide(HttpRequestT, req);
    scope.provide(HttpResponseT, res);
    scope.provide(RequestIdT, crypto.randomUUID());

    // Dependencies are automatically injected
    const handler = scope.resolve(HandlerT);
    await handler.handle();
  } finally {
    await scope.dispose();
  }
});
```

**Scope Methods:**

- `provide<T>(token: Token<T>, value: T)`: Register a scope-local value
- `has<T>(token: Token<T>): boolean`: Check if token exists in scope or module
- `tryResolve<T>(token: Token<T>): T | undefined`: Safe resolution with fallback
- `override<T>(token: Token<T>, value: T)`: Replace existing registration

```typescript
// Check token availability
if (scope.has(OptionalServiceT)) {
  const service = scope.resolve(OptionalServiceT);
  service.doWork();
}

// Safe resolution with fallback
const logger = scope.tryResolve(LoggerT) ?? console;
logger.log('Using fallback logger if needed');

// Override for testing
const mockDb = createMockDatabase();
scope.override(DatabaseT, mockDb);
```

**Key Features:**

- Scope-local registrations take **highest priority** (even over singleton cache)
- Automatic cleanup for disposable instances (`dispose()` or `close()` methods)
- Multiple scopes are completely isolated from each other
- Type-safe API with full IntelliSense support

### Factory Providers

Register dependencies using factory functions:

```typescript
import { Module } from '@ceryn/vault';

@Module({
  providers: [
    {
      provide: LoggerT,
      useFactory: (config: AppConfig) => new Logger(config.logLevel),
      deps: [ConfigT],
      lifecycle: Lifecycle.Singleton,
    },
  ],
})
class AppModule {}
```

### Value Providers

Register pre-created values or configuration objects:

```typescript
@Module({
  providers: [
    {
      provide: ConfigT,
      useValue: { apiKey: 'secret', logLevel: 'info' },
    },
  ],
})
class AppModule {}
```

### Global Mode

Enable transitive accessibility for shared modules:

```typescript
@Module({
  providers: [Logger, Config, Cache],
  exports: [LoggerT, ConfigT, CacheT],
  global: true, // All descendants can access these services
})
class InfrastructureModule {}
```

### Custom Lazy Resolvers

Provide custom resolution logic for advanced scenarios:

```typescript
const customResolver = (moduleClass: Constructor) => {
  // Custom module instantiation logic
  return new Module(/* ... */);
};

@Module({
  providers: [
    /* ... */
  ],
  lazyResolve: customResolver,
})
class CustomModule {}
```

### Telemetry Hooks

Monitor instantiation performance:

```typescript
@Module({
  providers: [
    /* ... */
  ],
  onInstantiate: (token: string, durationNs: number) => {
    console.log(`${token} instantiated in ${durationNs}ns`);
  },
})
class ObservableModule {}
```

## Performance

Ceryn Vault is designed for performance-critical applications.

### Benchmark Results

Compared against popular TypeScript DI containers on a realistic workload (6 endpoints, 3-layer dependency graph, singleton resolution):

| Scenario | Ceryn | Inversify | Tsyringe | TypeDI | Needle |
|----------|-------|-----------|----------|--------|--------|
| **Cold boot** | **0.25 ms** | 95 ms | 140 ms | 14 ms | 17 ms |
| **Warm 1k requests** | **134 ms** | 185 ms | 312 ms | 296 ms | 288 ms |
| **Burst 10k** | **1.08 s** | 1.54 s | 2.59 s | 2.47 s | 2.40 s |
| **Cross-module resolve 5k** | **49 ms** | 426 ms | 693 ms | 98 ms | 138 ms |

> **Cold boot is 57–559x faster** than alternatives. Warm-state resolution is 1.5–2.3x faster. Measured on Node v22, median values.

### Why it's fast

- **Zero reflection** — all metadata captured at decorator evaluation time, no `reflect-metadata` scanning
- **Bit-flag lifecycles** — integer bitwise checks instead of string comparisons on hot path
- **Singleton instance cache** — O(1) Map lookup for repeated resolutions
- **Frozen metadata** — V8 optimization-friendly immutable objects
- **Lazy module instantiation** — imported modules materialized on first cross-module resolve

Run benchmarks yourself:

```bash
npm run bench
```

## Architecture Patterns

### Layered Architecture

```typescript
// Infrastructure Layer
@Module({
  providers: [Database, Cache, Logger],
  exports: [DatabaseT, CacheT, LoggerT],
  global: true,
})
class InfraModule {}

// Repository Layer
@Module({
  providers: [UserRepository, OrderRepository],
  exports: [UserRepoT, OrderRepoT],
  imports: [InfraModule],
})
class DataModule {}

// Service Layer
@Module({
  providers: [UserService, OrderService],
  exports: [UserServiceT, OrderServiceT],
  imports: [DataModule],
})
class ServiceModule {}

// Presentation Layer
@Module({
  providers: [UserController, OrderController],
  exports: [UserControllerT, OrderControllerT],
  imports: [ServiceModule],
})
class AppModule {}
```

### Request-Scoped HTTP Handler

```typescript
import { Lifecycle } from '@ceryn/vault';

// Scoped services are instantiated once per scope
@Injectable({ provide: RequestContextT, lifecycle: Lifecycle.Scoped })
class RequestContext {
  public readonly requestId = crypto.randomUUID();

  constructor(@Inject(LoggerT) private logger: Logger) {
    this.logger.log(`Request ${this.requestId} started`);
  }
}

@Injectable({ provide: RequestHandlerT, lifecycle: Lifecycle.Scoped })
class RequestHandler {
  constructor(
    @Inject(RequestContextT) private ctx: RequestContext,
    @Inject(UserServiceT) private userService: UserService
  ) {}

  async handle(userId: string) {
    const user = await this.userService.getUser(userId);
    return { requestId: this.ctx.requestId, user };
  }
}

// In your HTTP server
app.get('/api/user/:id', async (req, res) => {
  // Create scope - binds resolve methods to this module
  const scope = container.createScope();

  try {
    // All Lifecycle.Scoped providers are automatically isolated to this scope
    const handler = scope.resolve(RequestHandlerT);
    const result = await handler.handle(req.params.id);
    res.json(result);
  } finally {
    await scope.dispose(); // Cleanup scoped resources
  }
});
```

## Error Handling

Ceryn Vault provides detailed error messages for common issues:

```typescript
import {
  CircularDependencyError,
  ProviderNotFoundError,
  ProviderNotExposedError,
  MissingInjectDecoratorError,
} from '@ceryn/vault';

try {
  const service = container.resolve(ServiceT);
} catch (error) {
  if (error instanceof ProviderNotFoundError) {
    console.error('Service not registered');
  } else if (error instanceof CircularDependencyError) {
    console.error('Circular dependency detected');
  }
}
```

## Testing

Ceryn Vault is designed with testing in mind:

```typescript
import { Container } from '@ceryn/vault';
import { MetadataRegistry } from '@ceryn/vault';

describe('UserService', () => {
  beforeEach(() => {
    // Reset registries between tests
    MetadataRegistry.resetForTests();
    Container.clearCache();
  });

  it('should get user', () => {
    // Create test module with mocks
    @Module({
      providers: [{ provide: DatabaseT, useValue: mockDatabase }, UserService],
      exports: [UserServiceT],
    })
    class TestModule {}

    const container = Container.create(TestModule);
    const service = container.resolve(UserServiceT);

    expect(service.getUser(1)).toBeDefined();
  });
});
```

## API Reference

### Core Exports

- `token<T>(label?: string): Token<T>` - Create a type-safe injection token
- `@Injectable(options: InjectableOptions)` - Mark a class as injectable
- `@Inject(token: Token<T>)` - Inject a dependency in constructor
- `@Module(config: ModuleConfig)` - Define a dependency container
- `Container.create(moduleClass: Constructor): Container` - Bootstrap a module

### Types

- `Token<T>` - Type-safe injection token
- `Lifecycle` - Lifecycle enum (Singleton, Scoped, Transient)
- `ModuleConfig` - Module configuration options
- `Provider` - Union of ClassProvider, ValueProvider, FactoryProvider
- `Constructor<T>` - Generic constructor type

### Utilities

- `MetadataRegistry` - Global registry for provider metadata
- `Scope` - Scoped resolution context
- `ModuleRegistry` - Module metadata lookup utilities

## Design Philosophy

Ceryn Vault is built on these principles:

1. **Explicit Over Implicit**: Every dependency must be explicitly declared. No magic.
2. **Type Safety First**: Leverage TypeScript's type system for compile-time guarantees.
3. **Performance Matters**: Zero-reflection architecture for minimal runtime overhead.
4. **Modular by Default**: Module composition enables clean separation of concerns.
5. **Developer Experience**: Clear error messages and intuitive APIs.

## Requirements

- Node.js >= 18.0.0
- TypeScript >= 5.3.3
- `experimentalDecorators` enabled in `tsconfig.json`

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": false
  }
}
```

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

MIT

## Acknowledgments

Built with inspiration from the TypeScript DI ecosystem, with a focus on performance and explicitness.

---

**Made with TypeScript** | [GitHub](https://github.com/Dimzdey/ceryn) | [Issues](https://github.com/Dimzdey/ceryn/issues)
