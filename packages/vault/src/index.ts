export { Container, Container as Genesis } from './api/container.js';
export { createTokenGroup } from './api/token-utils.js';

export {
  Inject,
  Injectable,
  Module,
  ModuleRegistry,
  Injectable as Relic,
  Inject as Summon,
  Module as Vault,
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
  ModuleConfig,
  Provider,
  ProviderMetadata,
  ProviderMetadata as RelicMetadata,
  StaticProviderDefinition,
  StaticProviderDefinition as StaticRelicDefinition,
  ValueProvider,
  ModuleConfig as VaultConfig,
} from './types/types.js';

export * from './core/token.js';

export { Scope } from './core/scope.js';
export type { ScopeProvideOptions } from './core/scope.js';
export { Vault as CoreContainer, Vault as CoreVault } from './core/vault.js';

// Errors
export {
  AggregateDisposalError,
  CircularDependencyError,
  CircularModuleAttachmentError,
  CircularModuleAttachmentError as CircularVaultAttachmentError,
  ContainerDisposedError,
  FactoryExecutionError,
  InvalidModuleConfigError,
  InvalidProviderError,
  InvalidTokenError,
  InvalidModuleConfigError as InvalidVaultConfigError,
  LazyFusionResolverMissingError,
  LazyResolverInvalidReturnError,
  LifecycleViolationError,
  MissingInjectableDecoratorError,
  MissingInjectDecoratorError,
  MissingInjectableDecoratorError as MissingRelicDecoratorError,
  MissingInjectDecoratorError as MissingSummonDecoratorError,
  MultipleShadowPolicyViolationsError,
  ProviderNotExposedError,
  ProviderNotFoundError,
  ProviderNotExposedError as RelicNotExposedError,
  ProviderNotFoundError as RelicNotFoundError,
  ScopeDisposedError,
  ScopedWithoutScopeError,
  ShadowPolicyViolationError,
  TokenCollisionError,
  UnconstructableProviderError,
  UnconstructableProviderError as UnconstructableRelicError,
  ContainerDisposedError as VaultDisposedError,
} from './errors/errors.js';
