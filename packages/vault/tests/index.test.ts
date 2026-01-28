import { describe, expect, it } from 'vitest';

import {
  CoreVault,
  Genesis,
  Lifecycle,
  Relic,
  StaticRelicRegistry,
  Summon,
  Vault,
  VaultRegistry,
} from '../src/index.js';
import { Genesis as GenesisImpl } from '../src/api/genesis.js';
import { Lifecycle as LifecycleImpl } from '../src/types/types.js';
import { StaticRelicRegistry as RegistryImpl } from '../src/registry/static-registry.js';
import { Vault as CoreVaultImpl } from '../src/core/vault.js';
import { VaultRegistry as RegistryDecorator } from '../src/decorators/vault.js';

describe('package public index', () => {
  it('re-exports core api surface', () => {
    expect(Genesis).toBe(GenesisImpl);
    expect(Lifecycle).toBe(LifecycleImpl);
    expect(StaticRelicRegistry).toBe(RegistryImpl);
    expect(CoreVault).toBe(CoreVaultImpl);
    expect(VaultRegistry).toBe(RegistryDecorator);
    expect(typeof Relic).toBe('function');
    expect(typeof Summon).toBe('function');
    expect(typeof Vault).toBe('function');
  });
});
