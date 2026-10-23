import { InvoiceSchema } from '../invoice/model.ts';
import { z } from 'zod';

/**
 * The legal `target` paths for a transformation rule (XFORM-005).
 *
 * DERIVED from `InvoiceSchema` rather than hand-listed, for the same reason the
 * OpenAPI contract is generated: a hand-maintained list drifts, and a rule
 * pointing at a target that no longer exists writes into nothing. The value
 * lands in an object the generator never reads, the field is silently absent
 * from the XML, and — if the field was optional — the invoice is transmitted
 * missing data nobody noticed.
 *
 * Validating targets at save time turns that into an error while the author is
 * still looking at the template.
 */

/** Walk a Zod object tree, emitting dotted paths with `[]` for arrays. */
function walk(schema: z.ZodTypeAny, prefix = '', depth = 0): string[] {
  if (depth > 6) return [];   // the canonical model is nowhere near this deep

  // Unwrap the wrappers that carry no path of their own.
  let s = schema;
  for (let i = 0; i < 10; i++) {
    const def = (s as unknown as { _def?: { typeName?: string; innerType?: z.ZodTypeAny;
      schema?: z.ZodTypeAny } })._def;
    if (!def) break;
    if (def.innerType) { s = def.innerType; continue; }
    if (def.schema) { s = def.schema; continue; }
    break;
  }

  const def = (s as unknown as { _def: { typeName: string } })._def;
  const kind = def?.typeName;

  if (kind === 'ZodObject') {
    const shape = (s as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;
    const out: string[] = [];
    for (const [key, child] of Object.entries(shape)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const nested = walk(child, path, depth + 1);
      // A leaf contributes its own path; a branch contributes its children.
      if (nested.length === 0) out.push(path);
      else out.push(...nested);
    }
    return out;
  }

  if (kind === 'ZodArray') {
    const el = (s as unknown as { _def: { type: z.ZodTypeAny } })._def.type;
    const nested = walk(el, `${prefix}[]`, depth + 1);
    return nested.length === 0 ? [`${prefix}[]`] : nested;
  }

  return [];   // a scalar: the caller records its own path
}

/** Every legal target path, derived from the canonical model. */
export const TARGET_PATHS: readonly string[] = Object.freeze(
  walk(InvoiceSchema).sort(),
);

const TARGET_SET: ReadonlySet<string> = new Set(TARGET_PATHS);

/**
 * Is this a path the generator will actually read?
 *
 * Array element paths are compared with their index stripped, so
 * `lines[0].unitPrice` matches the `lines[].unitPrice` the registry holds.
 */
export function isValidTarget(target: string): boolean {
  return TARGET_SET.has(target.replace(/\[\d+\]/g, '[]'));
}

/**
 * Suggest what the author probably meant.
 *
 * A rejection naming only the offending path leaves them scanning a list of
 * ninety; a suggestion usually ends the search immediately, because the real
 * cause is nearly always a casing slip or a singular/plural mix-up.
 */
export function suggestTargets(target: string, limit = 3): string[] {
  const norm = target.replace(/\[\d+\]/g, '[]').toLowerCase();
  const leaf = norm.split('.').pop() ?? norm;

  // Ranked by edit distance on the LEAF, because the real cause is nearly
  // always a casing slip or a singular/plural mix-up in the last segment —
  // "unitPrise" for "unitPrice", "line" for "lines".
  return TARGET_PATHS
    .map((p) => {
      const pl = p.toLowerCase();
      const pleaf = pl.split('.').pop() ?? pl;
      const contains = pl.includes(leaf) || leaf.includes(pleaf) ? 0 : 1;
      return { path: p, score: contains * 100 + editDistance(leaf, pleaf) };
    })
    .filter((c) => c.score < 105)
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((c) => c.path);
}

/** Levenshtein, bounded by the short paths involved. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1, cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev.splice(0, prev.length, ...cur);
  }
  return prev[b.length]!;
}
