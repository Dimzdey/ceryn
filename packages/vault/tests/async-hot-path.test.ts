import { expect, it, vi } from 'vitest';

import { token, type CanonicalId } from '../src/core/token.js';

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

it('does not allocate a ResolutionPath for a cached async singleton', async () => {
  const { Vault } = await import('../src/core/vault.js');
  const Value = token('AsyncHotCached');
  const vault = new Vault({ providers: [{ provide: Value, useValue: undefined }] });
  await vault.resolveAsync(Value);
  pathState.constructions = 0;

  await expect(vault.resolveAsync(Value)).resolves.toBeUndefined();
  expect(pathState.constructions).toBe(0);
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
