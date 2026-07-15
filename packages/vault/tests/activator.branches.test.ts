import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Entry } from '../src/core/entry-store.js';
import { FLAG_HAS_NO_DEPS } from '../src/core/flags.js';
import { ResolutionPath } from '../src/core/resolution-path.js';
import type { CanonicalId } from '../src/core/token.js';

const baseEntry = (overrides: Partial<Entry> = {}): Entry => ({
  token: 'tok_branch' as CanonicalId,
  factoryDeps: [],
  metadata: { name: 'tok_branch' as CanonicalId, label: 'TokBranch', lifecycle: 'singleton' },
  summons: [],
  aliases: ['tok_branch'],
  flags: 0,
  ...overrides,
});

const stubVault = () => {
  const resolve = vi.fn();
  const resolveAsync = vi.fn();
  const hook = vi.fn();
  return {
    getInstantiateHook: vi.fn(),
    _resolveProvider: resolve,
    _resolveProviderAsync: resolveAsync,
    hook,
  };
};

const importActivator = async (perf: { now: () => number } | undefined) => {
  vi.resetModules();
  if (perf === undefined) {
    vi.stubGlobal('performance', undefined);
  } else {
    vi.stubGlobal('performance', perf);
  }
  const mod = await import('../src/core/activator.js');
  vi.unstubAllGlobals();
  return mod.Activator;
};

