/**
 * Deriving the "computable but not stated" KPIs from figures already held.
 *
 * The fixtures are IGL's and Mahanagar's real shapes, because they are the two
 * cases that define the feature:
 *
 *   IGL       EBITDA/scm is stated for some quarters and blank for others. The
 *             arithmetic (Operating Profit ÷ volume×days) reproduces the stated
 *             ones to within half a percent, so it is trusted to fill the blank.
 *
 *   Mahanagar CNG+PNG growth from TOTAL sales volume does NOT match the growth the
 *             company reports (total volume carries industrial & commercial gas
 *             the reported figure excludes). The check catches it and fills
 *             nothing - a wrong-basis number is worse than the gap.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fillDerived, deriveTotals, daysInQuarter, prevYearQuarter } from '../lib/derive.mjs';
import { quarterLabel } from '../lib/fiscal.mjs';
import { freshStore, mergeIntoStore, renderWindow, sameUnit } from '../lib/kpi-store.mjs';
import { flagFor } from '../lib/kpi-flag.mjs';

const QUARTERS = ['Q1 FY26', 'Q2 FY26', 'Q3 FY26', 'Q4 FY26'];

// Jun 2025 = Q1 FY26 ... Dec 2025 = Q3 FY26. Mar 2026 (Q4) is deliberately absent
// from Insights, so it stays a gap - there is no volume to divide into.
const IGL_FIN = {
  tables: {
    quarters: {
      periodsIso: ['2025-03', '2025-06', '2025-09', '2025-12'],
      rows: { 'Operating Profit': [493, 511, 441, 471] }
    }
  }
};
const IGL_INS = {
  view: 'quarterly',
  periodsIso: ['2025-03', '2025-06', '2025-09', '2025-12'],
  rows: [{ label: 'Total Sales Volume', unit: 'MMSCMD', values: [9.18, 9.13, 9.31, 9.43] }]
};
const EBITDA_SPEC = { id: 'ebitda-per-scm', label: 'EBITDA / scm', unit: '₹/scm', flagBasis: 'level' };

/** A store where the model has already read EBITDA/scm for Q1 and Q3 only. */
function iglStoreWithHeld(vals = [6.16, null, 5.4, null]) {
  const store = freshStore();
  mergeIntoStore({
    store, companyId: 'igl', quarters: QUARTERS, fingerprint: 'a', origin: 'model', model: 'gpt-4o', at: 'r1',
    kpiObjects: [{ id: 'ebitda-per-scm', unit: '₹/scm', values: vals, sourceTags: vals.map((v) => (v == null ? null : 'mgmt-claim')) }]
  });
  return store;
}

test('EBITDA/scm: the gap is filled from Operating Profit ÷ volume×days, and only the gap', () => {
  const store = iglStoreWithHeld();
  const out = fillDerived({ store, companyId: 'igl', kpis: [EBITDA_SPEC], quarters: QUARTERS, fin: IGL_FIN, insights: IGL_INS, quarterLabel });
  const row = out.find((k) => k.id === 'ebitda-per-scm');
  // Q2: 441cr × 10 / (9.31 × 92 days) = 5.149 -> 5.15. Q1/Q3 held (not emitted); Q4 has no volume.
  assert.deepEqual(row.values, [null, 5.15, null, null]);
  assert.deepEqual(row.sourceTags, [null, 'derived', null, null]);
  assert.equal(row.unit, '₹/scm');
  assert.match(row.notes, /Operating Profit/);
});

test('EBITDA/scm: merged and rendered, the row is a complete series that shows its working', () => {
  const store = iglStoreWithHeld();
  const out = fillDerived({ store, companyId: 'igl', kpis: [EBITDA_SPEC], quarters: QUARTERS, fin: IGL_FIN, insights: IGL_INS, quarterLabel });
  mergeIntoStore({ store, companyId: 'igl', kpiObjects: out, quarters: QUARTERS, fingerprint: 'a', origin: 'derived', at: 'r2' });

  const row = renderWindow({ store, companyId: 'igl', kpis: [EBITDA_SPEC], quarters: QUARTERS, flagFor, flatBandPct: 1.5 })[0];
  assert.deepEqual(row.values, [6.16, 5.15, 5.4, null]);
  // The derived cell reads as derived, the model cells as model.
  assert.deepEqual(row.origins, ['model', 'derived', 'model', null]);
  assert.deepEqual(row.sourceTags, ['mgmt-claim', 'derived', 'mgmt-claim', null]);
  // The formula rides along on the row so the number is checkable.
  assert.match(row.notes, /Total Sales Volume/);
});

