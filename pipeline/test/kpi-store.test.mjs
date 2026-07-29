/**
 * The durable store. Two properties are load-bearing:
 *
 *   coverage can only go up   - a null never displaces a number, so a run that
 *                               answers nothing leaves the table intact
 *   a settled cell costs zero - no call is made for what we already know, until
 *                               the inputs or the prompt change
 *
 * Both were broken before: every run re-asked everything and overwrote the lot.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cellKey, fingerprintFor, docsSignature, freshStore, planCompany, isSettled,
  mergeIntoStore, renderWindow, storeTotals, quartersKnown, seedFromWindow, rankOf
} from '../lib/kpi-store.mjs';
import { flagFor } from '../lib/kpi-flag.mjs';

const QUARTERS = ['Q1 FY26', 'Q2 FY26', 'Q3 FY26', 'Q4 FY26'];
const KPIS = [
  { id: 'order-book', label: 'Order book', unit: '₹ cr', flagBasis: 'level', keywords: ['order book'] },
  { id: 'day-rate', label: 'Day-rate', unit: '$/day', flagBasis: 'level', keywords: ['day rate'] }
];
const FP = 'fingerprint-a';

/** A model reply shaped the way normalizeResult returns it. */
const reply = (id, values, tag = 'company-filing') => ({
  id, label: id, unit: '₹ cr', flagBasis: 'level',
  values, sourceTags: values.map((v) => (v == null ? null : tag)),
  flag: null, notes: null
});

test('a fresh store asks about everything', () => {
  const plan = planCompany({ store: freshStore(), companyId: 'x', kpis: KPIS, quarters: QUARTERS, fingerprint: FP });
  assert.equal(plan.ask.length, 2);
  assert.equal(plan.openCells, 8);
  assert.equal(plan.settledCells, 0);
});

test('a completed KPI is never asked about again', () => {
  const store = freshStore();
  mergeIntoStore({
    store, companyId: 'x', quarters: QUARTERS, fingerprint: FP, model: 'gpt-4o', at: 'now',
    kpiObjects: [reply('order-book', [3051, 3050, 2967, 3000])]
  });
  const plan = planCompany({ store, companyId: 'x', kpis: KPIS, quarters: QUARTERS, fingerprint: FP });
  assert.deepEqual(plan.ask.map((k) => k.id), ['day-rate']);
  assert.equal(plan.settledCells, 4);
});

test('every KPI complete means no call at all - the run costs nothing', () => {
  const store = freshStore();
  mergeIntoStore({
    store, companyId: 'x', quarters: QUARTERS, fingerprint: FP, model: 'gpt-4o', at: 'now',
    kpiObjects: [reply('order-book', [1, 2, 3, 4]), reply('day-rate', [5, 6, 7, 8])]
  });
  const plan = planCompany({ store, companyId: 'x', kpis: KPIS, quarters: QUARTERS, fingerprint: FP });
  assert.equal(plan.ask.length, 0);
  assert.equal(plan.openCells, 0);
});

test('a null NEVER overwrites a real value - the table cannot go backwards', () => {
  const store = freshStore();
  mergeIntoStore({
    store, companyId: 'x', quarters: QUARTERS, fingerprint: FP, model: 'gpt-4o', at: 'run1',
    kpiObjects: [reply('order-book', [3051, 3050, 2967, 3000])]
  });
  // A later run misses everything - which is exactly what used to wipe the row.
  const merged = mergeIntoStore({
    store, companyId: 'x', quarters: QUARTERS, fingerprint: 'fingerprint-b', model: 'gpt-4o', at: 'run2',
    kpiObjects: [reply('order-book', [null, null, null, null])]
  });
  assert.equal(merged.gained, 0);
  assert.equal(merged.kept, 4);
  const rows = renderWindow({ store, companyId: 'x', kpis: KPIS, quarters: QUARTERS, flagFor, flatBandPct: 1.5 });
  assert.deepEqual(rows[0].values, [3051, 3050, 2967, 3000]);
});

