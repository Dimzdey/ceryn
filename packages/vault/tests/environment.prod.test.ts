import { afterEach, describe, expect, it, vi } from 'vitest';

import { StaticRelicRegistry } from '../src/registry/static-registry.js';

const originalEnv = process.env.NODE_ENV;

describe('Production environment branches', () => {
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    StaticRelicRegistry.resetForTests();
    vi.resetModules();
  });

  it('covers production-specific fast paths', async () => {
    process.env.NODE_ENV = 'production';
    vi.resetModules();

    const { Relic: ProdRelic } = await import('../src/decorators/relic.js');
    const { Summon } = await import('../src/decorators/summon.js');
    const { Vault: ProdVault } = await import('../src/core/vault.js');
    const { token } = await import('../src/core/token.js');
    const { InvalidProviderError, FactoryExecutionError, AggregateDisposalError } = await import(
      '../src/errors/errors.js'
    );

    const TokenA = token('ProdA');
    const TokenB = token('ProdB');

    @ProdRelic({ provide: TokenB })
    class RelicB {}

    @ProdRelic({ provide: TokenA })
    class RelicA {
      constructor(@Summon(TokenB) _dep: RelicB) {}
    }

    const vault = new ProdVault({ relics: [RelicB, RelicA] });
    expect(() => vault.resolve({} as never)).toThrow(); // assertValidToken no-op
    expect(() => vault.resolve(TokenA)).not.toThrow();

    const providerErr = new InvalidProviderError({ foo: 'bar' });
    expect(providerErr.message).toBe('Invalid provider configuration.');

    const factoryErr = new FactoryExecutionError('tok_prod', new Error('fail'));
    expect(factoryErr.message).toBe("Factory for 'tok_prod' failed during creation.");

    const aggregate = new AggregateDisposalError([new Error('one'), new Error('two')]);
    expect(aggregate.message).toContain('2 disposal error');
  });
});
