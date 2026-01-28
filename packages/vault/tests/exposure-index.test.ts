import { describe, expect, it } from 'vitest';

import { Vault } from '../src/core/vault.js';
import { token } from '../src/core/token.js';

describe('ExposureIndex', () => {
  it('indexes revealed and aether tokens with first-wins semantics', () => {
    const SharedToken = token('SharedService');
    const AetherToken = token('AetherService');

    const baseVault = new Vault({
      name: 'Base',
      relics: [{ provide: SharedToken, useValue: { from: 'base' } }],
      reveal: [SharedToken],
    });

    const duplicateVault = new Vault({
      name: 'Duplicate',
      relics: [{ provide: SharedToken, useValue: { from: 'duplicate' } }],
      reveal: [SharedToken],
    });

    const aetherVault = new Vault({
      name: 'Aether',
      relics: [{ provide: AetherToken, useValue: { from: 'aether' } }],
      reveal: [AetherToken],
      aether: true,
    });

    const root = new Vault({
      name: 'Root',
      fuse: [aetherVault, duplicateVault, baseVault],
    });

    const version1 = root.exposure.compute(root);
    expect(version1).toBe(1);

    const revealedEntry = root.exposure.revealedMap.get(SharedToken.id);
    expect(revealedEntry?.vault.getName()).toBe('Base');

    const aetherEntry = root.exposure.aetherMap.get(AetherToken.id);
    expect(aetherEntry?.vault.getName()).toBe('Aether');

    // Recompute to hit early-return branch
    const version2 = root.exposure.compute(root);
    expect(version2).toBe(version1);

    // Clearing resets computation state
    root.exposure.clear();
    expect(root.exposure.isComputed).toBe(false);

    const version3 = root.exposure.compute(root);
    expect(version3).toBe(version1 + 1);
  });

  it('skips missing entries and repeated pairs', () => {
    const GhostToken = token('Ghost');

    const ghostVault = new Vault({
      name: 'Ghost',
      relics: [],
      reveal: [],
    });

    ghostVault.revealedTokens.add(GhostToken.id);
    const root = new Vault({
      name: 'Root',
      fuse: [ghostVault, ghostVault],
    });

    const first = root.exposure.compute(root);
    expect(first).toBe(1);

    // Re-run to exercise early return, then clear to rescan with caches warmed
    expect(root.exposure.compute(root)).toBe(first);
    root.exposure.clear();
    expect(root.exposure.compute(root)).toBe(first + 1);
  });
});
