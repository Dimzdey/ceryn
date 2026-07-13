import { describe, expect, it } from 'vitest';

import { ResolutionPath } from '../src/core/resolution-path.js';
import type { CanonicalId } from '../src/core/token.js';

const id = (value: string) => value as CanonicalId;

describe('ResolutionPath', () => {
  it('tracks membership and returns an ordered cycle', () => {
    const path = new ResolutionPath();
    path.enter(id('A'));
    path.enter(id('B'));
    path.enter(id('C'));

    expect(path.has(id('B'))).toBe(true);
    expect(path.cycle(id('B'))).toEqual([id('B'), id('C'), id('B')]);

    path.leave(id('C'));
    path.leave(id('B'));
    expect(path.tokens).toEqual([id('A')]);
    expect(path.has(id('B'))).toBe(false);
  });

  it('forks independent async branches', () => {
    const parent = new ResolutionPath();
    parent.enter(id('A'));
    const child = parent.fork();
    child.enter(id('B'));

    expect(parent.tokens).toEqual([id('A')]);
    expect(child.tokens).toEqual([id('A'), id('B')]);
    expect(parent.has(id('B'))).toBe(false);
  });

  it('keeps deep membership and cleanup correct after switching to active-set storage', () => {
    const tokens = Array.from({ length: 35 }, (_, index) => id(`Token${index}`));
    const path = new ResolutionPath();
    for (const token of tokens) path.enter(token);

    expect(path.has(tokens[0])).toBe(true);
    expect(path.has(tokens[34])).toBe(true);
    expect(() => path.enter(tokens[17])).toThrow('ResolutionPath duplicate enter');

    path.leave(tokens[34]);
    path.leave(tokens[33]);
    expect(path.has(tokens[34])).toBe(false);
    expect(path.has(tokens[33])).toBe(false);
    expect(path.tokens).toEqual(tokens.slice(0, 33));
  });

  it('rejects non-LIFO cleanup', () => {
    const path = new ResolutionPath();
    path.enter(id('A'));
    path.enter(id('B'));
    expect(() => path.leave(id('A'))).toThrow('ResolutionPath leave order mismatch');
  });

  it('tries entry atomically without mutating the path on a duplicate', () => {
    const path = new ResolutionPath();

    expect(path.tryEnter(id('A'))).toBe(true);
    expect(path.tryEnter(id('A'))).toBe(false);
    expect(path.tokens).toEqual([id('A')]);
  });
});
