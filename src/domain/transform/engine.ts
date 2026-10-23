import { Decimal } from 'decimal.js';
import { isValidTarget, suggestTargets } from './targets.ts';

/**
 * Transformation engine — DECLARATIVE JSON ONLY.
 *
 * Templates are authored by whoever holds a tenant API key, INCLUDING anyone
 * who stole one, and they execute on every invoice inside a process holding
 * channel credentials and database access. Any code-execution path here is
 * remote code execution.
 *
 * There is therefore no eval, no Function, no vm/vm2/isolated-vm, no template
 * engine with expression support. Only the whitelisted functions below.
 */

export class TransformError extends Error {
  readonly sourcePath: string | undefined;
  readonly targetPath: string | undefined;
  constructor(message: string, sourcePath?: string, targetPath?: string) {
    super(message);
    this.sourcePath = sourcePath;
    this.targetPath = targetPath;
  }
}

export const LIMITS = {
  maxRules: 500,
  maxChainDepth: 10,
  maxArrayItems: 10_000,
  regexTimeoutMs: 100,
  maxTemplateBytes: 256 * 1024,
} as const;

export interface TransformStep { fn: string; arg?: string | number }
export interface TransformRule {
  target: string;
  source?: string;
  literal?: string | number | boolean;
  transform?: TransformStep[];
  required?: boolean;
}
export interface Template { name: string; sourceFormat?: string; rules: TransformRule[] }

type Fn = (v: unknown, arg?: string | number) => unknown;

/**
 * Coerce a transform input to a string.
 *
 * `String(v)` on an object yields "[object Object]", which would flow silently
 * into a FatturaPA field. A CRM sending a nested object where a scalar was
 * expected is a mapping error and must surface as one.
 */
function str(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  throw new TransformError(
    `expected a scalar value, got ${Array.isArray(v) ? 'an array' : 'an object'} — ` +
    'check the source path in the mapping');
}

/** Numeric coercion with the same guarantee. */
const num = (v: unknown): string => (v === undefined || v === null ? '0' : str(v));

