import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { IdentityRejectedError } from '../ports/auth.js';
import type { ServiceAuth, VerifiedCaller } from '../ports/auth.js';
import { LlmClientError } from '../ports/llm-client.js';
import { LoopCoordinator } from '../loop/coordinator.js';
import {
  AmbiguousOutcomeError,
  ConfigError,
  HostRefusedError,
  IdempotencyConflictError,
  NotImplementedError,
  RequestValidationError,
  RunAbortedError,
  RunNotFoundError,
  WorkspaceScopeError,
} from '../errors.js';
import { hubRunRequestSchema, runCancelRequestSchema } from '../types/run.js';
import type { GatewayServiceConfig } from '../types/config.js';
import { GATEWAY_SERVICE_NAME } from '../types/config.js';
import { buildAuditEvent, getAuditActionInfo } from '../protocol.js';
import type { AuditPublisher } from '../ports/audit-publisher.js';
import type { Clock } from '../ports/clock.js';
import { redactDetails } from '../redact.js';
import type { Logger } from '../logger.js';
import type { RunSnapshot } from '../types/run.js';
import { SlidingWindowRateLimiter } from './rate-limit.js';

export const SERVICE_NAME = GATEWAY_SERVICE_NAME;

export interface AppDeps {
  config: GatewayServiceConfig;
  coordinator: LoopCoordinator;
  auth: ServiceAuth;
  audit: AuditPublisher;
  clock: Clock;
  logger: Logger;
  ready?: () => Promise<Record<string, 'ok' | 'fail'>>;
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function errorBody(code: string, message: string): { error: string; message: string } {
  return { error: code, message };
}

async function authenticate(
  deps: AppDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<VerifiedCaller | FastifyReply> {
  try {
    return await deps.auth.authenticate({ authorization: header(request, 'authorization') });
  } catch (err) {
    if (err instanceof IdentityRejectedError) {
      return deny(deps, request, reply, 401, err.code, 'service token was rejected');
    }
    deps.logger.error({ err: err instanceof Error ? err.name : 'error' }, 'auth verifier unavailable');
    return reply.status(503).send(errorBody('auth_unavailable', 'caller verification unavailable'));
  }
}

async function deny(
  deps: AppDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  workspaceId = 'unknown'
): Promise<FastifyReply> {
  const info = getAuditActionInfo('auth.denied');
  const event = buildAuditEvent({
    traceId: '00000000-0000-4000-8000-000000000000',
    workspaceId,
    actor: { type: 'service', id: SERVICE_NAME },
    service: SERVICE_NAME,
    action: 'auth.denied',
    category: info?.category ?? 'auth',
    outcome: 'denied',
    errorCode: code,
    riskLevel: info?.riskLevel,
    occurredAt: deps.clock.isoNow(),
    details: redactDetails({ path: request.url, method: request.method }),
  });
  try {
    await deps.audit.publish(event);
  } catch {
    // Still fail closed on the request; do not log token material.
  }
  return reply.status(status).send(errorBody(code, message));
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const limiter = new SlidingWindowRateLimiter(deps.config.limits.rateLimitMax, deps.config.limits.rateLimitWindowMs);
  const app = Fastify({
    logger: false,
    bodyLimit: deps.config.limits.maxRequestBytes,
    trustProxy: false,
  });

  app.get('/health', async () => ({ status: 'ok', service: SERVICE_NAME }));

  app.get('/ready', async (_request, reply) => {
    const checks = deps.ready ? await deps.ready() : { config: 'ok' as const };
    const ready = Object.values(checks).every((v) => v === 'ok');
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      service: SERVICE_NAME,
      checks,
    });
  });

