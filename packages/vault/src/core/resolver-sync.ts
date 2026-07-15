/* ResolverSync
 *
 * Synchronous resolution helper used by Vault. Responsibilities:
 *  - Collapse synchronous singleton construction so only the first sync
 *    instantiation commits the instance.
 *  - Handle scoped lifecycle instances using per-scope caches.
 *  - Delegate actual materialization to `Activator.instantiateSync` which
 *    enforces factory rules and throws on async factories.
 *  - Detect circular dependencies using the provided `stack` and throw a
 *    `CircularDependencyError` containing a helpful trace.
 *
 * Lifecycle handling:
 *  - Singleton: Instance stored in Entry.instance, cached in vault MRU cache
 *  - Scoped: Instance stored in Scope.cache, disposer registered for cleanup
 *  - Transient: Fresh instance every time, no caching
 *
 * Performance notes:
 *  - Uses bit flags for fast lifecycle checks (bitwise AND vs string comparison)
 *  - Lifecycle extracted once: `lifecycleFlags = entry.flags & LIFECYCLE_MASK`
 *  - Cache lookups happen before instantiation for maximum efficiency
 *
 * Notes:
 *  - This module deliberately avoids any async/cancellation semantics — those
 *    are handled by `resolver-async.ts` and `Activator.instantiateAsync`.
 *  - On singleton commit we set the `FLAG_HAS_INSTANCE` flag and prime the
 *    vault MRU cache with the canonical token and aliases. If instantiation
 *    throws, no state is mutated which allows retrying.
 *  - Scoped entries create a shallow copy to avoid mutating shared Entry metadata.
 */

import { CircularDependencyError, ScopedWithoutScopeError } from '../errors/errors.js';
import type { Disposable } from '../types/index.js';
import type { Activator } from './activator.js';
import type { Entry } from './entry-store.js';
import {
  FLAG_HAS_INSTANCE,
  FLAG_OWNS_INSTANCE,
  LIFECYCLE_MASK,
  LIFECYCLE_SCOPED,
  LIFECYCLE_SINGLETON,
} from './flags.js';
import type { ResolutionPath } from './resolution-path.js';
import type { Scope } from './scope.js';
import type { Vault } from './vault.js';

export class ResolverSync {
  constructor(
    private readonly vault: Vault,
    private readonly activator: Activator
  ) {}

  /**
   * Resolve a canonical token synchronously.
   *
   * Resolution flow:
   *  1. Check for existing singleton instance (fast path)
   *  2. Check scoped cache if scope provided and lifecycle is scoped
   *  3. Instantiate via Activator
   *  4. Store in appropriate cache based on lifecycle:
   *     - Singleton: Entry.instance + vault cache
   *     - Scoped: Scope.cache + register disposer
   *     - Transient: No caching
   *
   * Behavior contract:
   *  - Throws when the token is not registered locally
   *  - Throws `CircularDependencyError` when a cycle is detected
   *  - Throws when a factory incorrectly attempts to return a Promise in the
   *    sync path (this is enforced by the Activator)
   *  - Supports optional scope for Lifecycle.Scoped instances
   *
   * @param entry - Already-loaded local entry to resolve
   * @param stack - Dependency stack for cycle detection (mutated during traversal)
   * @param scope - Optional scope for scoped lifecycle instances
   * @param boundaryAlreadyValidated - Skip this entry's lifecycle check after cross-vault validation
   * @returns Resolved instance of type T
   */
  fromEntry<T>(
    entry: Entry,
    path: ResolutionPath,
    scope?: Scope,
    boundaryAlreadyValidated = false,
    scopeCacheChecked = false,
    scopeCacheEntry?: Entry
  ): T {
    const canonical = entry.token;
    const hadParent = path.length !== 0;

    // Detect dependency cycles early with the current canonical token.
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

      // Fast path: hot singleton instance already materialized
      // Check: lifecycle is singleton (0b00) AND instance flag is set
      if (lifecycleFlags === LIFECYCLE_SINGLETON && entry.flags & FLAG_HAS_INSTANCE) {
        this.vault.cache.primeAll(entry.token, entry);
        return entry.instance as T;
      }

      // Scoped cache check: return cached instance if available in scope
      let cached = scopeCacheEntry;
      if (lifecycleFlags === LIFECYCLE_SCOPED && scope) {
        if (!scopeCacheChecked) cached = scope._peekCache(entry.token);
        if (cached !== undefined && cached.flags & FLAG_HAS_INSTANCE) {
          return cached.instance as T;
        }
      }

      // Validate: Scoped lifecycle requires scope parameter
      // Performance: Single bit check before instantiation
      if (lifecycleFlags === LIFECYCLE_SCOPED && !scope) {
        const chain = path.tokens.map((id) => this.vault.describeToken(id));
        throw new ScopedWithoutScopeError(entry.token, chain);
      }

      // Instantiate via Activator. This enforces factory rules and throws if a
      // sync path mistakenly returns a Promise.
      const value = this.activator.instantiateSync(entry, path, scope);

      // Singleton: Commit instance to shared Entry and prime vault MRU cache
      // Lifecycle check: bits 0-1 are 0b00 (LIFECYCLE_SINGLETON)
      if ((entry.flags & LIFECYCLE_MASK) === 0) {
        entry.instance = value;
        entry.flags |= FLAG_HAS_INSTANCE;
        this.vault._trackOwnedInstance(entry);
        // Prime cache with canonical token and all aliases for fast future lookups
        this.vault.cache.primeAll(entry.token, entry);
      }

      // Scoped: Store in scope-specific cache and register cleanup
      // Note: Create shallow copy to avoid mutating the shared Entry metadata
      if (lifecycleFlags === LIFECYCLE_SCOPED && scope) {
        const scopedEntry: Entry = {
          ...entry,
          instance: value,
          promise: undefined,
          resolvedPromise: undefined,
          flags: entry.flags | FLAG_HAS_INSTANCE,
        };
        // Prime scope cache with canonical token and all aliases
        scope.cache.primeAll(entry.token, scopedEntry);

        // Auto-register cleanup: if instance has dispose() or close(), call on scope.dispose()
        if (
          value &&
          entry.flags & FLAG_OWNS_INSTANCE &&
          (typeof value === 'object' || typeof value === 'function') &&
          (typeof (value as Disposable).dispose === 'function' ||
            typeof (value as Disposable).close === 'function')
        ) {
          scope.registerDisposer(() => {
            const disposer = (value as Disposable).dispose ?? (value as Disposable).close;
            return disposer.call(value);
          });
        }
      }

      // Transient: Return value without caching (falls through to return statement)

      return value as T;
    } finally {
      path.leave(canonical);
    }
  }
}
