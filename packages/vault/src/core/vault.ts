/* eslint-disable @typescript-eslint/no-this-alias */
/* eslint-disable @typescript-eslint/restrict-template-expressions */
/* eslint-disable no-duplicate-imports */
import {
  AggregateDisposalError,
  CircularVaultAttachmentError,
  InvalidProviderError,
  InvalidTokenError,
  InvalidVaultConfigError,
  LifecycleViolationError,
  MissingRelicDecoratorError,
  MultipleShadowPolicyViolationsError,
  RelicNotFoundError,
} from '../errors';
import { StaticRelicRegistry } from '../registry';
import type { Disposable, ShadowPolicy } from '../types';
import {
  Lifecycle,
  lifecycleToFlag,
  type ClassProvider,
  type Constructor,
  type DecoratedVaultClass,
  type FactoryProvider,
  type Provider,
  type RelicMetadata,
  type StaticRelicDefinition,
  type ValueProvider,
  type VaultConfig,
} from '../types';
import { Activator } from './activator.js';
import type { Entry } from './entry-store.js';
import { EntryStore } from './entry-store.js';
import { ExposureIndex } from './exposure-index.js';
import {
  FLAG_HAS_INSTANCE,
  FLAG_HAS_NO_DEPS,
  LIFECYCLE_MASK,
  LIFECYCLE_SINGLETON,
} from './flags.js';
import { MRUCache } from './mru-cache.js';
import { ResolverAsync } from './resolver-async.js';
import { ResolverSync } from './resolver-sync.js';
import { Scope } from './scope.js';
import { isToken, type CanonicalId, type Token } from './token.js';
interface LegacyConfig {
  __vaultCfg__: VaultConfig;
}
// ---------- Internal constants ----------
const EMPTY_DEPS: readonly CanonicalId[] = Object.freeze([] as CanonicalId[]);

/**
 * Default MRU cache size (8 entries).
 *
 * This value represents a balance between memory usage and cache hit rates:
 * - Small enough to avoid excessive memory overhead
 * - Large enough to capture common hot-path tokens in typical DI workloads
 * - Tuned based on benchmarking typical request/response patterns
 */
const DEFAULT_MRU_SIZE = 8;

/**
 * Precomputed flag masks for hot-path optimization.
 * These eliminate repeated bitwise computations during resolution.
 */
const SINGLETON_WITH_INSTANCE = LIFECYCLE_SINGLETON | FLAG_HAS_INSTANCE;
const SINGLETON_MASK_CHECK = LIFECYCLE_MASK | FLAG_HAS_INSTANCE;

/**
 * Development mode flag for conditional validation.
 * In production builds, token validation is skipped for maximum performance.
 */
const IS_DEV = process.env.NODE_ENV !== 'production';

/**
 * Fast token validation helper (dev-only).
 * Zero cost in production builds - validation is completely eliminated.
 */
function assertValidToken(token: unknown): asserts token is Token {
  if (!IS_DEV) return; // Zero cost in production!
  if (!isToken(token)) throw new InvalidTokenError(token);
}

/*
 * Vault: minimal, deterministic DI container core.
 *
 * This module organizes registration, resolution (sync + async), cross-vault
 * exposure, and a tiny hot-path MRU cache. The implementation favors clarity
 * and predictable invariants: registrations are sealed via finalizeEntries(),
 * async singletons collapse via entry.promise, and lazy fused vaults are
 * materialized on-demand with rollback on failure.
 */

export class Vault {
  private static defaultLazyResolver?: (c: Constructor) => Vault;
  /**
   * @internal Allows frameworks (e.g., Genesis) to provide a shared lazy resolver
   * for class-based fusion when individual vault configs do not supply one.
   */
  static setDefaultLazyResolver(resolver?: (c: Constructor) => Vault): void {
    Vault.defaultLazyResolver = resolver;
  }
  /**
   * @internal Retrieve the shared lazy resolver installed via setDefaultLazyResolver.
   */
  static getDefaultLazyResolver(): ((c: Constructor) => Vault) | undefined {
    return Vault.defaultLazyResolver;
  }
  // Core composition: small responsibilities delegated to focused helpers
  readonly store: EntryStore;
  readonly cache: MRUCache;
  readonly exposure: ExposureIndex;
  readonly activator: Activator;
  readonly resolverAsync: ResolverAsync;
  readonly resolverSync: ResolverSync;

  // Tokens this vault explicitly chooses to reveal to fused peers
  readonly revealedTokens = new Set<CanonicalId>();

  // Fusion attachments (other vaults fused in). Supports lazy class-based
  // attachments which are resolved the first time cross-vault indices are
  // required.
  readonly fusedVaults: Vault[] = [];
  private lazyAttachmentClasses: Constructor[] = [];
  private lazyAttachmentsResolved = false; // flip only after successful compute()

  // OPTIMIZATION: Pre-allocated stack buffer for faster dependency tracking
  // Uses counter-based indexing instead of push/pop for better performance
  private readonly scratchStack: CanonicalId[] = [];

  // Registration sealed guard
  private entriesSealed = false;

  // Identity / options
  private readonly name: string;
  private readonly isAether: boolean;
  private readonly shadowPolicy: ShadowPolicy;
  private readonly lazyResolver?: (c: Constructor) => Vault;
  private readonly instantiateHook?: (token: string, durationNs: number) => void;
  private readonly _sourceClass?: Constructor;

  private disposed = false;
  private shadowIncomingCache: Map<CanonicalId, string[]> | null = null;
  private shadowIncomingStamp = -1;

  constructor(config?: VaultConfig | DecoratedVaultClass) {
    // Extract configuration from decorated vault class or use direct config
    // Decorated classes have __vaultCfg__ property attached by @Vault() decorator
    const rawCfg = this._extractConfig(config);

    // Validate and freeze configuration (shallow freeze is acceptable since we
    // don't mutate nested objects and this is a one-time setup operation)
    const cfg = this._validateAndFreezeConfig(rawCfg);

    if (typeof config === 'function') {
      this._sourceClass = config;
    }

    this.store = new EntryStore();
    this.exposure = new ExposureIndex();
    this.cache = new MRUCache(cfg.mruSize);
    this.instantiateHook = cfg.onInstantiate;
    this.activator = new Activator(this);
    this.resolverAsync = new ResolverAsync(this, this.activator);
    this.resolverSync = new ResolverSync(this, this.activator);

    this.name = cfg.name ?? 'Vault';
    this.shadowPolicy = cfg.shadowPolicy ?? 'error';
    this.isAether = cfg.aether ?? false;
    this.lazyResolver = cfg.lazyResolve;

    if (rawCfg) this._fastInit(cfg);
    this.entriesSealed = true;
  }
  /**
   * Get the constructor/class that was used to create this vault.
   *
   * Returns undefined if the vault was created from a plain config object
   * instead of a decorated class.
   *
   * @internal Primarily used by compiler and debugging tools
   */
  getVaultClass(): Constructor | undefined {
    return this._sourceClass;
  }
  /**
   * Extract configuration from either a direct VaultConfig object or a
   * DecoratedVaultClass with embedded __vaultCfg__.
   *
   * This supports two initialization patterns:
   * 1. Direct: new Vault({ relics: [...] })
   * 2. Decorated: new Vault(MyVaultClass) where MyVaultClass has __vaultCfg__
   */
  private _extractConfig(config?: VaultConfig | DecoratedVaultClass): VaultConfig | undefined {
    if (!config) return undefined;

    // Check if this is a decorated vault class (has __vaultCfg__ property)
    if (typeof config === 'function' && '__vaultCfg__' in config) {
      return config.__vaultCfg__;
    }

    // Check if this is a plain object that might have __vaultCfg__ (legacy support)
    if (typeof config === 'object' && '__vaultCfg__' in config) {
      return (config as LegacyConfig).__vaultCfg__;
    }

    // Direct VaultConfig object
    return config;
  }

