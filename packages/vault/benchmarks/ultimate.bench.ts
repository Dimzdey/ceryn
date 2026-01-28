/**
 * Ultimate Benchmark Suite for @ceryn/vault (tinybench)
 * - Rewritten to use tinybench for consistent, composable microbenchmarks
 * - Adds Genesis decorator-based benchmark (inspired by genesis.bench.ts)
 * Run with: npm run bench:ultimate (or: node --loader ts-node/esm ultimate.bench.ts)
 */

// This file contains imperative benchmarks only. Decorator-based Genesis
// benchmarks live in `benchmarks/genesis.bench.ts` and run in a separate
// process to avoid shared StaticRelicRegistry mutation.

import {
  Container as NeedleContainer,
  inject as needleInject,
  injectable as needleInjectable,
} from '@needle-di/core';
import { Bench } from 'tinybench';
import v8 from 'v8';
import { Relic, Summon, Vault } from '../src/index.js';
import { token } from '../src/vault/token.js';

// Comparison libraries
import {
  Container as InversifyContainer,
  inject as inversifyInject,
  injectable as inversifyInjectable,
} from 'inversify';
import 'reflect-metadata';
import { inject, injectable, container as tsyringeContainer } from 'tsyringe';
import {
  Container as TypeDIContainer,
  Inject as TypeDIInject,
  Service as TypeDIService,
} from 'typedi';

// A tiny helper to pre-warm functions (used to create warm instances)
function preWarm(fn: () => void, times = 10000) {
  for (let i = 0; i < times; i++) fn();
}

// ============================================================================
// TEST SERVICES (kept small & compatible with original bench)
// ============================================================================

const CerynLeafT = token('CerynLeaf');
const CerynBranchT = token('CerynBranch');
const CerynRootT = token('CerynRoot');

@Relic({ provide: CerynLeafT })
class CerynLeaf {
  value = 42;
}

@Relic({ provide: CerynBranchT })
class CerynBranch {
  constructor(
    @Summon(CerynLeafT) private readonly l1: CerynLeaf,
    @Summon(CerynLeafT) private readonly l2: CerynLeaf
  ) {}
}

@Relic({ provide: CerynRootT })
class CerynRoot {
  constructor(
    @Summon(CerynBranchT) private readonly b1: CerynBranch,
    @Summon(CerynBranchT) private readonly b2: CerynBranch,
    @Summon(CerynLeafT) private readonly leaf: CerynLeaf
  ) {}
}

const LayerInfraT = token('LayerInfra');
const LayerRepositoryT = token('LayerRepository');
const LayerServiceT = token('LayerService');
const LayerControllerT = token('LayerController');

@Relic({ provide: LayerInfraT })
class LayerInfra {
  query() {
    return 'layer:data';
  }
}

@Relic({ provide: LayerRepositoryT })
class LayerRepository {
  constructor(@Summon(LayerInfraT) private readonly infra: LayerInfra) {}

  fetch() {
    return this.infra.query();
  }
}

@Relic({ provide: LayerServiceT })
class LayerService {
  constructor(@Summon(LayerRepositoryT) private readonly repo: LayerRepository) {}

  execute() {
    return this.repo.fetch();
  }
}

@Relic({ provide: LayerControllerT })
class LayerController {
  constructor(@Summon(LayerServiceT) private readonly svc: LayerService) {}

  handle() {
    return this.svc.execute();
  }
}

const AetherDatabaseT = token('AetherDatabase');
const AetherLoggerT = token('AetherLogger');
const AetherCacheT = token('AetherCache');
const AppServiceT = token('AppService');

@Relic({ provide: AetherDatabaseT })
class AetherDatabase {
  connect() {
    return 'connected';
  }
}

@Relic({ provide: AetherLoggerT })
class AetherLogger {
  log(msg: string) {
    return msg;
  }
}

@Relic({ provide: AetherCacheT })
class AetherCache {
  get(k: string) {
    return `cached:${k}`;
  }
}

@Relic({ provide: AppServiceT })
class AppService {
  constructor(
    @Summon(AetherDatabaseT) private readonly db: AetherDatabase,
    @Summon(AetherLoggerT) private readonly logger: AetherLogger,
    @Summon(AetherCacheT) private readonly cache: AetherCache
  ) {}

