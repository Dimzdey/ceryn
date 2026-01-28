/* eslint-disable @typescript-eslint/no-explicit-any */
import { Scope } from '../core/scope';
import type { Constructor, VaultConfig } from '../types/types';

/**
 * Retrieve vault configuration from a decorated vault class.
 *
 * @param target - Vault class constructor
 * @returns VaultConfig if present, undefined otherwise
 */
export function getVaultConfig(target: Constructor): VaultConfig | undefined {
  return (target as any).__vaultCfg__;
}

/**
 * Check if a class has vault configuration attached.
 *
 * @param target - Class constructor to check
 * @returns true if class has __vaultCfg__ property
 */
export function hasVaultConfig(target: Constructor): boolean {
  return !!(target as any).__vaultCfg__;
}

/**
 * Registry for vault metadata lookups.
 *
 * Provides static methods to check and retrieve vault configurations
 * from decorated classes.
 */
export class VaultRegistry {
  static get = getVaultConfig;
  static has = hasVaultConfig;
}
/**
 * Decorator to mark a class as a Vault container.
 *
 * Attaches VaultConfig metadata to the class at module load time, enabling
 * declarative vault definitions that can be bootstrapped lazily by Genesis.
 *
 * Features:
 * - Declarative dependency injection configuration
 * - Lazy vault instantiation (vaults created on-demand)
 * - Vault fusion for modular architecture
 * - Aether mode for transitive exposure
 * - Automatic scope lifecycle management
 *
 * The decorator:
 * 1. Attaches config to class as __vaultCfg__ property
 * 2. Sets vault name to class name if not provided
 * 3. Adds static beginScope() method for scope creation
 *
 * @param config - Vault configuration (defaults to empty)
 * @returns ClassDecorator
 *
 * @example
 * ```typescript
 * // Core vault with shared services (aether mode)
 * @Vault({
 *   relics: [Logger, Config],
 *   reveal: [LoggerT, ConfigT],
 *   aether: true
 * })
 * export class CoreVault {}
 *
 * // Database vault fusing core services
 * @Vault({
 *   relics: [Database, DatabaseConfig],
 *   reveal: [DatabaseT],
 *   fuse: [CoreVault]
 * })
 * export class DatabaseVault {}
 *
 * // Application vault composing other vaults
 * @Vault({
 *   relics: [UserService, UserRepository],
 *   reveal: [UserServiceT],
 *   fuse: [CoreVault, DatabaseVault]
 * })
 * export class AppVault {}
 *
 * // Bootstrap with Genesis
 * const genesis = Genesis.from(AppVault);
 * const userService = genesis.resolve(UserServiceT);
 * ```
 */
export function Vault(config: VaultConfig = {}): ClassDecorator {
  return function (target: any) {
    // Attach configuration to class (used by Genesis.from())
    target.__vaultCfg__ = {
      ...config,
      name: config.name ?? target.name, // Default to class name
    };

    // Add static scope factory method to vault class
    target.beginScope = function () {
      return new Scope();
    };

    return target;
  };
}

/**
 * Abstract base class for vault hosts.
 *
 * Provides utility methods like beginScope() without requiring @Vault decorator.
 * Useful for testing or custom vault implementations.
 */
export abstract class Host {
  /**
   * Create a new dependency scope.
   *
   * @returns New Scope instance for scoped lifecycle management
   */
  static beginScope(): Scope {
    return new Scope();
  }
}