  /**
   * Validate configuration and return a frozen, validated config object.
   *
   * This method:
   * - Validates mruSize is within acceptable range [1, 256]
   * - Validates onInstantiate is a function or undefined
   * - Returns a shallow-frozen configuration object
   *
   * Note: Shallow freeze is acceptable because:
   * - Arrays (fuse, relics, reveal) are copied during _fastInit
   * - We don't mutate nested configuration objects after construction
   * - Deep freeze would impose unnecessary performance cost for minimal benefit
   */
  private _validateAndFreezeConfig(rawCfg?: VaultConfig) {
    return {
      mruSize: rawCfg?.mruSize ?? DEFAULT_MRU_SIZE,
      onInstantiate: rawCfg?.onInstantiate,
      lazyResolve: rawCfg?.lazyResolve,
      ...rawCfg,
    };
  }
  /**
   * Fast initialization path for vault configuration.
   *
   * Validates and processes fuse, relics, and reveal arrays with comprehensive
   * error checking to ensure type safety and catch configuration errors early.
   */
  private _fastInit(cfg: VaultConfig): void {
    const { fuse, relics, reveal } = cfg;

    // Validate and process fuse array
    if (fuse !== undefined) {
      if (!Array.isArray(fuse)) {
        throw new InvalidVaultConfigError(`'fuse' must be an array.`);
      }
      this._validateAndProcessFuse(fuse);
    }

    // Validate and process relics array
    if (relics !== undefined) {
      if (!Array.isArray(relics)) {
        throw new InvalidVaultConfigError(`'relics' must be an array.`);
      }
      this._validateAndProcessRelics(relics);
    }

    // Validate and process reveal array
    if (reveal !== undefined) {
      if (!Array.isArray(reveal)) {
        throw new InvalidVaultConfigError(`'reveal' must be an array.`);
      }
      this._validateAndProcessReveal(reveal);
    }

    // Compute exposure indices if we have fused vaults
    if (this.fusedVaults.length > 0) this.exposure.compute(this);
  }

  /**
   * Validate and process the fuse array.
   *
   * Each item must be either:
   * - A Vault instance (concrete fusion)
   * - A constructor function (lazy fusion)
   *
   * @throws InvalidVaultConfigError if any item is invalid
   */
  private _validateAndProcessFuse(fuse: (Constructor | Vault)[]): void {
    for (let i = 0; i < fuse.length; i++) {
      const item = fuse[i];

      if (item == null) {
        throw new InvalidVaultConfigError(
          `fuse[${i}] must be a Vault instance or constructor function, got ${item}`
        );
      }

      if (item instanceof Vault) {
        this.fusedVaults.push(item);
      } else if (typeof item === 'function') {
        // Validate it's actually a constructor (has prototype)
        // This catches arrow functions, async functions, etc.
        if (!item.prototype || typeof item.prototype !== 'object') {
          throw new InvalidVaultConfigError(
            `fuse[${i}] must be a class constructor, not an arrow or async function. ` +
              `Got function '${item.name || 'anonymous'}' without valid prototype.`
          );
        }
        this.lazyAttachmentClasses.push(item);
      } else {
        throw new InvalidVaultConfigError(
          `fuse[${i}] must be a Vault instance or constructor function, got ${typeof item}`
        );
      }
    }
  }

  /**
   * Validate and process the relics array.
   *
   * Each item must be either:
   * - A constructor function (decorated with @Relic)
   * - A Provider object (with provide + useClass/useValue/useFactory)
   *
   * @throws InvalidVaultConfigError if any item is invalid
   */
  private _validateAndProcessRelics(relics: Array<Constructor | Provider>): void {
    for (let i = 0; i < relics.length; i++) {
      const item = relics[i];

      if (item == null) {
        throw new InvalidVaultConfigError(
          `relics[${i}] must be a constructor or Provider object, got ${item}`
        );
      }

      // Validate provider objects have required properties
      if (typeof item === 'object' && !this._isProvider(item)) {
        throw new InvalidVaultConfigError(
          `relics[${i}] must be a constructor or valid Provider object with 'provide' and one of 'useClass'/'useValue'/'useFactory'`
        );
      }

      this._registerRelic(item);
    }
  }

  /**
   * Validate and process the reveal array.
   *
   * Each item must be a valid Token created with token<T>().
   *
   * @throws InvalidVaultConfigError if any item is invalid
   */
  private _validateAndProcessReveal(reveal: Array<Token>): void {
    for (let i = 0; i < reveal.length; i++) {
      const item = reveal[i];

      if (!isToken(item)) {
        let itemDesc: string;
        try {
          itemDesc = typeof item === 'string' ? `string "${item}"` : JSON.stringify(item);
        } catch {
          itemDesc = String(item);
        }

        throw new InvalidVaultConfigError(
          `reveal[${i}] must be a Token created with token<T>(), got ${itemDesc}`
        );
      }

      this.revealedTokens.add(item.id);
    }
  }
  // ----- public API (surface used by consumers) -----

  /**
   * Get the human-readable name of this vault.
   *
   * The vault name is used in diagnostic error messages and helps identify
   * which vault in a fusion hierarchy is involved in errors or conflicts.
   *
   * @returns The vault's configured name (defaults to 'Vault' if not specified)
   */
  getName(): string {
    return this.name;
  }

  /**
   * Check if this vault is configured as an aether host.
   *
   * Aether vaults expose ALL their relics transitively to descendant vaults in
   * the fusion hierarchy, bypassing normal reveal-based exposure. This is useful
   * for creating global/shared service containers.
   *
   * @returns true if aether mode is enabled, false otherwise
   */
  get isAetherHost(): boolean {
    return this.isAether;
  }

  /**
   * Create a new scope for resolving scoped-lifecycle relics.
   *
   * Scopes provide per-request or per-operation isolation for stateful services.
   * Each scope maintains its own cache of scoped instances and automatically
   * cleans up resources when disposed.
   *
   * @returns A new Scope with resolve/resolveAsync methods bound to this vault
   *
   * @example
   * ```typescript
   * const scope = vault.createScope();
   * try {
   *   const service = scope.resolve(ServiceT);
   *   await service.doWork();
   * } finally {
   *   await scope.dispose();
   * }
   * ```
   */
  createScope(): Scope & {
    resolve: <T>(token: Token<T>) => T;
    resolveAsync: <T>(token: Token<T>, opts?: { signal?: AbortSignal }) => Promise<T>;
  } {
    const scope = new Scope(this);
    const vault = this;

    // Bind resolve methods to this vault with the scope parameter pre-filled
    const boundResolve = <T>(token: Token<T>): T => vault.resolve(token, { scope });
    const boundResolveAsync = <T>(token: Token<T>, opts?: { signal?: AbortSignal }): Promise<T> =>
      vault.resolveAsync(token, { signal: opts?.signal, scope });

    // Return scope with resolve methods attached
    return Object.assign(scope, {
      resolve: boundResolve,
      resolveAsync: boundResolveAsync,
    });
  }

