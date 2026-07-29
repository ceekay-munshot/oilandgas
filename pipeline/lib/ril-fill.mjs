/**
 * Reliance's results deck -> KPI cells for the store.
 *
 * The deterministic sibling of insights-fill and ppac-fill: no model call, no
 * judgement, only a cell that follows by arithmetic from two figures printed in
 * one filing. Where insights-fill transcribes Screener's grid and ppac-fill the
 * ministry's, this one reads the company's own quarterly deck - so the tag is
 * [Company Filing], the same as the deck itself.
 *
 * WHAT IT CLOSES. "O2C EBITDA per tonne" is one of the four KPIs the brief
 * names for Reliance and the only one of them that a document we already
 * download can answer. lib/derive.mjs refuses to compute it, correctly: the
 * only EBITDA the pipeline held was consolidated - Jio and Retail and E&P as
 * well as O2C - and dividing that by refinery tonnes would be a fabricated
 * number wearing a formula.
 *
 * CADENCE. A deck reports the current quarter and the same quarter a year
 * earlier, never a run of four. So this fills at most two cells at a time and
 * the row builds up one quarter per refresh, accumulating in the store the way
 * PPAC's throughput does. Today that is Q1 FY26 and Q1 FY27; a quarter from now
 * the Q2 deck adds Q2 FY27, and so on until the window is full.
 */

import { parseRilO2C } from '../parsers/ril-segments.mjs';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Build kpiObjects from one company's cached deck text.
 *
 * Returns the DECK'S OWN quarters alongside the values, and the caller merges
 * over those - never over the company's display window.
 *
 * This is not a detail. A deck covers two quarters; a window covers four. Merged
 * over the window, the two quarters it does not reach are written as NULL cells
 * carrying the run's fingerprint - and a null cell with the current fingerprint
 * counts as settled, so the model would never be asked about them again. A step
 * that knows nothing about Q2 would have silently answered "nothing there" on
 * behalf of every source that might have. The store is keyed by quarter and
 * holds every quarter ever seen, so returning the deck's own periods also keeps
 * the year-ago figure, which the window has not reached yet and will.
 *
 * @param {object} opts
 * @param {string} opts.deckText   extracted text of the investor deck
 * @param {object[]} opts.kpis     this company's KPI spec
 * @param {string} [opts.kpiId='o2c-ebitda-per-tonne']
 * @returns {{kpiObjects:object[], quarters:string[]}} both empty when the deck says nothing
 */
export function fillFromDeck({ deckText, kpis, kpiId = 'o2c-ebitda-per-tonne' }) {
  const nothing = { kpiObjects: [], quarters: [] };
  const spec = (kpis || []).find((k) => k.id === kpiId);
  if (!spec) return nothing;

  let rows;
  try {
    rows = parseRilO2C(deckText || '');
  } catch {
    /* The deck carried both tables and they disagreed about which periods they
       describe. parseRilO2C has already refused; a caller that logged and
       continued is the right behaviour, not a thrown run. */
    return nothing;
  }
  if (!rows.length) return nothing;

  const quarters = rows.map((r) => r.quarter);
  const values = rows.map((r) => r.rupeesPerTonne);
  if (!values.some(isNum)) return nothing;

  /* One note for the row, naming the arithmetic and the quarters it came from,
     so a reader can check the division against the filing rather than trust it. */
  const shown = rows.map((r) => `${r.quarter}: ₹${r.ebitdaCrore} cr ÷ ${r.throughputMmt} MMT`).join('; ');

  const kpiObjects = [{
    id: spec.id,
    label: spec.label,
    unit: '₹/t',
    flagBasis: spec.flagBasis,
    values,
    /* The deck is the company's own unaudited quarterly presentation - the
       brief's [Company Filing], not [Official], which it reserves for audited
       results, exchange filings and regulator data. */
    sourceTags: values.map((v) => (isNum(v) ? 'company-filing' : null)),
    oneOffs: values.map(() => null),
    notes: 'O2C segment EBITDA ÷ O2C crude throughput, both read from Reliance\'s ' +
           `quarterly results presentation (${shown}). Stated in ₹/t because the deck ` +
           'carries no exchange rate for the year-ago quarter, and converting one ' +
           'quarter at this quarter\'s rate would misprice the comparison.',
    flag: null      // computed by the store on merge, never here
  }];

  return { kpiObjects, quarters };
}
