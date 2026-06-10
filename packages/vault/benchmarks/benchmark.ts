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

import { Container, Injectable, Inject, Module, Lifecycle } from '../src/index.js';
import { token } from '../src/core/token.js';
import { MetadataRegistry } from '../src/registry/index.js';

import {
  inject,
  container as tsyringe,
  injectable as tsyringeInjectable,
  Lifecycle as TsyringeLifecycle,
  type DependencyContainer,
} from 'tsyringe';

import { Container as Inversify, injectable as invInjectable } from 'inversify';
import { Container as TypeDIContainer, Token as TypeDIToken } from 'typedi';
import { Container as Needle } from '@needle-di/core';

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Percentile Calculation Utilities                                         │
// ╰──────────────────────────────────────────────────────────────────────────╯

interface PercentileStats {
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  p999: number;
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
// │ Shared scenario definition                                              │
// ╰──────────────────────────────────────────────────────────────────────────╯

const ENDPOINTS = ['users', 'orders', 'payments', 'catalog', 'search', 'auth'] as const;
type Endpoint = (typeof ENDPOINTS)[number];

interface Adapter {
  name: string;
  coldBoot(): Promise<void> | void;
  firstRequest(): Promise<void> | void;
  warmup(iter: number): Promise<void> | void;
  requestCycle(reqs: number): Promise<void> | void;
  bridgeCycle(reqs: number): Promise<void> | void;
  scopedCycle?(reqs: number): Promise<void> | void;
  asyncFactoryCycle?(reqs: number): Promise<void> | void;
  heap(): number;
}

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
// │ Ceryn adapter                                                           │
// ╰──────────────────────────────────────────────────────────────────────────╯

function buildCerynAdapter(): Adapter {
  MetadataRegistry.reset();

  const LoggerT = token<Logger>('Logger');
  const DatabaseT = token<Database>('Database');
  const CacheT = token<Cache>('Cache');

  const UserRepoT = token<RepoAPI>('Repo:users');
  const UserServiceT = token<SvcAPI>('Svc:users');
  const UserControllerT = token<CtrlAPI>('Ctrl:users');
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

  @Injectable({ provide: LoggerT })
  class Logger {
    log(_msg: string) {
      return 'LOG';
    }
  }

  @Injectable({ provide: DatabaseT })
  class Database {
    constructor(@Inject(LoggerT) private readonly logger: Logger) {}
    query(e: Endpoint) {
      this.logger.log('Query');
      return `db:${e}`;
    }
  }

  @Injectable({ provide: CacheT })
  class Cache {
    get(k: string) {
      return `cache:${k}`;
    }
  }

  @Injectable({ provide: UserRepoT })
  class UserRepo implements RepoAPI {
    constructor(@Inject(DatabaseT) private readonly db: Database) {}
    fetch() {
      return this.db.query('users');
    }
  }
  @Injectable({ provide: UserServiceT })
  class UserService implements SvcAPI {
    constructor(@Inject(UserRepoT) private readonly repo: RepoAPI) {}
    run() {
      return this.repo.fetch();
    }
  }
  @Injectable({ provide: UserControllerT })
  class UserController implements CtrlAPI {
    constructor(@Inject(UserServiceT) private readonly svc: SvcAPI) {}
    handle() {
      return this.svc.run();
    }
  }

  @Injectable({ provide: OrderRepoT })
  class OrderRepo implements RepoAPI {
    constructor(@Inject(DatabaseT) private readonly db: Database) {}
    fetch() {
      return this.db.query('orders');
    }
  }
  @Injectable({ provide: OrderServiceT })
  class OrderService implements SvcAPI {
    constructor(@Inject(OrderRepoT) private readonly repo: RepoAPI) {}
    run() {
      return this.repo.fetch();
    }
  }
  @Injectable({ provide: OrderControllerT })
  class OrderController implements CtrlAPI {
    constructor(@Inject(OrderServiceT) private readonly svc: SvcAPI) {}
    handle() {
      return this.svc.run();
    }
  }

  @Injectable({ provide: PaymentRepoT })
  class PaymentRepo implements RepoAPI {
    constructor(@Inject(DatabaseT) private readonly db: Database) {}
    fetch() {
      return this.db.query('payments');
    }
  }
  @Injectable({ provide: PaymentServiceT })
  class PaymentService implements SvcAPI {
    constructor(@Inject(PaymentRepoT) private readonly repo: RepoAPI) {}
    run() {
      return this.repo.fetch();
    }
  }
  @Injectable({ provide: PaymentControllerT })
  class PaymentController implements CtrlAPI {
    constructor(@Inject(PaymentServiceT) private readonly svc: SvcAPI) {}
    handle() {
      return this.svc.run();
    }
  }

  @Injectable({ provide: CatalogRepoT })
  class CatalogRepo implements RepoAPI {
    constructor(@Inject(DatabaseT) private readonly db: Database) {}
    fetch() {
      return this.db.query('catalog');
    }
  }
  @Injectable({ provide: CatalogServiceT })
  class CatalogService implements SvcAPI {
    constructor(@Inject(CatalogRepoT) private readonly repo: RepoAPI) {}
    run() {
      return this.repo.fetch();
    }
  }
  @Injectable({ provide: CatalogControllerT })
  class CatalogController implements CtrlAPI {
    constructor(@Inject(CatalogServiceT) private readonly svc: SvcAPI) {}
    handle() {
      return this.svc.run();
    }
  }

  @Injectable({ provide: SearchRepoT })
  class SearchRepo implements RepoAPI {
    constructor(@Inject(DatabaseT) private readonly db: Database) {}
    fetch() {
      return this.db.query('search');
    }
  }
  @Injectable({ provide: SearchServiceT })
  class SearchService implements SvcAPI {
    constructor(@Inject(SearchRepoT) private readonly repo: RepoAPI) {}
    run() {
      return this.repo.fetch();
    }
  }
  @Injectable({ provide: SearchControllerT })
  class SearchController implements CtrlAPI {
    constructor(@Inject(SearchServiceT) private readonly svc: SvcAPI) {}
    handle() {
      return this.svc.run();
    }
  }

  @Injectable({ provide: AuthRepoT })
  class AuthRepo implements RepoAPI {
    constructor(@Inject(DatabaseT) private readonly db: Database) {}
    fetch() {
      return this.db.query('auth');
    }
  }
  @Injectable({ provide: AuthServiceT })
  class AuthService implements SvcAPI {
    constructor(@Inject(AuthRepoT) private readonly repo: RepoAPI) {}
    run() {
      return this.repo.fetch();
    }
  }
  @Injectable({ provide: AuthControllerT })
  class AuthController implements CtrlAPI {
    constructor(@Inject(AuthServiceT) private readonly svc: SvcAPI) {}
    handle() {
      return this.svc.run();
    }
  }

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

  const CtrlT: Record<Endpoint, ReturnType<typeof token>> = {
    users: UserControllerT,
    orders: OrderControllerT,
    payments: PaymentControllerT,
    catalog: CatalogControllerT,
    search: SearchControllerT,
    auth: AuthControllerT,
  };

  // Scoped lifecycle tokens and classes
  const RequestIdT = token<string>('RequestId');
  const ScopedServiceT = token<{ id: string }>('ScopedService');

  @Injectable({ provide: ScopedServiceT, lifecycle: Lifecycle.Scoped })
  class ScopedService {
    constructor(@Inject(RequestIdT) public readonly id: string) {}
  }

  // Async factory token
  const AsyncDbT = token<{ connection: string }>('AsyncDb');

  @Module({
    providers: [
      ...allRelics,
      ScopedService,
      {
        provide: AsyncDbT,
        useFactory: async () => {
          // Simulate async connection setup
          return { connection: 'pg://localhost/bench' };
        },
        lifecycle: Lifecycle.Singleton,
      },
    ],
    exports: [...Object.values(CtrlT), LoggerT, ScopedServiceT, AsyncDbT],
    shadowPolicy: 'allow',
  })
  class FullAppVault {}

  const buildVault = () => Container.from(FullAppVault);

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
        (warm.resolve(CtrlT[e]) as CtrlAPI).handle();
      }
    },
    requestCycle(n: number) {
      const g = warm ?? (warm = buildVault());
      for (let k = 0; k < n; k++) {
        const e = epGen.next().value as Endpoint;
        (g.resolve(CtrlT[e]) as CtrlAPI).handle();
      }
    },
    bridgeCycle(n: number) {
      const g = warm ?? (warm = buildVault());
      for (let k = 0; k < n; k++) {
        g.resolve(LoggerT);
      }
    },
    scopedCycle(n: number) {
      const g = warm ?? (warm = buildVault());
      for (let k = 0; k < n; k++) {
        const scope = g.createScope();
        scope.provide(RequestIdT, `req-${k}`);
        void (scope.resolve(ScopedServiceT) as { id: string }).id;
        scope.disposeSync();
      }
    },
    async asyncFactoryCycle(n: number) {
      const g = warm ?? (warm = buildVault());
      for (let k = 0; k < n; k++) {
        await g.resolveAsync(AsyncDbT);
      }
    },
    heap() {
      return process.memoryUsage().heapUsed;
    },
  };
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Tsyringe adapter                                                        │
// ╰──────────────────────────────────────────────────────────────────────────╯

