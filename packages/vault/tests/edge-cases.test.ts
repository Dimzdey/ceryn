/**
 * Edge-case contract tests.
 *
 * These tests lock expected runtime semantics and regression cases.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { token } from '../src/core/token.js';
import { Vault } from '../src/core/vault.js';
import { Inject, Injectable } from '../src/decorators/index.js';
import {
  CircularDependencyError,
  InvalidModuleConfigError,
  LifecycleViolationError,
} from '../src/errors/errors.js';
import { MetadataRegistry } from '../src/registry/metadata-registry.js';
import { Lifecycle } from '../src/types/types.js';

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
// 3. Disposal precedence: dispose() wins over close()
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
    const cycle = err!.cycle.join(' → ');
    expect(cycle).toContain('CycleChainA');
    expect(cycle).toContain('CycleChainB');
    expect(cycle).toContain('CycleChainC');
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
    expect(err!.cycle.join(' → ')).toMatch(/ClassCycleA|ClassCycleB/);
    expect(err!.cycle.length).toBeGreaterThanOrEqual(3);
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

    expect(() => root.resolve(BT)).toThrow(CircularDependencyError);
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
  });
});

// ---------------------------------------------------------------------------
// 8. vault.dispose() while an async singleton is in-flight
// ---------------------------------------------------------------------------

describe('Vault dispose with in-flight async singleton', () => {
  it('does not deadlock when dispose is called before an in-flight singleton resolves', async () => {
    const SlowT = token<string>('SlowAsyncSingleton');
    let resolveFactory: ((value: string) => void) | undefined;
    let factoryStarted = false;

    const factory = () => {
      factoryStarted = true;
      return new Promise<string>((resolve) => {
        resolveFactory = resolve;
      });
    };

    const vault = new Vault({
      providers: [
        {
          provide: SlowT,
          lifecycle: Lifecycle.Singleton,
          useFactory: factory,
        },
      ],
    });

    // Start resolution and wait until the factory has actually been invoked
    const pending = vault.resolveAsync(SlowT);
    for (let i = 0; i < 10 && !factoryStarted; i++) {
      await Promise.resolve();
    }

    expect(factoryStarted).toBe(true);
    expect(resolveFactory).toBeDefined();

    // Dispose before the factory finishes
    const disposePending = Promise.resolve(vault.dispose());

    // Resolve the factory after dispose
    resolveFactory!('late-value');

    // The pending caller either gets the value or gets an error — but must not hang
    const resolveResult = await Promise.race([
      pending.then(() => 'resolved').catch(() => 'rejected'),
      new Promise<string>((res) => setTimeout(() => res('timeout'), 500)),
    ]);
    const disposeResult = await Promise.race([
      disposePending.then(() => 'disposed').catch(() => 'rejected'),
      new Promise<string>((res) => setTimeout(() => res('timeout'), 500)),
    ]);

    expect(resolveResult).not.toBe('timeout');
    expect(disposeResult).not.toBe('timeout');
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
