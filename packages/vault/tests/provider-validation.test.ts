import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Container } from '../src/api/container.js';
import { FLAG_LOCAL_DEPS_VALIDATED } from '../src/core/flags.js';
import { token } from '../src/core/token.js';
import { Vault } from '../src/core/vault.js';
import { Inject, Injectable, Module as ModuleDecorator } from '../src/decorators/index.js';
import { InvalidModuleConfigError, LifecycleViolationError } from '../src/errors/errors.js';
import { MetadataRegistry } from '../src/registry/metadata-registry.js';
import { Lifecycle } from '../src/types/types.js';

beforeEach(() => {
  MetadataRegistry.resetForTests();
  Container.reset();
});

describe('Provider validation', () => {
  it('certifies only dependency edges validated in registration order', () => {
    const Dependency = token('CertifiedDependency');
    const Consumer = token('CertifiedConsumer');
    const ordered = new Vault({
      providers: [
        { provide: Dependency, useFactory: () => 'dependency' },
        { provide: Consumer, deps: [Dependency], useFactory: () => 'consumer' },
      ],
    });
    const reverse = new Vault({
      providers: [
        { provide: Consumer, deps: [Dependency], useFactory: () => 'consumer' },
        { provide: Dependency, useFactory: () => 'dependency' },
      ],
    });

    expect(ordered.store.getByCanonical(Consumer.id)!.flags & FLAG_LOCAL_DEPS_VALIDATED).not.toBe(
      0
    );
    expect(reverse.store.getByCanonical(Consumer.id)!.flags & FLAG_LOCAL_DEPS_VALIDATED).toBe(0);
  });

  it('reuses decorated lifecycle validation across clearCache but resets it explicitly', () => {
    const Dependency = token('CachedValidationDependency');
    const Consumer = token('CachedValidationConsumer');

    @ModuleDecorator({
      providers: [
        { provide: Dependency, useFactory: () => 'dependency' },
        { provide: Consumer, deps: [Dependency], useFactory: () => 'consumer' },
      ],
    })
    class CachedValidationModule {}

    const prototype = Vault.prototype as unknown as {
      _validateDependencyLifecycle: (...args: unknown[]) => void;
    };
    const validation = vi.spyOn(prototype, '_validateDependencyLifecycle');

    try {
      Container.from(CachedValidationModule);
      expect(validation).toHaveBeenCalledTimes(1);

      Container.clearCache();
      Container.from(CachedValidationModule);
      expect(validation).toHaveBeenCalledTimes(1);

      Container.reset();
      Container.from(CachedValidationModule);
      expect(validation).toHaveBeenCalledTimes(2);
    } finally {
      validation.mockRestore();
    }
  });

  it('invalidates decorated lifecycle certification when provider config mutates', () => {
    const Dependency = token('MutatedValidationDependency');
    const Consumer = token('MutatedValidationConsumer');
    const dependencyProvider = {
      provide: Dependency,
      useFactory: () => 'dependency',
      lifecycle: Lifecycle.Singleton,
    };

    @ModuleDecorator({
      providers: [
        dependencyProvider,
        { provide: Consumer, deps: [Dependency], useFactory: () => 'consumer' },
      ],
    })
    class MutatedValidationModule {}

    Container.from(MutatedValidationModule);
    dependencyProvider.lifecycle = Lifecycle.Transient;
    Container.clearCache();

    expect(() => Container.from(MutatedValidationModule)).toThrow(LifecycleViolationError);
  });

  it('invalidates decorated lifecycle certification when class metadata mutates', () => {
    const Dependency = token('MutatedMetadataDependency');
    const Consumer = token('MutatedMetadataConsumer');

    @Injectable({ provide: Dependency })
    class DependencyService {}

    @Injectable({ provide: Consumer })
    class ConsumerService {
      constructor(@Inject(Dependency) readonly dependency: DependencyService) {}
    }

    @ModuleDecorator({ providers: [DependencyService, ConsumerService] })
    class MutatedMetadataModule {}

    Container.from(MutatedMetadataModule);
    Injectable({ provide: Dependency, lifecycle: Lifecycle.Transient })(DependencyService);
    Container.clearCache();

    expect(() => Container.from(MutatedMetadataModule)).toThrow(LifecycleViolationError);
  });

  it('validates each object provider shape once', () => {
    const First = token('SingleValidationFirst');
    const Second = token('SingleValidationSecond');
    const prototype = Vault.prototype as unknown as {
      _isProvider: (value: unknown) => boolean;
    };
    const validation = vi.spyOn(prototype, '_isProvider');

    try {
      new Vault({
        providers: [
          { provide: First, useValue: 1 },
          { provide: Second, useFactory: () => 2 },
        ],
      });

      expect(validation).toHaveBeenCalledTimes(2);
    } finally {
      validation.mockRestore();
    }
  });

  it('throws for invalid lifecycle on class provider override', () => {
    class Service {}

    const ServiceT = token<Service>('InvalidLifecycleClassService');

    expect(
      () =>
        new Vault({
          name: 'InvalidLifecycleClass',
          providers: [
            {
              provide: ServiceT,
              useClass: Service,
              lifecycle: 'forever' as never,
            },
          ],
        })
    ).toThrow(InvalidModuleConfigError);
  });

  it('throws for invalid lifecycle on factory provider', () => {
    class Service {}

    const ServiceT = token<Service>('InvalidLifecycleFactoryService');

    expect(
      () =>
        new Vault({
          name: 'InvalidLifecycleFactory',
          providers: [
            {
              provide: ServiceT,
              useFactory: () => new Service(),
              lifecycle: 'forever' as never,
            },
          ],
        })
    ).toThrow(InvalidModuleConfigError);
  });

  it('throws for invalid lifecycle on @Injectable metadata', () => {
    class Service {}

    const ServiceT = token<Service>('InvalidLifecycleDecoratedService');

    expect(() => {
      Injectable({ provide: ServiceT, lifecycle: 'forever' as never })(Service);
    }).toThrow(InvalidModuleConfigError);
  });

  it('rejects duplicate local providers for the same token', () => {
    const SharedToken = token('ProviderDuplicate');

    expect(
      () =>
        new Vault({
          providers: [
            { provide: SharedToken, useValue: 'first' },
            { provide: SharedToken, useValue: 'second' },
          ],
        })
    ).toThrow(InvalidModuleConfigError);
  });

  it('rejects duplicate exports for the same token', () => {
    const ExportedToken = token('ExportDuplicate');

    expect(
      () =>
        new Vault({
          providers: [{ provide: ExportedToken, useValue: 'value' }],
          exports: [ExportedToken, ExportedToken],
        })
    ).toThrow(InvalidModuleConfigError);
  });

  it('allows lazy hidden factory deps to be supplied by scope-local registrations', () => {
    const HiddenToken = token('LazyHiddenFactoryDep');
    const FactoryToken = token('LazyHiddenFactoryConsumer');
    const override = { value: 'scope-hidden' };

    @ModuleDecorator({
      providers: [{ provide: HiddenToken, useValue: 'hidden' }],
      exports: [],
    })
    class HiddenModule {}

    @ModuleDecorator({
      imports: [HiddenModule],
      providers: [
        {
          provide: FactoryToken,
          lifecycle: Lifecycle.Scoped,
          useFactory: (dep: typeof override) => ({ dep }),
          deps: [HiddenToken],
        },
      ],
    })
    class ConsumerModule {}

    const vault = Container.from(ConsumerModule);
    const scope = vault.createScope();
    scope.provide(HiddenToken, override);

    expect(vault.has(HiddenToken)).toBe(false);
    expect(vault.canResolve(FactoryToken)).toBe(false);
    expect(scope.resolve(FactoryToken)).toEqual({ dep: override });
  });

  it('allows concrete hidden factory deps to be supplied by scope-local registrations', () => {
    const HiddenToken = token('ImportedHiddenFactoryDep');
    const FactoryToken = token('ImportedHiddenFactoryConsumer');
    const override = { value: 'scope-hidden' };

    const imported = new Vault({
      providers: [{ provide: HiddenToken, useValue: 'hidden' }],
      exports: [],
    });

    const vault = new Vault({
      imports: [imported],
      providers: [
        {
          provide: FactoryToken,
          lifecycle: Lifecycle.Scoped,
          useFactory: (dep: typeof override) => ({ dep }),
          deps: [HiddenToken],
        },
      ],
    });
    const scope = vault.createScope();
    scope.provide(HiddenToken, override);

    expect(vault.has(HiddenToken)).toBe(false);
    expect(vault.canResolve(FactoryToken)).toBe(false);
    expect(scope.resolve(FactoryToken)).toEqual({ dep: override });
  });

  it('allows factory deps from imported exports', () => {
    const DependencyToken = token('VisibleFactoryDep');
    const FactoryToken = token('VisibleFactoryConsumer');

    const imported = new Vault({
      providers: [{ provide: DependencyToken, useValue: 'dep' }],
      exports: [DependencyToken],
    });

    const vault = new Vault({
      providers: [
        {
          provide: FactoryToken,
          useFactory: (dep: string) => `factory:${dep}`,
          deps: [DependencyToken],
        },
      ],
      imports: [imported],
    });

    expect(vault.resolve(FactoryToken)).toBe('factory:dep');
  });

  it('allows missing factory deps to be supplied by scope-local registrations', () => {
    const DependencyToken = token('ScopeSuppliedFactoryDep');
    const FactoryToken = token('ScopeSuppliedFactoryConsumer');
    const database = { url: 'scope://db' };

    const vault = new Vault({
      providers: [
        {
          provide: FactoryToken,
          lifecycle: Lifecycle.Scoped,
          useFactory: (dep: typeof database) => ({ dep }),
          deps: [DependencyToken],
        },
      ],
    });
    const scope = vault.createScope();
    scope.provide(DependencyToken, database);

    expect(scope.resolve(FactoryToken)).toEqual({ dep: database });
  });
});
