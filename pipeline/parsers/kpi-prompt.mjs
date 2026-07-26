/**
 * Everything the KPI extractor does that is NOT the network call: pick the
 * relevant text out of the cached documents, build the model messages, and
 * normalise the reply into the shape data/kpis.json stores. Pure and tested.
 *
 * Two rules run through all of it:
 *  - NEVER send a whole transcript. Only windows around the KPI's keywords, and
 *    only up to a character budget - a 50,000-char call is mostly noise and the
 *    model does worse on it, not better.
 *  - NEVER invent a value. The schema allows null everywhere; a quarter the
 *    excerpts do not state comes back null with a note, never a guess.
 */

import { flagFor } from '../lib/kpi-flag.mjs';

/** Source tags the dashboard knows (framework.json). Anything else -> unknown. */
const ALLOWED_TAGS = new Set([
  'official', 'company-filing', 'mgmt-claim', 'external', 'estimate', 'inference', 'derived', 'unknown'
]);

/**
 * Pull windows of text around the KPI keywords out of each source, newest and
 * most-authoritative first, up to a total character budget.
 *
 * @param {{label:string, text:string}[]} sources  ordered; PPT first, then
 *        transcripts newest-first, then a financials summary
 * @param {string[]} keywords
 * @param {object} [opts]
 * @returns {{label:string, text:string}[]} one block per source that hit
 */
export function preFilter(sources, keywords, { maxChars = 24000, window = 600 } = {}) {
  const needles = [...new Set((keywords || []).map((k) => String(k).toLowerCase()).filter(Boolean))];
  const out = [];
  let budget = maxChars;

  for (const src of sources || []) {
    if (budget <= 0) break;
    const text = String(src && src.text || '');
    if (!text) continue;
    const lower = text.toLowerCase();

    // Collect [start,end] windows around every keyword hit.
    const ranges = [];
    for (const n of needles) {
      let idx = lower.indexOf(n);
      while (idx !== -1 && ranges.length < 500) {
        ranges.push([Math.max(0, idx - window), Math.min(text.length, idx + n.length + window)]);
        idx = lower.indexOf(n, idx + n.length);
      }
    }
    if (!ranges.length) continue;

    // Merge overlapping windows so a dense passage is not repeated.
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) {
      const tail = merged[merged.length - 1];
      if (tail && r[0] <= tail[1]) tail[1] = Math.max(tail[1], r[1]);
      else merged.push([r[0], r[1]]);
    }

    let excerpt = '';
    for (const [a, b] of merged) {
      if (budget <= 0) break;
      const chunk = text.slice(a, b);
      const piece = (excerpt ? ' [...] ' : '') + chunk;
      excerpt += piece.slice(0, budget);
      budget -= piece.length;
    }
    if (excerpt.trim()) out.push({ label: src.label, text: excerpt.trim() });
  }
  return out;
}

/** A company's scraped financials -> a compact text block for the model. */
export function financialsToText(fin) {
  if (!fin || !fin.tables) return '';
  const lines = [];
  const q = fin.tables.quarters;
  if (q && q.periods && q.periods.length) {
    lines.push('QUARTERLY (Screener, company filing) periods: ' + q.periods.join(' | '));
    for (const row of q.order || Object.keys(q.rows || {})) {
      const vals = q.rows[row];
      if (!vals) continue;
      lines.push(`${row}: ${vals.map((v) => (v == null ? '-' : v)).join(' | ')}`);
    }
  }
  if (fin.analysis) {
    if (fin.analysis.pros && fin.analysis.pros.length) lines.push('Pros: ' + fin.analysis.pros.join('; '));
    if (fin.analysis.cons && fin.analysis.cons.length) lines.push('Cons: ' + fin.analysis.cons.join('; '));
  }
  return lines.join('\n');
}

/**
 * Build the system + user messages for one company.
 * @returns {{system:string, user:string}}
 */
