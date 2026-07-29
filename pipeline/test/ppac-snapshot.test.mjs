import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRefinerTotals, parseRefinerTotal, parseDataMonth,
  quarterFromCumulative, REFINER_TOTALS
} from '../parsers/ppac-snapshot.mjs';

/* The real Firecrawl OCR of PPAC's July-26 Snapshot (data for June 2026),
   captured by `node pipeline/fetch-macro.mjs --probe ppac-flash` on 2026-07-29.
   Verbatim, because the whole point is that the parser is anchored on what the
   source actually emits rather than on what a spec says it should. */
const REAL = `SNAPSHOT OF INDIA'S OIL & GAS DATA MONTHLY READY RECKONER July-26 (Data for Jun 2026) petroleum products (Million Metric Tonnes) Particulars 2024-25 2025-26 June April-June Particulars 2024-25 2025-26 2025-26(P) 2026-27(P) 2025-26(P) 2026-27(P) 1 Indigenous crude oil processing 26.5 25.7 2.4 1.9 6.3 6.1 2 Products from indigenous crude(93.3% of crude oil processed) 24.7 24.0 2.2 1.8 5.9 5.7 3 Products from fractionators(Including LPG and Gas) 3.3 3.4 0.3 0.3 0.8 0.7 4 Total production from indigenouscrude& condensate(2+3) 28.0 27.4 2.5 2.1 6.7 6.4 5 Total domestic consumption 239.2 243.2 20.0 19.4 61.6 58.5 % Self-sufficiency(4/5) 11.7% 11.3% 12.6% 10.6% 10.9% 10.9% Sl. no. Refinery Installed capacity (01.04.2024) MMTPA Crude oil processing (MMT) Sl. no. Refinery Installed capacity (01.04.2024) MMTPA 2024-25 2025-26 June April-June Sl. no. Refinery Installed capacity (01.04.2024) MMTPA 2024-25 2025-26 2025-26 (p) 2026-27 (Target) 2026-27 (p) 2025-26 (p) 2026-27 (Target) 2026-27 (p) 1 Barauni (1964) 6.0 6.5 6.4 0.6 0.6 0.5 1.6 1.8 1.6 2 Koyali (1965) 13.7 15.3 13.2 0.9 0.9 1.4 3.0 2.6 4.3 3 Haldia (1975) 8.0 6.9 8.5 0.7 0.7 0.7 2.2 2.2 2.2 4 Mathura (1982) 8.0 8.1 10.0 0.8 0.9 0.5 2.6 2.6 2.2 5 Panipat (1998) 15.0 15.4 15.9 1.3 1.2 1.3 4.0 3.8 3.9 6 Guwahati (1962) 1.2 1.2 1.3 0.1 0.1 0.1 0.3 0.3 0.3 7 Digboi (1901) 0.65 0.8 0.7 0.1 0.1 0.1 0.1 0.2 0.2 8 Bongaigaon(1979) 2.70 2.8 3.0 0.3 0.2 0.3 0.7 0.8 0.8 9 Paradip (2016) 15.0 14.7 16.3 1.4 1.4 1.2 4.2 4.1 3.7 IOCL-TOTAL 70.3 71.6 75.5 6.2 6.1 6.1 18.7 18.4 19.2 10 Manali (1969) 10.5 10.5 11.7 1.0 0.0 0.9 3.0 0.0 2.8 11 CBR (1993) 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 CPCL-TOTAL 10.5 10.5 11.7 1.0 0.0 0.9 3.0 0.0 2.8 12 Mumbai (1955) 12.0 15.5 16.0 1.4 1.3 1.2 3.9 3.8 3.8 13 Kochi (1966) 15.5 17.2 17.6 1.5 1.5 1.5 4.5 4.5 4.3 14 Bina (2011) 7.8 7.7 7.4 0.7 0.7 0.7 2.0 2.0 2.1 BPCL-TOTAL 35.3 40.4 41.0 3.5 3.4 3.4 10.4 10.3 10.2 15 Numaligarh (1999) 3.0 3.1 3.1 0.3 0.2 0.3 0.8 0.7 0.8 Sl. no. Refinery Installed capacity (01.04.2024) MMTPA Crude oil processing(MMT) Sl. no. Refinery Installed capacity (01.04.2024) MMTPA 2023-24 2024-25 2025-26 June April-June Sl. no. Refinery Installed capacity (01.04.2024) MMTPA 2023-24 2024-25 2025-26 2025-26(P) 2026-27(Target) 2026-27(P) 2025-26(P) 2026-27(Target) 2026-27(P) 16 Tatipaka(2001) 0.07 0.07 0.07 0.07 0.007 0.0 0.006 0.02 0.0 0.01 17 MRPL-Mangalore(1996) 15.0 16.5 18.0 16.8 0.7 1.2 1.4 3.4 3.6 4.3 ONGC-TOTAL 15.1 16.6 18.1 16.8 0.7 1.2 1.4 3.4 3.6 4.3 18 Mumbai(1954) 9.5 9.6 10.0 10.0 0.8 0.8 0.9 2.5 2.5 2.5 19 Visakh(1957) 15.0 12.7 15.3 16.0 1.3 1.3 1.3 4.2 3.7 4.0 HPCL-TOTAL 24.5 22.3 25.3 26.0 2.1 2.1 2.2 6.7 6.1 6.5 20 HMEL-Bathinda(2012) 11.3 12.6 13.0 11.7 1.1 1.1 1.1 3.3 3.3 3.3 21 HRRL-Pachpadra(2026)* 9.0 - - - 0.0 - 0.1 0.0 - 0.1 22 RIL-Jamnagar(DTA)(1999) 33.0 34.4 35.0 33.6 2.9 2.8 2.2 7.3 8.6 6.8 23 RIL-Jamnagar(SEZ)(2008) 35.2`;

