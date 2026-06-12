import { beforeEach, describe, expect, it } from 'vitest';

import { Vault } from '../src/core/vault.js';
import { Module as ModuleDecorator } from '../src/decorators/index.js';
import {
  LazyFusionResolverMissingError,
  LazyResolverInvalidReturnError,
} from '../src/errors/errors.js';
import { MetadataRegistry } from '../src/registry/metadata-registry.js';

describe('Lazy import resolver errors', () => {
  beforeEach(() => {
    MetadataRegistry.resetForTests();
    Vault.setDefaultLazyResolver(undefined);
  });

  it('throws LazyFusionResolverMissingError when no resolver is available', () => {
    @ModuleDecorator()
    class LazyModule {}

    expect(() => new Vault({ imports: [LazyModule] })).toThrow(LazyFusionResolverMissingError);
  });

  it('throws LazyResolverInvalidReturnError when a custom resolver does not return a Vault', () => {
    @ModuleDecorator()
    class LazyModule {}

    expect(
      () =>
        new Vault({
          imports: [LazyModule],
          lazyResolve: () => ({}) as Vault,
        })
    ).toThrow(LazyResolverInvalidReturnError);
  });
});
