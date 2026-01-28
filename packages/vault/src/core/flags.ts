/*
 * Entry Flag System
 * -----------------
 * Compact bit flags used in Entry.flags to optimize runtime checks.
 *
 * Memory layout (32-bit integer):
 *   Bits 0-1:  Lifecycle type (2 bits = 4 possible values)
 *   Bit  2:    Has materialized instance
 *   Bit  3:    Has no dependencies (fast-path optimization)
 *   Bits 4-31: Reserved for future flags
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
 * Legacy alias for LIFECYCLE_SINGLETON (bit pattern 0b00).
 * Maintained for backward compatibility with code checking `flags & FLAG_SINGLETON`.
 * @deprecated Use LIFECYCLE_SINGLETON and LIFECYCLE_MASK for lifecycle checks.
 */
export const FLAG_SINGLETON = LIFECYCLE_SINGLETON;
