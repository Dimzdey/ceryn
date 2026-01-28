/*
 * Scoped Lifecycle Benchmark
 * --------------------------
 * Focused micro-benchmark that compares per-request scoped lifecycles across DI
 * containers. Each adapter implements the same tiny scenario:
 *   - Singletons: Logger, Config, Database
 *   - Scoped: RequestSession, RequestService
 *   - Transient: RequestController
 * A single "request" creates a scope/child container, resolves the controller,
 * executes a method, then disposes the scope (where supported).
 *
 * Metrics captured:
 *   1) First scope (cold) — container boot + first scoped request
 *   2) Steady-state 1k scopes — create/tear down 1,000 scopes
 *
 * Run:
 *   pnpm --filter @ceryn/vault bench -- scoped-lifecycle
 *   node --loader ts-node/esm benchmarks/scoped-lifecycle.bench.ts
 */

import 'reflect-metadata';
import { Bench } from 'tinybench';
import v8 from 'v8';

import { Genesis, Lifecycle, Relic, Summon, Vault } from '../src/index.js';
import { token } from '../src/vault/token.js';

import { container as tsyringe, type DependencyContainer } from 'tsyringe';

import { Container as Needle } from '@needle-di/core';
import { Container as Inversify } from 'inversify';
import { Container as TypeDIContainer, Token as TypeDIToken } from 'typedi';
import { Host } from '../src/vault.decorator.js';

interface ScopedAdapter {
  name: string;
  reset(): void | Promise<void>;
  bootstrap(): void | Promise<void>;
  runScope(): void | Promise<void>;
  runScopeBatch?(count: number): void | Promise<void>;
}

