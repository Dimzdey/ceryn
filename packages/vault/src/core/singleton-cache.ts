import type { Entry } from './entry-store.js';

/**
 * Unbounded singleton entry cache.
 *
 * Simple cache using a Map for O(1) lookups. Stores entries for
 * canonical IDs and all aliases to enable fast resolution.
 */
export class SingletonCache {
  private readonly index = new Map<string, Entry>();

  get(token: string): Entry | undefined {
    return this.index.get(token);
  }

  private prime(token: string, entry: Entry): void {
    this.index.set(token, entry);
  }

  primeAll(requestToken: string, entry: Entry): void {
    this.prime(entry.token, entry);
    if (requestToken !== entry.token) {
      this.prime(requestToken, entry);
    }
    if (entry.aliases) {
      for (const alias of entry.aliases) {
        if (alias && alias !== entry.token && alias !== requestToken) {
          this.prime(alias, entry);
        }
      }
    }
  }

  clear(): void {
    this.index.clear();
  }
}
