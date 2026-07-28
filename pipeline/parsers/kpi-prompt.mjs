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

import { flagFor, usableSeries } from '../lib/kpi-flag.mjs';
import { quarterLabel } from '../lib/fiscal.mjs';

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
    // Label each column with the fiscal quarter it closes, so a value in the
    // "Mar 2026" column can be filed against Q4 FY26 without the model having to
    // work out India's April-March fiscal year for itself.
    const heads = q.periods.map((p, i) => {
      const iso = (q.periodsIso && q.periodsIso[i]) || null;
      const fq = iso ? quarterLabel(Number(iso.slice(0, 4)), Number(iso.slice(5, 7))) : null;
      return fq ? `${p} (${fq})` : p;
    });
    lines.push('QUARTERLY (Screener, company filing) periods: ' + heads.join(' | '));
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
 * Bump this whenever a change here could change the right answer for a cell the
 * store already recorded as empty.
 *
 * The store will not re-ask a settled cell, which is the point - but "settled"
 * has to mean "settled given this prompt". Without a version, an improved prompt
 * would keep being served the old null as though it were established fact.
 *
 *   1  first extractor
 *   2  quarter-aligned excerpt headings (lib/fiscal.mjs)
 *   3  flow measures must be single-quarter, not year-to-date
 */
export const PROMPT_VERSION = 3;

/**
 * Build the system + user messages for one company.
 * @returns {{system:string, user:string}}
 */
export function buildMessages({ companyName, kpis, quarters, blocks }) {
  const system = [
    'You are a precise financial-data extractor for Indian oil & gas companies.',
    'Extract ONLY numbers explicitly present in the provided excerpts. Never estimate, guess, annualise, or infer a number that is not stated.',
    'Each excerpt heading names the fiscal quarter that document reports on. A number stated in that document belongs in THAT quarter\'s slot - not the first slot, and not spread across the others. A document may also quote the year-ago or previous quarter for comparison; place such a figure in the quarter it actually belongs to if that quarter is in the list, otherwise ignore it.',
    'For each KPI and each quarter, return the value if the excerpts state it, otherwise null with a short note saying what was missing.',
    'FLOW measures (order inflow, revenue, volume, capex) must be the figure FOR THAT QUARTER ALONE. Indian companies routinely quote these year-to-date ("for the nine months", "YTD", "for the year so far") or for the full year. If the excerpt gives only a cumulative or full-year figure and the single-quarter figure is not stated, return null and say so in the note - a rising YTD series read as four quarters invents a trend that is not there. STOCK measures (order book, capacity, connections, reserves, utilisation %) are point-in-time and need no such care.',
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
    `The values array for each KPI has exactly ${quarters.length} slots, in THIS order: ${quarterList}`,
    'Use the quarter named in each excerpt heading to decide which slot a number goes in.',
    '',
    'Extract these KPIs (one object per id; values, sourceTags and oneOffs each length ' + quarters.length + '):',
    kpiList,
    '',
    'oneOffs: for each quarter, a SHORT reason (under 60 characters) when the',
    'source says that quarter was distorted by a known one-off - an inventory',
    'gain or loss inside a refining margin, a one-time provision or writeback, a',
    'planned shutdown or turnaround. Otherwise null. Only flag what the source',
    'actually states; do not infer a one-off from a number simply looking odd.',
    'These quarters are excluded from the trend, so a wrong flag hides a real move.',
    '',
    'Source excerpts:',
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
          /* Per quarter: a short reason when that quarter is distorted by a
             known one-off, else null. The brief excludes these from the
             trajectory and greys them out with the reason, so a one-off can
             never register as an inflection. */
          oneOffs: { type: 'array', items: { type: ['string', 'null'] } },
          notes: { type: ['string', 'null'] }
        },
        required: ['id', 'unit', 'values', 'sourceTags', 'oneOffs', 'notes']
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
    /* A one-off reason only means anything against a value; a reason on an empty
       quarter is noise, and would grey out a cell that is simply not disclosed. */
    const oneOffs = pad4(got.oneOffs).map((r, i) => {
      if (values[i] == null) return null;
      return (typeof r === 'string' && r.trim()) ? r.trim().slice(0, 60) : null;
    });

    return {
      id: spec.id,
      label: spec.label,
      unit,
      flagBasis: spec.flagBasis,
      values,
      sourceTags,
      oneOffs,
      /* The brief: one-off quarters are excluded from trajectory computation, so
         a distorted quarter can never register as an inflection. */
      flag: flagFor(usableSeries(values, { oneOffs, sourceTags }), spec.flagBasis, flatBandPct),
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
