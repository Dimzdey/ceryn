import { beforeEach, describe, expect, it, vi } from 'vitest';

import { token } from '../src/core/token.js';
import { Vault } from '../src/core/vault.js';
import { Inject, Injectable } from '../src/decorators/index.js';
import {
  AggregateDisposalError,
  CircularModuleAttachmentError,
  FactoryExecutionError,
  InvalidTokenError,
  LifecycleViolationError,
  MultipleShadowPolicyViolationsError,
  ProviderNotFoundError,
  ScopedWithoutScopeError,
} from '../src/errors/errors.js';
import { MetadataRegistry } from '../src/registry/metadata-registry.js';
import { Lifecycle } from '../src/types/types.js';

describe('Vault integration', () => {
  beforeEach(() => {
    MetadataRegistry.resetForTests();
    Vault.setDefaultLazyResolver(undefined);
  });

  it('resolves singleton relics, value providers, and primes caches', () => {
    const FooToken = token('Foo');
    const BarToken = token('Bar');
    const ConfigToken = token('Config');
    const instantiateHook = vi.fn();

    @Injectable({ provide: BarToken })
    class Bar {
      value = Math.random();
    }

    @Injectable({ provide: FooToken })
    class Foo {
      constructor(
        @Inject(BarToken) public readonly bar: Bar,
        @Inject(ConfigToken) public readonly config: { base: string }
      ) {}
    }

    const vault = new Vault({
      name: 'AppVault',
      providers: [
        Bar,
        Foo,
        {
          provide: ConfigToken,
          useValue: { base: 'v1' },
        },
      ],
      exports: [FooToken],
      onInstantiate: instantiateHook,
    });

    const foo1 = vault.resolve(FooToken) as Foo;
    const foo2 = vault.resolve(FooToken);

    expect(foo1).toBe(foo2);
    expect(foo1.bar).toBeInstanceOf(Bar);
    expect(foo1.config).toEqual({ base: 'v1' });
    expect(instantiateHook).toHaveBeenCalledWith(BarToken.id, expect.any(Number));
    expect(instantiateHook).toHaveBeenCalledWith(FooToken.id, expect.any(Number));

    expect(vault.isRegistered(FooToken.id)).toBe(true);
    expect(vault.isExposed(FooToken.id)).toBe(true);
    expect(vault.getRegisteredTokens()).toEqual(
      expect.arrayContaining([BarToken.id, FooToken.id, ConfigToken.id])
    );

    const singletons = vault.getSingletons();
    expect(singletons.get(FooToken.id)).toBe(foo1);
    expect(singletons.get(BarToken.id)).toBe(foo1.bar);

    vault.clear();
    const foo3 = vault.resolve(FooToken);
    expect(foo3).not.toBe(foo1);
    expect(instantiateHook).toHaveBeenCalledWith(FooToken.id, expect.any(Number));
  });

  it('manages scoped and transient lifecycles', async () => {
    const ScopedToken = token('Scoped');
    const TransientToken = token('Transient');

    const disposed: unknown[] = [];

    @Injectable({ provide: ScopedToken, lifecycle: Lifecycle.Scoped })
    class ScopedService {
      dispose() {
        disposed.push(this);
      }
    }

    let transientCounter = 0;
    @Injectable({ provide: TransientToken, lifecycle: Lifecycle.Transient })
    class TransientService {
      readonly id = ++transientCounter;
    }

    const vault = new Vault({ providers: [ScopedService, TransientService] });

    const scopeA = vault.createScope();
    const scopeB = vault.createScope();

    const scopedA1 = scopeA.resolve(ScopedToken);
    const scopedA2 = scopeA.resolve(ScopedToken);
    const scopedB1 = scopeB.resolve(ScopedToken);

    expect(scopedA1).toBe(scopedA2);
    expect(scopedA1).not.toBe(scopedB1);

    const transient1 = vault.resolve(TransientToken);
    const transient2 = vault.resolve(TransientToken);
    expect(transient1).not.toBe(transient2);

    await scopeA.dispose();
    expect(disposed).toContain(scopedA1);
    await scopeB.dispose();

    expect(() => vault.resolve(ScopedToken)).toThrow(ScopedWithoutScopeError);
  });

  it('supports factory providers, async resolution, and cancellation', async () => {
    const SyncFactoryToken = token('SyncFactory');
    const AsyncFactoryToken = token('AsyncFactory');
    const CurriedFactoryToken = token('CurriedFactory');
    const AbortableToken = token('Abortable');

    const vault = new Vault({
      providers: [
        {
          provide: SyncFactoryToken,
          useFactory: () => ({ created: Symbol('sync') }),
        },
        {
          provide: AsyncFactoryToken,
          lifecycle: Lifecycle.Singleton,
          useFactory: async () => 'async-result',
        },
        {
          provide: CurriedFactoryToken,
          lifecycle: Lifecycle.Singleton,
          useFactory: () => async () => 'curried-result',
        },
        {
          provide: AbortableToken,
          lifecycle: Lifecycle.Transient,
          useFactory: (...deps: unknown[]) => {
            const _ctx = deps[0] as { signal?: AbortSignal } | undefined;
            return new Promise((_, reject) => {
              _ctx?.signal?.addEventListener(
                'abort',
                () => reject(new DOMException('Aborted', 'AbortError')),
                { once: true }
              );
            });
          },
        },
      ],
    });

    // Sync factory resolves via sync path
    const syncValue = vault.resolve(SyncFactoryToken);
    expect(vault.resolve(SyncFactoryToken)).toBe(syncValue);

    // Async factory requires resolveAsync and caches results
    expect(() => vault.resolve(AsyncFactoryToken)).toThrow(FactoryExecutionError);
    await expect(vault.resolveAsync(AsyncFactoryToken)).resolves.toBe('async-result');
    await expect(vault.resolveAsync(AsyncFactoryToken)).resolves.toBe('async-result');
    expect(vault.resolve(AsyncFactoryToken)).toBe('async-result');

    // Curried async factory
    expect(() => vault.resolve(CurriedFactoryToken)).toThrow(FactoryExecutionError);
    await expect(vault.resolveAsync(CurriedFactoryToken)).resolves.toBe('curried-result');
    expect(vault.resolve(CurriedFactoryToken)).toBe('curried-result');

    // Abortable transient factory
    const abort = new AbortController();
    const pending = vault.resolveAsync(AbortableToken, { signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toThrowError();
  });

  it('fuses vaults and resolves revealed relics from parents', () => {
    const SharedToken = token('Shared');
    const LocalToken = token('Local');

    @Injectable({ provide: SharedToken })
    class SharedRelic {}

    @Injectable({ provide: LocalToken })
    class LocalRelic {
      constructor(@Inject(SharedToken) public readonly shared: SharedRelic) {}
    }

    const sharedVault = new Vault({
      name: 'SharedVault',
      providers: [SharedRelic],
      exports: [SharedToken],
    });

    const appVault = new Vault({
      name: 'AppVault',
      providers: [LocalRelic],
      imports: [sharedVault],
      exports: [LocalToken],
    });

    expect(appVault.has(LocalToken)).toBe(true);
    expect(appVault.has(SharedToken)).toBe(true);
    expect(appVault.canResolve(LocalToken)).toBe(true);
    expect(appVault.canResolve(SharedToken)).toBe(true);

    const local = appVault.resolve(LocalToken) as LocalRelic;
    const shared = appVault.resolve(SharedToken);

    expect(local.shared).toBe(sharedVault.resolve(SharedToken));
    expect(shared).toBeInstanceOf(SharedRelic);
  });

  it('clears instances and aggregates disposal errors', async () => {
    const DisposableToken = token('Disposable');
    const AsyncDisposableToken = token('AsyncDisposable');

    const throwingDispose = vi.fn(() => {
      throw new Error('sync failure');
    });
    const asyncDispose = vi.fn(() => Promise.resolve());

    const vault = new Vault({
      providers: [
        { provide: DisposableToken, useValue: { dispose: throwingDispose }, owned: true },
        { provide: AsyncDisposableToken, useFactory: () => ({ dispose: asyncDispose }) },
      ],
    });

    // Access value to ensure cache prime path runs
    const disposableInstance = vault.resolve(DisposableToken);
    expect(disposableInstance).toHaveProperty('dispose', throwingDispose);
    const asyncDisposableInstance = vault.resolve(AsyncDisposableToken);
    expect(asyncDisposableInstance).toHaveProperty('dispose', asyncDispose);

    await expect(vault.dispose()).rejects.toThrow(AggregateDisposalError);
    expect(throwingDispose).toHaveBeenCalledTimes(1);
    expect(asyncDispose).toHaveBeenCalledTimes(1);

    // Subsequent dispose is a no-op
    expect(vault.dispose()).toBeUndefined();
  });

  it('does not dispose unowned useValue providers by default', () => {
    const ExternalToken = token('ExternalValue');
    const dispose = vi.fn();
    const external = { dispose };

    const vault = new Vault({
      providers: [{ provide: ExternalToken, useValue: external }],
    });

    expect(vault.resolve(ExternalToken)).toBe(external);
    vault.dispose();

    expect(dispose).not.toHaveBeenCalled();
  });

  it('disposes owned singleton instances in LIFO creation order', () => {
    const FirstToken = token('FirstDisposableSingleton');
    const SecondToken = token('SecondDisposableSingleton');
    const order: string[] = [];

    const vault = new Vault({
      providers: [
        { provide: FirstToken, useFactory: () => ({ dispose: () => order.push('first') }) },
        { provide: SecondToken, useFactory: () => ({ dispose: () => order.push('second') }) },
      ],
    });

    vault.resolve(FirstToken);
    vault.resolve(SecondToken);
    vault.dispose();

    expect(order).toEqual(['second', 'first']);
  });

  it('validates lifecycle dependencies eagerly', () => {
    const TransientToken = token('TransientDep');
    const SingletonToken = token('BadSingleton');

    @Injectable({ provide: TransientToken, lifecycle: Lifecycle.Transient })
    class TransientDep {}

    @Injectable({ provide: SingletonToken, lifecycle: Lifecycle.Singleton })
    class BadSingleton {
      constructor(@Inject(TransientToken) _dep: TransientDep) {}
    }

    expect(() => new Vault({ providers: [TransientDep, BadSingleton] })).toThrow(
      LifecycleViolationError
    );
  });

  it('produces detailed ProviderNotFoundError dependency chains', () => {
    const NeedsMissingToken = token('NeedsMissing');
    const MissingToken = token('Missing');

    @Injectable({ provide: NeedsMissingToken })
    class NeedsMissing {
      constructor(@Inject(MissingToken) _missing: unknown) {}
    }

    const vault = new Vault({ providers: [NeedsMissing] });

    try {
      vault.resolve(NeedsMissingToken);
      expect.fail('Expected resolve to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderNotFoundError);
      if (error instanceof ProviderNotFoundError) {
        expect(error.dependencyChain).toEqual(
          expect.arrayContaining([expect.stringContaining('NeedsMissing [tok_')])
        );
      }
    }
  });

  it('validates has() and canResolve() input tokens', () => {
    const TokenA = token('TokenA');

    const vault = new Vault({ providers: [] });
    expect(vault.has(TokenA)).toBe(false);
    expect(vault.canResolve(TokenA)).toBe(false);

    expect(() => vault.has({} as never)).toThrow(InvalidTokenError);
    expect(() => vault.canResolve({} as never)).toThrow(InvalidTokenError);
  });

  it('deduplicates async singleton creation across concurrent callers', async () => {
    const AsyncSingletonToken = token('AsyncSingleton');
    let resolveFactory: ((value: { value: string }) => void) | undefined;
    const factory = vi.fn(
      () =>
        new Promise<{ value: string }>((resolve) => {
          resolveFactory = resolve;
        })
    );

    const vault = new Vault({
      providers: [
        {
          provide: AsyncSingletonToken,
          lifecycle: Lifecycle.Singleton,
          useFactory: factory,
        },
      ],
    });

    const abort = new AbortController();
    const p1 = vault.resolveAsync(AsyncSingletonToken);
    const p2 = vault.resolveAsync(AsyncSingletonToken, { signal: abort.signal });

    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!resolveFactory) throw new Error('factory not started');
    abort.abort();
    resolveFactory({ value: 'singleton' });

    const r1 = await p1;
    await expect(p2).rejects.toThrow(DOMException);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(vault.resolve(AsyncSingletonToken)).toBe(r1);
    await expect(vault.resolveAsync(AsyncSingletonToken)).resolves.toBe(r1);
  });

  it('removes abort listeners after async singleton resolution completes', async () => {
    const AsyncSingletonToken = token('AsyncSingletonAbortListenerCleanup');
    const vault = new Vault({
      providers: [
        {
          provide: AsyncSingletonToken,
          lifecycle: Lifecycle.Singleton,
          useFactory: async () => ({ value: 'singleton' }),
        },
      ],
    });
    const controller = new AbortController();
    let activeAbortListeners = 0;
    const addEventListener = controller.signal.addEventListener.bind(controller.signal);
    const removeEventListener = controller.signal.removeEventListener.bind(controller.signal);

    vi.spyOn(controller.signal, 'addEventListener').mockImplementation(
      (type, listener, options) => {
        if (type === 'abort') activeAbortListeners++;
        return addEventListener(type, listener, options);
      }
    );
    vi.spyOn(controller.signal, 'removeEventListener').mockImplementation(
      (type, listener, options) => {
        if (type === 'abort') activeAbortListeners--;
        return removeEventListener(type, listener, options);
      }
    );

    await vault.resolveAsync(AsyncSingletonToken, { signal: controller.signal });

    expect(activeAbortListeners).toBe(0);
  });

  it('does not report false cycles for shared async sibling dependencies', async () => {
    const AToken = token<{ b: unknown; c: unknown }>('AsyncSiblingA');
    const BToken = token<{ value: string }>('AsyncSiblingB');
    const CToken = token<{ b: unknown }>('AsyncSiblingC');

    const vault = new Vault({
      providers: [
        {
          provide: AToken,
          useFactory: (b: unknown, c: unknown) => ({ b, c }),
          deps: [BToken, CToken],
        },
        {
          provide: BToken,
          useFactory: async () => {
            await Promise.resolve();
            return { value: 'b' };
          },
        },
        {
          provide: CToken,
          useFactory: (b: unknown) => ({ b }),
          deps: [BToken],
        },
      ],
    });

    const resolved = await vault.resolveAsync(AToken);

    expect(resolved.b).toBe((resolved.c as { b: unknown }).b);
  });

  it('resolves scoped async factories within scopes', async () => {
    const AsyncScopedToken = token('AsyncScoped');
    const disposer = vi.fn();
    const factory = vi.fn(async () => ({
      dispose: disposer,
    }));

    const vault = new Vault({
      providers: [
        {
          provide: AsyncScopedToken,
          lifecycle: Lifecycle.Scoped,
          useFactory: factory,
        },
      ],
    });

    const scopeA = vault.createScope();
    const scopeB = vault.createScope();

    const scopedA1 = await vault.resolveAsync(AsyncScopedToken, { scope: scopeA });
    const scopedA2 = await vault.resolveAsync(AsyncScopedToken, { scope: scopeA });
    const scopedB1 = await vault.resolveAsync(AsyncScopedToken, { scope: scopeB });

    expect(scopedA1).toBe(scopedA2);
    expect(scopedA1).not.toBe(scopedB1);
    expect(factory).toHaveBeenCalledTimes(2);

    await scopeA.dispose();
    expect(disposer).toHaveBeenCalledTimes(1);
    await scopeB.dispose();
    expect(disposer).toHaveBeenCalledTimes(2);

    await expect(vault.resolveAsync(AsyncScopedToken)).rejects.toThrow(ScopedWithoutScopeError);
  });

  it('propagates already-aborted signals when resolving transients', async () => {
    const AbortToken = token('AbortToken');
    const factory = vi.fn(async () => 'never');

    const vault = new Vault({
      providers: [
        {
          provide: AbortToken,
          lifecycle: Lifecycle.Transient,
          useFactory: factory,
        },
      ],
    });

    const controller = new AbortController();
    controller.abort();

    await expect(vault.resolveAsync(AbortToken, { signal: controller.signal })).rejects.toThrow(
      DOMException
    );
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('retries async singleton factories after failures', async () => {
    const RetryToken = token('Retry');
    const factory = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error('first failure');
      })
      .mockResolvedValue('success');

    const vault = new Vault({
      providers: [
        {
          provide: RetryToken,
          lifecycle: Lifecycle.Singleton,
          useFactory: factory,
        },
      ],
    });

    await expect(vault.resolveAsync(RetryToken)).rejects.toThrow(FactoryExecutionError);
    await expect(vault.resolveAsync(RetryToken)).resolves.toBe('success');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('detects circular vault attachments', () => {
    const vaultA = new Vault({ name: 'VaultA' });
    const vaultB = new Vault({ name: 'VaultB' });

    vaultA.importedModules.push(vaultB);
    vaultB.importedModules.push(vaultA);

    const checker = vaultA as unknown as {
      _checkCircularAttachment: (vaults: Vault[], path: string[], stack: Set<Vault>) => void;
    };

    expect(() =>
      checker._checkCircularAttachment(vaultA.importedModules, ['VaultA'], new Set([vaultA]))
    ).toThrow(CircularModuleAttachmentError);
  });

  it('enforces shadow policy for conflicting exposures', () => {
    const ShadowToken = token('Shadowed');

    const producer = new Vault({
      name: 'Producer',
      providers: [{ provide: ShadowToken, useValue: { source: 'producer' } }],
      exports: [ShadowToken],
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new Vault({
      name: 'WarnVault',
      providers: [{ provide: ShadowToken, useValue: { source: 'warn' } }],
      imports: [producer],
      shadowPolicy: 'warn',
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();

    expect(
      () =>
        new Vault({
          name: 'ErrorVault',
          providers: [{ provide: ShadowToken, useValue: { source: 'error' } }],
          imports: [producer],
          shadowPolicy: 'error',
        })
    ).toThrow(MultipleShadowPolicyViolationsError);

    expect(
      () =>
        new Vault({
          name: 'AllowVault',
          providers: [{ provide: ShadowToken, useValue: { source: 'allow' } }],
          imports: [producer],
          shadowPolicy: 'allow',
        })
    ).not.toThrow();
  });
});
