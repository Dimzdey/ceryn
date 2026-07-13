import 'reflect-metadata';
import { Container, inject, injectable } from 'inversify';

import { ENDPOINTS, EXPECTED_REGISTRATIONS, verifyFixture } from './common.mjs';

export const name = 'Inversify';
export const registrationCount = EXPECTED_REGISTRATIONS;
export const capabilities = Object.freeze({
  decorators: 'reflect-metadata injection tokens',
  asyncResolution: true,
  childContainers: true,
  requestScopes: 'resolution request plus child override',
  synchronousDisposal: false,
  asynchronousDisposal: 'unbind deactivation',
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

export function buildContainer() {
  const core = new Container({ defaultScope: 'Transient' });
  core.bind(TOKENS.Logger).to(Logger).inSingletonScope();
  const container = new Container({ defaultScope: 'Transient', parent: core });
  container.bind(TOKENS.Database).to(Database).inSingletonScope();
  container.bind(TOKENS.Cache).to(Cache).inSingletonScope();
  container
    .bind(TOKENS.ScopedService)
    .toDynamicValue((context) => ({ id: context.get(TOKENS.RequestId) }))
    .inRequestScope();
  container
    .bind(TOKENS.AsyncDb)
    .toDynamicValue(async () => ({ connection: 'pg://localhost/bench' }))
    .inSingletonScope();

  for (const endpoint of ENDPOINTS) {
    const { EndpointRepository, EndpointService, EndpointController } = endpointClasses[endpoint];
    container.bind(Repo[endpoint]).to(EndpointRepository).inSingletonScope();
    container.bind(Service[endpoint]).to(EndpointService).inSingletonScope();
    container.bind(Controller[endpoint]).to(EndpointController).inSingletonScope();
  }
  return { core, container };
}

export function resolveController(root, endpoint) {
  return root.container.get(Controller[endpoint]);
}

export function resolveLogger(root) {
  return root.container.get(TOKENS.Logger);
}

export function createScope(root, requestId) {
  const scope = new Container({ parent: root.container });
  scope.bind(TOKENS.RequestId).toConstantValue(requestId);
  scope
    .bind(TOKENS.ScopedService)
    .toDynamicValue((context) => ({ id: context.get(TOKENS.RequestId) }))
    .inSingletonScope();
  return {
    resolveScoped: () => scope.get(TOKENS.ScopedService),
    release: () => scope.unbindAll(),
  };
}

export async function release(root) {
  await root.container.unbindAll();
  await root.core.unbindAll();
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
