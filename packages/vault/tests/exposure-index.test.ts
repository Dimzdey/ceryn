import { describe, expect, it } from 'vitest';

import { token } from '../src/core/token.js';
import { Vault } from '../src/core/vault.js';
import { CircularModuleAttachmentError, InvalidModuleConfigError } from '../src/errors/errors.js';

describe('ExposureIndex', () => {
  it('indexes revealed and aether tokens with first-wins semantics', () => {
    const SharedToken = token('SharedService');
    const AetherToken = token('AetherService');

    const baseVault = new Vault({
      name: 'Base',
      providers: [{ provide: SharedToken, useValue: { from: 'base' } }],
      exports: [SharedToken],
    });

    const duplicateVault = new Vault({
      name: 'Duplicate',
      providers: [{ provide: SharedToken, useValue: { from: 'duplicate' } }],
      exports: [SharedToken],
    });

    const aetherVault = new Vault({
      name: 'Aether',
      providers: [{ provide: AetherToken, useValue: { from: 'aether' } }],
      exports: [AetherToken],
      global: true,
    });

    const root = new Vault({
      name: 'Root',
      imports: [aetherVault, duplicateVault, baseVault],
      shadowPolicy: 'allow',
    });

    const version1 = root.exposure.compute(root);
    expect(version1).toBe(1);

    const revealedEntry = root.exposure.exportedMap.get(SharedToken.id);
    expect(revealedEntry?.vault.getName()).toBe('Base');

    const aetherEntry = root.exposure.globalMap.get(AetherToken.id);
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
      providers: [],
      exports: [],
    });

    ghostVault.exportedTokens.add(GhostToken.id);
    const root = new Vault({
      name: 'Root',
      imports: [ghostVault, ghostVault],
    });

    const first = root.exposure.compute(root);
    expect(first).toBe(1);

    // Re-run to exercise early return, then clear to rescan with caches warmed
    expect(root.exposure.compute(root)).toBe(first);
    root.exposure.clear();
    expect(root.exposure.compute(root)).toBe(first + 1);
  });

  it('exposes all local providers from global vaults to importing descendants', () => {
    const ExportedToken = token('ExportedGlobal');
    const UnexportedGlobalToken = token('UnexportedGlobal');
    const exportedValue = { from: 'exported-global' };
    const unexportedGlobalValue = { from: 'unexported-global' };

    const globalVault = new Vault({
      name: 'GlobalVault',
      providers: [
        { provide: ExportedToken, useValue: exportedValue },
        { provide: UnexportedGlobalToken, useValue: unexportedGlobalValue },
      ],
      exports: [ExportedToken],
      global: true,
    });

    const root = new Vault({
      name: 'Root',
      imports: [globalVault],
    });

    expect(root.canResolve(ExportedToken)).toBe(true);
    expect(root.canResolve(UnexportedGlobalToken)).toBe(true);
    expect(root.resolve(UnexportedGlobalToken)).toBe(unexportedGlobalValue);
  });

  it('preserves producer aliases for direct explicit exports', () => {
    const ExportedToken = token<string>('AliasedExplicitExport');
    const AliasToken = token<string>('ExplicitExportAlias');
    const producer = new Vault({
      providers: [{ provide: ExportedToken, useValue: 'aliased-export' }],
      exports: [ExportedToken],
    });
    const entry = producer.store.getByCanonical(ExportedToken.id);
    if (!entry) throw new Error('expected exported provider entry');
    entry.aliases = [AliasToken.id];

    const root = new Vault({ imports: [producer] });

    expect(root.resolve(AliasToken)).toBe('aliased-export');
  });

  it('builds parent global exposure from direct import summaries only', () => {
    const GlobalToken = token<string>('SummarizedGlobal');
    const globalVault = new Vault({
      providers: [{ provide: GlobalToken, useValue: 'global' }],
      global: true,
    });
    const middle = new Vault({ imports: [globalVault] });
    const descriptor = Object.getOwnPropertyDescriptor(middle, 'importedModules');
    Object.defineProperty(middle, 'importedModules', {
      configurable: true,
      get: () => {
        throw new Error('parent traversed a descendant import list');
      },
    });

    let root: Vault | undefined;
    try {
      root = new Vault({ imports: [middle] });
    } finally {
      if (descriptor) Object.defineProperty(middle, 'importedModules', descriptor);
    }

    expect(root?.resolve(GlobalToken)).toBe('global');
  });

  it('refreshes a child summary after public importedModules mutation', () => {
    const GlobalToken = token<string>('MutatedSummaryGlobal');
    const middle = new Vault();
    const root = new Vault({ imports: [middle] });
    const globalVault = new Vault({
      providers: [{ provide: GlobalToken, useValue: 'mutated-global' }],
      global: true,
    });

    middle.importedModules.push(globalVault);
    root.exposure.clear();
    root.exposure.compute(root);

    expect(root.resolve(GlobalToken)).toBe('mutated-global');
  });

  it('detects structural import mutations when explicitly recomputed', () => {
    const FirstToken = token('SnapshotMutationFirst');
    const SecondToken = token('SnapshotMutationSecond');
    const first = new Vault({
      providers: [{ provide: FirstToken, useValue: 'first' }],
      global: true,
    });
    const second = new Vault({
      providers: [{ provide: SecondToken, useValue: 'second' }],
      global: true,
    });
    const vault = new Vault({ imports: [first] });
    const imports = vault.importedModules;
    let version = vault.exposure.stamp;

    expect(Array.isArray(imports)).toBe(true);
    expect([...imports]).toEqual([first]);
    expect(vault.exposure.globalMap.has(FirstToken.id)).toBe(true);

    imports[0] = first;
    expect(vault.exposure.isComputed).toBe(true);
    expect(vault.exposure.compute(vault)).toBe(version);

    imports[0] = second;
    expect(vault.exposure.isComputed).toBe(true);
    expect(vault.exposure.compute(vault)).toBe(++version);
    expect(vault.exposure.globalMap.has(FirstToken.id)).toBe(false);
    expect(vault.exposure.globalMap.has(SecondToken.id)).toBe(true);

    imports.push(first);
    expect(vault.exposure.isComputed).toBe(true);
    expect(vault.exposure.compute(vault)).toBe(++version);
    expect(vault.exposure.globalMap.has(FirstToken.id)).toBe(true);

    imports.length = 1;
    expect(vault.exposure.isComputed).toBe(true);
    expect(vault.exposure.compute(vault)).toBe(++version);
    expect(vault.exposure.globalMap.has(FirstToken.id)).toBe(false);

    imports.push(first);
    expect(vault.exposure.compute(vault)).toBe(++version);

    delete imports[1];
    expect(vault.exposure.isComputed).toBe(true);
    expect(vault.exposure.compute(vault)).toBe(++version);
    expect(vault.exposure.globalMap.has(FirstToken.id)).toBe(false);
  });

  it('detects defineProperty index and length changes when explicitly recomputed', () => {
    const FirstToken = token('SnapshotDefineFirst');
    const SecondToken = token('SnapshotDefineSecond');
    const first = new Vault({
      providers: [{ provide: FirstToken, useValue: 'first' }],
      global: true,
    });
    const second = new Vault({
      providers: [{ provide: SecondToken, useValue: 'second' }],
      global: true,
    });
    const vault = new Vault({ imports: [first] });
    const imports = vault.importedModules;
    let version = vault.exposure.stamp;

    Object.defineProperty(imports, '0', {
      configurable: true,
      enumerable: true,
      value: second,
      writable: true,
    });
    expect(vault.exposure.isComputed).toBe(true);
    expect(vault.exposure.compute(vault)).toBe(++version);
    expect(vault.exposure.globalMap.has(FirstToken.id)).toBe(false);
    expect(vault.exposure.globalMap.has(SecondToken.id)).toBe(true);

    Object.defineProperty(imports, 'length', { value: 0 });
    expect(vault.exposure.isComputed).toBe(true);
    expect(vault.exposure.compute(vault)).toBe(++version);
    expect(vault.exposure.globalMap.size).toBe(0);
  });

  it('reports a named cycle during explicit summary recomputation and resets its guard', () => {
    const first = new Vault({ name: 'MutationCycleFirst' });
    const second = new Vault({ name: 'MutationCycleSecond' });
    first.importedModules.push(second);
    second.importedModules.push(first);

    first.exposure.clear();
    let caught: unknown;
    try {
      first.exposure.compute(first);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CircularModuleAttachmentError);
    expect((caught as CircularModuleAttachmentError).cycle).toEqual([
      'MutationCycleFirst',
      'MutationCycleSecond',
      'MutationCycleFirst',
    ]);

    second.importedModules.length = 0;
    first.exposure.clear();

    expect(() => first.exposure.compute(first)).not.toThrow();
  });

  it('discards partial exposure state before retrying a failed computation', () => {
    const RemovedToken = token('RemovedAfterFailedExposureCompute');
    const removedImport = new Vault({
      providers: [{ provide: RemovedToken, useValue: 'removed' }],
      global: true,
    });
    const cyclicFirst = new Vault({ name: 'RetryCycleFirst' });
    const cyclicSecond = new Vault({ name: 'RetryCycleSecond' });
    cyclicFirst.importedModules.push(cyclicSecond);
    cyclicSecond.importedModules.push(cyclicFirst);
    cyclicFirst.exposure.clear();
    cyclicSecond.exposure.clear();

    const root = new Vault();
    root.importedModules.push(cyclicFirst, removedImport);
    root.exposure.clear();

    expect(() => root.exposure.compute(root)).toThrow(CircularModuleAttachmentError);

    cyclicSecond.importedModules.length = 0;
    root.importedModules.pop();
    root.exposure.compute(root);

    expect(root.exposure.globalMap.has(RemovedToken.id)).toBe(false);
  });

  it('preserves duplicate global exposure from a direct import summary', () => {
    const SharedToken = token('SummarizedDuplicateGlobal');
    const first = new Vault({
      name: 'FirstSummarizedGlobal',
      providers: [{ provide: SharedToken, useValue: 'first' }],
      global: true,
    });
    const second = new Vault({
      name: 'SecondSummarizedGlobal',
      providers: [{ provide: SharedToken, useValue: 'second' }],
      global: true,
    });
    const middle = new Vault({
      imports: [first, second],
      shadowPolicy: 'allow',
    });

    expect(() => new Vault({ imports: [middle] })).toThrow(InvalidModuleConfigError);
  });

  it('rejects ambiguous imported exports by default', () => {
    const SharedToken = token('AmbiguousImport');

    const first = new Vault({
      name: 'FirstImport',
      providers: [{ provide: SharedToken, useValue: 'first' }],
      exports: [SharedToken],
    });
    const second = new Vault({
      name: 'SecondImport',
      providers: [{ provide: SharedToken, useValue: 'second' }],
      exports: [SharedToken],
    });

    expect(() => new Vault({ name: 'Root', imports: [first, second] })).toThrow(
      InvalidModuleConfigError
    );
  });

  it('allows ambiguous imported exports when shadowPolicy is allow', () => {
    const SharedToken = token('AllowedAmbiguousImport');

    const first = new Vault({
      name: 'FirstAllowedImport',
      providers: [{ provide: SharedToken, useValue: 'first' }],
      exports: [SharedToken],
    });
    const second = new Vault({
      name: 'SecondAllowedImport',
      providers: [{ provide: SharedToken, useValue: 'second' }],
      exports: [SharedToken],
    });

    expect(
      () => new Vault({ name: 'Root', imports: [first, second], shadowPolicy: 'allow' })
    ).not.toThrow();
  });
});
