import { describe, expect, it } from 'vitest';

import { isToken, token } from '../src/core/token.js';

describe('token()', () => {
  it('creates frozen tokens with unique ids and labels', () => {
    const first = token('Example');
    const second = token();

    expect(first.label).toBe('Example');
    expect(second.label).toBe('Token');
    expect(first.id).not.toBe(second.id);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
    expect(first.kind).toBe('token');
  });

  it('validates token objects with isToken()', () => {
    const valid = token('Valid');

    expect(isToken(valid)).toBe(true);
    expect(isToken(null)).toBe(false);
    expect(isToken({})).toBe(false);
    expect(isToken({ kind: 'token' })).toBe(false);
  });
});