const noop = () => {};

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Ceryn adapter - OPTIMIZED with Scope object pattern                     │
// ╰──────────────────────────────────────────────────────────────────────────╯
function buildCerynScopedAdapter(): ScopedAdapter {
  const LoggerT = token<Logger>('Logger');
  const ConfigT = token<Config>('Config');
  const DatabaseT = token<Database>('Database');
  const SessionT = token<RequestSession>('RequestSession');
  const ServiceT = token<RequestService>('RequestService');
  const ControllerT = token<RequestController>('RequestController');

  let sessionCounter = 0;

  @Relic({ provide: LoggerT })
  class Logger {
    log(message: string) {
      return message;
    }
  }

  @Relic({ provide: ConfigT })
  class Config {
    readonly prefix = 'cfg';
  }

  @Relic({ provide: DatabaseT })
  class Database {
    constructor(
      @Summon(LoggerT) private readonly logger: Logger,
      @Summon(ConfigT) private readonly config: Config
    ) {}

    query() {
      this.logger.log('query');
      return this.config.prefix;
    }
  }

  @Relic({ provide: SessionT, lifecycle: Lifecycle.Scoped })
  class RequestSession {
    readonly id = ++sessionCounter;
    dispose() {
      noop();
    }
  }

  @Relic({ provide: ServiceT, lifecycle: Lifecycle.Scoped })
  class RequestService {
    constructor(
      @Summon(SessionT) private readonly session: RequestSession,
      @Summon(DatabaseT) private readonly db: Database
    ) {}

    handle() {
      return `${this.session.id}:${this.db.query()}`;
    }
  }

  @Relic({ provide: ControllerT, lifecycle: Lifecycle.Transient })
  class RequestController {
    constructor(@Summon(ServiceT) private readonly service: RequestService) {}
    run() {
      return this.service.handle();
    }
  }

  @Vault({
    relics: [Logger, Config, Database, RequestSession, RequestService, RequestController],
    reveal: [ControllerT],
  })
  class AppVault extends Host {}

  let genesis: Genesis | null = null;

  async function disposeGenesis() {
    if (!genesis) return;
    const maybe = genesis.dispose();
    genesis = null;
    if (maybe && typeof (maybe as Promise<unknown>).then === 'function') {
      await maybe;
    }
  }

  const ensureGenesis = () => {
    if (!genesis) genesis = Genesis.from(AppVault);
    return genesis;
  };

  // OPTIMIZED: Use lightweight Scope object instead of child Vault
  function runScopeOnce() {
    const gen = ensureGenesis();
    const scope = AppVault.beginScope(); // Creates lightweight Scope object
    const controller = gen.resolve(ControllerT, { scope });
    controller.run();
    scope.disposeSync(); // Synchronous disposal (faster)
  }

  return {
    name: 'Ceryn',
    async reset() {
      sessionCounter = 0;
      await disposeGenesis();
    },
    bootstrap() {
      genesis = Genesis.from(AppVault);
    },
    runScope: () => Promise.resolve(runScopeOnce()),
    runScopeBatch(count: number) {
      // Optimized batch execution - all sync
      for (let i = 0; i < count; i++) runScopeOnce();
    },
  };
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Tsyringe adapter                                                         │
// ╰──────────────────────────────────────────────────────────────────────────╯
function buildTsyringeScopedAdapter(): ScopedAdapter {
  const TOK = {
    Logger: Symbol('TsyringeLogger'),
    Config: Symbol('TsyringeConfig'),
    Database: Symbol('TsyringeDatabase'),
    Session: Symbol('TsyringeSession'),
    Service: Symbol('TsyringeService'),
    Controller: Symbol('TsyringeController'),
  } as const;

  class Logger {
    log(message: string) {
      return message;
    }
  }
  class Config {
    readonly prefix = 'cfg';
  }
  class Database {
    constructor(
      private readonly logger: Logger,
      private readonly config: Config
    ) {}
    query() {
      this.logger.log('query');
      return this.config.prefix;
    }
  }
  class RequestSession {
    constructor(readonly id: number) {}
  }
  class RequestService {
    constructor(
      private readonly session: RequestSession,
      private readonly db: Database
    ) {}
    handle() {
      return `${this.session.id}:${this.db.query()}`;
    }
  }
  class RequestController {
    constructor(private readonly service: RequestService) {}
    run() {
      return this.service.handle();
    }
  }

  let root: DependencyContainer;
  let sessionCounter = 0;

  const registerSingletons = () => {
    root.registerInstance(TOK.Logger, new Logger());
    root.registerInstance(TOK.Config, new Config());
    root.registerInstance(
      TOK.Database,
      new Database(root.resolve(TOK.Logger), root.resolve(TOK.Config))
    );
  };

  const runScopeOnce = () => {
    const scope = root.createChildContainer();
    scope.registerInstance(TOK.Session, new RequestSession(++sessionCounter));
    scope.registerInstance(
      TOK.Service,
      new RequestService(scope.resolve(TOK.Session), scope.resolve(TOK.Database))
    );
    scope.registerInstance(TOK.Controller, new RequestController(scope.resolve(TOK.Service)));
    (scope.resolve(TOK.Controller) as RequestController).run();
    scope.reset();
  };

  return {
    name: 'Tsyringe',
    reset() {
      sessionCounter = 0;
      root = tsyringe.createChildContainer();
      registerSingletons();
    },
    bootstrap() {
      /* already registered in reset */
    },
    runScope: () => Promise.resolve(runScopeOnce()),
    runScopeBatch(count: number) {
      for (let i = 0; i < count; i++) runScopeOnce();
    },
  };
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Inversify adapter - Using hierarchical containers (parent option)       │
// ╰──────────────────────────────────────────────────────────────────────────╯
function buildInversifyScopedAdapter(): ScopedAdapter {
  const TOK = {
    Logger: Symbol.for('inv:Logger'),
    Config: Symbol.for('inv:Config'),
    Database: Symbol.for('inv:Database'),
    Session: Symbol.for('inv:Session'),
    Service: Symbol.for('inv:Service'),
    Controller: Symbol.for('inv:Controller'),
  } as const;

  class Logger {
    log(message: string) {
      return message;
    }
  }
  class Config {
    readonly prefix = 'cfg';
  }
  class Database {
    constructor(
      private readonly logger: Logger,
      private readonly config: Config
    ) {}
    query() {
      this.logger.log('query');
      return this.config.prefix;
    }
  }
  class RequestSession {
    constructor(readonly id: number) {}
  }
  class RequestService {
    constructor(
      private readonly session: RequestSession,
      private readonly db: Database
    ) {}
    handle() {
      return `${this.session.id}:${this.db.query()}`;
    }
  }
  class RequestController {
    constructor(private readonly service: RequestService) {}
    run() {
      return this.service.handle();
    }
  }

  let root: Inversify;
  let sessionCounter = 0;

  const registerSingletons = () => {
    root.bind(TOK.Logger).toConstantValue(new Logger());
    root.bind(TOK.Config).toConstantValue(new Config());
    root.bind(TOK.Database).toDynamicValue(() => {
      return new Database(root.get(TOK.Logger), root.get(TOK.Config));
    });
  };

  const runScopeOnce = async () => {
    // Inversify 6.x: Create child container with parent for hierarchical DI
    const child = new Inversify({ parent: root } as any);

    child.bind(TOK.Session).toConstantValue(new RequestSession(++sessionCounter));
    child.bind(TOK.Service).toDynamicValue(() => {
      return new RequestService(child.get(TOK.Session), child.get(TOK.Database));
    });
    child.bind(TOK.Controller).toDynamicValue(() => {
      return new RequestController(child.get(TOK.Service));
    });

    (child.get(TOK.Controller) as RequestController).run();

    // Clean up child container
    await child.unbindAll();
  };

  return {
    name: 'Inversify',
    reset() {
      sessionCounter = 0;
      root = new Inversify();
      registerSingletons();
    },
    bootstrap() {
      /* singletons registered in reset */
    },
    runScope: () => runScopeOnce(),
    async runScopeBatch(count: number) {
      for (let i = 0; i < count; i++) await runScopeOnce();
    },
  };
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ TypeDI adapter                                                           │
// ╰──────────────────────────────────────────────────────────────────────────╯
function buildTypeDIScopedAdapter(): ScopedAdapter {
  const TOK = {
    Logger: new TypeDIToken<Logger>('typed:logger'),
    Config: new TypeDIToken<Config>('typed:config'),
    Database: new TypeDIToken<Database>('typed:database'),
    Session: new TypeDIToken<RequestSession>('typed:session'),
    Service: new TypeDIToken<RequestService>('typed:service'),
    Controller: new TypeDIToken<RequestController>('typed:controller'),
  } as const;

  class Logger {
    log(message: string) {
      return message;
    }
  }
  class Config {
    readonly prefix = 'cfg';
  }
  class Database {
    constructor(
      private readonly logger: Logger,
      private readonly config: Config
    ) {}
    query() {
      this.logger.log('query');
      return this.config.prefix;
    }
  }
  class RequestSession {
    constructor(readonly id: number) {}
  }
  class RequestService {
    constructor(
      private readonly session: RequestSession,
      private readonly db: Database
    ) {}
    handle() {
      return `${this.session.id}:${this.db.query()}`;
    }
  }
  class RequestController {
    constructor(private readonly service: RequestService) {}
    run() {
      return this.service.handle();
    }
  }

  let sessionCounter = 0;

  const bootstrapSingletons = () => {
    TypeDIContainer.set(TOK.Logger, new Logger());
    TypeDIContainer.set(TOK.Config, new Config());
    TypeDIContainer.set(
      TOK.Database,
      new Database(TypeDIContainer.get(TOK.Logger), TypeDIContainer.get(TOK.Config))
    );
  };

  const runScopeOnce = () => {
    const scope = TypeDIContainer.of(undefined);
    scope.set(TOK.Session, new RequestSession(++sessionCounter));
    scope.set(
      TOK.Service,
      new RequestService(scope.get(TOK.Session), TypeDIContainer.get(TOK.Database))
    );
    scope.set(TOK.Controller, new RequestController(scope.get(TOK.Service)));
    (scope.get(TOK.Controller) as RequestController).run();
    scope.reset();
  };

  return {
    name: 'TypeDI',
    reset() {
      sessionCounter = 0;
      TypeDIContainer.reset();
      bootstrapSingletons();
    },
    bootstrap() {
      /* singletons registered in reset */
    },
    runScope: () => Promise.resolve(runScopeOnce()),
    runScopeBatch(count: number) {
      for (let i = 0; i < count; i++) runScopeOnce();
    },
  };
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Needle adapter                                                           │
// ╰──────────────────────────────────────────────────────────────────────────╯
function buildNeedleScopedAdapter(): ScopedAdapter {
  const TOK = {
    Logger: 'needle:logger',
    Config: 'needle:config',
    Database: 'needle:database',
    Session: 'needle:session',
    Service: 'needle:service',
    Controller: 'needle:controller',
  } as const;

  class Logger {
    log(message: string) {
      return message;
    }
  }
  class Config {
    readonly prefix = 'cfg';
  }
  class Database {
    constructor(
      private readonly logger: Logger,
      private readonly config: Config
    ) {}
    query() {
      this.logger.log('query');
      return this.config.prefix;
    }
  }
  class RequestSession {
    constructor(readonly id: number) {}
  }
  class RequestService {
    constructor(
      private readonly session: RequestSession,
      private readonly db: Database
    ) {}
    handle() {
      return `${this.session.id}:${this.db.query()}`;
    }
  }
  class RequestController {
    constructor(private readonly service: RequestService) {}
    run() {
      return this.service.handle();
    }
  }

  let root: Needle;
  let sessionCounter = 0;

  const registerSingletons = () => {
    root.bindAll(
      { provide: TOK.Logger, useFactory: () => new Logger() },
      { provide: TOK.Config, useFactory: () => new Config() },
      {
        provide: TOK.Database,
        useFactory: () => new Database(root.get(TOK.Logger), root.get(TOK.Config)),
      }
    );
  };

  const runScopeOnce = () => {
    const scope = new Needle(root);
    scope.bindAll(
      { provide: TOK.Session, useFactory: () => new RequestSession(++sessionCounter) },
      {
        provide: TOK.Service,
        useFactory: () =>
          new RequestService(
            scope.get<RequestSession>(TOK.Session),
            scope.get<Database>(TOK.Database)
          ),
      },
      {
        provide: TOK.Controller,
        useFactory: () => new RequestController(scope.get<RequestService>(TOK.Service)),
      }
    );
    scope.get<RequestController>(TOK.Controller).run();
    if (typeof (scope as any).dispose === 'function') (scope as any).dispose();
    else if (typeof (scope as any).clear === 'function') (scope as any).clear();
  };

  return {
    name: 'Needle',
    reset() {
      sessionCounter = 0;
      root = new Needle();
      registerSingletons();
    },
    bootstrap() {
      /* singletons registered in reset */
    },
    runScope: () => Promise.resolve(runScopeOnce()),
    runScopeBatch(count: number) {
      for (let i = 0; i < count; i++) runScopeOnce();
    },
  };
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Harness                                                                   │
// ╰──────────────────────────────────────────────────────────────────────────╯

function ms(value: number) {
  return `${value.toFixed(3)} ms`;
}

async function main() {
  console.log('=== Scoped Lifecycle Benchmark ===');
  console.log(`Node ${process.version}  ${process.platform} ${process.arch}`);
  console.log(`Heap limit ~${Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024)} MB`);

  const adapters: ScopedAdapter[] = [
    buildCerynScopedAdapter(),
    buildTsyringeScopedAdapter(),
    buildInversifyScopedAdapter(),
    buildTypeDIScopedAdapter(),
    buildNeedleScopedAdapter(),
  ];

  const bench = new Bench({ time: 1000 });

  for (const adapter of adapters) {
    bench.add(`${adapter.name}: First scope`, async () => {
      await adapter.reset();
      await adapter.bootstrap();
      await adapter.runScope();
    });
  }

  for (const adapter of adapters) {
    const runBatch = adapter.runScopeBatch
      ? adapter.runScopeBatch.bind(adapter)
      : async (count: number) => {
          for (let i = 0; i < count; i++) await adapter.runScope();
        };
    bench.add(`${adapter.name}: 1k scopes`, async () => {
      await adapter.reset();
      await adapter.bootstrap();
      await runBatch(1_000);
    });
  }

  console.log(`[phase] running ${bench.tasks?.length ?? 0} tasks`);
  await bench.run();

  console.table(bench.table());

  const getPeriodMs = (name: string) => {
    const task: any = (bench as any).tasks?.find((t: any) => t.name === name);
    if (!task?.result) return Number.NaN;
    const seconds = task.result.period ?? task.result.mean ?? 0;
    return seconds * 1000;
  };

  const phases = ['First scope', '1k scopes'] as const;
  for (const phase of phases) {
    console.log(`\n-- ${phase}`);
    const rows = adapters.map((adapter) => ({
      name: adapter.name,
      ms: getPeriodMs(`${adapter.name}: ${phase}`),
    }));
    rows.forEach((row) => console.log(`${row.name.padEnd(12)} ${ms(row.ms)}`));
    const best = rows.reduce((prev, cur) => (prev.ms <= cur.ms ? prev : cur));
    console.log(`Fastest: ${best.name} (${ms(best.ms)})`);
    const ceryn = rows.find((row) => row.name === 'Ceryn');
    if (!ceryn || !Number.isFinite(ceryn.ms) || ceryn.ms <= 0) continue;
    for (const row of rows) {
      if (row.name === 'Ceryn') continue;
      if (!Number.isFinite(row.ms) || row.ms <= 0) {
        console.log(`  Ceryn vs ${row.name}: n/a`);
        continue;
      }
      if (ceryn.ms <= row.ms) {
        console.log(`  Ceryn vs ${row.name}: ${(row.ms / ceryn.ms).toFixed(2)}x faster`);
      } else {
        console.log(`  Ceryn vs ${row.name}: ${(ceryn.ms / row.ms).toFixed(2)}x slower`);
      }
    }
  }

  console.log('\nBenchmark complete');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
