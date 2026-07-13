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

    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = vault.resolveAsync(TokenA);
    }).not.toThrow();
    await expect(pending).rejects.toThrow(ContainerDisposedError);
  });

  it('rejects new resolution while async disposal is in progress', async () => {
    const SlowT = token<Slow>('Slow');
    const OtherT = token<Other>('Other');

    class Slow {
      dispose(): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    class Other {}

    const vault = new Vault({
      name: 'DisposeRace',
      providers: [
        { provide: SlowT, useClass: Slow },
        { provide: OtherT, useClass: Other },
      ],
    });

    vault.resolve(SlowT);
    const pendingDispose = vault.dispose();

    expect(() => vault.resolve(OtherT)).toThrow(ContainerDisposedError);

    await pendingDispose;
    expect(() => vault.resolve(OtherT)).toThrow(ContainerDisposedError);
  });

  it('returns the active disposal promise to concurrent callers', async () => {
    const ResourceT = token<{ dispose: () => Promise<void> }>('ConcurrentDisposal');
    let releaseDisposal: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseDisposal = resolve;
    });
    const resource = {
      dispose: () => gate,
    };
    const vault = new Vault({
      providers: [{ provide: ResourceT, useValue: resource, owned: true }],
    });

    const first = vault.dispose();
    const second = vault.dispose();

    expect(first).toBeInstanceOf(Promise);
    expect(second).toBe(first);

    releaseDisposal?.();
    await second;
  });
});
