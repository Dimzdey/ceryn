import { afterEach, describe, expect, it, vi } from 'vitest';

import { MetadataRegistry } from '../src/registry/metadata-registry.js';

const originalEnv = process.env.NODE_ENV;

describe('Production environment branches', () => {
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    MetadataRegistry.resetForTests();
    vi.resetModules();
  });

  it('covers production-specific fast paths', async () => {
    process.env.NODE_ENV = 'production';
    vi.resetModules();

    const { Injectable: ProdInjectable } = await import('../src/decorators/injectable.js');
    const { Inject } = await import('../src/decorators/inject.js');
    const { Vault: ProdVault } = await import('../src/core/vault.js');
    const { token } = await import('../src/core/token.js');
    const { InvalidProviderError, FactoryExecutionError, AggregateDisposalError } = await import(
      '../src/errors/errors.js'
    );

    const TokenA = token('ProdA');
    const TokenB = token('ProdB');

    @ProdInjectable({ provide: TokenB })
    class ProviderB {}

    @ProdInjectable({ provide: TokenA })
    class ProviderA {
      constructor(@Inject(TokenB) _dep: ProviderB) {}
    }

    const vault = new ProdVault({ providers: [ProviderB, ProviderA] });
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
