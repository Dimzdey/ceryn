/**
 * Edge-case contract tests.
 *
 * These tests lock expected runtime semantics and regression cases.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Entry } from '../src/core/entry-store.js';
import { FLAG_DISPOSAL_TRACKED, FLAG_HAS_INSTANCE } from '../src/core/flags.js';
import { ResolutionPath } from '../src/core/resolution-path.js';
import { token } from '../src/core/token.js';
import { Vault } from '../src/core/vault.js';
import { Inject, Injectable } from '../src/decorators/index.js';
import {
  AggregateDisposalError,
  CircularDependencyError,
  ContainerDisposedError,
  FactoryExecutionError,
  InvalidModuleConfigError,
  LifecycleViolationError,
} from '../src/errors/errors.js';
import { MetadataRegistry } from '../src/registry/metadata-registry.js';
import { Lifecycle } from '../src/types/types.js';

type PromiseEntry = Entry & { resolvedPromise?: Promise<unknown> };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  MetadataRegistry.resetForTests();
  Vault.setDefaultLazyResolver(undefined);
});

// ---------------------------------------------------------------------------
// 1. Resolution precedence
// ---------------------------------------------------------------------------

describe('Resolution precedence', () => {
  it('scope-local registration overrides module singleton when resolving inside a scope', () => {
    const ServiceT = token<{ source: string }>('PrecedenceService');
    const moduleInstance = { source: 'module' };

    const vault = new Vault({
      providers: [{ provide: ServiceT, useValue: moduleInstance }],
    });
    const scope = vault.createScope();
    const scopeInstance = { source: 'scope-local' };
    scope.provide(ServiceT, scopeInstance);

    expect(scope.resolve(ServiceT)).toBe(scopeInstance);
    expect(vault.resolve(ServiceT)).toBe(moduleInstance);
  });

  it('module-local provider is preferred over same token from imported module', () => {
    const SharedT = token<string>('PrecedenceShared');

    const imported = new Vault({
      providers: [{ provide: SharedT, useValue: 'imported' }],
      exports: [SharedT],
    });
    const local = new Vault({
      providers: [{ provide: SharedT, useValue: 'local' }],
      imports: [imported],
      shadowPolicy: 'allow',
    });

    expect(local.resolve(SharedT)).toBe('local');
  });

  it('global module provider is visible to deeply nested importers', () => {
    const GlobalT = token<string>('PrecedenceGlobal');

    const global = new Vault({
      providers: [{ provide: GlobalT, useValue: 'global-value' }],
      global: true,
    });
    const middle = new Vault({ imports: [global] });
    const leaf = new Vault({ imports: [middle] });

    expect(leaf.resolve(GlobalT)).toBe('global-value');
  });

  it('explicit exported import is visible; non-exported import is not', () => {
    const ExportedT = token<string>('PrecedenceExported');
    const HiddenT = token<string>('PrecedenceHidden');

    const imported = new Vault({
      providers: [
        { provide: ExportedT, useValue: 'exported-value' },
        { provide: HiddenT, useValue: 'hidden-value' },
      ],
      exports: [ExportedT],
    });
    const root = new Vault({ imports: [imported] });

    expect(root.resolve(ExportedT)).toBe('exported-value');
    expect(root.has(HiddenT)).toBe(false);
    expect(() => root.resolve(HiddenT)).toThrow();
  });

  it('scope-local registration is not visible to the parent vault', () => {
    const LocalOnlyT = token<string>('PrecedenceScopeLocalOnly');

    const vault = new Vault({});
    const scope = vault.createScope();
    scope.provide(LocalOnlyT, 'only-in-scope');

    expect(vault.has(LocalOnlyT)).toBe(false);
    expect(() => vault.resolve(LocalOnlyT)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Re-export of imported tokens
// ---------------------------------------------------------------------------

describe('Module re-export of imported tokens', () => {
  it('does not expose a nested export unless the middle module re-exports it', () => {
    const ServiceT = token<string>('NestedPrivateExport');

    const producer = new Vault({
      name: 'NestedProducer',
      providers: [{ provide: ServiceT, useValue: 'produced' }],
      exports: [ServiceT],
    });
    const middle = new Vault({
      name: 'NestedMiddle',
      imports: [producer],
    });
    const consumer = new Vault({
      name: 'NestedConsumer',
      imports: [middle],
    });

    expect(consumer.has(ServiceT)).toBe(false);
    expect(() => consumer.resolve(ServiceT)).toThrow();
  });

  it('a middle module can re-export a token it imported and did not define', () => {
    const ServiceT = token<string>('ReExportService');

    const producer = new Vault({
      name: 'Producer',
      providers: [{ provide: ServiceT, useValue: 'produced' }],
      exports: [ServiceT],
    });
    const middle = new Vault({
      name: 'Middle',
      imports: [producer],
      exports: [ServiceT],
    });
    const consumer = new Vault({
      name: 'Consumer',
      imports: [middle],
    });

    expect(consumer.resolve(ServiceT)).toBe('produced');
  });

  it('allows a global middle module to re-export an imported token', () => {
    const ServiceT = token<string>('GlobalReExportService');

    const producer = new Vault({
      name: 'GlobalReExportProducer',
      providers: [{ provide: ServiceT, useValue: 'produced' }],
      exports: [ServiceT],
    });
    const middle = new Vault({
      name: 'GlobalReExportMiddle',
      imports: [producer],
      exports: [ServiceT],
      global: true,
    });
    const consumer = new Vault({
      name: 'GlobalReExportConsumer',
      imports: [middle],
    });

    expect(consumer.resolve(ServiceT)).toBe('produced');
  });

  it('a module cannot export a token that is neither locally defined nor imported', () => {
    const GhostT = token<string>('ReExportGhost');

    expect(
      () =>
        new Vault({
          name: 'BadExporter',
          providers: [],
          exports: [GhostT],
        })
    ).toThrow(InvalidModuleConfigError);
  });

  it('re-exporting a token does not duplicate its provider', () => {
    const ServiceT = token<{ id: symbol }>('ReExportSingleton');

    const producer = new Vault({
      name: 'ReExportProducer',
      providers: [{ provide: ServiceT, useFactory: () => ({ id: Symbol('singleton') }) }],
      exports: [ServiceT],
    });
    const middle = new Vault({
      name: 'ReExportMiddle',
      imports: [producer],
      exports: [ServiceT],
    });
    const consumer = new Vault({
      name: 'ReExportConsumer',
      imports: [middle],
    });

    const a = consumer.resolve(ServiceT);
    const b = consumer.resolve(ServiceT);

    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// 3. Undefined provider values
// ---------------------------------------------------------------------------

describe('Undefined provider values', () => {
  it('treats undefined as a resolved value in local and imported dependency graphs', async () => {
    const UndefinedT = token<undefined>('UndefinedValue');
    const LocalConsumerT = token<undefined>('UndefinedLocalConsumer');
    const ImportedConsumerT = token<undefined>('UndefinedImportedConsumer');

    const producer = new Vault({
      providers: [{ provide: UndefinedT, useValue: undefined }],
      exports: [UndefinedT],
    });
    const consumer = new Vault({
      imports: [producer],
      providers: [
        {
          provide: ImportedConsumerT,
          useFactory: (value: unknown) => value as undefined,
          deps: [UndefinedT],
        },
      ],
    });
    const local = new Vault({
      providers: [
        { provide: UndefinedT, useValue: undefined },
        {
          provide: LocalConsumerT,
          useFactory: (value: unknown) => value as undefined,
          deps: [UndefinedT],
        },
      ],
    });

    await expect(local.resolveAsync(LocalConsumerT)).resolves.toBeUndefined();
    await expect(consumer.resolveAsync(UndefinedT)).resolves.toBeUndefined();
    await expect(consumer.resolveAsync(ImportedConsumerT)).resolves.toBeUndefined();
    expect(local.resolve(LocalConsumerT)).toBeUndefined();
    expect(consumer.resolve(UndefinedT)).toBeUndefined();
    expect(consumer.resolve(ImportedConsumerT)).toBeUndefined();
    expect(local.getSingletons().has(UndefinedT.id)).toBe(true);
  });

  it('recreates undefined-returning factories after clear while retaining value providers', () => {
    const FactoryT = token<undefined>('UndefinedFactory');
    const ValueT = token<undefined>('UndefinedValueAfterClear');
    let calls = 0;
    const vault = new Vault({
      providers: [
        { provide: ValueT, useValue: undefined },
        {
          provide: FactoryT,
          useFactory: () => {
            calls++;
            return undefined;
          },
        },
      ],
    });

    expect(vault.resolve(FactoryT)).toBeUndefined();
    vault.clear();
    expect(vault.resolve(ValueT)).toBeUndefined();
    expect(vault.resolve(FactoryT)).toBeUndefined();
    expect(calls).toBe(2);
  });

  it('allows an undefined scope override to satisfy a nested dependency', () => {
    const ValueT = token<string | undefined>('UndefinedScopeValue');
    const ConsumerT = token<string | undefined>('UndefinedScopeConsumer');
    const vault = new Vault({
      providers: [
        { provide: ValueT, useValue: 'module' },
        {
          provide: ConsumerT,
          lifecycle: Lifecycle.Transient,
          useFactory: (value: unknown) => value as string | undefined,
          deps: [ValueT],
        },
      ],
    });
    const scope = vault.createScope();
    scope.provide(ValueT, undefined);

    expect(scope.resolve(ConsumerT)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Disposal precedence: dispose() wins over close()
// ---------------------------------------------------------------------------

describe('Disposal method precedence', () => {
  it('calls dispose() and not close() when an instance has both', async () => {
    const BothT = token<{ dispose: () => void; close: () => void }>('DisposeBothMethods');
    const disposeCalls: string[] = [];

    const vault = new Vault({
      providers: [
        {
          provide: BothT,
          useFactory: () => ({
            dispose: () => disposeCalls.push('dispose'),
            close: () => disposeCalls.push('close'),
          }),
        },
      ],
    });

    vault.resolve(BothT);
    await vault.dispose();

    expect(disposeCalls).toEqual(['dispose']);
  });

  it('calls close() as fallback when only close() is available', async () => {
    const CloseOnlyT = token<{ close: () => void }>('DisposeCloseOnly');
    const closeCalled: boolean[] = [];

    const vault = new Vault({
      providers: [
        {
          provide: CloseOnlyT,
          useFactory: () => ({ close: () => closeCalled.push(true) }),
        },
      ],
    });

    vault.resolve(CloseOnlyT);
    await vault.dispose();

    expect(closeCalled).toEqual([true]);
  });

  it('calls dispose() and not close() on scoped instances with both methods', async () => {
    const ScopedBothT = token<{ dispose: () => void; close: () => void }>(
      'ScopedDisposeBothMethods'
    );
    const scopedCalls: string[] = [];

    const vault = new Vault({
      providers: [
        {
          provide: ScopedBothT,
          lifecycle: Lifecycle.Scoped,
          useFactory: () => ({
            dispose: () => scopedCalls.push('dispose'),
            close: () => scopedCalls.push('close'),
          }),
        },
      ],
    });

    const scope = vault.createScope();
    scope.resolve(ScopedBothT);
    await scope.dispose();

    expect(scopedCalls).toEqual(['dispose']);
  });
});

// ---------------------------------------------------------------------------
// 4. Circular dependency errors include the full chain
// ---------------------------------------------------------------------------

describe('Circular dependency chain diagnostics', () => {
  it('cleans the resolution path after a synchronous factory failure', () => {
    const Failing = token('PathCleanupFailing');
    const Root = token('PathCleanupRoot');
    const vault = new Vault({
      providers: [
        {
          provide: Failing,
          lifecycle: Lifecycle.Transient,
          useFactory: () => {
            throw new Error('fail');
          },
        },
        {
          provide: Root,
          lifecycle: Lifecycle.Transient,
          deps: [Failing],
          useFactory: () => 'never',
        },
      ],
    });

    expect(() => vault.resolve(Root)).toThrow('Factory execution failed');
    expect(() => vault.resolve(Root)).toThrow('Factory execution failed');
  });

  it('factory cycle error contains every token in the cycle', () => {
    const AT = token<unknown>('CycleChainA');
    const BT = token<unknown>('CycleChainB');
    const CT = token<unknown>('CycleChainC');

    const vault = new Vault({
      providers: [
        { provide: AT, useFactory: (_b: unknown) => 'a', deps: [BT] },
        { provide: BT, useFactory: (_c: unknown) => 'b', deps: [CT] },
        { provide: CT, useFactory: (_a: unknown) => 'c', deps: [AT] },
      ],
    });

    let err: CircularDependencyError | undefined;
    try {
      vault.resolve(AT);
    } catch (e) {
      if (e instanceof CircularDependencyError) err = e;
    }

    expect(err).toBeInstanceOf(CircularDependencyError);
    expect(err!.cycle).toEqual([
      `CycleChainA [${AT.id}]`,
      `CycleChainB [${BT.id}]`,
      `CycleChainC [${CT.id}]`,
      `CycleChainA [${AT.id}]`,
    ]);
  });

  it('async factory cycle retains the exact ordered trace', async () => {
    const AT = token<unknown>('AsyncCycleChainA');
    const BT = token<unknown>('AsyncCycleChainB');
    const CT = token<unknown>('AsyncCycleChainC');
    const vault = new Vault({
      providers: [
        { provide: AT, useFactory: async (_b: unknown) => 'a', deps: [BT] },
        { provide: BT, useFactory: async (_c: unknown) => 'b', deps: [CT] },
        { provide: CT, useFactory: async (_a: unknown) => 'c', deps: [AT] },
      ],
    });

    let error: unknown;
    try {
      await vault.resolveAsync(AT);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(CircularDependencyError);
    expect((error as CircularDependencyError).cycle).toEqual([
      `AsyncCycleChainA [${AT.id}]`,
      `AsyncCycleChainB [${BT.id}]`,
      `AsyncCycleChainC [${CT.id}]`,
      `AsyncCycleChainA [${AT.id}]`,
    ]);
  });

  it('class provider cycle error contains every class name in the cycle', () => {
    const AT = token<unknown>('ClassCycleA');
    const BT = token<unknown>('ClassCycleB');

    @Injectable({ provide: AT })
    class ClassCycleA {
      constructor(@Inject(BT) readonly b: unknown) {}
    }

    @Injectable({ provide: BT })
    class ClassCycleB {
      constructor(@Inject(AT) readonly a: unknown) {}
    }

    const vault = new Vault({ providers: [ClassCycleA, ClassCycleB] });

    let err: CircularDependencyError | undefined;
    try {
      vault.resolve(AT);
    } catch (e) {
      if (e instanceof CircularDependencyError) err = e;
    }

    expect(err).toBeInstanceOf(CircularDependencyError);
    expect(err!.cycle).toEqual([
      `ClassCycleA [${AT.id}]`,
      `ClassCycleB [${BT.id}]`,
      `ClassCycleA [${AT.id}]`,
    ]);
  });

  it('cross-module cycle error is reported with the full cross-vault chain', () => {
    const AT = token<unknown>('CrossModuleCycleA');
    const BT = token<unknown>('CrossModuleCycleB');

    const vaultA = new Vault({
      name: 'VaultA',
      providers: [{ provide: AT, useFactory: (_b: unknown) => 'a', deps: [BT] }],
      exports: [AT],
    });

    const vaultB = new Vault({
      name: 'VaultB',
      providers: [{ provide: BT, useFactory: (_a: unknown) => 'b', deps: [AT] }],
      exports: [BT],
      imports: [vaultA],
    });

    const root = new Vault({
      imports: [vaultB],
      shadowPolicy: 'allow',
    });

    let error: unknown;
    try {
      root.resolve(BT);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(CircularDependencyError);
    expect((error as CircularDependencyError).cycle).toEqual([
      BT.id,
      `CrossModuleCycleA [${AT.id}]`,
      BT.id,
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5. has() vs canResolve() — additional precision cases
// ---------------------------------------------------------------------------

describe('has() vs canResolve() precision', () => {
  it('has() returns true for a singleton that is already materialized', () => {
    const MaterializedT = token<string>('HasMaterialized');
    const vault = new Vault({
      providers: [{ provide: MaterializedT, useValue: 'ready' }],
    });
    vault.resolve(MaterializedT);

    expect(vault.has(MaterializedT)).toBe(true);
  });

  it('canResolve() returns false for a singleton with broken downstream dep', () => {
    const MissingT = token<unknown>('CanResolveMissingDownstream');
    const MiddleT = token<unknown>('CanResolveMiddle');

    @Injectable({ provide: MiddleT })
    class Middle {
      constructor(@Inject(MissingT) readonly dep: unknown) {}
    }

    const vault = new Vault({ providers: [Middle] });

    expect(vault.has(MiddleT)).toBe(true);
    expect(vault.canResolve(MiddleT)).toBe(false);
  });

  it('has() returns true but canResolve() returns false for a lifecycle-violating provider', () => {
    const TransientT = token<unknown>('CanResolveTransientDep');
    const SingletonT = token<unknown>('CanResolveSingletonConsumer');

    @Injectable({ provide: TransientT, lifecycle: Lifecycle.Transient })
    class TransientDep {}

    @Injectable({ provide: SingletonT })
    class SingletonConsumer {
      constructor(@Inject(TransientT) readonly dep: TransientDep) {}
    }

    const imported = new Vault({ providers: [TransientDep], exports: [TransientT] });
    const root = new Vault({ providers: [SingletonConsumer], imports: [imported] });

    expect(root.has(SingletonT)).toBe(true);
    expect(root.canResolve(SingletonT)).toBe(false);
  });

  it('canResolve() returns true only after all deps are present', () => {
    const DepT = token<string>('CanResolveLateDepA');
    const ConsumerT = token<unknown>('CanResolveLateDepB');

    @Injectable({ provide: ConsumerT })
    class Consumer {
      constructor(@Inject(DepT) readonly dep: string) {}
    }

    const noDepVault = new Vault({ providers: [Consumer] });
    const withDepVault = new Vault({
      providers: [Consumer, { provide: DepT, useValue: 'present' }],
    });

    expect(noDepVault.canResolve(ConsumerT)).toBe(false);
    expect(withDepVault.canResolve(ConsumerT)).toBe(true);
  });

  it('canResolve() returns false for a scoped provider when no scope is given', () => {
    const ScopedT = token<unknown>('CanResolveScopedNoScope');

    @Injectable({ provide: ScopedT, lifecycle: Lifecycle.Scoped })
    class ScopedService {}

    const vault = new Vault({ providers: [ScopedService] });

    expect(vault.has(ScopedT)).toBe(true);
    expect(vault.canResolve(ScopedT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Singleton cannot capture scope-local via transitive deps
// ---------------------------------------------------------------------------

describe('Singleton transitive scope-local capture', () => {
  it('singleton cannot resolve transitively through a scoped provider that depends on a scope-local value', () => {
    const ScopeValueT = token<string>('TransitiveScopeValue');
    const ScopedServiceT = token<{ value: string }>('TransitiveScopedService');
    const SingletonT = token<{ service: { value: string } }>('TransitiveSingleton');

    // A singleton depending on a scoped provider is a lifecycle violation.
    // The error should be thrown — at bootstrap or at resolve time — before any
    // singleton instance is cached. If registration-time checking catches it,
    // the vault construction itself should throw. If it is deferred to
    // resolution time, scope.resolve() must throw. Either is acceptable as long
    // as a LifecycleViolationError is raised.
    const buildVault = () =>
      new Vault({
        providers: [
          {
            provide: ScopedServiceT,
            lifecycle: Lifecycle.Scoped,
            deps: [ScopeValueT],
            useFactory: (val: unknown) => ({ value: val as string }),
          },
          {
            provide: SingletonT,
            lifecycle: Lifecycle.Singleton,
            deps: [ScopedServiceT],
            useFactory: (service: unknown) => ({ service: service as { value: string } }),
          },
        ],
      });

    let vault: Vault;
    try {
      vault = buildVault();
    } catch (e) {
      expect(e).toBeInstanceOf(LifecycleViolationError);
      return;
    }

    const scope = vault.createScope();
    scope.provide(ScopeValueT, 'request-id');

    expect(() => scope.resolve(SingletonT)).toThrow(LifecycleViolationError);
  });
});

// ---------------------------------------------------------------------------
// 7. canResolve() returns false (not throws) for cross-vault cycles
// ---------------------------------------------------------------------------

describe('canResolve() cross-vault cycle detection', () => {
  it('returns false instead of throwing when a cross-vault cycle is detected', () => {
    const AT = token<unknown>('CanResolveCrossVaultCycleA');
    const BT = token<unknown>('CanResolveCrossVaultCycleB');

    const vaultA = new Vault({
      name: 'CanResolveCycleVaultA',
      providers: [{ provide: AT, useFactory: (_b: unknown) => 'a', deps: [BT] }],
      exports: [AT],
    });

    const vaultB = new Vault({
      name: 'CanResolveCycleVaultB',
      providers: [{ provide: BT, useFactory: (_a: unknown) => 'b', deps: [AT] }],
      exports: [BT],
      imports: [vaultA],
    });

    const root = new Vault({
      imports: [vaultB],
      shadowPolicy: 'allow',
    });

    // canResolve() must return false — not throw — for a cyclic cross-vault graph.
    expect(root.has(BT)).toBe(true);
    expect(() => root.canResolve(BT)).not.toThrow();
    expect(root.canResolve(BT)).toBe(false);

    const internal = root as unknown as {
      _validateResolvableGraph(
        canonical: typeof BT.id,
        path: ResolutionPath,
        isRoot: boolean
      ): void;
    };
    let diagnostic: unknown;
    try {
      internal._validateResolvableGraph(BT.id, new ResolutionPath(), true);
    } catch (caught) {
      diagnostic = caught;
    }
    expect(diagnostic).toBeInstanceOf(CircularDependencyError);
    expect((diagnostic as CircularDependencyError).cycle).toEqual([
      BT.id,
      `CanResolveCrossVaultCycleA [${AT.id}]`,
      BT.id,
    ]);
  });
});

// ---------------------------------------------------------------------------
// 8. vault.dispose() while an async singleton is in-flight
// ---------------------------------------------------------------------------

describe('Vault dispose with in-flight async singleton', () => {
  it('rejects and disposes an owned singleton that fulfills after disposal', async () => {
    const ResourceT = token<{ dispose: () => void }>('LateOwnedSingleton');
    const creation = deferred<{ dispose: () => void }>();
    const dispose = vi.fn();
    const factory = vi.fn(() => creation.promise);
    const vault = new Vault({ providers: [{ provide: ResourceT, useFactory: factory }] });
    const entry = vault.store.getByCanonical(ResourceT.id)! as PromiseEntry;
    const pending = vault.resolveAsync(ResourceT);

    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    const observed = pending.catch((error: unknown) => error);
    expect(vault.dispose()).toBeUndefined();
    creation.resolve({ dispose });

    expect(await observed).toBeInstanceOf(ContainerDisposedError);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(entry.instance).toBeUndefined();
    expect(entry.promise).toBeUndefined();
    expect(entry.flags & FLAG_HAS_INSTANCE).toBe(0);
    expect(entry.resolvedPromise).toBeUndefined();
    expect(vault.cache.get(ResourceT.id)).toBeUndefined();
    const state = vault as unknown as { disposalOrder: string[] };
    expect(state.disposalOrder).not.toContain(ResourceT.id);
    expect(entry.flags & FLAG_DISPOSAL_TRACKED).toBe(0);
  });

  it('awaits one late async disposer and shares the rejection reason', async () => {
    const ResourceT = token<{ dispose: () => Promise<void> }>('LateAsyncDisposer');
    const creation = deferred<{ dispose: () => Promise<void> }>();
    const cleanup = deferred<void>();
    const dispose = vi.fn(() => cleanup.promise);
    const vault = new Vault({
      providers: [{ provide: ResourceT, useFactory: () => creation.promise }],
    });
    const first = vault.resolveAsync(ResourceT);
    const second = vault.resolveAsync(ResourceT);
    const firstResult = first.catch((error: unknown) => error);
    const secondResult = second.catch((error: unknown) => error);

    await Promise.resolve();
    vault.dispose();
    creation.resolve({ dispose });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));

    let settled = false;
    firstResult.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    cleanup.resolve();
    const [firstError, secondError] = await Promise.all([firstResult, secondResult]);
    expect(firstError).toBeInstanceOf(ContainerDisposedError);
    expect(secondError).toBe(firstError);
  });

  it('does not clean up a non-owned stale singleton', async () => {
    const ResourceT = token<{ dispose: () => void }>('LateUnownedSingleton');
    const creation = deferred<{ dispose: () => void }>();
    const dispose = vi.fn();
    const vault = new Vault({
      providers: [{ provide: ResourceT, useFactory: () => creation.promise, owned: false }],
    });
    const pending = vault.resolveAsync(ResourceT);
    const observed = pending.catch((error: unknown) => error);
    await Promise.resolve();
    vault.dispose();
    creation.resolve({ dispose });

    expect(await observed).toBeInstanceOf(ContainerDisposedError);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('prefers dispose over close and accepts an owned value without a disposer', async () => {
    const BothT = token<{ dispose(): void; close(): void }>('LateDisposePreference');
    const bothCreation = deferred<{ dispose(): void; close(): void }>();
    const dispose = vi.fn();
    const close = vi.fn();
    const bothVault = new Vault({
      providers: [{ provide: BothT, useFactory: () => bothCreation.promise }],
    });
    const bothResult = bothVault.resolveAsync(BothT).catch((error: unknown) => error);
    await Promise.resolve();
    bothVault.dispose();
    bothCreation.resolve({ dispose, close });

    expect(await bothResult).toBeInstanceOf(ContainerDisposedError);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();

    const PlainT = token<object>('LateWithoutDisposer');
    const plainCreation = deferred<object>();
    const plainVault = new Vault({
      providers: [{ provide: PlainT, useFactory: () => plainCreation.promise }],
    });
    const plainResult = plainVault.resolveAsync(PlainT).catch((error: unknown) => error);
    await Promise.resolve();
    plainVault.dispose();
    plainCreation.resolve({});
    expect(await plainResult).toBeInstanceOf(ContainerDisposedError);
  });

  it('reports late cleanup failure through the shared creation', async () => {
    const ResourceT = token<{ dispose: () => Promise<void> }>('LateCleanupFailure');
    const creation = deferred<{ dispose: () => Promise<void> }>();
    const vault = new Vault({
      providers: [{ provide: ResourceT, useFactory: () => creation.promise }],
    });
    const entry = vault.store.getByCanonical(ResourceT.id)! as PromiseEntry;
    const first = vault.resolveAsync(ResourceT).catch((error: unknown) => error);
    const second = vault.resolveAsync(ResourceT).catch((error: unknown) => error);
    await Promise.resolve();
    vault.dispose();
    creation.resolve({ dispose: () => Promise.reject('cleanup failed') });

    const [firstError, secondError] = await Promise.all([first, second]);
    expect(firstError).toBeInstanceOf(AggregateDisposalError);
    expect(secondError).toBe(firstError);
    expect((firstError as AggregateDisposalError).errors).toHaveLength(1);
    expect((firstError as AggregateDisposalError).errors[0].message).toBe('cleanup failed');
    expect(entry.resolvedPromise).toBeUndefined();
  });

  it('preserves a factory rejection after disposal', async () => {
    const ResourceT = token('LateFactoryFailure');
    const creation = deferred<unknown>();
    const original = new Error('factory failed');
    const vault = new Vault({
      providers: [{ provide: ResourceT, useFactory: () => creation.promise }],
    });
    const entry = vault.store.getByCanonical(ResourceT.id)! as PromiseEntry;
    const first = vault.resolveAsync(ResourceT).catch((error: unknown) => error);
    const second = vault.resolveAsync(ResourceT).catch((error: unknown) => error);
    await Promise.resolve();
    vault.dispose();
    creation.reject(original);

    const [firstError, secondError] = await Promise.all([first, second]);
    expect(firstError).toBeInstanceOf(FactoryExecutionError);
    expect(secondError).toBe(firstError);
    expect((firstError as FactoryExecutionError).cause).toBe(original);
    expect((firstError as FactoryExecutionError).token).toBe(ResourceT.id);
    expect(entry.resolvedPromise).toBeUndefined();
  });

  it('keeps an aborted waiter detached during late cleanup', async () => {
    const ResourceT = token<{ dispose: () => void }>('LateAbort');
    const creation = deferred<{ dispose: () => void }>();
    const dispose = vi.fn();
    const controller = new AbortController();
    const vault = new Vault({
      providers: [{ provide: ResourceT, useFactory: () => creation.promise }],
    });
    const active = vault.resolveAsync(ResourceT).catch((error: unknown) => error);
    const aborted = vault
      .resolveAsync(ResourceT, { signal: controller.signal })
      .catch((error: unknown) => error);

    await Promise.resolve();
    controller.abort();
    vault.dispose();
    creation.resolve({ dispose });

    expect(await aborted).toBeInstanceOf(DOMException);
    expect(await active).toBeInstanceOf(ContainerDisposedError);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 9. scope.provide() with both dispose() and close() — dispose() wins
// ---------------------------------------------------------------------------

describe('Scope owned value disposal precedence', () => {
  it('calls dispose() and not close() on an owned scope value that has both', async () => {
    const BothT = token<{ dispose: () => void; close: () => void }>('ScopeOwnedBothMethods');
    const calls: string[] = [];
    const value = {
      dispose: () => calls.push('dispose'),
      close: () => calls.push('close'),
    };

    const vault = new Vault();
    const scope = vault.createScope();
    scope.provide(BothT, value, { owned: true });
    await scope.dispose();

    expect(calls).toEqual(['dispose']);
  });

  it('calls close() as fallback on an owned scope value with only close()', async () => {
    const CloseOnlyT = token<{ close: () => void }>('ScopeOwnedCloseOnly');
    const calls: string[] = [];

    const vault = new Vault();
    const scope = vault.createScope();
    scope.provide(CloseOnlyT, { close: () => calls.push('close') }, { owned: true });
    await scope.dispose();

    expect(calls).toEqual(['close']);
  });
});

// ---------------------------------------------------------------------------
// 10. Import order: last import wins with shadowPolicy: 'allow'
//
// The exposure index uses DFS with a LIFO stack and first-wins map insertion.
// Imports are pushed forward so later imports land on top and are visited first,
// making the LAST module in the imports array win for a given token.
// ---------------------------------------------------------------------------

describe('Import order last-wins with shadowPolicy allow', () => {
  it('resolves to the last imported module when two modules export the same token', () => {
    const SharedT = token<string>('ImportOrderShared');

    const first = new Vault({
      name: 'ImportOrderFirst',
      providers: [{ provide: SharedT, useValue: 'from-first' }],
      exports: [SharedT],
    });
    const second = new Vault({
      name: 'ImportOrderSecond',
      providers: [{ provide: SharedT, useValue: 'from-second' }],
      exports: [SharedT],
    });

    const root = new Vault({
      name: 'ImportOrderRoot',
      imports: [first, second],
      shadowPolicy: 'allow',
    });

    // Last import (second) wins because it is visited first in DFS stack traversal
    expect(root.resolve(SharedT)).toBe('from-second');
  });

  it('reversing import order changes which value wins', () => {
    const SharedT = token<string>('ImportOrderReversed');

    const first = new Vault({
      name: 'ImportOrderReversedFirst',
      providers: [{ provide: SharedT, useValue: 'from-first' }],
      exports: [SharedT],
    });
    const second = new Vault({
      name: 'ImportOrderReversedSecond',
      providers: [{ provide: SharedT, useValue: 'from-second' }],
      exports: [SharedT],
    });

    const normalOrder = new Vault({
      imports: [first, second],
      shadowPolicy: 'allow',
    });
    const reversedOrder = new Vault({
      imports: [second, first],
      shadowPolicy: 'allow',
    });

    // Last import wins in each case
    expect(normalOrder.resolve(SharedT)).toBe('from-second');
    expect(reversedOrder.resolve(SharedT)).toBe('from-first');
  });
});
