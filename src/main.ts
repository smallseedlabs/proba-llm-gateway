/**
 * Process entry. Internal HTTP only. Hub calls this gateway; the harness
 * (bounded loop) lives in this process and calls proba-llm one turn at a time.
 */

import { loadConfig } from './config.js';
import { createRuntime } from './runtime.js';
import { buildApp } from './http/app.js';
import { ConfigError } from './errors.js';
import { buildAuditEvent, getAuditActionInfo } from './protocol.js';
import { GATEWAY_SERVICE_NAME } from './types/config.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const runtime = await createRuntime(config);
  const app = await buildApp({
    config,
    coordinator: runtime.coordinator,
    auth: runtime.auth,
    adminAuth: runtime.adminAuth,
    audit: runtime.audit,
    clock: runtime.clock,
    logger: runtime.logger,
    ready: () => runtime.ready(),
  });

  await runtime.coordinator.relayPending();

  const started = getAuditActionInfo('system.started');
  await runtime.audit.publish(
    buildAuditEvent({
      traceId: '00000000-0000-4000-8000-000000000001',
      workspaceId: 'seedbed',
      actor: { type: 'service', id: GATEWAY_SERVICE_NAME },
      service: GATEWAY_SERVICE_NAME,
      action: 'system.started',
      category: started?.category ?? 'system',
      outcome: 'success',
      occurredAt: runtime.clock.isoNow(),
      details: { env: config.env, listen: `${config.listen.host}:${config.listen.port}` },
    })
  );

  await app.listen({ port: config.listen.port, host: config.listen.host });
  runtime.logger.info({ port: config.listen.port, host: config.listen.host }, 'proba-llm-gateway listening');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    runtime.logger.info({ signal }, 'shutting down');
    const stopped = getAuditActionInfo('system.stopped');
    try {
      await runtime.audit.publish(
        buildAuditEvent({
          traceId: '00000000-0000-4000-8000-000000000002',
          workspaceId: 'seedbed',
          actor: { type: 'service', id: GATEWAY_SERVICE_NAME },
          service: GATEWAY_SERVICE_NAME,
          action: 'system.stopped',
          category: stopped?.category ?? 'system',
          outcome: 'success',
          occurredAt: runtime.clock.isoNow(),
          details: { signal },
        })
      );
    } catch {
      // best-effort
    }
    try {
      await runtime.coordinator.relayPending();
    } catch {
      // outbox remains on disk for the next process
    }
    await app.close();
    await runtime.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  const message = err instanceof ConfigError ? err.message : err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