test('the company totals come out of the real OCR text', () => {
  const rows = parseRefinerTotals(REAL);
  const by = Object.fromEntries(rows.map((r) => [r.label, r]));
  assert.ok(by['IOCL-TOTAL'] && by['BPCL-TOTAL'] && by['HPCL-TOTAL']);
});

test('the 9-number layout is read correctly (IOCL block)', () => {
  // 1 Barauni ... IOCL-TOTAL 70.3 71.6 75.5 | 6.2 6.1 6.1 | 18.7 18.4 19.2
  const r = parseRefinerTotal(REAL, 'IOCL-TOTAL');
  assert.equal(r.capacityMmtpa, 70.3);
  assert.deepEqual(r.annual, [71.6, 75.5]);
  assert.equal(r.month.provisional, 6.1);
  assert.equal(r.yearToDate.provisional, 19.2);
  assert.equal(r.companyId, 'iocl');
});

test('the 10-number layout is read correctly (HPCL block, extra year)', () => {
  // HPCL-TOTAL 24.5 22.3 25.3 26.0 | 2.1 2.1 2.2 | 6.7 6.1 6.5
  // A parser assuming the 9-number shape reads these one column out and returns
  // a plausible wrong answer - this is the trap the two layouts create.
  const r = parseRefinerTotal(REAL, 'HPCL-TOTAL');
  assert.equal(r.capacityMmtpa, 24.5);
  assert.deepEqual(r.annual, [22.3, 25.3, 26.0]);
  assert.equal(r.month.provisional, 2.2);
  assert.equal(r.yearToDate.provisional, 6.5);
  assert.equal(r.companyId, 'hpcl');
});

test('BPCL reads on the 9-number layout', () => {
  const r = parseRefinerTotal(REAL, 'BPCL-TOTAL');
  assert.equal(r.capacityMmtpa, 35.3);
  assert.equal(r.yearToDate.provisional, 10.2);
  assert.equal(r.companyId, 'bpcl');
});

test('a refiner outside the backbone is read but not mapped to a company', () => {
  /* CPCL and ONGC-TOTAL(MRPL) are in the table and are not the backbone's
     refining KPIs. Mapping them onto a company would be a wrong-basis number
     wearing an [Official] tag. */
  assert.equal(parseRefinerTotal(REAL, 'CPCL-TOTAL').companyId, null);
  assert.equal(REFINER_TOTALS['ONGC-TOTAL'], null);
});

test('the DATA month is read, not the cover month', () => {
  /* the cover says July-26; the figures are June's. Reading the cover would
     date every value a month late while the number itself stayed right. */
  assert.deepEqual(parseDataMonth(REAL), { month: 6, year: 2026 });
  assert.equal(parseDataMonth('no date here'), null);
});

test('a layout it does not recognise is skipped, not guessed', () => {
  assert.equal(parseRefinerTotal('IOCL-TOTAL 1.0 2.0', 'IOCL-TOTAL'), null);
  assert.equal(parseRefinerTotal('nothing here', 'IOCL-TOTAL'), null);
});

test('a document with no totals throws rather than returning nothing quietly', () => {
  assert.throws(() => parseRefinerTotals('SNAPSHOT ... but no refinery table'), /layout has probably changed/i);
});

/* ------------------------------------------- year-to-date -> single quarter */

test('Q1 is the June year-to-date figure itself', () => {
  assert.equal(quarterFromCumulative(null, 19.2), 19.2);
});

test('a later quarter is the difference between consecutive year-to-dates', () => {
  // Apr-Sep 38.0 minus Apr-Jun 19.2 = Q2 of 18.8
  assert.equal(Number(quarterFromCumulative(19.2, 38.0).toFixed(1)), 18.8);
});

test('a year-to-date that FALLS is refused, not returned as negative throughput', () => {
  /* means the two readings straddle a fiscal year, so the difference describes
     nothing real */
  assert.equal(quarterFromCumulative(38.0, 6.1), null);
  assert.equal(quarterFromCumulative(19.2, null), null);
});