test('a derived value never displaces a value already held - it fills blanks only', () => {
  // Even though the arithmetic would give ~6.15 for Q1, the model's 6.16 stands.
  const store = iglStoreWithHeld();
  const out = fillDerived({ store, companyId: 'igl', kpis: [EBITDA_SPEC], quarters: QUARTERS, fin: IGL_FIN, insights: IGL_INS, quarterLabel });
  mergeIntoStore({ store, companyId: 'igl', kpiObjects: out, quarters: QUARTERS, fingerprint: 'a', origin: 'derived', at: 'r2' });
  const cell = store.companies.igl.cells['ebitda-per-scm|Q1 FY26'];
  assert.equal(cell.value, 6.16);
  assert.equal(cell.origin, 'model');
});

test('reproduce-or-refuse: a formula that disagrees with held values fills nothing', () => {
  // Held EBITDA/scm claims 9.0 and 9.5 where the arithmetic gives ~6.1/5.4 - a
  // 50% gap. The formula is not this KPI's, so no blank is filled from it.
  const store = iglStoreWithHeld([9.0, null, 9.5, null]);
  const out = fillDerived({ store, companyId: 'igl', kpis: [EBITDA_SPEC], quarters: QUARTERS, fin: IGL_FIN, insights: IGL_INS, quarterLabel });
  assert.deepEqual(out, []);
});

test('a formula with nothing to check against does not fill on its own', () => {
  // Inputs are present, but the store holds no EBITDA/scm to corroborate against.
  const store = freshStore();
  const out = fillDerived({ store, companyId: 'igl', kpis: [EBITDA_SPEC], quarters: QUARTERS, fin: IGL_FIN, insights: IGL_INS, quarterLabel });
  assert.deepEqual(out, []);
});

test('every window cell already held means nothing to derive', () => {
  const store = iglStoreWithHeld([6.16, 5.2, 5.4, 4.85]);
  const out = fillDerived({ store, companyId: 'igl', kpis: [EBITDA_SPEC], quarters: QUARTERS, fin: IGL_FIN, insights: IGL_INS, quarterLabel });
  assert.deepEqual(out, []);
});

test('inputs-or-nothing: a missing input is a gap, never a zero or a guess', () => {
  // Volume for Q2 is absent from the table, so Q2 must stay null even as Q3 - which
  // has its volume - is derived. Only Q1 is held, leaving Q2 and Q3 as the blanks.
  const ins = { view: 'quarterly', periodsIso: ['2025-03', '2025-06', '2025-12'], rows: [{ label: 'Total Sales Volume', unit: 'MMSCMD', values: [9.18, 9.13, 9.43] }] };
  const store = iglStoreWithHeld([6.16, null, null, null]);
  const out = fillDerived({ store, companyId: 'igl', kpis: [EBITDA_SPEC], quarters: QUARTERS, fin: IGL_FIN, insights: ins, quarterLabel });
  const row = out.find((k) => k.id === 'ebitda-per-scm');
  assert.equal(row.values[1], null);   // Q2 has no volume -> stays a gap
  assert.equal(row.values[2], 5.43);   // Q3 has its volume -> derived
});

const MGL_INS = {
  view: 'quarterly',
  periodsIso: ['2024-06', '2024-09', '2025-06', '2025-09'],
  rows: [{ label: 'Total Sales Volume', unit: 'MMSCMD', values: [4.23, 4.04, 4.45, 4.59] }]
};
const GROWTH_SPEC = { id: 'cng-png-volume-growth', label: 'CNG+PNG volume growth', unit: '% yoy', flagBasis: 'yoy' };