test('a partially answered KPI keeps what it had and gains what it did not', () => {
  const store = freshStore();
  mergeIntoStore({
    store, companyId: 'x', quarters: QUARTERS, fingerprint: FP, model: 'gpt-4o', at: 'run1',
    kpiObjects: [reply('order-book', [null, null, 2967, 3000])]
  });
  const merged = mergeIntoStore({
    store, companyId: 'x', quarters: QUARTERS, fingerprint: 'fingerprint-b', model: 'gpt-4o', at: 'run2',
    kpiObjects: [reply('order-book', [3051, null, 9999, null])]
  });
  assert.equal(merged.gained, 1);          // Q1 was empty, now filled
  assert.equal(merged.kept, 2);            // Q3 and Q4 stand as first recorded
  const rows = renderWindow({ store, companyId: 'x', kpis: KPIS, quarters: QUARTERS, flagFor, flatBandPct: 1.5 });
  // 9999 does NOT replace 2967: the first real answer for a cell stands.
  assert.deepEqual(rows[0].values, [3051, null, 2967, 3000]);
});

test('an empty cell is re-asked once the documents or the prompt change', () => {
  const store = freshStore();
  mergeIntoStore({
    store, companyId: 'x', quarters: QUARTERS, fingerprint: FP, model: 'gpt-4o', at: 'run1',
    kpiObjects: [reply('day-rate', [null, null, null, null])]
  });
  // Same inputs: settled, nothing to buy by asking again.
  let plan = planCompany({ store, companyId: 'x', kpis: [KPIS[1]], quarters: QUARTERS, fingerprint: FP });
  assert.equal(plan.ask.length, 0);
  // New fingerprint - a new concall, or a prompt fix - re-opens it.
  plan = planCompany({ store, companyId: 'x', kpis: [KPIS[1]], quarters: QUARTERS, fingerprint: 'fingerprint-b' });
  assert.equal(plan.ask.length, 1);
});

test('attempts accumulate on a cell that keeps coming back empty', () => {
  const store = freshStore();
  for (const fp of ['a', 'b', 'c']) {
    mergeIntoStore({
      store, companyId: 'x', quarters: ['Q4 FY26'], fingerprint: fp, model: 'gpt-4o', at: 'now',
      kpiObjects: [reply('day-rate', [null])]
    });
  }
  assert.equal(store.companies.x.cells[cellKey('day-rate', 'Q4 FY26')].attempts, 3);
});

test('the store keeps quarters outside the current window', () => {
  const store = freshStore();
  mergeIntoStore({
    store, companyId: 'x', quarters: ['Q3 FY25', 'Q4 FY25'], fingerprint: FP, model: 'gpt-4o', at: 'now',
    kpiObjects: [reply('order-book', [900, 950])]
  });
  mergeIntoStore({
    store, companyId: 'x', quarters: QUARTERS, fingerprint: FP, model: 'gpt-4o', at: 'now',
    kpiObjects: [reply('order-book', [3051, 3050, 2967, 3000])]
  });
  // Six quarters held; the window shows four. Sliding forward loses nothing.
  assert.equal(quartersKnown(store, 'x').length, 6);
  const rows = renderWindow({ store, companyId: 'x', kpis: KPIS, quarters: QUARTERS, flagFor, flatBandPct: 1.5 });
  assert.deepEqual(rows[0].values, [3051, 3050, 2967, 3000]);
  // And the older window is still renderable from the same store.
  const older = renderWindow({ store, companyId: 'x', kpis: KPIS, quarters: ['Q3 FY25', 'Q4 FY25'], flagFor, flatBandPct: 1.5 });
  assert.deepEqual(older[0].values, [900, 950]);
});

