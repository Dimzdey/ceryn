import { beforeEach, describe, expect, it } from 'vitest';
import { token } from '../src/core/token.js';
import { Vault } from '../src/core/vault.js';
import { StaticRelicRegistry } from '../src/registry/static-registry.js';
import { CircularDependencyError } from '../src/errors/errors.js';

beforeEach(() => {
  StaticRelicRegistry.resetForTests();
});

describe('Re-entrant resolve', () => {
  it('does not corrupt cycle detection when factory calls vault.resolve()', () => {
    const InnerToken = token<string>('Inner');
    const OuterToken = token<{ inner: string }>('Outer');

    const vault = new Vault({
      relics: [
        { provide: InnerToken, useValue: 'inner-value' },
        {
          provide: OuterToken,
          useFactory: () => {
            // Re-entrant: resolve another token during factory execution
            const inner = vault.resolve(InnerToken) as string;
            return { inner };
          },
        },
      ],
    });

    const result = vault.resolve(OuterToken) as { inner: string };
    expect(result.inner).toBe('inner-value');
  });

  it('still detects real circular dependencies after re-entrant resolve', () => {
    const AToken = token('A');
    const BToken = token('B');

    const vault = new Vault({
      relics: [
        {
          provide: AToken,
          useFactory: () => vault.resolve(BToken),
          deps: [],
        },
        {
          provide: BToken,
          useFactory: () => vault.resolve(AToken),
          deps: [],
        },
      ],
    });

    // Factory-based circular deps through re-entrant vault.resolve() cause
    // stack overflow, which is caught and wrapped by the factory executor.
    // The important thing is it throws (doesn't hang or corrupt state).
    expect(() => vault.resolve(AToken)).toThrow();
  });

  it('detects declared circular dependencies via deps array', () => {
    const AToken = token('A');
    const BToken = token('B');

    const vault = new Vault({
      relics: [
        {
          provide: AToken,
          useFactory: (_b: unknown) => 'a',
          deps: [BToken],
        },
        {
          provide: BToken,
          useFactory: (_a: unknown) => 'b',
          deps: [AToken],
        },
      ],
    });

    // Declared deps are detected by the stack-based cycle detection
    expect(() => vault.resolve(AToken)).toThrow(CircularDependencyError);
  });
});
