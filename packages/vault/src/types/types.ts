import type { CanonicalId, Token } from '../core/token.js';
import { InvalidModuleConfigError } from '../errors/errors.js';
import type { Vault } from '../core/vault.js';

/**
 * Generic constructor signature used throughout the DI container.
 *
 * @template T - Type produced by the constructor
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = any> = new (...args: any[]) => T;

/**
 * Token accepted by the DI container during registration and resolution.
 */
export type InjectionToken<T = unknown> = Token<T>;

export interface InjectableOptions {
  provide: InjectionToken;
  lifecycle?: Lifecycle;
  name?: string;
}

/** @deprecated Use InjectableOptions instead */
export type RelicOptions = InjectableOptions;

/**
 * Supported lifecycles for registered providers.
 *
 * The lifecycle determines how instances are created and cached:
 *   - **Singleton**: One instance per container (shared globally within container)
 *   - **Scoped**: One instance per logical scope (e.g., per HTTP request)
 *   - **Transient**: New instance for every resolution
 *
 * Implementation note:
 *   These string values are part of the public API for developer ergonomics.
 *   Internally, they are converted to bit flags for performance-critical
 *   resolution paths. This provides a zero-cost abstraction: strings at the
 *   API boundary, fast bit flags at runtime.
 *
 * Using a constant object instead of a string union provides:
 *   - Strong typing in TypeScript
 *   - Autocomplete support in IDEs
 *   - Interoperability with plain JavaScript consumers
 *   - Tree-shaking friendly for bundlers
 *
 * @example
 * ```typescript
 * @Injectable({ provide: ServiceT, lifecycle: Lifecycle.Scoped })
 * class RequestService { ... }
 *
 * @Injectable({ provide: ConfigT, lifecycle: Lifecycle.Singleton })
 * class Config { ... }
 * ```
 */
export const Lifecycle = {
  /** Single instance per container (default) - shared across all resolutions */
  Singleton: 'singleton',
  /** Instance scoped to a logical request scope - isolated per scope */
  Scoped: 'scoped',
  /** Fresh instance for every resolution - never cached */
  Transient: 'transient',
} as const;

/**
 * Lifecycle string literal type inferred from {@link Lifecycle}.
 *
 * Union type: 'singleton' | 'scoped' | 'transient'
 */
export type LifecycleType = (typeof Lifecycle)[keyof typeof Lifecycle];
export type Lifecycle = LifecycleType;

export function isLifecycle(value: unknown): value is LifecycleType {
  return (
    value === Lifecycle.Singleton || value === Lifecycle.Scoped || value === Lifecycle.Transient
  );
}

export function assertLifecycle(value: unknown, context: string): asserts value is LifecycleType {
  if (!isLifecycle(value)) {
    throw new InvalidModuleConfigError(
      `${context} lifecycle must be one of: singleton, scoped, transient. Received: ${String(value)}`
    );
  }
}

/**
 * Convert a lifecycle type string to its corresponding bit flag value.
 *
 * This function bridges the public API (string-based) and internal
 * implementation (bit flags). It's called during registration to convert
 * the developer-facing lifecycle string into a compact integer flag that
 * can be efficiently checked using bitwise operations.
 *
 * Bit flag values:
 *   - 'singleton' → 0b00 (LIFECYCLE_SINGLETON)
 *   - 'scoped'    → 0b01 (LIFECYCLE_SCOPED)
 *   - 'transient' → 0b10 (LIFECYCLE_TRANSIENT)
 *
 * Performance:
 *   This conversion happens once at registration time, not during resolution.
 *   Resolution code uses fast bitwise checks (e.g., `flags & LIFECYCLE_MASK`)
 *   instead of string comparisons.
 *
 * @param lifecycle - Lifecycle string value from the public API
 * @returns Integer bit flag (0b00, 0b01, or 0b10) for internal use
 * @internal - Not exported in public API, used only by vault internals
 */
export function lifecycleToFlag(lifecycle: LifecycleType): number {
  switch (lifecycle) {
    case 'singleton':
      return 0b00; // LIFECYCLE_SINGLETON
    case 'scoped':
      return 0b01; // LIFECYCLE_SCOPED
    case 'transient':
      return 0b10; // LIFECYCLE_TRANSIENT
    default:
      assertLifecycle(lifecycle, 'Provider');
      return 0b00; // Unreachable after assertLifecycle throws
  }
}

/**
 * Metadata produced by the `@Injectable()` decorator.
 *
 * All metadata objects are frozen to guarantee immutability at runtime.
 */
export interface ProviderMetadata {
  /** Canonical identifier of the provider */
  name: CanonicalId;
  /** Human-readable label used in diagnostics */
  label: string;
  /** Lifecycle strategy used by the container */
  lifecycle: LifecycleType;
}

/** @deprecated Use ProviderMetadata instead */
export type RelicMetadata = ProviderMetadata;