function buildTsyringeAdapter(): Adapter {
  const TOK = {
    DB: Symbol('DB'),
    Cache: Symbol('Cache'),
    Logger: Symbol('Logger'),
  } as const;
  const Repo = Object.fromEntries(ENDPOINTS.map((e) => [e, Symbol(`Repo:${e}`)])) as any;
  const Svc = Object.fromEntries(ENDPOINTS.map((e) => [e, Symbol(`Svc:${e}`)])) as any;
  const Ctrl = Object.fromEntries(ENDPOINTS.map((e) => [e, Symbol(`Ctrl:${e}`)])) as any;

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

  const buildEndpointClasses = (endpoint: Endpoint) => {
    @tsyringeInjectable()
    class EndpointRepo {
      constructor(@inject(TOK.DB) private db: DB) {}
      fetch() {
        return this.db.query(endpoint);
      }
    }

    @tsyringeInjectable()
    class EndpointSvc {
      constructor(@inject(Repo[endpoint]) private repo: EndpointRepo) {}
      run() {
        return this.repo.fetch();
      }
    }

    @tsyringeInjectable()
    class EndpointCtrl {
      constructor(@inject(Svc[endpoint]) private svc: EndpointSvc) {}
      handle() {
        return this.svc.run();
      }
    }

    return { EndpointRepo, EndpointSvc, EndpointCtrl };
  };

  const buildRoot = (): DependencyContainer => {
    const container = tsyringe.createChildContainer();
    container.register(TOK.DB, { useClass: DB }, { lifecycle: TsyringeLifecycle.Singleton });
    container.register(TOK.Cache, { useClass: Cache }, { lifecycle: TsyringeLifecycle.Singleton });
    container.register(
      TOK.Logger,
      { useClass: Logger },
      { lifecycle: TsyringeLifecycle.Singleton }
    );

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

  const epGen = endpointStream();
  let coldRoot: ReturnType<typeof buildRoot> | null = null;
  let sharedRoot: ReturnType<typeof buildRoot> | null = null;
  const ensureSharedRoot = () => sharedRoot ?? (sharedRoot = buildRoot());

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
    scopedCycle(n) {
      const root = ensureSharedRoot();
      for (let i = 0; i < n; i++) {
        const child = root.createChildContainer();
        child.register('RequestId', { useValue: `req-${i}` });
        child.resolve<any>(TOK.Logger); // resolve something from child
        child.reset();
      }
    },
    heap() {
      return process.memoryUsage().heapUsed;
    },
  };
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Inversify adapter                                                       │
// ╰──────────────────────────────────────────────────────────────────────────╯

function buildInversifyAdapter(): Adapter {
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

  const buildRoot = () => {
    const container = new Inversify({ defaultScope: 'Transient' });
    container.bind(TOK.DB).to(DB).inSingletonScope();
    container.bind(TOK.Cache).to(Cache).inSingletonScope();
    container.bind(TOK.Logger).to(Logger).inSingletonScope();

    for (const e of ENDPOINTS) {
      container
        .bind(Repo[e])
        .toResolvedValue((db: DB): RepoAPI => ({ fetch: () => db.query(e) }), [TOK.DB])
        .inSingletonScope();
      container
        .bind(Svc[e])
        .toResolvedValue((repo: RepoAPI): SvcAPI => ({ run: () => repo.fetch() }), [Repo[e]])
        .inSingletonScope();
      container
        .bind(Ctrl[e])
        .toResolvedValue((svc: SvcAPI): CtrlAPI => ({ handle: () => svc.run() }), [Svc[e]])
        .inSingletonScope();
    }
    return container;
  };

  const epGen = endpointStream();
  let coldRoot: Inversify | null = null;
  let sharedRoot: Inversify | null = null;
  const ensureSharedRoot = () => sharedRoot ?? (sharedRoot = buildRoot());

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
// │ TypeDI adapter                                                          │
// ╰──────────────────────────────────────────────────────────────────────────╯

function buildTypeDIAdapter(): Adapter {
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

  const configureRoot = () => {
    TypeDIContainer.reset();

    const services: any[] = [
      { id: TOK.DB, value: new DB(), global: true },
      { id: TOK.Cache, value: new Cache(), global: true },
      { id: TOK.Logger, value: new Logger(), global: true },
    ];

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
    firstRequest() {
      if (!coldReady) {
        configureRoot();
        coldReady = true;
        sharedReady = false;
      }
      const e = epGen.next().value;
      (TypeDIContainer.get(Ctrl[e]) as any).handle();
    },
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

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Needle adapter                                                          │
// ╰──────────────────────────────────────────────────────────────────────────╯

function buildNeedleAdapter(): Adapter {
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
    container.bindAll(
      { provide: TOK.DB, useFactory: () => ({ query: (e: Endpoint) => `db:${e}` }) },
      { provide: TOK.Cache, useFactory: () => ({ get: (k: string) => `cache:${k}` }) },
      { provide: TOK.Logger, useFactory: () => ({ log: (s: string) => s }) }
    );

    for (const e of ENDPOINTS) {
      container.bindAll(
        { provide: Repo[e], useFactory: (c) => ({ fetch: () => (c.get(TOK.DB) as any).query(e) }) },
        { provide: Svc[e], useFactory: (c) => ({ run: () => (c.get(Repo[e]) as any).fetch() }) },
        { provide: Ctrl[e], useFactory: (c) => ({ handle: () => (c.get(Svc[e]) as any).run() }) }
      );
    }
    return container;
  };

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
    firstRequest() {
      const root = coldRoot ?? (coldRoot = buildRoot());
      const e = epGen.next().value as Endpoint;
      (root.get(Ctrl[e]) as any).handle();
    },
    warmup(n) {
      const root = ensureSharedRoot();
      for (let i = 0; i < n; i++) {
        const e = epGen.next().value as Endpoint;
        (root.get(Ctrl[e]) as any).handle();
      }
    },
    requestCycle(n) {
      const root = ensureSharedRoot();
      for (let i = 0; i < n; i++) {
        const e = epGen.next().value as Endpoint;
        (root.get(Ctrl[e]) as any).handle();
      }
    },
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
// │ Harness                                                                 │
// ╰──────────────────────────────────────────────────────────────────────────╯

function ms(v: number) {
  return v.toFixed(3) + ' ms';
}

async function main() {
  console.log('=== Real-World DI Benchmark Suite ===');
  console.log(`Node ${process.version}  ${process.platform} ${process.arch}`);
  console.log(`Heap limit ~${Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024)} MB`);

  const adapters: Adapter[] = [
    buildCerynAdapter(),
    buildTsyringeAdapter(),
    buildInversifyAdapter(),
    buildTypeDIAdapter(),
    buildNeedleAdapter(),
  ];

  const bench = new Bench({ time: 1200 });

  for (const a of adapters) {
    bench.add(`${a.name}: Cold boot`, () => {
      a.coldBoot();
      a.firstRequest();
    });
  }

  for (const a of adapters) {
    bench.add(`${a.name}: Warm 1k requests`, () => {
      a.warmup(200);
      a.requestCycle(1000);
    });
  }

  for (const a of adapters) {
    bench.add(`${a.name}: Burst 10k`, () => {
      a.requestCycle(10_000);
    });
  }

  for (const a of adapters) {
    bench.add(`${a.name}: Bridge 5k`, () => {
      a.bridgeCycle(5_000);
    });
  }

  // Scoped lifecycle: create/resolve/dispose per iteration (only adapters that support it)
  for (const a of adapters) {
    if (a.scopedCycle) {
      const scopedFn = a.scopedCycle.bind(a);
      bench.add(`${a.name}: Scoped 1k`, () => {
        scopedFn(1_000);
      });
    }
  }

  // Async factory resolution (only adapters that support it)
  for (const a of adapters) {
    if (a.asyncFactoryCycle) {
      const asyncFn = a.asyncFactoryCycle.bind(a);
      bench.add(`${a.name}: Async Factory 100`, async () => {
        await asyncFn(100);
      });
    }
  }

  console.log(`[phase] running ${bench.tasks?.length ?? 0} tasks`);
  await bench.run();

  console.table(bench.table());

  console.log('\n=== Percentile Analysis ===\n');

  for (const phase of [
    'Cold boot',
    'Warm 1k requests',
    'Burst 10k',
    'Bridge 5k',
    'Scoped 1k',
    'Async Factory 100',
  ] as const) {
    console.log(`━━━ ${phase} ━━━\n`);

    for (const adapter of adapters) {
      const taskName = `${adapter.name}: ${phase}`;
      const task: any = (bench as any).tasks?.find((x: any) => x.name === taskName);

      if (!task?.result?.samples) {
        console.log(`${adapter.name.padEnd(12)} - No samples collected\n`);
        continue;
      }

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

  console.log('\n=== Summary (lower is better) ===');
  const getPeriodMs = (name: string) => {
    const t: any = (bench as any).tasks?.find((x: any) => x.name === name);
    const s = t?.result?.period ?? t?.result?.mean ?? 0;
    return s * 1000;
  };

  for (const phase of [
    'Cold boot',
    'Warm 1k requests',
    'Burst 10k',
    'Bridge 5k',
    'Scoped 1k',
    'Async Factory 100',
  ] as const) {
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
          console.log(`  Ceryn vs ${r.name}: ${(b / a).toFixed(2)}x faster`);
        } else {
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
