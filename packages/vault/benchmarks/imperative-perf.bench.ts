import { Bench } from 'tinybench';
import { Relic, Summon, Vault } from '../src';
import { token } from '../src/vault/token';

/**
 * Imperative Performance Benchmark (Raw Speed Style)
 *
 * Measures the fundamental speed of the core Vault mechanism with flat,
 * immediate registration, focusing on registration, instantiation, and lookup.
 */

// --- 1. Test Services (Deep Dependency Graph) ---
// This graph is intentionally deep (3 layers) but flat in registration
const loggerT = token<Logger>('Logger');
@Relic({ provide: loggerT })
class Logger {
  log(_msg: string) {
    return 'LOG';
  }
}

const configT = token<Config>('Config');
@Relic({ provide: configT })
class Config {
  getValue() {
    return 'config';
  }
}

const databaseT = token<Database>('Database');
@Relic({ provide: databaseT })
class Database {
  constructor(@Summon(loggerT) private readonly logger: Logger) {}
  query() {
    this.logger.log('Query');
    return 'data';
  }
}

const userRepositoryT = token<UserRepository>('UserRepository');
@Relic({ provide: userRepositoryT })
class UserRepository {
  constructor(@Summon(databaseT) private readonly db: Database) {}
  findUser(_id: string) {
    return this.db.query();
  }
}

const userServiceT = token<UserService>('UserService');
@Relic({ provide: userServiceT })
class UserService {
  constructor(
    @Summon(userRepositoryT) private readonly repo: UserRepository,
    @Summon(configT) private readonly config: Config,
    @Summon(loggerT) private readonly logger: Logger // Transitive Aether link
  ) {}
  getUser(id: string) {
    this.logger.log(`Getting user ${id} with ${this.config.getValue()}`);
    return this.repo.findUser(id);
  }
}

// A tiny helper to pre-warm functions (used to create warm instances)
function preWarm(fn: () => void, times = 10000) {
  for (let i = 0; i < times; i++) fn();
}

// =========================================================================
// === IMPERATIVE BENCHMARK (Raw Vault Construction)
// =========================================================================

// Vault configuration to explicitly match the decorated structure below.
const CoreVaultRelics = [Logger, Config];
const DatabaseVaultRelics = [Database];
const AppVaultRelics = [UserRepository, UserService];

/**
 * Manually constructs the three-vault hierarchy with explicit fusions and
 * exposure rules, matching the architecture of the Genesis benchmark.
 * @returns The top-level Vault (AppVault)
 */
const bootstrapImperative = () => {
  // 1. CoreVault (Aether, exposing Logger/Config)
  const coreVault = new Vault({
    relics: CoreVaultRelics,
    reveal: [loggerT, configT],
    aether: true,
    name: 'CoreVault',
  });

  // 2. DatabaseVault (Attaches Core, exposing Database)
  const databaseVault = new Vault({
    relics: DatabaseVaultRelics,
    reveal: [databaseT],
    fuse: [coreVault], // Manual fusion
    name: 'DatabaseVault',
  });

  // 3. AppVault (Attaches Core and Database, exposing UserService)
  const appVault = new Vault({
    relics: AppVaultRelics,
    reveal: [userServiceT],
    fuse: [coreVault, databaseVault],
    name: 'AppVault',
  });

  return appVault;
};

async function runImperativeBenchmark() {
  console.log(
    '=== Imperative Performance Benchmark (Raw Speed Style) - Matched Architecture ===\n'
  );

  const bench = new Bench({ time: 1000 });

  // --- Prep: Create and warm the Vault for cached resolve tests ---
  const warmAppVault = bootstrapImperative();
  preWarm(() => warmAppVault.resolve(userServiceT), 10000); // Trigger full instantiation

  console.log('[phase] warmup complete: warmAppVault instance created and resolved\n');

  bench
    // T1: Measures ONLY the cost of creating the three Vault instances and linking them.
    .add('T1: Ceryn: Bootstrap Only (Cold)', () => {
      bootstrapImperative();
    })

    // T2: Measures Bootstrap + Full Instantiation (Resolve local relic, forces cross-vault instantiation)
    .add('T2: Ceryn: Cold Start (Full Lifecycle)', () => {
      const vault = bootstrapImperative();
      vault.resolve(userServiceT);
    })

    // T3: Measures ONLY the speed of looking up the cached UserService instance (Local/AppVault)
    .add('T3: Ceryn: Warm Resolve (Cached Instance)', () => {
      warmAppVault.resolve(userServiceT);
    })

    // T4: Measures ONLY the speed of looking up the cached Logger instance (Aether/Transitive Lookup)
    .add('T4: Ceryn: Aether Resolve (Transitive)', () => {
      warmAppVault.resolve(loggerT);
    });

  console.log(`[phase] running ${bench.tasks.length} tasks...`);
  await bench.run();
  console.table(bench.table());

  // --- Detailed Analysis ---
  console.log('\n=== Performance Comparison Analysis ===\n');

  const getMs = (name: string) => {
    const task = bench.tasks.find((t) => t.name === name);
    return (task?.result?.period || 0) * 1000;
  };

  const registrationTime = getMs('T1: Ceryn: Bootstrap Only (Cold)');
  const coldResolveTime = getMs('T2: Ceryn: Cold Start (Full Lifecycle)');
  const cachedResolveTime = getMs('T3: Ceryn: Warm Resolve (Cached Instance)');

  const instantiationOverhead = coldResolveTime - registrationTime;

  console.log('Micro-Benchmark Breakdown:');
  console.log(`  Registration Cost (T1):           ${registrationTime.toFixed(3)} ms`);
  console.log(`  Instantiate Cost (T2 - T1):       ${instantiationOverhead.toFixed(3)} ms`);
  console.log(`  Total Cold Resolve (T2):          ${coldResolveTime.toFixed(3)} ms`);

  console.log('\nRuntime Lookup Performance:');
  console.log(
    `  Warm Resolve (T3):                ${(cachedResolveTime * 1_000_000).toFixed(0)} ns`
  );

  const aetherTime = getMs('T4: Ceryn: Aether Resolve (Transitive)');
  console.log(`  Aether Resolve (T4):              ${(aetherTime * 1_000_000).toFixed(0)} ns`);

  const lookupOverheadNs = (aetherTime - cachedResolveTime) * 1_000_000;
  console.log(`  Aether Lookup Overhead (T4 - T3): +${lookupOverheadNs.toFixed(0)} ns`);

  if (global.gc) {
    global.gc();
    const memBefore = process.memoryUsage().heapUsed;
    bootstrapImperative();
    global.gc();
    const memAfter = process.memoryUsage().heapUsed;
    const memUsed = (memAfter - memBefore) / 1024;
    console.log(`\nMemory Overhead (Registration): ${memUsed.toFixed(2)} KB`);
  }
}

// Ensure global.gc is revealed if memory check is desired (run with node --reveal-gc)
runImperativeBenchmark().catch(console.error);
