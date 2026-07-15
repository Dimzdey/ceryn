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
 *    @Inject decorator, unconstructable values, async factory in sync path).
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
  MissingInjectDecoratorError,
  UnconstructableProviderError,
} from '../errors/errors.js';
import type { Entry } from './entry-store.js';
import { FLAG_HAS_NO_DEPS, FLAG_LOCAL_DEPS_VALIDATED } from './flags.js';
import type { ResolutionPath } from './resolution-path.js';
import type { Scope } from './scope.js';
import type { CanonicalId } from './token.js';
import type { Vault } from './vault.js';

type InstantiateHook = (token: string, durationNs: number) => void;

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
 * Provider instantiation engine.
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
  private instrumentSync<T>(token: CanonicalId, hook: InstantiateHook, execute: () => T): T {
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
  private async instrumentAsync<T>(
    token: CanonicalId,
    hook: InstantiateHook,
    execute: () => Promise<T> | T
  ): Promise<T> {
    const start = nowMs();
    try {
      return await execute();
    } finally {
      hook(token, toNs(nowMs() - start));
    }
  }

  private invokeFactorySync(
    entry: Entry,
    dependencyCount: number,
    oneDependency: unknown,
    manyDependencies: readonly unknown[] | undefined
  ): unknown {
    const factory = entry.factory!;
    const result =
      dependencyCount === 0
        ? factory()
        : dependencyCount === 1
          ? factory(oneDependency)
          : factory(...manyDependencies!);
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
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
  }

  private async invokeFactoryAsync(
    entry: Entry,
    dependencyCount: number,
    oneDependency: unknown,
    manyDependencies: readonly unknown[] | undefined,
    signal?: AbortSignal
  ): Promise<unknown> {
    const factory = entry.factory!;
    const withContext = factory.length === dependencyCount + 1;
    const maybe =
      dependencyCount === 0
        ? withContext
          ? factory({ signal })
          : factory()
        : dependencyCount === 1
          ? withContext
            ? factory(oneDependency, { signal })
            : factory(oneDependency)
          : withContext
            ? factory(...manyDependencies!, { signal })
            : factory(...manyDependencies!);
    return typeof maybe === 'function'
      ? await (maybe as (ctx: { signal?: AbortSignal }) => Promise<unknown>)({ signal })
      : await maybe;
  }

  private invokeConstructorSync(
    entry: Entry,
    dependencyCount: number,
    oneDependency: unknown,
    manyDependencies: readonly unknown[] | undefined
  ): unknown {
    const ctor = entry.ctor!;
    const hook = this.vault.getInstantiateHook();
    if (!hook) {
      return dependencyCount === 0
        ? new ctor()
        : dependencyCount === 1
          ? new ctor(oneDependency)
          : new ctor(...manyDependencies!);
    }
    return this.instrumentSync(entry.token, hook, () =>
      dependencyCount === 0
        ? new ctor()
        : dependencyCount === 1
          ? new ctor(oneDependency)
          : new ctor(...manyDependencies!)
    );
  }

  /**
   * Synchronous instantiation.
   *
   * Behavior contract
   *  - Throws `FactoryExecutionError` when a factory is async or otherwise
   *    can't produce a sync result.
   *  - Throws `UnconstructableProviderError` when neither ctor nor instance exist.
   *  - Throws `MissingInjectDecoratorError` when constructor summons are missing
   *    decorator metadata (i.e. undefined token in summons list).
   *  - Accepts optional scope for scoped lifecycle resolution.
   */
  instantiateSync(entry: Entry, path: ResolutionPath, scope?: Scope): unknown {
    const lifecycleAlreadyValidated =
      scope === undefined && (entry.flags & FLAG_LOCAL_DEPS_VALIDATED) !== 0;

    // Factory-backed (sync only)
    if (entry.factory) {
      const dependencyCount = entry.factoryDeps.length;
      const oneDependency =
        dependencyCount === 1
          ? this.vault._resolveProvider(
              entry.factoryDeps[0],
              path,
              scope,
              lifecycleAlreadyValidated
            )
          : undefined;
      const manyDependencies =
        dependencyCount > 1
          ? entry.factoryDeps.map((dependency) =>
              this.vault._resolveProvider(dependency, path, scope, lifecycleAlreadyValidated)
            )
          : undefined;
      try {
        const hook = this.vault.getInstantiateHook();
        if (!hook) {
          return this.invokeFactorySync(entry, dependencyCount, oneDependency, manyDependencies);
        }
        return this.instrumentSync(entry.token, hook, () =>
          this.invokeFactorySync(entry, dependencyCount, oneDependency, manyDependencies)
        );
      } catch (error) {
        if (error instanceof FactoryExecutionError) throw error;
        throw new FactoryExecutionError(entry.token, error);
      }
    }

    // Value-backed: user supplied a concrete value via useValue provider
    if (!entry.ctor) {
      if (entry.instance !== undefined) return entry.instance;
      throw new UnconstructableProviderError(entry.token);
    }

    const dependencyCount = entry.flags & FLAG_HAS_NO_DEPS ? 0 : entry.summons.length;
    let oneDependency: unknown;
    let manyDependencies: readonly unknown[] | undefined;
    if (dependencyCount === 1) {
      const dependency = entry.summons[0];
      if (!dependency) throw new MissingInjectDecoratorError(entry.ctor.name, 0);
      oneDependency = this.vault._resolveProvider(
        dependency,
        path,
        scope,
        lifecycleAlreadyValidated
      );
    } else if (dependencyCount > 1) {
      manyDependencies = entry.summons.map((dependency, index) => {
        if (!dependency) throw new MissingInjectDecoratorError(entry.ctor!.name, index);
        return this.vault._resolveProvider(dependency, path, scope, lifecycleAlreadyValidated);
      });
    }
    return this.invokeConstructorSync(entry, dependencyCount, oneDependency, manyDependencies);
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
    path: ResolutionPath,
    signal?: AbortSignal,
    scope?: Scope
  ): Promise<unknown> {
    const lifecycleAlreadyValidated =
      scope === undefined && (entry.flags & FLAG_LOCAL_DEPS_VALIDATED) !== 0;

    // Factory-backed (async-aware)
    if (entry.factory) {
      const dependencyCount = entry.factoryDeps.length;
      let oneDependency: unknown;
      let manyDependencies: readonly unknown[] | undefined;
      if (dependencyCount === 1) {
        oneDependency = await this.vault._resolveProviderAsync(
          entry.factoryDeps[0],
          path.fork(),
          signal,
          scope,
          lifecycleAlreadyValidated
        );
      } else if (dependencyCount > 1) {
        manyDependencies = await Promise.all(
          entry.factoryDeps.map((dependency) =>
            this.vault._resolveProviderAsync(
              dependency,
              path.fork(),
              signal,
              scope,
              lifecycleAlreadyValidated
            )
          )
        );
      }

      try {
        const hook = this.vault.getInstantiateHook();
        if (!hook) {
          return await this.invokeFactoryAsync(
            entry,
            dependencyCount,
            oneDependency,
            manyDependencies,
            signal
          );
        }
        return await this.instrumentAsync(entry.token, hook, () =>
          this.invokeFactoryAsync(entry, dependencyCount, oneDependency, manyDependencies, signal)
        );
      } catch (error) {
        if (signal?.aborted) {
          throw new Error(`Factory for '${entry.token}' aborted`, { cause: error });
        }
        throw new FactoryExecutionError(entry.token, error);
      }
    }

    // Value-backed
    if (!entry.ctor) {
      if (entry.instance !== undefined) return entry.instance;
      throw new UnconstructableProviderError(entry.token);
    }

    const dependencyCount = entry.flags & FLAG_HAS_NO_DEPS ? 0 : entry.summons.length;
    let oneDependency: unknown;
    let manyDependencies: readonly unknown[] | undefined;
    if (dependencyCount === 1) {
      const dependency = entry.summons[0];
      if (!dependency) throw new MissingInjectDecoratorError(entry.ctor.name, 0);
      oneDependency = await this.vault._resolveProviderAsync(
        dependency,
        path.fork(),
        signal,
        scope,
        lifecycleAlreadyValidated
      );
    } else if (dependencyCount > 1) {
      manyDependencies = await Promise.all(
        entry.summons.map(async (dependency, index) => {
          if (!dependency) throw new MissingInjectDecoratorError(entry.ctor!.name, index);
          return this.vault._resolveProviderAsync(
            dependency,
            path.fork(),
            signal,
            scope,
            lifecycleAlreadyValidated
          );
        })
      );
    }
    return this.invokeConstructorSync(entry, dependencyCount, oneDependency, manyDependencies);
  }
}
