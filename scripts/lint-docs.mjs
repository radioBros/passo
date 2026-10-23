#!/usr/bin/env node
/**
 * Banned-phrase lint for documentation (DOC-003).
 *
 * PASSO is not an accredited SdI intermediary, holds no certification, and is
 * not a conservazione a norma provider. Claiming otherwise is not a wording
 * slip — an operator who believes PASSO discharges their conservation duty
 * simply will not archive their invoices, and discovers the gap during an audit
 * years later.
 *
 * Prose drifts. This makes the drift fail the build instead of shipping.
 *
 *   node scripts/lint-docs.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

/** Each rule: what is banned, and what to say instead. */
const BANNED = [
  {
    re: /\b(we are|passo is|it is)\s+(an?\s+)?accredited\b/gi,
    why: 'PASSO is NOT an accredited SdI intermediary. Say it transmits THROUGH an accredited vendor or the tenant own PEC.',
  },
  {
    re: /\bpasso\b[^.\n]{0,60}\bconservazione a norma\b/gi,
    why: 'PASSO does NOT provide conservazione a norma. That duty belongs to the CRM or its appointed provider.',
  },
  {
    re: /\bSOC ?2[- ]?(certified|compliant|attested)\b/gi,
    why: 'No SOC 2 audit has been performed. Describe the controls; never claim the attestation.',
  },
  {
    re: /\bISO ?27001[- ]?(certified|compliant)\b/gi,
    why: 'No ISO 27001 certification exists.',
  },
  {
    re: /\bGDPR[- ]?(certified|compliant)\b/gi,
    why: 'GDPR has no certification scheme for this. Describe what is held and for how long instead.',
  },
  {
    re: /\bwe guarantee\b|\bguaranteed delivery\b/gi,
    why: 'Delivery is SdI’s, and it is not guaranteed. State the actual semantics.',
  },
  {
    re: /\blegally binding\b/gi,
    why: 'Avoid asserting legal effect. State what SdI does and let the reader draw the conclusion.',
  },
  {
    re: /\bfully compliant\b/gi,
    why: 'Compliance is the operator’s, not the software’s. Name the specific control instead.',
  },
];

/**
 * Statements that MUST appear somewhere, so the scope boundary cannot quietly
 * disappear in a rewrite.
 */
const REQUIRED = [
  { file: 'docs/guide/scope.md', re: /not an accredited/i,
    why: 'the scope page must state that PASSO is not an accredited intermediary' },
  { file: 'docs/compliance/data-protection.md', re: /no certification/i,
    why: 'the data-protection page must state that PASSO holds no certification' },
  { file: 'README.md', re: /Not an accredited/i,
    why: 'the README must state the scope boundary' },
];

const roots = ['docs', 'README.md'];
const files = [];
const walk = (p) => {
  const st = statSync(p);
  if (st.isDirectory()) {
    if (p.includes('.vitepress')) return;
    for (const e of readdirSync(p)) walk(join(p, e));
  } else if (extname(p) === '.md') files.push(p);
};
for (const r of roots) { try { walk(r); } catch { /* absent */ } }

let failures = 0;
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  const lines = text.split('\n');
  for (const rule of BANNED) {
    lines.forEach((line, i) => {
      /**
       * A DENIAL is the correct usage, not a violation.
       *
       * "PASSO is not SOC 2 certified" and "carries no SOC 2 report" are
       * exactly the statements these rules exist to protect — flagging them
       * would push an author to delete the disclaimer to get a green build,
       * which is the opposite of the intent.
       */
      if (/\b(not|never|no|cannot|isn't|is not|nor|neither|any claim otherwise)\b/i.test(line)) return;
      // A line that quotes the ban itself is the rule's own documentation.
      if (/BANNED|never claim|must not say/i.test(line)) return;
      rule.re.lastIndex = 0;
      const m = rule.re.exec(line);
      if (m) {
        console.error(`${f}:${i + 1}  BANNED PHRASE "${m[0].trim()}"\n    ${rule.why}`);
        failures++;
      }
    });
  }
}

for (const req of REQUIRED) {
  let text = '';
  try { text = readFileSync(req.file, 'utf8'); } catch {
    console.error(`MISSING FILE ${req.file} — ${req.why}`);
    failures++; continue;
  }
  if (!req.re.test(text)) {
    console.error(`${req.file}  MISSING REQUIRED STATEMENT — ${req.why}`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`\n${failures} documentation problem(s). These are legal-accuracy rules, not style.`);
  process.exit(1);
}
console.error(`docs lint clean (${files.length} files)`);
