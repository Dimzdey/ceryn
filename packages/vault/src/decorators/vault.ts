/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Constructor, VaultConfig } from '../types/types.js';

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
 * @param config - Vault configuration (defaults to empty)
 * @returns ClassDecorator
 */
export function Vault(config: VaultConfig = {}): ClassDecorator {
  return function (target: any) {
    target.__vaultCfg__ = {
      ...config,
      name: config.name ?? target.name,
    };
    return target;
  };
}
