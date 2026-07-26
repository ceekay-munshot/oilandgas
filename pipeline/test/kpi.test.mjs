/**
 * KPI extractor - pure helper tests. No network, no LLM. The model call itself
 * runs in the "Refresh company data" / refresh-full workflows, where the keys and
 * the document cache live.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { trajectoryFlag, flagBasisSeries, flagFor } from '../lib/kpi-flag.mjs';
import { reportedQuarter, quarterLabel, quarterIndex } from '../lib/fiscal.mjs';
import {
  preFilter, financialsToText, buildMessages, normalizeResult, coverageOf, KPI_SCHEMA
} from '../parsers/kpi-prompt.mjs';

/* --------------------------------------------------------------- flags ------ */

test('trajectoryFlag names the five momentum cases', () => {
  assert.equal(trajectoryFlag([10, 20, 40]), 'accelerating');   // change 10 -> 20, faster
  assert.equal(trajectoryFlag([10, 50, 70]), 'decelerating');   // change 40 -> 20, slower
  assert.equal(trajectoryFlag([30, 10, 20]), 'inflecting-up');  // fell, then rose
  assert.equal(trajectoryFlag([10, 30, 20]), 'inflecting-down');// rose, then fell
  assert.equal(trajectoryFlag([50, 60, 70]), 'steady');         // constant +10 pace
});

test('trajectoryFlag reads a sustained decline as the cautionary decelerating', () => {
  assert.equal(trajectoryFlag([40, 30, 20]), 'decelerating');
});

test('trajectoryFlag needs three usable points, else null', () => {
  assert.equal(trajectoryFlag([10, 20]), null);
  assert.equal(trajectoryFlag([null, 20, null, 40]), null);      // only two finite
});

test('the flatBandPct dead-band swallows a tiny wobble', () => {
  // ~0.5% moves on a ~100 level, well inside a 1.5% band -> steady, not a trend.
  assert.equal(trajectoryFlag([100, 100.5, 101], 1.5), 'steady');
});

test('flagBasis is a reading hint - the flag is computed on the values', () => {
  // A steadily shrinking order book must not read as steady just because it is
  // "qoq"; it is flagged on the level like everything else.
  assert.deepEqual(flagBasisSeries([1300, 1200, 1100, 1000], 'qoq'), [1300, 1200, 1100, 1000]);
  assert.equal(flagFor([1300, 1200, 1100, 1000], 'qoq'), 'decelerating');
  assert.equal(flagFor([1000, 1100, 1250, 1450], 'qoq'), 'accelerating'); // growth speeding up
});

test('flagFor on a yoy series flags the growth rate turning', () => {
  assert.equal(flagFor([8, 10, 6, 9], 'yoy'), 'inflecting-up');  // growth fell then rose
});

/* ------------------------------------------------------------- pre-filter --- */

const PPT = { label: 'INVESTOR PPT [company filing]',
  text: 'Cover slide. Rig utilisation stood at 88% this quarter. ' + 'x'.repeat(2000) +
        ' Order book at Rs 1,250 cr. ' + 'y'.repeat(2000) + ' end.' };
const CALL = { label: 'CONCALL TRANSCRIPT [management call]',
  text: 'Operator intro ' + 'z'.repeat(3000) + ' management said day-rate improved to $95,000. bye' };

test('preFilter keeps only windows around the keywords, and drops sources with no hit', () => {
  const blocks = preFilter([PPT, CALL, { label: 'NOISE', text: 'weather and sports' }],
    ['utilisation', 'order book', 'day-rate'], { maxChars: 24000, window: 60 });
  assert.equal(blocks.length, 2);                       // NOISE dropped
  assert.match(blocks[0].text, /utilisation stood at 88%/);
  assert.match(blocks[0].text, /Order book at Rs 1,250 cr/);
  assert.ok(!blocks[0].text.includes('xxxxxxxxxxxxxxxxxxxx'.repeat(5))); // filler trimmed out
  assert.match(blocks[1].text, /day-rate improved to \$95,000/);
});