describe('Activator branches', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('selects appropriate timer strategy based on global performance', async () => {
    const withPerf = await importActivator({ now: () => 123 });
    const vaultA = stubVault();
    const perfHook = vi.fn();
    vaultA.getInstantiateHook.mockReturnValue(perfHook);
    const activatorA = new withPerf(vaultA as never);
    const entry = baseEntry({ ctor: class {} });
    expect(activatorA.instantiateSync(entry, new ResolutionPath())).toBeInstanceOf(entry.ctor!);
    expect(perfHook).toHaveBeenCalledWith(entry.token, expect.any(Number));

    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(10);
    const withoutPerf = await importActivator(undefined);
    const vaultB = stubVault();
    const fallbackHook = vi.fn();
    vaultB.getInstantiateHook.mockReturnValue(fallbackHook);
    const activatorB = new withoutPerf(vaultB as never);
    expect(activatorB.instantiateSync(entry, new ResolutionPath())).toBeInstanceOf(entry.ctor!);
    expect(dateSpy).toHaveBeenCalled();
    expect(fallbackHook).toHaveBeenCalledWith(entry.token, expect.any(Number));
    dateSpy.mockRestore();
  });

  it('covers sync instrumentation branches with and without hooks', async () => {
    const { Activator } = await import('../src/core/activator.js');
    const vault = stubVault();
    const activator = new Activator(vault as never);
    const entry = baseEntry({ ctor: class {} });

    // No hook path
    expect(activator.instantiateSync(entry, new ResolutionPath())).toBeInstanceOf(entry.ctor!);

    const hook = vi.fn();
    vault.getInstantiateHook.mockReturnValue(hook);
    expect(activator.instantiateSync(entry, new ResolutionPath())).toBeInstanceOf(entry.ctor!);
    expect(hook).toHaveBeenCalledWith(entry.token, expect.any(Number));
  });

  it('validates sync factories including promise and curried return values', async () => {
    const { Activator } = await import('../src/core/activator.js');
    const vault = stubVault();
    const activator = new Activator(vault as never);
    const entryPromise = baseEntry({
      factory: () => Promise.resolve(123),
    });
    expect(() => activator.instantiateSync(entryPromise, new ResolutionPath())).toThrowError(
      /Factory execution failed/
    );

    const entryCurried = baseEntry({
      factory: () => () => Promise.resolve(1),
    });
    expect(() => activator.instantiateSync(entryCurried, new ResolutionPath())).toThrowError(
      /Factory execution failed/
    );

    const innerError = new Error('boom');
    const entryThrows = baseEntry({
      factory: () => {
        throw innerError;
      },
    });
    expect(() => activator.instantiateSync(entryThrows, new ResolutionPath())).toThrowError(
      /Factory execution failed/
    );
  });

  it('handles value providers and missing constructor metadata', async () => {
    const { Activator } = await import('../src/core/activator.js');
    const vault = stubVault();
    const activator = new Activator(vault as never);

    const valueEntry = baseEntry({
      ctor: undefined,
      instance: { prebuilt: true },
    });
    expect(activator.instantiateSync(valueEntry, new ResolutionPath())).toEqual({ prebuilt: true });

    const badValueEntry = baseEntry({
      ctor: undefined,
      instance: undefined,
    });
    expect(() => activator.instantiateSync(badValueEntry, new ResolutionPath())).toThrowError(
      /Unconstructable provider/
    );

    const missingDeps = baseEntry({
      ctor: class Missing {},
      summons: [undefined],
    });
    expect(() => activator.instantiateSync(missingDeps, new ResolutionPath())).toThrowError(
      'Missing @Inject decorator'
    );

    const zeroDeps = baseEntry({
      ctor: class ZeroDeps {},
      flags: FLAG_HAS_NO_DEPS,
    });
    expect(activator.instantiateSync(zeroDeps, new ResolutionPath())).toBeInstanceOf(
      zeroDeps.ctor!
    );
  });

  it('covers async factory branches, including abort handling and currying', async () => {
    const { Activator } = await import('../src/core/activator.js');
    const vault = stubVault();
    const activator = new Activator(vault as never);

    const asyncEntry = baseEntry({
      factory: async () => 'async-result',
    });
    await expect(activator.instantiateAsync(asyncEntry, new ResolutionPath())).resolves.toBe(
      'async-result'
    );

    const expectsSignal = baseEntry({
      factoryDeps: ['dep' as CanonicalId],
      factory: vi.fn(async (_dep, opts) => opts.signal),
    });
    vault._resolveProviderAsync.mockResolvedValueOnce('dep-value');
    const ac = new AbortController();
    await expect(
      activator.instantiateAsync(expectsSignal, new ResolutionPath(), ac.signal)
    ).resolves.toBe(ac.signal);

    const curriedAsync = baseEntry({
      factory:
        () =>
        async ({ signal }: { signal: AbortSignal }) =>
          signal ? 'signalled' : 'plain',
    });
    await expect(
      activator.instantiateAsync(curriedAsync, new ResolutionPath(), ac.signal)
    ).resolves.toBe('signalled');

    const abortingFactory = baseEntry({
      factory: async () => {
        throw new Error('fail');
      },
    });
    ac.abort();
    await expect(
      activator.instantiateAsync(abortingFactory, new ResolutionPath(), ac.signal)
    ).rejects.toThrow(/Factory for/);

    const throwingFactory = baseEntry({
      factory: async () => {
        throw new Error('async-fail');
      },
    });
    const controller = new AbortController();
    await expect(
      activator.instantiateAsync(throwingFactory, new ResolutionPath(), controller.signal)
    ).rejects.toThrowError(/Factory execution failed/);

    const missingCtor = baseEntry({
      factory: undefined,
      ctor: undefined,
      instance: undefined,
    });
    await expect(
      activator.instantiateAsync(missingCtor, new ResolutionPath())
    ).rejects.toThrowError(/Unconstructable provider/);

    const zeroDeps = baseEntry({
      factory: undefined,
      ctor: class ZeroDep {},
      flags: FLAG_HAS_NO_DEPS,
    });
    await expect(
      activator.instantiateAsync(zeroDeps, new ResolutionPath())
    ).resolves.toBeInstanceOf(zeroDeps.ctor!);

    const missingSummon = baseEntry({
      factory: undefined,
      ctor: class Missing {},
      summons: [undefined],
    });
    await expect(
      activator.instantiateAsync(missingSummon, new ResolutionPath())
    ).rejects.toThrowError(/Missing @Inject decorator/);
  });

  it('skips Promise.all for an async factory without dependencies', async () => {
    const { Activator } = await import('../src/core/activator.js');
    const vault = stubVault();
    const activator = new Activator(vault as never);
    const aggregate = vi.spyOn(Promise, 'all');
    const entry = baseEntry({ factoryDeps: [], factory: async () => 'value' });

    const value = await activator.instantiateAsync(entry, new ResolutionPath());

    expect(value).toBe('value');
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('does not map zero or one sync dependency', async () => {
    const { Activator } = await import('../src/core/activator.js');
    const vault = stubVault();
    vault._resolveProvider.mockReturnValue('resolved');
    const activator = new Activator(vault as never);

    const zero = [] as CanonicalId[];
    const zeroMap = vi.spyOn(zero, 'map');
    const zeroFactory = baseEntry({ factoryDeps: zero, factory: () => 'zero' });
    expect(activator.instantiateSync(zeroFactory, new ResolutionPath())).toBe('zero');
    expect(zeroMap).not.toHaveBeenCalled();

    const oneFactoryDep = ['factory-dependency' as CanonicalId];
    const factoryMap = vi.spyOn(oneFactoryDep, 'map');
    const oneFactory = baseEntry({
      factoryDeps: oneFactoryDep,
      factory: (dependency) => dependency,
    });
    expect(activator.instantiateSync(oneFactory, new ResolutionPath())).toBe('resolved');
    expect(factoryMap).not.toHaveBeenCalled();

    class OneDependency {
      constructor(readonly dependency: unknown) {}
    }
    const oneSummon = ['constructor-dependency' as CanonicalId];
    const summonMap = vi.spyOn(oneSummon, 'map');
    const oneConstructor = baseEntry({ ctor: OneDependency, summons: oneSummon });
    const value = activator.instantiateSync(oneConstructor, new ResolutionPath()) as OneDependency;
    expect(value.dependency).toBe('resolved');
    expect(summonMap).not.toHaveBeenCalled();
  });

  it('avoids Promise.all for one async factory or constructor dependency', async () => {
    const { Activator } = await import('../src/core/activator.js');
    const vault = stubVault();
    vault._resolveProviderAsync.mockResolvedValue('resolved');
    const activator = new Activator(vault as never);
    const aggregate = vi.spyOn(Promise, 'all');
    const path = new ResolutionPath();
    path.enter('root' as CanonicalId);

    const factoryEntry = baseEntry({
      factoryDeps: ['factory-dependency' as CanonicalId],
      factory: async (dependency) => dependency,
    });
    await expect(activator.instantiateAsync(factoryEntry, path)).resolves.toBe('resolved');
    expect(aggregate).not.toHaveBeenCalled();
    aggregate.mockClear();

    class OneDependency {
      constructor(readonly dependency: unknown) {}
    }
    const constructorEntry = baseEntry({
      ctor: OneDependency,
      summons: ['constructor-dependency' as CanonicalId],
    });
    const value = (await activator.instantiateAsync(constructorEntry, path)) as OneDependency;
    expect(value.dependency).toBe('resolved');
    expect(aggregate).not.toHaveBeenCalled();
    for (const call of vault._resolveProviderAsync.mock.calls) {
      const dependencyPath = call[1] as ResolutionPath;
      expect(dependencyPath).not.toBe(path);
      expect(dependencyPath.tokens).toEqual(path.tokens);
    }
  });

  it('bypasses instrumentation methods when no hook exists', async () => {
    const { Activator } = await import('../src/core/activator.js');
    const vault = stubVault();
    const activator = new Activator(vault as never);
    const internal = activator as unknown as {
      instrumentSync: (...args: unknown[]) => unknown;
      instrumentAsync: (...args: unknown[]) => Promise<unknown>;
    };
    const syncInstrument = vi.spyOn(internal, 'instrumentSync');
    const asyncInstrument = vi.spyOn(internal, 'instrumentAsync');

    const ctorEntry = baseEntry({ ctor: class NoHook {}, flags: FLAG_HAS_NO_DEPS });
    activator.instantiateSync(ctorEntry, new ResolutionPath());
    const factoryEntry = baseEntry({ factory: async () => 'value' });
    await activator.instantiateAsync(factoryEntry, new ResolutionPath());

    expect(syncInstrument).not.toHaveBeenCalled();
    expect(asyncInstrument).not.toHaveBeenCalled();
  });

  it('reports one hook event for every zero, one, and many specialized branch', async () => {
    const { Activator } = await import('../src/core/activator.js');
    const vault = stubVault();
    vault._resolveProvider.mockImplementation((dependency) => dependency);
    vault._resolveProviderAsync.mockImplementation(async (dependency) => dependency);
    const hook = vi.fn();
    vault.getInstantiateHook.mockReturnValue(hook);
    const activator = new Activator(vault as never);

    class Capture {
      constructor(..._dependencies: unknown[]) {}
    }

    const syncEntries = [
      baseEntry({ factory: () => 0, factoryDeps: [] }),
      baseEntry({ factory: (...deps) => deps.length, factoryDeps: ['one' as CanonicalId] }),
      baseEntry({
        factory: (...deps) => deps.length,
        factoryDeps: ['one' as CanonicalId, 'two' as CanonicalId],
      }),
      baseEntry({ ctor: Capture, flags: FLAG_HAS_NO_DEPS, summons: [] }),
      baseEntry({ ctor: Capture, summons: ['one' as CanonicalId] }),
      baseEntry({ ctor: Capture, summons: ['one' as CanonicalId, 'two' as CanonicalId] }),
    ];
    for (const entry of syncEntries) {
      activator.instantiateSync(entry, new ResolutionPath());
    }
    expect(hook).toHaveBeenCalledTimes(6);

    hook.mockClear();
    const asyncEntries = [
      baseEntry({ factory: async () => 0, factoryDeps: [] }),
      baseEntry({
        factory: async (...deps) => deps.length,
        factoryDeps: ['one' as CanonicalId],
      }),
      baseEntry({
        factory: async (...deps) => deps.length,
        factoryDeps: ['one' as CanonicalId, 'two' as CanonicalId],
      }),
      baseEntry({ ctor: Capture, flags: FLAG_HAS_NO_DEPS, summons: [] }),
      baseEntry({ ctor: Capture, summons: ['one' as CanonicalId] }),
      baseEntry({ ctor: Capture, summons: ['one' as CanonicalId, 'two' as CanonicalId] }),
    ];
    for (const entry of asyncEntries) {
      await activator.instantiateAsync(entry, new ResolutionPath());
    }
    expect(hook).toHaveBeenCalledTimes(6);
    expect(hook).toHaveBeenCalledWith('tok_branch', expect.any(Number));
  });

  it('starts later async siblings when a multi-summon entry is malformed', async () => {
    const { Activator } = await import('../src/core/activator.js');
    const { MissingInjectDecoratorError } = await import('../src/errors/errors.js');
    const vault = stubVault();
    vault._resolveProviderAsync.mockResolvedValue('resolved');
    const activator = new Activator(vault as never);
    const entry = baseEntry({
      ctor: class MultiSummon {},
      summons: ['first' as CanonicalId, undefined, 'third' as CanonicalId],
    });

    await expect(activator.instantiateAsync(entry, new ResolutionPath())).rejects.toThrow(
      MissingInjectDecoratorError
    );
    expect(vault._resolveProviderAsync.mock.calls.map(([token]) => token)).toEqual([
      'first',
      'third',
    ]);
  });

  it('runs a hook once when a specialized factory throws or rejects', async () => {
    const { Activator } = await import('../src/core/activator.js');
    const { FactoryExecutionError } = await import('../src/errors/errors.js');
    const vault = stubVault();
    const hook = vi.fn();
    vault.getInstantiateHook.mockReturnValue(hook);
    const activator = new Activator(vault as never);

    const syncCause = new Error('sync cause');
    let syncReason: unknown;
    try {
      activator.instantiateSync(
        baseEntry({
          factory: () => {
            throw syncCause;
          },
          factoryDeps: [],
        }),
        new ResolutionPath()
      );
    } catch (error) {
      syncReason = error;
    }
    expect(syncReason).toBeInstanceOf(FactoryExecutionError);
    expect((syncReason as FactoryExecutionError).cause).toBe(syncCause);
    expect(hook).toHaveBeenCalledTimes(1);

    hook.mockClear();
    const asyncCause = new Error('async cause');
    const asyncReason = await activator
      .instantiateAsync(
        baseEntry({
          factory: async () => {
            throw asyncCause;
          },
          factoryDeps: [],
        }),
        new ResolutionPath()
      )
      .catch((error: unknown) => error);
    expect(asyncReason).toBeInstanceOf(FactoryExecutionError);
    expect((asyncReason as FactoryExecutionError).cause).toBe(asyncCause);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('retains concurrent aggregation with forked dependency paths', async () => {
    const { Activator } = await import('../src/core/activator.js');
    const vault = stubVault();
    let releaseFirst!: (value: string) => void;
    let releaseSecond!: (value: string) => void;
    const first = new Promise<string>((resolve) => {
      releaseFirst = resolve;
    });
    const second = new Promise<string>((resolve) => {
      releaseSecond = resolve;
    });
    vault._resolveProviderAsync.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const activator = new Activator(vault as never);
    const aggregate = vi.spyOn(Promise, 'all');
    const path = new ResolutionPath();
    path.enter('root' as CanonicalId);
    const entry = baseEntry({
      factoryDeps: ['first' as CanonicalId, 'second' as CanonicalId],
      factory: async (a, b) => `${String(a)}:${String(b)}`,
    });

    const pending = activator.instantiateAsync(entry, path);
    expect(vault._resolveProviderAsync).toHaveBeenCalledTimes(2);
    expect(aggregate).toHaveBeenCalledTimes(1);
    const firstPath = vault._resolveProviderAsync.mock.calls[0][1] as ResolutionPath;
    const secondPath = vault._resolveProviderAsync.mock.calls[1][1] as ResolutionPath;
    expect(firstPath).not.toBe(path);
    expect(secondPath).not.toBe(path);
    expect(firstPath).not.toBe(secondPath);
    expect(firstPath.tokens).toEqual(path.tokens);
    expect(secondPath.tokens).toEqual(path.tokens);

    releaseFirst('a');
    releaseSecond('b');
    await expect(pending).resolves.toBe('a:b');
  });
});
