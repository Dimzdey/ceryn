import type { Scope } from '@ceryn/vault';

declare module 'fastify' {
  interface FastifyRequest {
    scope: Scope;
  }
}