test('preFilter respects the character budget', () => {
  const big = { label: 'BIG', text: 'utilisation ' + 'a'.repeat(50000) };
  const blocks = preFilter([big], ['utilisation'], { maxChars: 1000, window: 40000 });
  const total = blocks.reduce((n, b) => n + b.text.length, 0);
  assert.ok(total <= 1200, `budget respected, got ${total}`);
});

test('financialsToText lays out the quarterly rows and pros/cons', () => {
  const fin = {
    tables: { quarters: { periods: ['Mar 2025', 'Jun 2025'], order: ['Sales', 'OPM %'],
      rows: { 'Sales': [100, 120], 'OPM %': [20, null] } } },
    analysis: { pros: ['Debt free'], cons: ['Low tax'] }
  };
  const t = financialsToText(fin);
  assert.match(t, /periods: Mar 2025 \| Jun 2025/);
  assert.match(t, /Sales: 100 \| 120/);
  assert.match(t, /OPM %: 20 \| -/);           // null renders as '-'
  assert.match(t, /Pros: Debt free/);
});

/* -------------------------------------------------------------- messages ---- */

test('buildMessages carries the ids, quarter order and the honesty rule', () => {
  const { system, user } = buildMessages({
    companyName: 'Deep Industries',
    kpis: [{ id: 'order-book', label: 'Order book', unit: 'Rs cr', flagBasis: 'qoq' }],
    quarters: ['Q2 FY26', 'Q3 FY26', 'Q4 FY26', 'Q1 FY27'],
    blocks: [{ label: 'INVESTOR PPT', text: 'order book Rs 1250 cr' }]
  });
  assert.match(system, /Never estimate, guess/i);
  assert.match(user, /id "order-book"/);
  assert.match(user, /\[0\] Q2 FY26/);
  assert.match(user, /INVESTOR PPT/);
});

/* ------------------------------------------------------------- normalise ---- */

const SPEC = [
  { id: 'util', label: 'Utilisation %', unit: '%', flagBasis: 'level' },
  { id: 'ob', label: 'Order book', unit: 'Rs cr', flagBasis: 'qoq' }
];
const QUARTERS = ['Q2 FY26', 'Q3 FY26', 'Q4 FY26', 'Q1 FY27'];

test('normalizeResult coerces to four cells and computes the flag in code', () => {
  const raw = { kpis: [
    { id: 'util', unit: '%', values: [80, 82, 84, 86], sourceTags: ['company-filing', 'company-filing', 'mgmt-claim', 'company-filing'], notes: null },
    { id: 'ob', unit: 'Rs cr', values: [1000, 1100, 1250, 1450], sourceTags: ['company-filing', 'company-filing', 'company-filing', 'company-filing'], notes: 'from PPT' }
  ] };
  const out = normalizeResult(raw, SPEC, QUARTERS);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].values, [80, 82, 84, 86]);
  assert.equal(out[0].flag, 'steady');            // +2 each quarter
  assert.equal(out[1].flag, 'accelerating');      // growth speeding up
  assert.equal(out[1].notes, 'from PPT');
});

test('normalizeResult nulls a missing quarter and drops its source tag', () => {
  const raw = { kpis: [{ id: 'util', unit: '%', values: [80, null, 84], sourceTags: ['company-filing', 'mgmt-claim', 'company-filing'], notes: 'Q3 not disclosed' }] };
  const out = normalizeResult(raw, [SPEC[0]], QUARTERS);
  assert.deepEqual(out[0].values, [80, null, 84, null]);   // padded to 4
  assert.equal(out[0].sourceTags[1], null);                // no value -> no source
  assert.equal(out[0].sourceTags[3], null);
});

test('normalizeResult clamps an unknown source tag and falls back to the spec unit', () => {
  const raw = { kpis: [{ id: 'util', unit: '', values: [80, 82, 84, 86], sourceTags: ['made-up-tag', 'company-filing', 'company-filing', 'company-filing'], notes: null }] };
  const out = normalizeResult(raw, [SPEC[0]], QUARTERS);
  assert.equal(out[0].sourceTags[0], 'unknown');   // not in the allowed set
  assert.equal(out[0].unit, '%');                  // empty unit -> spec hint
});

