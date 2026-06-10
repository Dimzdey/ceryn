import { beforeEach, describe, expect, it } from 'vitest';

import type { Entry } from '../src/core/entry-store.js';
import { token } from '../src/core/token.js';
import { Vault } from '../src/core/vault.js';
import { Injectable, Module as ModuleDecorator } from '../src/decorators/index.js';
import { LifecycleViolationError } from '../src/errors/errors.js';
import { MetadataRegistry } from '../src/registry/metadata-registry.js';
import { Lifecycle, type DecoratedModuleClass } from '../src/types/types.js';

beforeEach(() => {
  MetadataRegistry.resetForTests();
});

describe('Vault internal coverage', () => {
  it('exposes decorated constructor via getVaultClass()', () => {
    @ModuleDecorator()
    class DecoratedVault {}

    const vault = new Vault(DecoratedVault as DecoratedModuleClass);
    expect(vault.getVaultClass()).toBe(DecoratedVault);
  });

  it('registers class providers and resolves via scope helpers', async () => {
    const ClassToken = token('ClassToken');
    const AsyncToken = token('AsyncToken');

    @Injectable({ provide: ClassToken })
    class ClassInjectable {}

    const vault = new Vault({
      providers: [
        { provide: ClassToken, useClass: ClassInjectable },
        { provide: AsyncToken, useFactory: async () => 'async-value' },
      ],
    });

    const scope = vault.createScope();
    expect(scope.resolve(ClassToken)).toBeInstanceOf(ClassInjectable);
    await expect(scope.resolveAsync(AsyncToken)).resolves.toBe('async-value');
  });

  it('resolves async providers from fused vaults', async () => {
    const SharedToken = token('SharedAsync');

    const fused = new Vault({
      providers: [{ provide: SharedToken, useFactory: async () => 'shared' }],
      exports: [SharedToken],
    });

    const host = new Vault({
      providers: [],
      imports: [fused],
    });

    await expect(host.resolveAsync(SharedToken)).resolves.toBe('shared');
  });

  it('validates lifecycle relationships through private helper', () => {
    const ScopedToken = token('ScopedService');
    const SingletonToken = token('SingletonConsumer');

    const vault = new Vault();
    const store = vault.store as unknown as { add(entry: Entry, owner: string): void };

    const singletonEntry: Entry = {
      token: SingletonToken.id,
      ctor: class Singleton {},
      factoryDeps: [],
      metadata: { name: SingletonToken.id, label: 'Singleton', lifecycle: Lifecycle.Singleton },
      summons: [],
      aliases: [SingletonToken.id],
      flags: 0,
    };

    const scopedEntry: Entry = {
      token: ScopedToken.id,
      ctor: class Scoped {},
      factoryDeps: [],
      metadata: { name: ScopedToken.id, label: 'Scoped', lifecycle: Lifecycle.Scoped },
      summons: [],
      aliases: [ScopedToken.id],
      flags: 0,
    };

    store.add(singletonEntry, 'TestVault');
    store.add(scopedEntry, 'TestVault');

    const anyVault = vault as unknown as {
      _validateLifecycleRules(token: string, stack: string[]): void;
    };

    expect(() => anyVault._validateLifecycleRules(SingletonToken.id, [])).not.toThrow();
    expect(() => anyVault._validateLifecycleRules(ScopedToken.id, [SingletonToken.id])).toThrow(
      LifecycleViolationError
    );
  });
});
