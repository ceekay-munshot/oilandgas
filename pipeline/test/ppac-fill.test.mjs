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

/* ------------------------------------------------------------------------
   applyPpacToStore - the part that decides what actually gets WRITTEN.
   Tested against a fake store so the whole ingest path can be exercised
   without a network, an OCR credit or a PDF.
   ------------------------------------------------------------------------ */

import { applyPpacToStore } from '../lib/ppac-fill.mjs';
import { freshStore, cellsOf } from '../lib/kpi-store.mjs';
import { rankSnapshotUrls } from '../sources/ppac-docs.mjs';

const SPEC = { companies: { hpcl: KPIS, iocl: KPIS, bpcl: KPIS } };
const AT = '2026-07-29T00:00:00.000Z';

test('PPAC lands in the store as [Official], tagged ppac', () => {
  const store = freshStore();
  const out = applyPpacToStore({
    store, editions: [ed(6, 2026, 6.5, 19.2)], spec: SPEC, at: AT, fingerprint: 'ppac:test'
  });
  const cell = cellsOf(store, 'hpcl')['throughput|Q1 FY27'];
  assert.equal(cell.value, 6.5);
  assert.equal(cell.unit, 'MMT');
  assert.equal(cell.sourceTag, 'official');
  assert.equal(cell.origin, 'ppac');
  assert.equal(out.gained, 2);          // hpcl and iocl, one quarter each
});

test('a management claim is corrected by the ministry, not merely joined', () => {
  /* The live case this exists for: BPCL Q1 FY27 is stored as a [Mgmt Claim] of
     10.15 from a call, and PPAC publishes 10.2. Same quarter, better source. */
  const store = freshStore();
  store.companies.bpcl = { cells: { 'throughput|Q1 FY27': {
    value: 10.15, unit: 'MMT', sourceTag: 'mgmt-claim', origin: 'model'
  } } };
  const bpclEdition = {
    dataMonth: { month: 6, year: 2026 },
    totals: [{ label: 'BPCL-TOTAL', companyId: 'bpcl', yearToDate: { provisional: 10.2 } }]
  };
  const out = applyPpacToStore({ store, editions: [bpclEdition], spec: SPEC, at: AT, fingerprint: 'ppac:test' });

  const cell = cellsOf(store, 'bpcl')['throughput|Q1 FY27'];
  assert.equal(cell.value, 10.2);
  assert.equal(cell.sourceTag, 'official');
  assert.equal(cell.origin, 'ppac');
  assert.deepEqual(cell.replaced, { value: 10.15, origin: 'model' });
  assert.equal(out.corrected, 1);
});

test('quarters PPAC has not reached are never written as empty cells', () => {
  /* A null cell carries a fingerprint, and a fingerprint re-opens a settled
     question - so writing "PPAC has nothing for Q3 FY26" would send the model a
     bill for answering it again. Only quarters PPAC closed may be touched. */
  const store = freshStore();
  store.companies.hpcl = { cells: { 'throughput|Q3 FY26': {
    value: null, sourceTag: null, origin: 'model', fingerprint: 'model:abc'
  } } };
  applyPpacToStore({ store, editions: [ed(6, 2026, 6.5, 19.2)], spec: SPEC, at: AT, fingerprint: 'ppac:test' });

  const cells = cellsOf(store, 'hpcl');
  assert.equal(cells['throughput|Q3 FY26'].fingerprint, 'model:abc');   // untouched
  assert.equal(cells['throughput|Q1 FY27'].value, 6.5);
});

test('a company PPAC covers but the spec does not carry is reported, not written', () => {
  const store = freshStore();
  const out = applyPpacToStore({
    store, editions: [ed(6, 2026, 6.5, 19.2)], spec: { companies: { hpcl: KPIS } },
    at: AT, fingerprint: 'ppac:test'
  });
  assert.equal(Object.keys(store.companies).includes('iocl'), false);
  assert.equal(out.rows.find((r) => r.companyId === 'iocl').skipped, 'not in the KPI spec');
});

test('editions that close nothing write nothing', () => {
  const store = freshStore();
  const out = applyPpacToStore({
    store, editions: [ed(7, 2026, 8.7, 25.0)],      // mid-quarter
    spec: SPEC, at: AT, fingerprint: 'ppac:test'
  });
  assert.deepEqual(out.rows, []);
  assert.equal(out.gained, 0);
  assert.deepEqual(store.companies, {});
});

/* ------------------------------------------------------------------------
   Discovery: which of PPAC's PDFs is worth an OCR credit.
   ------------------------------------------------------------------------ */

const FLASH    = 'https://ppac.gov.in/download.php?file=menu/1782910010_Flash_Report_June26_Web_Upload.pdf';
const SNAPSHOT = 'https://ppac.gov.in/download.php?file=rep_studies/1784287517_Snapshot_of_India_Oil_and_Gas_June_2026_A5.pdf';
const ANNUAL   = 'https://ppac.gov.in/download.php?file=rep_studies/1784899305_The_PPAC_Ready_Reckoner_FY_2025-26_Final.pdf';

test('the Flash Report is never scraped - the probe settled that it names no company', () => {
  assert.deepEqual(rankSnapshotUrls([FLASH]), []);
});

test('the monthly Snapshot leads the annual Ready Reckoner', () => {
  /* Only the monthly one carries "Data for <Mon> <Year>", and an edition that
     cannot be dated is discarded - so the one most likely to parse goes first,
     even though the annual has the newer timestamp. */
  assert.deepEqual(rankSnapshotUrls([FLASH, ANNUAL, SNAPSHOT]), [SNAPSHOT, ANNUAL]);
});

test('within a kind, the newest timestamp wins', () => {
  const older = SNAPSHOT.replace('1784287517', '1770000000');
  assert.deepEqual(rankSnapshotUrls([older, SNAPSHOT], { limit: 1 }), [SNAPSHOT]);
});
