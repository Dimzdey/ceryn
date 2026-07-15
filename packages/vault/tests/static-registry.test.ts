import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('skips migration checks for an unchanged validated store', () => {
    MetadataRegistry.getBag();
    const hasOwn = vi.spyOn(Object.prototype, 'hasOwnProperty');

    void MetadataRegistry.stamp;
    const calls = hasOwn.mock.calls.length;
    hasOwn.mockRestore();

    expect(calls).toBe(0);
  });

  it('switches to an externally replaced current-format store', () => {
    const globalSymbol = Symbol.for('ceryn.staticRelicRegistry');
    const registryGlobal = globalThis as { [key: symbol]: unknown };
    const original = registryGlobal[globalSymbol];
    MetadataRegistry.getBag();

    const replacementBag = {
      relics: new WeakMap<Constructor, object>(),
      keys: new Set<Constructor>(),
      sealedAll: false,
    };
    const replacement = {
      defaultBag: replacementBag,
      namespaces: new Map<string, typeof replacementBag>(),
      generation: 41,
    };

    try {
      registryGlobal[globalSymbol] = replacement;
      class ExternalProvider {}
      const provide = token('ExternalProvider');
      expect(MetadataRegistry.stamp).toBe(41);
      MetadataRegistry.registerProvider(
        ExternalProvider as Constructor,
        metadata(provide.id, 'ExternalProvider')
      );
      expect(replacement.generation).toBe(42);
      expect(replacementBag.relics.has(ExternalProvider as Constructor)).toBe(true);
    } finally {
      registryGlobal[globalSymbol] = original;
      MetadataRegistry.resetForTests();
    }
  });

  it('repairs an in-place corrupted cached store', () => {
    const globalSymbol = Symbol.for('ceryn.staticRelicRegistry');
    const registryGlobal = globalThis as { [key: symbol]: unknown };
    MetadataRegistry.getBag();
    const store = registryGlobal[globalSymbol] as {
      defaultBag: unknown;
      namespaces: unknown;
      generation: unknown;
    };
    const original = { ...store };

    try {
      store.defaultBag = {};
      store.namespaces = {};
      store.generation = 'invalid';
      const bag = MetadataRegistry.getBag();
      expect(bag.relics).toBeInstanceOf(WeakMap);
      expect(bag.keys).toBeInstanceOf(Set);
      expect(store.namespaces).toBeInstanceOf(Map);
      expect(typeof store.generation).toBe('number');
    } finally {
      store.defaultBag = original.defaultBag;
      store.namespaces = original.namespaces;
      store.generation = original.generation;
      MetadataRegistry.resetForTests();
    }
  });

  it('upgrades legacy global registry records', () => {
    const globalSymbol = Symbol.for('ceryn.staticRelicRegistry');
    MetadataRegistry.getBag();
    const legacy = { relics: new WeakMap(), keys: new Set() };
    (globalThis as { [key: symbol]: unknown })[globalSymbol] = legacy;

    const bag = MetadataRegistry.getBag();
    expect(bag.relics).toBeInstanceOf(WeakMap);
    expect(bag.sealedAll).toBe(false);

    const store = (globalThis as { [key: symbol]: unknown })[globalSymbol] as {
      defaultBag: unknown;
      namespaces: Map<string, unknown>;
    };
    expect(store.defaultBag).toBe(legacy);

    MetadataRegistry.reset('legacy');
    expect(store.namespaces.has('legacy')).toBe(true);
  });
});
