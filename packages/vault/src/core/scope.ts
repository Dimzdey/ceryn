/* Scope
 *
 * Represents a logical request scope that isolates relic instances with
 * Lifecycle.Scoped from each other while sharing Lifecycle.Singleton instances.
 *
 * Purpose:
 *  - Provide per-request or per-operation isolation for stateful services
 *  - Automatically clean up resources when the scope ends
 *  - Enable safe concurrent request handling in server environments
 *  - Support dynamic dependency injection at runtime via scope-local registrations
 *
 * Design:
 *  - Each scope has its own MRU cache for scoped relic instances
 *  - Scope-local registrations override vault registrations (highest priority)
 *  - Lazy initialization: cache and disposers only created when first used
 *  - Disposers automatically registered for instances with dispose() or close()
 *  - dispose() or disposeSync() cleans up all scoped instances in registration order
 *  - Scope creation is O(1) - no upfront allocation
 *
 * Lifecycle interaction:
 *  - Singleton relics: Shared globally, NOT stored in scope cache
 *  - Scoped relics: Isolated per scope, stored in scope cache
 *  - Transient relics: Fresh instance every time, never cached
 *  - Scope-local registrations: Highest priority, override all other sources
 *
 * Resolution priority (highest to lowest):
 *  1. Scope-local registrations (via provide())
 *  2. Singleton cache
 *  3. Scoped lifecycle instances in scope cache
 *  4. Vault registration store
 *
 * Dynamic Registration:
 *  - provide(token, value): Register scope-local value (overrides vault)
 *  - has(token): Check if token exists in scope or vault
 *  - tryResolve(token): Safe resolution returning undefined on failure
 *  - override(token, value): Replace existing scope-local registration
 *
 * Usage example:
 * ```typescript
 * // Define tokens for dependency injection
 * const RequestT = token<Request>('Request');
 * const ResponseT = token<Response>('Response');
 * const RequestIdT = token<string>('RequestId');
 * const HandlerT = token<RequestHandler>('RequestHandler');
 *
 * // HTTP request handler with dynamic dependencies
 * async function handleRequest(req: Request, res: Response) {
 *   const scope = genesis.createScope();
 *   try {
 *     // Provide request-specific dependencies
 *     scope.provide(RequestT, req);
 *     scope.provide(ResponseT, res);
 *     scope.provide(RequestIdT, crypto.randomUUID());
 *
 *     // Resolve handler with injected dependencies
 *     const handler = scope.resolve(HandlerT);
 *     return await handler.handle();
 *   } finally {
 *     await scope.dispose(); // Cleanup scoped instances
 *   }
 * }
 * ```
 *
 * Performance notes:
 *  - Scope creation is lightweight (no allocations until first use)
 *  - Cache uses same MRU strategy as vault for consistent hot-path performance
 *  - Disposer set only allocated if needed (many scopes may not register disposers)
 *  - Local registrations map lazily allocated on first provide() call
 */

import { ScopeDisposedError } from '../errors/errors.js';
import type { Disposable } from '../types/index.js';
import type { Entry } from './entry-store.js';
import { FLAG_HAS_INSTANCE } from './flags.js';
import { MRUCache } from './mru-cache.js';
import type { CanonicalId, Token } from './token.js';
import type { Vault } from './vault.js';

export class Scope {
  /**
   * Tracks whether this scope has been disposed.
   * Once disposed, no further operations should be allowed.
   */
  private disposed = false;

  /**
   * Cleanup functions registered for scoped instances.
   * Lazily allocated - undefined until first disposer is registered.
   */
  private disposers: Set<() => void | Promise<void>> | undefined;

  /**
   * Maps token IDs to their disposer functions for scope-local registrations.
   * This allows removing old disposers when a token is overridden.
   * Lazily allocated when first disposer is registered via provide().
   */
  private tokenDisposers?: Map<CanonicalId, () => void | Promise<void>>;

  /**
   * MRU cache for scoped relic instances.
   * Lazily allocated - undefined until first scoped relic is resolved.
   */
  private _cache?: MRUCache;

  /**
   * Scope-local registrations that override vault registrations.
   * Maps CanonicalId to Entry. Lazily allocated when first provide() is called.
   *
   * These registrations take precedence over vault registrations during
   * resolution, enabling dynamic dependency injection within a scope.
   */
  private localRegistrations?: Map<CanonicalId, Entry>;

  /**
   * Reference to the parent vault for resolution delegation.
   * Injected during construction to enable scope-based resolution.
   */
  private vault?: Vault;

  /**
   * Create a new Scope, optionally bound to a parent Vault for resolution.
   *
   * @param vault - Optional parent vault for delegation during resolution
   */
  constructor(vault?: Vault) {
    this.vault = vault;
  }