test('normalizeResult fills every spec KPI even if the model omitted one', () => {
  const out = normalizeResult({ kpis: [] }, SPEC, QUARTERS);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].values, [null, null, null, null]);
  assert.equal(out[0].flag, null);
});

test('coverageOf counts filled versus empty cells', () => {
  const out = normalizeResult({ kpis: [
    { id: 'util', unit: '%', values: [80, 82, null, 86], sourceTags: [], notes: null }
  ] }, [SPEC[0]], QUARTERS);
  assert.deepEqual(coverageOf(out), { cells: 4, real: 3, nullCells: 1 });
});

test('KPI_SCHEMA is strict-schema shaped (all props required, no extras)', () => {
  assert.equal(KPI_SCHEMA.additionalProperties, false);
  const item = KPI_SCHEMA.properties.kpis.items;
  assert.deepEqual(item.required.sort(), ['id', 'notes', 'sourceTags', 'unit', 'values']);
  assert.equal(item.additionalProperties, false);
});

/* ---------------------------------------------------- fiscal quarters ------- */

test('quarterLabel maps a quarter-end month onto the Indian fiscal year', () => {
  assert.equal(quarterLabel(2025, 6), 'Q1 FY26');    // Apr-Jun 2025
  assert.equal(quarterLabel(2025, 9), 'Q2 FY26');    // Jul-Sep 2025
  assert.equal(quarterLabel(2025, 12), 'Q3 FY26');   // Oct-Dec 2025
  assert.equal(quarterLabel(2026, 3), 'Q4 FY26');    // Jan-Mar 2026 closes FY26
  assert.equal(quarterLabel(2026, 6), 'Q1 FY27');
  assert.equal(quarterLabel(2026, 5), null);         // not a quarter-end
});

test('reportedQuarter gives the quarter a concall discusses, not the month it happened', () => {
  // This is the mapping the first extraction run lacked.
  assert.equal(reportedQuarter('2025-11'), 'Q2 FY26');   // Nov call -> Jul-Sep 2025
  assert.equal(reportedQuarter('2026-02'), 'Q3 FY26');   // Feb call -> Oct-Dec 2025
  assert.equal(reportedQuarter('2026-05'), 'Q4 FY26');   // May call -> Jan-Mar 2026
  assert.equal(reportedQuarter('2025-08'), 'Q1 FY26');   // Aug call -> Apr-Jun 2025
});

test('reportedQuarter wraps correctly across the calendar year', () => {
  assert.equal(reportedQuarter('2026-01'), 'Q3 FY26');   // Jan -> Oct-Dec 2025
  assert.equal(reportedQuarter('2026-04'), 'Q4 FY26');   // Apr -> Jan-Mar 2026
  assert.equal(reportedQuarter('2026-07-24'), 'Q1 FY27');// full dates accepted
});

test('reportedQuarter rejects unparseable input rather than guessing', () => {
  assert.equal(reportedQuarter(''), null);
  assert.equal(reportedQuarter(null), null);
  assert.equal(reportedQuarter('2026-13'), null);
});

test('quarterIndex places a quarter in the target window', () => {
  const W = ['Q2 FY26', 'Q3 FY26', 'Q4 FY26', 'Q1 FY27'];
  assert.equal(quarterIndex('Q2 FY26', W), 0);
  assert.equal(quarterIndex('Q4 FY26', W), 2);
  assert.equal(quarterIndex('Q1 FY26', W), -1);   // older than the window
});

test('the smoke set\'s real transcript dates land in the target window', () => {
  // Deep Industries had 2026-05, 2026-02, 2025-11, 2025-08 cached.
  const W = ['Q2 FY26', 'Q3 FY26', 'Q4 FY26', 'Q1 FY27'];
  const mapped = ['2026-05', '2026-02', '2025-11', '2025-08'].map((d) => reportedQuarter(d));
  assert.deepEqual(mapped, ['Q4 FY26', 'Q3 FY26', 'Q2 FY26', 'Q1 FY26']);
  // Three of the four are in-window; the August call reports a quarter that is
  // older than the window and is dropped rather than misfiled.
  assert.deepEqual(mapped.map((q) => quarterIndex(q, W)), [2, 1, 0, -1]);
});

