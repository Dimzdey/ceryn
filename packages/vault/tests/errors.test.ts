import { describe, expect, it } from 'vitest';

import {
  AggregateDisposalError,
  AliasCollisionError,
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
} from '../src/errors/errors.js';

describe('error classes', () => {
  it('provides contextual error messages and properties', () => {
    const circular = new CircularDependencyError(['A', 'B', 'A']);
    expect(circular.cycle).toEqual(['A', 'B', 'A']);
    expect(circular.message).toContain('Circular dependency');

    const notFound = new RelicNotFoundError('ServiceT', ['Alpha', 'Beta'], ['Foo', 'Bar']);
    expect(notFound.token).toBe('ServiceT');
    expect(notFound.availableRelics).toEqual(['Alpha', 'Beta']);
    expect(notFound.dependencyChain).toEqual(['Foo', 'Bar']);

    const notFoundLarge = new RelicNotFoundError('Huge', new Array(11).fill('X'));
    expect(notFoundLarge.availableRelics.length).toBe(11);

    const missingSummon = new MissingSummonDecoratorError('Ctor', 1);
    expect(missingSummon.message).toContain('Ctor');

    const notExposed = new RelicNotExposedError('Foo', 'Vault', []);
    expect(notExposed.vaultName).toBe('Vault');

    const circularVault = new CircularVaultAttachmentError(['A', 'B', 'A']);
    expect(circularVault.message).toContain('Circular vault fusion');

    const invalidProvider = new InvalidProviderError({ foo: 'bar' });
    expect(invalidProvider.provider).toEqual({ foo: 'bar' });

    const tokenCollision = new TokenCollisionError('tok_1', 'A', 'B');
    expect(tokenCollision.newOwner).toBe('B');

    const aliasCollision = new AliasCollisionError('alias', 'tok_1', 'tok_2', 'Vault');
    expect(aliasCollision.alias).toBe('alias');

    const missingRelic = new MissingRelicDecoratorError('SomeClass');
    expect(missingRelic.message).toContain('SomeClass');

    const unconstructable = new UnconstructableRelicError('tok_missing');
    expect(unconstructable.token).toBe('tok_missing');

    const lazyMissing = new LazyFusionResolverMissingError();
    expect(lazyMissing.message).toContain('Lazy fusion resolver');

    const factoryError = new FactoryExecutionError('tok_factory', new Error('boom'));
    expect(factoryError.token).toBe('tok_factory');
    expect(factoryError.cause).toBeInstanceOf(Error);

    const scopeDisposed = new ScopeDisposedError();
    expect(scopeDisposed.message).toContain('Scope');

    const invalidConfig = new InvalidVaultConfigError('bad');
    expect(invalidConfig.reason).toBe('bad');

    const shadowPolicy = new ShadowPolicyViolationError(
      'Vault',
      ['A', 'B', 'A'],
      'tok',
      'singleton'
    );
    expect(shadowPolicy.owners).toEqual(['A', 'B', 'A']);

    const vaultDisposed = new VaultDisposedError('Vault');
    expect(vaultDisposed.vaultName).toBe('Vault');

    const scopedWithoutScope = new ScopedWithoutScopeError('tok_scoped', ['ChainA', 'ChainB']);
    expect(scopedWithoutScope.token).toBe('tok_scoped');

    const invalidToken = new InvalidTokenError({ bad: true });
    expect(invalidToken.token).toEqual({ bad: true });

    const lazyInvalidReturn = new LazyResolverInvalidReturnError('Vault', 123);
    expect(lazyInvalidReturn.className).toBe('Vault');

    const aggregate = new AggregateDisposalError([new Error('first'), new Error('second')]);
    expect(aggregate.errors).toHaveLength(2);

    const shadowViolations = new MultipleShadowPolicyViolationsError('Vault', [
      { token: 'tok', producers: ['A'], lifecycle: 'singleton' },
    ]);
    expect(shadowViolations.violations).toHaveLength(1);
  });

  it('details lifecycle violations for all combinations', () => {
    const singletonScoped = new LifecycleViolationError(
      'Consumer',
      'singleton',
      'Dependency',
      'scoped',
      ['Consumer', 'Dependency']
    );
    expect(singletonScoped.message).toContain('singleton');

    const singletonTransient = new LifecycleViolationError(
      'Consumer',
      'singleton',
      'Dependency',
      'transient'
    );
    expect(singletonTransient.message).toContain('transient');

    const scopedTransient = new LifecycleViolationError(
      'Consumer',
      'scoped',
      'Dependency',
      'transient'
    );
    expect(scopedTransient.message).toContain('scoped');
  });
});
