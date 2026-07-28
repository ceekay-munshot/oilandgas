/**
 * The durable commentary store: once a quarter's management tone is read, it is
 * ours forever. The twin of lib/kpi-store.mjs, and the same two problems drove it:
 *
 *   1. A steady-state run must cost nothing. A closed quarter's call is settled
 *      history - re-classifying it every week buys the same answer with the key.
 *   2. The strip must never go BACKWARDS. A tone that was read one week must not be
 *      wiped the next week by a pass that happened to see less text.
 *
 * So tones live here, keyed by company + quarter, across every quarter ever seen -
 * not just the current window. A run asks the model only about quarters it does
 * not already have a tone for, and a null never displaces a real tone.
 *
 * Simpler than the KPI store on purpose: one tone per quarter (not N KPIs), and a
 * single source of truth (the concall itself), so there is no unit guard and no
 * cross-source rank - the first real reading of a quarter stands until --refresh.
 * Re-asking a KNOWN-NULL quarter is governed by the same fingerprint idea: the
 * documents in the window and the prompt version. Change either and the null
 * re-opens; leave them and it stays settled.
 *
 * Pure except for the hash it borrows from kpi-store. No network, no filesystem.
 */

import { fingerprintFor, docsSignature } from './kpi-store.mjs';

// Re-exported so the orchestrator builds the fingerprint the same way the KPI side
// does, from one definition. `kpiSpec` is passed a constant marker here: tone has
// no per-KPI spec, but keeping the shape means one fingerprint function serves both.
export { fingerprintFor, docsSignature };

export function freshStore() {
  return {
    schemaVersion: 1,
    title: 'Management tone per company/quarter, kept across runs',
    generatedBy: 'pipeline/extract-commentary.mjs',
    generatedAt: null,
    note: 'One entry per company/quarter, for every quarter ever classified - not ' +
          'just the current window. A run only asks the model about quarters it does ' +
          'not already have a tone for, and a null never overwrites a real tone. Each ' +
          'tone is a reading of that quarter\'s own concall, with the quote it rests ' +
          'on. Delete a cell (or run with --refresh) to force re-classification.',
    companies: {}
  };
}

/** The cells (quarter -> tone) of one company, or an empty object. */
export function cellsOf(store, companyId) {
  return (store && store.companies && store.companies[companyId] && store.companies[companyId].cells) || {};
}

/**
 * Is this quarter settled - nothing to gain by asking again?
 * A real tone is always settled; a null only while its inputs are unchanged.
 */
export function isSettled(cell, fingerprint) {
  if (!cell) return false;
  if (cell.toneId) return true;
  return Boolean(cell.fingerprint) && cell.fingerprint === fingerprint;
}

/**
 * Which quarters still need the model, given what the store already holds.
 * @returns {{ask:string[], settled:number}}
 */
export function planQuarters({ store, companyId, quarters, fingerprint }) {
  const cells = cellsOf(store, companyId);
  const ask = [];
  let settled = 0;
  for (const q of quarters || []) {
    if (isSettled(cells[q], fingerprint)) settled++;
    else ask.push(q);
  }
  return { ask, settled };
}

/**
 * Fold a normalised reply into the store.
 *
 * The one rule that matters, same as the KPI store: a null NEVER displaces a real
 * tone. A run that reads nothing leaves the strip exactly as it was.
 *
 * @param {object} opts
 * @param {{quarter:string,toneId:string|null,score:number|null,quote:string|null,rationale:string|null}[]} opts.tones
 * @param {Record<string,string>} [opts.docByQuarter]  which document label each
 *        quarter's tone was read from, for provenance
 * @returns {{gained:number, kept:number, recorded:number}}
 */
export function mergeIntoStore({ store, companyId, tones, docByQuarter = {}, fingerprint, model, at }) {
  if (!store.companies[companyId]) store.companies[companyId] = { cells: {} };
  const entry = store.companies[companyId];
  if (!entry.cells) entry.cells = {};

  let gained = 0, kept = 0, recorded = 0;
  for (const t of tones || []) {
    const q = t && t.quarter;
    if (!q) continue;
    const prev = entry.cells[q];

    if (!t.toneId) {
      if (prev && prev.toneId) { kept++; continue; }        // keep the real tone we have
      entry.cells[q] = {
        toneId: null,
        score: null,
        quote: null,
        rationale: t.rationale || (prev && prev.rationale) || null,
        doc: (prev && prev.doc) || null,
        fingerprint,
        attempts: ((prev && prev.attempts) || 0) + 1,
        at
      };
      recorded++;
      continue;
    }

    if (prev && prev.toneId) { kept++; continue; }          // first real reading stands
    entry.cells[q] = {
      toneId: t.toneId,
      score: t.score,
      quote: t.quote || null,
      rationale: t.rationale || null,
      /* the fixed template: the synthesized read, the guided numbers it
         reported, and what it suggests next. Absent on cells written before
         the template existed, which is why every reader below defaults them. */
      driver: t.driver || null,
      direction: t.direction || null,
      signal: t.signal || null,
      mgmtDataPoints: Array.isArray(t.mgmtDataPoints) ? t.mgmtDataPoints : [],
      implication: t.implication || null,
      doc: docByQuarter[q] || null,
      fingerprint,
      attempts: ((prev && prev.attempts) || 0) + 1,
      model: model || null,
      at
    };
    gained++;
  }
  entry.updatedAt = at;
  return { gained, kept, recorded };
}

/**
 * Render one company's window out of the store, in commentary.json shape: one
 * entry per window quarter, oldest first, real tone or an honest null.
 *
 * @returns {{quarter:string, toneId:string|null, score:number|null,
 *            quote:string|null, rationale:string|null, doc:string|null}[]}
 */
export function renderTimeline({ store, companyId, quarters }) {
  const cells = cellsOf(store, companyId);
  return (quarters || []).map((q) => {
    const c = cells[q];
    if (!c || !c.toneId) {
      return {
        quarter: q,
        toneId: null,
        score: null,
        quote: null,
        rationale: (c && c.rationale) || null,
        driver: null,
        direction: null,
        signal: null,
        mgmtDataPoints: [],
        implication: null,
        doc: null
      };
    }
    return {
      quarter: q,
      toneId: c.toneId,
      score: c.score,
      quote: c.quote || null,
      rationale: c.rationale || null,
      driver: c.driver || null,
      direction: c.direction || null,
      signal: c.signal || null,
      mgmtDataPoints: Array.isArray(c.mgmtDataPoints) ? c.mgmtDataPoints : [],
      implication: c.implication || null,
      doc: c.doc || null
    };
  });
}

/** Every quarter the store holds a tone (real or null) for a company. */
export function quartersKnown(store, companyId) {
  return Object.keys(cellsOf(store, companyId));
}

/** Totals across the store, for the run summary. */
export function storeTotals(store) {
  let cells = 0, real = 0, companies = 0;
  for (const id of Object.keys((store && store.companies) || {})) {
    companies++;
    for (const c of Object.values(cellsOf(store, id))) {
      cells++;
      if (c && c.toneId) real++;
    }
  }
  return { companies, cells, real, empty: cells - real };
}