/** The complete whitelist. Anything not here is rejected at SAVE time. */
const FUNCTIONS: Record<string, Fn> = {
  // string
  trim: (v) => str(v).trim(),
  upper: (v) => str(v).toUpperCase(),
  lower: (v) => str(v).toLowerCase(),
  prefix: (v, a) => `${a ?? ''}${str(v)}`,
  suffix: (v, a) => `${str(v)}${a ?? ''}`,
  concat: (v, a) => `${str(v)}${a ?? ''}`,
  padStart: (v, a) => str(v).padStart(Number(a ?? 0), '0'),
  substring: (v, a) => str(v).slice(0, Number(a ?? 0)),
  // numeric — Decimal, never float
  multiply: (v, a) => new Decimal(num(v)).times(String(a ?? 1)).toString(),
  divide: (v, a) => {
    const d = new Decimal(String(a ?? 1));
    if (d.isZero()) throw new TransformError('divide by zero');
    return new Decimal(num(v)).div(d).toString();
  },
  add: (v, a) => new Decimal(num(v)).plus(String(a ?? 0)).toString(),
  subtract: (v, a) => new Decimal(num(v)).minus(String(a ?? 0)).toString(),
  abs: (v) => new Decimal(num(v)).abs().toString(),
  round: (v, a) => new Decimal(num(v)).toFixed(Number(a ?? 0)),
  // money — MANDATORY terminal step on monetary targets
  toDecimalString: (v, a) => new Decimal(num(v)).toFixed(Number(a ?? 2)),
  // date
  /**
   * Convert a date using an EXPLICIT source format (XFORM-010).
   *
   * `new Date("01/02/2026")` is the trap this exists to avoid: JavaScript reads
   * it as 2 January (US), an Italian CRM means 1 February, and the invoice
   * silently carries the wrong fiscal date. No locale inference, no
   * `new Date(string)` — the caller states the format or the rule fails.
   *
   *   dateFormat("DD/MM/YYYY")   1 February 2026 → "2026-02-01"
   *   dateFormat("MM/DD/YYYY")   2 January  2026 → "2026-01-02"
   *
   * The output is always ISO `YYYY-MM-DD`, which is what FatturaPA requires.
   */
  dateFormat: (v, a) => {
    const raw = str(v).trim();
    const fmt = String(a ?? '').trim();
    if (!fmt) {
      throw new TransformError(
        'dateFormat requires an explicit source format, e.g. dateFormat("DD/MM/YYYY") — ' +
        'guessing would read "01/02/2026" as either 1 February or 2 January');
    }

    /**
     * Already ISO — including a full timestamp — so take the date part.
     * ISO 8601 is unambiguous by construction, which is the whole reason
     * FatturaPA uses it; there is nothing to guess and nothing to declare.
     */
    const iso8601 = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/.exec(raw);
    if (iso8601) return iso8601[1]!;

    const order = fmt.toUpperCase();
    const KNOWN: Record<string, RegExp> = {
      'DD/MM/YYYY': /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
      'MM/DD/YYYY': /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
      'DD-MM-YYYY': /^(\d{1,2})-(\d{1,2})-(\d{4})$/,
      'MM-DD-YYYY': /^(\d{1,2})-(\d{1,2})-(\d{4})$/,
      'DD.MM.YYYY': /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/,
      'YYYY/MM/DD': /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/,
      'YYYYMMDD': /^(\d{4})(\d{2})(\d{2})$/,
    };
    const re = KNOWN[order];
    if (!re) {
      throw new TransformError(
        `unsupported date format "${fmt}". Supported: ${Object.keys(KNOWN).join(', ')}`);
    }
    const m = re.exec(raw);
    if (!m) throw new TransformError(`"${raw}" does not match the declared format ${fmt}`);

    let y: string; let mo: string; let d: string;
    if (order.startsWith('YYYY')) { [, y, mo, d] = m as unknown as [string, string, string, string]; }
    else if (order.startsWith('DD')) { [, d, mo, y] = m as unknown as [string, string, string, string]; }
    else { [, mo, d, y] = m as unknown as [string, string, string, string]; }

    const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    // Round-trip through UTC to reject 31 February and friends, which the
    // regex above happily accepts.
    const check = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== iso) {
      throw new TransformError(`"${raw}" is not a real date`);
    }
    return iso;
  },

  /**
   * Literal string replacement — NOT a regex.
   *
   * A regex here would be a second injection surface with its own ReDoS
   * profile, for a job that almost never needs one. `replace` takes
   * "search|replacement" and replaces every occurrence literally.
   */
  replace: (v, a) => {
    const spec = String(a ?? '');
    const sep = spec.indexOf('|');
    if (sep < 0) {
      throw new TransformError('replace takes "search|replacement", e.g. replace("Srl|S.r.l.")');
    }
    return str(v).split(spec.slice(0, sep)).join(spec.slice(sep + 1));
  },

  /**
   * Map a value through a closed table — "in:out,in:out".
   *
   * The common need is translating a CRM's own codes to FatturaPA enums
   * ("cash" → "MP01"). An unmapped value FAILS rather than passing through:
   * silently forwarding an unknown code produces an invoice SdI rejects, and
   * NS is terminal.
   */
  lookup: (v, a) => {
    const table = String(a ?? '');
    const key = str(v);
    for (const pair of table.split(',')) {
      const i = pair.indexOf(':');
      if (i > 0 && pair.slice(0, i).trim() === key) return pair.slice(i + 1).trim();
    }
    throw new TransformError(
      `lookup has no mapping for "${key}" — add it to the table or the invoice will carry ` +
      'an unmapped value');
  },

  /**
   * Coerce to a FatturaPA boolean, which is the string "SI" or "NO".
   *
   * A JSON `true` serialises to "true", which is schema-invalid.
   */
  boolean: (v) => {
    const raw = str(v).trim().toLowerCase();
    if (['true', '1', 'yes', 'si', 'sì', 'y'].includes(raw)) return 'SI';
    if (['false', '0', 'no', 'n', ''].includes(raw)) return 'NO';
    throw new TransformError(`cannot read "${str(v)}" as a boolean`);
  },
  // extraction — ReDoS-guarded
  regexExtract: (v, a) => {
    const pattern = String(a ?? '');
    assertSafeRegex(pattern);
    const started = Date.now();
    const m = new RegExp(pattern).exec(str(v));
    if (Date.now() - started > LIMITS.regexTimeoutMs) {
      throw new TransformError('regexExtract exceeded its time budget');
    }
    return m?.[1] ?? m?.[0] ?? null;
  },
  defaultTo: (v, a) => (v === undefined || v === null || v === '' ? a : v),
};

