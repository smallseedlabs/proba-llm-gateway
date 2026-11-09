#!/usr/bin/env node
/**
 * Production npm audit gate (high/critical).
 *
 * Runs `npm audit --omit=dev --json` and fails on:
 *   - npm audit tool/network errors
 *   - any high/critical GHSA not listed in scripts/prod-audit-baseline.json
 *   - a baseline GHSA that is no longer reported (so the allow-list cannot rot)
 *
 * After Fastify 5.12.8 + protocol v0.6.0 / Zod 4.6.7 the baseline is empty.
 * This is not Hub's warning-only job: extra advisories fail the build.
 * Do not broaden scripts/prod-audit-baseline.json.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const baselinePath = join(here, 'prod-audit-baseline.json');

function ghsaIdsFromAudit(report) {
  const ids = new Set();
  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    const severity = String(vuln.severity ?? '');
    if (severity !== 'high' && severity !== 'critical') continue;
    for (const via of Array.isArray(vuln.via) ? vuln.via : []) {
      if (via && typeof via === 'object' && typeof via.url === 'string') {
        const id = via.url.replace('https://github.com/advisories/', '');
        if (id.startsWith('GHSA-')) ids.add(id);
      }
    }
  }
  return ids;
}

export function evaluateProdAudit(report, baselineIds, auditExitCode) {
  const errors = [];
  if (auditExitCode !== 0 && auditExitCode !== 1) {
    errors.push(`npm audit failed with exit ${auditExitCode} (install/network/tool error)`);
    return { errors, found: [] };
  }
  const found = [...ghsaIdsFromAudit(report)].sort();
  const baseline = new Set(baselineIds);
  const extra = found.filter((id) => !baseline.has(id));
  const stale = [...baseline].filter((id) => !found.includes(id)).sort();
  if (extra.length > 0) {
    errors.push(`new high+ production advisories (not in baseline): ${extra.join(', ')}`);
  }
  if (stale.length > 0) {
    errors.push(`baseline GHSA no longer reported — remove from scripts/prod-audit-baseline.json: ${stale.join(', ')}`);
  }
  const critical = report.metadata?.vulnerabilities?.critical ?? 0;
  if (critical > 0 && extra.length === 0) {
    const criticalIds = [];
    for (const vuln of Object.values(report.vulnerabilities ?? {})) {
      if (vuln.severity !== 'critical') continue;
      for (const via of Array.isArray(vuln.via) ? vuln.via : []) {
        if (via && typeof via === 'object' && typeof via.url === 'string') {
          criticalIds.push(via.url.replace('https://github.com/advisories/', ''));
        }
      }
    }
    const unexpectedCritical = criticalIds.filter((id) => !baseline.has(id));
    if (unexpectedCritical.length > 0) {
      errors.push(`critical production advisories: ${unexpectedCritical.join(', ')}`);
    }
  }
  return { errors, found };
}

function main() {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) {
    console.error(`npm audit could not start: ${result.error.message}`);
    process.exit(1);
  }
  let report;
  try {
    report = JSON.parse(result.stdout || '{}');
  } catch {
    console.error('npm audit did not return JSON.');
    if (result.stderr) console.error(result.stderr.slice(0, 2000));
    process.exit(1);
  }
  const { errors, found } = evaluateProdAudit(report, baseline.github_advisory_ids, result.status ?? 1);
  const summary = report.metadata?.vulnerabilities ?? {};
  console.log(
    `Production audit: critical=${summary.critical ?? 0} high=${summary.high ?? 0} ` +
      `moderate=${summary.moderate ?? 0} low=${summary.low ?? 0}`
  );
  console.log(`High+ GHSA ids: ${found.join(', ') || '(none)'}`);
  if (errors.length > 0) {
    console.error('\nProduction audit FAILED:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  if (found.length > 0) {
    console.log('Baseline high+ advisories still present. New IDs would fail this job.');
  } else {
    console.log('No high+ production advisories.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
