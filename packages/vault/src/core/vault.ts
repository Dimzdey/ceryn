/* eslint-disable @typescript-eslint/no-this-alias */
/* eslint-disable @typescript-eslint/restrict-template-expressions */
/* eslint-disable no-duplicate-imports */
import {
  AggregateDisposalError,
  CircularDependencyError,
  CircularModuleAttachmentError,
  ContainerDisposedError,
  InvalidModuleConfigError,
  InvalidProviderError,
  InvalidTokenError,
  LazyFusionResolverMissingError,
  LazyResolverInvalidReturnError,
  LifecycleViolationError,
  MissingInjectDecoratorError,
  MissingInjectableDecoratorError,
  MultipleShadowPolicyViolationsError,
  ProviderNotFoundError,
  ScopedWithoutScopeError,
  TokenCollisionError,
} from '../errors/index.js';
import { MetadataRegistry } from '../registry/index.js';
import type { Disposable, ShadowPolicy } from '../types/index.js';
import {
  assertLifecycle,
  Lifecycle,
  lifecycleToFlag,
  type ClassProvider,
  type Constructor,
  type DecoratedModuleClass,
  type FactoryProvider,
  type ModuleConfig,
  type Provider,
  type ProviderMetadata,
  type StaticProviderDefinition,
  type ValueProvider,
} from '../types/index.js';
import { Activator } from './activator.js';
import type { Entry } from './entry-store.js';
import { EntryStore } from './entry-store.js';
import { ExposureIndex } from './exposure-index.js';
import {
  FLAG_HAS_INSTANCE,
  FLAG_HAS_NO_DEPS,
  FLAG_OWNS_INSTANCE,
  LIFECYCLE_MASK,
  LIFECYCLE_SCOPED,
  LIFECYCLE_SINGLETON,
} from './flags.js';
import { ResolverAsync } from './resolver-async.js';
import { ResolverSync } from './resolver-sync.js';
import { Scope } from './scope.js';
import { SingletonCache } from './singleton-cache.js';
import { isToken, type CanonicalId, type Token } from './token.js';
interface LegacyConfig {
  __moduleCfg__: ModuleConfig;
}
// ---------- Internal constants ----------
const EMPTY_DEPS: readonly CanonicalId[] = Object.freeze([] as CanonicalId[]);

