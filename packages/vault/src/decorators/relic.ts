import { isToken } from '../core/token.js';
import { StaticRelicRegistry } from '../registry/index.js';
import { Lifecycle } from '../types/index.js';
import type { Constructor, RelicMetadata, RelicOptions } from '../types/types.js';

/**
 * Marks a class as an injectable relic.
 *
 * Registers the class with its metadata in the StaticRelicRegistry at module
 * load time. The metadata includes lifecycle, canonical token ID, and human-
 * readable label for error messages.
 *
 * Requirements:
 * - Must pass a Token via the `provide` option
 * - Constructor parameters must use @Summon() decorator
 * - Lifecycle defaults to Singleton if not specified
 *
 * @param options - Relic configuration
 * @param options.provide - Injection token for this relic (required)
 * @param options.lifecycle - Instance lifecycle (singleton/scoped/transient)
 * @param options.name - Optional human-readable name (defaults to token label)
 *
 * @returns Class decorator function
 *
 * @example
 * ```typescript
 * const UserServiceT = token<UserService>('UserService');
 *
 * @Relic({ provide: UserServiceT })
 * class UserService {
 *   constructor(@Summon(DatabaseT) private db: Database) {}
 * }
 *
 * @Relic({ provide: HandlerT, lifecycle: Lifecycle.Transient })
 * class RequestHandler {}
 *
 * @Relic({ provide: ServiceT, name: 'CustomName' })
 * class MyService {}
 * ```
 */
export function Relic(options: RelicOptions): ClassDecorator {
  // Validate that a token was provided
  if (!options || !isToken(options.provide)) {
    throw new Error(
      "@Relic() requires a token. Create one with `const FooT = token<Foo>('Foo')` and pass { provide: FooT }."
    );
  }

  return (target) => {
    const constructor = target as unknown as Constructor;
    const canonical = options.provide.id;
    const label = options.name ?? options.provide.label ?? constructor.name;

    // Decorators run at module-evaluation time (import). We eagerly
    // normalize and freeze the metadata to make it immutable and safe to
    // share across multiple Vault instances. Freezing prevents accidental
    // mutations later which would cause surprising behavior at runtime.
    const metadata: RelicMetadata = {
      name: canonical,
      label,
      lifecycle: options.lifecycle ?? Lifecycle.Singleton,
    };

    // Freeze metadata for immutability guarantees
    Object.freeze(metadata);

    // Register with global static registry
    StaticRelicRegistry.registerRelic(constructor, metadata);
  };
}
