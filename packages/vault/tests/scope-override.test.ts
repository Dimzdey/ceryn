import { describe, expect, it, vi } from 'vitest';
import { Scope } from '../src/core/scope.js';
import { token } from '../src/core/token.js';

describe('Scope.override() disposer management', () => {
  it('should remove old disposer when overriding a value', async () => {
    const scope = new Scope();
    const TestT = token<{ dispose: () => void }>('Test');

    // Create first value with disposer
    const disposeSpy1 = vi.fn();
    const value1 = { dispose: disposeSpy1 };
    scope.provide(TestT, value1);

    // Override with second value
    const disposeSpy2 = vi.fn();
    const value2 = { dispose: disposeSpy2 };
    scope.override(TestT, value2);

    // Dispose scope
    await scope.dispose();

    // Only the second disposer should be called
    expect(disposeSpy1).not.toHaveBeenCalled();
    expect(disposeSpy2).toHaveBeenCalledOnce();
  });

  it('should handle multiple overrides correctly', async () => {
    const scope = new Scope();
    const TestT = token<{ close: () => void }>('Test');

    // Create and override multiple times
    const disposers = [vi.fn(), vi.fn(), vi.fn()];

    scope.provide(TestT, { close: disposers[0] });
    scope.override(TestT, { close: disposers[1] });
    scope.override(TestT, { close: disposers[2] });

    await scope.dispose();

    // Only the last disposer should be called
    expect(disposers[0]).not.toHaveBeenCalled();
    expect(disposers[1]).not.toHaveBeenCalled();
    expect(disposers[2]).toHaveBeenCalledOnce();
  });

  it('should not affect disposers for different tokens', async () => {
    const scope = new Scope();
    const Token1 = token<{ dispose: () => void }>('Token1');
    const Token2 = token<{ dispose: () => void }>('Token2');

    // Provide values for both tokens
    const disposer1 = vi.fn();
    const disposer2 = vi.fn();
    scope.provide(Token1, { dispose: disposer1 });
    scope.provide(Token2, { dispose: disposer2 });

    // Override only Token1
    const newDisposer1 = vi.fn();
    scope.override(Token1, { dispose: newDisposer1 });

    await scope.dispose();

    // Token1's old disposer should not be called, but Token2's should
    expect(disposer1).not.toHaveBeenCalled();
    expect(newDisposer1).toHaveBeenCalledOnce();
    expect(disposer2).toHaveBeenCalledOnce();
  });

  it('should handle override of value without disposer to value with disposer', async () => {
    const scope = new Scope();
    const TestT = token<{ dispose?: () => void }>('Test');

    // Provide value without disposer
    scope.provide(TestT, { name: 'test' });

    // Override with value that has disposer
    const disposeSpy = vi.fn();
    scope.override(TestT, { dispose: disposeSpy });

    await scope.dispose();

    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it('should handle override of value with disposer to value without disposer', async () => {
    const scope = new Scope();
    const TestT = token<{ dispose?: () => void }>('Test');

    // Provide value with disposer
    const disposeSpy = vi.fn();
    scope.provide(TestT, { dispose: disposeSpy });

    // Override with value without disposer
    scope.override(TestT, { name: 'test' });

    await scope.dispose();

    // Old disposer should not be called
    expect(disposeSpy).not.toHaveBeenCalled();
  });

  it('should work with async disposers', async () => {
    const scope = new Scope();
    const TestT = token<{ dispose: () => Promise<void> }>('Test');

    // Provide async value
    const asyncDispose1 = vi.fn().mockResolvedValue(undefined);
    scope.provide(TestT, { dispose: asyncDispose1 });

    // Override with another async value
    const asyncDispose2 = vi.fn().mockResolvedValue(undefined);
    scope.override(TestT, { dispose: asyncDispose2 });

    await scope.dispose();

    expect(asyncDispose1).not.toHaveBeenCalled();
    expect(asyncDispose2).toHaveBeenCalledOnce();
  });

  it('should preserve resolution after override', () => {
    const scope = new Scope();
    const TestT = token<{ value: string }>('Test');

    scope.provide(TestT, { value: 'first' });
    expect(scope.resolve(TestT).value).toBe('first');

    scope.override(TestT, { value: 'second' });
    expect(scope.resolve(TestT).value).toBe('second');
  });
});
