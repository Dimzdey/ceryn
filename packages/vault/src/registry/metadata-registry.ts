/* eslint-disable no-duplicate-imports */
import type { CanonicalId, Token } from '../core/token.js';
import type {
  Constructor,
  InjectionToken,
  ProviderMetadata,
  StaticProviderDefinition,
} from '../types/index.js';
import { Lifecycle } from '../types/index.js';

/**
 * Sentinel for providers with zero constructor dependencies.
 * Avoids allocating empty arrays for every dependency-free provider.
 */
const EMPTY_LINKS: readonly (CanonicalId | undefined)[] = [];

/**
 * Mutable record storing decorator metadata for a single provider.
 *
 * Fields:
 * - metadata: Provider lifecycle, name, label from @Injectable()
 * - links: Parameter index → CanonicalId mapping from @Inject()
 * - deps: Computed array of injections/dependencies (built from links)
 * - cachedDef: Precomputed StaticProviderDefinition for O(1) retrieval
 * - sealed: True if this record is finalized (no more changes expected)
 */
type MutableProviderRecord = {
  metadata: ProviderMetadata;
  links: Map<number, CanonicalId>;
  deps?: readonly (CanonicalId | undefined)[];
  cachedDef?: StaticProviderDefinition;
  sealed?: boolean;
};

/**
 * A bag of provider metadata, optionally isolated by namespace.
 *
 * Fields:
 * - relics: WeakMap for garbage collection of unused constructors
 * - keys: Strong references to prevent GC until explicitly cleared
 * - sealedAll: True if all records have been precomputed (sealAll() called)
 */
type GlobalBag = {
  relics: WeakMap<Constructor, MutableProviderRecord>;
  keys: Set<Constructor>;
  sealedAll: boolean;
};

/**
 * Top-level registry structure supporting multiple namespaces.
 *
 * The default bag is used for production code.
 * Namespaces are used for test isolation or multi-tenant scenarios.
 */
type RegistryStore = {
  defaultBag: GlobalBag;
  namespaces: Map<string, GlobalBag>;
  generation: number;
};

/**
 * Global symbol for storing the metadata registry on globalThis.
 *
 * This ensures a single registry instance per process, even if the module
 * is bundled multiple times (e.g., in monorepos or microfrontends).
 */
const GLOBAL_SYMBOL = Symbol.for('ceryn.staticRelicRegistry');

/**
 * Create a fresh, empty GlobalBag.
 */
function createBag(): GlobalBag {
  return { relics: new WeakMap(), keys: new Set(), sealedAll: false };
}

/**
 * Type guard for GlobalBag (used during store migration).
 *
 * This allows upgrading legacy registry formats to the current RegistryStore
 * structure without breaking existing code.
 */
function isGlobalBag(value: unknown): value is GlobalBag {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, 'relics') &&
    Object.prototype.hasOwnProperty.call(value, 'keys') &&
    (value as GlobalBag).relics instanceof WeakMap &&
    (value as GlobalBag).keys instanceof Set
  );
}

/**
 * Ensure the global registry store exists, upgrading legacy formats if needed.
 *
 * This function:
 * 1. Creates a fresh store if none exists
 * 2. Upgrades legacy GlobalBag to new RegistryStore format
 * 3. Ensures defaultBag and namespaces are present
 *
 * The upgrade path supports migration from older versions that stored
 * GlobalBag directly on globalThis[GLOBAL_SYMBOL].
 */
function ensureStore(): RegistryStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const existing = g[GLOBAL_SYMBOL] as RegistryStore | GlobalBag | undefined;
  if (!existing) {
    const fresh: RegistryStore = { defaultBag: createBag(), namespaces: new Map(), generation: 0 };
    g[GLOBAL_SYMBOL] = fresh;
    return fresh;
  }
  if (isGlobalBag(existing)) {
    const upgraded: RegistryStore = { defaultBag: existing, namespaces: new Map(), generation: 0 };
    g[GLOBAL_SYMBOL] = upgraded;
    return upgraded;
  }
  const store = existing;
  if (!store.defaultBag) store.defaultBag = createBag();
  if (!store.namespaces) store.namespaces = new Map();
  if (store.generation === undefined) store.generation = 0;
  return store;
}

/**
 * Resolve the GlobalBag for a given namespace.
 *
 * @param namespace - Optional namespace for test isolation or multi-tenancy.
 *                    If omitted, returns the default bag.
 * @returns The GlobalBag for the specified namespace.
 */
