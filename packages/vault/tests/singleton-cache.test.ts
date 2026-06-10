import { describe, expect, it } from 'vitest';

import type { Entry } from '../src/core/entry-store.js';
import { SingletonCache } from '../src/core/singleton-cache.js';
import type { CanonicalId } from '../src/index.js';

const createEntry = (overrides: Partial<Entry> = {}): Entry => ({
  token: 'tok_cache' as CanonicalId,
  aliases: ['alias_cache'],
  summons: [],
  factoryDeps: [],
  metadata: { name: 'tok_cache' as CanonicalId, label: 'Cache', lifecycle: 'singleton' },
  flags: 0,
  ...overrides,
});

describe('SingletonCache', () => {
  it('primes entries for canonical, request token, and aliases', () => {
    const cache = new SingletonCache();
    const entry = createEntry();

    cache.primeAll('request_token', entry);

    expect(cache.get('tok_cache')).toBe(entry);
    expect(cache.get('request_token')).toBe(entry);
    expect(cache.get('alias_cache')).toBe(entry);
  });

  it('clears cached entries', () => {
    const cache = new SingletonCache();
    cache.primeAll('tok_cache', createEntry());

    expect(cache.get('tok_cache')).toBeTruthy();
    cache.clear();
    expect(cache.get('tok_cache')).toBeUndefined();
  });
});
