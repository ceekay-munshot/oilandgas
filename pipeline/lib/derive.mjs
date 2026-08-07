/**
 * Fill KPI cells that no source states outright but that ARE arithmetic on
 * figures we already hold - no model involved.
 *
 * Some of what the client asked for is never printed as its own line. A gas
 * distributor reports EBITDA and it reports volume, but not EBITDA per scm; it
 * reports a volume every quarter, but not that volume's year-on-year growth.
 * Those are one division away from numbers already in data/financials.json and
 * data/insights.json. Computing them is not inference - it is the same division
 * an analyst does by hand, and putting the formula in the note makes it checkable.
 *
 * Two rules keep this on the honest side of the line the whole product is built
 * around ("never invent a number; a gap stays a gap"):
 *
 *   inputs or nothing   A quarter is derived only when EVERY figure the formula
 *                       needs is held for that exact quarter. A missing input is
 *                       a gap, not a zero and not a guess.
 *
 *   reproduce or refuse The formula must reproduce the values the store ALREADY
 *                       holds for the same KPI, within a tolerance, before it is
 *                       trusted to fill that KPI's blanks. Mahanagar's CNG+PNG
 *                       growth is the case this exists for: its total-sales-volume
 *                       yoy does not match the growth the company reports (total
 *                       volume includes industrial & commercial gas, the reported
 *                       growth does not), so the check fails and nothing is filled
 *                       rather than a wrong-basis number carrying a formula.
 *
 * A derived value only ever fills an EMPTY cell. It never overwrites a value the
 * model read or Screener cited - it fills the blanks between them. Which is why
 * the corroboration above works: the model's own reading is the yardstick the
 * arithmetic is held to before it is allowed to fill the gaps the model missed.
 */

import { cellKey, cellsOf } from './kpi-store.mjs';

/** Days in an Indian fiscal quarter. Q4 (Jan-Mar) is the only one leap-sensitive. */
export function daysInQuarter(label) {
  const m = String(label || '').match(/^Q([1-4]) FY(\d{2})$/);
  if (!m) return null;
  const q = Number(m[1]);
  if (q === 1) return 91;                 // Apr 30 + May 31 + Jun 30
  if (q === 2) return 92;                 // Jul 31 + Aug 31 + Sep 30
  if (q === 3) return 92;                 // Oct 31 + Nov 30 + Dec 31
  const year = 2000 + Number(m[2]);       // Q4 Jan-Mar falls in the FY-end calendar year
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return 31 + (leap ? 29 : 28) + 31;      // 90, or 91 in a leap year
}

