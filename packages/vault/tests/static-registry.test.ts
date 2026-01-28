import { beforeEach, describe, expect, it } from 'vitest';

import { token } from '../src/core/token.js';
import type { CanonicalId } from '../src/index.js';
import { StaticRelicRegistry } from '../src/registry/static-registry.js';
import { Lifecycle, type Constructor } from '../src/types/types.js';

const metadata = (name: CanonicalId, label: string) => ({
  name,
  label,
  lifecycle: Lifecycle.Singleton,
});

describe('StaticRelicRegistry', () => {
  beforeEach(() => {
    StaticRelicRegistry.resetForTests();
  });

  it('records relic metadata and summon dependencies', () => {
    class RelicA {}
    const provide = token('RelicA');
    const dep = token('DepA');

    StaticRelicRegistry.registerRelic(RelicA as Constructor, metadata(provide.id, 'RelicA'));
    StaticRelicRegistry.registerSummon(RelicA as Constructor, 2, dep);

    const def = StaticRelicRegistry.buildDefinition(RelicA as Constructor);

    expect(def).toBeDefined();
    expect(def?.ctor).toBe(RelicA);
    expect(def?.metadata).toMatchObject({ name: provide.id, label: 'RelicA' });
    expect(def?.dependencies).toHaveLength(3);
    expect(def?.dependencies?.[2]).toBe(dep.id);
  });

  it('creates fallback metadata when summon is used without relic decorator', () => {
    class RelicB {}
    const dep = token('DepB');

    StaticRelicRegistry.registerSummon(RelicB as Constructor, 0, dep);
    const def = StaticRelicRegistry.buildDefinition(RelicB as Constructor);

    expect(def).toBeDefined();
    expect(def?.metadata.name.startsWith('fallback:')).toBe(true);
    expect(def?.dependencies).toEqual([dep.id]);
  });

  it('seals definitions and recomputes when relic re-registers', () => {
    class RelicC {}
    const provide = token('RelicC');

    StaticRelicRegistry.registerRelic(RelicC as Constructor, metadata(provide.id, 'RelicC'));
    StaticRelicRegistry.sealAll();

    const initial = StaticRelicRegistry.buildDefinition(RelicC as Constructor);
    expect(initial?.metadata.label).toBe('RelicC');

    StaticRelicRegistry.registerRelic(RelicC as Constructor, metadata(provide.id, 'UpdatedLabel'));
    const updated = StaticRelicRegistry.buildDefinition(RelicC as Constructor);

    expect(updated?.metadata.label).toBe('UpdatedLabel');
  });

  it('supports namespaced bags and reset()', () => {
    class RelicD {}
    const tokenD = token('RelicD');

    StaticRelicRegistry.registerRelic(RelicD as Constructor, metadata(tokenD.id, 'RelicD'));
    expect(StaticRelicRegistry.buildDefinition(RelicD as Constructor)).toBeDefined();

    StaticRelicRegistry.reset();
    expect(StaticRelicRegistry.buildDefinition(RelicD as Constructor)).toBeUndefined();

    StaticRelicRegistry.reset('spec');
    const ns = StaticRelicRegistry.getBag('spec');
    expect(ns).not.toBe(StaticRelicRegistry.getBag());
  });

  it('upgrades legacy global registry records', () => {
    const globalSymbol = Symbol.for('ceryn.staticRelicRegistry');
    const legacy = { relics: new WeakMap(), keys: new Set(), sealedAll: false };
    (globalThis as { [key: symbol]: unknown })[globalSymbol] = legacy;

    const bag = StaticRelicRegistry.getBag();
    expect(bag.relics).toBeInstanceOf(WeakMap);

    const store = (globalThis as { [key: symbol]: unknown })[globalSymbol] as {
      defaultBag: unknown;
      namespaces: Map<string, unknown>;
    };
    expect(store.defaultBag).toBe(legacy);

    StaticRelicRegistry.reset('legacy');
    expect(store.namespaces.has('legacy')).toBe(true);
  });
});
