/*
 * EntryStore
 * ----------
 * Lightweight canonical registry used by Vault to map:
 *  - canonical token string -> Entry
 *  - alias string -> canonical token string
 *  - constructor (ctor function) -> canonical token string
 *
 * Responsibilities
 *  - keep a compact map of registered Entries (the authoritative data)
 *  - maintain a fast lookup index for token/alias/ctor → canonical token
 *  - enforce collision rules and provide helpful error messages
 *
 * Design notes
 *  - The implementation favors simplicity and predictable invariants over clever
 *    micro-optimizations; the index map intentionally stores the canonical token
 *    string as the value for all alias/ctor keys so lookups are cheap.
 *  - All mutation happens via `add()`; there is no removal API in the current
 *    design (registrations are expected to be sealed). This reduces complexity
 *    around removing aliases and preserving invariants.
 *  - Errors thrown on collisions include the existing canonical owner and the
 *    new vault name to make debugging multi-vault fusion easier.
 */
import { TokenCollisionError } from '../errors/errors';
import type { Constructor, RelicMetadata } from '../types/types';
import type { CanonicalId } from './token.js';

/**
 * Internal entry describing a registered relic.
 *
 * Notes on fields:
 *  - token: canonical token string used to index the Entry in `entries`.
 *  - ctor: optional constructor function for constructor-based lookup.
 *  - factory: optional factory function (may be async).
 *  - factoryDeps: explicit dependencies for factories (readonly array for immutability)
 *  - metadata: lifecycle + human name information
 *  - summons: injection tokens for ctor arguments declared via @Summon() (kept as readonly)
 *  - aliases: alternative names (strings) that should map to the canonical token
 *  - instance: materialized singleton instance (when applicable)
 *  - promise: pending creation promise for async singletons
 *  - flags: bitfield for fast runtime checks (singleton, hasInstance, etc.)
 */
export type Entry = {
  token: CanonicalId;
  ctor?: Constructor;
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  factory?: (...args: unknown[]) => Promise<unknown> | unknown;
  factoryDeps: readonly CanonicalId[];
  metadata: RelicMetadata;
  summons: readonly (CanonicalId | undefined)[];
  aliases: readonly string[];
  instance?: unknown;
  /** Pending creation for async singletons. */
  promise?: Promise<unknown>;
  flags: number;
};

/**
 * Registry of canonical entries for a single vault.
 *
 * Maintains the authoritative mapping from canonical token IDs to their
 * Entry metadata. Also tracks ownership for collision detection.
 */
export class EntryStore {
  /** Primary storage: canonical token -> Entry metadata */
  private readonly entries = new Map<CanonicalId, Entry>();

  /** Ownership tracking: canonical token -> vault name (for error messages) */
  private readonly owners = new Map<CanonicalId, string>();

  /**
   * Number of registered canonical entries.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Retrieve an Entry by its canonical token.
   *
   * @param canonical - The canonical token ID
   * @returns Entry metadata if found, undefined otherwise
   */
  getByCanonical(canonical: CanonicalId): Entry | undefined {
    return this.entries.get(canonical);
  }

  /**
   * Iterator of all registered canonical token IDs.
   * Useful for diagnostics and vault introspection.
   */
  *canonicalKeys(): IterableIterator<CanonicalId> {
    yield* this.entries.keys();
  }

  /**
   * Check if a canonical token is registered in this store.
   *
   * @param token - Canonical token ID to check
   * @returns true if registered, false otherwise
   */
  has(token: CanonicalId): boolean {
    return this.entries.has(token);
  }

  /**
   * Register a new entry in this store.
   *
   * @param entry - The Entry metadata to register
   * @param vaultName - Name of the owning vault (for collision errors)
   * @throws TokenCollisionError if the canonical token is already registered
   */
  add(entry: Entry, vaultName: string): void {
    const existingOwner = this.owners.get(entry.token);
    if (existingOwner) {
      throw new TokenCollisionError(entry.token, existingOwner, vaultName);
    }
    this.entries.set(entry.token, entry);
    this.owners.set(entry.token, vaultName);
  }
}
