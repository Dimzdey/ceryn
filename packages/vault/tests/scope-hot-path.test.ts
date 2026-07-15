import { describe, expect, it, vi } from 'vitest';

import type { Entry } from '../src/core/entry-store.js';
import { SingletonCache } from '../src/core/singleton-cache.js';
import { token, type CanonicalId } from '../src/core/token.js';
import { Vault } from '../src/core/vault.js';
import { Lifecycle } from '../src/types/types.js';

describe('Scope hot paths', () => {
  it('delegates through internal Vault entry points without public options wrappers', async () => {
    const SyncValue = token<number>('InternalScopeSync');
    const AsyncValue = token<number>('InternalScopeAsync');
    const Sentinel = token<number>('InternalScopeSentinel');
    const vault = new Vault({
      providers: [
        { provide: SyncValue, lifecycle: Lifecycle.Transient, useFactory: () => 1 },
        { provide: AsyncValue, lifecycle: Lifecycle.Transient, useFactory: async () => 2 },
      ],
    });
    const scope = vault.createScope();
    scope.provide(Sentinel, 0);
    const state = scope as unknown as {
      localRegistrations: Map<CanonicalId, Entry>;
    };
    const publicSync = vi.spyOn(vault, 'resolve');
    const publicAsync = vi.spyOn(vault, 'resolveAsync');
    const localGet = vi.spyOn(state.localRegistrations, 'get');

    expect(scope.resolve(SyncValue)).toBe(1);
    await expect(scope.resolveAsync(AsyncValue)).resolves.toBe(2);
    expect(publicSync).not.toHaveBeenCalled();
    expect(publicAsync).not.toHaveBeenCalled();
    expect(localGet).toHaveBeenCalledTimes(2);
  });

  it('does not allocate a cache for sync or async transient misses', async () => {
    const SyncValue = token<number>('ScopeTransientSync');
    const AsyncValue = token<number>('ScopeTransientAsync');
    const vault = new Vault({
      providers: [
        { provide: SyncValue, lifecycle: Lifecycle.Transient, useFactory: () => 1 },
        { provide: AsyncValue, lifecycle: Lifecycle.Transient, useFactory: async () => 2 },
      ],
    });
    const scope = vault.createScope();
    const state = scope as unknown as { _cache?: SingletonCache };

    expect(state._cache).toBeUndefined();
    expect(scope.resolve(SyncValue)).toBe(1);
    expect(state._cache).toBeUndefined();
    await expect(scope.resolveAsync(AsyncValue)).resolves.toBe(2);
    expect(state._cache).toBeUndefined();
  });

  it('probes SingletonCache once for a first scoped sync resolution', () => {
    const Value = token<number>('OneScopedProbe');
    const vault = new Vault({
      providers: [{ provide: Value, lifecycle: Lifecycle.Scoped, useFactory: () => 1 }],
    });
    const scope = vault.createScope();
    const get = vi.spyOn(SingletonCache.prototype, 'get');

    expect(scope.resolve(Value)).toBe(1);
    expect(get.mock.calls.filter(([id]) => id === Value.id)).toHaveLength(1);
  });

  it('passes one pending scoped async cache probe into the resolver', async () => {
    const Value = token<object>('PendingScopedProbe');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory = vi.fn(async () => {
      await gate;
      return {};
    });
    const vault = new Vault({
      providers: [{ provide: Value, lifecycle: Lifecycle.Scoped, useFactory: factory }],
    });
    const scope = vault.createScope();
    const state = scope as unknown as { _cache?: SingletonCache };

    const first = scope.resolveAsync(Value);
    expect(state._cache).toBeInstanceOf(SingletonCache);
    const get = vi.spyOn(state._cache!, 'get');
    const second = scope.resolveAsync(Value);

    expect(get).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(factory).toHaveBeenCalledTimes(1);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
  });

  it('uses fresh one-probe facts for a recursive cached scoped dependency', () => {
    const Dependency = token<object>('RecursiveScopedDependency');
    const Root = token<object>('RecursiveScopedRoot');
    const dependencyFactory = vi.fn(() => ({}));
    const vault = new Vault({
      providers: [
        { provide: Dependency, lifecycle: Lifecycle.Scoped, useFactory: dependencyFactory },
        {
          provide: Root,
          lifecycle: Lifecycle.Transient,
          deps: [Dependency],
          useFactory: (dependency) => dependency as object,
        },
      ],
    });
    const scope = vault.createScope();
    const dependency = scope.resolve(Dependency);
    const state = scope as unknown as { _cache: SingletonCache };
    const get = vi.spyOn(state._cache, 'get');

    expect(scope.resolve(Root)).toBe(dependency);
    expect(get.mock.calls.filter(([id]) => id === Root.id)).toHaveLength(1);
    expect(get.mock.calls.filter(([id]) => id === Dependency.id)).toHaveLength(1);
    expect(dependencyFactory).toHaveBeenCalledTimes(1);
  });

  it('hands one pending scoped probe across a Vault boundary', async () => {
    const Value = token<object>('CrossVaultPendingScopedProbe');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory = vi.fn(async () => {
      await gate;
      return {};
    });
    const producer = new Vault({
      providers: [{ provide: Value, lifecycle: Lifecycle.Scoped, useFactory: factory }],
      exports: [Value],
    });
    const consumer = new Vault({ providers: [], imports: [producer] });
    const scope = consumer.createScope();
    const state = scope as unknown as { _cache?: SingletonCache };

    const first = scope.resolveAsync(Value);
    expect(state._cache).toBeInstanceOf(SingletonCache);
    const get = vi.spyOn(state._cache!, 'get');
    const second = scope.resolveAsync(Value);

    expect(get).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
  });

  it('distinguishes a cached undefined value from a miss and preserves overrides', async () => {
    const Value = token<number | undefined>('ScopedUndefined');
    const factory = vi.fn(() => undefined);
    const vault = new Vault({
      providers: [{ provide: Value, lifecycle: Lifecycle.Scoped, useFactory: factory }],
    });
    const scope = vault.createScope();

    expect(scope.resolve(Value)).toBeUndefined();
    expect(scope.resolve(Value)).toBeUndefined();
    expect(factory).toHaveBeenCalledTimes(1);

    const overrideScope = vault.createScope();
    overrideScope.provide(Value, 7);
    expect(overrideScope.resolve(Value)).toBe(7);
    await expect(overrideScope.resolveAsync(Value)).resolves.toBe(7);
  });

  it('preserves public async singleton-first and bound Scope local-first ordering', async () => {
    const Value = token<number>('AsyncScopePrecedence');
    const vault = new Vault({ providers: [{ provide: Value, useValue: 1 }] });
    const scope = vault.createScope();

    await expect(vault.resolveAsync(Value)).resolves.toBe(1);
    scope.provide(Value, 2);

    await expect(scope.resolveAsync(Value)).resolves.toBe(2);
    await expect(vault.resolveAsync(Value, { scope })).resolves.toBe(1);
    expect(vault.resolve(Value, { scope })).toBe(2);
  });
});