  execute() {
    return `${this.db.connect()},${this.logger.log('test')},${this.cache.get('key')}`;
  }
}

// Standard revealed example
const StandardDatabaseT = token('StandardDatabase');
const StandardLoggerT = token('StandardLogger');
const StandardCacheT = token('StandardCache');
const StandardAppServiceT = token('StandardAppService');

@Relic({ provide: StandardDatabaseT })
class StandardDatabase {
  connect() {
    return 'connected';
  }
}

@Relic({ provide: StandardLoggerT })
class StandardLogger {
  log(m: string) {
    return m;
  }
}

@Relic({ provide: StandardCacheT })
class StandardCache {
  get(k: string) {
    return `cached:${k}`;
  }
}

@Relic({ provide: StandardAppServiceT })
class StandardAppService {
  constructor(
    @Summon(StandardDatabaseT) private readonly db: StandardDatabase,
    @Summon(StandardLoggerT) private readonly logger: StandardLogger,
    @Summon(StandardCacheT) private readonly cache: StandardCache
  ) {}

  execute() {
    return `${this.db.connect()},${this.logger.log('test')},${this.cache.get('key')}`;
  }
}

// TSyringe services
@injectable()
class TsyringeLeaf {
  value = 42;
}

@injectable()
class TsyringeBranch {
  constructor(
    @inject(TsyringeLeaf) private readonly l1: TsyringeLeaf,
    @inject(TsyringeLeaf) private readonly l2: TsyringeLeaf
  ) {}
}

@injectable()
class TsyringeRoot {
  constructor(
    @inject(TsyringeBranch) private readonly b1: TsyringeBranch,
    @inject(TsyringeBranch) private readonly b2: TsyringeBranch,
    @inject(TsyringeLeaf) private readonly leaf: TsyringeLeaf
  ) {}
}

// Needle DI services
@needleInjectable()
class NeedleLeaf {
  value = 42;
}

@needleInjectable()
class NeedleBranch {
  private readonly leaf1: NeedleLeaf;
  private readonly leaf2: NeedleLeaf;

  constructor() {
    this.leaf1 = needleInject(NeedleLeaf);
    this.leaf2 = needleInject(NeedleLeaf);
  }
}

@needleInjectable()
class NeedleRoot {
  private readonly branch1: NeedleBranch;
  private readonly branch2: NeedleBranch;
  private readonly leaf: NeedleLeaf;

  constructor() {
    this.branch1 = needleInject(NeedleBranch);
    this.branch2 = needleInject(NeedleBranch);
    this.leaf = needleInject(NeedleLeaf);
  }
}

// InversifyJS services
const TYPES = {
  Leaf: Symbol.for('Leaf'),
  Branch: Symbol.for('Branch'),
  Root: Symbol.for('Root'),
};

@inversifyInjectable()
class InversifyLeaf {
  value = 42;
}

@inversifyInjectable()
class InversifyBranch {
  constructor(
    @inversifyInject(TYPES.Leaf) private readonly l1: InversifyLeaf,
    @inversifyInject(TYPES.Leaf) private readonly l2: InversifyLeaf
  ) {}
}

@inversifyInjectable()
class InversifyRoot {
  constructor(
    @inversifyInject(TYPES.Branch) private readonly b1: InversifyBranch,
    @inversifyInject(TYPES.Branch) private readonly b2: InversifyBranch,
    @inversifyInject(TYPES.Leaf) private readonly leaf: InversifyLeaf
  ) {}
}

// ============================================================================
// SMALL HELPERS / PREP
// ============================================================================

const standardInfraVault = new Vault({
  name: 'StandardInfra',
  relics: [StandardDatabase, StandardLogger, StandardCache],
  reveal: [StandardDatabaseT, StandardLoggerT, StandardCacheT],
});

const standardBridgeVault = new Vault({
  name: 'StandardBridge',
  fuse: [standardInfraVault],
  relics: [
    { provide: StandardDatabaseT, useFactory: () => standardInfraVault.resolve(StandardDatabaseT) },
    { provide: StandardLoggerT, useFactory: () => standardInfraVault.resolve(StandardLoggerT) },
    { provide: StandardCacheT, useFactory: () => standardInfraVault.resolve(StandardCacheT) },
  ],
  reveal: [StandardDatabaseT, StandardLoggerT, StandardCacheT],
});

