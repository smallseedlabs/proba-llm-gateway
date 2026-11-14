/**
 * GET/PUT /v1/admin/guardrails — operator editor used by the Portal.
 *
 * Auth is the same pattern as the audit-api and memory-api admin endpoints:
 * a verified Firebase ID token whose email is on GATEWAY_ADMIN_EMAILS.
 * Hub service tokens are not accepted (the caller allowlists are not widened).
 * Writes are tighten-only, audited as config.changed, and reload in-memory state.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { IdentityRejectedError } from '../ports/auth.js';
import { AdminAuthorizationError, type AdminAuth, type AdminSession } from '../auth/admin-auth.js';
import { ConfigError } from '../errors.js';
import { buildAuditEvent, getAuditActionInfo } from '../protocol.js';
import { redactDetails } from '../redact.js';
import { GATEWAY_SERVICE_NAME } from '../types/config.js';
import { GuardrailsController, type GuardrailsSnapshot } from '../guardrails/snapshot.js';
import type { AuditPublisher } from '../ports/audit-publisher.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../logger.js';
import type { GatewayServiceConfig } from '../types/config.js';
import { SlidingWindowRateLimiter } from './rate-limit.js';

export interface AdminRouteDeps {
  config: GatewayServiceConfig;
  adminAuth?: AdminAuth;
  audit: AuditPublisher;
  clock: Clock;
  logger: Logger;
  guardrailsEnv?: NodeJS.ProcessEnv;
}

const PATH = '/v1/admin/guardrails';

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function errorBody(code: string, message: string): { error: string; message: string } {
  return { error: code, message };
}

export function applyAdminCors(request: FastifyRequest, reply: FastifyReply, origins: readonly string[]): void {
  const origin = header(request, 'origin');
  if (!origin || !origins.includes(origin)) return;
  reply.header('Access-Control-Allow-Origin', origin);
  reply.header('Vary', 'Origin');
  reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  reply.header('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  reply.header('Access-Control-Max-Age', '600');
}

async function auditDenied(
  deps: AdminRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  workspaceId = 'unknown'
): Promise<FastifyReply> {
  const info = getAuditActionInfo('auth.denied');
  const event = buildAuditEvent({
    traceId: randomUUID(),
    workspaceId,
    actor: { type: 'service', id: GATEWAY_SERVICE_NAME },
    service: GATEWAY_SERVICE_NAME,
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
    // Fail closed on the request; do not log token material.
  }
  return reply.status(status).send(errorBody(code, message));
}

async function auditChanged(
  deps: AdminRouteDeps,
  session: AdminSession,
  before: GuardrailsSnapshot,
  after: GuardrailsSnapshot
): Promise<void> {
  const info = getAuditActionInfo('config.changed');
  const changedLimits = Object.keys(after.fileLimits).concat(Object.keys(before.fileLimits)).filter((key, i, all) => {
    if (all.indexOf(key) !== i) return false;
    const k = key as keyof typeof after.fileLimits;
    return before.fileLimits[k] !== after.fileLimits[k];
  });
  const changedVerbs = after.verbs
    .filter((verb) => before.verbs.find((b) => b.name === verb.name)?.file !== verb.file)
    .map((verb) => verb.name);
  await deps.audit.publish(
    buildAuditEvent({
      traceId: randomUUID(),
      workspaceId: deps.config.admin.workspaceId,
      actor: { type: 'user', id: session.subject },
      service: GATEWAY_SERVICE_NAME,
      action: 'config.changed',
      category: info?.category ?? 'config',
      outcome: 'success',
      riskLevel: info?.riskLevel ?? 'medium',
      occurredAt: deps.clock.isoNow(),
      details: redactDetails({
        target: 'guardrails',
        fromVersion: before.fileVersion,
        toVersion: after.fileVersion,
        changedLimits,
        changedVerbs,
      }),
    })
  );
}

async function authenticateAdmin(
  deps: AdminRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<AdminSession | FastifyReply> {
  if (!deps.adminAuth) {
    return reply.status(503).send(errorBody('admin_unconfigured', 'the guardrails admin API is not configured'));
  }
  try {
    return await deps.adminAuth.authenticate({ authorization: header(request, 'authorization') });
  } catch (err) {
    if (err instanceof AdminAuthorizationError) {
      return auditDenied(deps, request, reply, 403, err.reason, err.message, deps.config.admin.workspaceId);
    }
    if (err instanceof IdentityRejectedError) {
      return auditDenied(deps, request, reply, 401, err.code, 'administrator token was rejected');
    }
    deps.logger.error({ err: err instanceof Error ? err.name : 'error' }, 'admin auth verifier unavailable');
    return reply.status(503).send(errorBody('auth_unavailable', 'caller verification unavailable'));
  }
}

export async function registerAdminGuardrails(app: FastifyInstance, deps: AdminRouteDeps): Promise<void> {
  const origins = deps.config.admin.corsOrigins;
  const controller = new GuardrailsController(deps.config, deps.guardrailsEnv ?? process.env);
  // Per-email window after auth; @fastify/rate-limit covers the IP dimension that CodeQL models.
  const emailLimiter = new SlidingWindowRateLimiter(deps.config.limits.rateLimitMax, deps.config.limits.rateLimitWindowMs);

  const rateLimited = (reply: FastifyReply) =>
    reply.status(429).send(errorBody('rate_limited', 'caller exceeded the request rate limit'));

  await app.register(async (scope) => {
    await scope.register(rateLimit, {
      global: true,
      max: deps.config.limits.rateLimitMax,
      timeWindow: deps.config.limits.rateLimitWindowMs,
      errorResponseBuilder: () => ({
        statusCode: 429,
        error: 'rate_limited',
        message: 'caller exceeded the request rate limit',
      }),
    });

    scope.options(PATH, { config: { rateLimit: false } }, async (request, reply) => {
      applyAdminCors(request, reply, origins);
      return reply.status(204).send();
    });

    scope.get(PATH, async (request, reply) => {
      applyAdminCors(request, reply, origins);
      const sessionOrReply = await authenticateAdmin(deps, request, reply);
      if (!('email' in sessionOrReply)) return sessionOrReply;
      if (!emailLimiter.allow(`admin:${sessionOrReply.email}`)) return rateLimited(reply);
      return reply.status(200).send(controller.snapshot());
    });

    scope.put(PATH, async (request, reply) => {
      applyAdminCors(request, reply, origins);
      const sessionOrReply = await authenticateAdmin(deps, request, reply);
      if (!('email' in sessionOrReply)) return sessionOrReply;
      const session = sessionOrReply;
      if (!emailLimiter.allow(`admin:${session.email}`)) return rateLimited(reply);
      const before = controller.snapshot();
      try {
        const after = controller.replace(request.body);
        await auditChanged(deps, session, before, after);
        return reply.status(200).send(after);
      } catch (err) {
        if (err instanceof ConfigError) {
          const info = getAuditActionInfo('config.changed');
          try {
            await deps.audit.publish(
              buildAuditEvent({
                traceId: randomUUID(),
                workspaceId: deps.config.admin.workspaceId,
                actor: { type: 'user', id: session.subject },
                service: GATEWAY_SERVICE_NAME,
                action: 'config.changed',
                category: info?.category ?? 'config',
                outcome: 'denied',
                errorCode: 'guardrails_rejected',
                riskLevel: info?.riskLevel ?? 'medium',
                occurredAt: deps.clock.isoNow(),
                details: redactDetails({ target: 'guardrails', reason: err.message }),
              })
            );
          } catch {
            // Still fail closed on the request.
          }
          return reply.status(400).send(errorBody('guardrails_rejected', err.message));
        }
        deps.logger.error({ err: err instanceof Error ? err.name : 'error' }, 'guardrails write failed');
        return reply.status(500).send(errorBody('internal', 'internal error'));
      }
    });
  });
}
