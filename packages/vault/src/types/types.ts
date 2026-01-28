import type { CanonicalId, Token } from '../core/token.js';
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

export interface RelicOptions {
  provide: InjectionToken;
  lifecycle?: Lifecycle;
  name?: string;
}

/**
 * Supported lifecycles for registered relics.
 *
 * The lifecycle determines how instances are created and cached:
 *   - **Singleton**: One instance per vault (shared globally within vault)
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
 * @Relic({ provide: ServiceT, lifecycle: Lifecycle.Scoped })
 * class RequestService { ... }
 *
 * @Relic({ provide: ConfigT, lifecycle: Lifecycle.Singleton })
 * class Config { ... }
 * ```
 */
export const Lifecycle = {
  /** Single instance per vault (default) - shared across all resolutions */
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
      // Defensive: fall back to singleton if given invalid lifecycle
      return 0b00; // LIFECYCLE_SINGLETON
  }
}

/**
 * Metadata produced by the `@Relic()` decorator.
 *
 * All metadata objects are frozen to guarantee immutability at runtime.
 */
export interface RelicMetadata {
  /** Canonical identifier of the relic */
  name: CanonicalId;
  /** Human-readable label used in diagnostics */
  label: string;
  /** Lifecycle strategy used by the vault */
  lifecycle: LifecycleType;
}

/**
 * Immutable relic definition captured during decorator evaluation.
 *
 * These definitions are consumed by the vault when registering decorated
 * classes.
 */
export interface StaticRelicDefinition {
  /** Decorated constructor */
  readonly ctor: Constructor;
  /** Frozen metadata associated with the constructor */
  readonly metadata: RelicMetadata;
  /**
   * Dependencies captured in parameter order.
   *
   * Undefined entries represent missing `@Summon()` decorators and will trigger
   * runtime errors if not corrected before resolution.
   */
  readonly dependencies: readonly (CanonicalId | undefined)[];
}

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
};

export type ShadowPolicy = 'error' | 'allow' | 'warn';

/**
 * Provider union accepted by the vault.
 */
export type Provider = ClassProvider | ValueProvider | FactoryProvider;

/**
 * Decorated vault class with embedded configuration.
 *
 * This interface represents vault classes decorated with @Vault() that
 * have configuration metadata attached via the __vaultCfg__ property.
 */
export interface DecoratedVaultClass extends Constructor<Vault> {
  __vaultCfg__: VaultConfig;
}

/**
 * Vault configuration passed to the constructor.
 */
export interface VaultConfig {
  /**
   * Relics to register in this vault.
   *
   * Can be:
   * - Class constructor decorated with @Relic()
   * - Provider object (useClass, useValue, useFactory)
   */
  relics?: Array<Constructor | Provider>;

  /**
   * Vaults to fuse (import revealed relics from).
   *
   * Only relics in the `reveal` list of fused vaults are accessible.
   */
  fuse?: (Constructor | Vault)[];

  /**
   * Relics to reveal to other vaults.
   *
   * Only revealed relics can be resolved by vaults that fuse to this one.
   * If not specified, no relics are revealed (all private).
   */
  reveal?: Array<InjectionToken>;

  /**
   * Optional name for debugging and error messages.
   */
  name?: string;

  /**
   * Enable transitive accessibility for all relics in this vault.
   *
   * When true, all relics in this vault can be resolved by ANY descendant vault
   * in the fusion tree, bypassing normal exposure rules. This provides
   * transitive accessibility through the entire hierarchy.
   *
   * @default false
   */
  aether?: boolean;

  /**
   * Policy for handling shadowed relic registrations.
   * - 'error' (default): throw an error when a relic registration shadows
   *   an existing token in the same vault.
   * - 'allow': permit shadowing; the local registration takes precedence.
   *
   * @default 'error'
   */
  shadowPolicy?: ShadowPolicy;

  /**
   * Maximum number of entries retained in the hot-path MRU cache.
   *
   * Increasing this can improve cache hit rates for highly dynamic workloads
   * at the cost of additional memory.
   *
   * @default 8
   */
  mruSize?: number;

  /**
   * Optional hook invoked after a relic is instantiated.
   *
   * Receives the canonical token string and the instantiation duration in
   * nanoseconds. Useful for profiling or custom telemetry.
   */
  onInstantiate?: (token: string, durationNs: number) => void;

  /**
   * Internal lazy fusion resolver function.
   *
   * @internal - Not part of public API. Used by Genesis framework to resolve
   * lazy vault class references during fusion. If omitted, Vault will call the
   * resolver installed via Vault.setDefaultLazyResolver().
   */
  lazyResolve?: (ctor: Constructor) => Vault;
}

export interface Disposable {
  dispose: () => void;
  close: () => void;
}
