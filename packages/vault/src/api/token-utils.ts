import { token, type Token } from '../core/token.js';

/**
 * Create multiple tokens at once with a shared prefix.
 * Useful for organizing related tokens in a feature or module.
 *
 * @param prefix - Common prefix for all tokens (e.g., 'User', 'Auth')
 * @param names - Token names to create
 * @returns Object with token names as keys and Token instances as values
 *
 * @example
 * ```typescript
 * const tokens = createTokenGroup('User', {
 *   Repository: null as UserRepository,
 *   Service: null as UserService,
 *   Controller: null as UserController,
 * });
 * // tokens.Repository: Token<UserRepository>
 * // tokens.Service: Token<UserService>
 * // tokens.Controller: Token<UserController>
 * ```
 */
export function createTokenGroup<T extends Record<string, unknown>>(
  prefix: string,
  names: T
): { [K in keyof T]: Token<T[K]> } {
  const result = {} as { [K in keyof T]: Token<T[K]> };

  (Object.keys(names) as Array<keyof T>).forEach((key) => {
    result[key] = token<T[typeof key]>(`${prefix}${String(key)}`);
  });

  return result;
}
