/**
 * Fill KPI cells straight from Screener's Insights table - no model involved.
 *
 * The last full run made the case for this on its own: 1,150 values sat parsed
 * in data/insights.json, quarterly and each carrying a document and page number,
 * while the KPI table held 97 cells the model had re-derived from transcripts.
 * Screener had already tabulated most of what the client asked for.
 *
 * Reading it directly is better on all three counts that matter here:
 *
 *   exact      the number is transcribed, not inferred, so it cannot drift
 *   cited      "Presentation - 14 May 2026, page 6" beats a guessed source tag
 *   correct    Petronet's regas utilisation came back [-, 27, 94, 90.1] because
 *              the model read Kochi's terminal for one quarter and Dahej for
 *              another. The table has them as separate rows, so the mapped
 *              series is [-, -, 94, 90.1] - two honest gaps instead of a number
 *              from the wrong terminal and a trajectory flag built on it.
 *
 * Which row IS which KPI is declared in data/kpi-spec.json (insightsRows), not
 * guessed by matching text at runtime. A row that is merely related is left
 * unmapped on purpose: a wrong number carrying a citation is worse than a gap,
 * because the citation makes it look checked.
 */

/**
 * @param {object}   insights   one company's entry from data/insights.json
 * @param {object[]} kpis       that company's KPI specs (with optional insightsRows)
 * @param {string[]} quarters   the window, oldest -> newest
 * @param {(y:number,m:number)=>string|null} quarterLabel from lib/fiscal.mjs
 * @returns {object[]} kpis.json-shaped objects, only for KPIs this filled anything for
 */
export function fillFromInsights({ insights, kpis, quarters, quarterLabel }) {
  if (!insights || !Array.isArray(insights.rows) || !insights.rows.length) return [];

  /* Quarterly only. The window is made of quarters, and an annual column would
     have to be reasoned about per KPI - a full-year order inflow is not a
     quarter's inflow, though a year-end order book is that quarter's position.
     That judgement is the model's to make from the text; this path only claims
     cells it can fill without judgement. */
  if (insights.view !== 'quarterly') return [];

  // Which column holds which quarter, resolved once.
  const colOf = new Map();
  (insights.periodsIso || []).forEach((iso, i) => {
    if (!iso) return;
    const q = quarterLabel(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)));
    if (q && !colOf.has(q)) colOf.set(q, i);
  });
  if (!colOf.size) return [];

  const byLabel = new Map();
  for (const r of insights.rows) byLabel.set(norm(r.label), r);

  const out = [];
  for (const spec of kpis) {
    const wanted = spec.insightsRows || [];
    if (!wanted.length) continue;

    // First declared row that is actually present wins.
    let row = null, matchedLabel = null;
    for (const label of wanted) {
      const hit = byLabel.get(norm(label));
      if (hit) { row = hit; matchedLabel = label; break; }
    }
    if (!row) continue;

    const values = [], sourceTags = [], cites = [];
    for (const q of quarters) {
      const i = colOf.get(q);
      const v = i == null ? null : row.values[i];
      values.push(v == null ? null : v);
      sourceTags.push(v == null ? null : 'company-filing');
      cites.push(v == null ? null : ((row.citations || [])[i] || null));
    }
    if (!values.some((v) => v != null)) continue;      // nothing to contribute

    out.push({
      id: spec.id,
      label: spec.label,
      unit: row.unit || spec.unit || null,
      flagBasis: spec.flagBasis,
      values,
      sourceTags,
      citations: cites,
      notes: noteFor(matchedLabel, row, cites)
    });
  }
  return out;
}

/**
 * Say where the number came from, in the row's own words.
 *
 * The Screener label is included because it is not always identical to the
 * client's KPI name - "Average TCY - Crude Carriers" answers "tanker freight
 * rate", and a reader deserves to see which one was actually read.
 */
function noteFor(matchedLabel, row, cites) {
  const cite = cites.find(Boolean);
  const scope = row.scope ? ` (${row.scope})` : '';
  const src = cite && cite.doc ? `; latest value cited to ${cite.doc}${cite.page ? `, page ${cite.page}` : ''}` : '';
  return `From Screener Insights row "${matchedLabel}"${scope}${src}.`;
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/** How many cells a fill produced, for the run summary. */
export function fillTotals(filled) {
  let cells = 0;
  for (const k of filled) cells += k.values.filter((v) => v != null).length;
  return { kpis: filled.length, cells };
}
