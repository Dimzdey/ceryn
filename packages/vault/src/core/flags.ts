/*
 * Entry Flag System
 * -----------------
 * Compact bit flags used in Entry.flags to optimize runtime checks.
 *
 * Memory layout (32-bit integer):
 *   Bits 0-1:  Lifecycle type (2 bits = 4 possible values)
 *   Bit  2:    Has materialized instance
 *   Bit  3:    Has no dependencies (fast-path optimization)
 *   Bit  4:    Container owns materialized instance and may dispose it
 *   Bit  5: Entry is backed by a pre-created value provider
 *   Bit  6: All declared dependencies were local and lifecycle-validated
 *   Bit  7: Owned singleton is tracked for LIFO disposal
 *   Bit  8: Root graph is certified resolvable within this sealed Vault
 *   Bits 9-31: Reserved for future flags
 *
 * Design rationale:
 *   - Lifecycle in bits 0-1 for fast masking and comparison
 *   - State flags in higher bits to avoid conflicts
 *   - Bitwise operations are significantly faster than string comparisons
 *   - All flags fit in a single integer for cache efficiency
 */

/**
 * Lifecycle type flags (bits 0-1).
 *
 * These occupy the lowest 2 bits of the flags field, allowing for 4 distinct
 * lifecycle types. Extract with `flags & LIFECYCLE_MASK`.
 */
export const LIFECYCLE_SINGLETON = 0b00; // Single instance per vault
export const LIFECYCLE_SCOPED = 0b01; // Instance per logical scope
export const LIFECYCLE_TRANSIENT = 0b10; // New instance per resolution

/**
 * Mask to extract lifecycle bits from flags field.
 * Usage: `const lifecycle = entry.flags & LIFECYCLE_MASK;`
 */
export const LIFECYCLE_MASK = 0b11;

/**
 * State flag: Instance has been materialized and stored.
 * Set when the instance field contains a valid value.
 */
export const FLAG_HAS_INSTANCE = 1 << 2; // Bit 2

/**
 * State flag: Relic has zero dependencies.
 * Enables fast-path construction without dependency resolution.
 */
export const FLAG_HAS_NO_DEPS = 1 << 3; // Bit 3

/**
 * State flag: Container owns the materialized instance.
 * Owned instances are automatically disposed when their container/scope ends.
 * External values such as useValue or scope.provide() are unowned by default.
 */
export const FLAG_OWNS_INSTANCE = 1 << 4; // Bit 4

/**
 * State flag: Entry is backed by a `useValue` registration.
 *
 * Value registrations are part of the container configuration rather than a
 * materialized cache entry, so `Vault.clear()` must retain them.
 */
export const FLAG_VALUE_PROVIDER = 1 << 5; // Bit 5

/** All declared dependencies were local and validated in registration order. */
export const FLAG_LOCAL_DEPS_VALIDATED = 1 << 6; // Bit 6

/** Owned singleton token is present in its Vault's LIFO disposal order. */
export const FLAG_DISPOSAL_TRACKED = 1 << 7; // Bit 7

/** Sealed root graph was successfully validated without crossing a Vault boundary. */
export const FLAG_RESOLVABLE = 1 << 8; // Bit 8

/**
 * Legacy alias for LIFECYCLE_SINGLETON (bit pattern 0b00).
 * Maintained for backward compatibility with code checking `flags & FLAG_SINGLETON`.
 * @deprecated Use LIFECYCLE_SINGLETON and LIFECYCLE_MASK for lifecycle checks.
 */
export const FLAG_SINGLETON = LIFECYCLE_SINGLETON;