function missingDepsForConstructor(ctor: Constructor): readonly (CanonicalId | undefined)[] {
  if (ctor.length === 0) return EMPTY_DEPS;
  return new Array<CanonicalId | undefined>(ctor.length).fill(undefined);
}

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
const IS_DEV = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

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
 * exposure, and a singleton instance cache. The implementation favors clarity
 * and predictable invariants: registrations are sealed after construction,
 * async singletons collapse via entry.promise, and lazy imported modules are
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
  readonly cache: SingletonCache;
  readonly exposure: ExposureIndex;
  readonly activator: Activator;
  readonly resolverAsync: ResolverAsync;
  readonly resolverSync: ResolverSync;

  // Tokens this vault explicitly chooses to export to imported modules
  readonly exportedTokens = new Set<CanonicalId>();

  // Fusion attachments (other vaults imported in). Supports lazy class-based
  // attachments which are resolved the first time cross-vault indices are
  // required.
  readonly importedModules: Vault[] = [];
  private lazyImportClasses: Constructor[] = [];
  private lazyImportsResolved = false; // flip only after successful compute()

  // NOTE: scratchStack was removed — each resolve() call now allocates a fresh
  // stack to avoid re-entrancy corruption when factories call vault.resolve().

  // Registration sealed guard
  private entriesSealed = false;

  // Identity / options
  private readonly name: string;
  private readonly _isGlobal: boolean;
  private readonly shadowPolicy: ShadowPolicy;
  private readonly lazyResolver?: (c: Constructor) => Vault;
  private readonly instantiateHook?: (token: string, durationNs: number) => void;
  private readonly _sourceClass?: Constructor;

  private disposed = false;
  private disposing = false;
  private readonly disposalOrder: CanonicalId[] = [];
  private readonly disposalTracked = new Set<CanonicalId>();
  private shadowIncomingCache: Map<CanonicalId, string[]> | null = null;
  private shadowIncomingStamp = -1;

  constructor(config?: ModuleConfig | DecoratedModuleClass) {
    // Extract configuration from decorated vault class or use direct config
    // Decorated classes have __moduleCfg__ property attached by @Vault() decorator
    const rawCfg = this._extractConfig(config);

    // Validate and freeze configuration (shallow freeze is acceptable since we
    // don't mutate nested objects and this is a one-time setup operation)
    const cfg = this._validateAndFreezeConfig(rawCfg);

    if (typeof config === 'function') {
      this._sourceClass = config;
    }

    this.store = new EntryStore();
    this.exposure = new ExposureIndex();
    this.cache = new SingletonCache();
    this.instantiateHook = cfg.onInstantiate;
    this.activator = new Activator(this);
    this.resolverAsync = new ResolverAsync(this, this.activator);
    this.resolverSync = new ResolverSync(this, this.activator);

    this.name = cfg.name ?? 'Module';
    this.shadowPolicy = cfg.shadowPolicy ?? 'error';
    this._isGlobal = cfg.global ?? false;
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
   * Extract configuration from either a direct ModuleConfig object or a
   * DecoratedModuleClass with embedded __moduleCfg__.
   *
   * This supports two initialization patterns:
   * 1. Direct: new Vault({ providers: [...] })
   * 2. Decorated: new Vault(MyVaultClass) where MyVaultClass has __moduleCfg__
   */
  private _extractConfig(config?: ModuleConfig | DecoratedModuleClass): ModuleConfig | undefined {
    if (!config) return undefined;

    // Check if this is a decorated vault class (has __moduleCfg__ property)
    if (typeof config === 'function' && '__moduleCfg__' in config) {
      return config.__moduleCfg__;
    }

    // Check if this is a plain object that might have __moduleCfg__ (legacy support)
    if (typeof config === 'object' && '__moduleCfg__' in config) {
      return (config as LegacyConfig).__moduleCfg__;
    }

    // Direct ModuleConfig object
    return config;
  }

  /**
   * Validate configuration and return a frozen, validated config object.
   *
   * This method:
   * - Validates onInstantiate is a function or undefined
   * - Returns a shallow-frozen configuration object
   *
   * Note: Shallow freeze is acceptable because:
   * - Arrays (fuse, providers, export) are copied during _fastInit
   * - We don't mutate nested configuration objects after construction
   * - Deep freeze would impose unnecessary performance cost for minimal benefit
   */
  private _validateAndFreezeConfig(rawCfg?: ModuleConfig): ModuleConfig {
    const cfg: ModuleConfig = { ...rawCfg };

    if (cfg.onInstantiate !== undefined && typeof cfg.onInstantiate !== 'function') {
      throw new InvalidModuleConfigError("'onInstantiate' must be a function");
    }

    if (
      cfg.shadowPolicy !== undefined &&
      cfg.shadowPolicy !== 'error' &&
      cfg.shadowPolicy !== 'allow' &&
      cfg.shadowPolicy !== 'warn'
    ) {
      throw new InvalidModuleConfigError("'shadowPolicy' must be 'error', 'allow', or 'warn'");
    }

    return Object.freeze(cfg);
  }
  /**
   * Fast initialization path for vault configuration.
   *
   * Validates and processes fuse, providers, and export arrays with comprehensive
   * error checking to ensure type safety and catch configuration errors early.
   */
  private _fastInit(cfg: ModuleConfig): void {
    const { imports: fuse, providers: relics, exports: reveal } = cfg;

    // Validate and process fuse array
    if (fuse !== undefined) {
      if (!Array.isArray(fuse)) {
        throw new InvalidModuleConfigError(`'imports' must be an array.`);
      }
      this._validateAndProcessFuse(fuse);
    }

    // Validate and process relics array
    if (relics !== undefined) {
      if (!Array.isArray(relics)) {
        throw new InvalidModuleConfigError(`'providers' must be an array.`);
      }
      this._validateAndProcessRelics(relics);
    }

    // Validate and process reveal array
    if (reveal !== undefined) {
      if (!Array.isArray(reveal)) {
        throw new InvalidModuleConfigError(`'exports' must be an array.`);
      }
      this._validateAndProcessReveal(reveal);
    }

    if (this.lazyImportClasses.length > 0) this.resolveLazyAttachments();

    // Compute exposure indices if we have imported modules
    if (this.importedModules.length > 0) this.exposure.compute(this);

    this._validateExportedTokens();

    // Enforce shadow policy after all registrations and exposure are indexed
    this._enforceShadowPolicy();
  }

  /**
   * Validate and process the fuse array.
   *
   * Each item must be either:
   * - A Vault instance (concrete fusion)
   * - A constructor function (lazy fusion)
   *
   * @throws InvalidModuleConfigError if any item is invalid
   */
  private _validateAndProcessFuse(fuse: (Constructor | Vault)[]): void {
    for (let i = 0; i < fuse.length; i++) {
      const item = fuse[i];

      if (item == null) {
        throw new InvalidModuleConfigError(
          `imports[${i}] must be a Vault instance or constructor function, got ${item}`
        );
      }

      if (item instanceof Vault) {
        this.importedModules.push(item);
      } else if (typeof item === 'function') {
        // Validate it's actually a constructor (has prototype)
        // This catches arrow functions, async functions, etc.
        if (!item.prototype || typeof item.prototype !== 'object') {
          throw new InvalidModuleConfigError(
            `imports[${i}] must be a class constructor, not an arrow or async function. ` +
              `Got function '${item.name || 'anonymous'}' without valid prototype.`
          );
        }
        this.lazyImportClasses.push(item);
      } else {
        throw new InvalidModuleConfigError(
          `imports[${i}] must be a Vault instance or constructor function, got ${typeof item}`
        );
      }
    }
  }

  /**
   * Validate and process the providers array.
   *
   * Each item must be either:
   * - A constructor function (decorated with @Provider)
   * - A Provider object (with provide + useClass/useValue/useFactory)
   *
   * @throws InvalidModuleConfigError if any item is invalid
   */
  private _validateAndProcessRelics(relics: Array<Constructor | Provider>): void {
    for (let i = 0; i < relics.length; i++) {
      const item = relics[i];

      if (item == null) {
        throw new InvalidModuleConfigError(
          `providers[${i}] must be a constructor or Provider object, got ${item}`
        );
      }

      // Validate provider objects have required properties
      if (typeof item === 'object' && !this._isProvider(item)) {
        throw new InvalidModuleConfigError(
          `providers[${i}] must be a constructor or valid Provider object with 'provide' and one of 'useClass'/'useValue'/'useFactory'`
        );
      }

      try {
        this._registerProvider(item);
      } catch (error) {
        if (error instanceof TokenCollisionError) {
          throw new InvalidModuleConfigError(
            `providers[${i}] duplicates token '${this._formatTokenForDiagnostics(
              error.token as CanonicalId
            )}'`
          );
        }
        throw error;
      }
    }
  }

  /**
   * Validate and process the export array.
   *
   * Each item must be a valid Token created with token<T>().
   *
   * @throws InvalidModuleConfigError if any item is invalid
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

        throw new InvalidModuleConfigError(
          `exports[${i}] must be a Token created with token<T>(), got ${itemDesc}`
        );
      }

      if (this.exportedTokens.has(item.id)) {
        throw new InvalidModuleConfigError(
          `exports[${i}] duplicates token '${this._formatTokenForDiagnostics(item.id)}'`
        );
      }

      this.exportedTokens.add(item.id);
    }
  }

  /**
   * Validate that every explicit export is backed by either a local provider or
   * a visible imported provider. This permits intentional re-exports while
   * rejecting dangling module contracts at bootstrap.
   */
  private _validateExportedTokens(): void {
    for (const canonical of this.exportedTokens) {
      if (this.store.has(canonical)) continue;
      if (this.exposure.exportedMap.has(canonical) || this.exposure.globalMap.has(canonical)) {
        continue;
      }

      throw new InvalidModuleConfigError(
        `Module '${this.name}' exports '${this._formatTokenForDiagnostics(
          canonical
        )}' but no local or imported provider is visible for that token.`
      );
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
   * Check if this vault is configured as an global module.
   *
   * Global modules expose ALL their providers transitively to descendant vaults in
   * the fusion hierarchy, bypassing normal export-based exposure. This is useful
   * for creating global/shared service containers.
   *
   * @returns true if global mode is enabled, false otherwise
   */
  get isGlobal(): boolean {
    return this._isGlobal;
  }

  /**
   * Create a new scope for resolving scoped-lifecycle providers.
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
  createScope(): Scope {
    this._assertUsable();
    return new Scope(this);
  }

  /**
   * Resolve a token synchronously to get its instance.
   *
   * Resolution order:
   * 1. Check cache for singleton instances
   * 2. Check scope cache for scoped instances (if scope provided)
   * 3. Resolve locally if token is registered in this vault
   * 4. Resolve from imported modules (global or exported tokens)
   * 5. Throw ProviderNotFoundError if not found
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
   * @param opts.scope - Scope for scoped-lifecycle providers
   *
   * @returns Instance of type T
   *
   * @throws {InvalidTokenError} If token is not a valid Token object
   * @throws {ProviderNotFoundError} If token is not registered
   * @throws {ContainerDisposedError} If vault has been disposed
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
    this._assertUsable();
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
      const stack: CanonicalId[] = [];
      const out = this.resolverSync.fromEntry<T>(id, stack, scope);

      // OPTIMIZATION: Only prime cache if singleton AND not already cached
      if ((local.flags & LIFECYCLE_MASK) === LIFECYCLE_SINGLETON && cached === undefined) {
        this.cache.primeAll(id, local);
      }
      return out;
    }

    // Cross-vault (cold path)
    this.resolveLazyAttachments();
    const stack: CanonicalId[] = [];
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
   * @param opts.scope - Scope for scoped-lifecycle providers
   *
   * @returns Promise resolving to instance of type T
   *
   * @throws {InvalidTokenError} If token is not a valid Token object
   * @throws {ProviderNotFoundError} If token is not registered
   * @throws {ContainerDisposedError} If vault has been disposed
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
    this._assertUsable();
    const stack: CanonicalId[] = [];

    // OPTIMIZATION: Extract options upfront to avoid repeated access
    const signal = opts !== undefined ? opts.signal : undefined;
    const scope = opts !== undefined ? opts.scope : undefined;

    return this._resolveProviderAsync<T>(token.id, stack, signal, scope);
  }

  /**
   * Check if a token is visible from this vault without instantiating it.
   *
   * Visibility rules:
   * - Local providers are always visible
   * - Imported exported providers are visible
   * - Imported providers from global vaults are visible
   * - Non-exported imported providers are not visible
   *
   * @param token - Token to check for visibility
   * @returns true if the token is visible from this vault
   * @throws InvalidTokenError if token is not a valid Token object
   */
  has<T>(token: Token<T>): boolean {
    this._assertUsable();
    if (!isToken(token)) {
      throw new InvalidTokenError(token);
    }

    return this._hasVisibleToken(token.id);
  }

  /**
   * Check if a token can be resolved without actually instantiating it.
   *
   * ⚠️ SIDE EFFECTS: This method triggers lazy attachment resolution, which:
   * - Materializes lazy-imported vault classes
   * - Recomputes cross-vault exposure indices
   * - Validates circular attachment detection
   * - Enforces shadow policy
   *
   * Use this method when you need to conditionally resolve tokens based on
   * availability. For unconditional resolution, use resolve() directly and
   * catch ProviderNotFoundError.
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
    this._assertUsable();
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
    if (!this._hasVisibleToken(canonical)) return false;

    try {
      this._validateResolvableGraph(canonical, [], true);
      return true;
    } catch (error) {
      if (!this._isExpectedCanResolveFailure(error)) throw error;
      return false;
    }
  }

  /** @internal Scope-aware resolvability check used by Scope.tryResolve(). */
  _canResolveInScope<T>(token: Token<T>, scope: Scope): boolean {
    if (!this._hasVisibleToken(token.id)) return false;

    try {
      this._validateResolvableGraph(token.id, [], false, scope);
      return true;
    } catch (error) {
      if (!this._isExpectedCanResolveFailure(error)) throw error;
      return false;
    }
  }

  private _isExpectedCanResolveFailure(error: unknown): boolean {
    return (
      error instanceof ProviderNotFoundError ||
      error instanceof LifecycleViolationError ||
      error instanceof CircularDependencyError ||
      error instanceof ScopedWithoutScopeError
    );
  }

  private _hasVisibleToken(canonical: CanonicalId): boolean {
    if (this._hasLocalEntry(canonical)) return true;

    this.resolveLazyAttachments();
    return this.exposure.globalMap.has(canonical) || this.exposure.exportedMap.has(canonical);
  }

  private _validateResolvableGraph(
    canonical: CanonicalId,
    stack: CanonicalId[],
    isRoot = false,
    scope?: Scope
  ): void {
    const scopeEntry = scope?.getLocalEntry(canonical);
    if (scopeEntry && scopeEntry.flags & FLAG_HAS_INSTANCE) {
      this._validateLifecycleRulesForEntry(canonical, scopeEntry, stack);
      return;
    }

    const localEntry = this.store.getByCanonical(canonical);
    if (localEntry) {
      this._validateLocalResolvableGraph(canonical, localEntry, stack, isRoot, scope);
      return;
    }

    this.resolveLazyAttachments();
    const hit = this._findCrossVaultEntry(canonical);
    if (!hit) {
      throw this.buildNotFoundError(canonical, stack);
    }

    const crossVaultEntry = hit.vault.store.getByCanonical(hit.canonical);
    if (!crossVaultEntry) {
      throw this.buildNotFoundError(canonical, stack);
    }

    this._validateLifecycleRulesForEntry(canonical, crossVaultEntry, stack);
    hit.vault._validateLocalResolvableGraph(hit.canonical, crossVaultEntry, stack, isRoot, scope);
  }

  private _validateLocalResolvableGraph(
    canonical: CanonicalId,
    entry: Entry,
    stack: CanonicalId[],
    isRoot = false,
    scope?: Scope
  ): void {
    if (stack.includes(canonical)) {
      const cycle = stack.slice(stack.indexOf(canonical)).concat(canonical);
      throw new CircularDependencyError(cycle.map((token) => this.describeToken(token)));
    }

    if (isRoot && (entry.flags & LIFECYCLE_MASK) === LIFECYCLE_SCOPED) {
      throw new ScopedWithoutScopeError(entry.token, [this.describeToken(canonical)]);
    }

    stack.push(canonical);
    try {
      this._validateLifecycleRules(canonical, stack);

      for (const [idx, dep] of entry.summons.entries()) {
        if (dep === undefined) {
          throw new MissingInjectDecoratorError(entry.ctor?.name ?? entry.metadata.label, idx);
        }
        this._validateResolvableGraph(dep, stack, false, scope);
      }

      for (const dep of entry.factoryDeps) {
        this._validateResolvableGraph(dep, stack, false, scope);
      }
    } finally {
      stack.pop();
    }
  }

  /** @internal Track owned materialized singletons for LIFO disposal. */
  _trackOwnedInstance(entry: Entry): void {
    if (!(entry.flags & FLAG_OWNS_INSTANCE) || !(entry.flags & FLAG_HAS_INSTANCE)) return;
    if (this.disposalTracked.has(entry.token)) return;

    this.disposalTracked.add(entry.token);
    this.disposalOrder.push(entry.token);
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
      const e = this.store.getByCanonical(canonical);
      if (!e) continue;
      if (e.instance !== undefined) {
        e.instance = undefined;
        e.flags &= ~FLAG_HAS_INSTANCE;
      }
      if (e.promise) e.promise = undefined;
    }
    this.cache.clear();
    this.disposalOrder.length = 0;
    this.disposalTracked.clear();
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
    if (this.disposed || this.disposing) return;
    this.disposing = true;

    const finish = (): void => {
      this.disposed = true;
      this.disposing = false;
    };

    const errors: Error[] = [];
    const pending: Promise<void>[] = [];
    const allCanonicals = Array.from(this.store.canonicalKeys());
    const seen = new Set<CanonicalId>();
    const disposalCandidates: CanonicalId[] = [];

    for (let i = this.disposalOrder.length - 1; i >= 0; i--) {
      const canonical = this.disposalOrder[i];
      if (!seen.has(canonical)) {
        seen.add(canonical);
        disposalCandidates.push(canonical);
      }
    }

    for (let i = allCanonicals.length - 1; i >= 0; i--) {
      const canonical = allCanonicals[i];
      if (!seen.has(canonical)) {
        seen.add(canonical);
        disposalCandidates.push(canonical);
      }
    }

    // Attempt to dispose owned instances, collecting errors along the way
    for (const canonical of disposalCandidates) {
      const entry = this.store.getByCanonical(canonical);
      if (!entry) continue;
      if (!(entry.flags & FLAG_OWNS_INSTANCE)) continue;

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
    }

    for (const canonical of allCanonicals) {
      const entry = this.store.getByCanonical(canonical);
      if (!entry) continue;
      entry.instance = undefined;
      entry.promise = undefined;
      entry.flags &= ~FLAG_HAS_INSTANCE;
    }

    // Clean up vault state
    this.cache.clear();
    this.exposure.clear();
    this._invalidateShadowCache();
    this.disposalOrder.length = 0;
    this.disposalTracked.clear();

    // Synchronous disposal path
    if (pending.length === 0) {
      finish();
      if (errors.length > 0) {
        throw new AggregateDisposalError(errors);
      }
      return;
    }

    // Asynchronous disposal path
    return Promise.allSettled(pending).then((results) => {
      // Collect rejection reasons
      for (const result of results) {
        if (result.status === 'rejected') {
          const error = result.reason;
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }

      // Mark as disposed AFTER all disposal attempts complete
      finish();

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
   * Returns a Map of currently instantiated singleton providers. This is useful for:
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
      const e = this.store.getByCanonical(k);
      if (!e) continue;
      if (e.metadata.lifecycle === Lifecycle.Singleton && e.instance !== undefined)
        out.set(k, e.instance);
    }
    return out;
  }

  /**
   * Check if a token is registered locally in this vault.
   *
   * This checks only local registrations, not tokens accessible via fusion.
   * Use has() to check if a token is visible (including imported tokens).
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
   * Check if a token was explicitly exported by this vault.
   *
   * Exported tokens are accessible to other vaults that fuse to this one.
   * This is different from global mode, which exposes all tokens transitively.
   *
   * @param token - Canonical token ID to check
   * @returns true if token was included in the export array, false otherwise
   *
   * @example
   * ```typescript
   * if (vault.isExposed('tok_123')) {
   *   console.log('Token is available to imported modules');
   * }
   * ```
   */
  isExposed(token: string): boolean {
    const canonical = this._hasLocalEntry(token);
    return !!canonical && this.exportedTokens.has(canonical);
  }

  /** @internal */
  getInstantiateHook(): ((token: string, durationNs: number) => void) | undefined {
    return this.instantiateHook;
  }

  // ----- Registration Helpers -----

  /** Guard to prevent late registration after finalization. */
  private _assertUsable(): void {
    if (this.disposed || this.disposing) throw new ContainerDisposedError(this.name);
  }

  /** Guard to prevent late registration after finalization. */
  private _assertNotSealed() {
    if (this.entriesSealed) throw new InvalidModuleConfigError('registration after finalize');
  }

  /**
   * Top-level registrar that dispatches provider shapes to specialized handlers.
   *
   * Handles three registration forms:
   *  - Constructor decorated with @Provider() → _registerClass()
   *  - Provider object with useClass → _registerClassProvider()
   *  - Provider object with useValue → _registerValueProvider()
   *  - Provider object with useFactory → _registerFactoryProvider()
   */
  private _registerProvider(provider: Constructor | Provider): void {
    this._assertNotSealed();
    if (typeof provider === 'function') {
      this._registerClass(provider);
      return;
    }

    if (!this._isProvider(provider)) throw new InvalidProviderError(provider);

    if ('useClass' in provider) return void this._registerClassProvider(provider);
    if ('useValue' in provider) return void this._registerValueProvider(provider);
    if ('useFactory' in provider) return void this._registerFactoryProvider(provider);

    throw new InvalidProviderError(provider);
  }

  /**
   * Register a class decorated with @Provider (requires decorator metadata).
   *
   * Extracts metadata from the MetadataRegistry (populated by @Provider decorator)
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
    if (!def) throw new MissingInjectableDecoratorError(ctor.name);

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
      flags: lifecycleFlag | FLAG_OWNS_INSTANCE | (hasNoDeps ? FLAG_HAS_NO_DEPS : 0),
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
   *  2. def.metadata.lifecycle (from @Provider decorator if present)
   *  3. Lifecycle.Singleton (default)
   */
  private _registerClassProvider(provider: ClassProvider): void {
    const def = this._getDefinition(provider.useClass);
    const token = provider.provide;
    const canonical = token.id;

    // Lifecycle resolution: provider override > decorator metadata > default singleton
    const lifecycle = provider.lifecycle ?? def?.metadata.lifecycle ?? Lifecycle.Singleton;
    assertLifecycle(lifecycle, 'Class provider');
    const lifecycleFlag = lifecycleToFlag(lifecycle);
    const metadata: ProviderMetadata = { name: canonical, label: token.label, lifecycle };

    const deps = def ? def.dependencies : missingDepsForConstructor(provider.useClass);
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
      flags: lifecycleFlag | FLAG_OWNS_INSTANCE | (hasNoDeps ? FLAG_HAS_NO_DEPS : 0),
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

    const metadata: ProviderMetadata = {
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
      flags:
        LIFECYCLE_SINGLETON |
        FLAG_HAS_INSTANCE |
        FLAG_HAS_NO_DEPS |
        (provider.owned === true ? FLAG_OWNS_INSTANCE : 0),
    };

    this.store.add(entry, this.name);
    this._trackOwnedInstance(entry);
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
    assertLifecycle(lifecycle, 'Factory provider');
    const lifecycleFlag = lifecycleToFlag(lifecycle);
    const metadata: ProviderMetadata = { name: canonical, label: token.label, lifecycle };

    const entry: Entry = {
      token: canonical,
      factory: provider.useFactory,
      factoryDeps,
      metadata,
      summons: EMPTY_DEPS, // Not used for factories (factoryDeps used instead)
      aliases: [canonical],
      // Flags: lifecycle bits (0-1) + FLAG_HAS_NO_DEPS (factories don't use summons[])
      flags: lifecycleFlag | FLAG_HAS_NO_DEPS | (provider.owned === false ? 0 : FLAG_OWNS_INSTANCE),
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
   * not present yet (deferred registration or imported exposure) we skip
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
    return this.exposure.globalMap.get(token) ?? this.exposure.exportedMap.get(token);
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
    const e = vault.store.getByCanonical(canonical);
    if (!e) throw this.buildNotFoundError(token, stack);
    const lifecycleFlags = e.flags & LIFECYCLE_MASK;
    this._validateLifecycleRulesForEntry(token, e, stack);
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
    const e = vault.store.getByCanonical(canonical);
    if (!e) throw this.buildNotFoundError(token, stack);
    const lifecycleFlags = e.flags & LIFECYCLE_MASK;
    this._validateLifecycleRulesForEntry(token, e, stack);
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
  _validateLifecycleRules(token: CanonicalId, stack: CanonicalId[]): void {
    if (stack.length === 0) return; // No parent to validate against

    const entry = this.store.getByCanonical(token);
    if (!entry) return; // Cross-vault resolution, skip validation

    this._validateLifecycleRulesForEntry(token, entry, stack);
  }

  private _validateLifecycleRulesForEntry(
    dependencyToken: CanonicalId,
    dependencyEntry: Entry,
    stack: CanonicalId[]
  ): void {
    if (stack.length === 0) return;

    for (const consumerToken of stack) {
      const consumerEntry = this.store.getByCanonical(consumerToken);
      if (!consumerEntry) continue; // Cross-vault, skip

      this._validateLifecyclePair(
        consumerToken,
        consumerEntry,
        dependencyToken,
        dependencyEntry,
        stack
      );
    }
  }

  private _validateLifecyclePair(
    consumerToken: CanonicalId,
    consumerEntry: Entry,
    dependencyToken: CanonicalId,
    dependencyEntry: Entry,
    stack: CanonicalId[]
  ): void {
    const consumerLifecycle = consumerEntry.metadata.lifecycle;
    const dependencyLifecycle = dependencyEntry.metadata.lifecycle;

    const violatesSingletonRule =
      consumerLifecycle === Lifecycle.Singleton &&
      (dependencyLifecycle === Lifecycle.Scoped || dependencyLifecycle === Lifecycle.Transient);
    const violatesScopedRule =
      consumerLifecycle === Lifecycle.Scoped && dependencyLifecycle === Lifecycle.Transient;

    if (violatesSingletonRule || violatesScopedRule) {
      const chain = stack.map((t) => this._formatTokenForDiagnostics(t));
      throw new LifecycleViolationError(
        this._formatTokenForDiagnostics(consumerToken),
        consumerLifecycle,
        this._formatTokenForDiagnostics(dependencyToken),
        dependencyLifecycle,
        chain
      );
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
  private _tryGetFromScopeCache<T>(
    token: CanonicalId,
    scope?: Scope,
    stack?: CanonicalId[]
  ): T | undefined {
    if (scope === undefined) return undefined;

    // Check scope-local registrations first (highest priority)
    const localEntry = scope.getLocalEntry(token);
    if (localEntry && localEntry.flags & FLAG_HAS_INSTANCE) {
      if (stack !== undefined) this._validateLifecycleRulesForEntry(token, localEntry, stack);
      return localEntry.instance as T;
    }

    // Then check scope cache for scoped-lifecycle instances
    const scopedCached = scope.cache.get(token);
    if (scopedCached !== undefined && scopedCached.flags & FLAG_HAS_INSTANCE) {
      if (stack !== undefined) this._validateLifecycleRulesForEntry(token, scopedCached, stack);
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
  _resolveProvider<T>(token: CanonicalId, stack: CanonicalId[], scope?: Scope): T {
    // Step 1: Check singleton cache
    const cachedInstance = this._tryGetFromSingletonCache<T>(token);
    if (cachedInstance !== undefined) return cachedInstance;

    // Step 2: Check scope cache
    const scopedInstance = this._tryGetFromScopeCache<T>(token, scope, stack);
    if (scopedInstance !== undefined) return scopedInstance;

    // Step 3: Try local resolution
    const cachedEntry = this.cache.get(token);
    const localInstance = this._resolveLocal<T>(token, stack, scope, cachedEntry);
    if (localInstance !== undefined) return localInstance;

    // Step 4: Try cross-vault resolution
    this.resolveLazyAttachments();
    const crossVaultInstance = this._crossVaultSync<T>(token, stack, scope);
    if (crossVaultInstance !== undefined) return crossVaultInstance;

    // Step 5: Token not found — but if the token is already in the stack it is a
    // cross-vault cycle: the dependency graph came back around to a token we are
    // already resolving in another vault.
    if (stack.includes(token)) {
      const cycle = stack.slice(stack.indexOf(token)).concat(token);
      throw new CircularDependencyError(cycle.map((t) => this.describeToken(t)));
    }

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
  async _resolveProviderAsync<T>(
    token: CanonicalId,
    stack: CanonicalId[],
    signal?: AbortSignal,
    scope?: Scope
  ): Promise<T> {
    // Step 1: Check singleton cache (instance or in-flight promise)
    const cachedInstance = await this._checkSingletonCacheAsync<T>(token);
    if (cachedInstance !== undefined) return cachedInstance;

    // Step 2: Check scope cache
    const scopedInstance = this._tryGetFromScopeCache<T>(token, scope, stack);
    if (scopedInstance !== undefined) return scopedInstance;

    // Step 3: Try local resolution
    const wasCached = this.cache.get(token) !== undefined;
    const localInstance = await this._resolveLocalAsync<T>(token, stack, signal, scope, wasCached);
    if (localInstance !== undefined) return localInstance;

    // Step 4: Try cross-vault resolution
    this.resolveLazyAttachments();
    const crossVaultInstance = await this._crossVaultAsync<T>(token, stack, signal, scope);
    if (crossVaultInstance !== undefined) return crossVaultInstance;

    // Step 5: Token not found — but if the token is already in the stack it is a
    // cross-vault cycle: the dependency graph came back around to a token we are
    // already resolving in another vault.
    if (stack.includes(token)) {
      const cycle = stack.slice(stack.indexOf(token)).concat(token);
      throw new CircularDependencyError(cycle.map((t) => this.describeToken(t)));
    }

    throw this.buildNotFoundError(token, stack);
  }

  // ----- attachments / indices -----

  /**
   * Lazily materialize imported modules. The method is idempotent and supports
   * rollback: on error we restore the importedModules array to its previous length
   * and reset the resolving flag so future attempts can retry.
   */
  private resolveLazyAttachments(): void {
    if (this.lazyImportsResolved) return;

    const resolver = this.lazyResolver ?? Vault.getDefaultLazyResolver();
    if (this.lazyImportClasses.length > 0 && resolver === undefined) {
      throw new LazyFusionResolverMissingError();
    }

    const initialImportCount = this.importedModules.length;
    for (const cls of this.lazyImportClasses) {
      try {
        if (!resolver) throw new LazyFusionResolverMissingError();
        const resolved = resolver(cls);
        if (!(resolved instanceof Vault)) {
          throw new LazyResolverInvalidReturnError(cls.name || 'anonymous', resolved);
        }
        this.importedModules.push(resolved);
      } catch (error) {
        this.importedModules.length = initialImportCount;
        throw error;
      }
    }

    this._checkCircularAttachment(this.importedModules, [this.name], new Set([this]));
    this.exposure.compute(this);
    this.lazyImportsResolved = true;
  }

  /**
   * DFS cycle detection for imported modules.
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
        throw new CircularModuleAttachmentError([...path, v.name]);
      }

      // Hot path - mutate arrays instead of allocating
      stack.add(v);
      path.push(v.name);
      try {
        v._checkCircularAttachment(v.importedModules, path, stack);
      } finally {
        // Restore state for backtracking
        path.pop();
        stack.delete(v);
      }
    }
  }

  // ----- utilities -----

  private _isProvider(value: unknown): value is Provider {
    if (typeof value !== 'object' || value === null || !('provide' in value)) return false;

    const candidate = value as Partial<ClassProvider & ValueProvider & FactoryProvider>;
    if (!isToken(candidate.provide)) return false;

    const implementationKeys = [
      'useClass' in candidate,
      'useValue' in candidate,
      'useFactory' in candidate,
    ].filter(Boolean).length;
    if (implementationKeys !== 1) return false;

    if ('useClass' in candidate && typeof candidate.useClass !== 'function') return false;
    if ('useFactory' in candidate && typeof candidate.useFactory !== 'function') return false;

    return true;
  }

  /**
   * Per-vault definition lookup. Uses MetadataRegistry.buildDefinition to
   * avoid auto-presealing global state and caches the result in the vault.
   */
  private _getDefinition(ctor: Constructor): StaticProviderDefinition | undefined {
    return MetadataRegistry.buildDefinition(ctor);
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
   * tokens from imported modules, helping prevent accidental token shadowing that
   * could lead to unexpected behavior.
   */
  private _enforceShadowPolicy(): void {
    if (this.shadowPolicy === 'allow') return;

    const violations = this._collectShadowViolations();
    const ambiguousImports = this._collectAmbiguousImportViolations();

    if (violations.length === 0 && ambiguousImports.length === 0) return;

    // Warn mode: Log all violations but don't throw
    if (this.shadowPolicy === 'warn') {
      if (violations.length > 0) {
        console.warn(`[Ceryn] Shadow policy violations detected in vault '${this.name}':`);
        for (const v of violations) {
          console.warn(
            `  - Token '${v.token}' (${v.lifecycle}) shadowed by: ${v.producers.join(', ')}`
          );
        }
      }
      if (ambiguousImports.length > 0) {
        console.warn(`[Ceryn] Ambiguous imported providers detected in vault '${this.name}':`);
        for (const v of ambiguousImports) {
          console.warn(`  - Token '${v.token}' exposed by: ${v.producers.join(', ')}`);
        }
      }
      return;
    }

    if (violations.length > 0) {
      throw new MultipleShadowPolicyViolationsError(this.name, violations);
    }

    throw new InvalidModuleConfigError(this._formatAmbiguousImportViolations(ambiguousImports));
  }

  private _formatAmbiguousImportViolations(
    violations: Array<{ token: string; producers: string[] }>
  ): string {
    const list = violations
      .map((v) => `'${v.token}' is exposed by ${v.producers.join(', ')}`)
      .join('; ');

    return `Module '${this.name}' has ambiguous imported providers: ${list}. Set shadowPolicy: 'allow' to keep first-match resolution, or import/export only one provider for each token.`;
  }

  private _collectAmbiguousImportViolations(): Array<{ token: string; producers: string[] }> {
    const byToken = new Map<CanonicalId, Set<string>>();
    const duplicateExposures: Array<{ canonical: CanonicalId; producerNames: string[] }> =
      this.exposure.getDuplicateExposures();

    for (const { canonical, producerNames } of duplicateExposures) {
      const names = byToken.get(canonical) ?? new Set<string>();
      for (const name of producerNames) names.add(name);
      byToken.set(canonical, names);
    }

    for (const [canonical, globalRef] of this.exposure.globalMap) {
      const exportedRef = this.exposure.exportedMap.get(canonical);
      if (!exportedRef) continue;
      if (globalRef.vault === exportedRef.vault && globalRef.canonical === exportedRef.canonical) {
        continue;
      }

      const names = byToken.get(canonical as CanonicalId) ?? new Set<string>();
      names.add(globalRef.vault.getName());
      names.add(exportedRef.vault.getName());
      byToken.set(canonical as CanonicalId, names);
    }

    return Array.from(byToken.entries()).map(([canonical, producers]) => ({
      token: this._formatTokenForDiagnostics(canonical),
      producers: Array.from(producers).sort(),
    }));
  }

  /**
   * Collect all shadow policy violations.
   *
   * A violation occurs when a token is registered locally AND exposed by one or
   * more imported modules (via global or export). This creates ambiguity about which
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

      const local = this.store.getByCanonical(k);
      if (!local) continue;
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

    for (const map of [this.exposure.globalMap, this.exposure.exportedMap]) {
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
   * @returns ProviderNotFoundError with formatted chain and suggestions
   */
  buildNotFoundError(token: CanonicalId, stack: CanonicalId[]): ProviderNotFoundError {
    const tokenName = this._formatTokenForDiagnostics(token);
    const available = this._getAvailableTokens().map((t) => this._formatTokenForDiagnostics(t));

    // Deduplicate by canonical ID to preserve cycle information
    const dedupedCanonicals = stack.length > 0 ? Array.from(new Set(stack)) : [];

    // Map to formatted labels with arrows
    const chain = dedupedCanonicals
      .map((canonical) => this._formatTokenForDiagnostics(canonical))
      .filter((formatted): formatted is string => Boolean(formatted));

    return new ProviderNotFoundError(tokenName, available, chain.length > 0 ? chain : undefined);
  }

  /** Compile available local + cross-vault tokens for diagnostics. */
  private _getAvailableTokens(): CanonicalId[] {
    const tokens = new Set<CanonicalId>();
    for (const k of this.store.canonicalKeys()) tokens.add(k);
    this.resolveLazyAttachments();
    for (const map of [this.exposure.globalMap, this.exposure.exportedMap]) {
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

    for (const map of [this.exposure.globalMap, this.exposure.exportedMap]) {
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
