import { CircularModuleAttachmentError } from '../errors/errors.js';
import type { CanonicalId } from './token.js';
import type { Vault } from './vault.js';

type ExposureRef = { vault: Vault; canonical: CanonicalId };
const COMPUTATION_PATH: Vault[] = [];

/**
 * Cross-module exposure index.
 *
 * Maintains fast lookup maps for tokens exposed by imported modules, enabling
 * efficient cross-module dependency resolution. Separates global (transitive)
 * from explicit export exposures.
 *
 * Responsibilities:
 * - Index explicit exports from direct imports
 * - Index providers from global modules transitively
 * - Maintain global (transitive) vs exported (explicit) separation
 * - Track computation state and version for cache invalidation
 * - Compose exposure from already-computed direct-import summaries
 *
 * Design notes:
 * - Imported vaults are initialized before their parents
 * - Parent computation does not traverse descendant import graphs
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

  /** Active-computation guard for explicitly recomputed mutable import graphs. */
  private computing = false;

  /** Retained direct-import array and last successful shallow snapshot. */
  private directImports?: Vault[];
  private importSnapshot?: Vault[];

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
   * Explicit exports are indexed only from direct imports, preserving module
   * boundaries and requiring intermediate modules to re-export dependencies.
   * Global providers are inherited from each direct import's computed summary.
   *
   * @param root - The root vault to index from
   * @returns The new version stamp
   */
  compute(root: Vault): number {
    let imports: Vault[];
    if (this.computed) {
      imports = this.directImports!;
      if (!this.importsChanged(imports)) return this.version;
      this.clear();
    } else {
      imports = root.importedModules;
      // A previous attempt may have indexed earlier imports before a later
      // import failed. Every fresh attempt must start from an empty summary.
      this.global.clear();
      this.exported.clear();
      this.duplicates.clear();
    }

    if (this.computing) {
      const cycleStart = COMPUTATION_PATH.indexOf(root);
      const cycleVaults =
        cycleStart >= 0 ? COMPUTATION_PATH.slice(cycleStart) : COMPUTATION_PATH.slice();
      throw new CircularModuleAttachmentError([
        ...cycleVaults.map((vault) => vault.getName()),
        root.getName(),
      ]);
    }

    this.computing = true;
    COMPUTATION_PATH.push(root);
    try {
      // Direct imports define the explicit module boundary. Each import is fully
      // initialized, so its global map summarizes all transitive global exposure.
      for (let i = imports.length - 1; i >= 0; i--) {
        if (!(i in imports)) continue;
        const imported = imports[i];
        imported.exposure.compute(imported);
        this.indexExplicitExports(imported);
        if (imported.isGlobal) this.indexGlobalVault(imported);
        this.mergeGlobalExposures(imported);
      }

      this.computed = true;
      this.directImports = imports;
      this.importSnapshot = imports.slice();
      this.version += 1;
      return this.version;
    } finally {
      COMPUTATION_PATH.pop();
      this.computing = false;
    }
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
    this.directImports = undefined;
    this.importSnapshot = undefined;
  }

  /** Compare the retained direct-import array without reading the public property. */
  private importsChanged(imports: Vault[]): boolean {
    const snapshot = this.importSnapshot;
    if (!snapshot || imports.length !== snapshot.length) return true;

    for (let i = 0; i < imports.length; i++) {
      const hasImport = i in imports;
      if (hasImport !== i in snapshot) return true;
      if (hasImport && imports[i] !== snapshot[i]) return true;
    }
    return false;
  }

  /** Index exports declared by one direct import, including intentional re-exports. */
  private indexExplicitExports(vault: Vault): void {
    for (const canonical of vault.exportedTokens) {
      const ref = this.resolveExportRef(vault, canonical);
      if (ref) {
        const aliases = ref.vault.store.getByCanonical(ref.canonical)?.aliases ?? [];
        this.addExposure(this.exported, canonical, ref, aliases);
      }
    }
  }

  /** Index every local provider owned by a transitive global module. */
  private indexGlobalVault(vault: Vault): void {
    for (const canonical of vault.store.canonicalKeys()) {
      const entry = vault.store.getByCanonical(canonical);
      if (!entry) continue;
      this.addExposure(this.global, canonical, { vault, canonical }, entry.aliases);
    }
  }

  /** Merge transitive global providers summarized by one direct import. */
  private mergeGlobalExposures(vault: Vault): void {
    for (const [token, ref] of vault.exposure.globalMap) {
      const existing = this.global.get(token);
      if (existing) this.recordDuplicate(ref.canonical, existing, ref);
      else this.global.set(token, ref);
    }

    this.mergeGlobalDuplicates(vault);
  }

  /** Preserve ambiguity between transitive global providers in a summary. */
  private mergeGlobalDuplicates(vault: Vault): void {
    for (const [canonical, producers] of vault.exposure.duplicateMap) {
      let globalProducerCount = 0;
      for (const producer of producers.values()) {
        if (producer.isGlobal) globalProducerCount++;
      }
      if (globalProducerCount < 2) continue;

      let merged = this.duplicates.get(canonical);
      if (!merged) {
        merged = new Map<string, Vault>();
        this.duplicates.set(canonical, merged);
      }
      for (const [name, producer] of producers) {
        if (producer.isGlobal) merged.set(name, producer);
      }
    }
  }

  /** Resolve a direct import's local export or the producer behind a re-export. */
  private resolveExportRef(vault: Vault, canonical: CanonicalId): ExposureRef | undefined {
    if (vault.store.has(canonical)) return { vault, canonical };
    return vault.exposure.globalMap.get(canonical) ?? vault.exposure.exportedMap.get(canonical);
  }

  private addExposure(
    target: Map<string, ExposureRef>,
    canonical: CanonicalId,
    ref: ExposureRef,
    aliases: readonly string[] = []
  ): void {
    const existing = target.get(canonical);
    if (existing) {
      this.recordDuplicate(canonical, existing, ref);
      return;
    }

    target.set(canonical, ref);
    for (const alias of aliases) {
      const existingAlias = target.get(alias);
      if (existingAlias) this.recordDuplicate(canonical, existingAlias, ref);
      else target.set(alias, ref);
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
}