function resolveBag(namespace?: string): GlobalBag {
  const store = ensureStore();
  if (!namespace) return store.defaultBag;
  let bag = store.namespaces.get(namespace);
  if (!bag) {
    bag = createBag();
    store.namespaces.set(namespace, bag);
  }
  return bag;
}

/**
 * Global registry for decorator-based provider metadata.
 *
 * This registry stores metadata collected by @Injectable() and @Inject() decorators.
 * It lives on globalThis to ensure a single registry per process, even when
 * the module is bundled multiple times (e.g., in monorepos or microfrontends).
 *
 * Architecture:
 * - Decorators call registerProvider() / registerInjection() at module load time
 * - Vault calls buildDefinition() during registration to retrieve metadata
 * - Lazy computation: definitions are built on-demand or precomputed via sealAll()
 *
 * Namespace support:
 * - Default bag: used by production code (no namespace)
 * - Namespaced bags: used for test isolation or multi-tenant scenarios
 */
export class MetadataRegistry {
  /** Monotonic stamp for invalidating compiled/bootstrap metadata summaries. */
  static get stamp(): number {
    return ensureStore().generation;
  }

  /**
   * Register metadata from @Injectable() decorator.
   *
   * This method is called by the @Injectable() decorator during class definition.
   * It stores the provider's name, label, and lifecycle for later retrieval.
   *
   * If a provider is re-registered (e.g., due to hot module reloading), the
   * cached definition is invalidated to force recomputation.
   *
   * @param target - The decorated class constructor
   * @param metadata - Provider metadata (name, label, lifecycle)
   */
  static registerProvider(target: Constructor, metadata: ProviderMetadata): void {
    ensureStore().generation += 1;
    const bag = this.getBag();
    let rec = bag.relics.get(target);
    if (!rec) {
      rec = { metadata, links: new Map() };
      bag.relics.set(target, rec);
      bag.keys.add(target);
    } else {
      rec.metadata = metadata;
      rec.sealed = false;
      rec.cachedDef = undefined;
      rec.deps = undefined;
    }
    if (bag.sealedAll) rec.cachedDef ??= this.buildDef(target, rec);
  }

  /**
   * @deprecated Use registerProvider instead
   */
  static registerRelic(target: Constructor, metadata: ProviderMetadata): void {
    return this.registerProvider(target, metadata);
  }

  /**
   * Register a constructor parameter dependency from @Inject() decorator.
   *
   * This method is called by the @Inject() decorator for each parameter.
   * It records the parameter index → token mapping for dependency injection.
   *
   * If @Injectable() was never called for this class, a fallback record is created
   * with singleton lifecycle. This allows manual registration via providers.
   *
   * @param target - The class constructor with the decorated parameter
   * @param parameterIndex - Zero-based parameter index (from TypeScript)
   * @param token - Injection token for the dependency
   */
  static registerInjection(
    target: Constructor,
    parameterIndex: number,
    token: InjectionToken
  ): void {
    ensureStore().generation += 1;
    const bag = this.getBag();
    let rec = bag.relics.get(target);
    if (!rec) {
      rec = this.createFallbackRecord(target);
      bag.relics.set(target, rec);
      bag.keys.add(target);
    }
    const canonicalId = (token as Token<unknown>).id;
    rec.links.set(parameterIndex, canonicalId);
    rec.sealed = false;
    rec.cachedDef = undefined;
    rec.deps = undefined;
    if (bag.sealedAll) rec.cachedDef ??= this.buildDef(target, rec);
  }

  /**
   * @deprecated Use registerInjection instead
   */
  static registerSummon(target: Constructor, parameterIndex: number, token: InjectionToken): void {
    return this.registerInjection(target, parameterIndex, token);
  }

  /**
   * Build a StaticProviderDefinition for a given constructor.
   *
   * This is the hot path called by Vault during provider registration.
   * Definitions are computed lazily and cached for O(1) retrieval.
   *
   * @param ctor - Class constructor decorated with @Injectable()
   * @returns StaticProviderDefinition or undefined if not decorated
   */
  static buildDefinition(ctor: Constructor): StaticProviderDefinition | undefined {
    const bag = this.getBag();
    const rec = bag.relics.get(ctor);
    if (!rec) return undefined;
    return rec.cachedDef ?? (rec.cachedDef = this.buildDef(ctor, rec));
  }

