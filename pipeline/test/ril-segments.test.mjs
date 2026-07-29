import test from 'node:test';
import assert from 'node:assert/strict';

import { parseO2CEbitda, parseO2CThroughput, parseRilO2C } from '../parsers/ril-segments.mjs';
import { fillFromDeck } from '../lib/ril-fill.mjs';

/* Verbatim slices of the real Q1 FY27 deck (BSE, 77 pages), as pdf-parse
   extracted it on 2026-07-29 - line breaks and all. The two tables are ~24,000
   characters apart in the document; the filler between them here stands in for
   that distance and for the other "₹ crore" headers that sit in between. */
const SEGMENT_PAGE = `PAT 21,859 23,196 2.5 6.1%

-- 10 of 77 --

10
₹ crore Q1 FY26 Q1 FY27 YoY
Change %
Oil to
Chemicals 14,511 17,010 17.2%
Oil and Gas 4,996 4,973 (0.5%)
Digital Services 18,312 21,255 16.1%
Retail 6,381 6,309 (1.1%)
Others 4,900 4,520 (7.8%)
Total EBITDA 49,100 54,067 10.1%
RIL Segment Performance: Q1 FY27`;

const BALANCE_SHEET = `Strong Balance Sheet: Q1 FY27
Particulars
Mar-26 Jun-26
₹ crore ₹ crore $ Bn
Net Debt 1,24,717 1,22,914 13.0
LTM EBITDA 2,07,911 2,03,954 21.5`;

const VOLUME_PAGE = `Maximized netback by re-routing product to deficit markets -
Singapore, Australia and East and South Africa
Volume (in MMT) Q1
FY26
Q1
FY27
Throughput 19.1 18.1
Production meant for sale
Transportation fuels 11.4 9.6
Polymer and Elastomers 1.6 1.4
Intermediates and Polyesters 2.2 2.0
Others 2.1 2.6
Total 17.3 15.6`;

const DECK = `${SEGMENT_PAGE}\n\n${BALANCE_SHEET}\n\n${VOLUME_PAGE}`;

const KPIS = [{ id: 'o2c-ebitda-per-tonne', label: 'O2C EBITDA per tonne', unit: '₹/t', flagBasis: 'level' }];

/* --------------------------------------------------------------- the tables */

test('the segment table yields O2C EBITDA and the quarters it covers', () => {
  const out = parseO2CEbitda(DECK);
  assert.deepEqual(out.quarters, ['Q1 FY26', 'Q1 FY27']);
  assert.deepEqual(out.values, [14511, 17010]);
});

test('the header is read backwards from the row, not forwards from "₹ crore"', () => {
  /* "₹ crore" appears three times in the deck, and the balance sheet's copy has
     no quarter labels at all. Anchoring forwards on that phrase found the wrong
     table and returned nothing - a silent loss of the whole KPI. */
  const reordered = `${BALANCE_SHEET}\n\n${SEGMENT_PAGE}\n\n${VOLUME_PAGE}`;
  const out = parseO2CEbitda(reordered);
  assert.deepEqual(out.quarters, ['Q1 FY26', 'Q1 FY27']);
  assert.deepEqual(out.values, [14511, 17010]);
});

test('the volume table yields throughput, with quarter labels the PDF split across lines', () => {
  /* The header prints as "Q1\\nFY26\\nQ1\\nFY27" - the label wraps mid-quarter. */
  const out = parseO2CThroughput(DECK);
  assert.deepEqual(out.quarters, ['Q1 FY26', 'Q1 FY27']);
  assert.deepEqual(out.values, [19.1, 18.1]);
});

/* --------------------------------------------------------------- the margin */

test('EBITDA per tonne is the two tables divided, quarter for quarter', () => {
  const rows = parseRilO2C(DECK);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.quarter), ['Q1 FY26', 'Q1 FY27']);
  // 14,511 crore = ₹145.11bn over 19.1 MMT = 19.1mn tonnes
  assert.equal(rows[0].rupeesPerTonne, 7597);
  assert.equal(rows[1].rupeesPerTonne, 9398);
});

test('tables covering different periods are REFUSED, not divided', () => {
  /* The whole reason this parser reads both headers. A deck that reported
     EBITDA year-on-year and volumes quarter-on-quarter would produce a number
     that looks exactly like a margin and is not - and no later check would
     catch it, because the value is plausible. */
  const mismatched = DECK.replace('Volume (in MMT) Q1\nFY26\nQ1\nFY27', 'Volume (in MMT) Q4\nFY26\nQ1\nFY27');
  assert.throws(() => parseRilO2C(mismatched), /different periods/);
});

test('half a table claims nothing', () => {
  assert.deepEqual(parseRilO2C(SEGMENT_PAGE), []);      // EBITDA, no volume
  assert.deepEqual(parseRilO2C(VOLUME_PAGE), []);       // volume, no EBITDA
  assert.deepEqual(parseRilO2C(''), []);
});

test('an implausible figure is not accepted as a margin input', () => {
  /* 181 MMT in a quarter is a year's throughput for the whole country. A
     decimal point lost in extraction must fail, not scale the margin by ten. */
  const bad = DECK.replace('Throughput 19.1 18.1', 'Throughput 19.1 181');
  assert.equal(parseO2CThroughput(bad), null);
  assert.deepEqual(parseRilO2C(bad), []);
});

/* ------------------------------------------------------------------ the fill */

test('the fill returns the DECK\'s quarters, not a window', () => {
  /* Merged over a four-quarter window instead, the two quarters the deck does
     not reach would be written as null cells carrying this run\'s fingerprint -
     and a null cell with the current fingerprint counts as settled, so the
     model would never be asked about them again. A step that knows nothing
     about Q2 must not answer on behalf of every source that might. */
  const out = fillFromDeck({ deckText: DECK, kpis: KPIS });
  assert.deepEqual(out.quarters, ['Q1 FY26', 'Q1 FY27']);
  assert.equal(out.kpiObjects.length, 1);
  assert.deepEqual(out.kpiObjects[0].values, [7597, 9398]);
  assert.deepEqual(out.kpiObjects[0].sourceTags, ['company-filing', 'company-filing']);
  assert.equal(out.kpiObjects[0].unit, '₹/t');
  assert.equal(out.kpiObjects[0].flag, null);            // the store computes the flag
  assert.match(out.kpiObjects[0].notes, /17010 cr ÷ 18\.1 MMT/);
});

test('every value the fill emits is real - it never writes a null cell', () => {
  const out = fillFromDeck({ deckText: DECK, kpis: KPIS });
  assert.equal(out.kpiObjects[0].values.every((v) => v != null), true);
  assert.equal(out.kpiObjects[0].values.length, out.quarters.length);
});

test('a KPI the company spec does not carry is not invented', () => {
  const out = fillFromDeck({ deckText: DECK, kpis: [{ id: 'grm', label: 'GRM' }] });
  assert.deepEqual(out, { kpiObjects: [], quarters: [] });
});

test('a deck whose tables disagree fills nothing rather than throwing the run', () => {
  const mismatched = DECK.replace('Volume (in MMT) Q1\nFY26\nQ1\nFY27', 'Volume (in MMT) Q4\nFY26\nQ1\nFY27');
  assert.deepEqual(fillFromDeck({ deckText: mismatched, kpis: KPIS }), { kpiObjects: [], quarters: [] });
});

test('a deck with no tables at all fills nothing', () => {
  assert.deepEqual(fillFromDeck({ deckText: '', kpis: KPIS }), { kpiObjects: [], quarters: [] });
});
