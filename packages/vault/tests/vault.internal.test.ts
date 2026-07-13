import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Entry } from '../src/core/entry-store.js';
import { ResolutionPath } from '../src/core/resolution-path.js';
import { token, type CanonicalId } from '../src/core/token.js';
import { Vault } from '../src/core/vault.js';
import { Injectable, Module as ModuleDecorator } from '../src/decorators/index.js';
import { LifecycleViolationError, ScopedWithoutScopeError } from '../src/errors/errors.js';
import { MetadataRegistry } from '../src/registry/metadata-registry.js';
import { Lifecycle, type DecoratedModuleClass } from '../src/types/types.js';

beforeEach(() => {
  MetadataRegistry.resetForTests();
});

describe('Vault internal coverage', () => {
  it('exposes decorated constructor via getVaultClass()', () => {
    @ModuleDecorator()
    class DecoratedVault {}

    const vault = new Vault(DecoratedVault as DecoratedModuleClass);
    expect(vault.getVaultClass()).toBe(DecoratedVault);
  });

  it('registers class providers and resolves via scope helpers', async () => {
    const ClassToken = token('ClassToken');
    const AsyncToken = token('AsyncToken');

    @Injectable({ provide: ClassToken })
    class ClassInjectable {}

    const vault = new Vault({
      providers: [
        { provide: ClassToken, useClass: ClassInjectable },
        { provide: AsyncToken, useFactory: async () => 'async-value' },
      ],
    });

    const scope = vault.createScope();
    expect(scope.resolve(ClassToken)).toBeInstanceOf(ClassInjectable);
    await expect(scope.resolveAsync(AsyncToken)).resolves.toBe('async-value');
  });

  it('resolves async providers from fused vaults', async () => {
    const SharedToken = token('SharedAsync');

    const fused = new Vault({
      providers: [{ provide: SharedToken, useFactory: async () => 'shared' }],
      exports: [SharedToken],
    });

    const host = new Vault({
      providers: [],
      imports: [fused],
    });

    await expect(host.resolveAsync(SharedToken)).resolves.toBe('shared');
  });

  it('validates lifecycle relationships through private helper', () => {
    const ScopedToken = token('ScopedService');
    const SingletonToken = token('SingletonConsumer');

    const vault = new Vault();
    const store = vault.store as unknown as { add(entry: Entry, owner: string): void };

    const singletonEntry: Entry = {
      token: SingletonToken.id,
      ctor: class Singleton {},
      factoryDeps: [],
      metadata: { name: SingletonToken.id, label: 'Singleton', lifecycle: Lifecycle.Singleton },
      summons: [],
      aliases: [SingletonToken.id],
      flags: 0,
    };

    const scopedEntry: Entry = {
      token: ScopedToken.id,
      ctor: class Scoped {},
      factoryDeps: [],
      metadata: { name: ScopedToken.id, label: 'Scoped', lifecycle: Lifecycle.Scoped },
      summons: [],
      aliases: [ScopedToken.id],
      flags: 0,
    };

    store.add(singletonEntry, 'TestVault');
    store.add(scopedEntry, 'TestVault');

    const anyVault = vault as unknown as {
      _validateLifecycleRules(token: CanonicalId, path: ResolutionPath): void;
    };

    expect(() =>
      anyVault._validateLifecycleRules(SingletonToken.id, new ResolutionPath())
    ).not.toThrow();
    const path = new ResolutionPath();
    path.enter(SingletonToken.id);
    expect(() => anyVault._validateLifecycleRules(ScopedToken.id, path)).toThrow(
      LifecycleViolationError
    );
  });

  it('skips runtime lifecycle checks for certified unscoped local edges', () => {
    const depth = 5;
    const tokens = Array.from({ length: depth }, (_, index) =>
      token<number>(`LifecycleDepth${index}`)
    );
    const providers = tokens
      .map((provide, index) =>
        index === depth - 1
          ? { provide, lifecycle: Lifecycle.Transient, useFactory: () => 1 }
          : {
              provide,
              lifecycle: Lifecycle.Transient,
              deps: [tokens[index + 1]],
              useFactory: (value: unknown) => Number(value) + 1,
            }
      )
      .reverse();
    const vault = new Vault({ providers });
    const internal = vault as unknown as {
      _validateLifecyclePair: (...args: unknown[]) => void;
    };
    const original = internal._validateLifecyclePair;
    let checks = 0;
    internal._validateLifecyclePair = (...args) => {
      checks++;
      return original.apply(vault, args);
    };

    expect(vault.resolve(tokens[0])).toBe(depth);
    expect(checks).toBe(0);
  });

  it('skips async runtime lifecycle checks for certified unscoped local edges', async () => {
    const depth = 5;
    const tokens = Array.from({ length: depth }, (_, index) =>
      token<number>(`AsyncCertifiedLifecycleDepth${index}`)
    );
    const vault = new Vault({
      providers: tokens
        .map((provide, index) =>
          index === depth - 1
            ? { provide, useFactory: async () => 1 }
            : {
                provide,
                deps: [tokens[index + 1]],
                useFactory: async (value: unknown) => Number(value) + 1,
              }
        )
        .reverse(),
    });
    const internal = vault as unknown as {
      _validateLifecyclePair: (...args: unknown[]) => void;
    };
    const validatePair = vi.spyOn(internal, '_validateLifecyclePair');

    await expect(vault.resolveAsync(tokens[0])).resolves.toBe(depth);
    expect(validatePair).not.toHaveBeenCalled();
  });

  it('retains runtime lifecycle checks when a scope can override local edges', () => {
    const Dependency = token<number>('ScopedValidationDependency');
    const Consumer = token<number>('ScopedValidationConsumer');
    const vault = new Vault({
      providers: [
        { provide: Dependency, useFactory: () => 1 },
        {
          provide: Consumer,
          deps: [Dependency],
          useFactory: (value: unknown) => Number(value) + 1,
        },
      ],
    });
    const internal = vault as unknown as {
      _validateLifecyclePair: (...args: unknown[]) => void;
    };
    const validatePair = vi.spyOn(internal, '_validateLifecyclePair');
    const scope = vault.createScope();

    expect(scope.resolve(Consumer)).toBe(2);
    expect(validatePair).toHaveBeenCalledTimes(1);
  });

  it('cleans the resolvability path when a root scoped provider has no scope', () => {
    const ScopedToken = token('ResolvablePathCleanupScoped');
    const vault = new Vault({
      providers: [
        {
          provide: ScopedToken,
          lifecycle: Lifecycle.Scoped,
          useFactory: () => 'scoped',
        },
      ],
    });
    const internal = vault as unknown as {
      _validateResolvableGraph(canonical: CanonicalId, path: ResolutionPath, isRoot: boolean): void;
    };
    const path = new ResolutionPath();

    expect(() => internal._validateResolvableGraph(ScopedToken.id, path, true)).toThrow(
      ScopedWithoutScopeError
    );
    expect(path.tokens).toEqual([]);
  });

  it('does not scan past a foreign immediate lifecycle consumer', () => {
    const LocalConsumer = token('LocalConsumer');
    const ForeignConsumer = token('ForeignConsumer');
    const LocalDependency = token('LocalDependency');
    const vault = new Vault({
      providers: [
        {
          provide: LocalConsumer,
          lifecycle: Lifecycle.Transient,
          useFactory: () => 'consumer',
        },
        {
          provide: LocalDependency,
          lifecycle: Lifecycle.Transient,
          useFactory: () => 'dependency',
        },
      ],
    });
    const internal = vault as unknown as {
      _validateLifecycleRules(token: CanonicalId, path: ResolutionPath): void;
      _validateLifecyclePair: (...args: unknown[]) => void;
    };
    const validatePair = vi.spyOn(internal, '_validateLifecyclePair');

    const path = new ResolutionPath();
    path.enter(LocalConsumer.id);
    path.enter(ForeignConsumer.id);
    path.enter(LocalDependency.id);
    internal._validateLifecycleRules(LocalDependency.id, path);

    expect(validatePair).not.toHaveBeenCalled();
  });

  it('primes each local singleton once during sync materialization', () => {
    const Dependency = token<number>('PrimeSyncDependency');
    const Root = token<number>('PrimeSyncRoot');
    const vault = new Vault({
      providers: [
        {
          provide: Root,
          deps: [Dependency],
          useFactory: (value: unknown) => Number(value) + 1,
        },
        { provide: Dependency, useFactory: () => 1 },
      ],
    });
    const prime = vi.spyOn(vault.cache, 'primeAll');

    expect(vault.resolve(Root)).toBe(2);
    expect(prime).toHaveBeenCalledTimes(2);
  });

  it('primes each local singleton once during async materialization', async () => {
    const Dependency = token<number>('PrimeAsyncDependency');
    const Root = token<number>('PrimeAsyncRoot');
    const vault = new Vault({
      providers: [
        {
          provide: Root,
          deps: [Dependency],
          useFactory: async (value: unknown) => Number(value) + 1,
        },
        { provide: Dependency, useFactory: async () => 1 },
      ],
    });
    const prime = vi.spyOn(vault.cache, 'primeAll');

    await expect(vault.resolveAsync(Root)).resolves.toBe(2);
    expect(prime).toHaveBeenCalledTimes(2);
  });

  it('bounds synchronous Array.includes membership scans to the shallow path', () => {
    const tokens = Array.from({ length: 12 }, (_, index) => token(`SyncPath${index}`));
    const vault = new Vault({
      providers: tokens.map((provide, index) => ({
        provide,
        lifecycle: Lifecycle.Transient,
        deps: index + 1 < tokens.length ? [tokens[index + 1]] : [],
        useFactory: () => index,
      })),
    });
    const includes = vi.spyOn(Array.prototype, 'includes');

    vault.resolve(tokens[0]);

    const ids = new Set(tokens.map((entry) => entry.id));
    const cycleScans = includes.mock.calls.filter(([value]) => ids.has(value as CanonicalId));
    expect(cycleScans).toHaveLength(9);
  });
});
