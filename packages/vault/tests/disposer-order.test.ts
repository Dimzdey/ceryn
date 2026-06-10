import { describe, expect, it } from 'vitest';
import { Scope } from '../src/core/scope.js';

describe('Scope disposer order', () => {
  it('runs disposers in LIFO order (async)', async () => {
    const order: number[] = [];
    const scope = new Scope();

    scope.registerDisposer(() => {
      order.push(1);
    });
    scope.registerDisposer(() => {
      order.push(2);
    });
    scope.registerDisposer(() => {
      order.push(3);
    });

    await scope.dispose();

    expect(order).toEqual([3, 2, 1]);
  });

  it('runs sync disposers in LIFO order', () => {
    const order: number[] = [];
    const scope = new Scope();

    scope.registerDisposer(() => {
      order.push(1);
    });
    scope.registerDisposer(() => {
      order.push(2);
    });
    scope.registerDisposer(() => {
      order.push(3);
    });

    scope.disposeSync();

    expect(order).toEqual([3, 2, 1]);
  });
});
