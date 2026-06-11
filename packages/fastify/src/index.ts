import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Scope, Token } from '@ceryn/vault';

/**
 * Token/value pair for scope-local registrations.
 */
export type ScopeProvider<T = unknown> = [Token<T>, T];

/**
 * Options for the ceryn Fastify plugin.
 */
export interface CerynPluginOptions extends FastifyPluginOptions {
  /**
   * The vault container instance (from Container.from()).
   * Must have a createScope() method.
   */
  container: { createScope(): Scope; dispose(): void | Promise<void> };

  /**
   * Optional function that provides request-specific values to each scope.
   * Called on every request with the Fastify request object.
   * Return an array of [token, value] pairs to provide to the scope.
   */
  scopeProviders?: (req: FastifyRequest) => ScopeProvider[];
}

/**
 * Built-in tokens for accessing the raw Fastify request and reply.
 */
export { RequestToken, ReplyToken } from './tokens.js';

async function cerynPluginFn(fastify: FastifyInstance, opts: CerynPluginOptions): Promise<void> {
  const { container, scopeProviders } = opts;

  // Decorate request with scope
  fastify.decorateRequest('scope', undefined as unknown as Scope);

  // Create scope on each request
  fastify.addHook('onRequest', async (req) => {
    const scope = container.createScope();

    // Provide user-defined scope-local values
    if (scopeProviders) {
      const providers = scopeProviders(req);
      for (let i = 0; i < providers.length; i++) {
        const [token, value] = providers[i];
        scope.provide(token, value);
      }
    }

    req.scope = scope;
  });

  // Dispose scope after response (even on errors)
  fastify.addHook('onResponse', async (req) => {
    if (req.scope && !req.scope.isDisposed) {
      await req.scope.dispose();
    }
  });

  // Also dispose on error to prevent leaks
  fastify.addHook('onError', async (req) => {
    if (req.scope && !req.scope.isDisposed) {
      await req.scope.dispose();
    }
  });

  // Graceful shutdown: dispose container singletons
  fastify.addHook('onClose', async () => {
    await container.dispose();
  });
}

/**
 * Fastify plugin that integrates @ceryn/vault with per-request scoped injection.
 *
 * Creates a new scope for each incoming request, provides optional request-specific
 * values, and automatically disposes the scope after the response (or on error).
 *
 * @example
 * ```typescript
 * import Fastify from 'fastify';
 * import { Container, Module, Injectable, token } from '@ceryn/vault';
 * import { cerynPlugin } from '@ceryn/fastify';
 *
 * const app = Fastify();
 * const container = Container.from(AppModule);
 *
 * app.register(cerynPlugin, {
 *   container,
 *   scopeProviders: (req) => [[RequestIdToken, req.id]],
 * });
 *
 * app.get('/', async (req) => {
 *   const service = req.scope.resolve(MyServiceToken);
 *   return service.getData();
 * });
 * ```
 */
export const cerynPlugin = fp(cerynPluginFn, {
  fastify: '>=4.0.0',
  name: '@ceryn/fastify',
});
