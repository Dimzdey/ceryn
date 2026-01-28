import { describe, expect, it } from 'vitest';

import { EntryStore, type Entry } from '../src/core/entry-store.js';
import { TokenCollisionError } from '../src/errors/errors.js';
import type { CanonicalId } from '../src/index.js';

const createEntry = (token: CanonicalId, overrides: Partial<Entry> = {}): Entry => ({
  token,
  aliases: [token],
  summons: [],
  factoryDeps: [],
  metadata: { name: token, label: token, lifecycle: 'singleton' },
  flags: 0,
  ...overrides,
});

describe('EntryStore', () => {
  it('registers and retrieves entries by canonical id', () => {
    const store = new EntryStore();
    const entry = createEntry('tok_1' as CanonicalId);

    store.add(entry, 'PrimaryVault');

    expect(store.size).toBe(1);
    expect(store.getByCanonical('tok_1' as CanonicalId)).toBe(entry);
    expect(Array.from(store.canonicalKeys())).toEqual(['tok_1']);
  });

  it('throws on token collisions with helpful context', () => {
    const store = new EntryStore();
    store.add(createEntry('tok_conflict' as CanonicalId), 'ExistingVault');

    expect(() => store.add(createEntry('tok_conflict' as CanonicalId), 'NewVault')).toThrowError(
      TokenCollisionError
    );
  });
});
