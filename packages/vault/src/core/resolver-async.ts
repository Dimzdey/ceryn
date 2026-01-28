/* ResolverAsync
 *
 * Asynchronous resolution helper used by Vault. Responsibilities:
 *  - Collapse concurrent async singleton creation so only the first async
 *    instantiation commits the instance (Entry.promise deduplication).
 *  - Handle scoped lifecycle instances using per-scope caches.
 *  - Support per-caller AbortSignal cancellation without aborting the shared
 *    underlying creation (caller detached cancellation).
 *  - Delegate actual materialization to `Activator.instantiateAsync` which
 *    enforces factory rules and supports async factories.
 *  - Detect circular dependencies using the provided `stack` and throw a
 *    `CircularDependencyError` containing a helpful trace.
 *
 * Lifecycle handling:
 *  - Singleton: First call creates Entry.promise (shared), subsequent calls
 *    await same promise. Instance stored in Entry.instance after completion.
 *  - Scoped: Instance stored in Scope.cache, disposer registered for cleanup
 *  - Transient: Fresh instance every time, no caching, honors caller's signal
 *
 * Performance notes:
 *  - Uses bit flags for fast lifecycle checks (bitwise AND vs string comparison)
 *  - Lifecycle extracted once: `lifecycleFlags = entry.flags & LIFECYCLE_MASK`
 *  - Promise deduplication prevents thundering herd on concurrent singleton requests
 *  - Per-caller signal allows individual timeout without cancelling shared creation
 *
 * Notes:
 *  - On singleton commit we set the `FLAG_HAS_INSTANCE` flag and prime the
 *    vault MRU cache with the canonical token and aliases. If instantiation
 *    throws, `entry.promise` is cleared to allow retrying.
 *  - Scoped entries create a shallow copy to avoid mutating shared Entry metadata.
 *  - AbortSignal is only passed to transient instantiation and individual waiters,
 *    not to the shared singleton creation (prevents one caller's abort from
 *    cancelling another caller's singleton).
 */

import { CircularDependencyError, ScopedWithoutScopeError } from '../errors/errors.js';
import type { Disposable } from '../types';
import type { Activator } from './activator.js';
import {
  FLAG_HAS_INSTANCE,
  LIFECYCLE_MASK,
  LIFECYCLE_SCOPED,
  LIFECYCLE_SINGLETON,
} from './flags.js';
import type { Scope } from './scope.js';
import type { CanonicalId } from './token.js';
import type { Vault } from './vault.js';

/**
 * Convert an AbortSignal into a Promise that rejects with an AbortError when
 * the signal fires. Returns `null` when no signal is provided. The returned
 * promise is intended for use with Promise.race to implement per-caller
 * cancellation semantics.
 */
