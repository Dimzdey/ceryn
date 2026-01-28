import { describe, expect, it, vi } from 'vitest';

import { Scope } from '../src/core/scope.js';
import { ScopeDisposedError } from '../src/errors/errors.js';

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
});
