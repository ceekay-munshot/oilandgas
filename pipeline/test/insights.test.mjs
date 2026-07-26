/**
 * Insights-table parser tests. Pure - the browser half (sources/screener-insights)
 * runs in the workflow, where the paid login lives.
 *
 * The fixture mirrors the real ONGC Investors -> Insights grid: a period-headed
 * table whose label cell carries the KPI name, its unit, and sometimes a scope
 * note, with early periods blank for rows Screener only has later history for.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseInsightsTable, insightsToText, parseCell, periodToIso, looksLikePeriod
} from '../parsers/screener-insights.mjs';
import { quarterLabel } from '../lib/fiscal.mjs';

const INSIGHTS_HTML = `
<div class="card">
  <h2>Insights <span class="badge">In beta</span></h2>
  <div class="toggle"><button>Yearly</button><button aria-pressed="true">Quarterly</button></div>
  <table class="data-table">
    <thead><tr>
      <th class="text"></th><th>Sep 2025</th><th>Dec 2025</th><th>Mar 2026</th>
    </tr></thead>
    <tbody>
      <tr>
        <td class="text"><a href="#">1P Proved Reserves (Group)</a><div class="sub">MMTOE</div></td>
        <td>775.42 <i class="icon-info"></i></td><td>779.90 <i class="icon-info"></i></td><td>806.90 <i class="icon-info"></i></td>
      </tr>
      <tr>
        <td class="text"><a href="#">Crude Oil Production (Standalone)</a><div class="sub">MMT &middot; Standalone data</div></td>
        <td>19.60</td><td>19.47</td><td>19.58</td>
      </tr>
      <tr>
        <td class="text"><a href="#">Wells Drilled (Total)</a><div class="sub">Number &middot; Standalone data</div></td>
        <td>578</td><td>544</td><td>461</td>
      </tr>
      <tr>
        <td class="text"><a href="#">Reserve Replacement Ratio (RRR)</a><div class="sub">Ratio &middot; Standalone data</div></td>
        <td></td><td>1.19</td><td>1.35</td>
      </tr>
    </tbody>
  </table>
  <p>&#10022; Extracted by Screener AI</p>
</div>`;

test('parseInsightsTable reads the periods and every row', () => {
  const t = parseInsightsTable(INSIGHTS_HTML);
  assert.deepEqual(t.periods, ['Sep 2025', 'Dec 2025', 'Mar 2026']);
  assert.deepEqual(t.periodsIso, ['2025-09', '2025-12', '2026-03']);
  assert.equal(t.rows.length, 4);
});

test('the label cell splits into name, unit and scope', () => {
  const t = parseInsightsTable(INSIGHTS_HTML);
  const crude = t.rows.find((r) => r.label.startsWith('Crude Oil Production'));
  assert.equal(crude.label, 'Crude Oil Production (Standalone)');
  assert.equal(crude.unit, 'MMT');
  assert.equal(crude.scope, 'Standalone data');
});

test('a row with no scope note keeps a clean unit', () => {
  const t = parseInsightsTable(INSIGHTS_HTML);
  const res = t.rows.find((r) => r.label.startsWith('1P Proved'));
  assert.equal(res.unit, 'MMTOE');
  assert.equal(res.scope, null);
});

test('values parse through the info icon, and Wells Drilled comes out whole', () => {
  const t = parseInsightsTable(INSIGHTS_HTML);
  assert.deepEqual(t.rows.find((r) => r.label.startsWith('1P Proved')).values, [775.42, 779.90, 806.90]);
  // The KPI the client asks for by name: ONGC's new well count.
  assert.deepEqual(t.rows.find((r) => r.label.startsWith('Wells Drilled')).values, [578, 544, 461]);
});

test('a blank period is null, never 0 - an unreported period is not zero wells', () => {
  const t = parseInsightsTable(INSIGHTS_HTML);
  assert.deepEqual(t.rows.find((r) => r.label.startsWith('Reserve Replacement')).values, [null, 1.19, 1.35]);
});

test('parseInsightsTable returns null when no period-headed table is present', () => {
  assert.equal(parseInsightsTable('<table><thead><tr><th>Name</th><th>Notes</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>'), null);
  assert.equal(parseInsightsTable(''), null);
});

test('parseInsightsTable picks the period-headed table out of a fuller page', () => {
  const page = '<table><thead><tr><th>Peer</th><th>CMP</th></tr></thead><tbody><tr><td>X</td><td>1</td></tr></tbody></table>' + INSIGHTS_HTML;
  const t = parseInsightsTable(page);
  assert.deepEqual(t.periods, ['Sep 2025', 'Dec 2025', 'Mar 2026']);
});

test('insightsToText labels each period with the quarter it closes', () => {
  const txt = insightsToText(parseInsightsTable(INSIGHTS_HTML), quarterLabel);
  assert.match(txt, /Sep 2025 \(Q2 FY26\)/);
  assert.match(txt, /Mar 2026 \(Q4 FY26\)/);
  assert.match(txt, /Wells Drilled \(Total\) \[Number\]: 578 \| 544 \| 461/);
  assert.match(txt, /Reserve Replacement Ratio \(RRR\) \[Ratio\]: - \| 1.19 \| 1.35/);
});

test('parseCell tolerates grouping, dashes and percent, and refuses junk', () => {
  assert.equal(parseCell('1,23,456'), 123456);
  assert.equal(parseCell('16%'), 16);
  assert.equal(parseCell('–'), null);
  assert.equal(parseCell(''), null);
  assert.equal(parseCell('n/a'), null);
});

test('periodToIso and looksLikePeriod accept month-year and TTM, reject labels', () => {
  assert.equal(periodToIso('Mar 2026'), '2026-03');
  assert.equal(periodToIso('TTM'), null);
  assert.equal(looksLikePeriod('Mar 2026'), true);
  assert.equal(looksLikePeriod('TTM'), true);
  assert.equal(looksLikePeriod('Q4 FY26'), true);
  assert.equal(looksLikePeriod('Crude Oil Production'), false);
});

/* ------------------------------------ not the Quarterly Results table ------- */