export const ALLOWED_FUNCTIONS = Object.keys(FUNCTIONS);

/** Reject the classic catastrophic-backtracking shapes at save time. */
export function assertSafeRegex(pattern: string): void {
  if (pattern.length > 200) throw new TransformError('regex too long');
  if (/(\([^)]*[+*][^)]*\)\s*[+*])|(\[[^\]]*\][+*]\s*[+*])/.test(pattern)) {
    throw new TransformError(`regex has nested quantifiers (ReDoS risk): ${pattern}`);
  }
}

/** Validate a template BEFORE it is stored. */
export function validateTemplate(t: unknown): Template {
  const tpl = t as Template;
  if (!tpl || !Array.isArray(tpl.rules)) throw new TransformError('template must have a rules array');
  if (JSON.stringify(tpl).length > LIMITS.maxTemplateBytes) {
    throw new TransformError('template exceeds the size limit');
  }
  if (tpl.rules.length > LIMITS.maxRules) {
    throw new TransformError(`template has ${tpl.rules.length} rules, limit is ${LIMITS.maxRules}`);
  }
  for (const r of tpl.rules) {
    if (!r.target) throw new TransformError('rule is missing a target');
    if (r.transform && r.transform.length > LIMITS.maxChainDepth) {
      throw new TransformError(`transform chain deeper than ${LIMITS.maxChainDepth}`, r.source, r.target);
    }
    for (const step of r.transform ?? []) {
      if (!ALLOWED_FUNCTIONS.includes(step.fn)) {
        throw new TransformError(
          `function "${step.fn}" is not whitelisted (allowed: ${ALLOWED_FUNCTIONS.join(', ')})`,
          r.source, r.target,
        );
      }
      if (step.fn === 'regexExtract') assertSafeRegex(String(step.arg ?? ''));
    }
    /**
     * The target must be a path the generator actually reads (XFORM-005).
     *
     * A rule pointing at a non-existent target writes into an object nobody
     * looks at: the field is silently absent from the XML and — if it was
     * optional — the invoice transmits missing data with no error anywhere.
     */
    if (!isValidTarget(r.target)) {
      const near = suggestTargets(r.target);
      throw new TransformError(
        `"${r.target}" is not a field of the canonical invoice model` +
        (near.length ? `. Did you mean ${near.map((n) => `"${n}"`).join(' or ')}?` : ''),
        r.source, r.target,
      );
    }

    // A monetary target must terminate in toDecimalString, or the generator
    // receives a bare number and SdI rejects the invoice.
    if (isMonetaryTarget(r.target)) {
      const last = r.transform?.[r.transform.length - 1];
      if (!last || last.fn !== 'toDecimalString') {
        throw new TransformError(
          `monetary target "${r.target}" must end with toDecimalString`, r.source, r.target,
        );
      }
      // Cents -> decimal is divide(100). multiply(100) is the classic inversion.
      if (r.transform?.some((s) => s.fn === 'multiply' && String(s.arg) === '100')) {
        throw new TransformError(
          `monetary target "${r.target}" uses multiply(100) — did you mean divide(100)? ` +
          'A CRM sending integer cents needs divide.', r.source, r.target,
        );
      }
    }
  }
  return tpl;
}

const MONETARY = /(unitPrice|totalPrice|taxableAmount|taxAmount|amount)$/i;
export const isMonetaryTarget = (t: string): boolean => MONETARY.test(t.replace(/\[\]$/, ''));

/** Read a dotted path with [] array segments. */
function readPath(src: unknown, path: string): unknown {
  let cur: unknown = src;
  for (const seg of path.split('.')) {
    if (cur === undefined || cur === null) return undefined;
    const m = /^(.+)\[\]$/.exec(seg);
    if (m) { cur = (cur as Record<string, unknown>)[m[1]!]; continue; }
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function writePath(dst: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split('.');
  let cur = dst;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i]!;
    if (typeof cur[s] !== 'object' || cur[s] === null) cur[s] = {};
    cur = cur[s] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]!] = value;
}

