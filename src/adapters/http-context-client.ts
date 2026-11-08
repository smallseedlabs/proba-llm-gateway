/**
 * HTTP adapter for the context bridge POST /v1/context/build.
 * Request/response are protocol ContextRequest / ContextPacket.
 * Authorization is the Hub act-as assertion, same as Hub's HttpContextClient.
 */

import { validateContextPacket, type ContextPacket, type ContextRequest } from '../protocol.js';
import { ContextClientError, type ContextBuildOptions, type ContextPort } from '../ports/context.js';
import { assertAllowedBaseUrl, trimBaseUrl } from '../http/allowlist.js';

export interface HttpContextClientOptions {
  baseUrl: string;
  allowedHosts: readonly string[];
  nodeEnv: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class HttpContextClient implements ContextPort {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpContextClientOptions) {
    const url = assertAllowedBaseUrl(options.baseUrl, options.allowedHosts, options.nodeEnv);
    this.baseUrl = trimBaseUrl(url.toString());
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async ping(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      for (const path of ['/ready', '/health'] as const) {
        try {
          const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: 'GET', signal: controller.signal });
          if (response.ok) return;
        } catch (err) {
          if (controller.signal.aborted) {
            throw new ContextClientError('timeout', 'context readiness probe timed out');
          }
          if (path === '/health') {
            throw new ContextClientError(
              'unreachable',
              err instanceof Error ? err.message : 'context bridge readiness probe failed',
              err
            );
          }
        }
      }
      throw new ContextClientError('unreachable', 'context bridge /ready and /health were not ok');
    } finally {
      clearTimeout(timer);
    }
  }

  async build(request: ContextRequest, options: ContextBuildOptions): Promise<ContextPacket> {
    if (!options.assertion) {
      throw new ContextClientError('assertion_invalid', 'act-as assertion is required for context build');
    }
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuter = () => controller.abort();
    options.signal?.addEventListener('abort', onOuter, { once: true });
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/context/build`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.assertion}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) {
        const code = response.status >= 500 ? 'http_error' : 'rejected';
        throw new ContextClientError(code, `Context bridge returned HTTP ${response.status}`, undefined, response.status);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (err) {
        throw new ContextClientError('invalid_packet', 'Context bridge returned non-JSON', err);
      }
      const parsed = validateContextPacket(body);
      if (!parsed.success) {
        throw new ContextClientError('invalid_packet', parsed.error.issues[0]?.message ?? 'invalid ContextPacket');
      }
      return parsed.data;
    } catch (err) {
      if (err instanceof ContextClientError) throw err;
      if (controller.signal.aborted) throw new ContextClientError('timeout', 'context build timed out or was cancelled');
      throw new ContextClientError('unreachable', err instanceof Error ? err.message : 'context bridge unreachable', err);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onOuter);
    }
  }
}
