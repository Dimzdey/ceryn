/*
 * Real-World DI Benchmark Suite (tinybench)
 * Purpose: honest, comparable workloads across DI libs using request-like scopes,
 *          mixed lifecycles, layered graphs, and aether/bridge style composition.
 * Notes:
 * - Uses only constructs supported by all libs under test: singletons, transients,
 *   scoped containers (child/container-of), factory providers, and token-based injection.
 * - Measures fresh container work in a warm process, steady-state, burst, and bridge hops.
 * - Reports batch and per-operation latency with sample-aware percentile context.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import 'reflect-metadata';
import { Bench, type Fn, type FnOptions } from 'tinybench';
import v8 from 'v8';

import { token } from '../src/core/token.js';
import { Container, Inject, Injectable, Lifecycle, Module } from '../src/index.js';
import { MetadataRegistry } from '../src/registry/index.js';

import {
  inject,
  container as tsyringe,
  injectable as tsyringeInjectable,
  Lifecycle as TsyringeLifecycle,
  type DependencyContainer,
} from 'tsyringe';

import { Container as Needle } from '@needle-di/core';
import {
  Container as Inversify,
  inject as invInject,
  injectable as invInjectable,
} from 'inversify';
import {
  Container as TypeDIContainer,
  Token as TypeDIToken,
  type ContainerInstance as TypeDIContainerInstance,
} from 'typedi';
import {
  calculatePercentiles,
  deterministicShuffle,
  logarithmicHistogram,
  percentileEligibility,
} from './lib/statistics.mjs';

function formatNs(ns: number): string {
  if (ns >= 1_000_000_000) return `${(ns / 1_000_000_000).toFixed(2)}s`;
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(2)}ms`;
  if (ns >= 1_000) return `${(ns / 1_000).toFixed(2)}μs`;
  return `${ns.toFixed(0)}ns`;
}

function positiveEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
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
  release(): Promise<void> | void;
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

function buildCerynAdapter(endpointSeed = 1337): Adapter {
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
    providers: [Logger],
    exports: [LoggerT],
    name: 'BenchmarkCoreModule',
  })
  class CoreModule {}

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
    imports: [CoreModule],
    exports: [...Object.values(CtrlT), ScopedServiceT, AsyncDbT],
    name: 'BenchmarkAppModule',
  })
  class FullAppVault {}

  const buildVault = () => Container.from(FullAppVault);

  let cold: ReturnType<typeof buildVault> | null = null;
  let warm: ReturnType<typeof buildVault> | null = null;
  const epGen = endpointStream(endpointSeed);

  return {
    name: 'Ceryn',
    coldBoot() {
      Container.clearCache();
      cold = buildVault();
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
    release() {
      cold = null;
      warm = null;
      Container.clearCache();
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
  const RequestIdT = Symbol('RequestId');
  const ScopedServiceT = Symbol('ScopedService');
  const AsyncDbT = Symbol('AsyncDb');

  @tsyringeInjectable()
  class DB {
    constructor(@inject(TOK.Logger) private readonly logger: Logger) {}
    query(e: Endpoint) {
      this.logger.log('Query');
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

  const endpointClasses = Object.fromEntries(
    ENDPOINTS.map((endpoint) => [endpoint, buildEndpointClasses(endpoint)])
  ) as Record<Endpoint, ReturnType<typeof buildEndpointClasses>>;

  @tsyringeInjectable()
  class ScopedService {
    constructor(@inject(RequestIdT) public readonly id: string) {}
  }

  const buildRoot = (): DependencyContainer => {
    const core = tsyringe.createChildContainer();
    core.register(TOK.Logger, { useClass: Logger }, { lifecycle: TsyringeLifecycle.Singleton });

    const container = core.createChildContainer();
    container.register(TOK.DB, { useClass: DB }, { lifecycle: TsyringeLifecycle.Singleton });
    container.register(TOK.Cache, { useClass: Cache }, { lifecycle: TsyringeLifecycle.Singleton });
    container.register(
      ScopedServiceT,
      { useClass: ScopedService },
      { lifecycle: TsyringeLifecycle.ContainerScoped }
    );
    container.register(AsyncDbT, {
      useFactory: () => Promise.resolve({ connection: 'pg://localhost/bench' }),
    });

    for (const e of ENDPOINTS) {
      const { EndpointRepo, EndpointSvc, EndpointCtrl } = endpointClasses[e];
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
        child.registerInstance(RequestIdT, `req-${i}`);
        void child.resolve<ScopedService>(ScopedServiceT).id;
        child.reset();
      }
    },
    release() {
      coldRoot = null;
      sharedRoot = null;
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
  const RequestIdT = Symbol('RequestId');
  const ScopedServiceT = Symbol('ScopedService');
  const AsyncDbT = Symbol('AsyncDb');

  @invInjectable()
  class DB {
    constructor(@invInject(TOK.Logger) private readonly logger: Logger) {}
    query(e: Endpoint) {
      this.logger.log('Query');
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
    const core = new Inversify({ defaultScope: 'Transient' });
    core.bind(TOK.Logger).to(Logger).inSingletonScope();

    const container = new Inversify({ defaultScope: 'Transient', parent: core });
    container.bind(TOK.DB).to(DB).inSingletonScope();
    container.bind(TOK.Cache).to(Cache).inSingletonScope();
    container
      .bind<{ id: string }>(ScopedServiceT)
      .toDynamicValue((context) => ({ id: context.get<string>(RequestIdT) }));
    container
      .bind<{ connection: string }>(AsyncDbT)
      .toDynamicValue(async () => ({ connection: 'pg://localhost/bench' }))
      .inSingletonScope();

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
    scopedCycle(n) {
      const root = ensureSharedRoot();
      for (let i = 0; i < n; i++) {
        const child = new Inversify({ parent: root });
        child.bind(RequestIdT).toConstantValue(`req-${i}`);
        void child.get<{ id: string }>(ScopedServiceT).id;
      }
    },
    async asyncFactoryCycle(n) {
      const root = ensureSharedRoot();
      for (let i = 0; i < n; i++) {
        await root.getAsync<{ connection: string }>(AsyncDbT);
      }
    },
    release() {
      coldRoot = null;
      sharedRoot = null;
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
  const RequestIdT = new TypeDIToken<string>('RequestId');
  const ScopedServiceT = new TypeDIToken<{ id: string }>('ScopedService');
  const AsyncDbT = new TypeDIToken<Promise<{ connection: string }>>('AsyncDb');

  class DB {
    constructor(private readonly logger: Logger) {}
    query(e: Endpoint) {
      this.logger.log('Query');
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

  let scopeCounter = 0;

  const configureRoot = (): TypeDIContainerInstance => {
    TypeDIContainer.reset('bench-app');
    TypeDIContainer.of().reset({ strategy: 'resetServices' });

    const services: any[] = [
      { id: TOK.Logger, value: new Logger(), global: true },
      {
        id: TOK.DB,
        factory: (container: TypeDIContainerInstance) => new DB(container.get<Logger>(TOK.Logger)),
        global: true,
      },
      { id: TOK.Cache, value: new Cache(), global: true },
      {
        id: AsyncDbT,
        factory: () => Promise.resolve({ connection: 'pg://localhost/bench' }),
        global: true,
      },
    ];

    for (const e of ENDPOINTS) {
      services.push({
        id: Repo[e],
        factory: (container: TypeDIContainerInstance) => ({
          fetch: () => container.get<DB>(TOK.DB).query(e),
        }),
        global: true,
      });
      services.push({
        id: Svc[e],
        factory: (container: TypeDIContainerInstance) => ({
          run: () => container.get<RepoAPI>(Repo[e]).fetch(),
        }),
        global: true,
      });
      services.push({
        id: Ctrl[e],
        factory: (container: TypeDIContainerInstance) => ({
          handle: () => container.get<SvcAPI>(Svc[e]).run(),
        }),
        global: true,
      });
    }

    TypeDIContainer.set(services);
    const root = TypeDIContainer.of('bench-app');
    root.set({
      id: ScopedServiceT,
      factory: (container: TypeDIContainerInstance) => ({
        id: container.get(RequestIdT),
      }),
      global: false,
    });
    return root;
  };

  const epGen = endpointStream();
  let coldRoot: TypeDIContainerInstance | null = null;
  let sharedRoot: TypeDIContainerInstance | null = null;
  const ensureSharedRoot = () => sharedRoot ?? (sharedRoot = configureRoot());

  return {
    name: 'TypeDI',
    coldBoot() {
      coldRoot = configureRoot();
    },
    firstRequest() {
      const root = coldRoot ?? (coldRoot = configureRoot());
      const e = epGen.next().value;
      (root.get(Ctrl[e]) as CtrlAPI).handle();
    },
    warmup(n) {
      const root = ensureSharedRoot();
      for (let i = 0; i < n; i++) {
        const e = epGen.next().value;
        (root.get(Ctrl[e]) as CtrlAPI).handle();
      }
    },
    requestCycle(n) {
      const root = ensureSharedRoot();
      for (let i = 0; i < n; i++) {
        const e = epGen.next().value;
        (root.get(Ctrl[e]) as CtrlAPI).handle();
      }
    },
    bridgeCycle(n) {
      const root = ensureSharedRoot();
      for (let i = 0; i < n; i++) {
        root.get(TOK.Logger);
      }
    },
    scopedCycle(n) {
      void ensureSharedRoot();
      for (let i = 0; i < n; i++) {
        const scopeId = `bench-scope-${++scopeCounter}`;
        const scope = TypeDIContainer.of(scopeId);
        scope.set(RequestIdT, `req-${i}`);
        scope.set({
          id: ScopedServiceT,
          factory: (container: TypeDIContainerInstance) => ({
            id: container.get(RequestIdT),
          }),
          global: false,
        });
        void scope.get(ScopedServiceT).id;
        TypeDIContainer.reset(scopeId);
      }
    },
    release() {
      coldRoot = null;
      sharedRoot = null;
      TypeDIContainer.reset('bench-app');
      TypeDIContainer.of().reset({ strategy: 'resetServices' });
    },
  };
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Needle adapter                                                          │
// ╰──────────────────────────────────────────────────────────────────────────╯

function buildNeedleAdapter(): Adapter {
  const TOK = {
    DB: 'DB',
    Cache: 'Cache',
    Logger: 'Logger',
    RequestId: 'RequestId',
    ScopedService: 'ScopedService',
    AsyncDb: 'AsyncDb',
  } as const;
  const Repo: Record<Endpoint, string> = Object.fromEntries(
    ENDPOINTS.map((e) => [e, `Repo:${e}`])
  ) as any;
  const Svc: Record<Endpoint, string> = Object.fromEntries(
    ENDPOINTS.map((e) => [e, `Svc:${e}`])
  ) as any;
  const Ctrl = Object.fromEntries(ENDPOINTS.map((e) => [e, `Ctrl:${e}`])) as any;

  const buildRoot = () => {
    const core = new Needle();
    core.bind({ provide: TOK.Logger, useFactory: () => ({ log: (s: string) => s }) });

    const container = core.createChild();
    container.bindAll(
      {
        provide: TOK.DB,
        useFactory: (c) => {
          const logger = c.get(TOK.Logger) as { log: (message: string) => string };
          return {
            query: (e: Endpoint) => {
              logger.log('Query');
              return `db:${e}`;
            },
          };
        },
      },
      { provide: TOK.Cache, useFactory: () => ({ get: (k: string) => `cache:${k}` }) },
      {
        provide: TOK.AsyncDb,
        async: true,
        useFactory: async () => ({ connection: 'pg://localhost/bench' }),
      }
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
    scopedCycle(n) {
      const root = ensureSharedRoot();
      for (let i = 0; i < n; i++) {
        const child = root.createChild();
        child.bindAll(
          { provide: TOK.RequestId, useValue: `req-${i}` },
          {
            provide: TOK.ScopedService,
            useFactory: (container) => ({ id: container.get(TOK.RequestId) as string }),
          }
        );
        void (child.get(TOK.ScopedService) as { id: string }).id;
        child.unbindAll();
      }
    },
    async asyncFactoryCycle(n) {
      const root = ensureSharedRoot();
      for (let i = 0; i < n; i++) {
        await root.getAsync(TOK.AsyncDb);
      }
    },
    release() {
      coldRoot = null;
      sharedRoot = null;
    },
  };
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Harness                                                                 │
// ╰──────────────────────────────────────────────────────────────────────────╯

const PHASES = [
  { name: 'Fresh container + first request (warm process)', batchSize: 1, unit: 'batch' },
  { name: 'Warm 1k requests', batchSize: 1_000, unit: 'request' },
  { name: 'Burst 10k', batchSize: 10_000, unit: 'request' },
  { name: 'Parent lookup 5k', batchSize: 5_000, unit: 'lookup' },
  { name: 'Scoped 1k', batchSize: 1_000, unit: 'scope' },
  { name: 'Async cached singleton 100', batchSize: 100, unit: 'resolve' },
] as const;

async function prepareWarmAdapter(adapter: Adapter): Promise<void> {
  await adapter.release();
  await adapter.warmup(200);
}

async function prepareAsyncAdapter(adapter: Adapter): Promise<void> {
  await prepareWarmAdapter(adapter);
  await adapter.asyncFactoryCycle?.(1);
}

function packageVersions(): string | undefined {
  try {
    let cerynVersion = 'unknown';
    for (const packagePath of [
      resolve(process.cwd(), 'package.json'),
      resolve(process.cwd(), 'packages/vault/package.json'),
    ]) {
      if (!existsSync(packagePath)) continue;
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (packageJson.name === '@ceryn/vault') {
        cerynVersion = packageJson.version ?? 'unknown';
        break;
      }
    }

    const lockPath = [
      resolve(process.cwd(), 'package-lock.json'),
      resolve(process.cwd(), '../../package-lock.json'),
    ].find(existsSync);
    if (!lockPath) return undefined;

    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      packages?: Record<string, { version?: string }>;
    };
    const packages = lock.packages ?? {};
    const names = [
      ['Ceryn', cerynVersion],
      ['Tinybench', packages['node_modules/tinybench']?.version ?? 'unknown'],
      ['Tsyringe', packages['node_modules/tsyringe']?.version ?? 'unknown'],
      ['Inversify', packages['node_modules/inversify']?.version ?? 'unknown'],
      ['TypeDI', packages['node_modules/typedi']?.version ?? 'unknown'],
      ['Needle', packages['node_modules/@needle-di/core']?.version ?? 'unknown'],
    ] as const;
    return names.map(([label, version]) => `${label} ${version}`).join('  ');
  } catch {
    return undefined;
  }
}

function profileCerynFreshContainerPath(): void {
  const iterations = positiveEnv(
    'BENCH_FRESH_ITERATIONS',
    positiveEnv('BENCH_COLD_ITERATIONS', 100_000)
  );
  const seed = Number.parseInt(process.env.BENCH_SEED ?? '42', 10) >>> 0;
  const adapter = buildCerynAdapter(seed);
  const bootSamplesNs: number[] = [];
  const firstRequestSamplesNs: number[] = [];
  const combinedSamplesNs: number[] = [];

  for (let index = 0; index < 2_000; index++) {
    adapter.coldBoot();
    adapter.firstRequest();
  }

  for (let index = 0; index < iterations; index++) {
    const bootStart = process.hrtime.bigint();
    adapter.coldBoot();
    const bootEnd = process.hrtime.bigint();
    adapter.firstRequest();
    const requestEnd = process.hrtime.bigint();

    bootSamplesNs.push(Number(bootEnd - bootStart));
    firstRequestSamplesNs.push(Number(requestEnd - bootEnd));
    combinedSamplesNs.push(Number(requestEnd - bootStart));
  }

  const tasks = [
    { name: 'container boot', samplesNs: bootSamplesNs },
    { name: 'first request', samplesNs: firstRequestSamplesNs },
    { name: 'combined fresh container + first request', samplesNs: combinedSamplesNs },
  ];
  const output = {
    suite: 'vault-fresh-container',
    seed,
    iterations,
    environment: { node: process.version, cpu: cpus()[0]?.model ?? 'unknown' },
    tasks,
  };

  const boot = calculatePercentiles(bootSamplesNs);
  const firstRequest = calculatePercentiles(firstRequestSamplesNs);
  console.log('=== Ceryn Fresh-Container Profile (warm process) ===');
  console.log(`Iterations: ${iterations.toLocaleString()}`);
  console.log(
    `Container boot: p50 ${formatNs(boot.p50)}, p95 ${formatNs(boot.p95)}, mean ${formatNs(boot.mean)}`
  );
  console.log(
    `First request: p50 ${formatNs(firstRequest.p50)}, p95 ${formatNs(firstRequest.p95)}, mean ${formatNs(firstRequest.mean)}`
  );
  if (process.env.BENCH_OUTPUT_JSON) {
    writeFileSync(resolve(process.env.BENCH_OUTPUT_JSON), `${JSON.stringify(output, null, 2)}\n`);
  }
}

async function main() {
  if (process.env.BENCH_PROFILE === 'ceryn-cold') {
    profileCerynFreshContainerPath();
    return;
  }

  console.log('=== Real-World DI Warm-Process Benchmark Suite ===');
  console.log(`Node ${process.version}  ${process.platform} ${process.arch}`);
  const cpu = cpus();
  console.log(`CPU ${cpu[0]?.model ?? 'unknown'}  ${cpu.length} logical cores`);
  console.log(`Heap limit ~${Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024)} MB`);
  const versions = packageVersions();
  if (versions) console.log(versions);
  console.log('Command: npm run bench -w packages/vault');

  const adapters: Adapter[] = [
    buildCerynAdapter(),
    buildTsyringeAdapter(),
    buildInversifyAdapter(),
    buildTypeDIAdapter(),
    buildNeedleAdapter(),
  ];

  const benchmarkTimeMs = positiveEnv('BENCH_TIME_MS', 1_200);
  const warmupTimeMs = positiveEnv('BENCH_WARMUP_MS', 250);
  const bench = new Bench({ time: benchmarkTimeMs, warmupTime: warmupTimeMs });
  const taskSpecs: Array<{ name: string; fn: Fn; options?: FnOptions }> = [];
  const addTask = (name: string, fn: Fn, options?: FnOptions) => {
    taskSpecs.push({ name, fn, options });
  };

  for (const a of adapters) {
    addTask(`${a.name}: Fresh container + first request (warm process)`, () => {
      a.coldBoot();
      a.firstRequest();
    });
  }

  for (const a of adapters) {
    addTask(
      `${a.name}: Warm 1k requests`,
      () => {
        a.requestCycle(1000);
      },
      {
        beforeAll: () => prepareWarmAdapter(a),
      }
    );
  }

  for (const a of adapters) {
    addTask(
      `${a.name}: Burst 10k`,
      () => {
        a.requestCycle(10_000);
      },
      { beforeAll: () => prepareWarmAdapter(a) }
    );
  }

  for (const a of adapters) {
    addTask(
      `${a.name}: Parent lookup 5k`,
      () => {
        a.bridgeCycle(5_000);
      },
      { beforeAll: () => prepareWarmAdapter(a) }
    );
  }

  // Scoped lifecycle: create child/scope, provide request id, construct scoped value, tear down.
  for (const a of adapters) {
    if (a.scopedCycle) {
      const scopedFn = a.scopedCycle.bind(a);
      addTask(
        `${a.name}: Scoped 1k`,
        () => {
          scopedFn(1_000);
        },
        { beforeAll: () => prepareWarmAdapter(a) }
      );
    }
  }

  // Native async singleton hot path; creation is completed in beforeAll.
  for (const a of adapters) {
    if (a.asyncFactoryCycle) {
      const asyncFn = a.asyncFactoryCycle.bind(a);
      addTask(
        `${a.name}: Async cached singleton 100`,
        async () => {
          await asyncFn(100);
        },
        { beforeAll: () => prepareAsyncAdapter(a) }
      );
    }
  }

  const parsedSeed = Number.parseInt(process.env.BENCH_SEED ?? '', 10);
  const seed = Number.isFinite(parsedSeed) ? parsedSeed >>> 0 : Date.now() >>> 0;
  for (const task of deterministicShuffle(taskSpecs, seed)) {
    bench.add(task.name, task.fn, task.options);
  }
  let completedTasks = 0;
  bench.addEventListener('cycle', (event) => {
    completedTasks++;
    console.log(`[task ${completedTasks}/${taskSpecs.length}] ${event.task?.name ?? 'unknown'}`);
  });
  console.log(`Seed: ${seed}`);
  console.log(`Tinybench: ${benchmarkTimeMs}ms measured + ${warmupTimeMs}ms warmup per task`);
  console.log(`[phase] running ${bench.tasks?.length ?? 0} tasks in seeded order`);
  await bench.run();

  console.table(bench.table());

  console.log('\n=== Percentile Analysis ===\n');

  for (const phase of PHASES) {
    console.log(`━━━ ${phase.name} ━━━\n`);

    for (const adapter of adapters) {
      const taskName = `${adapter.name}: ${phase.name}`;
      const task = bench.tasks.find((candidate) => candidate.name === taskName);

      if (!task?.result?.latency.samples) {
        console.log(`${adapter.name.padEnd(12)} - No samples collected\n`);
        continue;
      }

      const samplesNs = task.result.latency.samples.map((sampleMs) => sampleMs * 1_000_000);
      const stats = calculatePercentiles(samplesNs);
      const eligible = percentileEligibility(stats.samples);
      const tail = (value: number, available: boolean) =>
        available ? formatNs(value).padStart(12) : 'insufficient samples';

      console.log(`${adapter.name}:`);
      console.log(`  Samples:  ${stats.samples.toLocaleString()}`);
      console.log(`  Min:      ${formatNs(stats.min)}`);
      console.log(`  p50:      ${formatNs(stats.p50).padStart(12)} (median)`);
      console.log(`  p90:      ${tail(stats.p90, eligible.p90)}`);
      console.log(`  p95:      ${tail(stats.p95, eligible.p95)}`);
      console.log(`  p99:      ${tail(stats.p99, eligible.p99)}`);
      console.log(`  p99.9:    ${tail(stats.p999, eligible.p999)}`);
      console.log(`  Max:      ${formatNs(stats.max)}`);
      console.log(`  Mean:     ${formatNs(stats.mean)}`);
      console.log(`  StdDev:   ${formatNs(stats.stddev)}`);
      if (process.env.BENCH_HISTOGRAM === '1') {
        console.log('  Histogram (ns, powers of two):');
        for (const bucket of logarithmicHistogram(samplesNs)) {
          console.log(
            `    ${formatNs(bucket.lowerBound)}..${formatNs(bucket.upperBound)} ${bucket.count}`
          );
        }
      }
      console.log();
    }
    console.log();
  }

  console.log('\n=== Summary (median latency; lower is better) ===');
  const getMedianMs = (name: string) => {
    const task = bench.tasks.find((candidate) => candidate.name === name);
    return task?.result?.latency.p50 ?? -1;
  };

  for (const phase of PHASES) {
    console.log(`\n-- ${phase.name}`);
    const rows = adapters
      .map((a) => ({ name: a.name, ms: getMedianMs(`${a.name}: ${phase.name}`) }))
      .filter((r) => r.ms > 0); // Exclude adapters that didn't participate

    if (rows.length === 0) {
      console.log('  (no participants)');
      continue;
    }

    rows.forEach((row) => {
      const batch = formatNs(row.ms * 1_000_000);
      const perOperation = formatNs((row.ms * 1_000_000) / phase.batchSize);
      console.log(
        `${row.name.padEnd(12)} ${batch.padStart(10)} / batch  ${perOperation.padStart(10)} / ${phase.unit}`
      );
    });
    const best = rows.reduce((p, c) => (p.ms <= c.ms ? p : c));
    console.log(`Fastest: ${best.name} (${formatNs(best.ms * 1_000_000)} per batch)`);
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

  if (process.env.BENCH_OUTPUT_JSON) {
    const outputPath = resolve(process.env.BENCH_OUTPUT_JSON);
    writeFileSync(
      outputPath,
      `${JSON.stringify(
        {
          suite: 'warm-process',
          seed,
          environment: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            cpu: cpu[0]?.model ?? 'unknown',
          },
          tasks: bench.tasks.map((task) => ({
            name: task.name,
            samplesNs: task.result?.latency.samples.map((sampleMs) => sampleMs * 1_000_000) ?? [],
          })),
        },
        null,
        2
      )}\n`
    );
    console.log(`\nRaw samples written to ${outputPath}`);
  }

  // Notes on methodology
  console.log('\n=== Notes ===');
  console.log(
    '• This is a warm-process microbenchmark; it does not measure process or module cold start.'
  );
  console.log(
    '• Tinybench warmup runs before every task; adapter setup runs outside timed samples.'
  );
  console.log('• Parent lookup resolves a singleton registered in a parent/imported container.');
  console.log('• Scoped work creates a child/scope, provides RequestId, constructs a service,');
  console.log(
    "  reads it, and performs the adapter's idiomatic synchronous teardown where available."
  );
  console.log(
    '• Async cached singleton includes only adapters with a native async resolution API;'
  );
  console.log('  singleton creation completes before timed samples.');
  console.log('• Tail percentiles require at least ten expected tail observations.');
  console.log(
    '• Use npm run bench:isolated for process-level startup and retained-memory estimates.'
  );

  console.log('\nBenchmark complete');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