const standardAppVault = new Vault({
  name: 'StandardApp',
  relics: [StandardAppService],
  fuse: [standardBridgeVault],
});

const infraVault = new Vault({
  name: 'Infrastructure',
  relics: [AetherDatabase, AetherLogger, AetherCache],
  aether: true,
});

const bridgeVault = new Vault({
  name: 'Bridge',
  fuse: [infraVault],
  relics: [],
});

const appVault = new Vault({
  name: 'App',
  relics: [AppService],
  fuse: [bridgeVault],
});

const directInfraVault = new Vault({
  name: 'DirectInfra',
  relics: [AetherDatabase, AetherLogger, AetherCache],
  reveal: [AetherDatabaseT, AetherLoggerT, AetherCacheT],
  aether: true,
});

const directAppVault = new Vault({
  name: 'DirectApp',
  relics: [AppService],
  fuse: [directInfraVault],
});

// Pre-warm frequently used containers
preWarm(() => new Vault({ relics: [CerynLeaf, CerynBranch, CerynRoot] }), 2000);

// Pre-warm app vault resolution
preWarm(() => (appVault.resolve(AppServiceT) as AppService).execute(), 2000);

// Decorator-based Genesis benchmarks were intentionally removed from this
// file to keep the benchmark process imperative and avoid clearing the
// shared StaticRelicRegistry. See `benchmarks/genesis.bench.ts` for that
// suite which runs separately.

// ============================================================================
// MAIN: tinybench tasks
// ============================================================================

