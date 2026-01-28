/* Scope
 *
 * Represents a logical request scope that isolates relic instances with
 * Lifecycle.Scoped from each other while sharing Lifecycle.Singleton instances.
 *
 * Purpose:
 *  - Provide per-request or per-operation isolation for stateful services
 *  - Automatically clean up resources when the scope ends
 *  - Enable safe concurrent request handling in server environments
 *
 * Design:
 *  - Each scope has its own MRU cache for scoped relic instances
 *  - Lazy initialization: cache and disposers only created when first used
 *  - Disposers automatically registered for instances with dispose() or close()
 *  - dispose() or disposeSync() cleans up all scoped instances in LIFO order
 *  - Scope creation is O(1) - no upfront allocation
 *
 * Lifecycle interaction:
 *  - Singleton relics: Shared globally, NOT stored in scope cache
 *  - Scoped relics: Isolated per scope, stored in scope cache
 *  - Transient relics: Fresh instance every time, never cached
 *
 * Usage example:
 * ```typescript
 * // HTTP request handler
 * async function handleRequest(req: Request) {
 *   const scope = AppVault.beginScope();
 *   try {
 *     const controller = genesis.resolve(ControllerT, { scope });
 *     return await controller.handle(req);
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
 */

import { ScopeDisposedError } from '../errors/errors.js';
import { MRUCache } from './mru-cache.js';

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
   * MRU cache for scoped relic instances.
   * Lazily allocated - undefined until first scoped relic is resolved.
   */
  private _cache?: MRUCache;

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
