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
  it('passes a clean high+ report against the empty post-remediation baseline', () => {
    expect(baseline.github_advisory_ids).toEqual([]);
    const ok = evaluateProdAudit({ metadata: { vulnerabilities: { critical: 0, high: 0 } }, vulnerabilities: {} }, [], 0);
    expect(ok.errors).toEqual([]);
    expect(ok.found).toEqual([]);
  });

  it('fails on a new high GHSA rather than growing the allowlist', () => {
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
  });

  it('fails when a listed baseline GHSA is no longer reported (allowlist cannot rot)', () => {
    const stale = evaluateProdAudit(
      { metadata: { vulnerabilities: { critical: 0, high: 0 } }, vulnerabilities: {} },
      ['GHSA-mrhx-c7xc-m3w5'],
      0
    );
    expect(stale.errors.some((e) => e.includes('no longer reported'))).toBe(true);
  });

  it('fails when npm audit itself cannot run', () => {
    const out = evaluateProdAudit({}, baseline.github_advisory_ids, 2);
    expect(out.errors.some((e) => /exit 2/.test(e))).toBe(true);
  });
});
