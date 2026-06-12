import { describe, expect, it } from 'vitest';

import {
  CoreContainer,
  CoreVault,
  Container,
  Genesis,
  Lifecycle,
  Injectable,
  Relic,
  MetadataRegistry,
  StaticRelicRegistry,
  Inject,
  Summon,
  Module,
  Vault,
  ModuleRegistry,
  VaultRegistry,
} from '../src/index.js';
import { Container as ContainerImpl } from '../src/api/container.js';
import { Lifecycle as LifecycleImpl } from '../src/types/types.js';
import { MetadataRegistry as RegistryImpl } from '../src/registry/metadata-registry.js';
import { Vault as CoreVaultImpl } from '../src/core/vault.js';
import { ModuleRegistry as RegistryDecorator } from '../src/decorators/module.js';

describe('package public index', () => {
  it('re-exports core api surface', () => {
    expect(Container).toBe(ContainerImpl);
    expect(Genesis).toBe(ContainerImpl);
    expect(Lifecycle).toBe(LifecycleImpl);
    expect(MetadataRegistry).toBe(RegistryImpl);
    expect(StaticRelicRegistry).toBe(RegistryImpl);
    expect(CoreContainer).toBe(CoreVaultImpl);
    expect(CoreVault).toBe(CoreVaultImpl);
    expect(ModuleRegistry).toBe(RegistryDecorator);
    expect(VaultRegistry).toBe(RegistryDecorator);
    expect(typeof Injectable).toBe('function');
    expect(typeof Relic).toBe('function');
    expect(typeof Inject).toBe('function');
    expect(typeof Summon).toBe('function');
    expect(typeof Module).toBe('function');
    expect(typeof Vault).toBe('function');
  });

  it('keeps current root exports available', async () => {
    const api = await import('../src/index.js');
    expect(api.Container).toBeDefined();
    expect(api.Injectable).toBeDefined();
    expect(api.Inject).toBeDefined();
    expect(api.Module).toBeDefined();
    expect(api.Lifecycle).toBeDefined();
  });

  it('exposes legacy aliases from compat subpath source', async () => {
    const compat = await import('../src/compat.js');
    expect(compat.Genesis).toBeDefined();
    expect(compat.Relic).toBeDefined();
    expect(compat.Summon).toBeDefined();
  });
});
