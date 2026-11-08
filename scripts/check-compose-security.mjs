#!/usr/bin/env node
/**
 * CI guard for docker-compose.yml and deploy/stack.yml. Does not start containers.
 *
 * Fails when:
 *   - a published port is not bound to 127.0.0.1
 *   - RESEARCH_HTTP_FETCH is missing or not "false"
 *   - vendor LLM keys appear
 *   - a password/secret has a default instead of ${NAME:?...}
 *   - the Swarm stack publishes a port
 *   - resolved compose (docker compose config) disagrees
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LOOPBACK = '127.0.0.1';
const SECRET_NAME = /(PASSWORD|PASSWD|SECRET|HMAC_?KEY|API_?KEY|PRIVATE_?KEY)/i;
const REQUIRED = /\$\{([A-Za-z_][A-Za-z0-9_]*):\?[^}]*\}/g;
const DEFAULTED = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-+])/g;
const URL_PASSWORD = /[a-z][a-z0-9+.-]*:\/\/[^:/\s@]*:([^@\s/]+)@/gi;
const VENDOR_KEY = /\b(DEEPSEEK_API_KEY|LLM_API_KEY)\b/;

function withoutComments(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');
}

export function checkComposeText(text, label) {
  const violations = [];
  const body = withoutComments(text);
  if (!/RESEARCH_HTTP_FETCH:\s*"false"/.test(text)) {
    violations.push(`${label}: RESEARCH_HTTP_FETCH must be exactly "false"`);
  }
  if (/RESEARCH_HTTP_FETCH:\s*"?true"?/.test(text)) {
    violations.push(`${label}: RESEARCH_HTTP_FETCH must not be enabled`);
  }
  if (VENDOR_KEY.test(body)) {
    violations.push(`${label}: vendor LLM keys do not belong in this process`);
  }
  const required = new Set();
  for (const m of body.matchAll(REQUIRED)) required.add(m[1]);
  const masked = body.replace(REQUIRED, '\u0000');
  for (const m of masked.matchAll(DEFAULTED)) {
    if (SECRET_NAME.test(m[1])) {
      violations.push(`${label}: "${m[1]}" has a default; use \${${m[1]}:?set ${m[1]}}`);
    }
  }
  for (const m of masked.matchAll(URL_PASSWORD)) {
    if (m[1] !== '\u0000') {
      violations.push(`${label}: a URL carries a literal password; take it from a \${NAME:?...} variable`);
    }
  }
  return { violations, required: [...required].sort() };
}

export function checkComposePublish(composeText) {
  const violations = [];
  if (!composeText.includes('127.0.0.1:3700:3700')) {
    violations.push('docker-compose.yml: gateway must publish 127.0.0.1:3700:3700 only');
  }
  for (const line of composeText.split('\n')) {
    const m = line.match(/^\s*-\s*"?([0-9.*]+):(\d+):(\d+)"?/);
    if (!m) continue;
    if (m[1] !== LOOPBACK) {
      violations.push(`docker-compose.yml: published port ${m[1]}:${m[2]}:${m[3]} is not bound to ${LOOPBACK}`);
    }
  }
  if (/^\s*-\s*"?\d+:\d+"?/m.test(composeText)) {
    violations.push('docker-compose.yml: a published port has no host IP (defaults to 0.0.0.0)');
  }
  return violations;
}

export function checkStackText(stackText) {
  const violations = [];
  if (/^\s+ports:/m.test(stackText)) {
    violations.push('deploy/stack.yml must not publish ports (overlay-only)');
  }
  return violations;
}

export function checkGatewayComposeFiles(composeText, stackText) {
  const compose = checkComposeText(composeText, 'docker-compose.yml');
  const stack = checkComposeText(stackText, 'deploy/stack.yml');
  const violations = [
    ...compose.violations,
    ...stack.violations,
    ...checkComposePublish(composeText),
    ...checkStackText(stackText),
  ];
  if (compose.required.length === 0) {
    violations.push('docker-compose.yml: no ${NAME:?...} variable found');
  }
  return { violations, required: compose.required };
}

function composeConfig(file, { cwd, envFile, vars }) {
  return spawnSync('docker', ['compose', '-f', file, '--env-file', envFile, 'config', '--format', 'json'], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '', ...vars },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

export function checkResolvedCompose(file, required) {
  const violations = [];
  const dir = mkdtempSync(join(tmpdir(), 'gw-compose-check-'));
  const emptyEnv = join(dir, 'empty.env');
  writeFileSync(emptyEnv, '');
  const jwks = join(dir, 'jwks.json');
  const key = join(dir, 'key.pem');
  writeFileSync(jwks, '{"keys":[]}\n');
  writeFileSync(key, '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n');
  const vars = Object.fromEntries(required.map((name) => [name, `sentinel-${name.toLowerCase()}`]));
  for (const name of required) {
    if (name.endsWith('_FILE')) vars[name] = name.includes('KEY') ? key : jwks;
  }
  const cwd = resolve(file, '..');
  const full = composeConfig(file, { cwd, envFile: emptyEnv, vars });
  if (full.status !== 0) {
    violations.push(`docker compose config failed: ${(full.stderr || full.stdout || '').trim().split('\n').pop()}`);
    return violations;
  }
  const config = JSON.parse(full.stdout);
  for (const [name, service] of Object.entries(config.services ?? {})) {
    if (service.network_mode === 'host') {
      violations.push(`${name}: network_mode host exposes every port of the container`);
    }
    for (const port of service.ports ?? []) {
      if (port.host_ip !== LOOPBACK) {
        violations.push(
          `${name}: port ${port.published ?? '(random)'}:${port.target} is bound to ${port.host_ip ?? '0.0.0.0'}, not ${LOOPBACK}`
        );
      }
    }
    const env = service.environment ?? {};
    if (env.DEEPSEEK_API_KEY || env.LLM_API_KEY) {
      violations.push(`${name}: vendor LLM keys resolved in compose`);
    }
  }
  const gateway = config.services?.gateway;
  if (!gateway) {
    violations.push('resolved compose has no gateway service');
  } else if (String(gateway.environment?.RESEARCH_HTTP_FETCH) !== 'false') {
    violations.push(
      `gateway: resolved RESEARCH_HTTP_FETCH is ${JSON.stringify(gateway.environment?.RESEARCH_HTTP_FETCH)}, not false`
    );
  }
  return violations;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const composeFile = resolve(process.argv[2] ?? join(root, 'docker-compose.yml'));
  const stackFile = resolve(process.argv[3] ?? join(root, 'deploy/stack.yml'));
  const { violations, required } = checkGatewayComposeFiles(
    readFileSync(composeFile, 'utf8'),
    readFileSync(stackFile, 'utf8')
  );
  violations.push(...checkResolvedCompose(composeFile, required));
  if (violations.length > 0) {
    console.error('compose security check FAILED:');
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(
    `compose security check passed: loopback ports, RESEARCH_HTTP_FETCH=false, no vendor keys (${required.length} required: ${required.join(', ')})`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
