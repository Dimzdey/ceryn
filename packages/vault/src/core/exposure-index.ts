import type { CanonicalId } from './token.js';
import type { Vault } from './vault.js';

type ExposureRef = { vault: Vault; canonical: CanonicalId };

/**
 * Cross-module exposure index.
 *
 * Maintains fast lookup maps for tokens exposed by imported modules, enabling
 * efficient cross-module dependency resolution. Separates global (transitive)
 * from explicit export exposures.
 *
 * Responsibilities:
 * - Index all exposed tokens from imported modules
 * - Maintain global (transitive) vs exported (explicit) separation
 * - Track computation state and version for cache invalidation
 * - Prevent redundant traversal of module import graphs
 *
 * Design notes:
 * - Uses iterative DFS to avoid stack overflow on deep import graphs
 * - WeakMap/WeakSet for automatic memory cleanup of vault references
 * - Version stamping for shadow policy cache invalidation
 */
export class ExposureIndex {
  /**
   * Global exposure map: token -> vault/canonical reference.
   * Contains transitively exposed tokens from global modules.
   */
  private readonly global = new Map<string, ExposureRef>();

  /**
   * Explicit export map: token -> vault/canonical reference.
   * Contains explicitly exported tokens from non-global modules.
   */
  private readonly exported = new Map<string, ExposureRef>();

  /** Duplicate visible imported providers discovered during indexing. */
  private readonly duplicates = new Map<CanonicalId, Map<string, Vault>>();

  /** Computation complete flag (prevents redundant indexing) */
  private computed = false;

  /**
   * Pair tracking cache: prevents re-processing vault pairs.
   * WeakMap ensures vaults can be GC'd when no longer referenced.
   */
  private pairCache: WeakMap<Vault, WeakSet<Vault>> = new WeakMap();

  /**
   * Visited vaults set: prevents cycles in import graph traversal.
   * WeakSet allows automatic cleanup.
   */
  private visited: WeakSet<Vault> = new WeakSet();

  /** Version counter: incremented on each compute() for cache invalidation */
  private version = 0;

  /**
   * Public accessor for global exposure map.
   * Used by resolution logic to find transitively exposed tokens.
   */
  get globalMap(): ReadonlyMap<string, ExposureRef> {
    return this.global;
  }

  /** @deprecated Use globalMap instead */
  get aetherMap() {
    return this.global;
  }

  /**
   * Public accessor for explicit export map.
   * Used by resolution logic to find explicitly exported tokens.
   */
  get exportedMap(): ReadonlyMap<string, ExposureRef> {
    return this.exported;
  }

  get duplicateMap(): ReadonlyMap<CanonicalId, ReadonlyMap<string, Vault>> {
    return this.duplicates;
  }

  getDuplicateExposures(): Array<{ canonical: CanonicalId; producerNames: string[] }> {
    return Array.from(this.duplicates, ([canonical, producers]) => ({
      canonical,
      producerNames: Array.from(producers.keys()),
    }));
  }

  /** @deprecated Use exportedMap instead */
  get revealedMap() {
    return this.exported;
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
   * Compute exposure index for a module import graph.
   *
   * Performs iterative DFS traversal of the import graph, indexing all
   * exposed tokens by type (global vs exported). Idempotent - returns
   * immediately if already computed.
   *
   * @param root - The root vault to index from
   * @returns The new version stamp
   */
  compute(root: Vault): number {
    if (this.computed) return this.version;

    // Iterative DFS to avoid stack overflow on deep import graphs
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      if (!current) continue;

      // Skip already-visited vaults (prevents cycles)
      if (this.visited.has(current)) continue;
      this.visited.add(current);

      // Index this vault's exposed tokens
      this.indexVault(current);

      // Add unprocessed imported modules to stack
      for (const imported of current.importedModules) {
        if (this.markPair(current, imported)) continue; // Skip if pair seen
        stack.push(imported);
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
    this.global.clear();
    this.exported.clear();
    this.duplicates.clear();
    this.computed = false;
    this.pairCache = new WeakMap();
    this.visited = new WeakSet();
  }

  /**
   * Index a single vault's exposed tokens.
   *
   * Adds tokens to either global or exported map based on vault's global flag.
   * Includes all aliases for each exposed token.
   *
   * @param vault - Vault to index
   */
  private indexVault(vault: Vault): void {
    // Choose target map based on global flag
    const target = vault.isGlobal ? this.global : this.exported;
    const exposedTokens = vault.isGlobal ? vault.store.canonicalKeys() : vault.exportedTokens;

    // Global modules expose all local providers; non-global modules expose exports only.
    for (const canonical of exposedTokens) {
      const entry = vault.store.getByCanonical(canonical);
      if (!entry) continue;

      const ref = { vault, canonical } as const;

      // Add canonical and all aliases to target map (first-wins semantics)
      const existing = target.get(canonical);
      if (existing) {
        this.recordDuplicate(canonical, existing, ref);
      } else {
        target.set(canonical, ref);
        for (const alias of entry.aliases) {
          const existingAlias = target.get(alias);
          if (existingAlias) this.recordDuplicate(canonical, existingAlias, ref);
          else target.set(alias, ref);
        }
      }
    }
  }

  private recordDuplicate(token: CanonicalId, first: ExposureRef, second: ExposureRef): void {
    if (first.vault === second.vault && first.canonical === second.canonical) return;

    let producers = this.duplicates.get(token);
    if (!producers) {
      producers = new Map<string, Vault>();
      this.duplicates.set(token, producers);
    }

    producers.set(first.vault.getName(), first.vault);
    producers.set(second.vault.getName(), second.vault);
  }

  /**
   * Mark a vault pair as processed.
   *
   * Tracks which vault->vault edges have been traversed to prevent
   * redundant processing of the same import relationship.
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