test('renderWindow computes the flag and drops a tag on an empty cell', () => {
  const store = freshStore();
  mergeIntoStore({
    store, companyId: 'x', quarters: QUARTERS, fingerprint: FP, model: 'gpt-4o', at: 'now',
    // Growing increments (+50, +100, +150), not linear - linear growth is steady.
    kpiObjects: [reply('order-book', [100, 150, 250, 400])]
  });
  const rows = renderWindow({ store, companyId: 'x', kpis: KPIS, quarters: QUARTERS, flagFor, flatBandPct: 1.5 });
  assert.equal(rows[0].flag, 'accelerating');
  assert.deepEqual(rows[0].sourceTags, ['company-filing', 'company-filing', 'company-filing', 'company-filing']);
  // The untouched KPI renders as four honest nulls with no tags.
  assert.deepEqual(rows[1].values, [null, null, null, null]);
  assert.deepEqual(rows[1].sourceTags, [null, null, null, null]);
});

test('a fingerprint moves with the documents, the spec and the prompt version', () => {
  const base = { promptVersion: 3, docs: ['a:100', 'b:200'], kpiSpec: KPIS };
  const same = fingerprintFor(base);
  assert.equal(fingerprintFor({ ...base, docs: ['b:200', 'a:100'] }), same, 'document order is not a change');
  assert.notEqual(fingerprintFor({ ...base, promptVersion: 4 }), same);
  assert.notEqual(fingerprintFor({ ...base, docs: ['a:100', 'b:201'] }), same);
  assert.notEqual(fingerprintFor({ ...base, kpiSpec: [KPIS[0]] }), same);
});

test('docsSignature names each block by label and length', () => {
  assert.deepEqual(
    docsSignature([{ label: 'Q4 FY26 summary', text: 'xy' }, { label: 'PPT', text: 'abc' }]),
    ['Q4 FY26 summary:2', 'PPT:3']
  );
});

test('isSettled: a value is final, an empty cell only holds for its fingerprint', () => {
  assert.equal(isSettled({ value: 5, fingerprint: 'a' }, 'b'), true);
  assert.equal(isSettled({ value: null, fingerprint: 'a' }, 'a'), true);
  assert.equal(isSettled({ value: null, fingerprint: 'a' }, 'b'), false);
  assert.equal(isSettled(undefined, 'a'), false);
});

test('seeding adopts real values from a previous kpis.json, but not its nulls', () => {
  const store = freshStore();
  const adopted = seedFromWindow({
    store, companyId: 'x', quarters: QUARTERS, at: 'now',
    kpiObjects: [
      { id: 'order-book', unit: '₹ cr', values: [3051, 3050, 2967, 3000],
        sourceTags: ['mgmt-claim', 'mgmt-claim', 'mgmt-claim', 'mgmt-claim'] },
      { id: 'day-rate', unit: '$/day', values: [null, null, null, null], sourceTags: [null, null, null, null] }
    ]
  });
  assert.equal(adopted, 4);
  // The 4 paid-for cells are held; the never-answered ones stay open, because
  // "not found" was never established against a known set of inputs.
  const plan = planCompany({ store, companyId: 'x', kpis: KPIS, quarters: QUARTERS, fingerprint: FP });
  assert.deepEqual(plan.ask.map((k) => k.id), ['day-rate']);
  assert.equal(plan.settledCells, 4);
  assert.equal(store.companies.x.cells[cellKey('order-book', 'Q1 FY26')].sourceTag, 'mgmt-claim');
});

test('seeding never displaces a value the store already holds', () => {
  const store = freshStore();
  mergeIntoStore({
    store, companyId: 'x', quarters: QUARTERS, fingerprint: FP, model: 'gpt-4o', at: 'run1',
    kpiObjects: [reply('order-book', [1, 2, 3, 4])]
  });
  const adopted = seedFromWindow({
    store, companyId: 'x', quarters: QUARTERS, at: 'now',
    kpiObjects: [{ id: 'order-book', unit: '₹ cr', values: [9, 9, 9, 9], sourceTags: ['unknown', 'unknown', 'unknown', 'unknown'] }]
  });
  assert.equal(adopted, 0);
  const rows = renderWindow({ store, companyId: 'x', kpis: KPIS, quarters: QUARTERS, flagFor, flatBandPct: 1.5 });
  assert.deepEqual(rows[0].values, [1, 2, 3, 4]);
});

