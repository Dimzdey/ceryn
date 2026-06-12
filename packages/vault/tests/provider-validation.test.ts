import { beforeEach, describe, expect, it } from 'vitest';

import { Container } from '../src/api/container.js';
import { token } from '../src/core/token.js';
import { Vault } from '../src/core/vault.js';
import { Module as ModuleDecorator } from '../src/decorators/index.js';
import { InvalidModuleConfigError } from '../src/errors/errors.js';
import { MetadataRegistry } from '../src/registry/metadata-registry.js';

beforeEach(() => {
  MetadataRegistry.resetForTests();
  Container.clearCache();
  Vault.setDefaultLazyResolver(undefined);
});

describe('Provider validation', () => {
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
