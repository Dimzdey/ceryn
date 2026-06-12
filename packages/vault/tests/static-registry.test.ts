import { beforeEach, describe, expect, it } from 'vitest';

import { Container } from '../src/api/container.js';
import { Vault } from '../src/core/vault.js';
import { token } from '../src/core/token.js';
import { Injectable, Module } from '../src/decorators/index.js';
import type { CanonicalId } from '../src/index.js';
import { MetadataRegistry } from '../src/registry/metadata-registry.js';
import { Lifecycle, type Constructor } from '../src/types/types.js';

const metadata = (name: CanonicalId, label: string) => ({
  name,
  label,
  lifecycle: Lifecycle.Singleton,
});

describe('MetadataRegistry', () => {
  beforeEach(() => {
    MetadataRegistry.resetForTests();
    Container.clearCache();
    Vault.setDefaultLazyResolver(undefined);
  });

  it('can reset static container state between app/test instances', () => {
    @Module({ providers: [], exports: [] })
    class EmptyModule {}

    const first = Container.from(EmptyModule);
    Container.reset();
    const second = Container.from(EmptyModule);

    expect(second).not.toBe(first);
  });

  it('can clear metadata registry explicitly', () => {
    const ServiceT = token<Service>('Service');

    @Injectable({ provide: ServiceT })
    class Service {}

    expect(MetadataRegistry.buildDefinition(Service)).toBeDefined();
    MetadataRegistry.clear();
    expect(MetadataRegistry.buildDefinition(Service)).toBeUndefined();
  });

  it('records provider metadata and injection dependencies', () => {
    class ProviderA {}
    const provide = token('ProviderA');
    const dep = token('DepA');

    MetadataRegistry.registerProvider(ProviderA as Constructor, metadata(provide.id, 'ProviderA'));
    MetadataRegistry.registerInjection(ProviderA as Constructor, 2, dep);

    const def = MetadataRegistry.buildDefinition(ProviderA as Constructor);

    expect(def).toBeDefined();
    expect(def?.ctor).toBe(ProviderA);
    expect(def?.metadata).toMatchObject({ name: provide.id, label: 'ProviderA' });
    expect(def?.dependencies).toHaveLength(3);
    expect(def?.dependencies?.[2]).toBe(dep.id);
  });

  it('creates fallback metadata when injection is used without injectable decorator', () => {
    class ProviderB {}
    const dep = token('DepB');

    MetadataRegistry.registerInjection(ProviderB as Constructor, 0, dep);
    const def = MetadataRegistry.buildDefinition(ProviderB as Constructor);

    expect(def).toBeDefined();
    expect(def?.metadata.name.startsWith('fallback:')).toBe(true);
    expect(def?.dependencies).toEqual([dep.id]);
  });

  it('seals definitions and recomputes when provider re-registers', () => {
    class ProviderC {}
    const provide = token('ProviderC');

    MetadataRegistry.registerProvider(ProviderC as Constructor, metadata(provide.id, 'ProviderC'));
    MetadataRegistry.sealAll();

    const initial = MetadataRegistry.buildDefinition(ProviderC as Constructor);
    expect(initial?.metadata.label).toBe('ProviderC');

    MetadataRegistry.registerProvider(
      ProviderC as Constructor,
      metadata(provide.id, 'UpdatedLabel')
    );
    const updated = MetadataRegistry.buildDefinition(ProviderC as Constructor);

    expect(updated?.metadata.label).toBe('UpdatedLabel');
  });

  it('supports namespaced bags and reset()', () => {
    class ProviderD {}
    const tokenD = token('ProviderD');

    MetadataRegistry.registerProvider(ProviderD as Constructor, metadata(tokenD.id, 'ProviderD'));
    expect(MetadataRegistry.buildDefinition(ProviderD as Constructor)).toBeDefined();

    MetadataRegistry.reset();
    expect(MetadataRegistry.buildDefinition(ProviderD as Constructor)).toBeUndefined();

    MetadataRegistry.reset('spec');
    const ns = MetadataRegistry.getBag('spec');
    expect(ns).not.toBe(MetadataRegistry.getBag());
  });

  it('upgrades legacy global registry records', () => {
    const globalSymbol = Symbol.for('ceryn.staticRelicRegistry');
    const legacy = { relics: new WeakMap(), keys: new Set(), sealedAll: false };
    (globalThis as { [key: symbol]: unknown })[globalSymbol] = legacy;

    const bag = MetadataRegistry.getBag();
    expect(bag.relics).toBeInstanceOf(WeakMap);

    const store = (globalThis as { [key: symbol]: unknown })[globalSymbol] as {
      defaultBag: unknown;
      namespaces: Map<string, unknown>;
    };
    expect(store.defaultBag).toBe(legacy);

    MetadataRegistry.reset('legacy');
    expect(store.namespaces.has('legacy')).toBe(true);
  });
});