  /**
   * Precompute all provider definitions at once.
   *
   * This is useful for startup optimization - it converts all decorator
   * metadata into frozen StaticProviderDefinitions in a single pass.
   *
   * After calling sealAll(), future buildDefinition() calls return cached
   * definitions immediately (no lazy computation).
   *
   * Idempotent: safe to call multiple times.
   */
  static sealAll(): void {
    const bag = this.getBag();
    if (bag.sealedAll) return;
    for (const ctor of bag.keys) {
      const rec = bag.relics.get(ctor);
      if (!rec) continue;
      rec.cachedDef ??= this.buildDef(ctor, rec);
      rec.sealed = true;
    }
    bag.sealedAll = true;
  }

  /**
   * Test helper to reset the registry.
   *
   * ⚠️ For test environments only. Alias for reset().
   */
  static resetForTests(): void {
    this.reset();
  }

  /**
   * Clear decorator metadata from the default registry bag.
   *
   * Alias for reset() with clearer teardown semantics.
   */
  static clear(): void {
    this.reset();
  }

  /**
   * Get the GlobalBag for a given namespace.
   *
   * @param namespace - Optional namespace for isolation (defaults to main bag)
   * @returns The GlobalBag for the specified namespace
   */
  static getBag(namespace?: string): GlobalBag {
    return resolveBag(namespace);
  }

  /**
   * Reset the registry bag for a namespace.
   *
   * ⚠️ This is intended for test environments. Calling reset() in production
   * may break decorator metadata for already imported modules.
   *
   * @param namespace - Optional namespace to reset (defaults to main bag)
   */
  static reset(namespace?: string): void {
    const store = ensureStore();
    store.generation += 1;
    if (!namespace) {
      store.defaultBag = createBag();
      return;
    }
    store.namespaces.set(namespace, createBag());
  }

  // ---- internals ----

  /**
   * Build a StaticProviderDefinition from a MutableProviderRecord.
   *
   * This internal method:
   * 1. Computes the dependency array from parameter mappings
   * 2. Freezes the definition for immutability
   * 3. Marks the record as sealed
   *
   * @param ctor - The class constructor
   * @param rec - Mutable record with metadata and parameter links
   * @returns Immutable StaticProviderDefinition
   */
  private static buildDef(ctor: Constructor, rec: MutableProviderRecord): StaticProviderDefinition {
    const deps = rec.deps ?? (rec.deps = this.computeDeps(ctor, rec));
    const def: StaticProviderDefinition = {
      ctor,
      metadata: rec.metadata,
      dependencies: deps,
    };
    rec.sealed = true;
    return def;
  }

  /**
   * Create a fallback record for classes with @Inject() but no @Injectable().
   *
   * This allows manual registration via providers (useClass, useFactory)
   * without requiring @Injectable() decoration.
   *
   * Fallback records use:
   * - Singleton lifecycle (default)
   * - Name prefixed with "fallback:" for debugging
   * - Empty links map (populated by subsequent @Inject() calls)
   *
   * @param target - The class constructor
   * @returns Fallback MutableProviderRecord with singleton lifecycle
   */
  private static createFallbackRecord(target: Constructor): MutableProviderRecord {
    return {
      metadata: {
        name: `fallback:${target.name}` as CanonicalId,
        label: target.name,
        lifecycle: Lifecycle.Singleton,
      },
      links: new Map(),
    };
  }

  /**
   * Compute the dependency array from parameter index → token mappings.
   *
   * The array is constructed with:
   * - Length: highest parameter index + 1
   * - Undefined entries: parameters without @Inject() decorators
   * - CanonicalId entries: parameters with @Inject() decorators
   *
   * Example:
   *   constructor(
   *     @Inject(A) a: A,        // index 0 → 'A'
   *     b: B,                   // index 1 → undefined
   *     @Inject(C) c: C         // index 2 → 'C'
   *   )
   *   Result: ['A', undefined, 'C']
   *
   * Missing @Inject() decorators (undefined entries) will trigger runtime
   * errors during resolution unless the constructor is never called.
   *
   * @param rec - MutableProviderRecord with parameter mappings
   * @returns Readonly array of dependencies (not frozen for performance)
   */
  private static computeDeps(
    ctor: Constructor,
    rec: MutableProviderRecord
  ): readonly (CanonicalId | undefined)[] {
    let max = ctor.length - 1;
    for (const i of rec.links.keys()) if (i > max) max = i;
    if (max < 0) return EMPTY_LINKS;
    const deps = new Array<CanonicalId | undefined>(max + 1);
    deps.fill(undefined);
    for (const [i, token] of rec.links) deps[i] = token;
    return deps; // no freeze (performance)
  }
}

/**
 * @deprecated Use MetadataRegistry instead
 */
export const StaticRelicRegistry = MetadataRegistry;