function applyChain(
  value: unknown, steps: TransformStep[] | undefined, r: TransformRule,
  trace?: TraceStep[],
): unknown {
  let v = value;
  for (const s of steps ?? []) {
    const fn = FUNCTIONS[s.fn];
    if (!fn) throw new TransformError(`function "${s.fn}" is not whitelisted`, r.source, r.target);
    const before = v;
    try { v = s.arg === undefined ? fn(v) : fn(v, s.arg); }
    catch (e) {
      trace?.push({ fn: s.fn, ...(s.arg !== undefined ? { arg: s.arg } : {}),
                    in: before, error: (e as Error).message });
      throw new TransformError(
        `${s.fn} failed: ${(e as Error).message}`, r.source, r.target,
      );
    }
    trace?.push({ fn: s.fn, ...(s.arg !== undefined ? { arg: s.arg } : {}), in: before, out: v });
  }
  return v;
}

/** One step of a rule's transform chain, as seen by the dry-run tracer. */
export interface TraceStep {
  fn: string; arg?: string | number; in: unknown; out?: unknown; error?: string;
}

export interface RuleTrace {
  target: string;
  source?: string;
  literal?: unknown;
  sourceValue?: unknown;
  steps: TraceStep[];
  result?: unknown;
  error?: string;
}

export interface DryRunResult {
  output: Record<string, unknown>;
  trace: RuleTrace[];
  errors: Array<{ sourcePath?: string; targetPath?: string; message: string }>;
}

/**
 * Apply a template while recording what happened to every rule (XFORM-015).
 *
 * Two differences from `applyTemplate`, both deliberate:
 *
 *   - It **accumulates** errors instead of throwing on the first. An author
 *     fixing a mapping wants every problem at once; one-per-round-trip turns a
 *     ten-field mistake into ten deploys.
 *   - It records `source value → each step → result` per rule. A mapping that
 *     produces the wrong number is otherwise opaque: the trace is what shows
 *     that `divide(100)` ran where `multiply(100)` was written.
 *
 * It runs the SAME engine under the SAME limits as a real submission, so a
 * dry-run that succeeds is evidence about the real path — and it persists,
 * queues and submits nothing.
 */
export function dryRunTemplate(tpl: Template, source: unknown): DryRunResult {
  const out: Record<string, unknown> = {};
  const trace: RuleTrace[] = [];
  const errors: DryRunResult['errors'] = [];
  const arrayRules = new Map<string, TransformRule[]>();

  for (const r of tpl.rules) {
    if (/^(.+?)\[\]\.(.+)$/.test(r.target)) {
      const key = /^(.+?)\[\]\./.exec(r.target)![1]!;
      if (!arrayRules.has(key)) arrayRules.set(key, []);
      arrayRules.get(key)!.push(r);
      continue;
    }
    const steps: TraceStep[] = [];
    const raw = r.literal !== undefined ? r.literal : readPath(source, r.source ?? '');
    const entry: RuleTrace = {
      target: r.target,
      ...(r.source ? { source: r.source } : {}),
      ...(r.literal !== undefined ? { literal: r.literal } : {}),
      sourceValue: raw, steps,
    };
    try {
      if (raw === undefined && r.required) {
        throw new TransformError(
          `required field missing at source path "${r.source}"`, r.source, r.target);
      }
      if (raw === undefined && !r.transform?.some((st) => st.fn === 'defaultTo')) {
        entry.result = undefined;
        trace.push(entry);
        continue;
      }
      const value = applyChain(raw, r.transform, r, steps);
      writePath(out, r.target, value);
      entry.result = value;
    } catch (e) {
      const te = e instanceof TransformError ? e : null;
      entry.error = (e as Error).message;
      errors.push({
        ...(te?.sourcePath ? { sourcePath: te.sourcePath } : {}),
        targetPath: r.target,
        message: (e as Error).message,
      });
    }
    trace.push(entry);
  }

  for (const [targetKey, rules] of arrayRules) {
    const first = rules[0]!;
    const srcArrPath = /^(.+?)\[\]/.exec(first.source ?? '')?.[1];
    const arr = srcArrPath ? readPath(source, srcArrPath) : undefined;
    if (!Array.isArray(arr)) {
      errors.push({
        ...(first.source ? { sourcePath: first.source } : {}),
        targetPath: first.target,
        message: `source array not found at "${srcArrPath ?? '(none)'}" — ` +
                 `${targetKey}[] rules produced nothing`,
      });
      continue;
    }
    if (arr.length > LIMITS.maxArrayItems) {
      errors.push({ targetPath: first.target,
        message: `source array has ${arr.length} items, limit is ${LIMITS.maxArrayItems}` });
      continue;
    }
    const items: Record<string, unknown>[] = [];
    arr.forEach((item, i) => {
      const built: Record<string, unknown> = {};
      for (const r of rules) {
        const steps: TraceStep[] = [];
        const leaf = /^(.+?)\[\]\.(.+)$/.exec(r.target)![2]!;
        const srcLeaf = /^(.+?)\[\]\.(.+)$/.exec(r.source ?? '')?.[2];
        const raw = r.literal !== undefined
          ? r.literal
          : (srcLeaf ? readPath(item, srcLeaf) : undefined);
        const entry: RuleTrace = {
          target: r.target.replace('[]', `[${i}]`),
          ...(r.source ? { source: r.source.replace('[]', `[${i}]`) } : {}),
          sourceValue: raw, steps,
        };
        try {
          if (raw === undefined && r.required) {
            throw new TransformError(
              `required field missing at source path "${r.source}"`, r.source, r.target);
          }
          if (raw === undefined) { trace.push(entry); continue; }
          const value = applyChain(raw, r.transform, r, steps);
          writePath(built, leaf, value);
          entry.result = value;
        } catch (e) {
          entry.error = (e as Error).message;
          errors.push({
            ...(r.source ? { sourcePath: r.source.replace('[]', `[${i}]`) } : {}),
            targetPath: entry.target, message: (e as Error).message,
          });
        }
        trace.push(entry);
      }
      items.push(built);
    });
    writePath(out, targetKey, items);
  }

  return { output: out, trace, errors };
}

