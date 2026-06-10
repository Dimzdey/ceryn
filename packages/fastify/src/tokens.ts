import type { FastifyReply, FastifyRequest } from 'fastify';
import { token } from '@ceryn/vault';

/**
 * Token for injecting the current Fastify request object.
 * Automatically provided per-request when using scopeProviders.
 */
export const RequestToken = token<FastifyRequest>('FastifyRequest');

/**
 * Token for injecting the current Fastify reply object.
 * Automatically provided per-request when using scopeProviders.
 */
export const ReplyToken = token<FastifyReply>('FastifyReply');
