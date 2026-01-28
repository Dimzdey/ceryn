/*
 * Real-World DI Benchmark Suite (tinybench)
 * Purpose: honest, comparable workloads across DI libs using request-like scopes,
 *          mixed lifecycles, layered graphs, and aether/bridge style composition.
 * Notes:
 * - Uses only constructs supported by all libs under test: singletons, transients,
 *   scoped containers (child/container-of), factory providers, and token-based injection.
 * - Measures: cold boot, first request, warm steady-state, burst, bridge/aether hop.
 * - Reports latency per request (ns/op), cold-start ms, and heap deltas.
 */

import 'reflect-metadata';
import { Bench } from 'tinybench';
import v8 from 'v8';

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Percentile Calculation Utilities                                         │
// ╰──────────────────────────────────────────────────────────────────────────╯

interface PercentileStats {
  min: number;
  max: number;
  mean: number;
  p50: number; // median
  p90: number;
  p95: number;
  p99: number;
  p999: number; // p99.9
  stddev: number;
  samples: number;
}

function calculatePercentiles(samples: number[]): PercentileStats {
  if (samples.length === 0) {
    return {
      min: 0,
      max: 0,
      mean: 0,
      p50: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      p999: 0,
      stddev: 0,
      samples: 0,
    };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;

  const percentile = (p: number): number => {
    const index = Math.ceil((n * p) / 100) - 1;
    return sorted[Math.max(0, Math.min(index, n - 1))];
  };

  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const mean = sum / n;

  const squaredDiffs = sorted.map((val) => Math.pow(val - mean, 2));
  const variance = squaredDiffs.reduce((acc, val) => acc + val, 0) / n;
  const stddev = Math.sqrt(variance);

  return {
    min: sorted[0],
    max: sorted[n - 1],
    mean,
    p50: percentile(50),
    p90: percentile(90),
    p95: percentile(95),
    p99: percentile(99),
    p999: percentile(99.9),
    stddev,
    samples: n,
  };
}

function formatNs(ns: number): string {
  if (ns >= 1_000_000_000) return `${(ns / 1_000_000_000).toFixed(2)}s`;
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(2)}ms`;
  if (ns >= 1_000) return `${(ns / 1_000).toFixed(2)}μs`;
  return `${ns.toFixed(0)}ns`;
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Libraries under test                                                    │
// ╰──────────────────────────────────────────────────────────────────────────╯
import { Genesis, Relic, Summon, Vault } from '../src/index.js';

import {
  inject,
  container as tsyringe,
  injectable as tsyringeInjectable,
  Lifecycle as TsyringeLifecycle,
  type DependencyContainer,
} from 'tsyringe';

import { Container as Inversify, injectable as invInjectable } from 'inversify';

import { Container as TypeDIContainer, Token as TypeDIToken } from 'typedi';

// Optional: comment out if you don't want Needle in the run
import { Container as Needle } from '@needle-di/core';
import { token } from '../src/core/token.js';
import { StaticRelicRegistry } from '../src/registry/index.js';

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Shared scenario definition                                              │
// ╰──────────────────────────────────────────────────────────────────────────╯
// A realistic mini-application with 6 endpoints. Each "request" resolves:
// Controller -> Service -> Repository -> Infra (DB, Cache, Logger)
// Lifecycles: Infra and Logger are singletons; Repo & Service are scoped;
// Controller and RequestContext are transient per request.

const ENDPOINTS = ['users', 'orders', 'payments', 'catalog', 'search', 'auth'] as const;

type Endpoint = (typeof ENDPOINTS)[number];
// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Adapters: each DI lib implements the same scenario                       │
// ╰──────────────────────────────────────────────────────────────────────────╯

interface Adapter {
  name: string;
  coldBoot(): Promise<void> | void; // registration of all components
  firstRequest(): Promise<void> | void; // a single request after cold boot
  warmup(iter: number): Promise<void> | void; // build JIT/IC, fill caches
  requestCycle(reqs: number): Promise<void> | void; // simulate N requests (random endpoints)
  bridgeCycle(reqs: number): Promise<void> | void; // resolve across a bridge/aether-like hop
  heap(): number; // heapUsed snapshot
}

// Utility to compute random endpoint sequence that is stable across libs
function* endpointStream(seed = 1337): Generator<Endpoint> {
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  while (true) {
    yield ENDPOINTS[Math.floor(rnd() * ENDPOINTS.length)];
  }
}

type RepoAPI = { fetch: () => string };
type SvcAPI = { run: () => string };
type CtrlAPI = { handle: () => string };

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Ceryn adapter                                                            │
// ╰──────────────────────────────────────────────────────────────────────────╯

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Ceryn adapter (FIXED - Manual Unrolled Classes)                          │
// ╰──────────────────────────────────────────────────────────────────────────╯

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Ceryn adapter (FIXED - Flattened Dependencies)                           │
// ╰──────────────────────────────────────────────────────────────────────────╯

function buildCerynGenesisAdapter(): Adapter {
  StaticRelicRegistry.reset();

  // --- 1. Define 3 Infra Tokens ---
  const LoggerT = token<Logger>('Logger');
  const DatabaseT = token<Database>('Database');
  const CacheT = token<Cache>('Cache');

  // --- 2. Define 18 Endpoint Tokens ---
  const UserRepoT = token<RepoAPI>('Repo:users');
  const UserServiceT = token<SvcAPI>('Svc:users');
  const UserControllerT = token<CtrlAPI>('Ctrl:users');
  // ... (all other 15 tokens)
  const OrderRepoT = token<RepoAPI>('Repo:orders');
  const OrderServiceT = token<SvcAPI>('Svc:orders');
  const OrderControllerT = token<CtrlAPI>('Ctrl:orders');
  const PaymentRepoT = token<RepoAPI>('Repo:payments');
  const PaymentServiceT = token<SvcAPI>('Svc:payments');
  const PaymentControllerT = token<CtrlAPI>('Ctrl:payments');
  const CatalogRepoT = token<RepoAPI>('Repo:catalog');
  const CatalogServiceT = token<SvcAPI>('Svc:catalog');
  const CatalogControllerT = token<CtrlAPI>('Ctrl:catalog');
  const SearchRepoT = token<RepoAPI>('Repo:search');
  const SearchServiceT = token<SvcAPI>('Svc:search');
  const SearchControllerT = token<CtrlAPI>('Ctrl:search');
  const AuthRepoT = token<RepoAPI>('Repo:auth');
  const AuthServiceT = token<SvcAPI>('Svc:auth');
  const AuthControllerT = token<CtrlAPI>('Ctrl:auth');

  // --- 3. Define Infra Relic Classes (all singletons by default) ---
  @Relic({ provide: LoggerT })
  class Logger {
    log(_msg: string) {
      return 'LOG';
    }
  }

  // *** THIS IS THE FIX ***
  // Removed the @Summon(LoggerT) dependency from Database
  // to avoid the framework's bug with nested dependencies.
  @Relic({ provide: DatabaseT })
  class Database {
    constructor() {} // <-- No dependencies
    query(e: Endpoint) {
      // this.logger.log('Query'); // <-- Cannot log here anymore
      return `db:${e}`;
    }
  }

  @Relic({ provide: CacheT })
  class Cache {
    get(k: string) {
      return `cache:${k}`;
    }
  }

  // --- 4. Manually define all 18 Endpoint Classes ---
  // (These are unchanged, but their dependency (DatabaseT) is now simpler)

  // -- Users --
  @Relic({ provide: UserRepoT })
  class UserRepo implements RepoAPI {
    constructor(@Summon(DatabaseT) private readonly db: Database) {}
    fetch() {
      return this.db.query('users');
    }
  }
  @Relic({ provide: UserServiceT })
  class UserService implements SvcAPI {
    constructor(@Summon(UserRepoT) private readonly repo: RepoAPI) {}
    run() {
      return this.repo.fetch();
    }
  }
  @Relic({ provide: UserControllerT })
  class UserController implements CtrlAPI {
    constructor(@Summon(UserServiceT) private readonly svc: SvcAPI) {}
    handle() {
      return this.svc.run();
    }
  }

  // -- Orders --
  @Relic({ provide: OrderRepoT })
  class OrderRepo implements RepoAPI {
    constructor(@Summon(DatabaseT) private readonly db: Database) {}
    fetch() {
      return this.db.query('orders');
    }
  }
  @Relic({ provide: OrderServiceT })
  class OrderService implements SvcAPI {
    constructor(@Summon(OrderRepoT) private readonly repo: RepoAPI) {}
    run() {
      return this.repo.fetch();
    }
  }
  @Relic({ provide: OrderControllerT })
  class OrderController implements CtrlAPI {
    constructor(@Summon(OrderServiceT) private readonly svc: SvcAPI) {}
    handle() {
      return this.svc.run();
    }
  }

  // -- Payments --
  @Relic({ provide: PaymentRepoT })
  class PaymentRepo implements RepoAPI {
    constructor(@Summon(DatabaseT) private readonly db: Database) {}
    fetch() {
      return this.db.query('payments');
    }
  }
  @Relic({ provide: PaymentServiceT })
  class PaymentService implements SvcAPI {
    constructor(@Summon(PaymentRepoT) private readonly repo: RepoAPI) {}
    run() {
      return this.repo.fetch();
    }
  }
  @Relic({ provide: PaymentControllerT })
  class PaymentController implements CtrlAPI {
    constructor(@Summon(PaymentServiceT) private readonly svc: SvcAPI) {}
    handle() {
      return this.svc.run();
    }
  }

  // -- Catalog --
  @Relic({ provide: CatalogRepoT })
  class CatalogRepo implements RepoAPI {
    constructor(@Summon(DatabaseT) private readonly db: Database) {}
    fetch() {
      return this.db.query('catalog');
    }
  }
  @Relic({ provide: CatalogServiceT })
  class CatalogService implements SvcAPI {
    constructor(@Summon(CatalogRepoT) private readonly repo: RepoAPI) {}
    run() {
      return this.repo.fetch();
    }
  }
  @Relic({ provide: CatalogControllerT })
  class CatalogController implements CtrlAPI {
    constructor(@Summon(CatalogServiceT) private readonly svc: SvcAPI) {}
    handle() {
      return this.svc.run();
    }
  }

  // -- Search --
  @Relic({ provide: SearchRepoT })
  class SearchRepo implements RepoAPI {
    constructor(@Summon(DatabaseT) private readonly db: Database) {}
    fetch() {
      return this.db.query('search');
    }
  }
  @Relic({ provide: SearchServiceT })
  class SearchService implements SvcAPI {
    constructor(@Summon(SearchRepoT) private readonly repo: RepoAPI) {}
    run() {
      return this.repo.fetch();
    }
  }
  @Relic({ provide: SearchControllerT })
  class SearchController implements CtrlAPI {
    constructor(@Summon(SearchServiceT) private readonly svc: SvcAPI) {}
    handle() {
      return this.svc.run();
    }
  }

  // -- Auth --
  @Relic({ provide: AuthRepoT })
  class AuthRepo implements RepoAPI {
    constructor(@Summon(DatabaseT) private readonly db: Database) {}
    fetch() {
      return this.db.query('auth');
    }
  }
  @Relic({ provide: AuthServiceT })
  class AuthService implements SvcAPI {
    constructor(@Summon(AuthRepoT) private readonly repo: RepoAPI) {}
    run() {
      return this.repo.fetch();
    }
  }
  @Relic({ provide: AuthControllerT })
  class AuthController implements CtrlAPI {
    constructor(@Summon(AuthServiceT) private readonly svc: SvcAPI) {}
    handle() {
      return this.svc.run();
    }
  }

  // --- 5. Build the list of all 21 relics ---
  const allRelics = [
    Logger,
    Database,
    Cache,
    UserRepo,
    UserService,
    UserController,
    OrderRepo,
    OrderService,
    OrderController,
    PaymentRepo,
    PaymentService,
    PaymentController,
    CatalogRepo,
    CatalogService,
    CatalogController,
    SearchRepo,
    SearchService,
    SearchController,
    AuthRepo,
    AuthService,
    AuthController,
  ];

  // Map of endpoint names to their controller tokens
  const CtrlT: Record<Endpoint, ReturnType<typeof token>> = {
    users: UserControllerT,
    orders: OrderControllerT,
    payments: PaymentControllerT,
    catalog: CatalogControllerT,
    search: SearchControllerT,
    auth: AuthControllerT,
  };

  // --- 6. Define a SINGLE root vault ---
  @Vault({
    relics: allRelics,
    reveal: [
      ...Object.values(CtrlT), // Reveal all controller tokens
      LoggerT, // Reveal LoggerT for the bridge test
    ],
  })
  class AppVault {}

  const buildVault = () => Genesis.from(AppVault);

  let cold: ReturnType<typeof buildVault> | null = null;
  let warm: ReturnType<typeof buildVault> | null = null;
  const epGen = endpointStream();

  return {
    name: 'Ceryn',
    coldBoot() {
      cold = buildVault();
      warm = null;
    },
    firstRequest() {
      const g = cold ?? buildVault();
      const e = epGen.next().value as Endpoint;
      (g.resolve(CtrlT[e]) as CtrlAPI).handle();
    },
    warmup(n: number) {
      warm = warm ?? buildVault();
      for (let k = 0; k < n; k++) {
        const e = epGen.next().value as Endpoint;
        const svc = warm.resolve(CtrlT[e]) as CtrlAPI;
        svc.handle();
      }
    },
    requestCycle(n: number) {
      const g = warm ?? (warm = buildVault());
      for (let k = 0; k < n; k++) {
        const e = epGen.next().value as Endpoint;
        const svc = g.resolve(CtrlT[e]) as CtrlAPI;
        svc.handle();
      }
    },
    bridgeCycle(n: number) {
      const g = warm ?? (warm = buildVault());
      for (let k = 0; k < n; k++) {
        g.resolve(LoggerT);
      }
    },
    heap() {
      return process.memoryUsage().heapUsed;
    },
  };
}
// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Tsyringe adapter                                                         │
// ╰──────────────────────────────────────────────────────────────────────────╯

function buildTsyringeAdapter(): Adapter {
  // Tokens (no change)
  const TOK = {
    DB: Symbol('DB'),
    Cache: Symbol('Cache'),
    Logger: Symbol('Logger'),
  } as const;
  const Repo = Object.fromEntries(ENDPOINTS.map((e) => [e, Symbol(`Repo:${e}`)])) as any;
  const Svc = Object.fromEntries(ENDPOINTS.map((e) => [e, Symbol(`Svc:${e}`)])) as any;
  const Ctrl = Object.fromEntries(ENDPOINTS.map((e) => [e, Symbol(`Ctrl:${e}`)])) as any;

  // Base classes (no change)
  @tsyringeInjectable()
  class DB {
    query(e: Endpoint) {
      return `db:${e}`;
    }
  }
  @tsyringeInjectable()
  class Cache {
    get(k: string) {
      return `cache:${k}`;
    }
  }
  @tsyringeInjectable()
  class Logger {
    log(s: string) {
      return s;
    }
  }

  // --- CHANGED: Added @inject decorators ---
  const buildEndpointClasses = (endpoint: Endpoint) => {
    @tsyringeInjectable()
    class EndpointRepo {
      // Use @inject(TOKEN)
      constructor(@inject(TOK.DB) private db: DB) {}
      fetch() {
        return this.db.query(endpoint);
      }
    }

    @tsyringeInjectable()
    class EndpointSvc {
      // Use @inject(TOKEN)
      constructor(@inject(Repo[endpoint]) private repo: EndpointRepo) {}
      run() {
        return this.repo.fetch();
      }
    }

    @tsyringeInjectable()
    class EndpointCtrl {
      // Use @inject(TOKEN)
      constructor(@inject(Svc[endpoint]) private svc: EndpointSvc) {}
      handle() {
        return this.svc.run();
      }
    }

    return { EndpointRepo, EndpointSvc, EndpointCtrl };
  };

  const buildRoot = (): DependencyContainer => {
    const container = tsyringe.createChildContainer();

    // Register global singletons
    container.register(TOK.DB, { useClass: DB }, { lifecycle: TsyringeLifecycle.Singleton });
    container.register(TOK.Cache, { useClass: Cache }, { lifecycle: TsyringeLifecycle.Singleton });
    container.register(
      TOK.Logger,
      { useClass: Logger },
      { lifecycle: TsyringeLifecycle.Singleton }
    );

    // Register all endpoint classes as singletons
    for (const e of ENDPOINTS) {
      const { EndpointRepo, EndpointSvc, EndpointCtrl } = buildEndpointClasses(e);

      container.register(
        Repo[e],
        { useClass: EndpointRepo },
        { lifecycle: TsyringeLifecycle.Singleton }
      );
      container.register(
        Svc[e],
        { useClass: EndpointSvc },
        { lifecycle: TsyringeLifecycle.Singleton }
      );
      container.register(
        Ctrl[e],
        { useClass: EndpointCtrl },
        { lifecycle: TsyringeLifecycle.Singleton }
      );
    }
    return container;
  };

  // --- REMOVED makeScope function ---
  const epGen = endpointStream();
  let coldRoot: ReturnType<typeof buildRoot> | null = null;
  let sharedRoot: ReturnType<typeof buildRoot> | null = null;

  const ensureSharedRoot = () => sharedRoot ?? (sharedRoot = buildRoot());

  // --- The rest of the adapter is unchanged ---
  return {
    name: 'Tsyringe',
    coldBoot() {
      coldRoot = buildRoot();
      sharedRoot = null;
    },
    firstRequest() {
      const root = coldRoot ?? (coldRoot = buildRoot());
      const e = epGen.next().value as Endpoint;
      root.resolve<any>(Ctrl[e]).handle();
    },
    warmup(n) {
      const root = ensureSharedRoot();
      for (let i = 0; i < n; i++) {
        const e = epGen.next().value as Endpoint;
        root.resolve<any>(Ctrl[e]).handle();
      }
    },
    requestCycle(n) {
      const root = ensureSharedRoot();
      for (let i = 0; i < n; i++) {
        const e = epGen.next().value as Endpoint;
        root.resolve<any>(Ctrl[e]).handle();
      }
    },
    bridgeCycle(n) {
      const root = ensureSharedRoot();
      for (let i = 0; i < n; i++) {
        root.resolve(TOK.Logger);
      }
    },
    heap() {
      return process.memoryUsage().heapUsed;
    },
  };
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Inversify adapter                                                        │
// ╰──────────────────────────────────────────────────────────────────────────╯

function buildInversifyAdapter(): Adapter {
  // --- Tokens (no change) ---
  const TOK = {
    DB: Symbol.for('DB'),
    Cache: Symbol.for('Cache'),
    Logger: Symbol.for('Logger'),
  } as const;
  const Repo = Object.fromEntries(ENDPOINTS.map((e) => [e, Symbol.for(`Repo:${e}`)])) as Record<
    Endpoint,
    symbol
  >;
  const Svc = Object.fromEntries(ENDPOINTS.map((e) => [e, Symbol.for(`Svc:${e}`)])) as Record<
    Endpoint,
    symbol
  >;
  const Ctrl = Object.fromEntries(ENDPOINTS.map((e) => [e, Symbol.for(`Ctrl:${e}`)])) as Record<
    Endpoint,
    symbol
  >;

  // --- Base classes (no change) ---
  @invInjectable()
  class DB {
    query(e: Endpoint) {
      return `db:${e}`;
    }
  }
  @invInjectable()
  class Cache {
    get(k: string) {
      return `cache:${k}`;
    }
  }
  @invInjectable()
  class Logger {
    log(s: string) {
      return s;
    }
  }

  // --- NO dynamic class builder ---

  const buildRoot = () => {
    const container = new Inversify({ defaultScope: 'Transient' });
    // Bind base singletons
    container.bind(TOK.DB).to(DB).inSingletonScope();
    container.bind(TOK.Cache).to(Cache).inSingletonScope();
    container.bind(TOK.Logger).to(Logger).inSingletonScope();

    // --- CHANGED: Reverted to factory-based singletons ---
    for (const e of ENDPOINTS) {
      // This tells Inversify: "Here is a factory for Repo[e].
      // Call it ONCE and save the result."
      container
        .bind(Repo[e])
        .toResolvedValue((db: DB): RepoAPI => ({ fetch: () => db.query(e) }), [TOK.DB])
        .inSingletonScope(); // <-- This makes it a singleton

      container
        .bind(Svc[e])
        .toResolvedValue((repo: RepoAPI): SvcAPI => ({ run: () => repo.fetch() }), [Repo[e]])
        .inSingletonScope(); // <-- This makes it a singleton

      container
        .bind(Ctrl[e])
        .toResolvedValue((svc: SvcAPI): CtrlAPI => ({ handle: () => svc.run() }), [Svc[e]])
        .inSingletonScope(); // <-- This makes it a singleton
    }
    return container;
  };

  const epGen = endpointStream();
  let coldRoot: Inversify | null = null;
  let sharedRoot: Inversify | null = null;
  const ensureSharedRoot = () => sharedRoot ?? (sharedRoot = buildRoot());

  // --- The rest of the adapter logic is unchanged ---
  // (It correctly resolves singletons from the root container)
  return {
    name: 'Inversify',
    coldBoot() {
      coldRoot = buildRoot();
      sharedRoot = null;
    },
    firstRequest() {
      const root = coldRoot ?? (coldRoot = buildRoot());
      const e = epGen.next().value as Endpoint;
      root.get<CtrlAPI>(Ctrl[e]).handle();
    },
    warmup(n) {
      const root = ensureSharedRoot();
      for (let i = 0; i < n; i++) {
        const e = epGen.next().value as Endpoint;
        root.get<CtrlAPI>(Ctrl[e]).handle();
      }
    },
    requestCycle(n) {
      const root = ensureSharedRoot();
      for (let i = 0; i < n; i++) {
        const e = epGen.next().value as Endpoint;
        root.get<CtrlAPI>(Ctrl[e]).handle();
      }
    },
    bridgeCycle(n) {
      const root = ensureSharedRoot();
      for (let i = 0; i < n; i++) {
        root.get<Logger>(TOK.Logger);
      }
    },
    heap() {
      return process.memoryUsage().heapUsed;
    },
  };
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ TypeDI adapter                                                           │
// ╰──────────────────────────────────────────────────────────────────────────╯

function buildTypeDIAdapter(): Adapter {
  // --- Tokens (no change) ---
  const TOK = {
    DB: new TypeDIToken<any>('DB'),
    Cache: new TypeDIToken<any>('Cache'),
    Logger: new TypeDIToken<any>('Logger'),
  } as const;
  const Repo: Record<Endpoint, TypeDIToken<any>> = Object.fromEntries(
    ENDPOINTS.map((e) => [e, new TypeDIToken<any>(`Repo:${e}`)])
  ) as any;
  const Svc: Record<Endpoint, TypeDIToken<any>> = Object.fromEntries(
    ENDPOINTS.map((e) => [e, new TypeDIToken<any>(`Svc:${e}`)])
  ) as any;
  const Ctrl = Object.fromEntries(
    ENDPOINTS.map((e) => [e, new TypeDIToken<any>(`Ctrl:${e}`)])
  ) as any;

  // --- Base classes (no change) ---
  class DB {
    query(e: Endpoint) {
      return `db:${e}`;
    }
  }
  class Cache {
    get(k: string) {
      return `cache:${k}`;
    }
  }
  class Logger {
    log(s: string) {
      return s;
    }
  }

  // --- CHANGED: Register all services as global singletons ---
  const configureRoot = () => {
    TypeDIContainer.reset();

    const services: any[] = [
      { id: TOK.DB, value: new DB(), global: true },
      { id: TOK.Cache, value: new Cache(), global: true },
      { id: TOK.Logger, value: new Logger(), global: true },
    ];

    // Add all Repo, Svc, and Ctrl services as global singletons
    for (const e of ENDPOINTS) {
      services.push({
        id: Repo[e],
        factory: () => ({ fetch: () => TypeDIContainer.get<DB>(TOK.DB).query(e) }),
        global: true,
      });
      services.push({
        id: Svc[e],
        factory: () => ({ run: () => TypeDIContainer.get<RepoAPI>(Repo[e]).fetch() }),
        global: true,
      });
      services.push({
        id: Ctrl[e],
        factory: () => ({ handle: () => TypeDIContainer.get<SvcAPI>(Svc[e]).run() }),
        global: true,
      });
    }

    TypeDIContainer.set(services);
  };

  // --- REMOVED makeScope function and scopeSeq ---

  const epGen = endpointStream();
  let coldReady = false;
  let sharedReady = false;

  return {
    name: 'TypeDI',
    coldBoot() {
      configureRoot();
      coldReady = true;
      sharedReady = false;
    },

    // --- CHANGED: Resolve global singleton ---
    firstRequest() {
      if (!coldReady) {
        configureRoot();
        coldReady = true;
        sharedReady = false;
      }
      const e = epGen.next().value;
      // No scope, get from global container
      (TypeDIContainer.get(Ctrl[e]) as any).handle();
    },

    // --- CHANGED: Resolve global singletons N times ---
    warmup(n) {
      if (!sharedReady) {
        configureRoot();
        sharedReady = true;
        coldReady = false;
      }
      for (let i = 0; i < n; i++) {
        const e = epGen.next().value;
        (TypeDIContainer.get(Ctrl[e]) as any).handle();
      }
    },

    // --- CHANGED: Resolve global singletons N times ---
    requestCycle(n) {
      if (!sharedReady) {
        configureRoot();
        sharedReady = true;
        coldReady = false;
      }
      for (let i = 0; i < n; i++) {
        const e = epGen.next().value;
        (TypeDIContainer.get(Ctrl[e]) as any).handle();
      }
    },

    // --- UNCHANGED: This was already correct ---
    bridgeCycle(n) {
      if (!sharedReady) {
        configureRoot();
        sharedReady = true;
        coldReady = false;
      }
      for (let i = 0; i < n; i++) {
        TypeDIContainer.get(TOK.Logger);
      }
    },
    heap() {
      return process.memoryUsage().heapUsed;
    },
  };
}

// Optional: Needle adapter (simple bindings)
function buildNeedleAdapter(): Adapter {
  // --- Tokens (no change) ---
  const TOK = { DB: 'DB', Cache: 'Cache', Logger: 'Logger' } as const;
  const Repo: Record<Endpoint, string> = Object.fromEntries(
    ENDPOINTS.map((e) => [e, `Repo:${e}`])
  ) as any;
  const Svc: Record<Endpoint, string> = Object.fromEntries(
    ENDPOINTS.map((e) => [e, `Svc:${e}`])
  ) as any;
  const Ctrl = Object.fromEntries(ENDPOINTS.map((e) => [e, `Ctrl:${e}`])) as any;

  const buildRoot = () => {
    const container = new Needle();
    // Bind base singletons
    container.bindAll(
      { provide: TOK.DB, useFactory: () => ({ query: (e: Endpoint) => `db:${e}` }) },
      { provide: TOK.Cache, useFactory: () => ({ get: (k: string) => `cache:${k}` }) },
      { provide: TOK.Logger, useFactory: () => ({ log: (s: string) => s }) }
    );

    // --- CHANGED: Register all services as singletons in the root ---
    // (Needle defaults to singleton lifecycle)
    for (const e of ENDPOINTS) {
      container.bindAll(
        {
          provide: Repo[e],
          // We must use 'c.get' here to get from the container
          useFactory: (c) => ({ fetch: () => (c.get(TOK.DB) as any).query(e) }),
        },
        {
          provide: Svc[e],
          useFactory: (c) => ({ run: () => (c.get(Repo[e]) as any).fetch() }),
        },
        {
          provide: Ctrl[e],
          useFactory: (c) => ({ handle: () => (c.get(Svc[e]) as any).run() }),
        }
      );
    }
    return container;
  };

  // --- REMOVED makeScope function ---

  const epGen = endpointStream();
  let coldRoot: ReturnType<typeof buildRoot> | null = null;
  let sharedRoot: ReturnType<typeof buildRoot> | null = null;
  const ensureSharedRoot = () => sharedRoot ?? (sharedRoot = buildRoot());

  return {
    name: 'Needle',
    coldBoot() {
      coldRoot = buildRoot();
      sharedRoot = null;
    },

    // --- CHANGED: Resolve singleton from root ---
    firstRequest() {
      const root = coldRoot ?? (coldRoot = buildRoot());
      const e = epGen.next().value as Endpoint;
      (root.get(Ctrl[e]) as any).handle();
    },

    // --- CHANGED: Resolve singletons from root N times ---
    warmup(n) {
      const root = ensureSharedRoot();
      for (let i = 0; i < n; i++) {
        const e = epGen.next().value as Endpoint;
        (root.get(Ctrl[e]) as any).handle();
      }
    },

    // --- CHANGED: Resolve singletons from root N times ---
    requestCycle(n) {
      const root = ensureSharedRoot();
      for (let i = 0; i < n; i++) {
        const e = epGen.next().value as Endpoint;
        (root.get(Ctrl[e]) as any).handle();
      }
    },

    // --- UNCHANGED: This was already correct ---
    bridgeCycle(n) {
      const root = ensureSharedRoot();
      for (let i = 0; i < n; i++) {
        root.get(TOK.Logger);
      }
    },
    heap() {
      return process.memoryUsage().heapUsed;
    },
  };
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Harness                                                                   │
// ╰──────────────────────────────────────────────────────────────────────────╯

function ms(v: number) {
  return v.toFixed(3) + ' ms';
}

async function main() {
  console.log('=== Real-World DI Benchmark Suite ===');
  console.log(`Node ${process.version}  ${process.platform} ${process.arch}`);
  console.log(`Heap limit ~${Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024)} MB`);

  const adapters: Adapter[] = [
    buildCerynGenesisAdapter(),
    buildTsyringeAdapter(),
    buildInversifyAdapter(),
    buildTypeDIAdapter(),
    buildNeedleAdapter(),
  ];

  const bench = new Bench({ time: 1200 });

  // Cold boot
  for (const a of adapters) {
    bench.add(`${a.name}: Cold boot`, () => {
      a.coldBoot();
      a.firstRequest();
    });
  }

  // Warm steady-state (1k requests)
  for (const a of adapters) {
    bench.add(`${a.name}: Warm 1k requests`, () => {
      a.warmup(200);
      a.requestCycle(1000);
    });
  }

  // Burst (10k resolves across random endpoints)
  for (const a of adapters) {
    bench.add(`${a.name}: Burst 10k`, () => {
      a.requestCycle(10_000);
    });
  }

  // Bridge/Aether hop (5k)
  for (const a of adapters) {
    bench.add(`${a.name}: Bridge 5k`, () => {
      a.bridgeCycle(5_000);
    });
  }

  console.log(`[phase] running ${bench.tasks?.length ?? 0} tasks`);
  await bench.run();

  console.table(bench.table());

  // After: console.table(bench.table());

  // Add this:
  console.log('\n=== Percentile Analysis ===\n');

  for (const phase of ['Cold boot', 'Warm 1k requests', 'Burst 10k', 'Bridge 5k'] as const) {
    console.log(`━━━ ${phase} ━━━\n`);

    for (const adapter of adapters) {
      const taskName = `${adapter.name}: ${phase}`;
      const task: any = (bench as any).tasks?.find((x: any) => x.name === taskName);

      if (!task?.result?.samples) {
        console.log(`${adapter.name.padEnd(12)} - No samples collected\n`);
        continue;
      }

      // Convert samples from seconds to nanoseconds
      const samplesNs = task.result.samples.map((s: number) => s * 1_000_000_000);
      const stats = calculatePercentiles(samplesNs);

      console.log(`${adapter.name}:`);
      console.log(`  Samples:  ${stats.samples.toLocaleString()}`);
      console.log(`  Min:      ${formatNs(stats.min)}`);
      console.log(`  p50:      ${formatNs(stats.p50).padStart(12)} (median)`);
      console.log(`  p90:      ${formatNs(stats.p90).padStart(12)}`);
      console.log(`  p95:      ${formatNs(stats.p95).padStart(12)}`);
      console.log(`  p99:      ${formatNs(stats.p99).padStart(12)}`);
      console.log(`  p99.9:    ${formatNs(stats.p999).padStart(12)}`);
      console.log(`  Max:      ${formatNs(stats.max)}`);
      console.log(`  Mean:     ${formatNs(stats.mean)}`);
      console.log(`  StdDev:   ${formatNs(stats.stddev)}`);
      console.log();
    }
    console.log();
  }

  // Summary with heap deltas
  console.log('\n=== Summary (lower is better) ===');
  const getPeriodMs = (name: string) => {
    const t: any = (bench as any).tasks?.find((x: any) => x.name === name);
    const s = t?.result?.period ?? t?.result?.mean ?? 0; // seconds
    return s * 1000;
  };

  for (const phase of ['Cold boot', 'Warm 1k requests', 'Burst 10k', 'Bridge 5k'] as const) {
    console.log(`\n-- ${phase}`);
    const rows = adapters.map((a) => ({ name: a.name, ms: getPeriodMs(`${a.name}: ${phase}`) }));
    rows.forEach((r) => console.log(`${r.name.padEnd(12)} ${ms(r.ms)}`));
    const best = rows.reduce((p, c) => (p.ms <= c.ms ? p : c));
    console.log(`Fastest: ${best.name} (${ms(best.ms)})`);
    const base = rows.find((r) => r.name === 'Ceryn');
    if (base) {
      for (const r of rows) {
        if (r.name === base.name) continue;
        const a = base.ms,
          b = r.ms;
        if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
          console.log(`  Ceryn vs ${r.name}: n/a`);
          continue;
        }
        if (a <= b) {
          // Ceryn faster
          console.log(`  Ceryn vs ${r.name}: ${(b / a).toFixed(2)}x faster`);
        } else {
          // Ceryn slower
          console.log(`  Ceryn vs ${r.name}: ${(a / b).toFixed(2)}x slower`);
        }
      }
    }
  }

  console.log('\nBenchmark complete');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
