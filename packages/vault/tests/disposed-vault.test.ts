import { beforeEach, describe, expect, it } from 'vitest';
import { token } from '../src/core/token.js';
import { Vault } from '../src/core/vault.js';
import { MetadataRegistry } from '../src/registry/metadata-registry.js';
import { ContainerDisposedError } from '../src/errors/errors.js';

beforeEach(() => {
  MetadataRegistry.resetForTests();
});

describe('Disposed vault', () => {
  it('throws ContainerDisposedError on resolve() after dispose()', () => {
    const TokenA = token('A');
    const vault = new Vault({ providers: [{ provide: TokenA, useValue: 'val' }] });

    vault.resolve(TokenA); // works before dispose
    vault.dispose();

    expect(() => vault.resolve(TokenA)).toThrow(ContainerDisposedError);
  });

  it('throws ContainerDisposedError on resolveAsync() after dispose()', async () => {
    const TokenA = token('A');
    const vault = new Vault({ providers: [{ provide: TokenA, useValue: 'val' }] });

    vault.dispose();

    await expect(vault.resolveAsync(TokenA)).rejects.toThrow(ContainerDisposedError);
  });
});
