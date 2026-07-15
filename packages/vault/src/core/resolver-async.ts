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
 *  - Detect circular dependencies using the provided path and throw a
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
 *    not to shared singleton or scoped creation (prevents one caller's abort from
 *    cancelling creation used by another caller).
 */

import {
  CircularDependencyError,
  ScopeDisposedError,
  ScopedWithoutScopeError,
} from '../errors/errors.js';
import type { Disposable } from '../types/index.js';
import type { Activator } from './activator.js';
import {
  FLAG_HAS_INSTANCE,
  FLAG_OWNS_INSTANCE,
  LIFECYCLE_MASK,
  LIFECYCLE_SCOPED,
  LIFECYCLE_SINGLETON,
} from './flags.js';
import type { Entry } from './entry-store.js';
import type { ResolutionPath } from './resolution-path.js';
import type { Scope } from './scope.js';
import type { Vault } from './vault.js';

/**
 * Convert an AbortSignal into a Promise that rejects with an AbortError when
 * the signal fires. Returns `null` when no signal is provided.
 */
function abortAsPromise(signal?: AbortSignal) {
  if (!signal) return null;
  if (signal.aborted) {
    return {
      promise: Promise.reject(new DOMException('Aborted', 'AbortError')),
      cleanup: () => {},
    };
  }
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    promise,
    cleanup: () => {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    },
  };
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  const abortP = abortAsPromise(signal);
  return Promise.race([promise, abortP!.promise]).finally(abortP!.cleanup);
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

  /** Wait for shared creation, avoiding abort-race allocation without a signal. */
  waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    return raceWithAbort(promise, signal);
  }

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
   * @param entry - Already-loaded local entry to resolve
   * @param path - Dependency path for cycle detection (mutated during traversal)
   * @param signal - Optional AbortSignal for caller-specific cancellation
   * @param scope - Optional scope for scoped lifecycle instances
   * @param boundaryAlreadyValidated - Skip this entry's lifecycle check after cross-vault validation
   * @returns Resolved instance of type T
   */
  async fromEntry<T>(
    entry: Entry,
    path: ResolutionPath,
    signal?: AbortSignal,
    scope?: Scope,
    boundaryAlreadyValidated = false,
    scopeCacheChecked = false,
    scopeCacheEntry?: Entry
  ): Promise<T> {
    const canonical = entry.token;
    const hadParent = path.length !== 0;

    // Detect cycles and produce a helpful cycle trace for diagnostics
    if (!path.tryEnter(canonical)) {
      throw new CircularDependencyError(
        path.cycle(canonical).map((t) => this.vault.describeToken(t))
      );
    }

    try {
      // Extract lifecycle bits once for multiple checks (performance optimization)
      const lifecycleFlags = entry.flags & LIFECYCLE_MASK;

      // Validate lifecycle rules at resolution time (catches order-independent violations)
      if (hadParent && !boundaryAlreadyValidated) {
        this.vault._validateLifecycleRulesForEntry(canonical, entry, path);
      }

      // Singleton lifecycle: Share promise across concurrent requests
      // Lifecycle check: bits 0-1 are 0b00 (LIFECYCLE_SINGLETON)
      if (lifecycleFlags === LIFECYCLE_SINGLETON) {
        // Fast path: hot singleton instance already materialized
        if (entry.flags & FLAG_HAS_INSTANCE) {
          this.vault.cache.primeAll(entry.token, entry);
          return (entry.resolvedPromise ??= Promise.resolve(entry.instance as T)) as Promise<T>;
        }

        // Kick off shared creation only once (promise deduplication)
        if (!entry.promise) {
          // Important: decouple underlying creation from caller's signal so the
          // shared creation continues even if an individual waiter aborts.
          const creationPath = path.fork();
          const creationPromise = Promise.resolve()
            .then(() => this.activator.instantiateAsync(entry, creationPath /* no signal */))
            .then((value) => {
              if (!this.vault._canCommitAsyncCreation()) {
                return this.vault._rejectStaleAsyncCreation(entry, value);
              }

              entry.instance = value;
              entry.flags |= FLAG_HAS_INSTANCE;
              this.vault._trackOwnedInstance(entry);
              this.vault.cache.primeAll(entry.token, entry);
              entry.promise = undefined;
              entry.resolvedPromise = creationPromise;
              return value;
            })
            .catch((error) => {
              // On failure clear the promise so callers can retry later
              if (entry.promise === creationPromise) entry.promise = undefined;
              if (entry.resolvedPromise === creationPromise) entry.resolvedPromise = undefined;
              throw error;
            });
          entry.promise = creationPromise;
        }

        // Per-caller cancellation: await the shared promise but allow the
        // caller to abort their wait without cancelling the shared creation.
        // Race the shared promise against the caller's abort signal.
        // IMPORTANT: do not affect entry.promise — caller only detaches
        return await raceWithAbort(entry.promise as Promise<T>, signal);
      }

      // Scoped lifecycle: Instance per logical scope
      // Lifecycle check: bits 0-1 are 0b01 (LIFECYCLE_SCOPED)
      if (lifecycleFlags === LIFECYCLE_SCOPED) {
        // Validate: Scoped lifecycle requires scope parameter
        // Performance: Single check before instantiation
        if (!scope) {
          const chain = path.tokens.map((id) => this.vault.describeToken(id));
          throw new ScopedWithoutScopeError(entry.token, chain);
        }

        // The scope cache stores both completed instances and in-flight creation.
        // This provides the same deduplication guarantee as singleton resolution.
        let scopedEntry = scopeCacheEntry;
        if (!scopeCacheChecked) scopedEntry = scope._peekCache(entry.token);
        if (scopedEntry !== undefined && scopedEntry.flags & FLAG_HAS_INSTANCE) {
          return scopedEntry.instance as T;
        }

        if (scopedEntry === undefined) {
          scopedEntry = {
            ...entry,
            instance: undefined,
            promise: undefined,
            resolvedPromise: undefined,
            flags: entry.flags & ~FLAG_HAS_INSTANCE,
          };
          scope.cache.primeAll(entry.token, scopedEntry);
        }

        if (!scopedEntry.promise) {
          const creationPath = path.fork();
          let createdValue: unknown;
          let creationSucceeded = false;
          const creationPromise = Promise.resolve()
            .then(() => this.activator.instantiateAsync(entry, creationPath, undefined, scope))
            .then((value) => {
              createdValue = value;
              creationSucceeded = true;
              scopedEntry.instance = value;
              scopedEntry.flags |= FLAG_HAS_INSTANCE;
              scopedEntry.promise = undefined;
              return value;
            })
            .catch((error) => {
              scopedEntry.promise = undefined;
              throw error;
            });

          scopedEntry.promise = creationPromise;

          if (entry.flags & FLAG_OWNS_INSTANCE) {
            const disposeValue = (value: unknown): void | Promise<void> => {
              if (value && (typeof value === 'object' || typeof value === 'function')) {
                const disposer = (value as Disposable).dispose ?? (value as Disposable).close;
                if (typeof disposer === 'function') return disposer.call(value);
              }
            };

            scope.registerDisposer(() => {
              if (creationSucceeded) return disposeValue(createdValue);
              return creationPromise.then(disposeValue, () => undefined);
            });
          }
        }

        const value = await raceWithAbort(scopedEntry.promise as Promise<T>, signal);
        if (scope.isDisposed) throw new ScopeDisposedError();
        return value;
      }

      // Transient lifecycle: Fresh instance every time, no caching
      // Each caller triggers a fresh instantiation which honors the caller's AbortSignal directly.
      const p = Promise.resolve().then(() =>
        this.activator.instantiateAsync(entry, path, signal, scope)
      );
      return await raceWithAbort(p as Promise<T>, signal);
    } finally {
      path.leave(canonical);
    }
  }
}
