import { describe, expect, it } from 'vitest';

import { token } from '../src/core/token.js';
import { Vault } from '../src/core/vault.js';
import { LifecycleViolationError } from '../src/errors/errors.js';
import { Lifecycle } from '../src/types/types.js';

function createSameTokenForeignConsumerVaults() {
  const ConsumerToken = token<{ dependency: string }>('SameTokenForeignConsumer');
  const DependencyToken = token<string>('SameTokenImportedDependency');

  const producer = new Vault({
    name: 'SameTokenProducer',
    providers: [
      {
        provide: ConsumerToken,
        lifecycle: Lifecycle.Singleton,
        useFactory: () => ({ dependency: 'producer-local' }),
      },
      {
        provide: DependencyToken,
        lifecycle: Lifecycle.Transient,
        useFactory: () => 'imported',
      },
    ],
    exports: [DependencyToken],
  });

  const root = new Vault({
    name: 'SameTokenRoot',
    providers: [
      {
        provide: ConsumerToken,
        lifecycle: Lifecycle.Transient,
        deps: [DependencyToken],
        useFactory: (dependency) => ({ dependency }),
      },
    ],
    imports: [producer],
  });

  return { ConsumerToken, root };
}

describe('Cross-module lifecycle validation', () => {
  it('rejects a root singleton factory that depends on an imported scoped provider', () => {
    const ScopedToken = token('ImportedScoped');
    const SingletonToken = token('RootSingletonWithScopedDep');

    const imported = new Vault({
      providers: [
        {
          provide: ScopedToken,
          lifecycle: Lifecycle.Scoped,
          useFactory: () => ({ id: Symbol('scoped') }),
        },
      ],
      exports: [ScopedToken],
    });

    const root = new Vault({
      providers: [
        {
          provide: SingletonToken,
          lifecycle: Lifecycle.Singleton,
          deps: [ScopedToken],
          useFactory: (dep) => ({ dep }),
        },
      ],
      imports: [imported],
    });

    const scope = root.createScope();

    expect(() => scope.resolve(SingletonToken)).toThrow(LifecycleViolationError);
  });

  it('rejects a root singleton factory that depends on an imported transient provider', () => {
    const TransientToken = token('ImportedTransient');
    const SingletonToken = token('RootSingletonWithTransientDep');

    const imported = new Vault({
      providers: [
        {
          provide: TransientToken,
          lifecycle: Lifecycle.Transient,
          useFactory: () => ({ id: Symbol('transient') }),
        },
      ],
      exports: [TransientToken],
    });

    const root = new Vault({
      providers: [
        {
          provide: SingletonToken,
          lifecycle: Lifecycle.Singleton,
          deps: [TransientToken],
          useFactory: (dep) => ({ dep }),
        },
      ],
      imports: [imported],
    });

    expect(() => root.resolve(SingletonToken)).toThrow(LifecycleViolationError);
  });

  it('rejects a singleton that depends on a scope-local value', () => {
    const DatabaseToken = token('ScopeLocalDatabase');
    const SingletonToken = token('SingletonWithRuntimeScopeLocalDep');
    const database = { url: 'scope://db' };

    const root = new Vault({
      providers: [
        {
          provide: SingletonToken,
          lifecycle: Lifecycle.Singleton,
          deps: [DatabaseToken],
          useFactory: (dep) => ({ dep }),
        },
      ],
    });
    const scope = root.createScope();
    scope.provide(DatabaseToken, database);

    expect(() => scope.resolve(SingletonToken)).toThrow(LifecycleViolationError);
  });

  it('allows a scoped provider to depend on a scope-local value', () => {
    const DatabaseToken = token('ScopeLocalDatabaseForScopedConsumer');
    const ScopedToken = token('ScopedWithRuntimeScopeLocalDep');
    const database = { url: 'scope://db' };

    const root = new Vault({
      providers: [
        {
          provide: ScopedToken,
          lifecycle: Lifecycle.Scoped,
          deps: [DatabaseToken],
          useFactory: (dep) => ({ dep }),
        },
      ],
    });
    const scope = root.createScope();
    scope.provide(DatabaseToken, database);

    expect(scope.resolve(ScopedToken)).toEqual({ dep: database });
  });

  it('resolves through a producer that has a same-token singleton shadow', () => {
    const { ConsumerToken, root } = createSameTokenForeignConsumerVaults();

    expect(root.resolve(ConsumerToken)).toEqual({ dependency: 'imported' });
  });

  it('resolves asynchronously through a producer that has a same-token singleton shadow', async () => {
    const { ConsumerToken, root } = createSameTokenForeignConsumerVaults();

    await expect(root.resolveAsync(ConsumerToken)).resolves.toEqual({ dependency: 'imported' });
  });

  it('canResolve accepts a foreign consumer shadowed by a producer singleton', () => {
    const { ConsumerToken, root } = createSameTokenForeignConsumerVaults();

    expect(root.canResolve(ConsumerToken)).toBe(true);
  });
});
