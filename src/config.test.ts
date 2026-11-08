import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { ConfigError } from './errors.js';

describe('loadConfig', () => {
  it('refuses vendor LLM keys in this process', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', DEEPSEEK_API_KEY: 'secret' })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: 'test', LLM_API_KEY: 'secret' })).toThrow(/vendor keys do not belong/);
  });

  it('refuses public ingress', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', INGRESS_PUBLIC: 'true' })).toThrow(/no public ingress/);
  });

  it('defaults research HTTP fetch to off so citations cannot be invented', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).research.httpFetchEnabled).toBe(false);
    expect(loadConfig({ NODE_ENV: 'test', RESEARCH_HTTP_FETCH: 'true' }).research.httpFetchEnabled).toBe(true);
  });

  it('defaults unknown quota to allow_with_run_budget and rejects an invalid policy', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).llm.quotaUnknownPolicy).toBe('allow_with_run_budget');
    expect(loadConfig({ NODE_ENV: 'test', LLM_QUOTA_UNKNOWN_POLICY: 'refuse' }).llm.quotaUnknownPolicy).toBe('refuse');
    expect(() => loadConfig({ NODE_ENV: 'test', LLM_QUOTA_UNKNOWN_POLICY: 'invent_zero' })).toThrow(
      /LLM_QUOTA_UNKNOWN_POLICY/
    );
  });
});
