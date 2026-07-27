/**
 * Filling KPI cells straight from Screener's Insights table.
 *
 * The fixture is Petronet's real shape, because Petronet is the case that made
 * this necessary: the model produced [-, 27, 94, 90.1] for regas utilisation by
 * reading KOCHI's terminal for one quarter and DAHEJ's for another. The table has
 * them as separate rows, so the mapped series is [-, -, 94, 90.1] - two honest
 * gaps instead of a number from the wrong terminal and a flag built on it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fillFromInsights, fillTotals } from '../lib/insights-fill.mjs';
import { quarterLabel } from '../lib/fiscal.mjs';
import { freshStore, mergeIntoStore, renderWindow, rankOf } from '../lib/kpi-store.mjs';
import { flagFor } from '../lib/kpi-flag.mjs';

const QUARTERS = ['Q1 FY26', 'Q2 FY26', 'Q3 FY26', 'Q4 FY26'];

// Jun 2025 = Q1 FY26 ... Mar 2026 = Q4 FY26, with two earlier quarters attached.
const PETRONET = {
  view: 'quarterly',
  periods: ['Dec 2024', 'Mar 2025', 'Jun 2025', 'Sep 2025', 'Dec 2025', 'Mar 2026'],
  periodsIso: ['2024-12', '2025-03', '2025-06', '2025-09', '2025-12', '2026-03'],
  rows: [
    { label: 'Dahej Terminal Capacity Utilization', unit: '%', scope: null,
      values: [93, null, null, null, 94, 90.1],
      citations: [null, null, null, null, null,
        { doc: 'Concall Transcript - 14 May 2026', quote: 'Dahej ran at 90.1%', page: 3 }] },
    { label: 'Kochi Terminal Capacity Utilization', unit: '%', scope: null,
      values: [24, 25, 26, 27, 29, 31], citations: [] },
    { label: 'Total LNG Throughput', unit: 'TBTU', scope: null,
      values: [230, 228, 220, 211, 233, 219], citations: [] }
  ]
};

const KPIS = [
  { id: 'regas-utilisation', label: 'Regas utilisation %', unit: '%', flagBasis: 'level',
    insightsRows: ['Dahej Terminal Capacity Utilization'] },
  { id: 'volume', label: 'Volume', unit: 'tmt / mmbtu', flagBasis: 'qoq',
    insightsRows: ['Total LNG Throughput'] },
  { id: 'unmapped', label: 'Something else', unit: null, flagBasis: 'level' }
];

const fill = (insights = PETRONET, kpis = KPIS, quarters = QUARTERS) =>
  fillFromInsights({ insights, kpis, quarters, quarterLabel });

test('a mapped row fills the window, aligned by the quarter each column closes', () => {
  const out = fill();
  const vol = out.find((k) => k.id === 'volume');
  // Jun 2025 | Sep 2025 | Dec 2025 | Mar 2026 -> Q1..Q4 FY26.
  assert.deepEqual(vol.values, [220, 211, 233, 219]);
  assert.equal(vol.unit, 'TBTU');                    // the table's unit, not the spec hint
});

test('the Kochi/Dahej mix-up cannot happen - only the mapped row is read', () => {
  const out = fill();
  const regas = out.find((k) => k.id === 'regas-utilisation');
  // Kochi's 26/27 sit in the same table for Q1/Q2 and are NOT picked up.
  assert.deepEqual(regas.values, [null, null, 94, 90.1]);
});

test('every filled value is tagged company-filing, and empties carry no tag', () => {
  const regas = fill().find((k) => k.id === 'regas-utilisation');
  assert.deepEqual(regas.sourceTags, [null, null, 'company-filing', 'company-filing']);
});

test('Screener\'s citation rides along with the value', () => {
  const regas = fill().find((k) => k.id === 'regas-utilisation');
  assert.equal(regas.citations[3].doc, 'Concall Transcript - 14 May 2026');
  assert.equal(regas.citations[3].page, 3);
  assert.equal(regas.citations[0], null);            // no value, nothing to cite
  assert.match(regas.notes, /Dahej Terminal Capacity Utilization/);
});

test('an unmapped KPI is left alone for the model', () => {
  const out = fill();
  assert.equal(out.find((k) => k.id === 'unmapped'), undefined);
  assert.deepEqual(fillTotals(out), { kpis: 2, cells: 6 });
});

test('a row that is mapped but absent from the table fills nothing', () => {
  const out = fill(PETRONET, [{ id: 'x', label: 'X', flagBasis: 'level', insightsRows: ['Not A Real Row'] }]);
  assert.deepEqual(out, []);
});

test('a row present but empty across the window is not reported as a fill', () => {
  const table = { ...PETRONET, rows: [{ label: 'Dahej Terminal Capacity Utilization', unit: '%', values: [93, null, null, null, null, null], citations: [] }] };
  assert.deepEqual(fill(table, [KPIS[0]]), []);
});

/* An annual table is skipped outright. Whether a full-year figure belongs in a
   quarter depends on the measure - a year-end order book does, a year's order
   inflow does not - and that judgement is the model's to make from the text. This
   path only claims cells it can fill without judging. */
