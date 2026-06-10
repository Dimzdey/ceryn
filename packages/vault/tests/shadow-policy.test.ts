import { beforeEach, describe, expect, it } from 'vitest';
import { token } from '../src/core/token.js';
import { Vault } from '../src/core/vault.js';
import { Injectable } from '../src/decorators/index.js';
import { MultipleShadowPolicyViolationsError } from '../src/errors/errors.js';
import { MetadataRegistry } from '../src/registry/metadata-registry.js';

beforeEach(() => {
  MetadataRegistry.resetForTests();
});

describe('Shadow policy enforcement', () => {
  it('throws MultipleShadowPolicyViolationsError with shadowPolicy error', () => {
    const SharedToken = token('Shared');

    @Injectable({ provide: SharedToken })
    class SharedRelic {}

    const producer = new Vault({
      providers: [SharedRelic],
      exports: [SharedToken],
    });

    // Consumer registers same token locally AND fuses the producer
    expect(
      () =>
        new Vault({
          providers: [{ provide: SharedToken, useValue: 'local-shadow' }],
          imports: [producer],
          shadowPolicy: 'error',
        })
    ).toThrow(MultipleShadowPolicyViolationsError);
  });

  it('allows shadowing with shadowPolicy allow', () => {
    const SharedToken = token('Shared');

    @Injectable({ provide: SharedToken })
    class SharedRelic {}

    const producer = new Vault({
      providers: [SharedRelic],
      exports: [SharedToken],
    });

    expect(
      () =>
        new Vault({
          providers: [{ provide: SharedToken, useValue: 'local' }],
          imports: [producer],
          shadowPolicy: 'allow',
        })
    ).not.toThrow();
  });

  it('uses error as default shadowPolicy', () => {
    const SharedToken = token('Shared');

    @Injectable({ provide: SharedToken })
    class SharedRelic {}

    const producer = new Vault({
      providers: [SharedRelic],
      exports: [SharedToken],
    });

    // Default is 'error'
    expect(
      () =>
        new Vault({
          providers: [{ provide: SharedToken, useValue: 'local-shadow' }],
          imports: [producer],
        })
    ).toThrow(MultipleShadowPolicyViolationsError);
  });
});
