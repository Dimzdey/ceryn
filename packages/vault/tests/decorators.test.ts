import { beforeEach, describe, expect, it } from 'vitest';

import { MetadataRegistry } from '../src/registry/metadata-registry.js';
import { Injectable, Inject, Module, ModuleRegistry } from '../src/decorators/index.js';
import { token } from '../src/core/token.js';

describe('Decorators', () => {
  beforeEach(() => {
    MetadataRegistry.resetForTests();
  });

  it('@Injectable registers metadata and enforces token requirement', () => {
    const provide = token('Service');

    @Injectable({ provide })
    class Service {
      constructor() {}
    }

    const definition = MetadataRegistry.buildDefinition(Service);
    expect(definition?.metadata.name).toBe(provide.id);

    // Missing token
    expect(() => Injectable({} as never)).toThrowError();
  });

  it('@Inject rejects invalid tokens', () => {
    const provide = token('InjectTarget');

    class UsesInject {
      // eslint-disable-next-line @typescript-eslint/no-useless-constructor
      constructor(
        @Inject(provide)
        _dep?: unknown
      ) {}
    }

    expect(() => MetadataRegistry.buildDefinition(UsesInject)).not.toThrow();
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error Deliberate misuse in test
      Inject('not-a-token')(UsesInject, undefined, 0)
    ).toThrowError();
  });

  it('@Module attaches configuration', () => {
    const provide = token('ModuleProvider');

    @Injectable({ provide })
    class ModuleProvider {}

    @Module({ providers: [ModuleProvider] })
    class AppModule {}

    const cfg = ModuleRegistry.get(AppModule);
    expect(cfg?.name).toBe('AppModule');
    expect(ModuleRegistry.has(AppModule)).toBe(true);

    // beginScope is no longer attached to decorated classes
    expect((AppModule as any).beginScope).toBeUndefined();
  });
});