test('an annual table is not filled from', () => {
  const yearly = { ...PETRONET, view: 'yearly' };
  assert.deepEqual(fill(yearly), []);
});

test('label matching ignores case and spacing but not identity', () => {
  const kpis = [{ id: 'v', label: 'V', flagBasis: 'qoq', insightsRows: ['  total   lng   THROUGHPUT '] }];
  assert.deepEqual(fill(PETRONET, kpis)[0].values, [220, 211, 233, 219]);
});

/* The precedence rule. This is the half that repairs data already stored. */
test('a cited Insights value corrects a model value already in the store', () => {
  const store = freshStore();
  const model = [{ id: 'regas-utilisation', unit: '%', values: [null, 27, 94, 90.1],
    sourceTags: [null, 'mgmt-claim', 'mgmt-claim', 'mgmt-claim'], notes: 'Kochi utilisation 27%' }];
  mergeIntoStore({ store, companyId: 'p', kpiObjects: model, quarters: QUARTERS,
    fingerprint: 'a', origin: 'model', model: 'gpt-4o', at: 'run1' });

  const merged = mergeIntoStore({ store, companyId: 'p', kpiObjects: fill().filter((k) => k.id === 'regas-utilisation'),
    quarters: QUARTERS, fingerprint: 'a', origin: 'insights', at: 'run2' });

  assert.equal(merged.corrected, 0, 'Q3/Q4 agree, so nothing is corrected');
  const rows = renderWindow({ store, companyId: 'p', kpis: [KPIS[0]], quarters: QUARTERS, flagFor, flatBandPct: 1.5 });
  // The wrong 27 stands only because Insights has no value for Q2 - and the
  // store records that it came from the model, so it reads as the weaker source.
  assert.equal(rows[0].origins[2], 'insights');
  assert.equal(rows[0].origins[1], 'model');
});

test('where both have a value and they differ, the cited one wins', () => {
  const store = freshStore();
  mergeIntoStore({ store, companyId: 'p', quarters: ['Q4 FY26'], fingerprint: 'a',
    origin: 'model', model: 'gpt-4o', at: 'run1',
    kpiObjects: [{ id: 'regas-utilisation', unit: '%', values: [27], sourceTags: ['mgmt-claim'] }] });

  const merged = mergeIntoStore({ store, companyId: 'p', quarters: ['Q4 FY26'], fingerprint: 'a',
    origin: 'insights', at: 'run2',
    kpiObjects: [{ id: 'regas-utilisation', unit: '%', values: [90.1], sourceTags: ['company-filing'],
      citations: [{ doc: 'Concall Transcript - 14 May 2026', page: 3 }] }] });

  assert.equal(merged.corrected, 1);
  const cell = store.companies.p.cells['regas-utilisation|Q4 FY26'];
  assert.equal(cell.value, 90.1);
  assert.equal(cell.origin, 'insights');
  assert.equal(cell.citation.page, 3);
  // What it replaced is kept, so a correction is auditable rather than silent.
  assert.deepEqual(cell.replaced, { value: 27, origin: 'model' });
});

