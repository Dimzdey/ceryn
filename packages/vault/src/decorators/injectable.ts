import { isToken } from '../core/token.js';
import { MetadataRegistry } from '../registry/index.js';
import { assertLifecycle, Lifecycle } from '../types/index.js';
import type { Constructor, ProviderMetadata, InjectableOptions } from '../types/types.js';

/**
 * Marks a class as an injectable provider.
 *
 * Registers the class with its metadata in the MetadataRegistry at module
 * load time. The metadata includes lifecycle, canonical token ID, and human-
 * readable label for error messages.
 *
 * Requirements:
 * - Must pass a Token via the `provide` option
 * - Constructor parameters must use @Inject() decorator
 * - Lifecycle defaults to Singleton if not specified
 *
 * @param options - Injectable configuration
 * @param options.provide - Injection token for this provider (required)
 * @param options.lifecycle - Instance lifecycle (singleton/scoped/transient)
 * @param options.name - Optional human-readable name (defaults to token label)
 *
 * @returns Class decorator function
 *
 * @example
 * ```typescript
 * const UserServiceT = token<UserService>('UserService');
 *
 * @Injectable({ provide: UserServiceT })
 * class UserService {
 *   constructor(@Inject(DatabaseT) private db: Database) {}
 * }
 *
 * @Injectable({ provide: HandlerT, lifecycle: Lifecycle.Transient })
 * class RequestHandler {}
 *
 * @Injectable({ provide: ServiceT, name: 'CustomName' })
 * class MyService {}
 * ```
 */
export function Injectable(options: InjectableOptions): ClassDecorator {
  // Validate that a token was provided
  if (!options || !isToken(options.provide)) {
    throw new Error(
      "@Injectable() requires a token. Create one with `const FooT = token<Foo>('Foo')` and pass { provide: FooT }."
    );
  }

  return (target) => {
    const constructor = target as unknown as Constructor;
    const canonical = options.provide.id;
    const label = options.name ?? options.provide.label ?? constructor.name;
    const lifecycle = options.lifecycle ?? Lifecycle.Singleton;

    assertLifecycle(lifecycle, '@Injectable()');

    // Decorators run at module-evaluation time (import). We eagerly
    // normalize and freeze the metadata to make it immutable and safe to
    // share across multiple container instances. Freezing prevents accidental
    // mutations later which would cause surprising behavior at runtime.
    const metadata: ProviderMetadata = {
      name: canonical,
      label,
      lifecycle,
    };

    // Freeze metadata for immutability guarantees
    Object.freeze(metadata);

    // Register with global static registry
    MetadataRegistry.registerProvider(constructor, metadata);
  };
}
