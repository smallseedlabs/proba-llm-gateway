import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors.js';
import { MemoryAnalyticsStore } from './memory-store.js';

describe('analytics decision store', () => {
  it('refuses the in-memory adapter in production', () => {
    expect(() => new MemoryAnalyticsStore('production')).toThrow(ConfigError);
  });
});
