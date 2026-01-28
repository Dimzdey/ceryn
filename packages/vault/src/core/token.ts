/**
 * Branded type for canonical token identifiers.
 * Prevents accidental use of raw strings as token IDs.
 */
export type CanonicalId = string & { __brand: 'CanonicalId' };

/**
 * Phantom type brand for compile-time type safety.
 * Associates tokens with their resolved value type without runtime overhead.
 */
declare const TOKEN_BRAND: unique symbol;

/**
 * Type-safe injection token.
 *
 * Tokens uniquely identify dependencies and carry their type information
 * at compile time via the phantom type parameter T.
 *
 * @template T - The type of value this token resolves to
 */
export interface Token<T = unknown> {
  /** Discriminant for runtime type checking */
  readonly kind: 'token';

  /** Unique canonical identifier (tok_1, tok_2, etc.) */
  readonly id: CanonicalId;

  /** Human-readable label for debugging and error messages */
  readonly label: string;

  /**
   * @deprecated Use `label` instead. Kept for backward compatibility.
   */
  readonly debug: string;

  /** Unique symbol for identity checks (future use) */
  readonly sym: symbol;

  /** Phantom type brand - associates token with its value type */
  readonly [TOKEN_BRAND]: T;
}

/**
 * Global counter for generating unique token IDs.
 * Starts at 0 and increments with each token() call.
 */
let _tokCounter = 0;

/**
 * Create a new type-safe injection token.
 *
 * Tokens are frozen objects that uniquely identify dependencies in the DI system.
 * Each token gets a unique canonical ID and carries its type information.
 *
 * @template T - The type of value this token will resolve to
 * @param label - Optional human-readable label for debugging (defaults to "Token")
 * @returns A frozen Token object with unique identity
 *
 * @example
 * ```typescript
 * const UserServiceT = token<UserService>('UserService');
 * const ConfigT = token<AppConfig>('AppConfig');
 * ```
 */
export function token<T = unknown>(label?: string): Token<T> {
  const resolvedLabel = label ?? `Token`;
  const id = `tok_${++_tokCounter}` as CanonicalId;
  const t: Token<T> = Object.freeze({
    kind: 'token',
    id,
    label: resolvedLabel,
    debug: resolvedLabel,
    sym: Symbol(resolvedLabel),
  }) as Token<T>;
  return t;
}

/**
 * Runtime type guard to check if a value is a valid Token.
 *
 * Validates that the object has all required Token properties with correct types.
 * Used for input validation in public APIs.
 *
 * @param x - Value to check
 * @returns true if x is a valid Token, false otherwise
 */
export function isToken(x: unknown): x is Token<unknown> {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as Token).kind === 'token' &&
    typeof (x as Token).id === 'string' &&
    typeof (x as Token).label === 'string' &&
    typeof (x as Token).sym === 'symbol'
  );
}