  app.post('/v1/runs', async (request, reply) => {
    const callerOrReply = await authenticate(deps, request, reply);
    if (!('issuer' in callerOrReply)) return callerOrReply;
    const caller = callerOrReply;

    if (!limiter.allow(`${caller.issuer}\n${caller.subject}`)) {
      return reply.status(429).send(errorBody('rate_limited', 'caller exceeded the request rate limit'));
    }

    const parsed = hubRunRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(errorBody('invalid_request', parsed.error.issues[0]?.message ?? 'invalid request'));
    }
    const body = parsed.data;
    const controller = new AbortController();
    request.raw.on('close', () => controller.abort());
    try {
      const snapshot = await deps.coordinator.start(body, caller, controller.signal);
      logRunOutcome(deps, snapshot, body.traceId);
      return reply.status(200).send(snapshot);
    } catch (err) {
      return mapRunError(deps, reply, err, body.traceId);
    }
  });

  app.get('/v1/runs/:runId', async (request, reply) => {
    const callerOrReply = await authenticate(deps, request, reply);
    if (!('issuer' in callerOrReply)) return callerOrReply;
    const runId = (request.params as { runId: string }).runId;
    try {
      const snapshot = await deps.coordinator.get(runId, callerOrReply);
      return reply.status(200).send(snapshot);
    } catch (err) {
      return mapRunError(deps, reply, err);
    }
  });

  app.post('/v1/runs/:runId/cancel', async (request, reply) => {
    const callerOrReply = await authenticate(deps, request, reply);
    if (!('issuer' in callerOrReply)) return callerOrReply;
    const parsed = runCancelRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorBody('invalid_request', parsed.error.issues[0]?.message ?? 'invalid request'));
    }
    const runId = (request.params as { runId: string }).runId;
    try {
      const snapshot = await deps.coordinator.cancel(runId, parsed.data.reason, callerOrReply);
      return reply.status(200).send(snapshot);
    } catch (err) {
      return mapRunError(deps, reply, err);
    }
  });

  return app;
}

/**
 * A blocked run is a deliberate refusal (no paid call). It is already audited as policy.denied; this puts the
 * same reason in the container log so an operator sees it next to the Hub's error. Only capability names,
 * states and gateway policy messages are logged, never request content or tokens.
 */
export function blockedRunLogFields(snapshot: RunSnapshot, traceId?: string): Record<string, unknown> | null {
  if (snapshot.status !== 'blocked') return null;
  const needs = (snapshot.needs ?? []).flatMap((n) => {
    if (!n || typeof n !== 'object') return [];
    const need = n as Record<string, unknown>;
    return [
      {
        capability: typeof need.capability === 'string' ? need.capability : undefined,
        state: typeof need.state === 'string' ? need.state : undefined,
        message: typeof need.message === 'string' ? need.message.slice(0, 300) : undefined,
      },
    ];
  });
  return { runId: snapshot.runId, traceId, errorCode: snapshot.error?.code, reason: snapshot.error?.message?.slice(0, 300), needs };
}

function logRunOutcome(deps: AppDeps, snapshot: RunSnapshot, traceId?: string): void {
  const fields = blockedRunLogFields(snapshot, traceId);
  if (fields) deps.logger.warn(fields, 'run blocked by preflight');
}

function mapRunError(deps: AppDeps, reply: FastifyReply, err: unknown, traceId?: string): FastifyReply {
  if (err instanceof NotImplementedError) {
    return reply.status(501).send(errorBody(err.code, err.message));
  }
  if (err instanceof RequestValidationError || err instanceof HostRefusedError) {
    return reply.status(400).send(errorBody(err.code, err.message));
  }
  if (err instanceof WorkspaceScopeError) {
    return reply.status(403).send(errorBody(err.code, err.message));
  }
  if (err instanceof RunNotFoundError) {
    return reply.status(404).send(errorBody(err.code, err.message));
  }
  if (err instanceof IdempotencyConflictError) {
    return reply.status(409).send(errorBody(err.code, err.message));
  }
  if (err instanceof AmbiguousOutcomeError) {
    return reply.status(504).send(errorBody(err.code, err.message));
  }
  if (err instanceof RunAbortedError) {
    return reply.status(409).send(errorBody(err.code, err.message));
  }
  if (err instanceof LlmClientError) {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
    return reply.status(status).send(errorBody(err.code, err.message));
  }
  if (err instanceof ConfigError) {
    return reply.status(500).send(errorBody('config_invalid', 'service misconfigured'));
  }
  deps.logger.error({ err: err instanceof Error ? err.name : 'error', traceId }, 'run failed');
  return reply.status(500).send(errorBody('internal', 'internal error'));
}
