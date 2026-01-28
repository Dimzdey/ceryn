/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Vault } from '../core/vault';
import { VaultRegistry } from '../decorators';
import type { Constructor } from '../types/types';

/**
 * The `Genesis` class provides static methods for creating and managing vault instances.
 * It handles lazy vault instantiation, circular dependency detection, and caching.
 *
 * @remarks
 * - Use `Genesis.resolve()` to create a vault from a decorated vault class
 * - Automatically caches vault instances for reuse
 * - Detects and prevents circular vault dependencies
 * - Use `vault.beginScope()` to create scoped resolution contexts
 */
export class Genesis {
  private static lazyVaults = new Map<Constructor, Vault>();
  private static resolving = new Set<Constructor>();
  private static boundLazyResolver?: (vaultClass: Constructor) => Vault;

  /**
   * Get the default lazy resolver function.
   * This resolver is bound once and reused for all vault instantiations.
   *
   * @internal
   */
  private static getDefaultLazyResolver(): (vaultClass: Constructor) => Vault {
    if (!this.boundLazyResolver) {
      this.boundLazyResolver = (vaultClass: Constructor) => this.from(vaultClass);
    }
    return this.boundLazyResolver;
  }

  /**
   * Resolve a decorated vault class into a Vault instance.
   *
   * Features:
   * - Caches vault instances (only created once)
   * - Lazy fusion resolution (fused vaults instantiated on-demand)
   * - Circular dependency detection
   * - Automatic lazy resolver injection
   *
   * @param vaultClass - Decorated vault class (must have @Vault decorator)
   * @returns Cached or newly created Vault instance
   *
   * @throws Error if vault class is not decorated
   * @throws Error if circular vault dependency detected
   *
   * @example
   * ```typescript
   * @Vault({ relics: [UserService], reveal: [UserServiceT] })
   * class AppVault {}
   *
   * const vault = Genesis.resolve(AppVault);
   * const service = vault.resolve(UserServiceT);
   * ```
   */
  static from(vaultClass: Constructor): Vault {
    const resolver = this.getDefaultLazyResolver();
    Vault.setDefaultLazyResolver(resolver);

    // Return cached instance if exists
    if (this.lazyVaults.has(vaultClass)) {
      return this.lazyVaults.get(vaultClass)!;
    }

    // Detect circular dependencies
    if (this.resolving.has(vaultClass)) {
      const chain = Array.from(this.resolving)
        .map((c) => c.name)
        .join(' → ');
      throw new Error(`Circular vault dependency detected: ${chain} → ${vaultClass.name}`);
    }

    // Mark as resolving
    this.resolving.add(vaultClass);

    try {
      // Get vault config from registry
      const config = VaultRegistry.get(vaultClass);
      if (!config) throw new Error(`${vaultClass.name} is not a decorated vault`);

      // Pass through vault classes for lazy resolution
      const fusions =
        config.fuse?.map((fused) => {
          if (fused instanceof Vault) return fused;
          return fused; // Leave constructor functions for lazy resolution
        }) ?? [];

      // Create vault instance with lazy resolver
      const lazyResolver = config.lazyResolve ?? resolver;
      const vault = new Vault({
        ...config,
        fuse: fusions as any,
        lazyResolve: lazyResolver,
      });

      // Cache and return
      this.lazyVaults.set(vaultClass, vault);
      return vault;
    } finally {
      // Remove from resolving set
      this.resolving.delete(vaultClass);
    }
  }

  /**
   * Clear all cached vault instances.
   *
   * ⚠️ Use with caution - this will force re-instantiation of all vaults.
   * Primarily useful for testing environments.
   *
   * @internal
   */
  static clearCache(): void {
    this.lazyVaults.clear();
    this.resolving.clear();
  }
}
