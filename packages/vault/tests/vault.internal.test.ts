import { beforeEach, describe, expect, it } from 'vitest';

import type { Entry } from '../src/core/entry-store.js';
import { token } from '../src/core/token.js';
import { Vault } from '../src/core/vault.js';
import { Relic, Vault as VaultDecorator } from '../src/decorators/index.js';
import { LifecycleViolationError } from '../src/errors/errors.js';
import { StaticRelicRegistry } from '../src/registry/static-registry.js';
import { Lifecycle, type DecoratedVaultClass } from '../src/types/types.js';

beforeEach(() => {
  StaticRelicRegistry.resetForTests();
});

describe('Vault internal coverage', () => {
  it('exposes decorated constructor via getVaultClass()', () => {
    @VaultDecorator()
    class DecoratedVault {}

    const vault = new Vault(DecoratedVault as DecoratedVaultClass);
    expect(vault.getVaultClass()).toBe(DecoratedVault);
  });

  it('registers class providers and resolves via scope helpers', async () => {
    const ClassToken = token('ClassToken');
    const AsyncToken = token('AsyncToken');

    @Relic({ provide: ClassToken })
    class ClassRelic {}

    const vault = new Vault({
      relics: [
        { provide: ClassToken, useClass: ClassRelic },
        { provide: AsyncToken, useFactory: async () => 'async-value' },
      ],
    });

    const scope = vault.createScope();
    expect(scope.resolve(ClassToken)).toBeInstanceOf(ClassRelic);
    await expect(scope.resolveAsync(AsyncToken)).resolves.toBe('async-value');
  });

  it('resolves async providers from fused vaults', async () => {
    const SharedToken = token('SharedAsync');

    const fused = new Vault({
      relics: [{ provide: SharedToken, useFactory: async () => 'shared' }],
      reveal: [SharedToken],
    });

    const host = new Vault({
      relics: [],
      fuse: [fused],
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