/* ------------------------------------------------ rolling quarter window ---- */

import { windowFor, qKey } from '../extract-kpis.mjs';

const mapOf = (labels) => new Map(labels.map((q) => [q, { quarter: q, docs: [] }]));

test('qKey sorts quarters across a fiscal-year boundary', () => {
  assert.ok(qKey('Q1 FY27') > qKey('Q4 FY26'));
  assert.ok(qKey('Q4 FY26') > qKey('Q3 FY26'));
  assert.equal(qKey('nonsense'), -1);
});

test('windowFor takes the four most recent quarters, oldest first', () => {
  // gatherByQuarter hands them newest-first; the window is chronological.
  const m = mapOf(['Q4 FY26', 'Q3 FY26', 'Q2 FY26', 'Q1 FY26', 'Q4 FY25']);
  assert.deepEqual(windowFor(m, []), ['Q1 FY26', 'Q2 FY26', 'Q3 FY26', 'Q4 FY26']);
});

test('windowFor rolls forward on its own when a new quarter lands', () => {
  const before = windowFor(mapOf(['Q4 FY26', 'Q3 FY26', 'Q2 FY26', 'Q1 FY26']), []);
  const after = windowFor(mapOf(['Q1 FY27', 'Q4 FY26', 'Q3 FY26', 'Q2 FY26', 'Q1 FY26']), []);
  assert.deepEqual(before, ['Q1 FY26', 'Q2 FY26', 'Q3 FY26', 'Q4 FY26']);
  assert.deepEqual(after, ['Q2 FY26', 'Q3 FY26', 'Q4 FY26', 'Q1 FY27']);  // oldest dropped
});

test('a company behind on filings gets its own older window, not empty columns', () => {
  // IGL's cached calls stopped at Feb 2026 (Q3 FY26) while others reached Q4 FY26.
  assert.deepEqual(
    windowFor(mapOf(['Q3 FY26', 'Q2 FY26', 'Q1 FY26', 'Q4 FY25']), []),
    ['Q4 FY25', 'Q1 FY26', 'Q2 FY26', 'Q3 FY26']
  );
});

test('windowFor falls back to the spec window when nothing was cached', () => {
  const fb = ['Q2 FY26', 'Q3 FY26', 'Q4 FY26', 'Q1 FY27'];
  assert.deepEqual(windowFor(new Map(), fb), fb);
});

test('windowFor copes with fewer than four cached quarters', () => {
  assert.deepEqual(windowFor(mapOf(['Q4 FY26', 'Q3 FY26']), []), ['Q3 FY26', 'Q4 FY26']);
});

/* ------------------------------------------------ screener credentials ------ */

import { screenerCredentials } from '../lib/env.mjs';

test('screenerCredentials prefers the paid pair - only it can read AI summaries', () => {
  const c = screenerCredentials({
    SCREENER_PAID_EMAIL: 'paid@x.com', SCREENER_PAID_PASSWORD: 'p2',
    SCREENER_EMAIL: 'free@x.com', SCREENER_PASSWORD: 'p1'
  });
  assert.equal(c.email, 'paid@x.com');
  assert.equal(c.tier, 'paid');
});

test('screenerCredentials falls back to the free pair', () => {
  const c = screenerCredentials({ SCREENER_EMAIL: 'free@x.com', SCREENER_PASSWORD: 'p1' });
  assert.equal(c.email, 'free@x.com');
  assert.equal(c.tier, 'free');
});

test('a half-set paid pair does not shadow a complete free pair', () => {
  // An empty secret in CI reads as '' - it must not win and strand the login.
  const c = screenerCredentials({
    SCREENER_PAID_EMAIL: 'paid@x.com', SCREENER_PAID_PASSWORD: '',
    SCREENER_EMAIL: 'free@x.com', SCREENER_PASSWORD: 'p1'
  });
  assert.equal(c.email, 'free@x.com');
  assert.equal(c.tier, 'free');
});

test('screenerCredentials reports none when nothing is set', () => {
  const c = screenerCredentials({});
  assert.equal(c.email, null);
  assert.equal(c.tier, 'none');
});
