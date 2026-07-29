/**
 * PPAC Snapshot editions -> KPI cells. Pure: parsed editions in, kpiObjects out.
 *
 * The deterministic twin of insights-fill: no model call, no judgement, only
 * cells that can be filled by arithmetic on a published table. Where
 * insights-fill transcribes Screener's grid, this transcribes the ministry's,
 * which matters because the tag differs - PPAC is regulator data, [Official],
 * the firmest thing on the Part D ladder, where an aggregator is not.
 *
 * WHY THIS EXISTS. Refinery throughput for the three OMCs was previously a
 * management remark on a call. On today's data the difference is visible:
 * HPCL's Q1 FY27 cell is empty and PPAC has it, and BPCL's Q1 FY27 is a
 * [Mgmt Claim] of 10.15 against PPAC's [Official] 10.2 - the same quarter,
 * independently sourced, agreeing to within a rounding step.
 *
 * THE CADENCE PROBLEM. PPAC publishes April-to-date, not quarters. So a quarter
 * is a difference between consecutive year-to-date readings, and only editions
 * at a quarter END can produce one:
 *
 *   Q1 = YTD(June)                     Q3 = YTD(December) - YTD(September)
 *   Q2 = YTD(September) - YTD(June)    Q4 = YTD(March)    - YTD(December)
 *
 * A mid-quarter edition (say July) is read and discarded rather than treated as
 * a quarter, because a two-month figure sitting in a quarterly row is the
 * wrong-cadence error the store already refuses elsewhere.
 */

import { quarterLabel } from './fiscal.mjs';
import { quarterFromCumulative } from '../parsers/ppac-snapshot.mjs';

/** Quarter-end months of the Indian fiscal year, in order. */
const QUARTER_END = { 6: 1, 9: 2, 12: 3, 3: 4 };

/** The month that ends the PREVIOUS quarter, for the subtraction. */
const PREV_QUARTER_END = { 6: null, 9: 6, 12: 9, 3: 12 };

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Which fiscal year an April-to-date reading belongs to.
 * Jan-Mar close the fiscal year that began the previous April.
 */
function fiscalYearOf({ month, year }) {
  return month <= 3 ? year - 1 : year;
}

/**
 * Index every edition by company and quarter-end month, so a quarter can find
 * the reading it needs to subtract.
 *
 * @param {{dataMonth:{month:number,year:number}, totals:object[]}[]} editions
 * @returns {Map<string, Map<string, {ytd:number, dataMonth:object}>>}
 *          companyId -> "fy:endMonth" -> reading
 */
export function indexEditions(editions) {
  const byCompany = new Map();
  for (const ed of editions || []) {
    const dm = ed && ed.dataMonth;
    if (!dm || !isNum(dm.month) || !isNum(dm.year)) continue;
    /* Only a quarter-end edition can close a quarter. A July reading covers
       four months and belongs to no quarterly row. */
    if (!QUARTER_END[dm.month]) continue;
    const fy = fiscalYearOf(dm);

    for (const row of ed.totals || []) {
      if (!row || !row.companyId) continue;
      const ytd = row.yearToDate && row.yearToDate.provisional;
      if (!isNum(ytd)) continue;
      if (!byCompany.has(row.companyId)) byCompany.set(row.companyId, new Map());
      byCompany.get(row.companyId).set(`${fy}:${dm.month}`, { ytd, dataMonth: dm });
    }
  }
  return byCompany;
}

/**
 * Every quarter that can be closed from the editions held, per company.
 *
 * @returns {Map<string, Map<string, number>>} companyId -> quarterLabel -> MMT
 */
export function quartersFromEditions(editions) {
  const idx = indexEditions(editions);
  const out = new Map();

  for (const [companyId, readings] of idx) {
    const quarters = new Map();
    for (const [key, reading] of readings) {
      const [fyStr, monthStr] = key.split(':');
      const fy = Number(fyStr), month = Number(monthStr);
      const prevMonth = PREV_QUARTER_END[month];

      let value;
      if (prevMonth === null) {
        value = quarterFromCumulative(null, reading.ytd);          // Q1
      } else {
        const prev = readings.get(`${fy}:${prevMonth}`);
        /* Without the previous quarter-end reading the subtraction cannot be
           done. Treating the year-to-date as the quarter would overstate it by
           everything before it, which is the worst kind of wrong: large,
           plausible, and carrying an [Official] tag. */
        if (!prev) continue;
        value = quarterFromCumulative(prev.ytd, reading.ytd);
      }
      if (!isNum(value)) continue;

      /* quarterLabel wants the calendar year the quarter ENDS in. */
      const endYear = month === 3 ? fy + 1 : fy;
      quarters.set(quarterLabel(endYear, month), Number(value.toFixed(2)));
    }
    if (quarters.size) out.set(companyId, quarters);
  }
  return out;
}

/**
 * Build kpiObjects for the store from the editions held.
 *
 * Shaped exactly like fillFromInsights's output so mergeIntoStore needs no new
 * path: one object per KPI it can speak to, values aligned to `quarters`, and a
 * null wherever PPAC has nothing for that quarter.
 *
 * @param {object} opts
 * @param {object[]} opts.editions   parsed Snapshot editions
 * @param {object[]} opts.kpis       this company's KPI spec
 * @param {string} opts.companyId
 * @param {string[]} opts.quarters   the company's window, oldest first
 * @param {string} [opts.kpiId='throughput']
 * @returns {object[]} kpiObjects, or [] when PPAC covers nothing in the window
 */
export function fillFromPpac({ editions, kpis, companyId, quarters, kpiId = 'throughput' }) {
  const spec = (kpis || []).find((k) => k.id === kpiId);
  if (!spec) return [];

  const byCompany = quartersFromEditions(editions);
  const held = byCompany.get(companyId);
  if (!held || !held.size) return [];

  const values = (quarters || []).map((q) => (held.has(q) ? held.get(q) : null));
  if (!values.some(isNum)) return [];        // nothing in this window: claim nothing

  return [{
    id: spec.id,
    label: spec.label,
    unit: spec.unit || 'MMT',
    flagBasis: spec.flagBasis,
    values,
    /* Regulator data. The brief puts PPAC alongside PNGRB and the RBI under
       [Official] - audited results, exchange filings, regulator data. */
    sourceTags: values.map((v) => (isNum(v) ? 'official' : null)),
    oneOffs: values.map(() => null),
    notes: 'Crude oil processing from PPAC\'s Monthly Ready Reckoner ' +
           '(Ministry of Petroleum & Natural Gas). PPAC publishes April-to-date, ' +
           'so a quarter is the difference between consecutive year-to-date readings.',
    flag: null      // computed by the store on merge, never here
  }];
}
