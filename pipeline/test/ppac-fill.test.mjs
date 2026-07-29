import test from 'node:test';
import assert from 'node:assert/strict';

import { quartersFromEditions, indexEditions, fillFromPpac } from '../lib/ppac-fill.mjs';

/* Editions shaped exactly as parseRefinerTotals returns them. The June numbers
   are the real ones from PPAC's July-26 Ready Reckoner; the September and
   December figures continue them plausibly so the subtraction can be tested. */
const ed = (month, year, hpclYtd, ioclYtd) => ({
  dataMonth: { month, year },
  totals: [
    { label: 'HPCL-TOTAL', companyId: 'hpcl', yearToDate: { provisional: hpclYtd } },
    { label: 'IOCL-TOTAL', companyId: 'iocl', yearToDate: { provisional: ioclYtd } },
    { label: 'CPCL-TOTAL', companyId: null,   yearToDate: { provisional: 2.8 } }
  ]
});

const KPIS = [{ id: 'throughput', label: 'Throughput', unit: 'MMT', flagBasis: 'level' }];

test('Q1 is the June year-to-date, straight', () => {
  const q = quartersFromEditions([ed(6, 2026, 6.5, 19.2)]);
  assert.equal(q.get('hpcl').get('Q1 FY27'), 6.5);
  assert.equal(q.get('iocl').get('Q1 FY27'), 19.2);
});

test('Q2 is September year-to-date minus June', () => {
  const q = quartersFromEditions([ed(6, 2026, 6.5, 19.2), ed(9, 2026, 13.1, 38.9)]);
  assert.equal(q.get('hpcl').get('Q1 FY27'), 6.5);
  assert.equal(q.get('hpcl').get('Q2 FY27'), 6.6);      // 13.1 - 6.5
  assert.equal(q.get('iocl').get('Q2 FY27'), 19.7);     // 38.9 - 19.2
});

test('a quarter whose previous reading is missing is NOT closed', () => {
  /* year-to-date at September without June would overstate Q2 by the whole of
     Q1 - large, plausible, and wearing an [Official] tag */
  const q = quartersFromEditions([ed(9, 2026, 13.1, 38.9)]);
  /* nothing closable, so the company is absent entirely rather than present
     with an empty map - there is no half-answer to give */
  assert.equal(q.has('hpcl'), false);
  assert.equal(q.size, 0);
});

test('a mid-quarter edition is discarded, not read as a quarter', () => {
  /* July covers four months and belongs to no quarterly row */
  const idx = indexEditions([ed(7, 2026, 8.7, 25.0)]);
  assert.equal(idx.size, 0);
});

test('January-to-March closes the fiscal year that began the previous April', () => {
  const q = quartersFromEditions([
    ed(12, 2026, 19.8, 58.0),     // Apr-Dec of FY27
    ed(3, 2027, 26.4, 77.5)       // Apr-Mar of FY27, published in calendar 2027
  ]);
  assert.equal(q.get('hpcl').get('Q4 FY27'), 6.6);      // 26.4 - 19.8
});

test('a company PPAC lists but the backbone does not is never claimed', () => {
  const q = quartersFromEditions([ed(6, 2026, 6.5, 19.2)]);
  assert.equal(q.has(null), false);
  assert.equal(q.size, 2);        // hpcl and iocl only - CPCL is dropped
});

test('the fill aligns to the company window and nulls the rest', () => {
  const out = fillFromPpac({
    editions: [ed(6, 2026, 6.5, 19.2), ed(9, 2026, 13.1, 38.9)],
    kpis: KPIS, companyId: 'hpcl',
    quarters: ['Q3 FY26', 'Q4 FY26', 'Q1 FY27', 'Q2 FY27']
  });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].values, [null, null, 6.5, 6.6]);
  assert.deepEqual(out[0].sourceTags, [null, null, 'official', 'official']);
  assert.equal(out[0].unit, 'MMT');
  assert.equal(out[0].flag, null);        // the store computes the flag, not this
});

test('a window PPAC cannot speak to claims nothing at all', () => {
  const out = fillFromPpac({
    editions: [ed(6, 2026, 6.5, 19.2)],
    kpis: KPIS, companyId: 'hpcl',
    quarters: ['Q1 FY25', 'Q2 FY25', 'Q3 FY25', 'Q4 FY25']
  });
  assert.deepEqual(out, []);
});

test('a KPI the spec does not carry is not invented', () => {
  const out = fillFromPpac({
    editions: [ed(6, 2026, 6.5, 19.2)],
    kpis: [{ id: 'grm', label: 'GRM' }], companyId: 'hpcl',
    quarters: ['Q1 FY27']
  });
  assert.deepEqual(out, []);
});
