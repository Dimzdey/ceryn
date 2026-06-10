/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Constructor, ModuleConfig } from '../types/types.js';

/**
 * Retrieve module configuration from a decorated module class.
 *
 * @param target - Module class constructor
 * @returns ModuleConfig if present, undefined otherwise
 */
export function getModuleConfig(target: Constructor): ModuleConfig | undefined {
  return (target as any).__moduleCfg__;
}

/**
 * Check if a class has module configuration attached.
 *
 * @param target - Class constructor to check
 * @returns true if class has __moduleCfg__ property
 */
export function hasModuleConfig(target: Constructor): boolean {
  return !!(target as any).__moduleCfg__;
}

/**
 * Registry for module metadata lookups.
 *
 * Provides static methods to check and retrieve module configurations
 * from decorated classes.
 */
export class ModuleRegistry {
  static get = getModuleConfig;
  static has = hasModuleConfig;
}

/**
 * Decorator to mark a class as a Module container.
 *
 * Attaches ModuleConfig metadata to the class at module load time, enabling
 * declarative module definitions that can be bootstrapped lazily by Container.
 *
 * @param config - Module configuration (defaults to empty)
 * @returns ClassDecorator
 */
export function Module(config: ModuleConfig = {}): ClassDecorator {
  return function (target: any) {
    target.__moduleCfg__ = {
      ...config,
      name: config.name ?? target.name,
    };
    return target;
  };
}
