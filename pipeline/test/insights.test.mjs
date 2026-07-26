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
  parseInsightsTable, insightsToText, parseCell, periodToIso, looksLikePeriod, viewFromPeriods,
  parseCitation
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

/* The live run recorded view "quarterly" on four companies whose columns were
   Mar 2016..Mar 2026 - annual data, because the Quarterly control that got clicked
   belonged to another card. The click is not evidence; the months are. */
test('viewFromPeriods calls a repeated year-end month yearly', () => {
  assert.equal(viewFromPeriods(['Mar 2024', 'Mar 2025', 'Mar 2026']), 'yearly');
  assert.equal(viewFromPeriods(['Mar 2016', 'Mar 2017', 'Mar 2018', 'Mar 2019']), 'yearly');
  // A December year-end is just as annual.
  assert.equal(viewFromPeriods(['Dec 2023', 'Dec 2024', 'Dec 2025']), 'yearly');
});

test('viewFromPeriods calls cycling months quarterly', () => {
  assert.equal(viewFromPeriods(['Jun 2025', 'Sep 2025', 'Dec 2025', 'Mar 2026']), 'quarterly');
  assert.equal(viewFromPeriods(['Sep 2025', 'Dec 2025']), 'quarterly');
});

test('viewFromPeriods says unknown rather than guess from too little', () => {
  assert.equal(viewFromPeriods(['Mar 2026']), 'unknown');
  assert.equal(viewFromPeriods([]), 'unknown');
  assert.equal(viewFromPeriods(['TTM', 'Q4 FY26']), 'unknown');
});

test('an annual table is labelled FULL YEAR, never as a quarter', () => {
  // Mar 2026 closes Q4 FY26, so the quarter label would be literally true and
  // completely misleading: the value is twelve months, not three.
  const yearly = parseInsightsTable(INSIGHTS_HTML.replace(
    '<th>Sep 2025</th><th>Dec 2025</th><th>Mar 2026</th>',
    '<th>Mar 2024</th><th>Mar 2025</th><th>Mar 2026</th>'
  ));
  const txt = insightsToText(yearly, quarterLabel);
  assert.match(txt, /FULL YEARS, not quarters/);
  assert.match(txt, /Mar 2026 \(FY26, FULL YEAR\)/);
  // Assert on the header line, not the whole text: the guidance above it names
  // Q4 FY26 on purpose, to say the stock rows ARE usable for that quarter.
  assert.doesNotMatch(periodLine(txt), /Q[1-4] FY/);
});

/** The `periods:` line - the only place a column is actually labelled. */
const periodLine = (txt) => txt.split('\n').find((l) => l.startsWith('periods:')) || '';

test('an annual table still offers its stock rows - only flows are held back', () => {
  const yearly = parseInsightsTable(INSIGHTS_HTML.replace(
    '<th>Sep 2025</th><th>Dec 2025</th><th>Mar 2026</th>',
    '<th>Mar 2024</th><th>Mar 2025</th><th>Mar 2026</th>'
  ));
  const txt = insightsToText(yearly, quarterLabel);
  // Reserves are a position as of the column date, so the annual view carries a
  // usable Q4 number. Banning the whole table would throw that away.
  assert.match(txt, /STOCK measure/);
  assert.match(txt, /position AS OF the column date/);
  assert.match(txt, /FLOW measure/);
  assert.match(txt, /1P Proved Reserves \(Group\) \[MMTOE\]: 775.42/);
});

test('an undetermined cadence gets no quarter label at all', () => {
  // "Mar 2026 | TTM" leaves one parseable month, so the cadence is unknown - and
  // an unknown cadence must not inherit the quarterly reading.
  const t = parseInsightsTable(INSIGHTS_HTML.replace(
    '<th>Sep 2025</th><th>Dec 2025</th><th>Mar 2026</th>',
    '<th>Mar 2026</th><th>TTM</th>'
  ));
  assert.equal(viewFromPeriods(t.periods), 'unknown');
  const txt = insightsToText(t, quarterLabel);
  assert.match(txt, /cadence of these columns could not be determined/);
  // Bare period headers - neither reading is asserted, because neither is known.
  assert.equal(periodLine(txt), 'periods: Mar 2026 | TTM');
});

test('a quarterly table keeps its quarter labels and gains no annual warning', () => {
  const txt = insightsToText(parseInsightsTable(INSIGHTS_HTML), quarterLabel);
  assert.match(txt, /Mar 2026 \(Q4 FY26\)/);
  assert.doesNotMatch(txt, /FULL YEAR/);
});

