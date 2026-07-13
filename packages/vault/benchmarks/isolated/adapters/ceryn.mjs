import {
  Container,
  Injectable,
  Inject,
  Lifecycle,
  MetadataRegistry,
  Module,
  token,
} from '../../../dist/index.js';

import { ENDPOINTS, EXPECTED_REGISTRATIONS, verifyFixture } from './common.mjs';

MetadataRegistry.reset();

export const name = 'Ceryn';
export const registrationCount = EXPECTED_REGISTRATIONS;
export const capabilities = Object.freeze({
  decorators: 'explicit-token metadata',
  asyncResolution: true,
  childContainers: false,
  requestScopes: true,
  synchronousDisposal: true,
  asynchronousDisposal: true,
});

const LoggerT = token('Logger');
const DatabaseT = token('Database');
const CacheT = token('Cache');
const RequestIdT = token('RequestId');
const ScopedServiceT = token('ScopedService');
const AsyncDbT = token('AsyncDb');
const Repo = Object.fromEntries(ENDPOINTS.map((endpoint) => [endpoint, token(`Repo:${endpoint}`)]));
const Service = Object.fromEntries(
  ENDPOINTS.map((endpoint) => [endpoint, token(`Svc:${endpoint}`)])
);
const Controller = Object.fromEntries(
  ENDPOINTS.map((endpoint) => [endpoint, token(`Ctrl:${endpoint}`)])
);

function decorateProvider(target, provide, dependencies = [], lifecycle = Lifecycle.Singleton) {
  dependencies.forEach((dependency, index) => Inject(dependency)(target, undefined, index));
  Injectable({ provide, lifecycle })(target);
  return target;
}

class Logger {
  log(message) {
    return message;
  }
}
decorateProvider(Logger, LoggerT);

class Database {
  constructor(logger) {
    this.logger = logger;
  }
  query(endpoint) {
    this.logger.log('Query');
    return `db:${endpoint}`;
  }
}
decorateProvider(Database, DatabaseT, [LoggerT]);

class Cache {
  get(key) {
    return `cache:${key}`;
  }
}
decorateProvider(Cache, CacheT);

const endpointProviders = [];
for (const endpoint of ENDPOINTS) {
  class EndpointRepository {
    constructor(database) {
      this.database = database;
    }
    fetch() {
      return this.database.query(endpoint);
    }
  }
  decorateProvider(EndpointRepository, Repo[endpoint], [DatabaseT]);

  class EndpointService {
    constructor(repository) {
      this.repository = repository;
    }
    run() {
      return this.repository.fetch();
    }
  }
  decorateProvider(EndpointService, Service[endpoint], [Repo[endpoint]]);

  class EndpointController {
    constructor(service) {
      this.service = service;
    }
    handle() {
      return this.service.run();
    }
  }
  decorateProvider(EndpointController, Controller[endpoint], [Service[endpoint]]);
  endpointProviders.push(EndpointRepository, EndpointService, EndpointController);
}

class ScopedService {
  constructor(id) {
    this.id = id;
  }
}
decorateProvider(ScopedService, ScopedServiceT, [RequestIdT], Lifecycle.Scoped);

class CoreModule {}
Module({ providers: [Logger], exports: [LoggerT], name: 'IsolatedBenchmarkCore' })(CoreModule);

class AppModule {}
Module({
  providers: [
    Database,
    Cache,
    ...endpointProviders,
    ScopedService,
    {
      provide: AsyncDbT,
      useFactory: async () => ({ connection: 'pg://localhost/bench' }),
      lifecycle: Lifecycle.Singleton,
    },
  ],
  imports: [CoreModule],
  exports: [...Object.values(Controller), ScopedServiceT, AsyncDbT],
  name: 'IsolatedBenchmarkApp',
})(AppModule);

export function buildContainer() {
  Container.clearCache();
  return Container.from(AppModule);
}

export function resolveController(container, endpoint) {
  return container.resolve(Controller[endpoint]);
}

export function resolveLogger(container) {
  return container.resolve(LoggerT);
}

export function createScope(container, requestId) {
  const scope = container.createScope();
  scope.provide(RequestIdT, requestId);
  return {
    resolveScoped: () => scope.resolve(ScopedServiceT),
    release: () => scope.disposeSync(),
  };
}

export async function release(container) {
  await container.dispose();
  Container.clearCache();
}

export function verifyContract() {
  return verifyFixture({
    registrationCount,
    buildContainer,
    resolveController,
    resolveLogger,
    createScope,
    release,
  });
}
