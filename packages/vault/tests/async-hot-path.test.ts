import { expect, it, vi } from 'vitest';

import type { Entry } from '../src/core/entry-store.js';
import { token, type CanonicalId } from '../src/core/token.js';

type PromiseEntry = Entry & { resolvedPromise?: Promise<unknown> };

const pathState = vi.hoisted(() => ({ constructions: 0 }));

vi.mock('../src/core/resolution-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/resolution-path.js')>();
  return {
    ...actual,
    ResolutionPath: class extends actual.ResolutionPath {
      constructor(tokens: readonly CanonicalId[] = []) {
        super(tokens);
        pathState.constructions++;
      }
    },
  };
});

it('reuses one fulfilled promise without allocating a ResolutionPath', async () => {
  const { Vault } = await import('../src/core/vault.js');
  const Value = token('AsyncHotCached');
  const vault = new Vault({ providers: [{ provide: Value, useValue: undefined }] });
  const entry = vault.store.getByCanonical(Value.id)! as PromiseEntry;

  await vault.resolveAsync(Value);
  const fulfilled = entry.resolvedPromise;
  pathState.constructions = 0;

  const second = vault._resolveProviderAsync(Value.id);
  const third = vault._resolveProviderAsync(Value.id);
  const controller = new AbortController();
  controller.abort();
  const abortedSignalHit = vault._resolveProviderAsync(Value.id, undefined, controller.signal);

  expect(fulfilled).toBeInstanceOf(Promise);
  expect(second).toBe(fulfilled);
  expect(third).toBe(fulfilled);
  expect(abortedSignalHit).toBe(fulfilled);
  await expect(second).resolves.toBeUndefined();
  expect(pathState.constructions).toBe(0);
});

it('clears fulfilled promise state on clear and dispose', async () => {
  const { Vault } = await import('../src/core/vault.js');
  const Value = token('ClearedFulfilledValue');
  const Factory = token('DisposedFulfilledFactory');
  const vault = new Vault({
    providers: [
      { provide: Value, useValue: undefined },
      { provide: Factory, useFactory: async () => 'factory' },
    ],
  });
  const valueEntry = vault.store.getByCanonical(Value.id)! as PromiseEntry;
  const factoryEntry = vault.store.getByCanonical(Factory.id)! as PromiseEntry;

  await vault.resolveAsync(Value);
  const beforeClear = valueEntry.resolvedPromise;
  expect(beforeClear).toBeInstanceOf(Promise);
  vault.clear();
  expect(valueEntry.resolvedPromise).toBeUndefined();
  const afterClear = vault._resolveProviderAsync(Value.id);
  await afterClear;
  expect(valueEntry.resolvedPromise).toBeInstanceOf(Promise);
  expect(valueEntry.resolvedPromise).not.toBe(beforeClear);

  await vault._resolveProviderAsync(Factory.id);
  expect(factoryEntry.resolvedPromise).toBeInstanceOf(Promise);
  await vault.dispose();
  expect(valueEntry.resolvedPromise).toBeUndefined();
  expect(factoryEntry.resolvedPromise).toBeUndefined();
});

it('returns a rejected promise instead of throwing synchronously for an invalid token', async () => {
  const { Vault } = await import('../src/core/vault.js');
  const vault = new Vault();
  let resolution: Promise<unknown> | undefined;

  expect(() => {
    resolution = vault.resolveAsync(null as never);
  }).not.toThrow();

  await expect(resolution).rejects.toThrow('Invalid token');
});
