export { Genesis } from './api/genesis.js';
export { createTokenGroup } from './api/token-utils.js';

export { Relic, Summon, Vault, VaultRegistry } from './decorators/index.js';
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

export { Scope } from './core/scope.js';
export { Vault as CoreVault } from './core/vault.js';

// Errors
export {
  AggregateDisposalError,
  CircularDependencyError,
  CircularVaultAttachmentError,
  FactoryExecutionError,
  InvalidProviderError,
  InvalidTokenError,
  InvalidVaultConfigError,
  LazyFusionResolverMissingError,
  LazyResolverInvalidReturnError,
  LifecycleViolationError,
  MissingRelicDecoratorError,
  MissingSummonDecoratorError,
  MultipleShadowPolicyViolationsError,
  RelicNotExposedError,
  RelicNotFoundError,
  ScopeDisposedError,
  ScopedWithoutScopeError,
  ShadowPolicyViolationError,
  TokenCollisionError,
  UnconstructableRelicError,
  VaultDisposedError,
} from './errors/errors.js';
