# @ceryn/vault

A **zero-reflection** dependency injection container for TypeScript that prioritizes performance, type safety, and explicit design over magic.

## Why Ceryn Vault?

- **Zero Reflection**: No runtime reflection overhead - all metadata captured at decorator evaluation time
- **Blazingly Fast**: Optimized hot paths with MRU caching and bit-flag lifecycles
- **Type-Safe**: Full TypeScript support with compile-time type checking via phantom types
- **Explicit Over Implicit**: Every dependency must be explicitly declared with `@Summon()`
- **Modular Architecture**: Compose vaults with fusion for clean separation of concerns
- **Modern**: Built for ES modules, Node.js 18+, and contemporary TypeScript

## Installation

```bash
npm install @ceryn/vault
```

## Quick Start

```typescript
import { Genesis, Relic, Summon, Vault, token } from '@ceryn/vault';

// 1. Create type-safe tokens
const DatabaseT = token<Database>('Database');
const UserServiceT = token<UserService>('UserService');

// 2. Define injectable relics with explicit dependencies
@Relic({ provide: DatabaseT })
class Database {
  query(sql: string) {
    return `Result: ${sql}`;
  }
}

@Relic({ provide: UserServiceT })
class UserService {
  constructor(@Summon(DatabaseT) private db: Database) {}

  getUser(id: number) {
    return this.db.query(`SELECT * FROM users WHERE id = ${id}`);
  }
}

// 3. Create a vault to compose your dependencies
@Vault({
  relics: [Database, UserService],
  reveal: [UserServiceT],
})
class AppVault {}

// 4. Bootstrap and resolve
const genesis = Genesis.from(AppVault);
const userService = genesis.resolve(UserServiceT);

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

### Relics

Relics are injectable classes registered with the DI container. Use the `@Relic()` decorator to mark classes as injectable.

```typescript
import { Relic, Summon, Lifecycle } from '@ceryn/vault';

@Relic({ provide: LoggerT })
class Logger {
  log(message: string) {
    console.log(`[LOG] ${message}`);
  }
}

// With explicit lifecycle
@Relic({
  provide: RequestHandlerT,
  lifecycle: Lifecycle.Transient,
})
class RequestHandler {
  constructor(
    @Summon(LoggerT) private logger: Logger,
    @Summon(ConfigT) private config: AppConfig
  ) {}
}
```

### Lifecycles

Ceryn Vault supports three lifecycle strategies:

- **Singleton** (default): One instance per vault, shared across all resolutions
- **Scoped**: One instance per logical scope (e.g., per HTTP request)
- **Transient**: Fresh instance for every resolution

```typescript
import { Lifecycle } from '@ceryn/vault';

@Relic({ provide: ConfigT, lifecycle: Lifecycle.Singleton })
class Config {}

@Relic({ provide: RequestContextT, lifecycle: Lifecycle.Scoped })
class RequestContext {}

@Relic({ provide: FactoryT, lifecycle: Lifecycle.Transient })
class Factory {}
```

### Vaults

Vaults are containers that organize and compose your dependencies. They support modular architecture through vault fusion.

```typescript
import { Vault } from '@ceryn/vault';

@Vault({
  relics: [Logger, Config], // Classes to register
  reveal: [LoggerT, ConfigT], // Tokens to expose
  name: 'CoreVault', // Optional name for debugging
})
class CoreVault {}
```

### Vault Fusion

Compose vaults together to create modular, maintainable architectures. Only revealed tokens are accessible to fused vaults.

```typescript
// Core vault with shared services
@Vault({
  relics: [Logger, Config],
  reveal: [LoggerT, ConfigT],
  aether: true, // Transitive accessibility
})
class CoreVault {}

// Database vault that uses core services
@Vault({
  relics: [Database, DatabaseConfig],
  reveal: [DatabaseT],
  fuse: [CoreVault], // Import core services
})
class DatabaseVault {}

// Application vault composing everything
@Vault({
  relics: [UserService, UserRepository],
  reveal: [UserServiceT],
  fuse: [CoreVault, DatabaseVault],
})
class AppVault {}
```

### Genesis

Genesis is the entry point for bootstrapping vault instances with lazy instantiation and caching.

```typescript
import { Genesis } from '@ceryn/vault';