test('the model never overwrites a cited Insights value', () => {
  const store = freshStore();
  mergeIntoStore({ store, companyId: 'p', quarters: ['Q4 FY26'], fingerprint: 'a', origin: 'insights', at: 'r1',
    kpiObjects: [{ id: 'x', unit: '%', values: [90.1], sourceTags: ['company-filing'] }] });
  const merged = mergeIntoStore({ store, companyId: 'p', quarters: ['Q4 FY26'], fingerprint: 'a', origin: 'model', at: 'r2',
    kpiObjects: [{ id: 'x', unit: '%', values: [27], sourceTags: ['mgmt-claim'] }] });
  assert.equal(merged.kept, 1);
  assert.equal(merged.corrected, 0);
  assert.equal(store.companies.p.cells['x|Q4 FY26'].value, 90.1);
});

test('rankOf puts Insights above the model and treats unknowns as weakest', () => {
  assert.ok(rankOf('insights') > rankOf('model'));
  assert.ok(rankOf('insights') > rankOf('seeded'));
  assert.equal(rankOf(undefined), 1);
});

/* One unit per row. The failure this prevents is specific: Engineers India's
   order book is "12145 ₹ cr" from the model and "121443 INR mn" from Screener -
   the same quantity, ten times apart. A row mixing them draws a collapse that
   never happened. */
test('a row will not mix two scales of the same quantity', async () => {
  const { sameUnit } = await import('../lib/kpi-store.mjs');
  assert.equal(sameUnit('₹ cr', 'Rs Crore'), true, 'spelling differences are the same unit');
  assert.equal(sameUnit('INR Crores', 'crore'), true);
  assert.equal(sameUnit('USD/day', '$/day'), true);
  assert.equal(sameUnit('INR mn', '₹ cr'), false, 'a scale difference is a real difference');
  assert.equal(sameUnit('million MT', "'000 MT"), false);
});

test('a cell in another unit is withheld, not rescaled', () => {
  const store = freshStore();
  // Model holds Q4 in crore; Insights fills Q1-Q3 in millions.
  mergeIntoStore({ store, companyId: 'e', quarters: QUARTERS, fingerprint: 'a', origin: 'model', at: 'r1',
    kpiObjects: [{ id: 'order-book', unit: '₹ cr', values: [null, null, null, 15109],
      sourceTags: [null, null, null, 'mgmt-claim'] }] });
  mergeIntoStore({ store, companyId: 'e', quarters: QUARTERS, fingerprint: 'a', origin: 'insights', at: 'r2',
    kpiObjects: [{ id: 'order-book', unit: 'INR mn', values: [121443, 131311, 125379, null],
      sourceTags: ['company-filing', 'company-filing', 'company-filing', null] }] });

  const spec = [{ id: 'order-book', label: 'Order book', unit: '₹ cr', flagBasis: 'level' }];
  const row = renderWindow({ store, companyId: 'e', kpis: spec, quarters: QUARTERS, flagFor, flatBandPct: 1.5 })[0];
  // Without the guard this reads [121443, 131311, 125379, 15109] - an 88% fall.
  assert.deepEqual(row.values, [121443, 131311, 125379, null]);
  assert.equal(row.unit, 'INR mn');
  assert.match(row.notes, /withheld: does not match this row's unit/);
});

test('matching units are left alone', () => {
  const store = freshStore();
  mergeIntoStore({ store, companyId: 'b', quarters: QUARTERS, fingerprint: 'a', origin: 'model', at: 'r1',
    kpiObjects: [{ id: 'grm', unit: '$/barrel', values: [null, null, null, 6.1], sourceTags: [null, null, null, 'mgmt-claim'] }] });
  mergeIntoStore({ store, companyId: 'b', quarters: QUARTERS, fingerprint: 'a', origin: 'insights', at: 'r2',
    kpiObjects: [{ id: 'grm', unit: '$/barrel', values: [5.95, 9.2, 4.88, null], sourceTags: ['company-filing', 'company-filing', 'company-filing', null] }] });
  const spec = [{ id: 'grm', label: 'GRM', unit: '$/bbl', flagBasis: 'level' }];
  const row = renderWindow({ store, companyId: 'b', kpis: spec, quarters: QUARTERS, flagFor, flatBandPct: 1.5 })[0];
  assert.deepEqual(row.values, [5.95, 9.2, 4.88, 6.1]);
});
