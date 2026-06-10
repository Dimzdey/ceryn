/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Vault } from '../core/vault.js';
import { ModuleRegistry } from '../decorators/index.js';
import type { Constructor } from '../types/types.js';

/**
 * The `Container` class provides static methods for creating and managing vault instances.
 * It handles lazy module instantiation, circular dependency detection, and caching.
 *
 * @remarks
 * - Use `Container.from()` to create a vault from a decorated module class
 * - Automatically caches vault instances for reuse
 * - Detects and prevents circular module dependencies
 * - Use `vault.createScope()` to create scoped resolution contexts
 */
export class Container {
  private static lazyVaults = new Map<Constructor, Vault>();
  private static resolving = new Set<Constructor>();
  private static boundLazyResolver?: (moduleClass: Constructor) => Vault;

  /**
   * Get the default lazy resolver function.
   * This resolver is bound once and reused for all vault instantiations.
   *
   * @internal
   */
  private static getDefaultLazyResolver(): (moduleClass: Constructor) => Vault {
    if (!this.boundLazyResolver) {
      this.boundLazyResolver = (moduleClass: Constructor) => this.from(moduleClass);
    }
    return this.boundLazyResolver;
  }

  /**
   * Resolve a decorated module class into a Vault instance.
   *
   * Features:
   * - Caches vault instances (only created once)
   * - Lazy import resolution (imported modules instantiated on-demand)
   * - Circular dependency detection
   * - Automatic lazy resolver injection
   *
   * @param moduleClass - Decorated module class (must have @Module decorator)
   * @returns Cached or newly created Vault instance
   *
   * @throws Error if module class is not decorated
   * @throws Error if circular module dependency detected
   *
   * @example
   * ```typescript
   * @Module({ providers: [UserService], exports: [UserServiceT] })
   * class AppModule {}
   *
   * const vault = Container.from(AppModule);
   * const service = vault.resolve(UserServiceT);
   * ```
   */
  static from(moduleClass: Constructor): Vault {
    const resolver = this.getDefaultLazyResolver();
    Vault.setDefaultLazyResolver(resolver);

    // Return cached instance if exists
    if (this.lazyVaults.has(moduleClass)) {
      return this.lazyVaults.get(moduleClass)!;
    }

    // Detect circular dependencies
    if (this.resolving.has(moduleClass)) {
      const chain = Array.from(this.resolving)
        .map((c) => c.name)
        .join(' → ');
      throw new Error(`Circular vault dependency detected: ${chain} → ${moduleClass.name}`);
    }

    // Mark as resolving
    this.resolving.add(moduleClass);

    try {
      // Get module config from registry
      const config = ModuleRegistry.get(moduleClass);
      if (!config) throw new Error(`${moduleClass.name} is not a decorated vault`);

      // Pass through module classes for lazy resolution
      const imports =
        config.imports?.map((imported) => {
          if (imported instanceof Vault) return imported;
          return imported; // Leave constructor functions for lazy resolution
        }) ?? [];

      // Create vault instance with lazy resolver
      const lazyResolver = config.lazyResolve ?? resolver;
      const vault = new Vault({
        ...config,
        imports: imports as any,
        lazyResolve: lazyResolver,
      });

      // Cache and return
      this.lazyVaults.set(moduleClass, vault);
      return vault;
    } finally {
      // Remove from resolving set
      this.resolving.delete(moduleClass);
    }
  }

  /**
   * Clear all cached vault instances.
   *
   * ⚠️ Use with caution - this will force re-instantiation of all modules.
   * Primarily useful for testing environments.
   *
   * @internal
   */
  static clearCache(): void {
    this.lazyVaults.clear();
    this.resolving.clear();
  }
}

/** @deprecated Use Container instead */
export const Genesis = Container;