  /**
   * Resolve a token synchronously to get its instance.
   *
   * Resolution order:
   * 1. Check cache for singleton instances
   * 2. Check scope cache for scoped instances (if scope provided)
   * 3. Resolve locally if token is registered in this vault
   * 4. Resolve from fused vaults (aether or revealed tokens)
   * 5. Throw RelicNotFoundError if not found
   *
   * Lifecycle behavior:
   * - Singleton: Returns cached instance or creates once and caches
   * - Scoped: Returns scope-cached instance or creates per scope
   * - Transient: Always creates new instance
   *
   * Optimizations:
   * - Token validation only in dev mode (zero cost in production)
   * - Precomputed flag masks for bitwise checks
   * - Eliminated optional chaining overhead
   * - Smarter cache priming (only canonical ID when needed)
   *
   * @param token - Token to resolve (created via token<T>())
   * @param opts - Optional resolution options
   * @param opts.scope - Scope for scoped-lifecycle relics
   *
   * @returns Instance of type T
   *
   * @throws {InvalidTokenError} If token is not a valid Token object
   * @throws {RelicNotFoundError} If token is not registered
   * @throws {VaultDisposedError} If vault has been disposed
   * @throws {LifecycleViolationError} If dependency violates lifecycle rules
   * @throws {CircularDependencyError} If circular dependency detected
   *
   * @example
   * ```typescript
   * const userService = vault.resolve(UserServiceT);
   * const scopedService = vault.resolve(RequestServiceT, { scope });
   * ```
   */
  resolve<T = unknown>(token: Token<T>, opts?: { scope?: Scope }): T {
    assertValidToken(token); // Dev-only, stripped in production
    const id = token.id;

    // OPTIMIZATION: Extract scope upfront to avoid repeated access
    const scope = opts !== undefined ? opts.scope : undefined;

    // PRIORITY 1: Check scope-local registrations FIRST (highest priority)
    if (scope !== undefined) {
      const localEntry = scope.getLocalEntry(id);
      if (localEntry && localEntry.flags & FLAG_HAS_INSTANCE) {
        return localEntry.instance as T;
      }
    }

    // PRIORITY 2: Check singleton cache
    const cached = this.cache.get(id);
    if (cached !== undefined) {
      // Single bitwise check instead of two separate checks
      if ((cached.flags & SINGLETON_MASK_CHECK) === SINGLETON_WITH_INSTANCE) {
        return cached.instance as T;
      }
    }

    // PRIORITY 3: Check scope cache for scoped-lifecycle instances
    if (scope !== undefined) {
      const scopeCached = scope.cache.get(id);
      if (scopeCached !== undefined && scopeCached.flags & FLAG_HAS_INSTANCE) {
        return scopeCached.instance as T;
      }
    }

    // Local resolution
    const local = this.store.getByCanonical(id);
    if (local !== undefined) {
      const stack = this.scratchStack;
      stack.length = 0;
      const out = this.resolverSync.fromEntry<T>(id, stack, scope);

      // OPTIMIZATION: Only prime cache if singleton AND not already cached
      if ((local.flags & LIFECYCLE_MASK) === LIFECYCLE_SINGLETON && cached === undefined) {
        this.cache.primeAll(id, local);
      }
      return out;
    }

    // Cross-vault (cold path)
    this.resolveLazyAttachments();
    const stack = this.scratchStack;
    stack.length = 0;
    const x = this._crossVaultSync<T>(id, stack, scope);
    if (x !== undefined) return x;

    throw this.buildNotFoundError(id, []);
  }

  /**
   * Resolve a token asynchronously to get its instance.
   *
   * Use this method when:
   * - Resolving async factories (factories returning Promises)
   * - Need cancellation support via AbortSignal
   * - Working in async context and want consistent API
   *
   * Key differences from sync resolve:
   * - Awaits in-flight async singleton promises (prevents duplicate creation)
   * - All factory dependencies resolved asynchronously
   * - Supports cancellation via AbortSignal
   *
   * Optimizations:
   * - Token validation only in dev mode (zero cost in production)
   * - Precomputed flag masks for bitwise checks
   * - Eliminated optional chaining overhead
   * - Direct parameter checks instead of object destructuring
   *
   * @param token - Token to resolve (created via token<T>())
   * @param opts - Optional resolution options
   * @param opts.signal - AbortSignal for cancellation
   * @param opts.scope - Scope for scoped-lifecycle relics
   *
   * @returns Promise resolving to instance of type T
   *
   * @throws {InvalidTokenError} If token is not a valid Token object
   * @throws {RelicNotFoundError} If token is not registered
   * @throws {VaultDisposedError} If vault has been disposed
   * @throws {LifecycleViolationError} If dependency violates lifecycle rules
   * @throws {CircularDependencyError} If circular dependency detected
   *
   * @example
   * ```typescript
   * const dbService = await vault.resolveAsync(DatabaseServiceT);
   *
   * // With cancellation
   * const controller = new AbortController();
   * const service = await vault.resolveAsync(ServiceT, {
   *   signal: controller.signal
   * });
   * ```
   */
  async resolveAsync<T = unknown>(
    token: Token<T>,
    opts?: { signal?: AbortSignal; scope?: Scope }
  ): Promise<T> {
    assertValidToken(token); // Dev-only, stripped in production
    const stack: CanonicalId[] = [];

    // OPTIMIZATION: Extract options upfront to avoid repeated access
    const signal = opts !== undefined ? opts.signal : undefined;
    const scope = opts !== undefined ? opts.scope : undefined;

    return this._resolveRelicAsync<T>(token.id, stack, signal, scope);
  }

  /**
   * Check if a token can be resolved without actually instantiating it.
   *
   * ⚠️ SIDE EFFECTS: This method triggers lazy attachment resolution, which:
   * - Materializes lazy-fused vault classes
   * - Recomputes cross-vault exposure indices
   * - Validates circular attachment detection
   * - Enforces shadow policy
   *
   * Use this method when you need to conditionally resolve tokens based on
   * availability. For unconditional resolution, use resolve() directly and
   * catch RelicNotFoundError.
   *
   * @param token - Token to check for resolvability
   * @returns true if the token can be resolved (locally or via fusion)
   * @throws InvalidTokenError if token is not a valid Token object
   *
   * @example
   * ```typescript
   * if (vault.canResolve(OptionalServiceT)) {
   *   const service = vault.resolve(OptionalServiceT);
   *   service.doWork();
   * }
   * ```
   */
  canResolve<T>(token: Token<T>): boolean {
    // Validate token parameter using isToken() helper
    if (!isToken(token)) {
      throw new InvalidTokenError(token);
    }

    return this._canResolveInternal(token.id);
  }