async function runBenchmarks() {
  console.log('╔═══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                    ULTIMATE @CERYN/VAULT BENCHMARK SUITE (tinybench)           ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Node.js: ${process.version}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(
    `Memory: ${Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024)}MB limit`
  );
  console.log('');

  const bench = new Bench({ time: 1000 });

  // Pre-warm containers for cached resolve tests
  console.log('[phase] pre-warm: creating warmed containers (this may take a few seconds)');
  const cerynVault = new Vault({ relics: [CerynLeaf, CerynBranch, CerynRoot] });
  preWarm(() => cerynVault.resolve(CerynRootT), 10000);

  const needleContainer = new NeedleContainer();
  needleContainer.bindAll(
    { provide: NeedleLeaf, useClass: NeedleLeaf },
    { provide: NeedleBranch, useClass: NeedleBranch },
    { provide: NeedleRoot, useClass: NeedleRoot }
  );
  preWarm(() => needleContainer.get(NeedleRoot), 10000);

  const tsyringeMainContainer = tsyringeContainer.createChildContainer();
  tsyringeMainContainer.register(TsyringeLeaf, { useClass: TsyringeLeaf });
  tsyringeMainContainer.register(TsyringeBranch, { useClass: TsyringeBranch });
  tsyringeMainContainer.register(TsyringeRoot, { useClass: TsyringeRoot });
  preWarm(() => tsyringeMainContainer.resolve(TsyringeRoot), 10000);

  const inversifyMainContainer = new InversifyContainer();
  inversifyMainContainer.bind(TYPES.Leaf).to(InversifyLeaf);
  inversifyMainContainer.bind(TYPES.Branch).to(InversifyBranch);
  inversifyMainContainer.bind(TYPES.Root).to(InversifyRoot);
  preWarm(() => inversifyMainContainer.get(TYPES.Root), 10000);

  // TypeDI services setup (decorators)
  @TypeDIService()
  class TypeDILeaf {
    value = 42;
  }

  @TypeDIService()
  class TypeDIBranch {
    constructor(
      @TypeDIInject(() => TypeDILeaf) private readonly l1: any,
      @TypeDIInject(() => TypeDILeaf) private readonly l2: any
    ) {}
  }

  @TypeDIService()
  class TypeDIRoot {
    constructor(
      @TypeDIInject(() => TypeDIBranch) private readonly b1: any,
      @TypeDIInject(() => TypeDIBranch) private readonly b2: any,
      @TypeDIInject(() => TypeDILeaf) private readonly leaf: any
    ) {}
  }

  // Pre-warm TypeDI
  preWarm(() => TypeDIContainer.get(TypeDIRoot), 10000);

  console.log('[phase] pre-warm complete');

  // Registration: small graph
  console.log('[phase] registration: enqueueing registration tasks');
  bench.add('Ceryn: Register 3 services', () => {
    new Vault({ relics: [CerynLeaf, CerynBranch, CerynRoot] });
  });
  bench.add('Needle: Register 3 services', () => {
    const c = new NeedleContainer();
    c.bindAll(
      { provide: NeedleLeaf, useClass: NeedleLeaf },
      { provide: NeedleBranch, useClass: NeedleBranch },
      { provide: NeedleRoot, useClass: NeedleRoot }
    );
  });
  bench.add('TSyringe: Register 3 services', () => {
    const c = tsyringeContainer.createChildContainer();
    c.register(TsyringeLeaf, { useClass: TsyringeLeaf });
    c.register(TsyringeBranch, { useClass: TsyringeBranch });
    c.register(TsyringeRoot, { useClass: TsyringeRoot });
  });
  bench.add('InversifyJS: Register 3 services', () => {
    const c = new InversifyContainer();
    c.bind(TYPES.Leaf).to(InversifyLeaf);
    c.bind(TYPES.Branch).to(InversifyBranch);
    c.bind(TYPES.Root).to(InversifyRoot);
  });
  bench.add('TypeDI: Register 3 services', () => {
    // TypeDI uses decorators and container.get — registration is implicit via decorators
    // Clear any previous instances to simulate fresh registration
    TypeDIContainer.reset();
    TypeDIContainer.set({ id: TypeDILeaf, type: TypeDILeaf });
    TypeDIContainer.set({ id: TypeDIBranch, type: TypeDIBranch });
    TypeDIContainer.set({ id: TypeDIRoot, type: TypeDIRoot });
  });

  console.log('[phase] registration queued');

  // Resolution (cached)
  console.log('[phase] resolution (cached): enqueueing tasks');
  bench.add('Ceryn: Resolve (cached)', () => {
    const instance = cerynVault.resolve(CerynRootT);
    if (!instance) throw new Error('unreachable');
  });
  bench.add('Needle: Resolve (cached)', () => {
    const instance = needleContainer.get(NeedleRoot);
    if (!instance) throw new Error('unreachable');
  });
  bench.add('TSyringe: Resolve (cached)', () => {
    const instance = tsyringeMainContainer.resolve(TsyringeRoot);
    if (!instance) throw new Error('unreachable');
  });
  bench.add('TypeDI: Resolve (cached)', () => {
    const instance = TypeDIContainer.get(TypeDIRoot);
    if (!instance) throw new Error('unreachable');
  });
  bench.add('InversifyJS: Resolve (cached)', () => {
    const instance = inversifyMainContainer.get(TYPES.Root);
    if (!instance) throw new Error('unreachable');
  });

  console.log('[phase] resolution (cached) queued');

  // Resolution (first time)
  console.log('[phase] resolution (first time): enqueueing tasks');
  bench.add('Ceryn: Resolve (first time)', () => {
    const vault = new Vault({ relics: [CerynLeaf, CerynBranch, CerynRoot] });
    vault.resolve(CerynRootT);
  });
  bench.add('Needle: Resolve (first time)', () => {
    const c = new NeedleContainer();
    c.bindAll(
      { provide: NeedleLeaf, useClass: NeedleLeaf },
      { provide: NeedleBranch, useClass: NeedleBranch },
      { provide: NeedleRoot, useClass: NeedleRoot }
    );
    c.get(NeedleRoot);
  });

  console.log('[phase] resolution (first time) queued');

  // Layered access
  const buildLayeredVaults = (useAether: boolean) => {
    const infra = new Vault({
      name: useAether ? 'layered-infra-aether' : 'layered-infra',
      relics: [LayerInfra],
      ...(useAether ? { aether: true, reveal: [LayerInfraT] } : { reveal: [LayerInfraT] }),
    });
    const domain = new Vault({
      name: useAether ? 'layered-domain-aether' : 'layered-domain',
      fuse: [infra],
      relics: [LayerRepository, LayerService],
      reveal: [LayerServiceT],
    });
    const api = new Vault({
      name: useAether ? 'layered-api-aether' : 'layered-api',
      fuse: [domain],
      relics: [LayerController],
    });
    return api;
  };

  const layeredDefault = buildLayeredVaults(false);
  const layeredAether = buildLayeredVaults(true);
  preWarm(() => (layeredDefault.resolve(LayerControllerT) as LayerController).handle(), 2000);
  preWarm(() => (layeredAether.resolve(LayerControllerT) as LayerController).handle(), 2000);

  console.log('[phase] layered pre-warm complete');

  bench.add('Ceryn: Resolve layered (default)', () => {
    const instance = layeredDefault.resolve(LayerControllerT) as LayerController;
    if (!instance) throw new Error('unreachable');
    instance.handle();
  });
  bench.add('Ceryn: Resolve layered (aether)', () => {
    const instance = layeredAether.resolve(LayerControllerT) as LayerController;
    if (!instance) throw new Error('unreachable');
    instance.handle();
  });

  console.log('[phase] layered queued');

  // Aether cached
  bench.add('Ceryn: Aether (transitive, cached)', () => {
    const inst = appVault.resolve(AppServiceT) as AppService;
    if (!inst) throw new Error('unreachable');
    inst.execute();
  });
  bench.add('Ceryn: Aether (direct, cached)', () => {
    const inst = directAppVault.resolve(AppServiceT) as AppService;
    if (!inst) throw new Error('unreachable');
    inst.execute();
  });

  console.log('[phase] aether queued');

  // Standard revealed cached
  preWarm(
    () => (standardAppVault.resolve(StandardAppServiceT) as StandardAppService).execute(),
    2000
  );
  bench.add('Ceryn: Standard revealed (cached)', () => {
    const inst = standardAppVault.resolve(StandardAppServiceT) as StandardAppService;
    if (!inst) throw new Error('unreachable');
    inst.execute();
  });

  console.log('[phase] standard revealed queued');

  // Decorator-based Genesis benchmarks are run in `benchmarks/genesis.bench.ts`.

  // Informative estimate so the user knows the process is active
  const estimatedSec = Math.max(1, Math.ceil((bench.tasks?.length ?? 1) * 1));
  console.log(`[phase] running ${bench.tasks?.length ?? 0} tasks — estimated ~${estimatedSec}s`);

  await bench.run();

  console.table(bench.table());

  // Summary comparison
  const getMs = (name: string) => {
    const t = (bench as any).tasks?.find((x: any) => x.name === name);
    const period = t?.result?.period ?? t?.result?.mean ?? 0;
    return period * 1000;
  };

  const phases = {
    registration: [
      'Ceryn: Register 3 services',
      'Needle: Register 3 services',
      'TSyringe: Register 3 services',
      'InversifyJS: Register 3 services',
    ],
    resolveCached: [
      'Ceryn: Resolve (cached)',
      'Needle: Resolve (cached)',
      'TSyringe: Resolve (cached)',
      'InversifyJS: Resolve (cached)',
    ],
    resolveFirst: ['Ceryn: Resolve (first time)', 'Needle: Resolve (first time)'],
  };

  console.log('\n=== Summary: Ceryn vs Others (lower is better) ===');
  const printPhase = (title: string, names: string[]) => {
    console.log(`\n-- ${title}`);
    const results = names.map((n) => ({ name: n, ms: getMs(n) }));
    for (const r of results) {
      console.log(`${r.name.padEnd(35)} ${r.ms.toFixed(3)} ms`);
    }
    const best = results.reduce((a, b) => (a.ms <= b.ms ? a : b));
    console.log(`Fastest: ${best.name} (${best.ms.toFixed(3)} ms)`);
    const ceryn = results.find((r) => r.name.startsWith('Ceryn'));
    if (ceryn) {
      for (const r of results) {
        if (r.name === ceryn.name) continue;
        const ratio = r.ms === 0 ? Infinity : ceryn.ms / r.ms;
        console.log(
          '  ' +
            ceryn.name.split(':')[0] +
            ' / ' +
            r.name.split(':')[0] +
            ' = ' +
            ratio.toFixed(2) +
            'x'
        );
      }
    }
  };

  printPhase('Registration (3 services)', phases.registration);
  printPhase('Resolve (cached)', phases.resolveCached);
  printPhase('Resolve (first time)', phases.resolveFirst);

  console.log('\nBENCHMARK COMPLETE');
}
// Run the benchmark
runBenchmarks().catch(console.error);
