import { beforeEach, describe, expect, it } from 'vitest';

import { StaticRelicRegistry } from '../src/registry/static-registry.js';
import { Relic, Summon, Vault, VaultRegistry } from '../src/decorators/index.js';
import { token } from '../src/core/token.js';

describe('Decorators', () => {
  beforeEach(() => {
    StaticRelicRegistry.resetForTests();
  });

  it('@Relic registers metadata and enforces token requirement', () => {
    const provide = token('Service');

    @Relic({ provide })
    class Service {
      constructor() {}
    }

    const definition = StaticRelicRegistry.buildDefinition(Service);
    expect(definition?.metadata.name).toBe(provide.id);

    // Missing token
    expect(() => Relic({} as never)).toThrowError();
  });

  it('@Summon rejects invalid tokens', () => {
    const provide = token('SummonTarget');

    class UsesSummon {
      // eslint-disable-next-line @typescript-eslint/no-useless-constructor
      constructor(
        @Summon(provide)
        _dep?: unknown
      ) {}
    }

    expect(() => StaticRelicRegistry.buildDefinition(UsesSummon)).not.toThrow();
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error Deliberate misuse in test
      Summon('not-a-token')(UsesSummon, undefined, 0)
    ).toThrowError();
  });

  it('@Vault attaches configuration', () => {
    const provide = token('VaultRelic');

    @Relic({ provide })
    class VaultRelic {}

    @Vault({ relics: [VaultRelic] })
    class AppVault {}

    const cfg = VaultRegistry.get(AppVault);
    expect(cfg?.name).toBe('AppVault');
    expect(VaultRegistry.has(AppVault)).toBe(true);

    // beginScope is no longer attached to decorated classes
    expect((AppVault as any).beginScope).toBeUndefined();
  });
});
