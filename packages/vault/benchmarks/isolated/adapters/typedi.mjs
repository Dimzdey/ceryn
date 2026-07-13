import { Container, Token } from 'typedi';

import { ENDPOINTS, EXPECTED_REGISTRATIONS, verifyFixture } from './common.mjs';

export const name = 'TypeDI';
export const registrationCount = EXPECTED_REGISTRATIONS;
export const capabilities = Object.freeze({
  decorators: false,
  asyncResolution: false,
  childContainers: 'named containers with global inheritance',
  requestScopes: 'named-container override',
  synchronousDisposal: 'container reset',
  asynchronousDisposal: false,
});

const TOKENS = {
  Logger: new Token('Logger'),
  Database: new Token('Database'),
  Cache: new Token('Cache'),
  RequestId: new Token('RequestId'),
  ScopedService: new Token('ScopedService'),
  AsyncDb: new Token('AsyncDb'),
};
const Repo = Object.fromEntries(ENDPOINTS.map((endpoint) => [endpoint, new Token(`Repo:${endpoint}`)]));
const Service = Object.fromEntries(
  ENDPOINTS.map((endpoint) => [endpoint, new Token(`Svc:${endpoint}`)])
);
const Controller = Object.fromEntries(
  ENDPOINTS.map((endpoint) => [endpoint, new Token(`Ctrl:${endpoint}`)])
);

class Logger {
  log(message) {
    return message;
  }
}

class Database {
  constructor(logger) {
    this.logger = logger;
  }
  query(endpoint) {
    this.logger.log('Query');
    return `db:${endpoint}`;
  }
}

class Cache {
  get(key) {
    return `cache:${key}`;
  }
}

let rootSequence = 0;
let scopeSequence = 0;

export function buildContainer() {
  Container.reset();
  const services = [
    { id: TOKENS.Logger, value: new Logger(), global: true },
    {
      id: TOKENS.Database,
      factory: (container) => new Database(container.get(TOKENS.Logger)),
      global: true,
    },
    { id: TOKENS.Cache, value: new Cache(), global: true },
    {
      id: TOKENS.AsyncDb,
      value: Promise.resolve({ connection: 'pg://localhost/bench' }),
      global: true,
    },
  ];

  for (const endpoint of ENDPOINTS) {
    services.push(
      {
        id: Repo[endpoint],
        factory: (container) => ({
          fetch: () => container.get(TOKENS.Database).query(endpoint),
        }),
        global: true,
      },
      {
        id: Service[endpoint],
        factory: (container) => ({
          run: () => container.get(Repo[endpoint]).fetch(),
        }),
        global: true,
      },
      {
        id: Controller[endpoint],
        factory: (container) => ({
          handle: () => container.get(Service[endpoint]).run(),
        }),
        global: true,
      }
    );
  }

  Container.set(services);
  const rootId = `isolated-root-${++rootSequence}`;
  const container = Container.of(rootId);
  container.set({
    id: TOKENS.ScopedService,
    factory: (current) => ({ id: current.get(TOKENS.RequestId) }),
    global: false,
  });
  return { rootId, container };
}

export function resolveController(root, endpoint) {
  return root.container.get(Controller[endpoint]);
}

export function resolveLogger(root) {
  return root.container.get(TOKENS.Logger);
}

export function createScope(_root, requestId) {
  const scopeId = `isolated-scope-${++scopeSequence}`;
  const scope = Container.of(scopeId);
  scope.set(TOKENS.RequestId, requestId);
  scope.set({
    id: TOKENS.ScopedService,
    factory: (container) => ({ id: container.get(TOKENS.RequestId) }),
    global: false,
  });
  return {
    resolveScoped: () => scope.get(TOKENS.ScopedService),
    release: () => Container.reset(scopeId),
  };
}

export function release(root) {
  Container.reset(root.rootId);
  Container.reset();
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
