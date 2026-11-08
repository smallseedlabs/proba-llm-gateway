import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const baseline = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'prod-audit-baseline.json'), 'utf8')
) as { github_advisory_ids: string[] };

const { evaluateProdAudit } = (await import(new URL('./assert-prod-audit.mjs', import.meta.url).href)) as {
  evaluateProdAudit: (
    report: unknown,
    baselineIds: string[],
    auditExitCode: number
  ) => { errors: string[]; found: string[] };
};

describe('production audit gate', () => {
  it('passes the current fastify4/zod3 baseline and fails on a new high GHSA', () => {
    const report = {
      metadata: { vulnerabilities: { critical: 0, high: 1 } },
      vulnerabilities: {
        zod: {
          severity: 'high',
          via: [{ url: 'https://github.com/advisories/GHSA-mrhx-c7xc-m3w5' }],
        },
      },
    };
    const ok = evaluateProdAudit(report, ['GHSA-mrhx-c7xc-m3w5'], 1);
    expect(ok.errors).toEqual([]);
    expect(ok.found).toContain('GHSA-mrhx-c7xc-m3w5');
    expect(baseline.github_advisory_ids).toContain('GHSA-mrhx-c7xc-m3w5');

    const extra = evaluateProdAudit(
      {
        metadata: { vulnerabilities: { critical: 0, high: 1 } },
        vulnerabilities: {
          leftover: {
            severity: 'high',
            via: [{ url: 'https://github.com/advisories/GHSA-xxxx-xxxx-xxxx' }],
          },
        },
      },
      baseline.github_advisory_ids,
      1
    );
    expect(extra.errors.some((e) => e.includes('GHSA-xxxx-xxxx-xxxx'))).toBe(true);

    const stale = evaluateProdAudit(report, baseline.github_advisory_ids, 1);
    expect(stale.errors.some((e) => e.includes('no longer reported'))).toBe(true);
  });

  it('fails when npm audit itself cannot run', () => {
    const out = evaluateProdAudit({}, baseline.github_advisory_ids, 2);
    expect(out.errors.some((e) => /exit 2/.test(e))).toBe(true);
  });
});
