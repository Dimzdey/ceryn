import { describe, expect, it } from 'vitest';

import {
  AggregateDisposalError,
  CircularDependencyError,
  CircularModuleAttachmentError,
  FactoryExecutionError,
  InvalidProviderError,
  InvalidTokenError,
  InvalidModuleConfigError,
  LazyFusionResolverMissingError,
  LazyResolverInvalidReturnError,
  LifecycleViolationError,
  MissingInjectableDecoratorError,
  MissingInjectDecoratorError,
  MultipleShadowPolicyViolationsError,
  ProviderNotExposedError,
  ProviderNotFoundError,
  ScopeDisposedError,
  ScopedWithoutScopeError,
  ShadowPolicyViolationError,
  TokenCollisionError,
  UnconstructableProviderError,
  ContainerDisposedError,
} from '../src/errors/errors.js';

describe('error classes', () => {
  it('provides contextual error messages and properties', () => {
    const circular = new CircularDependencyError(['A', 'B', 'A']);
    expect(circular.cycle).toEqual(['A', 'B', 'A']);
    expect(circular.message).toContain('Circular dependency');

    const notFound = new ProviderNotFoundError('ServiceT', ['Alpha', 'Beta'], ['Foo', 'Bar']);
    expect(notFound.token).toBe('ServiceT');
    expect(notFound.availableRelics).toEqual(['Alpha', 'Beta']);
    expect(notFound.dependencyChain).toEqual(['Foo', 'Bar']);

    const notFoundLarge = new ProviderNotFoundError('Huge', new Array(11).fill('X'));
    expect(notFoundLarge.availableRelics.length).toBe(11);

    const missingInject = new MissingInjectDecoratorError('Ctor', 1);
    expect(missingInject.message).toContain('Ctor');

    const notExposed = new ProviderNotExposedError('Foo', 'Module', []);
    expect(notExposed.vaultName).toBe('Module');

    const circularModule = new CircularModuleAttachmentError(['A', 'B', 'A']);
    expect(circularModule.message).toContain('Circular module import');

    const invalidProvider = new InvalidProviderError({ foo: 'bar' });
    expect(invalidProvider.provider).toEqual({ foo: 'bar' });

    const tokenCollision = new TokenCollisionError('tok_1', 'A', 'B');
    expect(tokenCollision.newOwner).toBe('B');

    const missingInjectable = new MissingInjectableDecoratorError('SomeClass');
    expect(missingInjectable.message).toContain('SomeClass');

    const unconstructable = new UnconstructableProviderError('tok_missing');
    expect(unconstructable.token).toBe('tok_missing');

    const lazyMissing = new LazyFusionResolverMissingError();
    expect(lazyMissing.message).toContain('Lazy import resolver');

    const factoryError = new FactoryExecutionError('tok_factory', new Error('boom'));
    expect(factoryError.token).toBe('tok_factory');
    expect(factoryError.cause).toBeInstanceOf(Error);

    const scopeDisposed = new ScopeDisposedError();
    expect(scopeDisposed.message).toContain('Scope');

    const invalidConfig = new InvalidModuleConfigError('bad');
    expect(invalidConfig.reason).toBe('bad');

    const shadowPolicy = new ShadowPolicyViolationError(
      'Module',
      ['A', 'B', 'A'],
      'tok',
      'singleton'
    );
    expect(shadowPolicy.owners).toEqual(['A', 'B', 'A']);

    const containerDisposed = new ContainerDisposedError('Module');
    expect(containerDisposed.vaultName).toBe('Module');

    const scopedWithoutScope = new ScopedWithoutScopeError('tok_scoped', ['ChainA', 'ChainB']);
    expect(scopedWithoutScope.token).toBe('tok_scoped');

    const invalidToken = new InvalidTokenError({ bad: true });
    expect(invalidToken.token).toEqual({ bad: true });

    const lazyInvalidReturn = new LazyResolverInvalidReturnError('Module', 123);
    expect(lazyInvalidReturn.className).toBe('Module');

    const aggregate = new AggregateDisposalError([new Error('first'), new Error('second')]);
    expect(aggregate.errors).toHaveLength(2);

    const shadowViolations = new MultipleShadowPolicyViolationsError('Module', [
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
