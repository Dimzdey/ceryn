import { describe, expect, it, vi } from 'vitest';

import { Scope } from '../src/core/scope.js';
import { token } from '../src/core/token.js';
import { Vault } from '../src/core/vault.js';
import {
  AggregateDisposalError,
  ContainerDisposedError,
  InvalidTokenError,
  ScopeDisposedError,
} from '../src/errors/errors.js';
import { Lifecycle } from '../src/types/types.js';

describe('Scope', () => {
  it('provides lazy cache and prevents reuse after disposal', () => {
    const scope = new Scope();
    const cache = scope.cache;

    expect(scope.isDisposed).toBe(false);
    expect(cache).toBe(scope.cache);

    let disposed = false;
    scope.registerDisposer(() => {
      disposed = true;
    });

    scope.disposeSync();

    expect(disposed).toBe(true);
    expect(scope.isDisposed).toBe(true);
    expect(() => scope.cache).toThrow(ScopeDisposedError);
    expect(() => scope.registerDisposer(() => undefined)).toThrow(ScopeDisposedError);
  });

  it('awaits async disposers and is idempotent', async () => {
    const scope = new Scope();
    const spy = vi.fn();

    scope.registerDisposer(() => Promise.resolve().then(spy));

    await scope.dispose();
    await scope.dispose(); // second call should be a no-op

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('runs every async disposer and aggregates failures', async () => {
    const scope = new Scope();
    const order: string[] = [];

    scope.registerDisposer(() => {
      order.push('first');
      throw new Error('first failure');
    });
    scope.registerDisposer(async () => {
      order.push('second');
      throw new Error('second failure');
    });

    await expect(scope.dispose()).rejects.toThrow(AggregateDisposalError);
    expect(order).toEqual(['second', 'first']);
    await expect(scope.dispose()).resolves.toBeUndefined();
  });

  it('runs every sync disposer and aggregates failures', () => {
    const scope = new Scope();
    const order: string[] = [];

    scope.registerDisposer(() => {
      order.push('first');
      throw new Error('first failure');
    });
    scope.registerDisposer(() => {
      order.push('second');
      throw new Error('second failure');
    });

    expect(() => scope.disposeSync()).toThrow(AggregateDisposalError);
    expect(order).toEqual(['second', 'first']);
    expect(scope.disposeSync()).toBeUndefined();
  });

  it('preserves scope disposal errors and keeps async failures asynchronous', async () => {
    const Value = token<number>('DisposedScopeFastPath');
    const vault = new Vault({
      providers: [{ provide: Value, lifecycle: Lifecycle.Scoped, useFactory: () => 1 }],
    });
    const scope = vault.createScope();
    scope.disposeSync();

    expect(() => scope.resolve(Value)).toThrow(ScopeDisposedError);
    let scopeAsync: Promise<unknown> | undefined;
    expect(() => {
      scopeAsync = scope.resolveAsync(Value);
    }).not.toThrow();
    expect(scopeAsync).toBeInstanceOf(Promise);
    const scopeRejection = await scopeAsync!.catch((error: unknown) => error);
    expect(scopeRejection).toBeInstanceOf(ScopeDisposedError);
    expect(scopeRejection).toMatchObject({
      name: 'ScopeDisposedError',
      message: new ScopeDisposedError().message,
    });
    expect(() => vault.resolve(Value, { scope })).toThrow(ScopeDisposedError);
    await expect(vault.resolveAsync(Value, { scope })).rejects.toThrow(ScopeDisposedError);
  });

  it('keeps Scope.resolveAsync validation and Vault failures asynchronous', async () => {
    const Value = token<number>('ScopeAsyncErrorTiming');
    const vault = new Vault({ providers: [{ provide: Value, useValue: 1 }] });
    const scope = vault.createScope();
    scope.provide(Value, 2);
    const invalidToken = { id: Value.id } as never;
    let invalid: Promise<unknown> | undefined;

    expect(() => {
      invalid = scope.resolveAsync(invalidToken);
    }).not.toThrow();
    expect(invalid).toBeInstanceOf(Promise);
    const invalidRejection = await invalid!.catch((error: unknown) => error);
    expect(invalidRejection).toBeInstanceOf(InvalidTokenError);
    expect(invalidRejection).toMatchObject({
      name: 'InvalidTokenError',
      message: new InvalidTokenError(invalidToken).message,
      token: invalidToken,
    });

    vault.dispose();
    let disposedVault: Promise<unknown> | undefined;
    expect(() => {
      disposedVault = scope.resolveAsync(Value);
    }).not.toThrow();
    expect(disposedVault).toBeInstanceOf(Promise);
    const vaultRejection = await disposedVault!.catch((error: unknown) => error);
    expect(vaultRejection).toBeInstanceOf(ContainerDisposedError);
    expect(vaultRejection).toMatchObject({
      name: 'ContainerDisposedError',
      message: new ContainerDisposedError('Module').message,
      vaultName: 'Module',
    });

    const detached = new Scope();
    let missingVault: Promise<unknown> | undefined;
    expect(() => {
      missingVault = detached.resolveAsync(Value);
    }).not.toThrow();
    expect(missingVault).toBeInstanceOf(Promise);
    const missingRejection = await missingVault!.catch((error: unknown) => error);
    expect(missingRejection).toBeInstanceOf(Error);
    expect(missingRejection).toMatchObject({
      name: 'Error',
      message: `Token not found: ${String(Value)}`,
    });
  });
});