export function buildMessages({ companyName, kpis, quarters, blocks }) {
  const system = [
    'You are a precise financial-data extractor for Indian oil & gas companies.',
    'Extract ONLY numbers explicitly present in the provided excerpts. Never estimate, guess, annualise, or infer a number that is not stated.',
    'For each KPI and each of the four quarters, return the value if the excerpts state it, otherwise null with a short note saying what was missing.',
    'Tag every non-null value with sourceTag: "company-filing" (a reported number in a results table or PPT), "mgmt-claim" (a figure management stated on the call as guidance or commentary), "derived" (you computed it from other reported numbers - explain in notes), "inference" (implied, not stated), or "unknown".',
    'Values are plain numbers only - no units, no commas, no % sign. Put the unit in the unit field.',
    'Output STRICT JSON matching the schema and nothing else.'
  ].join(' ');

  const kpiList = kpis
    .map((k) => `- id "${k.id}": ${k.label} (unit hint: ${k.unit || 'n/a'}; flagged on ${k.flagBasis})`)
    .join('\n');
  const quarterList = quarters.map((q, i) => `[${i}] ${q}`).join(', ');
  const context = (blocks || []).map((b) => `### ${b.label}\n${b.text}`).join('\n\n');

  const user = [
    `Company: ${companyName}`,
    '',
    `The values array for each KPI is in THIS quarter order: ${quarterList}`,
    '',
    'Extract these KPIs (one object per id; values and sourceTags each length 4):',
    kpiList,
    '',
    'Source excerpts (the heading tells you the document type):',
    context || '(no relevant excerpts were found - return nulls with a note)'
  ].join('\n');

  return { system, user };
}

/** JSON Schema for the reply (OpenAI strict json_schema compatible). */
export const KPI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kpis: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          unit: { type: ['string', 'null'] },
          values: { type: 'array', items: { type: ['number', 'null'] } },
          sourceTags: { type: 'array', items: { type: ['string', 'null'] } },
          notes: { type: ['string', 'null'] }
        },
        required: ['id', 'unit', 'values', 'sourceTags', 'notes']
      }
    }
  },
  required: ['kpis']
};

const pad4 = (arr) => {
  const o = Array.isArray(arr) ? arr.slice(0, 4) : [];
  while (o.length < 4) o.push(null);
  return o;
};
const toNum = (v) =>
  (typeof v === 'number' && Number.isFinite(v)) ? v
    : (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Normalise the model reply against the spec: coerce every KPI to exactly four
 * numeric-or-null values, clamp source tags to the known set (and null out any
 * tag on a null value), then compute the trajectory flag in code.
 *
 * @returns {object[]} kpis.json-shaped KPI objects, one per spec KPI (in order)
 */
export function normalizeResult(raw, kpis, quarters, { flatBandPct = 1.5 } = {}) {
  const byId = new Map(((raw && raw.kpis) || []).filter((k) => k && k.id).map((k) => [k.id, k]));

  return kpis.map((spec) => {
    const got = byId.get(spec.id) || {};
    const values = pad4(got.values).map(toNum);
    const sourceTags = pad4(got.sourceTags).map((t, i) => {
      if (values[i] == null) return null;                 // no value -> no source
      return ALLOWED_TAGS.has(t) ? t : 'unknown';
    });
    const unit = (typeof got.unit === 'string' && got.unit.trim()) ? got.unit.trim() : (spec.unit || null);
    const notes = (typeof got.notes === 'string' && got.notes.trim()) ? got.notes.trim().slice(0, 240) : null;

    return {
      id: spec.id,
      label: spec.label,
      unit,
      flagBasis: spec.flagBasis,
      values,
      sourceTags,
      flag: flagFor(values, spec.flagBasis, flatBandPct),
      notes
    };
  });
}

/** Count filled vs empty cells for a company's KPI list. */
export function coverageOf(kpiObjects) {
  let cells = 0, real = 0;
  for (const k of kpiObjects) {
    for (const v of k.values) { cells++; if (v != null) real++; }
  }
  return { cells, real, nullCells: cells - real };
}

export { ALLOWED_TAGS };