/**
 * Apply a template. Errors carry BOTH the canonical target path and the CRM's
 * source path — "lines[2].nature" alone is useless to someone who sent
 * "line_items[2].tax_code".
 */
export function applyTemplate(tpl: Template, source: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const arrayRules = new Map<string, TransformRule[]>();

  for (const r of tpl.rules) {
    const arrMatch = /^(.+?)\[\]\.(.+)$/.exec(r.target);
    if (arrMatch) {
      const key = arrMatch[1]!;
      if (!arrayRules.has(key)) arrayRules.set(key, []);
      arrayRules.get(key)!.push(r);
      continue;
    }
    const raw = r.literal !== undefined ? r.literal : readPath(source, r.source ?? '');
    if (raw === undefined && r.required) {
      throw new TransformError(
        `required field missing at source path "${r.source}"`, r.source, r.target,
      );
    }
    if (raw === undefined && !r.transform?.some((s) => s.fn === 'defaultTo')) continue;
    writePath(out, r.target, applyChain(raw, r.transform, r));
  }

  for (const [targetKey, rules] of arrayRules) {
    const first = rules[0]!;
    const srcArrPath = /^(.+?)\[\]/.exec(first.source ?? '')?.[1];
    const arr = srcArrPath ? readPath(source, srcArrPath) : undefined;
    if (!Array.isArray(arr)) continue;
    if (arr.length > LIMITS.maxArrayItems) {
      throw new TransformError(
        `source array has ${arr.length} items, limit is ${LIMITS.maxArrayItems}`,
        first.source, first.target,
      );
    }
    const items = arr.map((item, i) => {
      const o: Record<string, unknown> = {};
      for (const r of rules) {
        const leaf = /\[\]\.(.+)$/.exec(r.target)![1]!;
        const srcLeaf = /\[\]\.(.+)$/.exec(r.source ?? '')?.[1];
        const raw = r.literal !== undefined
          ? r.literal
          : (srcLeaf ? readPath(item, srcLeaf) : undefined);
        if (raw === undefined && r.required) {
          throw new TransformError(
            `required field missing at "${r.source}" (item ${i})`, r.source, r.target,
          );
        }
        writePath(o, leaf, applyChain(raw, r.transform, r));
      }
      return o;
    });
    writePath(out, targetKey, items);
  }
  return out;
}
