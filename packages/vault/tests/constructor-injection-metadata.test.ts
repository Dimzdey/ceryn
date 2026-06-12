import { describe, expect, it } from 'vitest';

import { Inject, Injectable } from '../src/decorators/index.js';
import { MissingInjectDecoratorError } from '../src/errors/errors.js';
import { token } from '../src/core/token.js';
import { Vault } from '../src/core/vault.js';

describe('Constructor injection metadata strictness', () => {
  it('throws when a constructor dependency has no @Inject decorators', () => {
    class Dep {}
    const DepT = token<Dep>('NoDecoratorDep');
    const ServiceT = token<Service>('NoDecoratorService');

    @Injectable({ provide: ServiceT })
    class Service {
      constructor(readonly dep: Dep) {}
    }

    const vault = new Vault({
      providers: [{ provide: DepT, useClass: Dep }, Service],
    });

    expect(() => vault.resolve(ServiceT)).toThrow(MissingInjectDecoratorError);
    expect(() => vault.resolve(ServiceT)).toThrow(/parameter 0/i);
  });

  it('throws for undecorated useClass constructor dependencies without @Inject', () => {
    class Dep {}
    const ServiceT = token<Service>('UseClassNoDecoratorService');

    class Service {
      constructor(readonly dep: Dep) {}
    }

    const vault = new Vault({
      providers: [{ provide: ServiceT, useClass: Service }],
    });

    expect(() => vault.resolve(ServiceT)).toThrow(MissingInjectDecoratorError);
    expect(() => vault.resolve(ServiceT)).toThrow(/parameter 0/i);
  });

  it('throws when the trailing constructor parameter is missing @Inject', () => {
    class A {}
    class B {}
    const AT = token<A>('TrailingA');
    const BT = token<B>('TrailingB');
    const ServiceT = token<Service>('TrailingService');

    @Injectable({ provide: ServiceT })
    class Service {
      constructor(
        @Inject(AT) readonly a: A,
        readonly b: B
      ) {}
    }

    const vault = new Vault({
      providers: [{ provide: AT, useClass: A }, { provide: BT, useClass: B }, Service],
    });

    expect(() => vault.resolve(ServiceT)).toThrow(MissingInjectDecoratorError);
    expect(() => vault.resolve(ServiceT)).toThrow(/parameter 1/i);
  });

  it('throws when a middle constructor parameter is missing @Inject', () => {
    class A {}
    class B {}
    class C {}
    const AT = token<A>('MiddleA');
    const BT = token<B>('MiddleB');
    const CT = token<C>('MiddleC');
    const ServiceT = token<Service>('MiddleService');

    @Injectable({ provide: ServiceT })
    class Service {
      constructor(
        @Inject(AT) readonly a: A,
        readonly b: B,
        @Inject(CT) readonly c: C
      ) {}
    }

    const vault = new Vault({
      providers: [
        { provide: AT, useClass: A },
        { provide: BT, useClass: B },
        { provide: CT, useClass: C },
        Service,
      ],
    });

    expect(() => vault.resolve(ServiceT)).toThrow(MissingInjectDecoratorError);
    expect(() => vault.resolve(ServiceT)).toThrow(/parameter 1/i);
  });

  it('passes when every constructor parameter is decorated', () => {
    class A {}
    class B {}
    const AT = token<A>('DecoratedA');
    const BT = token<B>('DecoratedB');
    const ServiceT = token<Service>('DecoratedService');

    @Injectable({ provide: ServiceT })
    class Service {
      constructor(
        @Inject(AT) readonly a: A,
        @Inject(BT) readonly b: B
      ) {}
    }

    const vault = new Vault({
      providers: [{ provide: AT, useClass: A }, { provide: BT, useClass: B }, Service],
    });

    const service = vault.resolve<Service>(ServiceT);

    expect(service.a).toBeInstanceOf(A);
    expect(service.b).toBeInstanceOf(B);
  });

  it('passes for a zero-argument constructor', () => {
    const ServiceT = token<Service>('ZeroArgService');

    @Injectable({ provide: ServiceT })
    class Service {}

    const vault = new Vault({ providers: [Service] });

    expect(vault.resolve(ServiceT)).toBeInstanceOf(Service);
  });
});