/**
 * Immutable provider definition captured during decorator evaluation.
 *
 * These definitions are consumed by the container when registering decorated
 * classes.
 */
export interface StaticProviderDefinition {
  /** Decorated constructor */
  readonly ctor: Constructor;
  /** Frozen metadata associated with the constructor */
  readonly metadata: ProviderMetadata;
  /**
   * Dependencies captured in parameter order.
   *
   * Undefined entries represent missing `@Inject()` decorators and will trigger
   * runtime errors if not corrected before resolution.
   */
  readonly dependencies: readonly (CanonicalId | undefined)[];
}

/** @deprecated Use StaticProviderDefinition instead */
export type StaticRelicDefinition = StaticProviderDefinition;

/**
 * Register a class constructor.
 *
 * @example
 * ```typescript
 * { provide: DatabaseToken, useClass: PostgresDatabase }
 * ```
 */
export interface ClassProvider {
  provide: InjectionToken;
  useClass: Constructor;
  lifecycle?: LifecycleType;
}

/**
 * Register a pre-created value/instance.
 *
 * @example
 * ```typescript
 * { provide: ConfigToken, useValue: { apiKey: 'secret' } }
 * ```
 */
export interface ValueProvider {
  provide: InjectionToken;
  useValue: unknown;
  /**
   * Whether the container owns this external value and should dispose it.
   * Defaults to false because useValue instances are usually owned by caller code.
   */
  owned?: boolean;
}
export type FactoryCtx = { signal?: AbortSignal };
/**
 * Register a factory function.
 *
 * @example
 * ```typescript
 * {
 *   provide: LoggerToken,
 *   useFactory: (config) => new Logger(config.logLevel),
 *   deps: [ConfigToken]
 * }
 * ```
 */
export type FactoryProvider<T = unknown> = {
  provide: InjectionToken;
  useFactory: (...deps: unknown[]) => T | Promise<T> | ((ctx: FactoryCtx) => Promise<T>);
  deps?: Array<InjectionToken | CanonicalId>;
  lifecycle?: Lifecycle; // Singleton | Transient | Scoped (if you add scopes later)
  /**
   * Whether the container owns factory-created instances and should dispose them.
   * Defaults to true.
   */
  owned?: boolean;
};

export type ShadowPolicy = 'error' | 'allow' | 'warn';

/**
 * Provider union accepted by the container.
 */
export type Provider = ClassProvider | ValueProvider | FactoryProvider;

/**
 * Decorated module class with embedded configuration.
 *
 * This interface represents module classes decorated with @Module() that
 * have configuration metadata attached via the __moduleCfg__ property.
 */
export interface DecoratedModuleClass extends Constructor<Vault> {
  __moduleCfg__: ModuleConfig;
}

/** @deprecated Use DecoratedModuleClass instead */
export type DecoratedVaultClass = DecoratedModuleClass;

/**
 * Module configuration passed to the constructor.
 */
export interface ModuleConfig {
  /**
   * Providers to register in this module.
   *
   * Can be:
   * - Class constructor decorated with @Injectable()
   * - Provider object (useClass, useValue, useFactory)
   */
  providers?: Array<Constructor | Provider>;

  /**
   * Modules to import (access exported providers from).
   *
   * Only providers in the `exports` list of imported modules are accessible.
   */
  imports?: (Constructor | Vault)[];

  /**
   * Providers to export to other modules.
   *
   * Only exported providers can be resolved by modules that import this one.
   * If not specified, no providers are exported (all private).
   */
  exports?: Array<InjectionToken>;

  /**
   * Optional name for debugging and error messages.
   */
  name?: string;

  /**
   * Enable transitive accessibility for all providers in this module.
   *
   * When true, all providers in this module can be resolved by ANY descendant module
   * in the import tree, bypassing normal export rules. This provides
   * transitive accessibility through the entire hierarchy.
   *
   * @default false
   */
  global?: boolean;

  /**
   * Policy for handling shadowed provider registrations.
   * - 'error' (default): throw an error when a provider registration shadows
   *   an existing token in the same module.
   * - 'allow': permit shadowing; the local registration takes precedence.
   *
   * @default 'error'
   */
  shadowPolicy?: ShadowPolicy;

  /**
   * Optional hook invoked after a provider is instantiated.
   *
   * Receives the canonical token string and the instantiation duration in
   * nanoseconds. Useful for profiling or custom telemetry.
   */
  onInstantiate?: (token: string, durationNs: number) => void;

  /**
   * Internal lazy import resolver function.
   *
   * @internal - Not part of public API. Used by Container framework to resolve
   * lazy module class references during import. If omitted, Vault will call the
   * resolver installed via Vault.setDefaultLazyResolver().
   */
  lazyResolve?: (ctor: Constructor) => Vault;
}

/** @deprecated Use ModuleConfig instead */
export type VaultConfig = ModuleConfig;

export interface Disposable {
  dispose: () => void;
  close: () => void;
}
