import { Bench } from 'tinybench';
import { Genesis, Relic, Summon, Vault, token } from '../src';

/**
 * Genesis Performance Benchmark (System Style)
 *
 * Measures the full application startup lifecycle using decorators, multi-vault
 * hierarchy, and lazy fusion creation. This captures the real-world cost
 * of using the high-level Genesis API.
 */

const LoggerT = token<Logger>('Logger');

@Relic({ provide: LoggerT })
class Logger {
  log(_msg: string) {
    return 'LOG';
  }
}

const ConfigT = token<Config>('Config');
@Relic({ provide: ConfigT })
class Config {
  getValue() {
    return 'config';
  }
}
const DatabaseT = token<Database>('Database');
@Relic({ provide: DatabaseT })
class Database {
  constructor(@Summon(LoggerT) private readonly logger: Logger) {}
  query() {
    this.logger.log('Query');
    return 'data';
  }
}

const UserRepositoryT = token<UserRepository>('UserRepository');
@Relic({ provide: UserRepositoryT })
class UserRepository {
  constructor(@Summon(DatabaseT) private readonly db: Database) {}
  findUser(_id: string) {
    return this.db.query();
  }
}
const UserServiceT = token<UserService>('UserService');
@Relic({ provide: UserServiceT })
class UserService {
  constructor(
    @Summon(UserRepositoryT) private readonly repo: UserRepository,
    @Summon(ConfigT) private readonly config: Config,
    @Summon(LoggerT) private readonly logger: Logger // Transitive Aether link
  ) {}
  getUser(id: string) {
    this.logger.log(`Getting user ${id} with ${this.config.getValue()}`);
    return this.repo.findUser(id);
  }
}
// --- 1. Test Services ---
@Vault({
  relics: [Logger, Config],
  reveal: [LoggerT, ConfigT],
  aether: true, // Services revealed to all fused vaults
})
class CoreVault {}

@Vault({
  relics: [Database],
  reveal: [DatabaseT],
  fuse: [CoreVault],
})
class DatabaseVault {}

@Vault({
  relics: [UserRepository, UserService],
  reveal: [UserServiceT],
  fuse: [CoreVault, DatabaseVault], // UserService depends on relics from both Core and Database
})
class AppVault {}

// Use reflection-based loading (no manifest) for this benchmark
const bootstrapGenesis = () => Genesis.from(AppVault);

async function runGenesisBenchmark() {
  console.log('=== Genesis Performance Benchmark (System Style) ===\n');

  const bench = new Bench({ time: 1000 });

  // Pre-warm: Create genesis once for cached/warm benchmarks
  const warmGenesis = bootstrapGenesis();
  warmGenesis.resolve(UserServiceT); // Trigger lazy fusion creation and instantiation

  console.log('[phase] warmup complete: warmGenesis instance created and resolved\n');

  bench
    // T1: Measures ONLY decorator processing and metadata assembly
    .add('T1: Genesis: Bootstrap Only (Cold)', () => {
      bootstrapGenesis();
    })

    // T2: Measures Bootstrap + Lazy Attachment Creation + Instantiation
    .add('T2: Genesis: Cold Start (Full Lifecycle)', () => {
      const genesis = bootstrapGenesis();
      genesis.resolve(UserServiceT);
    })

    // T3: Measures resolution of already-instantiated singleton
    .add('T3: Genesis: Warm Resolve (Cached Instance)', () => {
      warmGenesis.resolve(UserServiceT);
    })

    // T4: Measures Aether resolution performance
    .add('T4: Genesis: Aether Resolve (Transitive)', () => {
      warmGenesis.resolve(LoggerT);
    });

  console.log(`[phase] running ${bench.tasks.length} tasks...`);
  await bench.run();
  console.table(bench.table());

  // --- 4. Detailed Analysis ---
  console.log('\n=== Performance Breakdown Analysis ===\n');

  const getMs = (name: string) => {
    const task = bench.tasks.find((t) => t.name === name);
    return (task?.result?.period || 0) * 1000;
  };

  const bootstrapTime = getMs('T1: Genesis: Bootstrap Only (Cold)');
  const coldStartTime = getMs('T2: Genesis: Cold Start (Full Lifecycle)');
  const warmResolveTime = getMs('T3: Genesis: Warm Resolve (Cached Instance)');
  const aetherTime = getMs('T4: Genesis: Aether Resolve (Transitive)');

  const lazyAttachmentAndInstantiation = coldStartTime - bootstrapTime;
  // Estimate lazy fusion creation + direct relic instantiation cost
  const estimatedLazyLoad = lazyAttachmentAndInstantiation * 0.5; // Heuristic split

  console.log('Startup Sequence Breakdown:');
  console.log(`  1. Bootstrap (Decorator/Metadata): ${bootstrapTime.toFixed(3)} ms`);
  console.log(`  2. Lazy Attachment Creation:       ~${estimatedLazyLoad.toFixed(3)} ms`);
  console.log(
    `  3. Service Instantiation:          ~${(lazyAttachmentAndInstantiation - estimatedLazyLoad).toFixed(3)} ms`
  );
  console.log(`  Total Cold Start (Full T2):        ${coldStartTime.toFixed(3)} ms`);

  console.log('\nRuntime Performance:');
  console.log(
    `  Warm Resolve (T3):                 ${(warmResolveTime * 1_000_000).toFixed(0)} ns`
  );
  console.log(`  Aether Resolve (T4):               ${(aetherTime * 1_000_000).toFixed(0)} ns`);
  console.log(
    `  Aether Overhead (T4 vs T3):        +${((aetherTime - warmResolveTime) * 1_000_000).toFixed(0)} ns`
  );

  if (global.gc) {
    global.gc();
    const memBefore = process.memoryUsage().heapUsed;
    bootstrapGenesis();
    global.gc();
    const memAfter = process.memoryUsage().heapUsed;
    const memUsed = (memAfter - memBefore) / 1024;
    console.log(`\nMemory Overhead (Bootstrap): ${memUsed.toFixed(2)} KB`);
  }
}

// Ensure global.gc is revealed if memory check is desired (run with node --reveal-gc)
runGenesisBenchmark().catch(console.error);