/** 'Q2 FY26' -> 'Q2 FY25': the same quarter one fiscal year earlier. */
export function prevYearQuarter(label) {
  const m = String(label || '').match(/^Q([1-4]) FY(\d{2})$/);
  if (!m) return null;
  return `Q${m[1]} FY${String(Number(m[2]) - 1).padStart(2, '0')}`;
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/** A financials quarterly row (Screener P&L), keyed by the quarter each column closes. */
function financialsRowByQuarter(fin, candidates, quarterLabel) {
  const table = fin && fin.tables && fin.tables.quarters;
  if (!table || !table.rows || !Array.isArray(table.periodsIso)) return null;
  const rowKey = Object.keys(table.rows).find((k) => candidates.some((c) => norm(k) === norm(c) || norm(k).startsWith(norm(c))));
  if (!rowKey) return null;
  const vals = table.rows[rowKey];
  const byQ = new Map();
  table.periodsIso.forEach((iso, i) => {
    const q = quarterLabel(Number(String(iso).slice(0, 4)), Number(String(iso).slice(5, 7)));
    if (q && vals[i] != null && !byQ.has(q)) byQ.set(q, vals[i]);
  });
  return byQ;
}

/** An Insights row, keyed by the quarter each column closes. */
function insightsRowByQuarter(insights, candidates, quarterLabel) {
  if (!insights || !Array.isArray(insights.rows) || !Array.isArray(insights.periodsIso)) return null;
  if (insights.view !== 'quarterly') return null;
  const row = insights.rows.find((r) => candidates.some((c) => norm(r.label) === norm(c)));
  if (!row) return null;
  const byQ = new Map();
  insights.periodsIso.forEach((iso, i) => {
    const q = quarterLabel(Number(String(iso).slice(0, 4)), Number(String(iso).slice(5, 7)));
    if (q && row.values[i] != null && !byQ.has(q)) byQ.set(q, row.values[i]);
  });
  return { byQ, row };
}

/* ---- the derivations, declared ---- */

/**
 * EBITDA per standard cubic metre, for a city-gas distributor.
 *
 * EBITDA is Screener's quarterly Operating Profit (Sales - Expenses, ₹ cr).
 * Volume is the Insights "Total Sales Volume" row in MMSCMD - a per-DAY rate, so
 * a quarter's gas is that rate times the days in the quarter. In ₹/scm:
 *
 *   (OP_cr x 1e7) / (vol_mmscmd x 1e6 x days)   =   OP_cr x 10 / (vol_mmscmd x days)
 */
function computeEbitdaPerScm({ fin, insights, quarterLabel }) {
  const op = financialsRowByQuarter(fin, ['Operating Profit'], quarterLabel);
  const vol = insightsRowByQuarter(insights, ['Total Sales Volume'], quarterLabel);
  if (!op || !vol) return null;
  const out = new Map();
  for (const [q, opCr] of op) {
    const v = vol.byQ.get(q);
    const days = daysInQuarter(q);
    if (v == null || !v || !days) continue;
    out.set(q, (opCr * 1e7) / (v * 1e6 * days));   // ₹/scm
  }
  return out;
}

/**
 * Year-on-year growth of quarterly volume, in percentage points.
 *
 * The volume row is a per-day rate (MMSCMD), so this quarter's rate against the
 * same quarter a year earlier IS the volume growth - no day-count needed, the two
 * rates are already like-for-like.
 */
function computeVolumeYoy({ insights, quarterLabel }) {
  const vol = insightsRowByQuarter(insights, ['Total Sales Volume'], quarterLabel);
  if (!vol) return null;
  const out = new Map();
  for (const [q, v] of vol.byQ) {
    const prev = vol.byQ.get(prevYearQuarter(q));
    if (prev == null || !prev) continue;
    out.set(q, (v / prev - 1) * 100);              // % yoy
  }
  return out;
}

/**
 * One entry per derivable KPI id. `tol` is how close the formula must come to a
 * value the store already holds before it is trusted to fill that KPI's gaps -
 * relative for a level, absolute (percentage points) for a growth rate.
 *
 * Deliberately NOT here, each assessed and refused:
 *
 *   O2C EBITDA/tonne (Reliance). We hold O2C throughput but not the O2C SEGMENT's
 *     EBITDA - only Reliance's consolidated operating profit, which is Jio and
 *     Retail and E&P as well as O2C. Dividing that by refinery tonnes would be a
 *     fabricated number wearing a formula. (The segment figure is read from the
 *     results deck instead - see lib/ril-fill.mjs.)
 *
 *   Terminal utilisation (Aegis Logistics, Aegis-Vopak). Throughput is quarterly
 *     but LPG Throughput Capacity is reported once a year AND jumped 9,600 ->
 *     19,600 in Mar 2026 (a capacity expansion). Dividing quarterly throughput by
 *     an annual capacity that changed at an unknown point in the year would draw a
 *     utilisation cliff (57% -> 25%) that is an artefact of the expansion timing,
 *     not a real fall. There is also no held utilisation value to reproduce
 *     against, so the corroboration gate could not catch it. It stays a gap.
 *     (Aegis-Vopak's throughput row is empty outright.)
 *
 *   Marketing margin (IOCL/BPCL/HPCL), Petchem margin (Reliance/GAIL). These need
 *     the marketing/petrochem SEGMENT's profitability per unit, which neither the
 *     Insights grid nor Screener's P&L breaks out - only consolidated profit. Same
 *     trap as O2C. They stay gaps until a segmental source is added.
 */
export const DERIVATIONS = {
  'ebitda-per-scm': {
    outUnit: '₹/scm',
    decimals: 2,
    tol: { rel: 0.15 },
    note: 'Derived: EBITDA (Screener quarterly Operating Profit, ₹ cr) ÷ quarterly gas volume ' +
          '(Insights "Total Sales Volume" MMSCMD × days in quarter), in ₹/scm.',
    compute: computeEbitdaPerScm
  },
  'cng-png-volume-growth': {
    outUnit: '% yoy',
    decimals: 1,
    tol: { abs: 1.5 },
    note: 'Derived: year-on-year growth of quarterly volume (Insights "Total Sales Volume", ' +
          'this quarter vs the same quarter a year earlier).',
    compute: computeVolumeYoy
  }
};

const round = (x, dp) => {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
};

/**
 * Does the formula reproduce what the store already holds for this KPI?
 *
 * Every quarter the store holds a real value for AND we computed one for must
 * agree within tolerance, and there must be at least one such quarter - a formula
 * with nothing to check against is not trusted to fill blanks on its own.
 */
function reproducesHeld(computed, cells, kpiId, tol) {
  let overlaps = 0;
  for (const [q, dv] of computed) {
    const cell = cells[cellKey(kpiId, q)];
    if (!cell || cell.value == null) continue;
    overlaps++;
    const hv = cell.value;
    const ok = tol.abs != null
      ? Math.abs(dv - hv) <= tol.abs
      : Math.abs(dv - hv) <= tol.rel * Math.abs(hv);
    if (!ok) return false;
  }
  return overlaps >= 1;
}

/**
 * Derive what we can for one company, gaps only.
 *
 * @param {object}   store        the durable store (read only here)
 * @param {string}   companyId
 * @param {object[]} kpis         the company's KPI specs
 * @param {string[]} quarters     the window, oldest -> newest
 * @param {object}   fin          this company's entry from data/financials.json
 * @param {object}   insights     this company's entry from data/insights.json
 * @param {(y:number,m:number)=>string|null} quarterLabel from lib/fiscal.mjs
 * @returns {object[]} kpis.json-shaped objects, only for KPIs this filled a gap in
 */
export function fillDerived({ store, companyId, kpis, quarters, fin, insights, quarterLabel }) {
  const cells = cellsOf(store, companyId);
  const out = [];

  for (const spec of kpis) {
    const d = DERIVATIONS[spec.id];
    if (!d) continue;

    const computed = d.compute({ fin, insights, quarterLabel, spec });
    if (!computed || !computed.size) continue;

    // The formula must reproduce the numbers already on record, or it is not
    // trusted to fill the ones that are missing.
    if (!reproducesHeld(computed, cells, spec.id, d.tol)) continue;

    // Fill EMPTY window cells only. A held value - model or cited - stands.
    const values = [], sourceTags = [];
    let filledAny = false;
    for (const q of quarters) {
      const held = cells[cellKey(spec.id, q)];
      const dv = computed.get(q);
      if ((!held || held.value == null) && dv != null) {
        values.push(round(dv, d.decimals));
        /* Part D reserves [Derived] for arithmetic on tagged inputs - flags,
           bucket scores, the stage call. A cell the pipeline COMPUTED because
           nobody disclosed one is [Estimate]: "a value the pipeline computed to
           fill a disclosure gap, with the method noted". The method is in the
           note; the cell keeps origin 'derived' so the store's rank rules are
           untouched. */
        sourceTags.push('estimate');
        filledAny = true;
      } else {
        values.push(null);
        sourceTags.push(null);
      }
    }
    if (!filledAny) continue;

    out.push({
      id: spec.id,
      label: spec.label,
      unit: d.outUnit || spec.unit || null,
      flagBasis: spec.flagBasis,
      values,
      sourceTags,
      notes: d.note
    });
  }
  return out;
}

/** How many cells a derivation produced, for the run summary. */
export function deriveTotals(filled) {
  let cells = 0;
  for (const k of filled) cells += k.values.filter((v) => v != null).length;
  return { kpis: filled.length, cells };
}
