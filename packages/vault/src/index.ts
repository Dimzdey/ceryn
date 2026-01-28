export { Genesis } from './api/genesis.js';

export { Relic, Summon, Vault, VaultRegistry } from './decorators';
export { StaticRelicRegistry } from './registry/static-registry.js';

export { Lifecycle } from './types/types.js';
export type {
  ClassProvider,
  Constructor,
  FactoryProvider,
  InjectionToken,
  Provider,
  RelicMetadata,
  StaticRelicDefinition,
  ValueProvider,
  VaultConfig,
} from './types/types.js';

export * from './core/token.js';

export { Vault as CoreVault } from './core/vault.js';

// Global types
export type {
  RelicMetadata as ManifestRelicMetadata,
  VaultMetadata as ManifestVaultMetadata,
  TokenMetadata,
  VaultManifest,
} from './types/global.js';

// Errors
export {
  CircularDependencyError,
  CircularVaultAttachmentError,
  InvalidProviderError,
  MissingSummonDecoratorError,
  RelicNotExposedError,
  RelicNotFoundError,
} from './errors/errors.js';
// test comment
