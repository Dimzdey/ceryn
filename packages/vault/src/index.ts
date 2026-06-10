export { Container, Container as Genesis } from './api/container.js';
export { createTokenGroup } from './api/token-utils.js';

export {
  Injectable,
  Injectable as Relic,
  Inject,
  Inject as Summon,
  Module,
  Module as Vault,
  ModuleRegistry,
  ModuleRegistry as VaultRegistry,
} from './decorators/index.js';
export {
  MetadataRegistry,
  MetadataRegistry as StaticRelicRegistry,
} from './registry/metadata-registry.js';

export { Lifecycle } from './types/types.js';
export type {
  ClassProvider,
  Constructor,
  FactoryProvider,
  InjectionToken,
  Provider,
  ProviderMetadata,
  ProviderMetadata as RelicMetadata,
  StaticProviderDefinition,
  StaticProviderDefinition as StaticRelicDefinition,
  ValueProvider,
  ModuleConfig,
  ModuleConfig as VaultConfig,
} from './types/types.js';

export * from './core/token.js';

export { Scope } from './core/scope.js';
export { Vault as CoreContainer, Vault as CoreVault } from './core/vault.js';

// Errors
export {
  AggregateDisposalError,
  CircularDependencyError,
  CircularModuleAttachmentError,
  CircularModuleAttachmentError as CircularVaultAttachmentError,
  FactoryExecutionError,
  InvalidProviderError,
  InvalidTokenError,
  InvalidModuleConfigError,
  InvalidModuleConfigError as InvalidVaultConfigError,
  LazyFusionResolverMissingError,
  LazyResolverInvalidReturnError,
  LifecycleViolationError,
  MissingInjectableDecoratorError,
  MissingInjectableDecoratorError as MissingRelicDecoratorError,
  MissingInjectDecoratorError,
  MissingInjectDecoratorError as MissingSummonDecoratorError,
  MultipleShadowPolicyViolationsError,
  ProviderNotExposedError,
  ProviderNotExposedError as RelicNotExposedError,
  ProviderNotFoundError,
  ProviderNotFoundError as RelicNotFoundError,
  ScopeDisposedError,
  ScopedWithoutScopeError,
  ShadowPolicyViolationError,
  TokenCollisionError,
  UnconstructableProviderError,
  UnconstructableProviderError as UnconstructableRelicError,
  ContainerDisposedError,
  ContainerDisposedError as VaultDisposedError,
} from './errors/errors.js';