  /**
   * Check if this scope has been disposed.
   * Once disposed, no further operations should be performed on this scope.
   *
   * @returns true if disposed, false otherwise
   */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Get the scope's instance cache, creating it lazily on first access.
   *
   * This getter ensures O(1) scope creation - the cache is only allocated
   * when the first scoped relic is resolved within this scope.
   *
   * Performance note: Validation check is only performed when accessed, not on creation.
   *
   * @returns MRU cache for scoped instances
   * @throws {ScopeDisposedError} if scope has been disposed
   */
  get cache() {
    if (this.disposed) throw new ScopeDisposedError();
    return (this._cache ??= new MRUCache());
  }

  /**
   * Register a cleanup function to be called when this scope is disposed.
   *
   * The resolver automatically calls this for scoped instances that implement
   * dispose() or close() methods. Disposers are executed in LIFO order during
   * scope disposal.
   *
   * Performance note: Disposed check is O(1) boolean comparison.
   *
   * @param fn - Cleanup function (can be sync or async)
   * @throws {ScopeDisposedError} if scope has already been disposed
   */
  registerDisposer(fn: () => void | Promise<void>) {
    if (this.disposed) throw new ScopeDisposedError();
    if (!this.disposers) this.disposers = new Set(); // lazily create
    this.disposers.add(fn);
  }

  /**
   * Provide a value for a token in this scope.
   *
   * This registers a scope-local value that overrides any vault registration
   * for the given token. The value is only available within this scope and
   * will be disposed when the scope is disposed.
   *
   * If the provided value implements dispose() or close(), it will be
   * automatically registered for cleanup.
   *
   * @param token - Token to register the value for
   * @param value - Instance to provide
   * @param isOverride - Internal flag indicating if this is an override operation
   * @throws {ScopeDisposedError} if scope has already been disposed
   *
   * @example
   * ```typescript
   * const scope = vault.createScope();
   * const dbConnection = await createConnection();
   * scope.provide(ConnectionT, dbConnection);
   * ```
   */
  provide<T>(token: Token<T>, value: T, isOverride = false): void {
    if (this.disposed) throw new ScopeDisposedError();

    // If this is an override, remove the old disposer first
    if (isOverride && this.tokenDisposers?.has(token.id)) {
      const oldDisposer = this.tokenDisposers.get(token.id)!;
      this.disposers?.delete(oldDisposer);
      this.tokenDisposers.delete(token.id);
    }

    // Lazily create local registrations map
    if (!this.localRegistrations) {
      this.localRegistrations = new Map();
    }

    // Create an Entry for this scope-local value
    const entry: Entry = {
      token: token.id,
      ctor: undefined,
      factory: undefined,
      factoryDeps: [],
      metadata: {
        lifecycle: 'transient',
        name: token.id,
        label: String(token),
      },
      summons: [],
      aliases: [],
      instance: value,
      flags: FLAG_HAS_INSTANCE, // Mark as having instance
    };

    this.localRegistrations.set(token.id, entry);

    // Auto-register cleanup if value has dispose() or close()
    if (
      value &&
      (typeof value === 'object' || typeof value === 'function') &&
      (typeof (value as unknown as Disposable).dispose === 'function' ||
        typeof (value as unknown as Disposable).close === 'function')
    ) {
      const disposer = () => {
        const disposeFn =
          (value as unknown as Disposable).dispose ?? (value as unknown as Disposable).close;
        return disposeFn.call(value);
      };

      this.registerDisposer(disposer);

      // Track this disposer by token so it can be removed on override
      if (!this.tokenDisposers) {
        this.tokenDisposers = new Map();
      }
      this.tokenDisposers.set(token.id, disposer);
    }
  }

  /**
   * Check if a token is registered in this scope or the parent vault.
   *
   * Checks scope-local registrations first, then delegates to vault if available.
   *
   * @param token - Token to check
   * @returns true if the token can be resolved, false otherwise
   *
   * @example
   * ```typescript
   * if (scope.has(UserServiceT)) {
   *   const service = scope.resolve(UserServiceT);
   * }
   * ```
   */
  has<T>(token: Token<T>): boolean {
    if (this.disposed) return false;

    // Check scope-local registrations first
    if (this.localRegistrations?.has(token.id)) {
      return true;
    }

    // Delegate to vault if available
    if (this.vault) {
      return this.vault.canResolve(token);
    }

    return false;
  }

  /**
   * Get a scope-local entry by canonical ID if it exists.
   *
   * @param canonical - Canonical token ID
   * @returns Entry if found in scope-local registrations, undefined otherwise
   * @internal Used by Vault during resolution
   */
  getLocalEntry(canonical: CanonicalId): Entry | undefined {
    return this.localRegistrations?.get(canonical);
  }

