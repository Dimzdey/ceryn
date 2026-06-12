export {
  Container as Genesis,
  Injectable as Relic,
  Inject as Summon,
  Module as Vault,
  ModuleRegistry as VaultRegistry,
  MetadataRegistry as StaticRelicRegistry,
  Vault as CoreContainer,
  Vault as CoreVault,
} from './index.js';

export type {
  ProviderMetadata as RelicMetadata,
  StaticProviderDefinition as StaticRelicDefinition,
  ModuleConfig as VaultConfig,
} from './types/types.js';

export {
  CircularModuleAttachmentError as CircularVaultAttachmentError,
  InvalidModuleConfigError as InvalidVaultConfigError,
  MissingInjectableDecoratorError as MissingRelicDecoratorError,
  MissingInjectDecoratorError as MissingSummonDecoratorError,
  ProviderNotExposedError as RelicNotExposedError,
  ProviderNotFoundError as RelicNotFoundError,
  UnconstructableProviderError as UnconstructableRelicError,
  ContainerDisposedError as VaultDisposedError,
} from './errors/errors.js';
