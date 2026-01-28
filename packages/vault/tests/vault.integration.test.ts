import { beforeEach, describe, expect, it, vi } from 'vitest';

import { token } from '../src/core/token.js';
import { Vault } from '../src/core/vault.js';
import { Relic, Summon } from '../src/decorators/index.js';
import {
  AggregateDisposalError,
  CircularVaultAttachmentError,
  FactoryExecutionError,
  InvalidTokenError,
  LifecycleViolationError,
  MultipleShadowPolicyViolationsError,
  RelicNotFoundError,
  ScopedWithoutScopeError,
} from '../src/errors/errors.js';
import { StaticRelicRegistry } from '../src/registry/static-registry.js';
import { Lifecycle } from '../src/types/types.js';

describe('Vault integration', () => {
  beforeEach(() => {
    StaticRelicRegistry.resetForTests();
    Vault.setDefaultLazyResolver(undefined);
  });

  it('resolves singleton relics, value providers, and primes caches', () => {
    const FooToken = token('Foo');
    const BarToken = token('Bar');
    const ConfigToken = token('Config');
    const instantiateHook = vi.fn();

    @Relic({ provide: BarToken })
    class Bar {
      value = Math.random();
    }

    @Relic({ provide: FooToken })
    class Foo {
      constructor(
        @Summon(BarToken) public readonly bar: Bar,
        @Summon(ConfigToken) public readonly config: { base: string }
      ) {}
    }

    const vault = new Vault({
      name: 'AppVault',
      relics: [
        Bar,
        Foo,
        {
          provide: ConfigToken,
          useValue: { base: 'v1' },
        },
      ],
      reveal: [FooToken],
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

    @Relic({ provide: ScopedToken, lifecycle: Lifecycle.Scoped })
    class ScopedService {
      dispose() {
        disposed.push(this);
      }
    }

    let transientCounter = 0;
    @Relic({ provide: TransientToken, lifecycle: Lifecycle.Transient })
    class TransientService {
      readonly id = ++transientCounter;
    }

    const vault = new Vault({ relics: [ScopedService, TransientService] });

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
      relics: [
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

    @Relic({ provide: SharedToken })
    class SharedRelic {}

    @Relic({ provide: LocalToken })
    class LocalRelic {
      constructor(@Summon(SharedToken) public readonly shared: SharedRelic) {}
    }

    const sharedVault = new Vault({
      name: 'SharedVault',
      relics: [SharedRelic],
      reveal: [SharedToken],
    });

    const appVault = new Vault({
      name: 'AppVault',
      relics: [LocalRelic],
      fuse: [sharedVault],
      reveal: [LocalToken],
    });

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
      relics: [
        { provide: DisposableToken, useValue: { dispose: throwingDispose } },
        { provide: AsyncDisposableToken, useValue: { dispose: asyncDispose } },
      ],
    });

    // Access value to ensure cache prime path runs
    const disposableInstance = vault.resolve(DisposableToken);
    expect(disposableInstance).toHaveProperty('dispose', throwingDispose);

    await expect(vault.dispose()).rejects.toThrow(AggregateDisposalError);
    expect(throwingDispose).toHaveBeenCalledTimes(1);
    expect(asyncDispose).toHaveBeenCalledTimes(1);

    // Subsequent dispose is a no-op
    expect(vault.dispose()).toBeUndefined();
  });

  it('validates lifecycle dependencies eagerly', () => {
    const TransientToken = token('TransientDep');
    const SingletonToken = token('BadSingleton');

    @Relic({ provide: TransientToken, lifecycle: Lifecycle.Transient })
    class TransientDep {}

    @Relic({ provide: SingletonToken, lifecycle: Lifecycle.Singleton })
    class BadSingleton {
      constructor(@Summon(TransientToken) _dep: TransientDep) {}
    }

    expect(() => new Vault({ relics: [TransientDep, BadSingleton] })).toThrow(
      LifecycleViolationError
    );
  });

  it('produces detailed RelicNotFoundError dependency chains', () => {
    const NeedsMissingToken = token('NeedsMissing');
    const MissingToken = token('Missing');

    @Relic({ provide: NeedsMissingToken })
    class NeedsMissing {
      constructor(@Summon(MissingToken) _missing: unknown) {}
    }

    const vault = new Vault({ relics: [NeedsMissing] });

    try {
      vault.resolve(NeedsMissingToken);
      expect.fail('Expected resolve to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(RelicNotFoundError);
      if (error instanceof RelicNotFoundError) {
        expect(error.dependencyChain).toEqual(
          expect.arrayContaining([expect.stringContaining('NeedsMissing [tok_')])
        );
      }
    }
  });

  it('validates canResolve input tokens', () => {
    const TokenA = token('TokenA');

    const vault = new Vault({ relics: [] });
    expect(vault.canResolve(TokenA)).toBe(false);

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
      relics: [
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

  it('resolves scoped async factories within scopes', async () => {
    const AsyncScopedToken = token('AsyncScoped');
    const disposer = vi.fn();
    const factory = vi.fn(async () => ({
      dispose: disposer,
    }));

    const vault = new Vault({
      relics: [
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
      relics: [
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
      relics: [
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

    vaultA.fusedVaults.push(vaultB);
    vaultB.fusedVaults.push(vaultA);

    const checker = vaultA as unknown as {
      _checkCircularAttachment: (vaults: Vault[], path: string[], stack: Set<Vault>) => void;
    };

    expect(() =>
      checker._checkCircularAttachment(vaultA.fusedVaults, ['VaultA'], new Set([vaultA]))
    ).toThrow(CircularVaultAttachmentError);
  });

  it('enforces shadow policy for conflicting exposures', () => {
    const ShadowToken = token('Shadowed');

    const producer = new Vault({
      name: 'Producer',
      relics: [{ provide: ShadowToken, useValue: { source: 'producer' } }],
      reveal: [ShadowToken],
    });

    const warnVault = new Vault({
      name: 'WarnVault',
      relics: [{ provide: ShadowToken, useValue: { source: 'warn' } }],
      fuse: [producer],
      shadowPolicy: 'warn',
    });
    warnVault['resolveLazyAttachments']();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (warnVault as unknown as { _enforceShadowPolicy(): void })._enforceShadowPolicy();
    (warnVault as unknown as { _enforceShadowPolicy(): void })._enforceShadowPolicy();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();

    const errorVault = new Vault({
      name: 'ErrorVault',
      relics: [{ provide: ShadowToken, useValue: { source: 'error' } }],
      fuse: [producer],
      shadowPolicy: 'error',
    });
    errorVault['resolveLazyAttachments']();
    expect(() =>
      (errorVault as unknown as { _enforceShadowPolicy(): void })._enforceShadowPolicy()
    ).toThrow(MultipleShadowPolicyViolationsError);

    const allowVault = new Vault({
      name: 'AllowVault',
      relics: [{ provide: ShadowToken, useValue: { source: 'allow' } }],
      fuse: [producer],
      shadowPolicy: 'allow',
    });
    allowVault['resolveLazyAttachments']();
    expect(() =>
      (allowVault as unknown as { _enforceShadowPolicy(): void })._enforceShadowPolicy()
    ).not.toThrow();
  });
});