/* The exact markup the live dump returned. Every value in the first three runs
   came back null against this, for two reasons visible right here: the unit is in
   a `.sub` span behind a <br>, and each value cell carries Screener's citation
   inline after the number. */
const LIVE_ROW_HTML = `
<table>
  <thead><tr>
    <th class="text"></th>
    <th data-date-key="2022-03-31">Mar 2022</th>
    <th data-date-key="2023-03-31">Mar 2023</th>
    <th data-date-key="2024-03-31">Mar 2024</th>
  </tr></thead>
  <tbody>
    <tr class="stripe">
      <td class="text">
        Onshore Rigs (Drilling + Workover)<br><span class="font-weight-500 font-size-12 sub">Number</span>
      </td>
      <td class=""><span class="inline-flex flex-align-center gap-2"><span>11</span>
        <span class="has-tooltip opacity-45"><span class="icon-info smaller"></span>
        <span class="tooltip"><span class="font-weight-500">Presentation - 07 May 2022</span><br>
        <span class="ink-700">&ldquo;Owns &amp; Operates 8 Workover Rigs with capacity ranging from 30T to 100T, 3 Drilling Rigs with capacity of 1000Hp.&rdquo;</span><br>
        <span class="ink-600">Page 24 &middot; <a href="#">Source</a></span></span></span></span></td>
      <td class=""><span><span>14</span></span></td>
      <td class=""></td>
    </tr>
    <tr>
      <td class="text">Order Book<br><span class="sub">Rs Crore &#12539; Standalone data</span></td>
      <td>3,051 Presentation - 14 May 2026 &ldquo;Order book of Rs 3,051 crore&rdquo; Page 6 &middot; Source</td>
      <td>2,967</td>
      <td>-</td>
    </tr>
  </tbody>
</table>`;

test('the live markup parses - unit off the .sub span, value before the citation', () => {
  const t = parseInsightsTable(LIVE_ROW_HTML);
  assert.deepEqual(t.periods, ['Mar 2022', 'Mar 2023', 'Mar 2024']);
  assert.equal(t.rows[0].label, 'Onshore Rigs (Drilling + Workover)');
  assert.equal(t.rows[0].unit, 'Number');
  // 11 - not null, and not 8 from "8 Workover Rigs" inside the quote.
  assert.deepEqual(t.rows[0].values, [11, 14, null]);
});

test('the katakana scope note still splits off the unit', () => {
  const t = parseInsightsTable(LIVE_ROW_HTML);
  assert.equal(t.rows[1].label, 'Order Book');
  assert.equal(t.rows[1].unit, 'Rs Crore');
  assert.equal(t.rows[1].scope, 'Standalone data');
  assert.deepEqual(t.rows[1].values, [3051, 2967, null]);
});

test('the citation Screener attaches to a value is kept', () => {
  const t = parseInsightsTable(LIVE_ROW_HTML);
  const c = t.rows[0].citations[0];
  assert.equal(c.doc, 'Presentation - 07 May 2022');
  assert.equal(c.page, 24);
  assert.match(c.quote, /Owns & Operates 8 Workover Rigs/);
  // No value means nothing to attribute.
  assert.equal(t.rows[0].citations[2], null);
});

test('parseCitation pulls document, page and quote out of one cell', () => {
  const c = parseCitation('3,051 Presentation - 14 May 2026 “Order book of Rs 3,051 crore” Page 6 · Source');
  assert.equal(c.doc, 'Presentation - 14 May 2026');
  assert.equal(c.quote, 'Order book of Rs 3,051 crore');
  assert.equal(c.page, 6);
  assert.equal(parseCitation('3051'), null);       // a bare number cites nothing
  assert.equal(parseCitation(''), null);
});

test('insightsToText passes the citation through to the model', () => {
  const txt = insightsToText(parseInsightsTable(LIVE_ROW_HTML), quarterLabel);
  assert.match(txt, /Onshore Rigs \(Drilling \+ Workover\) \[Number\]: 11 \| 14 \| -/);
  assert.match(txt, /source: Presentation - 07 May 2022, page 24 \(Screener citation\)/);
});

test('parseCell takes the leading number and ignores the citation after it', () => {
  assert.equal(parseCell('11 Presentation - 07 May 2022 “Owns & Operates 8 Workover Rigs” Page 24 · Source'), 11);
  assert.equal(parseCell('3,051 Presentation “Order book of Rs 3,051 crore” Page 6'), 3051);
  assert.equal(parseCell('94.5% Annual Report'), 94.5);
  // Text first means the number is not this column's value.
  assert.equal(parseCell('Presentation - 07 May 2022 Page 24'), null);
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
