#!/usr/bin/env node
/**
 * npm audit, failing on high/critical — except advisories we cannot take
 * without a breaking upgrade. Add an id here only with a comment in .trivyignore.
 */
import { spawnSync } from 'node:child_process';

const ALLOW = new Set([
  'GHSA-mrhx-c7xc-m3w5', // Zod 3: fix is Zod 4
]);

const r = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8' });
const report = JSON.parse(r.stdout || '{}');
const bad = [];

for (const v of Object.values(report.vulnerabilities ?? {})) {
  if (v.severity !== 'high' && v.severity !== 'critical') continue;
  const ids = (v.via ?? [])
    .filter((x) => x && typeof x === 'object')
    .map((x) => x.url?.match(/GHSA-[a-z0-9-]+/)?.[0] ?? String(x.source ?? ''));
  if (ids.length && ids.every((id) => ALLOW.has(id))) continue;
  bad.push(`${v.name} (${v.severity}): ${ids.filter(Boolean).join(', ') || v.title || ''}`);
}

if (bad.length) {
  console.error(bad.join('\n'));
  process.exit(1);
}
console.error('audit clean (allowed: %s)', [...ALLOW].join(', ') || 'none');
