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
});
