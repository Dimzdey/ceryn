import { describe, expect, it } from 'vitest';

import { Vault } from '../src/core/vault.js';
import { InvalidModuleConfigError, MissingInjectableDecoratorError } from '../src/errors/errors.js';
import { MetadataRegistry } from '../src/registry/metadata-registry.js';

describe('Vault configuration validation', () => {
  it('rejects invalid fuse entries', () => {
    expect(() => new Vault({ imports: [null as unknown as Vault] })).toThrow(
      InvalidModuleConfigError
    );

    const notConstructor = (() => {}) as unknown as new () => void;
    expect(() => new Vault({ imports: [notConstructor] })).toThrow(InvalidModuleConfigError);
  });

  it('rejects invalid relic entries', () => {
    expect(() => new Vault({ providers: [null as never] })).toThrow(InvalidModuleConfigError);

    const badProvider = { useValue: 1 } as never;
    expect(() => new Vault({ providers: [badProvider] })).toThrow(InvalidModuleConfigError);
  });

  it('rejects reveal entries that are not tokens', () => {
    expect(() => new Vault({ exports: ['not-a-token' as never] })).toThrow(
      InvalidModuleConfigError
    );
  });

  it('ensures classes are decorated with @Injectable before registration', () => {
    class Undecorated {}
    MetadataRegistry.resetForTests();

    expect(() => new Vault({ providers: [Undecorated] })).toThrow(MissingInjectableDecoratorError);
  });
});
