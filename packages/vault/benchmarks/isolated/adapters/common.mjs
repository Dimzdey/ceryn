export const ENDPOINTS = Object.freeze([
  'users',
  'orders',
  'payments',
  'catalog',
  'search',
  'auth',
]);

export const EXPECTED_REGISTRATIONS = 23;

export async function verifyFixture(fixture) {
  const container = fixture.buildContainer();
  const scopes = [];
  try {
    const firstController = fixture.resolveController(container, 'users');
    const firstResult = firstController.handle();
    const secondController = fixture.resolveController(container, 'users');
    const firstLogger = fixture.resolveLogger(container);
    const secondLogger = fixture.resolveLogger(container);

    const firstScope = fixture.createScope(container, 'scope-a');
    scopes.push(firstScope);
    const firstScoped = firstScope.resolveScoped();
    const repeatedScoped = firstScope.resolveScoped();

    const secondScope = fixture.createScope(container, 'scope-b');
    scopes.push(secondScope);
    const secondScoped = secondScope.resolveScoped();

    return {
      registrationCount: fixture.registrationCount,
      resultConsumed: firstResult === 'db:users',
      controllerSingleton: firstController === secondController,
      parentSingleton: firstLogger === secondLogger,
      scopedStableWithinScope: firstScoped === repeatedScoped,
      scopedDistinctAcrossScopes: firstScoped !== secondScoped,
      requestOverride: firstScoped.id === 'scope-a' && secondScoped.id === 'scope-b',
    };
  } finally {
    for (const scope of scopes.reverse()) await scope.release();
    await fixture.release(container);
  }
}
