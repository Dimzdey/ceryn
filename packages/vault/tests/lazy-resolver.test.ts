import { beforeEach, describe, expect, it } from 'vitest';

import { token } from '../src/core/token.js';
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
    const MissingToken = token('MissingFromLazyImport');

    @ModuleDecorator()
    class LazyModule {}

    const vault = new Vault({ imports: [LazyModule] });

    expect(() => vault.canResolve(MissingToken)).toThrow(LazyFusionResolverMissingError);
  });

  it('throws LazyResolverInvalidReturnError when a custom resolver does not return a Vault', () => {
    const MissingToken = token('MissingFromInvalidLazyImport');

    @ModuleDecorator()
    class LazyModule {}

    const vault = new Vault({
      imports: [LazyModule],
      lazyResolve: () => ({}) as Vault,
    });

    expect(() => vault.canResolve(MissingToken)).toThrow(LazyResolverInvalidReturnError);
  });
});
