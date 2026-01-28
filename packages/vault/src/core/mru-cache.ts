import type { Entry } from './entry-store';

/**
 * Unbounded singleton entry cache.
 *
 * Simplified cache implementation that uses a Map for O(1) lookups without
 * any eviction strategy. This provides maximum performance for workloads
 * where most singletons are accessed frequently.
 *
 * Design rationale:
 * - No LRU/MRU tracking (removed for simplicity and performance)
 * - No capacity limits (suitable for typical DI workloads)
 * - Direct Entry storage (no indirection overhead)
 * - All operations are O(1) with Map's hash table
 *
 * Memory characteristics:
 * - Grows with number of unique tokens resolved
 * - Caches singleton entries indefinitely until clear()
 * - Each entry is a single pointer (minimal overhead)
 */
export class MRUCache {
  /**
   * Primary cache storage: token string -> Entry reference.
   * Stores entries for canonical IDs and all aliases.
   */
  private readonly index = new Map<string, Entry>();

  /**
   * Create a new cache instance.
   *
   * @param _max - Legacy parameter, now ignored. Kept for API compatibility.
   */
  constructor(_max = 8) {
    // Maximum size is no longer enforced. Parameter kept for backward compatibility
    // with code that may pass custom cache sizes.
  }

  /**
   * Retrieve a cached entry by token string.
   *
   * @param token - Token string (canonical ID or alias)
   * @returns Cached Entry if found, undefined otherwise
   */
  get(token: string): Entry | undefined {
    return this.index.get(token);
  }

  /**
   * Add a single token->entry mapping to the cache.
   *
   * @param token - Token string to cache
   * @param entry - Entry metadata to associate with token
   */
  private prime(token: string, entry: Entry): void {
    // Direct Map.set - overwrites existing entry if present.
    // This is idempotent and safe for repeated calls.
    this.index.set(token, entry);
  }

  /**
   * Prime cache with entry and all its aliases.
   *
   * Populates the cache with:
   * 1. The canonical token ID
   * 2. The request token (if different from canonical)
   * 3. All registered aliases
   *
   * This ensures the entry can be found via any of its known names.
   *
   * @param requestToken - The token string used in the original resolve() call
   * @param entry - The Entry to cache
   */
  primeAll(requestToken: string, entry: Entry): void {
    // Step 1: Always prime the canonical ID
    this.prime(entry.token, entry);

    // Step 2: Prime the request token if it differs from canonical
    if (requestToken !== entry.token) {
      this.prime(requestToken, entry);
    }

    // Step 3: Prime all unique aliases that weren't already primed
    if (entry.aliases) {
      for (const alias of entry.aliases) {
        if (alias && alias !== entry.token && alias !== requestToken) {
          this.prime(alias, entry);
        }
      }
    }
  }

  /**
   * Clear all cached entries.
   *
   * Resets the cache to empty state. Useful for testing or when
   * vault entries are modified.
   */
  clear(): void {
    this.index.clear();
  }
}
