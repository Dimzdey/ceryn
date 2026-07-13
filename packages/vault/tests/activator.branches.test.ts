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

  it('retains concurrent aggregation with forked dependency paths', async () => {
    const { Activator } = await import('../src/core/activator.js');
    const vault = stubVault();
    vault._resolveProviderAsync.mockResolvedValue('dependency');
    const activator = new Activator(vault as never);
    const aggregate = vi.spyOn(Promise, 'all');
    const path = new ResolutionPath();
    path.enter('root' as CanonicalId);
    const entry = baseEntry({
      factoryDeps: ['dependency' as CanonicalId],
      factory: async (dependency) => dependency,
    });

    const value = await activator.instantiateAsync(entry, path);

    expect(value).toBe('dependency');
    expect(aggregate).toHaveBeenCalledTimes(1);
    const dependencyPath = vault._resolveProviderAsync.mock.calls[0][1] as ResolutionPath;
    expect(dependencyPath).not.toBe(path);
    expect(dependencyPath.tokens).toEqual(path.tokens);
  });
});
