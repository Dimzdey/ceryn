# @ceryn/fastify

Fastify plugin for [@ceryn/vault](https://www.npmjs.com/package/@ceryn/vault) — per-request scoped dependency injection.

## Installation

```bash
npm install @ceryn/vault @ceryn/fastify fastify
```

## Usage

```typescript
import Fastify from 'fastify';
import { Container, Injectable, Inject, Module, Lifecycle, token } from '@ceryn/vault';
import { cerynPlugin, RequestToken } from '@ceryn/fastify';

// Define tokens
const UserServiceT = token<UserService>('UserService');
const RequestIdT = token<string>('RequestId');

// Define providers
@Injectable({ provide: UserServiceT, lifecycle: Lifecycle.Scoped })
class UserService {
  constructor(@Inject(RequestIdT) private reqId: string) {}
  getUser(id: string) {
    return { id, requestId: this.reqId };
  }
}

// Define module
@Module({ providers: [UserService], exports: [UserServiceT] })
class AppModule {}

// Wire up
const container = Container.from(AppModule);
const app = Fastify();

app.register(cerynPlugin, {
  container,
  scopeProviders: (req) => [
    [RequestIdT, req.id],
    [RequestToken, req],
  ],
});

// Use in routes
app.get('/users/:id', async (req) => {
  const userService = req.scope.resolve(UserServiceT);
  return userService.getUser(req.params.id);
});

app.listen({ port: 3000 });
```

## How it works

1. **`onRequest`** — Creates a new scope from your container, provides request-specific values
2. **Route handler** — Access `req.scope.resolve(Token)` to get scoped instances
3. **`onResponse`** — Automatically disposes the scope (LIFO cleanup of all scoped resources)
4. **`onError`** — Also disposes on error to prevent resource leaks
5. **`onClose`** — Disposes the container on server shutdown (cleans up singletons)

## Options

```typescript
app.register(cerynPlugin, {
  // Required: your DI container
  container: Container.from(AppModule),

  // Optional: provide request-specific values to each scope
  scopeProviders: (req) => [
    [RequestIdToken, req.id],
    [RequestToken, req],
  ],
});
```

## Built-in Tokens

- `RequestToken` — token for the Fastify request object
- `ReplyToken` — token for the Fastify reply object

## Type Safety

`req.scope` is fully typed via module augmentation. Your IDE will autocomplete `resolve()`, `provide()`, `has()`, etc.

## License

MIT