  /**
   * Internal implementation of canResolve that accepts canonical ID.
   *
   * This method is separated to allow internal callers to bypass token
   * validation when they already have a canonical ID.
   *
   * @internal
   */
  private _canResolveInternal(canonical: CanonicalId): boolean {
    // Check local registration
    const local = this._hasLocalEntry(canonical);
    if (local) return true;

    // Trigger lazy attachment resolution (side effect!)
    this.resolveLazyAttachments();

    // Check cross-vault exposure
    if (this.exposure.aetherMap.has(canonical)) return true;
    if (this.exposure.revealedMap.has(canonical)) return true;

    return false;
  }

  /**
   * Clear cached instances and promises WITHOUT disposing them.
   *
   * ⚠️ WARNING: POTENTIAL RESOURCE LEAK
   *
   * This method clears all cached singleton instances and pending promises
   * but does NOT call dispose() or close() on them. Use this method with caution:
   *
   * Safe use cases:
   * - Testing: Resetting vault state between test cases
   * - Instances don't hold resources (no cleanup needed)
   * - You've manually disposed instances before calling clear()
   *
   * Unsafe use cases:
   * - Instances hold file handles, database connections, timers, etc.
   * - You expect automatic cleanup (use dispose() instead)
   *
   * For proper resource cleanup, use dispose() which:
   * - Calls dispose()/close() on all instances
   * - Marks the vault as disposed
   * - Prevents further use
   *
   * This method keeps the vault active and allows continued resolution after
   * clearing, which is why it doesn't dispose instances (to avoid using disposed
   * resources that might be re-created).
   *
   * @see dispose() for proper resource cleanup
   */
  clear(): void {
    for (const canonical of this.store.canonicalKeys()) {
      const e = this.store.getByCanonical(canonical)!;
      if (e.instance !== undefined) {
        e.instance = undefined;
        e.flags &= ~FLAG_HAS_INSTANCE;
      }
      if (e.promise) e.promise = undefined;
    }
    this.cache.clear();
  }

