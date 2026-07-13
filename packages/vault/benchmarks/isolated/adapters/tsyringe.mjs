import 'reflect-metadata';
import {
  Lifecycle,
  container as globalContainer,
  inject,
  injectable,
} from 'tsyringe';

import { ENDPOINTS, EXPECTED_REGISTRATIONS, verifyFixture } from './common.mjs';

export const name = 'Tsyringe';
export const registrationCount = EXPECTED_REGISTRATIONS;
export const capabilities = Object.freeze({
  decorators: 'reflect-metadata injection tokens',
  asyncResolution: false,
  childContainers: true,
  requestScopes: 'container-scoped',
  synchronousDisposal: 'reset only',
  asynchronousDisposal: true,
});

const TOKENS = {
  Logger: Symbol('Logger'),
  Database: Symbol('Database'),
  Cache: Symbol('Cache'),
  RequestId: Symbol('RequestId'),
  ScopedService: Symbol('ScopedService'),
  AsyncDb: Symbol('AsyncDb'),
};
const Repo = Object.fromEntries(ENDPOINTS.map((endpoint) => [endpoint, Symbol(`Repo:${endpoint}`)]));
const Service = Object.fromEntries(
  ENDPOINTS.map((endpoint) => [endpoint, Symbol(`Svc:${endpoint}`)])
);
const Controller = Object.fromEntries(
  ENDPOINTS.map((endpoint) => [endpoint, Symbol(`Ctrl:${endpoint}`)])
);

function decorateInjectable(target, dependencies = []) {
  dependencies.forEach((dependency, index) => inject(dependency)(target, undefined, index));
  injectable()(target);
  return target;
}

class Logger {
  log(message) {
    return message;
  }
}
decorateInjectable(Logger);

class Database {
  constructor(logger) {
    this.logger = logger;
  }
  query(endpoint) {
    this.logger.log('Query');
    return `db:${endpoint}`;
  }
}
decorateInjectable(Database, [TOKENS.Logger]);

class Cache {
  get(key) {
    return `cache:${key}`;
  }
}
decorateInjectable(Cache);

const endpointClasses = {};
for (const endpoint of ENDPOINTS) {
  class EndpointRepository {
    constructor(database) {
      this.database = database;
    }
    fetch() {
      return this.database.query(endpoint);
    }
  }
  decorateInjectable(EndpointRepository, [TOKENS.Database]);

  class EndpointService {
    constructor(repository) {
      this.repository = repository;
    }
    run() {
      return this.repository.fetch();
    }
  }
  decorateInjectable(EndpointService, [Repo[endpoint]]);

  class EndpointController {
    constructor(service) {
      this.service = service;
    }
    handle() {
      return this.service.run();
    }
  }
  decorateInjectable(EndpointController, [Service[endpoint]]);
  endpointClasses[endpoint] = { EndpointRepository, EndpointService, EndpointController };
}

class ScopedService {
  constructor(id) {
    this.id = id;
  }
}
decorateInjectable(ScopedService, [TOKENS.RequestId]);

export function buildContainer() {
  const core = globalContainer.createChildContainer();
  core.register(TOKENS.Logger, { useClass: Logger }, { lifecycle: Lifecycle.Singleton });
  const container = core.createChildContainer();
  container.register(TOKENS.Database, { useClass: Database }, { lifecycle: Lifecycle.Singleton });
  container.register(TOKENS.Cache, { useClass: Cache }, { lifecycle: Lifecycle.Singleton });
  container.register(
    TOKENS.ScopedService,
    { useClass: ScopedService },
    { lifecycle: Lifecycle.ContainerScoped }
  );
  container.register(TOKENS.AsyncDb, {
    useFactory: () => Promise.resolve({ connection: 'pg://localhost/bench' }),
  });

  for (const endpoint of ENDPOINTS) {
    const { EndpointRepository, EndpointService, EndpointController } = endpointClasses[endpoint];
    container.register(
      Repo[endpoint],
      { useClass: EndpointRepository },
      { lifecycle: Lifecycle.Singleton }
    );
    container.register(
      Service[endpoint],
      { useClass: EndpointService },
      { lifecycle: Lifecycle.Singleton }
    );
    container.register(
      Controller[endpoint],
      { useClass: EndpointController },
      { lifecycle: Lifecycle.Singleton }
    );
  }
  return { core, container };
}

export function resolveController(root, endpoint) {
  return root.container.resolve(Controller[endpoint]);
}

export function resolveLogger(root) {
  return root.container.resolve(TOKENS.Logger);
}

export function createScope(root, requestId) {
  const scope = root.container.createChildContainer();
  scope.registerInstance(TOKENS.RequestId, requestId);
  return {
    resolveScoped: () => scope.resolve(TOKENS.ScopedService),
    release: () => scope.dispose(),
  };
}

export async function release(root) {
  await root.container.dispose();
  await root.core.dispose();
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
