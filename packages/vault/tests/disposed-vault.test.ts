import { beforeEach, describe, expect, it } from 'vitest';
import { token } from '../src/core/token.js';
import { Vault } from '../src/core/vault.js';
import { StaticRelicRegistry } from '../src/registry/static-registry.js';
import { VaultDisposedError } from '../src/errors/errors.js';

beforeEach(() => {
  StaticRelicRegistry.resetForTests();
});

describe('Disposed vault', () => {
  it('throws VaultDisposedError on resolve() after dispose()', () => {
    const TokenA = token('A');
    const vault = new Vault({ relics: [{ provide: TokenA, useValue: 'val' }] });

    vault.resolve(TokenA); // works before dispose
    vault.dispose();

    expect(() => vault.resolve(TokenA)).toThrow(VaultDisposedError);
  });

  it('throws VaultDisposedError on resolveAsync() after dispose()', async () => {
    const TokenA = token('A');
    const vault = new Vault({ relics: [{ provide: TokenA, useValue: 'val' }] });

    vault.dispose();

    await expect(vault.resolveAsync(TokenA)).rejects.toThrow(VaultDisposedError);
  });
});
