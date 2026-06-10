import { beforeEach, describe, expect, it } from 'vitest';
import { token } from '../src/core/token.js';
import { Vault } from '../src/core/vault.js';
import { Injectable, Inject } from '../src/decorators/index.js';
import { LifecycleViolationError } from '../src/errors/errors.js';
import { MetadataRegistry } from '../src/registry/metadata-registry.js';
import { Lifecycle } from '../src/types/types.js';

beforeEach(() => {
  MetadataRegistry.resetForTests();
});

describe('Lifecycle validation (resolution-time)', () => {
  it('catches singleton depending on scoped even when consumer registered BEFORE dependency', () => {
    const ScopedToken = token('ScopedDep');
    const SingletonToken = token('BadSingleton');

    @Injectable({ provide: SingletonToken, lifecycle: Lifecycle.Singleton })
    class BadSingleton {
      constructor(@Inject(ScopedToken) _dep: unknown) {}
    }

    @Injectable({ provide: ScopedToken, lifecycle: Lifecycle.Scoped })
    class ScopedDep {}

    // Register consumer BEFORE dependency — registration-time check misses this
    // Use shadowPolicy: 'allow' to avoid shadow enforcement interfering
    const vault = new Vault({ providers: [BadSingleton, ScopedDep], shadowPolicy: 'allow' });
    const scope = vault.createScope();

    expect(() => scope.resolve(SingletonToken)).toThrow(LifecycleViolationError);
  });

  it('catches singleton depending on transient in reverse registration order', () => {
    const TransientToken = token('TransientDep');
    const SingletonToken = token('BadSingleton2');

    @Injectable({ provide: SingletonToken, lifecycle: Lifecycle.Singleton })
    class BadSingleton2 {
      constructor(@Inject(TransientToken) _dep: unknown) {}
    }

    @Injectable({ provide: TransientToken, lifecycle: Lifecycle.Transient })
    class TransientDep {}

    // Consumer registered BEFORE dependency
    const vault = new Vault({ providers: [BadSingleton2, TransientDep], shadowPolicy: 'allow' });

    expect(() => vault.resolve(SingletonToken)).toThrow(LifecycleViolationError);
  });
});