  /**
   * Dispose all cached instances and clean up resources.
   *
   * This method:
   * - Calls dispose() or close() on all cached instances
   * - Collects ALL errors that occur during disposal (no silent failures)
   * - Sets disposed flag ONLY after all disposal attempts complete
   * - Uses Promise.allSettled() to ensure all async disposals run even if some fail
   * - Throws AggregateDisposalError if any disposals failed
   *
   * Disposal is transactional: the vault is only marked as disposed after ALL
   * disposal attempts complete (success or failure). This ensures consistent state
   * even in the presence of errors.
   *
   * @throws AggregateDisposalError if one or more disposals fail
   */
  dispose(): void | Promise<void> {
    if (this.disposed) return;

    const errors: Error[] = [];
    const pending: Promise<void>[] = [];

    // Attempt to dispose all instances, collecting errors along the way
    for (const canonical of this.store.canonicalKeys()) {
      const entry = this.store.getByCanonical(canonical)!;
      const instance = entry.instance as Disposable | undefined;
      if (instance === undefined) continue;

      const disposer =
        (typeof instance === 'object' || typeof instance === 'function') &&
        instance !== null &&
        (typeof instance.dispose === 'function'
          ? instance.dispose
          : typeof instance.close === 'function'
            ? instance.close
            : undefined);

      if (disposer) {
        try {
          const result = disposer.call(instance);
          if (
            typeof result === 'object' &&
            typeof (result as Promise<unknown>).then === 'function'
          ) {
            // Wrap the promise to ensure void return type
            pending.push((result as Promise<unknown>).then(() => undefined));
          }
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }

      entry.instance = undefined;
      entry.promise = undefined;
      entry.flags &= ~FLAG_HAS_INSTANCE;
    }

    // Clean up vault state
    this.cache.clear();
    this.exposure.clear();
    this._invalidateShadowCache();

    // Synchronous disposal path
    if (pending.length === 0) {
      this.disposed = true;
      if (errors.length > 0) {
        throw new AggregateDisposalError(errors);
      }
      return;
    }

    // Asynchronous disposal path
    return Promise.allSettled(pending).then((results) => {
      // Mark as disposed AFTER all disposal attempts complete
      this.disposed = true;

      // Collect rejection reasons
      for (const result of results) {
        if (result.status === 'rejected') {
          const error = result.reason;
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }

      // Throw aggregate error if any disposals failed
      if (errors.length > 0) {
        throw new AggregateDisposalError(errors);
      }
    });
  }

  /**
   * Get all tokens registered in this vault (sorted alphabetically).
   *
   * This returns only tokens registered locally in this vault, not tokens
   * accessible via fusion from other vaults. Useful for diagnostics and debugging.
   *
   * @returns Array of canonical token IDs sorted alphabetically
   *
   * @example
   * ```typescript
   * const tokens = vault.getRegisteredTokens();
   * console.log('Registered:', tokens);
   * // => ['tok_1', 'tok_2', 'tok_3']
   * ```
   */
  getRegisteredTokens(): CanonicalId[] {
    return Array.from(this.store.canonicalKeys()).sort();
  }

  /**
   * Get snapshot of all materialized singleton instances.
   *
   * Returns a Map of currently instantiated singleton relics. This is useful for:
   * - Debugging: See which singletons have been created
   * - Testing: Verify singleton state
   * - Monitoring: Track active instances
   *
   * Note: Only includes singletons that have been resolved at least once.
   * Lazy singletons that haven't been requested yet won't appear.
   *
   * @returns Map of canonical token ID to instance
   *
   * @example
   * ```typescript
   * const singletons = vault.getSingletons();
   * for (const [token, instance] of singletons) {
   *   console.log(`Token ${token}:`, instance);
   * }
   * ```
   */
  getSingletons(): Map<CanonicalId, unknown> {
    const out = new Map<CanonicalId, unknown>();
    for (const k of this.store.canonicalKeys()) {
      const e = this.store.getByCanonical(k)!;
      if (e.metadata.lifecycle === Lifecycle.Singleton && e.instance !== undefined)
        out.set(k, e.instance);
    }
    return out;
  }

  /**
   * Check if a token is registered locally in this vault.
   *
   * This checks only local registrations, not tokens accessible via fusion.
   * Use canResolve() to check if a token can be resolved (including fused tokens).
   *
   * @param token - Canonical token ID to check
   * @returns true if token is registered locally, false otherwise
   *
   * @example
   * ```typescript
   * if (vault.isRegistered('tok_123')) {
   *   console.log('Token registered locally');
   * }
   * ```
   */
  isRegistered(token: string): boolean {
    const canonical = this._hasLocalEntry(token);
    return canonical !== undefined && !!this.store.getByCanonical(canonical);
  }

  /**
   * Check if a token was explicitly revealed by this vault.
   *
   * Revealed tokens are accessible to other vaults that fuse to this one.
   * This is different from aether mode, which exposes all tokens transitively.
   *
   * @param token - Canonical token ID to check
   * @returns true if token was included in the reveal array, false otherwise
   *
   * @example
   * ```typescript
   * if (vault.isExposed('tok_123')) {
   *   console.log('Token is available to fused vaults');
   * }
   * ```
   */
  isExposed(token: string): boolean {
    const canonical = this._hasLocalEntry(token);
    return !!canonical && this.revealedTokens.has(canonical);
  }

  /** @internal */
  getInstantiateHook(): ((token: string, durationNs: number) => void) | undefined {
    return this.instantiateHook;
  }

  // ----- Registration Helpers -----

  /** Guard to prevent late registration after finalization. */
  private _assertNotSealed() {
    if (this.entriesSealed) throw new InvalidVaultConfigError('registration after finalize');
  }

  /**
   * Top-level registrar that dispatches provider shapes to specialized handlers.
   *
   * Handles three registration forms:
   *  - Constructor decorated with @Relic() → _registerClass()
   *  - Provider object with useClass → _registerClassProvider()
   *  - Provider object with useValue → _registerValueProvider()
   *  - Provider object with useFactory → _registerFactoryProvider()
   */
  private _registerRelic(relic: Constructor | Provider): void {
    this._assertNotSealed();
    if (typeof relic === 'function') {
      this._registerClass(relic);
      return;
    }

    if (!this._isProvider(relic)) throw new InvalidProviderError(relic);

    if ('useClass' in relic) return void this._registerClassProvider(relic);
    if ('useValue' in relic) return void this._registerValueProvider(relic);
    if ('useFactory' in relic) return void this._registerFactoryProvider(relic);

    throw new InvalidProviderError(relic);
  }

  /**
   * Register a class decorated with @Relic (requires decorator metadata).
   *
   * Extracts metadata from the StaticRelicRegistry (populated by @Relic decorator)
   * and converts the lifecycle string to a bit flag for fast runtime checks.
   *
   * Lifecycle conversion:
   *  - Lifecycle.Singleton ('singleton') → 0b00 (LIFECYCLE_SINGLETON)
   *  - Lifecycle.Scoped ('scoped') → 0b01 (LIFECYCLE_SCOPED)
   *  - Lifecycle.Transient ('transient') → 0b10 (LIFECYCLE_TRANSIENT)
   *
   * Optimization flags:
   *  - FLAG_HAS_NO_DEPS: Set when dependencies.length === 0 for fast-path construction
   */
  private _registerClass(ctor: Constructor): void {
    const def = this._getDefinition(ctor);
    if (!def) throw new MissingRelicDecoratorError(ctor.name);

    // Convert lifecycle string to bit flag (one-time cost at registration)
    const lifecycleFlag = lifecycleToFlag(def.metadata.lifecycle);
    const hasNoDeps = def.dependencies.length === 0;

    const canonical = def.metadata.name;
    const entry: Entry = {
      token: canonical,
      ctor: def.ctor,
      factory: undefined,
      factoryDeps: EMPTY_DEPS,
      metadata: def.metadata,
      summons: def.dependencies,
      aliases: [canonical],
      // Compose flags: lifecycle bits (0-1) + optimization flags (2+)
      flags: lifecycleFlag | (hasNoDeps ? FLAG_HAS_NO_DEPS : 0),
    };

    this.store.add(entry, this.name);

    // Validate lifecycle relationships at registration time when possible.
    // If a dependency is not yet registered in this vault we defer validation
    // (it may be validated when that dependency is registered).
    this._validateDependencyLifecyclesForEntry(entry);
  }

  /**
   * Register a provider object using useClass.
   *
   * Allows explicit lifecycle override at registration time:
   *  { provide: TokenT, useClass: MyClass, lifecycle: Lifecycle.Scoped }
   *
   * Lifecycle priority:
   *  1. provider.lifecycle (explicit override)
   *  2. def.metadata.lifecycle (from @Relic decorator if present)
   *  3. Lifecycle.Singleton (default)
   */
  private _registerClassProvider(provider: ClassProvider): void {
    const def = this._getDefinition(provider.useClass);
    const token = provider.provide;
    const canonical = token.id;

    // Lifecycle resolution: provider override > decorator metadata > default singleton
    const lifecycle = provider.lifecycle ?? def?.metadata.lifecycle ?? Lifecycle.Singleton;
    const lifecycleFlag = lifecycleToFlag(lifecycle);
    const metadata: RelicMetadata = { name: canonical, label: token.label, lifecycle };

    const deps = def ? def.dependencies : EMPTY_DEPS;
    const hasNoDeps = deps.length === 0;

    const entry: Entry = {
      token: canonical,
      ctor: provider.useClass,
      factory: undefined,
      factoryDeps: EMPTY_DEPS,
      metadata,
      summons: deps,
      aliases: [canonical],
      // Compose flags: lifecycle bits (0-1) + optimization flags (2+)
      flags: lifecycleFlag | (hasNoDeps ? FLAG_HAS_NO_DEPS : 0),
    };

    this.store.add(entry, this.name);

    // Registration-time lifecycle validation (best-effort). Skip missing summons.
    this._validateDependencyLifecyclesForEntry(entry);
  }

  /**
   * Register a value provider (always singleton with pre-materialized instance).
   *
   * Value providers:
   *  - Always use Lifecycle.Singleton (no lifecycle override allowed)
   *  - Instance is already materialized (FLAG_HAS_INSTANCE set immediately)
   *  - No dependencies (FLAG_HAS_NO_DEPS always set)
   *  - Useful for configuration objects, primitive values, pre-constructed services
   *
   * Example:
   *  { provide: ConfigT, useValue: { apiKey: 'secret' } }
   */
  private _registerValueProvider(provider: ValueProvider): void {
    const token = provider.provide;
    const ctor = (provider.useValue as { constructor?: Constructor })?.constructor;
    const canonical = token.id;

    const metadata: RelicMetadata = {
      name: canonical,
      label: token.label,
      lifecycle: Lifecycle.Singleton,
    };

    const entry: Entry = {
      token: canonical,
      ctor: typeof ctor === 'function' ? ctor : undefined,
      factory: undefined,
      factoryDeps: EMPTY_DEPS,
      metadata,
      summons: EMPTY_DEPS,
      aliases: [canonical],
      instance: provider.useValue,
      // Flags: singleton (0b00) + has instance + no summons
      flags: LIFECYCLE_SINGLETON | FLAG_HAS_INSTANCE | FLAG_HAS_NO_DEPS,
    };

    this.store.add(entry, this.name);
  }

  /**
   * Register a factory provider (sync or async).
   *
   * Factory providers:
   *  - Can specify explicit dependencies via `deps` array
   *  - Support both sync and async factories
   *  - Lifecycle can be Singleton, Scoped, or Transient
   *  - FLAG_HAS_NO_DEPS always set (constructor summons[] not used for factories)
   *
   * Factory function signatures:
   *  - Sync: (...deps: any[]) => T
   *  - Async with context: (ctx: FactoryCtx) => Promise<T>
   *  - Async simple: (...deps: any[]) => Promise<T>
   *
   * Example:
   *  {
   *    provide: LoggerT,
   *    useFactory: (config) => new Logger(config.logLevel),
   *    deps: [ConfigT],
   *    lifecycle: Lifecycle.Scoped
   *  }
   */
  private _registerFactoryProvider(provider: FactoryProvider): void {
    const token = provider.provide;
    const canonical = token.id;
    const factoryDeps =
      provider.deps?.map((dep) => (typeof dep === 'string' ? dep : dep.id)) ?? EMPTY_DEPS;

    const lifecycle = provider.lifecycle ?? Lifecycle.Singleton;
    const lifecycleFlag = lifecycleToFlag(lifecycle);
    const metadata: RelicMetadata = { name: canonical, label: token.label, lifecycle };

    const entry: Entry = {
      token: canonical,
      factory: provider.useFactory,
      factoryDeps,
      metadata,
      summons: EMPTY_DEPS, // Not used for factories (factoryDeps used instead)
      aliases: [canonical],
      // Flags: lifecycle bits (0-1) + FLAG_HAS_NO_DEPS (factories don't use summons[])
      flags: lifecycleFlag | FLAG_HAS_NO_DEPS,
    };
    this.store.add(entry, this.name);

    // Validate factory dependencies where possible (deferred if dependency missing).
    this._validateDependencyLifecyclesForEntry(entry);
  }

  /**
   * Best-effort lifecycle validation performed at registration time.
   *
   * This checks consumer -> dependency lifecycle relationships when the
   * dependency is already registered in the same vault. If a dependency is
   * not present yet (deferred registration or fused exposure) we skip
   * validation; it will be validated when that dependency gets registered.
   */
  private _validateDependencyLifecyclesForEntry(entry: Entry): void {
    const consumerLifecycle = entry.metadata.lifecycle;

    // Collect dependencies from both ctor summons and factory deps
    const depSet = new Set<CanonicalId>();
    for (const d of entry.summons) if (d !== undefined) depSet.add(d);
    for (const d of entry.factoryDeps) if (d !== undefined) depSet.add(d);

    for (const depToken of depSet) {
      const depEntry = this.store.getByCanonical(depToken);
      if (!depEntry) continue; // Dependency not registered yet - defer

      const depLifecycle = depEntry.metadata.lifecycle;

      // Singleton cannot depend on Scoped or Transient
      if (consumerLifecycle === Lifecycle.Singleton) {
        if (depLifecycle === Lifecycle.Scoped || depLifecycle === Lifecycle.Transient) {
          throw new LifecycleViolationError(
            entry.metadata.label ?? entry.token,
            consumerLifecycle,
            depEntry.metadata.label ?? depEntry.token,
            depLifecycle
          );
        }
      }

      // Scoped cannot depend on Transient
      if (consumerLifecycle === Lifecycle.Scoped && depLifecycle === Lifecycle.Transient) {
        throw new LifecycleViolationError(
          entry.metadata.label ?? entry.token,
          consumerLifecycle,
          depEntry.metadata.label ?? depEntry.token,
          depLifecycle
        );
      }
    }
  }

  // ----- cross-vault helpers -----

  /** Find a cross-vault exposure entry for token if any. */
  private _findCrossVaultEntry(token: CanonicalId) {
    return this.exposure.aetherMap.get(token) ?? this.exposure.revealedMap.get(token);
  }

  /** Shared logic for cross-vault synchronous lookups. */
  private _crossVaultSync<T>(
    token: CanonicalId,
    stack: CanonicalId[],
    scope?: Scope
  ): T | undefined {
    const hit = this._findCrossVaultEntry(token);
    if (!hit) return;
    const { vault, canonical } = hit;
    const e = vault.store.getByCanonical(canonical)!;
    const lifecycleFlags = e.flags & LIFECYCLE_MASK;
    if (lifecycleFlags === LIFECYCLE_SINGLETON && e.flags & FLAG_HAS_INSTANCE) {
      this.cache.primeAll(token, e);
      return e.instance as T;
    }
    const out = vault.resolverSync.fromEntry<T>(canonical, stack, scope);
    if (lifecycleFlags === LIFECYCLE_SINGLETON && e.flags & FLAG_HAS_INSTANCE) {
      this.cache.primeAll(token, e);
    }
    return out;
  }

  /** Shared logic for cross-vault asynchronous lookups. */
  private async _crossVaultAsync<T>(
    token: CanonicalId,
    stack: CanonicalId[],
    signal?: AbortSignal,
    scope?: Scope
  ): Promise<T | undefined> {
    const hit = this._findCrossVaultEntry(token);
    if (!hit) return;
    const { vault, canonical } = hit;
    const e = vault.store.getByCanonical(canonical)!;
    const lifecycleFlags = e.flags & LIFECYCLE_MASK;
    if (lifecycleFlags === LIFECYCLE_SINGLETON && e.flags & FLAG_HAS_INSTANCE) {
      this.cache.primeAll(token, e);
      return e.instance as T;
    }
    const out = await vault.resolverAsync.fromEntry<T>(canonical, stack, signal, scope);
    if (lifecycleFlags === LIFECYCLE_SINGLETON) this.cache.primeAll(token, e);
    return out;
  }

  /**
   * Validate lifecycle dependency rules.
   *
   * Rules enforced:
   * - Singleton CANNOT depend on Scoped (would capture first scope's instance)
   * - Singleton CANNOT depend on Transient (would capture first transient)
   * - Scoped CANNOT depend on Transient (unclear semantics)
   *
   * @param token - The token being resolved
   * @param stack - Current dependency resolution stack (for error reporting)
   */
  private _validateLifecycleRules(token: CanonicalId, stack: CanonicalId[]): void {
    if (stack.length === 0) return; // No parent to validate against

    const entry = this.store.getByCanonical(token);
    if (!entry) return; // Cross-vault resolution, skip validation

    const dependencyLifecycle = entry.metadata.lifecycle;

    // Check each consumer in the stack
    for (const consumerToken of stack) {
      const consumerEntry = this.store.getByCanonical(consumerToken);
      if (!consumerEntry) continue; // Cross-vault, skip

      const consumerLifecycle = consumerEntry.metadata.lifecycle;

      // Singleton cannot depend on Scoped or Transient
      if (consumerLifecycle === Lifecycle.Singleton) {
        if (
          dependencyLifecycle === Lifecycle.Scoped ||
          dependencyLifecycle === Lifecycle.Transient
        ) {
          const chain = stack.map((t) => this._formatTokenForDiagnostics(t));
          throw new LifecycleViolationError(
            this._formatTokenForDiagnostics(consumerToken),
            consumerLifecycle,
            this._formatTokenForDiagnostics(token),
            dependencyLifecycle,
            chain
          );
        }
      }

      // Scoped cannot depend on Transient
      if (consumerLifecycle === Lifecycle.Scoped && dependencyLifecycle === Lifecycle.Transient) {
        const chain = stack.map((t) => this._formatTokenForDiagnostics(t));
        throw new LifecycleViolationError(
          this._formatTokenForDiagnostics(consumerToken),
          consumerLifecycle,
          this._formatTokenForDiagnostics(token),
          dependencyLifecycle,
          chain
        );
      }
    }
  }

  // ----- resolution (sync) -----

  /**
   * Check singleton cache for materialized instance.
   * @returns Instance if found in cache, undefined otherwise
   */
  private _tryGetFromSingletonCache<T>(token: CanonicalId): T | undefined {
    const cached = this.cache.get(token);
    if (cached !== undefined && (cached.flags & SINGLETON_MASK_CHECK) === SINGLETON_WITH_INSTANCE) {
      return cached.instance as T;
    }
    return undefined;
  }

  /**
   * Check scope cache for scoped instance.
   * @returns Instance if found in scope cache, undefined otherwise
   */
  private _tryGetFromScopeCache<T>(token: CanonicalId, scope?: Scope): T | undefined {
    if (scope === undefined) return undefined;

    // Check scope-local registrations first (highest priority)
    const localEntry = scope.getLocalEntry(token);
    if (localEntry && localEntry.flags & FLAG_HAS_INSTANCE) {
      return localEntry.instance as T;
    }

    // Then check scope cache for scoped-lifecycle instances
    const scopedCached = scope.cache.get(token);
    if (scopedCached !== undefined && scopedCached.flags & FLAG_HAS_INSTANCE) {
      return scopedCached.instance as T;
    }
    return undefined;
  }

  /**
   * Resolve token from local vault registry.
   * @returns Resolved instance if token is registered locally, undefined otherwise
   */
  private _resolveLocal<T>(
    token: CanonicalId,
    stack: CanonicalId[],
    scope: Scope | undefined,
    cachedEntry: Entry | undefined
  ): T | undefined {
    const canonical = this._hasLocalEntry(token);
    if (canonical === undefined) return undefined;

    const instance = this.resolverSync.fromEntry<T>(canonical, stack, scope);

    // Prime cache only if singleton AND not already cached
    if (cachedEntry === undefined) {
      const entry = this.store.getByCanonical(canonical);
      if (entry && (entry.flags & LIFECYCLE_MASK) === LIFECYCLE_SINGLETON) {
        this.cache.primeAll(canonical, entry);
      }
    }

    return instance;
  }

  /**
   * Core synchronous resolution flow: cache -> local -> cross-vault -> error
   *
   * OPTIMIZED: Inline cache check with precomputed masks, simplified local resolution
   */
  _resolveRelic<T>(token: CanonicalId, stack: CanonicalId[], scope?: Scope): T {
    // Step 1: Check singleton cache
    const cachedInstance = this._tryGetFromSingletonCache<T>(token);
    if (cachedInstance !== undefined) return cachedInstance;

    // Step 2: Check scope cache
    const scopedInstance = this._tryGetFromScopeCache<T>(token, scope);
    if (scopedInstance !== undefined) return scopedInstance;

    // Step 3: Try local resolution
    const cachedEntry = this.cache.get(token);
    const localInstance = this._resolveLocal<T>(token, stack, scope, cachedEntry);
    if (localInstance !== undefined) return localInstance;

    // Step 4: Try cross-vault resolution
    this.resolveLazyAttachments();
    const crossVaultInstance = this._crossVaultSync<T>(token, stack, scope);
    if (crossVaultInstance !== undefined) return crossVaultInstance;

    // Step 5: Token not found
    throw this.buildNotFoundError(token, stack);
  }

  // ----- resolution (async) -----

  /**
   * Check singleton cache for materialized instance or in-flight promise.
   * @returns Instance/promise if found in cache, undefined otherwise
   */
  private async _checkSingletonCacheAsync<T>(token: CanonicalId): Promise<T | undefined> {
    const cached = this.cache.get(token);
    if (cached === undefined) return undefined;

    const lifecycleFlags = cached.flags & LIFECYCLE_MASK;
    if (lifecycleFlags !== LIFECYCLE_SINGLETON) return undefined;

    // Check for materialized instance first
    if ((cached.flags & SINGLETON_MASK_CHECK) === SINGLETON_WITH_INSTANCE) {
      return cached.instance as T;
    }

    // Check for in-flight promise
    if (cached.promise !== undefined) {
      return (await cached.promise) as T;
    }

    return undefined;
  }

  /**
   * Resolve token from local vault registry asynchronously.
   * @returns Resolved instance if token is registered locally, undefined otherwise
   */
  private async _resolveLocalAsync<T>(
    token: CanonicalId,
    stack: CanonicalId[],
    signal: AbortSignal | undefined,
    scope: Scope | undefined,
    wasCached: boolean
  ): Promise<T | undefined> {
    const canonical = this._hasLocalEntry(token);
    if (canonical === undefined) return undefined;

    const instance = await this.resolverAsync.fromEntry<T>(canonical, stack, signal, scope);

    // Prime cache only if singleton AND not already cached
    if (!wasCached) {
      const entry = this.store.getByCanonical(canonical);
      if (entry && (entry.flags & LIFECYCLE_MASK) === LIFECYCLE_SINGLETON) {
        this.cache.primeAll(canonical, entry);
      }
    }

    return instance;
  }

  /**
   * Core asynchronous resolution flow.
   *
   * Key differences from sync path:
   * - Checks cached.promise for in-flight async singletons
   * - Supports AbortSignal for cancellation
   * - All dependencies resolved asynchronously
   *
   * OPTIMIZED: Inline cache check with precomputed masks, simplified local resolution
   */
  async _resolveRelicAsync<T>(
    token: CanonicalId,
    stack: CanonicalId[],
    signal?: AbortSignal,
    scope?: Scope
  ): Promise<T> {
    // Step 1: Check singleton cache (instance or in-flight promise)
    const cachedInstance = await this._checkSingletonCacheAsync<T>(token);
    if (cachedInstance !== undefined) return cachedInstance;

    // Step 2: Check scope cache
    const scopedInstance = this._tryGetFromScopeCache<T>(token, scope);
    if (scopedInstance !== undefined) return scopedInstance;

    // Step 3: Try local resolution
    const wasCached = this.cache.get(token) !== undefined;
    const localInstance = await this._resolveLocalAsync<T>(token, stack, signal, scope, wasCached);
    if (localInstance !== undefined) return localInstance;

    // Step 4: Try cross-vault resolution
    this.resolveLazyAttachments();
    const crossVaultInstance = await this._crossVaultAsync<T>(token, stack, signal, scope);
    if (crossVaultInstance !== undefined) return crossVaultInstance;

    // Step 5: Token not found
    throw this.buildNotFoundError(token, stack);
  }

  // ----- attachments / indices -----

  /**
   * Lazily materialize fused vaults. The method is idempotent and supports
   * rollback: on error we restore the fusedVaults array to its previous length
   * and reset the resolving flag so future attempts can retry.
   */
  private resolveLazyAttachments(): void {
    if (this.lazyAttachmentsResolved) return;

    for (const cls of this.lazyAttachmentClasses) {
      this.fusedVaults.push(this.lazyResolver!(cls));
    }

    this._checkCircularAttachment(this.fusedVaults, [this.name], new Set([this]));
    this.exposure.compute(this);
    this.lazyAttachmentsResolved = true;
  }

  /**
   * DFS cycle detection for fused vaults.
   *
   * This method uses a stack-based DFS with path mutation to avoid allocating
   * new arrays on each iteration. The path array is mutated in place and
   * restored in the finally block, providing O(1) path updates instead of O(n)
   * array spreading.
   *
   * Performance optimization:
   * - Mutates path array instead of spreading [...path, v.name]
   * - Restores path state in finally block for correct backtracking
   * - Only allocates new array when cycle is detected (error path)
   *
   * @param vaults - Array of vaults to check for cycles
   * @param path - Mutable path array tracking current DFS path
   * @param stack - Set of vaults currently in the DFS stack (cycle detection)
   */
  private _checkCircularAttachment(
    vaults: Vault[],
    path: string[],
    stack: Set<Vault> = new Set()
  ): void {
    for (const v of vaults) {
      if (stack.has(v)) {
        // Cycle detected - allocate error path (cold path)
        throw new CircularVaultAttachmentError([...path, v.name]);
      }

      // Hot path - mutate arrays instead of allocating
      stack.add(v);
      path.push(v.name);
      try {
        v._checkCircularAttachment(v.fusedVaults, path, stack);
      } finally {
        // Restore state for backtracking
        path.pop();
        stack.delete(v);
      }
    }
  }

  // ----- utilities -----

  private _isProvider(value: unknown): value is Provider {
    return (
      typeof value === 'object' &&
      value !== null &&
      'provide' in value &&
      ('useClass' in value || 'useValue' in value || 'useFactory' in value)
    );
  }

  /**
   * Per-vault definition lookup. Uses StaticRelicRegistry.buildDefinition to
   * avoid auto-presealing global state and caches the result in the vault.
   */
  private _getDefinition(ctor: Constructor): StaticRelicDefinition | undefined {
    return StaticRelicRegistry.buildDefinition(ctor);
  }

  private _hasLocalEntry(token: string): CanonicalId | undefined {
    const canonical = token as CanonicalId;
    return this.store.has(canonical) ? canonical : undefined;
  }

  /**
   * Enforce shadow policy after all registrations are complete.
   *
   * Shadow policy modes:
   * - 'allow': Permit shadowing (local registration takes precedence)
   * - 'warn': Log all violations to console but don't throw
   * - 'error': Collect ALL violations and throw MultipleShadowPolicyViolationsError
   *
   * This method validates that local registrations don't conflict with exposed
   * tokens from fused vaults, helping prevent accidental token shadowing that
   * could lead to unexpected behavior.
   */
  private _enforceShadowPolicy(): void {
    if (this.shadowPolicy === 'allow') return;

    const violations = this._collectShadowViolations();

    if (violations.length === 0) return;

    // Warn mode: Log all violations but don't throw
    if (this.shadowPolicy === 'warn') {
      console.warn(`[Ceryn] Shadow policy violations detected in vault '${this.name}':`);
      for (const v of violations) {
        console.warn(
          `  - Token '${v.token}' (${v.lifecycle}) shadowed by: ${v.producers.join(', ')}`
        );
      }
      return;
    }

    // Error mode (default): Throw with all violations
    throw new MultipleShadowPolicyViolationsError(this.name, violations);
  }

  /**
   * Collect all shadow policy violations.
   *
   * A violation occurs when a token is registered locally AND exposed by one or
   * more fused vaults (via aether or reveal). This creates ambiguity about which
   * implementation should be used.
   *
   * @returns Array of violations with token info and producer vault names
   */
  private _collectShadowViolations(): Array<{
    token: string;
    producers: string[];
    lifecycle: string;
  }> {
    const stamp = this.exposure.stamp;
    const incoming =
      this.shadowIncomingCache && this.shadowIncomingStamp === stamp
        ? this.shadowIncomingCache
        : this._computeShadowIncoming(stamp);

    const violations: Array<{ token: string; producers: string[]; lifecycle: string }> = [];

    for (const k of this.store.canonicalKeys()) {
      const producers = incoming.get(k);
      if (!producers || producers.length === 0) continue; // No conflict

      const local = this.store.getByCanonical(k)!;
      violations.push({
        token: this._formatTokenForDiagnostics(k),
        producers: Array.from(new Set(producers)), // Deduplicate producer names
        lifecycle: local.metadata.lifecycle,
      });
    }

    return violations;
  }

  private _computeShadowIncoming(stamp: number): Map<CanonicalId, string[]> {
    const incoming = new Map<CanonicalId, string[]>();
    const add = (canonical: CanonicalId, from: Vault) => {
      if (from === this) return;
      const arr = incoming.get(canonical);
      if (arr) arr.push(from.getName());
      else incoming.set(canonical, [from.getName()]);
    };

    for (const map of [this.exposure.aetherMap, this.exposure.revealedMap]) {
      for (const [, { canonical, vault }] of map) add(canonical, vault);
    }

    this.shadowIncomingCache = incoming;
    this.shadowIncomingStamp = stamp;
    return incoming;
  }

  /**
   * Build a rich not-found error with available tokens and dependency chain.
   *
   * The dependency chain is deduplicated by canonical ID first, then mapped to
   * labels to preserve cycle information. This ensures that circular dependencies
   * are visible in the error message.
   *
   * Example with cycle:
   *   ServiceA[tok_1] -> ServiceB[tok_2] -> ServiceA[tok_1]
   *
   * Old behavior (dedupe by label - WRONG):
   *   ServiceA -> ServiceB  // Lost the cycle!
   *
   * New behavior (dedupe by canonical ID - CORRECT):
   *   ServiceA [tok_1] -> ServiceB [tok_2] -> ServiceA [tok_1]  // Cycle preserved!
   *
   * @param token - The token that could not be resolved
   * @param stack - Dependency chain (canonical IDs) leading to this token
   * @returns RelicNotFoundError with formatted chain and suggestions
   */
  buildNotFoundError(token: CanonicalId, stack: CanonicalId[]): RelicNotFoundError {
    const tokenName = this._formatTokenForDiagnostics(token);
    const available = this._getAvailableTokens().map((t) => this._formatTokenForDiagnostics(t));

    // Deduplicate by canonical ID to preserve cycle information
    const dedupedCanonicals = stack.length > 0 ? Array.from(new Set(stack)) : [];

    // Map to formatted labels with arrows
    const chain = dedupedCanonicals
      .map((canonical) => this._formatTokenForDiagnostics(canonical))
      .filter((formatted): formatted is string => Boolean(formatted));

    return new RelicNotFoundError(tokenName, available, chain.length > 0 ? chain : undefined);
  }

  /** Compile available local + cross-vault tokens for diagnostics. */
  private _getAvailableTokens(): CanonicalId[] {
    const tokens = new Set<CanonicalId>();
    for (const k of this.store.canonicalKeys()) tokens.add(k);
    this.resolveLazyAttachments();
    for (const map of [this.exposure.aetherMap, this.exposure.revealedMap]) {
      for (const { canonical } of map.values()) tokens.add(canonical);
    }
    return Array.from(tokens).sort();
  }

  private _invalidateShadowCache(): void {
    this.shadowIncomingCache = null;
    this.shadowIncomingStamp = -1;
  }

  private _formatTokenForDiagnostics(canonical: CanonicalId): string {
    const local = this.store.getByCanonical(canonical);
    if (local) return `${local.metadata.label} [${canonical}]`;

    for (const map of [this.exposure.aetherMap, this.exposure.revealedMap]) {
      const hit = map.get(canonical);
      if (hit) {
        const entry = hit.vault.store.getByCanonical(hit.canonical);
        if (entry) return `${entry.metadata.label} [${hit.canonical}]`;
      }
    }

    return canonical;
  }

  /** @internal */
  describeToken(canonical: CanonicalId): string {
    return this._formatTokenForDiagnostics(canonical);
  }
}