function abortAsPromise(signal?: AbortSignal) {
  if (!signal) return null;
  if (signal.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise<never>((_, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Asynchronous resolver implementation with promise deduplication and per-caller
 * cancellation support.
 *
 * Promise deduplication strategy:
 *  - For singleton entries: the first caller creates `entry.promise` which
 *    becomes the shared creation promise. Subsequent callers await the same
 *    `entry.promise`, ensuring only one instantiation occurs even with
 *    concurrent requests.
 *  - Per-caller AbortSignal only cancels that caller's await (via
 *    Promise.race) — it does NOT cancel the shared underlying creation. This
 *    prevents races where one caller's cancellation would invalidate another
 *    caller's creation.
 *  - On successful creation the instance is cached in Entry.instance and the
 *    vault MRU cache is primed with both canonical token and aliases.
 *  - Any error during creation clears `entry.promise` so future attempts can
 *    retry; errors are propagated to all waiting callers.
 */
export class ResolverAsync {
  constructor(
    private readonly vault: Vault,
    private readonly activator: Activator
  ) {}

  /**
   * Resolve a canonical token asynchronously.
   *
   * Resolution flow:
   *  1. Check for existing singleton instance (fast path)
   *  2. For singletons without instance: create or await shared Entry.promise
   *  3. Check scoped cache if scope provided and lifecycle is scoped
   *  4. Instantiate via Activator
   *  5. Store in appropriate cache based on lifecycle:
   *     - Singleton: Entry.instance + vault cache + shared Entry.promise
   *     - Scoped: Scope.cache + register disposer
   *     - Transient: No caching, honor caller's signal
   *
   * Behavior contract:
   *  - Throws when the token is not registered locally
   *  - Throws `CircularDependencyError` when a cycle is detected
   *  - Supports optional AbortSignal for per-caller cancellation
   *  - Supports optional scope for Lifecycle.Scoped instances
   *  - Promise deduplication prevents concurrent singleton instantiations
   *
   * @param canonical - Canonical token ID to resolve
   * @param stack - Dependency stack for cycle detection (mutated during traversal)
   * @param signal - Optional AbortSignal for caller-specific cancellation
   * @param scope - Optional scope for scoped lifecycle instances
   * @returns Resolved instance of type T
   */
  async fromEntry<T>(
    canonical: CanonicalId,
    stack: CanonicalId[],
    signal?: AbortSignal,
    scope?: Scope
  ): Promise<T> {
    const entry = this.vault.store.getByCanonical(canonical);
    if (!entry) throw this.vault.buildNotFoundError(canonical, stack);

    // Detect cycles and produce a helpful cycle trace for diagnostics
    if (stack.includes(canonical)) {
      const cycle = stack.slice(stack.indexOf(canonical)).concat(canonical);
      throw new CircularDependencyError(cycle.map((t) => this.vault.describeToken(t)));
    }

    stack.push(canonical);
    try {
      // Extract lifecycle bits once for multiple checks (performance optimization)
      const lifecycleFlags = entry.flags & LIFECYCLE_MASK;

      // Singleton lifecycle: Share promise across concurrent requests
      // Lifecycle check: bits 0-1 are 0b00 (LIFECYCLE_SINGLETON)
      if (lifecycleFlags === LIFECYCLE_SINGLETON) {
        // Fast path: hot singleton instance already materialized
        if (entry.flags & FLAG_HAS_INSTANCE) return entry.instance as T;

        // Kick off shared creation only once (promise deduplication)
        if (!entry.promise) {
          // Important: decouple underlying creation from caller's signal so the
          // shared creation continues even if an individual waiter aborts.
          entry.promise = Promise.resolve()
            .then(() => this.activator.instantiateAsync(entry, stack /* no signal */))
            .then((value) => {
              entry.instance = value;
              entry.flags |= FLAG_HAS_INSTANCE;
              entry.promise = undefined;
              this.vault.cache.primeAll(entry.token, entry);
              return value;
            })
            .catch((err) => {
              // On failure clear the promise so callers can retry later
              entry.promise = undefined;
              throw err;
            });
        }

        // Per-caller cancellation: await the shared promise but allow the
        // caller to abort their wait without cancelling the shared creation.
        // Race the shared promise against the caller's abort signal.
        const abortP = abortAsPromise(signal);
        if (abortP) {
          // IMPORTANT: do not affect entry.promise — caller only detaches
          return (await Promise.race([entry.promise as Promise<T>, abortP])) as T;
        }
        return (await entry.promise) as T;
      }

      // Scoped lifecycle: Instance per logical scope
      // Lifecycle check: bits 0-1 are 0b01 (LIFECYCLE_SCOPED)
      if (lifecycleFlags === LIFECYCLE_SCOPED) {
        // Validate: Scoped lifecycle requires scope parameter
        // Performance: Single check before instantiation
        if (!scope) {
          const chain = stack.map((id) => this.vault.describeToken(id));
          throw new ScopedWithoutScopeError(entry.token, chain);
        }

        // Scoped cache check: return cached instance if available in scope
        const cached = scope.cache.get(entry.token);
        if (cached && cached.flags & FLAG_HAS_INSTANCE) {
          return cached.instance as T;
        }

        // Instantiate via Activator. This enforces factory rules and supports async factories.
        const value = await this.activator.instantiateAsync(entry, stack, signal, scope);

        // Scoped: Store in scope-specific cache and register cleanup
        // Note: Create shallow copy to avoid mutating the shared Entry metadata
        const scopedEntry = {
          ...entry,
          instance: value,
          flags: entry.flags | FLAG_HAS_INSTANCE,
        };
        // Prime scope cache with canonical token and all aliases
        scope.cache.primeAll(entry.token, scopedEntry);

        // Auto-register cleanup: if instance has dispose() or close(), call on scope.dispose()
        if (
          value &&
          (typeof value === 'object' || typeof value === 'function') &&
          (typeof (value as Disposable).dispose === 'function' ||
            typeof (value as Disposable).close === 'function')
        ) {
          scope.registerDisposer(() => {
            const disposer = (value as Disposable).dispose ?? (value as Disposable).close;
            return disposer.call(value);
          });
        }

        return value as T;
      }

      // Transient lifecycle: Fresh instance every time, no caching
      // Each caller triggers a fresh instantiation which honors the caller's AbortSignal directly.
      const p = Promise.resolve().then(() =>
        this.activator.instantiateAsync(entry, stack, signal, scope)
      );
      const abortP = abortAsPromise(signal);
      return (await (abortP ? Promise.race([p, abortP]) : p)) as T;
    } finally {
      stack.pop();
    }
  }
}