/* The first live run captured THIS instead of Insights: a real period-headed
   table, just the wrong one. Every row is a standard P&L line. */
const PNL_HTML = `
<section id="quarters"><table class="data-table">
  <thead><tr><th class="text"></th><th>Sep 2025</th><th>Dec 2025</th><th>Mar 2026</th></tr></thead>
  <tbody>
    <tr><td class="text">Sales +</td><td>221.01</td><td>221.50</td><td>248.71</td></tr>
    <tr><td class="text">Expenses +</td><td>129.41</td><td>121.33</td><td>166.81</td></tr>
    <tr><td class="text">Operating Profit</td><td>91.60</td><td>100.17</td><td>81.90</td></tr>
    <tr><td class="text">OPM %</td><td>41.45</td><td>45.22</td><td>32.93</td></tr>
    <tr><td class="text">Interest</td><td>6.51</td><td>4.32</td><td>2.67</td></tr>
    <tr><td class="text">Depreciation</td><td>14.90</td><td>15.65</td><td>15.64</td></tr>
  </tbody>
</table></section>`;

test('a P&L label cell yields no unit - the label is not its own unit', () => {
  // The bug: with no separate unit line, `rest` equalled the label, so rows came
  // out as "Operating Profit [Operating Profit]".
  const t = parseInsightsTable(PNL_HTML);
  const op = t.rows.find((r) => r.label.startsWith('Operating Profit'));
  assert.equal(op.unit, null);
  const opm = t.rows.find((r) => r.label.startsWith('OPM'));
  assert.equal(opm.unit, null);
});

test('the P&L table still parses as a table - rejecting it is the browser\'s job', () => {
  // parseInsightsTable is deliberately not the guard: it reads whatever table it
  // is handed. Choosing the RIGHT table happens in the page, where the Insights
  // card's own wording ("Extracted by Screener AI") can be anchored on, and where
  // a P&L-shaped table is refused. Pinning this so the split of responsibility is
  // explicit rather than accidental.
  const t = parseInsightsTable(PNL_HTML);
  assert.ok(t && t.rows.length === 6);
  assert.deepEqual(t.periods, ['Sep 2025', 'Dec 2025', 'Mar 2026']);
});

/* ------------------------------- the browser's text matrix (preferred) ------ */

import { parseInsightsMatrix } from '../parsers/screener-insights.mjs';

/* Exactly the shape the live run produced, which the markup parser could not
   read: the label cell separates name from unit with a <br>, so cheerio's child
   walk saw nothing and returned "Order BookRs Crore" with unit null and every
   value null. innerText gives the browser's already-resolved lines instead.
   Note Screener's separator here is a katakana middle dot, not a Latin one. */
const MATRIX = {
  periods: ['Jun 2025', 'Sep 2025', 'Dec 2025', 'Mar 2026'],
  rows: [
    { lines: ['Order Book', 'Rs Crore'], cells: ['3,051', '3,050', '2,967', '3,000'] },
    { lines: ['Consultancy Order Book', 'INR mn ・Standalone data'], cells: ['1,21,450', '', '1,45,000', '1,51,090'] },
    { lines: ['Kochi Terminal Capacity Utilization', '%'], cells: ['21 ⓘ', '23 ⓘ', '20 ⓘ', '22 ⓘ'] },
    { lines: ['Onshore Rigs (Drilling + Workover)', 'Number'], cells: ['12', '12', '13', '-'] }
  ]
};

test('parseInsightsMatrix splits the name from the unit across the <br>', () => {
  const t = parseInsightsMatrix(MATRIX);
  const ob = t.rows.find((r) => r.label === 'Order Book');
  assert.equal(ob.label, 'Order Book');          // not "Order BookRs Crore"
  assert.equal(ob.unit, 'Rs Crore');
});

test('parseInsightsMatrix reads the values the markup route lost', () => {
  const t = parseInsightsMatrix(MATRIX);
  assert.deepEqual(t.rows.find((r) => r.label === 'Order Book').values, [3051, 3050, 2967, 3000]);
});

test('parseInsightsMatrix handles the katakana middle dot in the unit line', () => {
  const t = parseInsightsMatrix(MATRIX);
  const c = t.rows.find((r) => r.label === 'Consultancy Order Book');
  assert.equal(c.unit, 'INR mn');
  assert.equal(c.scope, 'Standalone data');
  assert.deepEqual(c.values, [121450, null, 145000, 151090]);   // blank -> null
});

test('parseInsightsMatrix strips the info glyph and maps a dash to null', () => {
  const t = parseInsightsMatrix(MATRIX);
  assert.deepEqual(t.rows.find((r) => r.label.startsWith('Kochi')).values, [21, 23, 20, 22]);
  assert.deepEqual(t.rows.find((r) => r.label.startsWith('Onshore')).values, [12, 12, 13, null]);
});

test('parseInsightsMatrix labels periods and returns null on an empty matrix', () => {
  const t = parseInsightsMatrix(MATRIX);
  assert.deepEqual(t.periodsIso, ['2025-06', '2025-09', '2025-12', '2026-03']);
  assert.equal(parseInsightsMatrix(null), null);
  assert.equal(parseInsightsMatrix({ periods: [], rows: [] }), null);
});
