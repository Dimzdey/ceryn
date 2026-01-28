import { describe, expect, it } from 'vitest';

import { Vault } from '../src/core/vault.js';
import { InvalidVaultConfigError, MissingRelicDecoratorError } from '../src/errors/errors.js';
import { StaticRelicRegistry } from '../src/registry/static-registry.js';

describe('Vault configuration validation', () => {
  it('rejects invalid fuse entries', () => {
    expect(() => new Vault({ fuse: [null as unknown as Vault] })).toThrow(InvalidVaultConfigError);

    const notConstructor = (() => {}) as unknown as new () => void;
    expect(() => new Vault({ fuse: [notConstructor] })).toThrow(InvalidVaultConfigError);
  });

  it('rejects invalid relic entries', () => {
    expect(() => new Vault({ relics: [null as never] })).toThrow(InvalidVaultConfigError);

    const badProvider = { useValue: 1 } as never;
    expect(() => new Vault({ relics: [badProvider] })).toThrow(InvalidVaultConfigError);
  });

  it('rejects reveal entries that are not tokens', () => {
    expect(() => new Vault({ reveal: ['not-a-token' as never] })).toThrow(InvalidVaultConfigError);
  });

  it('ensures classes are decorated with @Relic before registration', () => {
    class Undecorated {}
    StaticRelicRegistry.resetForTests();

    expect(() => new Vault({ relics: [Undecorated] })).toThrow(MissingRelicDecoratorError);
  });
});