test('storeTotals counts what we hold across every company and quarter', () => {
  const store = freshStore();
  mergeIntoStore({
    store, companyId: 'x', quarters: QUARTERS, fingerprint: FP, model: 'gpt-4o', at: 'now',
    kpiObjects: [reply('order-book', [1, 2, null, null])]
  });
  mergeIntoStore({
    store, companyId: 'y', quarters: ['Q4 FY26'], fingerprint: FP, model: 'gpt-4o', at: 'now',
    kpiObjects: [reply('order-book', [7])]
  });
  assert.deepEqual(storeTotals(store), { companies: 2, cells: 5, real: 3, empty: 2 });
});

test('a PPAC figure outranks Screener\'s grid, and never the reverse', () => {
  /* The brief files regulator data under [Official] and an aggregator under
     [External], so the ministry's number corrects a transcribed one in place. */
  assert.ok(rankOf('ppac') > rankOf('insights'));
  assert.ok(rankOf('insights') > rankOf('derived'));
  assert.ok(rankOf('derived') > rankOf('model'));
});

/* ------------------------------------------------------- pruning thin extras

   The client's rule: an extra row needs a trend and a value in the two most
   recent quarters, or it does not earn a line on the grid.                    */

import { pruneThinExtras } from '../lib/kpi-store.mjs';

const row = (id, values, extra) => ({
  id, label: id, values, flag: values.filter((v) => v != null).length >= 3 ? 'steady' : null,
  ...(extra ? { beyondBrief: true } : {})
});

test('an extra with one quarter and no trend is dropped', () => {
  const out = pruneThinExtras([
    row('brief', [1, 2, 3, 4]),
    row('thin', [null, null, null, 8000], true)
  ]);
  assert.deepEqual(out.kpis.map((k) => k.id), ['brief']);
  assert.match(out.dropped[0].reason, /1 quarter, no trend/);
});

test('an extra missing the newest reported quarter is dropped', () => {
  /* the company HAS reported column 3 - its brief row is filled there - so the
     extra is genuinely behind, not merely waiting on a late filer */
  const out = pruneThinExtras([
    row('brief', [1, 2, 3, 4]),
    row('behind', [10, 11, 12, null], true)
  ]);
  assert.deepEqual(out.kpis.map((k) => k.id), ['brief']);
  assert.match(out.dropped[0].reason, /two most recent/);
});

test('a late filer keeps its extras: the frontier is the COMPANY\'s, not the calendar\'s', () => {
  /* Welspun's window runs to Q1 FY27 and Welspun has filed nothing for it, so
     every row is empty in that column. Measuring against the calendar would
     delete four healthy three-point series for reporting late. */
  const out = pruneThinExtras([
    row('brief', [1, 2, 3, null]),
    row('pipe', [252, 265, 255, null], true)
  ]);
  assert.deepEqual(out.kpis.map((k) => k.id), ['brief', 'pipe']);
  assert.equal(out.dropped.length, 0);
});

test('the brief\'s own KPIs are never pruned, however thin', () => {
  /* A gap in the client's own list is the question they asked. Hiding the row
     would answer it by pretending it was never asked. */
  const out = pruneThinExtras([row('brief', [null, null, null, null])]);
  assert.deepEqual(out.kpis.map((k) => k.id), ['brief']);
  assert.equal(out.dropped.length, 0);
});

test('a full extra with a live trend is kept', () => {
  const out = pruneThinExtras([
    row('brief', [1, 2, 3, 4]),
    row('good', [107.1, 106.7, 99.5, 113.9], true)
  ]);
  assert.deepEqual(out.kpis.map((k) => k.id), ['brief', 'good']);
});

test('a company with nothing reported at all drops its extras rather than throwing', () => {
  const out = pruneThinExtras([row('x', [null, null, null, null], true)]);
  assert.deepEqual(out.kpis, []);
  assert.equal(out.dropped.length, 1);
});