// Create vault instance (cached)
const genesis = Genesis.from(AppVault);

// Resolve singleton dependencies
const userService = genesis.resolve(UserServiceT);

// Create scopes for request-level dependencies
const scope = genesis.createScope();
const handler = scope.resolve(HandlerT);
await scope.dispose();

// Clear cache for testing
Genesis.clearCache();
```

## Advanced Features

### Scoped Dependencies

Create isolated scopes for request-level dependencies:

```typescript
import { Lifecycle } from '@ceryn/vault';

@Relic({ provide: RequestContextT, lifecycle: Lifecycle.Scoped })
class RequestContext {
  constructor(@Summon(ConfigT) private config: Config) {}
}

@Relic({ provide: HandlerT, lifecycle: Lifecycle.Scoped })
class RequestHandler {
  constructor(@Summon(RequestContextT) private ctx: RequestContext) {}

  handle() {
    // ... handle request
  }
}

// Create a scope for each request
async function handleRequest(req: Request) {
  const scope = genesis.createScope();

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

Dynamically provide values to scopes at runtime. Scope-local registrations override vault registrations:

```typescript
// Define tokens for runtime values
const HttpRequestT = token<Request>('HttpRequest');
const HttpResponseT = token<Response>('HttpResponse');
const RequestIdT = token<string>('RequestId');

// Create a handler that depends on runtime values
@Relic({ provide: HandlerT })
class RequestHandler {
  constructor(
    @Summon(HttpRequestT) private req: Request,
    @Summon(HttpResponseT) private res: Response,
    @Summon(RequestIdT) private requestId: string
  ) {}

  handle() {
    this.res.setHeader('X-Request-ID', this.requestId);
    // ... process request
  }
}

// In your HTTP server
app.use(async (req, res) => {
  const scope = genesis.createScope();

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
- `has<T>(token: Token<T>): boolean`: Check if token exists in scope or vault
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
import { Vault } from '@ceryn/vault';

@Vault({
  relics: [
    {
      provide: LoggerT,
      useFactory: (config: AppConfig) => new Logger(config.logLevel),
      deps: [ConfigT],
      lifecycle: Lifecycle.Singleton,
    },
  ],
})
class AppVault {}
```

### Value Providers

Register pre-created values or configuration objects:

```typescript
@Vault({
  relics: [
    {
      provide: ConfigT,
      useValue: { apiKey: 'secret', logLevel: 'info' },
    },
  ],
})
class AppVault {}
```

### Aether Mode

Enable transitive accessibility for shared vaults:

```typescript
@Vault({
  relics: [Logger, Config, Cache],
  reveal: [LoggerT, ConfigT, CacheT],
  aether: true, // All descendants can access these services
})
class InfrastructureVault {}
```

### Custom Lazy Resolvers

Provide custom resolution logic for advanced scenarios:

```typescript
const customResolver = (vaultClass: Constructor) => {
  // Custom vault instantiation logic
  return new Vault(/* ... */);
};

@Vault({
  relics: [
    /* ... */
  ],
  lazyResolve: customResolver,
})
class CustomVault {}
```

### Telemetry Hooks

Monitor instantiation performance:

```typescript
@Vault({
  relics: [
    /* ... */
  ],
  onInstantiate: (token: string, durationNs: number) => {
    console.log(`${token} instantiated in ${durationNs}ns`);
  },
})
class ObservableVault {}
```

## Performance

Ceryn Vault is designed for performance-critical applications. Based on benchmarks comparing major DI frameworks:

**Key Performance Features:**

- Zero reflection overhead (all metadata captured at decorator time)
- Hot-path MRU caching for frequently accessed dependencies
- Bit-flag lifecycle checks (faster than string comparisons)
- Frozen metadata objects (VM optimization friendly)
- Lazy vault instantiation (pay-as-you-go)

**Benchmark Highlights** (from [di-comp.bench.ts](benchmarks/di-comp.bench.ts)):

- Cold boot: Competitive with fastest DI containers
- Warm resolution: Optimized for steady-state performance
- Burst scenarios: Efficient handling of 10k+ resolutions
- Memory efficient: Minimal heap allocation

Run benchmarks yourself:

```bash
npm run bench:comparison
npm run bench:genesis:perf
```

## Architecture Patterns

### Layered Architecture

```typescript
// Infrastructure Layer
@Vault({
  relics: [Database, Cache, Logger],
  reveal: [DatabaseT, CacheT, LoggerT],
  aether: true,
})
class InfraVault {}

// Repository Layer
@Vault({
  relics: [UserRepository, OrderRepository],
  reveal: [UserRepoT, OrderRepoT],
  fuse: [InfraVault],
})
class DataVault {}

// Service Layer
@Vault({
  relics: [UserService, OrderService],
  reveal: [UserServiceT, OrderServiceT],
  fuse: [DataVault],
})
class ServiceVault {}

// Presentation Layer
@Vault({
  relics: [UserController, OrderController],
  reveal: [UserControllerT, OrderControllerT],
  fuse: [ServiceVault],
})
class AppVault {}
```

### Request-Scoped HTTP Handler

```typescript
import { Lifecycle } from '@ceryn/vault';

// Scoped services are instantiated once per scope
@Relic({ provide: RequestContextT, lifecycle: Lifecycle.Scoped })
class RequestContext {
  public readonly requestId = crypto.randomUUID();

  constructor(@Summon(LoggerT) private logger: Logger) {
    this.logger.log(`Request ${this.requestId} started`);
  }
}

@Relic({ provide: RequestHandlerT, lifecycle: Lifecycle.Scoped })
class RequestHandler {
  constructor(
    @Summon(RequestContextT) private ctx: RequestContext,
    @Summon(UserServiceT) private userService: UserService
  ) {}

  async handle(userId: string) {
    const user = await this.userService.getUser(userId);
    return { requestId: this.ctx.requestId, user };
  }
}

// In your HTTP server
app.get('/api/user/:id', async (req, res) => {
  // Create scope - binds resolve methods to this vault
  const scope = genesis.createScope();

  try {
    // All Lifecycle.Scoped relics are automatically isolated to this scope
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
  RelicNotFoundError,
  RelicNotExposedError,
  MissingSummonDecoratorError,
} from '@ceryn/vault';

try {
  const service = genesis.resolve(ServiceT);
} catch (error) {
  if (error instanceof RelicNotFoundError) {
    console.error('Service not registered');
  } else if (error instanceof CircularDependencyError) {
    console.error('Circular dependency detected');
  }
}
```

## Testing

Ceryn Vault is designed with testing in mind:

```typescript
import { Genesis } from '@ceryn/vault';
import { StaticRelicRegistry } from '@ceryn/vault';

describe('UserService', () => {
  beforeEach(() => {
    // Reset registries between tests
    StaticRelicRegistry.resetForTests();
    Genesis.clearCache();
  });

  it('should get user', () => {
    // Create test vault with mocks
    @Vault({
      relics: [{ provide: DatabaseT, useValue: mockDatabase }, UserService],
      reveal: [UserServiceT],
    })
    class TestVault {}

    const genesis = Genesis.from(TestVault);
    const service = genesis.resolve(UserServiceT);

    expect(service.getUser(1)).toBeDefined();
  });
});
```

## API Reference

### Core Exports

- `token<T>(label?: string): Token<T>` - Create a type-safe injection token
- `@Relic(options: RelicOptions)` - Mark a class as injectable
- `@Summon(token: Token<T>)` - Inject a dependency in constructor
- `@Vault(config: VaultConfig)` - Define a dependency container
- `Genesis.from(vaultClass: Constructor): Vault` - Bootstrap a vault

### Types

- `Token<T>` - Type-safe injection token
- `Lifecycle` - Lifecycle enum (Singleton, Scoped, Transient)
- `VaultConfig` - Vault configuration options
- `Provider` - Union of ClassProvider, ValueProvider, FactoryProvider
- `Constructor<T>` - Generic constructor type

### Utilities

- `StaticRelicRegistry` - Global registry for relic metadata
- `Scope` - Scoped resolution context
- `VaultRegistry` - Vault metadata lookup utilities

## Design Philosophy

Ceryn Vault is built on these principles:

1. **Explicit Over Implicit**: Every dependency must be explicitly declared. No magic.
2. **Type Safety First**: Leverage TypeScript's type system for compile-time guarantees.
3. **Performance Matters**: Zero-reflection architecture for minimal runtime overhead.
4. **Modular by Default**: Vault fusion enables clean separation of concerns.
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
