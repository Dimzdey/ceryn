import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import {
  Container,
  Injectable,
  Inject,
  Module,
  Lifecycle,
  token,
  MetadataRegistry,
} from '@ceryn/vault';
import { cerynPlugin, RequestToken } from '../src/index.js';

beforeEach(() => {
  MetadataRegistry.resetForTests();
  Container.clearCache();
});

describe('@ceryn/fastify plugin', () => {
  it('creates a scope per request and resolves scoped providers', async () => {
    const GreeterT = token<{ greet: () => string }>('Greeter');
    const RequestIdT = token<string>('RequestId');

    @Injectable({ provide: GreeterT, lifecycle: Lifecycle.Scoped })
    class Greeter {
      constructor(@Inject(RequestIdT) private id: string) {}
      greet() {
        return `hello from ${this.id}`;
      }
    }

    @Module({ providers: [Greeter], exports: [GreeterT], shadowPolicy: 'allow' })
    class AppModule {}

    const container = Container.from(AppModule);
    const app = Fastify();

    await app.register(cerynPlugin, {
      container,
      scopeProviders: (req) => [[RequestIdT, req.id]],
    });

    app.get('/test', async (req) => {
      const greeter = req.scope.resolve(GreeterT);
      return { message: greeter.greet() };
    });

    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message).toMatch(/^hello from /);
  });

  it('disposes scope after response', async () => {
    const DisposableT = token<{ disposed: boolean }>('Disposable');
    let disposed = false;

    @Module({
      providers: [
        {
          provide: DisposableT,
          useFactory: () => ({
            disposed: false,
            dispose() {
              disposed = true;
            },
          }),
          lifecycle: Lifecycle.Scoped,
        },
      ],
      exports: [DisposableT],
      shadowPolicy: 'allow',
    })
    class AppModule {}

    const container = Container.from(AppModule);
    const app = Fastify();

    await app.register(cerynPlugin, { container });

    app.get('/test', async (req) => {
      req.scope.resolve(DisposableT);
      return { ok: true };
    });

    await app.inject({ method: 'GET', url: '/test' });
    // After response, scope should be disposed
    expect(disposed).toBe(true);
  });

  it('isolates scopes between concurrent requests', async () => {
    const CounterT = token<{ value: number }>('Counter');

    @Module({
      providers: [
        {
          provide: CounterT,
          useFactory: () => ({ value: Math.random() }),
          lifecycle: Lifecycle.Scoped,
        },
      ],
      exports: [CounterT],
      shadowPolicy: 'allow',
    })
    class AppModule {}

    const container = Container.from(AppModule);
    const app = Fastify();

    await app.register(cerynPlugin, { container });

    app.get('/test', async (req) => {
      const counter = req.scope.resolve(CounterT);
      return { value: counter.value };
    });

    const [res1, res2] = await Promise.all([
      app.inject({ method: 'GET', url: '/test' }),
      app.inject({ method: 'GET', url: '/test' }),
    ]);

    const val1 = JSON.parse(res1.body).value;
    const val2 = JSON.parse(res2.body).value;
    // Different scopes should produce different random values
    expect(val1).not.toBe(val2);
  });

  it('provides built-in RequestToken', async () => {
    const HandlerT = token<{ id: string }>('Handler');

    @Injectable({ provide: HandlerT, lifecycle: Lifecycle.Scoped })
    class Handler {
      id: string;
      constructor(@Inject(RequestToken) private req: any) {
        this.id = this.req.id;
      }
    }

    @Module({ providers: [Handler], exports: [HandlerT], shadowPolicy: 'allow' })
    class AppModule {}

    const container = Container.from(AppModule);
    const app = Fastify();

    await app.register(cerynPlugin, {
      container,
      scopeProviders: (req) => [[RequestToken, req]],
    });

    app.get('/test', async (req) => {
      const handler = req.scope.resolve(HandlerT);
      return { id: handler.id };
    });

    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBeDefined();
  });
});
