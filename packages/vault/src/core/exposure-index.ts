import type { CanonicalId } from './token.js';
import type { Vault } from './vault.js';

/**
 * Cross-vault exposure index.
 *
 * Maintains fast lookup maps for tokens exposed by fused vaults, enabling
 * efficient cross-vault dependency resolution. Separates aether (transitive)
 * from explicit reveal exposures.
 *
 * Responsibilities:
 * - Index all exposed tokens from fused vaults
 * - Maintain aether (transitive) vs revealed (explicit) separation
 * - Track computation state and version for cache invalidation
 * - Prevent redundant traversal of vault fusion graphs
 *
 * Design notes:
 * - Uses iterative DFS to avoid stack overflow on deep fusion graphs
 * - WeakMap/WeakSet for automatic memory cleanup of vault references
 * - Version stamping for shadow policy cache invalidation
 */
export class ExposureIndex {
  /**
   * Aether exposure map: token -> vault/canonical reference.
   * Contains transitively exposed tokens from aether vaults.
   */
  private readonly aether = new Map<string, { vault: Vault; canonical: CanonicalId }>();

  /**
   * Explicit reveal map: token -> vault/canonical reference.
   * Contains explicitly revealed tokens from non-aether vaults.
   */
  private readonly revealed = new Map<string, { vault: Vault; canonical: CanonicalId }>();

  /** Computation complete flag (prevents redundant indexing) */
  private computed = false;

  /**
   * Pair tracking cache: prevents re-processing vault pairs.
   * WeakMap ensures vaults can be GC'd when no longer referenced.
   */
  private pairCache: WeakMap<Vault, WeakSet<Vault>> = new WeakMap();

  /**
   * Visited vaults set: prevents cycles in fusion graph traversal.
   * WeakSet allows automatic cleanup.
   */
  private visited: WeakSet<Vault> = new WeakSet();

  /** Version counter: incremented on each compute() for cache invalidation */
  private version = 0;

  /**
   * Public accessor for aether exposure map.
   * Used by resolution logic to find transitively exposed tokens.
   */
  get aetherMap() {
    return this.aether;
  }

  /**
   * Public accessor for explicit reveal map.
   * Used by resolution logic to find explicitly revealed tokens.
   */
  get revealedMap() {
    return this.revealed;
  }

  /**
   * Check if exposure has been computed.
   * Used to avoid redundant computation calls.
   */
  get isComputed() {
    return this.computed;
  }

  /**
   * Current version stamp.
   * Used by shadow policy checker to invalidate its cache.
   */
  get stamp(): number {
    return this.version;
  }

  /**
   * Compute exposure index for a vault fusion graph.
   *
   * Performs iterative DFS traversal of the fusion graph, indexing all
   * exposed tokens by type (aether vs revealed). Idempotent - returns
   * immediately if already computed.
   *
   * @param root - The root vault to index from
   * @returns The new version stamp
   */
  compute(root: Vault): number {
    if (this.computed) return this.version;

    // Iterative DFS to avoid stack overflow on deep fusion graphs
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      if (!current) continue;

      // Skip already-visited vaults (prevents cycles)
      if (this.visited.has(current)) continue;
      this.visited.add(current);

      // Index this vault's exposed tokens
      this.indexVault(current);

      // Add unprocessed fused vaults to stack
      for (const fused of current.fusedVaults) {
        if (this.markPair(current, fused)) continue; // Skip if pair seen
        stack.push(fused);
      }
    }

    this.computed = true;
    this.version += 1;
    return this.version;
  }

  /**
   * Clear all indexed data and reset state.
   *
   * Used when vault structure changes or for cleanup.
   */
  clear() {
    this.aether.clear();
    this.revealed.clear();
    this.computed = false;
    this.pairCache = new WeakMap();
    this.visited = new WeakSet();
  }

  /**
   * Index a single vault's exposed tokens.
   *
   * Adds tokens to either aether or revealed map based on vault's aether flag.
   * Includes all aliases for each exposed token.
   *
   * @param vault - Vault to index
   */
  private indexVault(vault: Vault): void {
    // Choose target map based on aether flag
    const target = vault.isAetherHost ? this.aether : this.revealed;

    // Index each revealed token
    for (const canonical of vault.revealedTokens) {
      const entry = vault.store.getByCanonical(canonical);
      if (!entry) continue;

      const ref = { vault, canonical } as const;

      // Add canonical and all aliases to target map (first-wins semantics)
      if (!target.has(canonical)) {
        target.set(canonical, ref);
        for (const alias of entry.aliases) {
          if (!target.has(alias)) target.set(alias, ref);
        }
      }
    }
  }

  /**
   * Mark a vault pair as processed.
   *
   * Tracks which vault->vault edges have been traversed to prevent
   * redundant processing of the same fusion relationship.
   *
   * @param from - Source vault
   * @param to - Target vault
   * @returns true if pair was already marked, false if newly marked
   */
  private markPair(from: Vault, to: Vault): boolean {
    let set = this.pairCache.get(from);
    if (!set) {
      set = new WeakSet();
      this.pairCache.set(from, set);
    }
    if (set.has(to)) return true;
    set.add(to);
    return false;
  }
}
