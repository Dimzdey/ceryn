import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Container } from '../src/api/container.js';
import { token } from '../src/core/token.js';
import { Vault } from '../src/core/vault.js';
import { Injectable, Inject, Module as ModuleDecorator } from '../src/decorators/index.js';
import type { Constructor } from '../src/index.js';
import { MetadataRegistry } from '../src/registry/metadata-registry.js';

describe('Container', () => {
  beforeEach(() => {
    MetadataRegistry.resetForTests();
    Container.clearCache();
    Vault.setDefaultLazyResolver(undefined);
  });

  it('instantiates decorated modules lazily and caches instances', () => {
    const SharedToken = token('Shared');

    @Injectable({ provide: SharedToken })
    class SharedService {}

    @ModuleDecorator({
      providers: [SharedService],
      exports: [SharedToken],
    })
    class CoreModule {}

    @ModuleDecorator({
      providers: [],
      imports: [CoreModule],
    })
    class AppModule {}

    const vault1 = Container.from(AppModule);
    const vault2 = Container.from(AppModule);

    expect(vault1).toBe(vault2);
    expect(vault1.resolve(SharedToken)).toBeInstanceOf(SharedService);

    Container.clearCache();
    const vault3 = Container.from(AppModule);
    expect(vault3).not.toBe(vault1);
  });

  it('supports lazy imports and installs default resolver', () => {
    const DependencyToken = token('Dependency');
    const ConsumerToken = token('Consumer');

    @Injectable({ provide: DependencyToken })
    class Dependency {}

    @ModuleDecorator({
      providers: [Dependency],
      exports: [DependencyToken],
    })
    class DependencyModule {}

    @Injectable({ provide: ConsumerToken })
    class Consumer {
      constructor(@Inject(DependencyToken) public readonly dep: Dependency) {}
    }

    @ModuleDecorator({
      providers: [Consumer],
      imports: [DependencyModule],
    })
    class ConsumerModule {}

    const vault = Container.from(ConsumerModule);
    expect(Vault.getDefaultLazyResolver()).toBeDefined();
    expect((vault.resolve(ConsumerToken) as Consumer).dep).toBeInstanceOf(Dependency);
  });

  it('throws for undecorated module classes', () => {
    class PlainModule {}
    expect(() => Container.from(PlainModule)).toThrowError('PlainModule is not a decorated vault');
  });

  it('detects circular resolution attempts', () => {
    @ModuleDecorator()
    class LoopModule {}

    const internals = Container as unknown as { resolving: Set<Constructor> };
    internals.resolving.add(LoopModule);
    try {
      expect(() => Container.from(LoopModule)).toThrowError(/Circular vault dependency detected/);
    } finally {
      internals.resolving.delete(LoopModule);
    }
  });

  it('respects pre-resolved vault instances and custom lazy resolvers', () => {
    const CustomToken = token('Custom');

    @Injectable({ provide: CustomToken })
    class CustomProvider {}

    const imported = new Vault({ providers: [CustomProvider], exports: [CustomToken] });
    const lazySpy = vi.fn(() => new Vault());

    @ModuleDecorator({
      imports: [imported],
      lazyResolve: lazySpy,
    })
    class InstanceImportModule {}

    const vault = Container.from(InstanceImportModule);
    expect(vault.importedModules).toContain(imported);
    expect(lazySpy).not.toHaveBeenCalled();
  });
});