test('CNG+PNG growth: total-volume yoy that misses the reported figure is refused', () => {
  // Held (reported) growth is 9.61/9.22; total-volume yoy is 5.2/13.6. Wrong basis,
  // so the gate refuses and no cell is written from it.
  const store = freshStore();
  mergeIntoStore({
    store, companyId: 'mgl', quarters: QUARTERS, fingerprint: 'a', origin: 'model', model: 'gpt-4o', at: 'r1',
    kpiObjects: [{ id: 'cng-png-volume-growth', unit: '% yoy', values: [9.61, 9.22, null, null], sourceTags: ['mgmt-claim', 'mgmt-claim', null, null] }]
  });
  const out = fillDerived({ store, companyId: 'mgl', kpis: [GROWTH_SPEC], quarters: QUARTERS, fin: {}, insights: MGL_INS, quarterLabel });
  assert.deepEqual(out, []);
});

test('CNG+PNG growth: where total-volume yoy DOES match, a blank is filled', () => {
  // A company whose reported growth tracks its total-volume yoy. Held Q1 = 5.2
  // (matches the arithmetic); Q2 is blank and gets 13.61.
  const store = freshStore();
  mergeIntoStore({
    store, companyId: 'c', quarters: QUARTERS, fingerprint: 'a', origin: 'model', model: 'gpt-4o', at: 'r1',
    kpiObjects: [{ id: 'cng-png-volume-growth', unit: '% yoy', values: [5.2, null, null, null], sourceTags: ['mgmt-claim', null, null, null] }]
  });
  const out = fillDerived({ store, companyId: 'c', kpis: [GROWTH_SPEC], quarters: QUARTERS, fin: {}, insights: MGL_INS, quarterLabel });
  const row = out.find((k) => k.id === 'cng-png-volume-growth');
  assert.equal(row.values[1], 13.6);   // (4.59/4.04 - 1) × 100 = 13.61 -> 13.6
  assert.equal(row.sourceTags[1], 'derived');
});

test('a KPI with no declared derivation (O2C EBITDA/tonne) is left as a gap', () => {
  const store = freshStore();
  const spec = [{ id: 'o2c-ebitda-per-tonne', label: 'O2C EBITDA per tonne', unit: '$/t', flagBasis: 'level' }];
  // Even handed consolidated Operating Profit, there is no formula for it - the
  // segment EBITDA is not held, so it must not be invented from the group figure.
  const fin = { tables: { quarters: { periodsIso: ['2025-06'], rows: { 'Operating Profit': [42905] } } } };
  assert.deepEqual(fillDerived({ store, companyId: 'reliance', kpis: spec, quarters: QUARTERS, fin, insights: {}, quarterLabel }), []);
});

test('deriveTotals counts the cells actually produced', () => {
  const store = iglStoreWithHeld();
  const out = fillDerived({ store, companyId: 'igl', kpis: [EBITDA_SPEC], quarters: QUARTERS, fin: IGL_FIN, insights: IGL_INS, quarterLabel });
  assert.deepEqual(deriveTotals(out), { kpis: 1, cells: 1 });
});

test('daysInQuarter knows the quarter lengths, and the leap year', () => {
  assert.equal(daysInQuarter('Q1 FY26'), 91);   // Apr-Jun
  assert.equal(daysInQuarter('Q2 FY26'), 92);   // Jul-Sep
  assert.equal(daysInQuarter('Q3 FY26'), 92);   // Oct-Dec
  assert.equal(daysInQuarter('Q4 FY26'), 90);   // Jan-Mar 2026, not a leap year
  assert.equal(daysInQuarter('Q4 FY28'), 91);   // Jan-Mar 2028, leap
  assert.equal(daysInQuarter('nonsense'), null);
});

test('prevYearQuarter steps back one fiscal year, same quarter', () => {
  assert.equal(prevYearQuarter('Q2 FY26'), 'Q2 FY25');
  assert.equal(prevYearQuarter('Q1 FY26'), 'Q1 FY25');
  assert.equal(prevYearQuarter('Q4 FY10'), 'Q4 FY09');
});

test('₹/scm and INR/scm are one unit, so a derived row does not split from a model one', () => {
  // The renderWindow anchor picks the derived cell (higher rank); the model cell
  // in "INR/scm" must not then be withheld as a different unit.
  assert.equal(sameUnit('₹/scm', 'INR/scm'), true);
  assert.equal(sameUnit('₹/scm', 'Rs/scm'), true);
});
