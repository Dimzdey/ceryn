import { isToken } from '../core/token.js';
import { MetadataRegistry } from '../registry/index.js';
import type { Constructor, InjectionToken } from '../types/types.js';

/**
 * Parameter decorator for constructor dependency injection.
 *
 * Declares an explicit dependency on another provider. ALL constructor parameters
 * MUST be decorated with @Inject() to enable dependency injection. This is
 * required because TypeScript's emitDecoratorMetadata is not used.
 *
 * The decorator records the parameter index -> token mapping in the
 * MetadataRegistry at module load time. During container construction, this
 * metadata is used to resolve and inject dependencies.
 *
 * Design rationale:
 * - Explicit over implicit: No hidden "magic" reflection
 * - Type-safe: Token<T> carries compile-time type information
 * - Performance: No runtime reflection overhead
 * - Deterministic: All dependencies known at module load time
 *
 * @param token - Injection token for the dependency
 *
 * @example
 * ```typescript
 * const DatabaseT = token<Database>('Database');
 * const LoggerT = token<Logger>('Logger');
 *
 * @Injectable({ provide: UserServiceT })
 * class UserService {
 *   constructor(
 *     @Inject(DatabaseT) private db: Database,
 *     @Inject(LoggerT) private logger: Logger
 *   ) {}
 * }
 * ```
 */
export function Inject<T>(token: InjectionToken<T>): ParameterDecorator {
  return function (
    target: object,
    _propertyKey: string | symbol | undefined,
    parameterIndex: number
  ) {
    // Validate token before registration
    if (!isToken(token)) {
      throw new Error("@Inject expects a Token — create one: `const FooT = token<Foo>('Foo')`");
    }

    // Target is the constructor function for constructor parameter decorators.
    // Register the parameter index -> token mapping in the global registry.
    // The registry preserves order even if decorators are applied out-of-order.
    const constructor = target as unknown as Constructor;
    MetadataRegistry.registerInjection(constructor, parameterIndex, token);
  };
}
