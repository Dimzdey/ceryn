/* Activator
 *
 * Responsible for materializing a registered Entry into a runtime value.
 * It handles three distinct paths:
 *  - factory-backed entries (may be sync or async, and may opt into AbortSignal)
 *  - value-backed entries (pre-instantiated singletons)
 *  - constructor-backed entries (ctor + summons)
 *
 * Goals / guarantees
 *  - Keep instantiation logic isolated from Vault resolution policies.
 *  - Preserve existing sync behavior while providing a first-class async
 *    instantiation flow that supports abort signals and curried factories.
 *  - Provide clear, richly-typed errors for common programmer mistakes (missing
 *    @Summon decorator, unconstructable values, async factory in sync path).
 *
 * Notes on AbortSignal handling
 *  - Factories may accept an options argument of shape { signal } as the last
 *    parameter. To remain backward compatible we detect the factory arity and
 *    only pass the options object when the factory function expects it.
 *  - When a curried factory returns a function, the activator will call that
 *    function with { signal } and await the result. This accommodates patterns
 *    like `() => async (ctx) => { ... }` where the outer function is sync but
 *    returns an async function that accepts the signal.
 */

import {
  FactoryExecutionError,
  MissingSummonDecoratorError,
  UnconstructableRelicError,
} from '../errors/errors.js';
import type { Entry } from './entry-store.js';
import { FLAG_HAS_NO_DEPS } from './flags.js';
import type { Scope } from './scope.js';
import type { CanonicalId } from './token.js';
import type { Vault } from './vault.js';

/** Empty dependencies constant - reused to avoid allocations */
const EMPTY_DEPS: readonly CanonicalId[] = Object.freeze([] as CanonicalId[]);

/**
 * High-resolution timer function.
 * Prefers performance.now() when available, falls back to Date.now().
 * Initialized once at module load for performance.
 */
const nowMs = (() => {
  const maybePerf = typeof globalThis !== 'undefined' ? globalThis.performance : undefined;
  return maybePerf && typeof maybePerf.now === 'function'
    ? () => maybePerf.now()
    : () => Date.now();
})();

/** Convert milliseconds to nanoseconds for instrumentation hook */
const toNs = (ms: number) => Math.round(ms * 1_000_000);

/**
 * Relic instantiation engine.
 *
 * Handles the creation of instances from Entry metadata, supporting:
 * - Factory functions (sync and async)
 * - Constructors with dependency injection
 * - Pre-instantiated values
 * - Performance instrumentation hooks
 * - AbortSignal propagation for async factories
 *
 * Separated from Vault to isolate instantiation concerns from resolution logic.
 */
export class Activator {
  constructor(private readonly vault: Vault) {}

  /**
   * Wrap synchronous instantiation with performance instrumentation.
   *
   * @param token - Token being instantiated (for hook reporting)
   * @param execute - Function that performs the instantiation
   * @returns The instantiated value
   */
  private instrumentSync<T>(token: CanonicalId, execute: () => T): T {
    const hook = this.vault.getInstantiateHook();
    if (!hook) return execute();

    const start = nowMs();
    try {
      return execute();
    } finally {
      hook(token, toNs(nowMs() - start));
    }
  }

  /**
   * Wrap asynchronous instantiation with performance instrumentation.
   *
   * @param token - Token being instantiated (for hook reporting)
   * @param execute - Function that performs the async instantiation
   * @returns Promise of the instantiated value
   */
  private async instrumentAsync<T>(token: CanonicalId, execute: () => Promise<T> | T): Promise<T> {
    const hook = this.vault.getInstantiateHook();
    if (!hook) return await execute();

    const start = nowMs();
    try {
      return await execute();
    } finally {
      hook(token, toNs(nowMs() - start));
    }
  }

