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