  /**
   * Try to resolve a token, returning undefined if not found.
   *
   * This is a safe version of resolve() that returns undefined instead of
   * throwing when the token is not registered. Other errors (like circular
   * dependencies or disposal errors) will still be thrown.
   *
   * @param token - Token to resolve
   * @returns Resolved instance or undefined if not found
   *
   * @example
   * ```typescript
   * const logger = scope.tryResolve(LoggerT) ?? console;
   * logger.info('Using fallback logger if needed');
   * ```
   */
  tryResolve<T>(token: Token<T>): T | undefined {
    if (this.disposed) return undefined;

    // Only return undefined when the token cannot be resolved.
    // Let other resolution errors propagate to aid debugging.
    if (!this.has(token)) {
      return undefined;
    }
    return this.resolve(token);
  }

  /**
   * Override an existing registration with a new value.
   *
   * This replaces any existing scope-local or vault registration for the token.
   * If a previous value exists and implements dispose() or close(), the old
   * disposer is automatically removed to prevent memory leaks and duplicate
   * cleanup calls.
   *
   * @param token - Token to override
   * @param value - New value to provide
   * @throws {ScopeDisposedError} if scope has already been disposed
   *
   * @example
   * ```typescript
   * // Override with a mock for testing
   * scope.override(DatabaseT, mockDatabase);
   * ```
   */
  override<T>(token: Token<T>, value: T): void {
    // Pass isOverride flag to trigger old disposer removal
    this.provide(token, value, true);
  }

  /**
   * Resolve a token from this scope.
   *
   * Checks scope-local registrations first, then delegates to vault.
   * This method is designed to be called by the resolver during dependency
   * resolution.
   *
   * @param token - Token to resolve
   * @returns Resolved instance
   * @throws {ScopeDisposedError} if scope has been disposed
   * @throws {RelicNotFoundError} if token is not registered
   *
   * @internal Used by resolver, not intended for direct use
   */
  resolve<T>(token: Token<T>): T {
    if (this.disposed) throw new ScopeDisposedError();

    // Check scope-local registrations first
    const localEntry = this.localRegistrations?.get(token.id);
    if (localEntry && localEntry.flags & FLAG_HAS_INSTANCE) {
      return localEntry.instance as T;
    }

    // Delegate to vault if available
    if (this.vault) {
      return this.vault.resolve(token, { scope: this });
    }

    throw new Error(`Token not found: ${String(token)}`);
  }

  /**
   * Asynchronously resolve a token from this scope.
   *
   * Checks scope-local registrations first, then delegates to vault.
   *
   * @param token - Token to resolve
   * @returns Promise resolving to the instance
   * @throws {ScopeDisposedError} if scope has been disposed
   * @throws {RelicNotFoundError} if token is not registered
   *
   * @internal Used by resolver, not intended for direct use
   */
  async resolveAsync<T>(token: Token<T>): Promise<T> {
    if (this.disposed) throw new ScopeDisposedError();

    // Check scope-local registrations first
    const localEntry = this.localRegistrations?.get(token.id);
    if (localEntry && localEntry.flags & FLAG_HAS_INSTANCE) {
      return localEntry.instance as T;
    }

    // Delegate to vault if available
    if (this.vault) {
      return this.vault.resolveAsync(token, { scope: this });
    }

    throw new Error(`Token not found: ${String(token)}`);
  }

  /**
   * Synchronously dispose all scoped instances in this scope.
   *
   * Calls all registered disposers synchronously and clears the cache.
   * Use this when you know all disposers are synchronous for better performance.
   * If any disposer returns a Promise, it will NOT be awaited.
   *
   * Safe to call multiple times - subsequent calls are no-ops.
   * Once disposed, the scope cannot be reused.
   */
  disposeSync() {
    if (this.disposed) return; // Idempotent - safe to call multiple times
    this.disposed = true;

    if (!this.disposers) {
      // Clear cache if it exists (without triggering getter)
      if (this._cache) this._cache.clear();
      return;
    }

    for (const fn of this.disposers) void fn();
    if (this._cache) this._cache.clear();
    this.disposers = undefined;
  }

  /**
   * Asynchronously dispose all scoped instances in this scope.
   *
   * Calls all registered disposers and awaits any that return Promises.
   * This is the recommended disposal method as it handles both sync and async
   * cleanup safely.
   *
   * Safe to call multiple times - subsequent calls are no-ops.
   * Once disposed, the scope cannot be reused.
   */
  async dispose() {
    if (this.disposed) return; // Idempotent - safe to call multiple times
    this.disposed = true;

    if (!this.disposers) {
      // Clear cache if it exists (without triggering getter)
      if (this._cache) this._cache.clear();
      return;
    }

    for (const fn of this.disposers) {
      const res = fn();
      // Check if result is a Promise using duck typing (avoids instanceof check)
      if (res && typeof (res as Promise<unknown>).then === 'function') await res;
    }
    if (this._cache) this._cache.clear();
    this.disposers = undefined;
  }
}