  /**
   * Synchronous instantiation.
   *
   * Behavior contract
   *  - Throws `FactoryExecutionError` when a factory is async or otherwise
   *    can't produce a sync result.
   *  - Throws `UnconstructableRelicError` when neither ctor nor instance exist.
   *  - Throws `MissingSummonDecoratorError` when constructor summons are missing
   *    decorator metadata (i.e. undefined token in summons list).
   *  - Accepts optional scope for scoped lifecycle resolution.
   */
  instantiateSync(entry: Entry, stack: CanonicalId[], scope?: Scope): unknown {
    // Factory-backed (sync only)
    if (entry.factory) {
      const deps = entry.factoryDeps ?? EMPTY_DEPS;
      const args = deps.map((dep) => this.vault._resolveRelic(dep, stack, scope));
      try {
        return this.instrumentSync(entry.token, () => {
          const result = entry.factory!(...args);
          if (result && typeof (result as Promise<unknown>).then === 'function') {
            throw new FactoryExecutionError(
              entry.token,
              new Error('Async factory requires resolveAsync()')
            );
          }
          if (typeof result === 'function') {
            throw new FactoryExecutionError(
              entry.token,
              new Error('Curried async factory requires resolveAsync()')
            );
          }
          return result;
        });
      } catch (e) {
        // Preserve explicit FactoryExecutionError rethrows
        if (e instanceof FactoryExecutionError) throw e;
        // Wrap other errors to provide token context
        throw new FactoryExecutionError(entry.token, e);
      }
    }

    // Value-backed: user supplied a concrete value via useValue provider
    if (!entry.ctor) {
      if (entry.instance !== undefined) return entry.instance;
      throw new UnconstructableRelicError(entry.token);
    }

    // Zero-summons fast path: cheap constructor call when there are no dependencies
    if (entry.flags & FLAG_HAS_NO_DEPS)
      return this.instrumentSync(entry.token, () => new entry.ctor!());

    // Constructor with summons (sync)
    const args = entry.summons.map((dep, idx) => {
      if (!dep) throw new MissingSummonDecoratorError(entry.ctor!.name, idx);
      return this.vault._resolveRelic(dep, stack, scope);
    });

    return this.instrumentSync(entry.token, () => new entry.ctor!(...args));
  }

  /**
   * Asynchronous instantiation.
   *
   * Behavior contract
   *  - Accepts an optional AbortSignal that will be propagated to factories
   *    which opt-in via an extra final parameter or a curried function.
   *  - Converts thrown errors into `FactoryExecutionError` to provide token
   *    context; aborted factories produce a specific Abort error with cause.
   *  - Accepts optional scope for scoped lifecycle resolution.
   */
  async instantiateAsync(
    entry: Entry,
    stack: CanonicalId[],
    signal?: AbortSignal,
    scope?: Scope
  ): Promise<unknown> {
    // Factory-backed (async-aware)
    if (entry.factory) {
      // Resolve factory deps asynchronously; factories may themselves depend
      // on other async factories so we await them all here.
      const deps = await Promise.all(
        (entry.factoryDeps ?? EMPTY_DEPS).map((d) =>
          this.vault._resolveRelicAsync(d, stack, signal, scope)
        )
      );

      try {
        return await this.instrumentAsync(entry.token, async () => {
          const maybe =
            entry.factory!.length === deps.length + 1
              ? entry.factory!(...deps, { signal })
              : entry.factory!(...deps);

          return typeof maybe === 'function'
            ? await (maybe as (ctx: { signal?: AbortSignal }) => Promise<unknown>)({ signal })
            : await maybe;
        });
      } catch (e) {
        // When the AbortSignal was triggered, prefer a clear Abort error with cause
        if (signal?.aborted) throw new Error(`Factory for '${entry.token}' aborted`, { cause: e });
        throw new FactoryExecutionError(entry.token, e);
      }
    }

    // Value-backed
    if (!entry.ctor) {
      if (entry.instance !== undefined) return entry.instance;
      throw new UnconstructableRelicError(entry.token);
    }

    // Zero-summons fast path
    if (entry.flags & FLAG_HAS_NO_DEPS)
      return this.instrumentSync(entry.token, () => new entry.ctor!());

    // Constructor with summons; summons may themselves be async factories
    const args = await Promise.all(
      entry.summons.map(async (dep, idx) => {
        if (!dep) throw new MissingSummonDecoratorError(entry.ctor!.name, idx);
        return this.vault._resolveRelicAsync(dep, stack, signal, scope);
      })
    );

    return this.instrumentSync(entry.token, () => new entry.ctor!(...args));
  }
}
