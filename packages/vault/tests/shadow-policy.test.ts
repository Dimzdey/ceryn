import { beforeEach, describe, expect, it } from 'vitest';
import { token } from '../src/core/token.js';
import { Vault } from '../src/core/vault.js';
import { Relic } from '../src/decorators/index.js';
import { MultipleShadowPolicyViolationsError } from '../src/errors/errors.js';
import { StaticRelicRegistry } from '../src/registry/static-registry.js';

beforeEach(() => {
  StaticRelicRegistry.resetForTests();
});

describe('Shadow policy enforcement', () => {
  it('throws MultipleShadowPolicyViolationsError with shadowPolicy error', () => {
    const SharedToken = token('Shared');

    @Relic({ provide: SharedToken })
    class SharedRelic {}

    const producer = new Vault({
      relics: [SharedRelic],
      reveal: [SharedToken],
    });

    // Consumer registers same token locally AND fuses the producer
    expect(
      () =>
        new Vault({
          relics: [{ provide: SharedToken, useValue: 'local-shadow' }],
          fuse: [producer],
          shadowPolicy: 'error',
        })
    ).toThrow(MultipleShadowPolicyViolationsError);
  });

  it('allows shadowing with shadowPolicy allow', () => {
    const SharedToken = token('Shared');

    @Relic({ provide: SharedToken })
    class SharedRelic {}

    const producer = new Vault({
      relics: [SharedRelic],
      reveal: [SharedToken],
    });

    expect(
      () =>
        new Vault({
          relics: [{ provide: SharedToken, useValue: 'local' }],
          fuse: [producer],
          shadowPolicy: 'allow',
        })
    ).not.toThrow();
  });

  it('uses error as default shadowPolicy', () => {
    const SharedToken = token('Shared');

    @Relic({ provide: SharedToken })
    class SharedRelic {}

    const producer = new Vault({
      relics: [SharedRelic],
      reveal: [SharedToken],
    });

    // Default is 'error'
    expect(
      () =>
        new Vault({
          relics: [{ provide: SharedToken, useValue: 'local-shadow' }],
          fuse: [producer],
        })
    ).toThrow(MultipleShadowPolicyViolationsError);
  });
});
