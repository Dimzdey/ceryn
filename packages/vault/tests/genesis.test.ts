import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Genesis } from '../src/api/genesis.js';
import { token } from '../src/core/token.js';
import { Vault } from '../src/core/vault.js';
import { Relic, Summon, Vault as VaultDecorator } from '../src/decorators/index.js';
import type { Constructor } from '../src/index.js';
import { StaticRelicRegistry } from '../src/registry/static-registry.js';

describe('Genesis', () => {
  beforeEach(() => {
    StaticRelicRegistry.resetForTests();
    Genesis.clearCache();
    Vault.setDefaultLazyResolver(undefined);
  });

  it('instantiates decorated vaults lazily and caches instances', () => {
    const SharedToken = token('Shared');

    @Relic({ provide: SharedToken })
    class SharedService {}

    @VaultDecorator({
      relics: [SharedService],
      reveal: [SharedToken],
    })
    class CoreVault {}

    @VaultDecorator({
      relics: [],
      fuse: [CoreVault],
    })
    class AppVault {}

    const vault1 = Genesis.from(AppVault);
    const vault2 = Genesis.from(AppVault);

    expect(vault1).toBe(vault2);
    expect(vault1.resolve(SharedToken)).toBeInstanceOf(SharedService);

    Genesis.clearCache();
    const vault3 = Genesis.from(AppVault);
    expect(vault3).not.toBe(vault1);
  });

  it('supports lazy fusion and installs default resolver', () => {
    const DependencyToken = token('Dependency');
    const ConsumerToken = token('Consumer');

    @Relic({ provide: DependencyToken })
    class Dependency {}

    @VaultDecorator({
      relics: [Dependency],
      reveal: [DependencyToken],
    })
    class DependencyVault {}

    @Relic({ provide: ConsumerToken })
    class Consumer {
      constructor(@Summon(DependencyToken) public readonly dep: Dependency) {}
    }

    @VaultDecorator({
      relics: [Consumer],
      fuse: [DependencyVault],
    })
    class ConsumerVault {}

    const vault = Genesis.from(ConsumerVault);
    expect(Vault.getDefaultLazyResolver()).toBeDefined();
    expect((vault.resolve(ConsumerToken) as Consumer).dep).toBeInstanceOf(Dependency);
  });

  it('throws for undecorated vault classes', () => {
    class PlainVault {}
    expect(() => Genesis.from(PlainVault)).toThrowError('PlainVault is not a decorated vault');
  });

  it('detects circular resolution attempts', () => {
    @VaultDecorator()
    class LoopVault {}

    const internals = Genesis as unknown as { resolving: Set<Constructor> };
    internals.resolving.add(LoopVault);
    try {
      expect(() => Genesis.from(LoopVault)).toThrowError(/Circular vault dependency detected/);
    } finally {
      internals.resolving.delete(LoopVault);
    }
  });

  it('respects pre-resolved vault instances and custom lazy resolvers', () => {
    const CustomToken = token('Custom');

    @Relic({ provide: CustomToken })
    class CustomRelic {}

    const fused = new Vault({ relics: [CustomRelic], reveal: [CustomToken] });
    const lazySpy = vi.fn(() => new Vault());

    @VaultDecorator({
      fuse: [fused],
      lazyResolve: lazySpy,
    })
    class InstanceFuseVault {}

    const vault = Genesis.from(InstanceFuseVault);
    expect(vault.fusedVaults).toContain(fused);
    expect(lazySpy).not.toHaveBeenCalled();
  });
});
