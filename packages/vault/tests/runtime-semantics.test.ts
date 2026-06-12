import { describe, expect, it, vi } from 'vitest';

import { token } from '../src/core/token.js';
import { Vault } from '../src/core/vault.js';
import { Inject, Injectable } from '../src/decorators/index.js';
import {
  CircularDependencyError,
  InvalidTokenError,
  LazyResolverInvalidReturnError,
  MissingInjectDecoratorError,
  ScopedWithoutScopeError,
} from '../src/errors/errors.js';
import { Lifecycle } from '../src/types/types.js';

describe('Runtime visibility and resolvability', () => {
  it('has() returns true for local providers and imported visible tokens', () => {
    const LocalT = token('RuntimeLocal');
    const SharedT = token('RuntimeShared');

    const shared = new Vault({
      providers: [{ provide: SharedT, useValue: 'shared' }],
      exports: [SharedT],
    });
    const root = new Vault({
      providers: [{ provide: LocalT, useValue: 'local' }],
      imports: [shared],
    });

    expect(root.has(LocalT)).toBe(true);
    expect(root.has(SharedT)).toBe(true);
  });

  it('has() returns false for non-exported imported tokens', () => {
    const HiddenT = token('RuntimeHidden');
    const imported = new Vault({
      providers: [{ provide: HiddenT, useValue: 'hidden' }],
      exports: [],
    });
    const root = new Vault({ imports: [imported] });

    expect(root.has(HiddenT)).toBe(false);
    expect(root.canResolve(HiddenT)).toBe(false);
  });

  it('has() and canResolve() do not instantiate providers', () => {
    const LocalT = token('RuntimeNoInstantiateLocal');
    const SharedT = token('RuntimeNoInstantiateShared');
    const factory = vi.fn(() => 'shared');
    const onInstantiate = vi.fn();

    @Injectable({ provide: LocalT })
    class LocalService {}

    const shared = new Vault({
      providers: [{ provide: SharedT, useFactory: factory }],
      exports: [SharedT],
    });
    const root = new Vault({
      providers: [LocalService],
      imports: [shared],
      onInstantiate,
    });

    expect(root.has(LocalT)).toBe(true);
    expect(root.has(SharedT)).toBe(true);
    expect(root.canResolve(LocalT)).toBe(true);
    expect(root.canResolve(SharedT)).toBe(true);
    expect(onInstantiate).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it('canResolve() returns false when a visible provider has missing constructor deps', () => {
    const ServiceT = token('RuntimeNeedsMissing');
    const MissingT = token('RuntimeMissingDep');

    @Injectable({ provide: ServiceT })
    class Service {
      constructor(@Inject(MissingT) readonly missing: unknown) {}
    }

    const vault = new Vault({ providers: [Service] });

    expect(vault.has(ServiceT)).toBe(true);
    expect(vault.canResolve(ServiceT)).toBe(false);
  });

  it('canResolve() propagates missing @Inject metadata errors', () => {
    const ServiceT = token<Service>('RuntimeMissingInjectService');

    @Injectable({ provide: ServiceT })
    class Service {
      constructor(readonly dep: unknown) {}
    }

    const vault = new Vault({ providers: [Service] });

    expect(() => vault.canResolve(ServiceT)).toThrow(MissingInjectDecoratorError);
  });

  it('canResolve() returns false when a visible factory provider has missing deps', () => {
    const ServiceT = token('RuntimeFactoryNeedsMissing');
    const MissingT = token('RuntimeFactoryMissingDep');

    const vault = new Vault({
      providers: [
        {
          provide: ServiceT,
          useFactory: () => 'service',
          deps: [MissingT],
        },
      ],
    });

    expect(vault.has(ServiceT)).toBe(true);
    expect(vault.canResolve(ServiceT)).toBe(false);
  });

  it('canResolve() propagates lazy import resolver configuration errors', () => {
    const ImportedT = token('RuntimeLazyImportToken');

    @Injectable({ provide: ImportedT })
    class ImportedService {}

    const vault = new Vault();

    Object.assign(
      vault as unknown as {
        lazyImportClasses: Array<new () => unknown>;
        lazyImportsResolved: boolean;
        lazyResolver: (() => Vault) | undefined;
      },
      {
        lazyImportClasses: [ImportedService],
        lazyImportsResolved: false,
        lazyResolver: () => ({}) as Vault,
      }
    );

    expect(() => vault.canResolve(ImportedT)).toThrow(LazyResolverInvalidReturnError);
  });

  it('canResolve() returns false when lifecycle rules block resolution', () => {
    const ImportedTransientT = token('RuntimeImportedTransient');
    const ConsumerT = token('RuntimeSingletonConsumer');

    @Injectable({ provide: ImportedTransientT, lifecycle: Lifecycle.Transient })
    class ImportedTransient {}

    @Injectable({ provide: ConsumerT, lifecycle: Lifecycle.Singleton })
    class SingletonConsumer {
      constructor(@Inject(ImportedTransientT) readonly dep: ImportedTransient) {}
    }

    const imported = new Vault({
      providers: [ImportedTransient],
      exports: [ImportedTransientT],
    });
    const root = new Vault({
      providers: [SingletonConsumer],
      imports: [imported],
    });

    expect(root.has(ConsumerT)).toBe(true);
    expect(root.canResolve(ConsumerT)).toBe(false);
  });

  it('canResolve() returns false for circular dependency graphs', () => {
    const AToken = token('RuntimeCycleA');
    const BToken = token('RuntimeCycleB');

    const vault = new Vault({
      providers: [
        {
          provide: AToken,
          useFactory: (_b: unknown) => 'a',
          deps: [BToken],
        },
        {
          provide: BToken,
          useFactory: (_a: unknown) => 'b',
          deps: [AToken],
        },
      ],
    });

    expect(vault.has(AToken)).toBe(true);
    expect(vault.canResolve(AToken)).toBe(false);
    expect(() => vault.resolve(AToken)).toThrow(CircularDependencyError);
  });

  it('canResolve() returns false for scoped providers resolved from the root vault', () => {
    const ScopedToken = token('RuntimeScopedRoot');

    @Injectable({ provide: ScopedToken, lifecycle: Lifecycle.Scoped })
    class ScopedService {}

    const vault = new Vault({ providers: [ScopedService] });

    expect(vault.has(ScopedToken)).toBe(true);
    expect(vault.canResolve(ScopedToken)).toBe(false);
    expect(() => vault.resolve(ScopedToken)).toThrow(ScopedWithoutScopeError);
  });

  it('canResolve() returns true for a fully resolvable graph', () => {
    const DepT = token('RuntimeDep');
    const ServiceT = token('RuntimeService');

    @Injectable({ provide: ServiceT })
    class Service {
      constructor(@Inject(DepT) readonly dep: unknown) {}
    }

    const vault = new Vault({
      providers: [{ provide: DepT, useValue: 'dep' }, Service],
    });

    expect(vault.canResolve(ServiceT)).toBe(true);
  });

  it('validates token inputs for has() and canResolve()', () => {
    const vault = new Vault();

    expect(() => vault.has({} as never)).toThrow(InvalidTokenError);
    expect(() => vault.canResolve({} as never)).toThrow(InvalidTokenError);
  });
});
