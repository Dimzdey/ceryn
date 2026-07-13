import { Container } from '@needle-di/core';

import { ENDPOINTS, EXPECTED_REGISTRATIONS, verifyFixture } from './common.mjs';

export const name = 'Needle';
export const registrationCount = EXPECTED_REGISTRATIONS;
export const capabilities = Object.freeze({
  decorators: false,
  asyncResolution: true,
  childContainers: true,
  requestScopes: 'child-container override',
  synchronousDisposal: 'unbind only',
  asynchronousDisposal: false,
});

const TOKENS = {
  Logger: 'Logger',
  Database: 'Database',
  Cache: 'Cache',
  RequestId: 'RequestId',
  ScopedService: 'ScopedService',
  AsyncDb: 'AsyncDb',
};
const Repo = Object.fromEntries(ENDPOINTS.map((endpoint) => [endpoint, `Repo:${endpoint}`]));
const Service = Object.fromEntries(ENDPOINTS.map((endpoint) => [endpoint, `Svc:${endpoint}`]));
const Controller = Object.fromEntries(
  ENDPOINTS.map((endpoint) => [endpoint, `Ctrl:${endpoint}`])
);

export function buildContainer() {
  const core = new Container();
  core.bind({
    provide: TOKENS.Logger,
    useFactory: () => ({ log: (message) => message }),
  });

  const container = core.createChild();
  container.bindAll(
    {
      provide: TOKENS.Database,
      useFactory: (current) => {
        const logger = current.get(TOKENS.Logger);
        return {
          query: (endpoint) => {
            logger.log('Query');
            return `db:${endpoint}`;
          },
        };
      },
    },
    { provide: TOKENS.Cache, useFactory: () => ({ get: (key) => `cache:${key}` }) },
    {
      provide: TOKENS.ScopedService,
      useFactory: (current) => ({ id: current.get(TOKENS.RequestId) }),
    },
    {
      provide: TOKENS.AsyncDb,
      async: true,
      useFactory: async () => ({ connection: 'pg://localhost/bench' }),
    }
  );

  for (const endpoint of ENDPOINTS) {
    container.bindAll(
      {
        provide: Repo[endpoint],
        useFactory: (current) => ({
          fetch: () => current.get(TOKENS.Database).query(endpoint),
        }),
      },
      {
        provide: Service[endpoint],
        useFactory: (current) => ({ run: () => current.get(Repo[endpoint]).fetch() }),
      },
      {
        provide: Controller[endpoint],
        useFactory: (current) => ({ handle: () => current.get(Service[endpoint]).run() }),
      }
    );
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
  const scope = root.container.createChild();
  scope.bindAll(
    { provide: TOKENS.RequestId, useValue: requestId },
    {
      provide: TOKENS.ScopedService,
      useFactory: (current) => ({ id: current.get(TOKENS.RequestId) }),
    }
  );
  return {
    resolveScoped: () => scope.get(TOKENS.ScopedService),
    release: () => scope.unbindAll(),
  };
}

export function release(root) {
  root.container.unbindAll();
  root.core.unbindAll();
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
