/**
 * The commentary (management-tone) scorer's pure parts: turning a model reply into
 * aligned tone cells, and the store that keeps them across runs.
 *
 * The honesty bar is the KPI extractor's, so the tests that matter are the same
 * ones: an unrecognised tone is dropped to null rather than coerced, a null never
 * overwrites a real tone, and a settled quarter is not re-asked. A tone with a
 * confident-looking label and a real quote behind it - but the wrong label - is
 * exactly the mistake these guard against.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMessages, normalizeResult, coverageOf, TONE_SCORE, TONE_IDS, COMMENTARY_PROMPT_VERSION
} from '../parsers/commentary-prompt.mjs';
import {
  freshStore, cellsOf, isSettled, planQuarters, mergeIntoStore, renderTimeline,
  storeTotals, fingerprintFor
} from '../lib/commentary-store.mjs';

const QUARTERS = ['Q1 FY26', 'Q2 FY26', 'Q3 FY26', 'Q4 FY26'];

/* ----------------------------------------------------------- prompt / normalise */

test('the five tone ids and scores match the diverging scale', () => {
  assert.deepEqual(TONE_IDS, ['confident', 'constructive', 'neutral', 'cautious', 'defensive']);
  assert.equal(TONE_SCORE.confident, 5);
  assert.equal(TONE_SCORE.neutral, 3);
  assert.equal(TONE_SCORE.defensive, 1);
});

test('normalizeResult aligns tones to the asked quarters, in order', () => {
  const raw = {
    quarters: [
      { quarter: 'Q2 FY26', tone: 'cautious', quote: 'demand was soft', why: 'flagged delays' },
      { quarter: 'Q1 FY26', tone: 'constructive', quote: 'volumes recovering', why: 'sees improvement' }
    ]
  };
  const out = normalizeResult(raw, QUARTERS);
  assert.equal(out.length, 4);
  assert.equal(out[0].quarter, 'Q1 FY26');
  assert.equal(out[0].toneId, 'constructive');
  assert.equal(out[0].score, 4);
  assert.equal(out[1].toneId, 'cautious');
  assert.equal(out[1].score, 2);
  // quarters not in the reply are null, not a guess
  assert.equal(out[2].toneId, null);
  assert.equal(out[3].toneId, null);
});

test('normalizeResult drops an unrecognised tone to null rather than coerce it', () => {
  const raw = { quarters: [{ quarter: 'Q1 FY26', tone: 'bullish', quote: 'x', why: null }] };
  const out = normalizeResult(raw, ['Q1 FY26']);
  assert.equal(out[0].toneId, null);
  assert.equal(out[0].score, null);
  assert.equal(out[0].quote, null);            // a quote with no valid tone is noise
  assert.match(out[0].rationale, /unrecognised tone "bullish"/);
});

test('normalizeResult keeps an explicit null tone with its reason, no quote', () => {
  const raw = { quarters: [{ quarter: 'Q1 FY26', tone: null, quote: 'ignored', why: 'call did not discuss outlook' }] };
  const out = normalizeResult(raw, ['Q1 FY26']);
  assert.equal(out[0].toneId, null);
  assert.equal(out[0].quote, null);
  assert.equal(out[0].rationale, 'call did not discuss outlook');
});

test('normalizeResult trims and caps overlong quotes and reasons', () => {
  const longQuote = 'q'.repeat(400);
  const longWhy = 'w'.repeat(400);
  const raw = { quarters: [{ quarter: 'Q1 FY26', tone: 'confident', quote: '  ' + longQuote + '  ', why: longWhy }] };
  const out = normalizeResult(raw, ['Q1 FY26']);
  assert.ok(out[0].quote.length <= 200);
  assert.ok(out[0].rationale.length <= 240);
  assert.ok(!out[0].quote.startsWith(' '));
});

test('normalizeResult is case-insensitive on the tone label', () => {
  const raw = { quarters: [{ quarter: 'Q1 FY26', tone: 'Defensive', quote: 'cutting capex', why: 'protecting cash' }] };
  const out = normalizeResult(raw, ['Q1 FY26']);
  assert.equal(out[0].toneId, 'defensive');
  assert.equal(out[0].score, 1);
});

test('buildMessages names every tone and includes each quarter block', () => {
  const { system, user } = buildMessages({
    companyName: 'IGL',
    quarterBlocks: [
      { quarter: 'Q1 FY26', text: 'management sounded upbeat about volumes' },
      { quarter: 'Q2 FY26', text: 'more measured on margins' }
    ]
  });
  for (const id of TONE_IDS) assert.ok(system.includes(id), `system prompt should name "${id}"`);
  assert.ok(user.includes('IGL'));
  assert.ok(user.includes('Q1 FY26'));
  assert.ok(user.includes('upbeat about volumes'));
  assert.ok(user.includes('measured on margins'));
});

test('coverageOf counts toned vs null quarters', () => {
  const cov = coverageOf([{ toneId: 'neutral' }, { toneId: null }, { toneId: 'cautious' }]);
  assert.deepEqual(cov, { cells: 3, real: 2, nullCells: 1 });
});

/* ----------------------------------------------------------------------- store */

const toneCell = (quarter, toneId) => ({
  quarter, toneId, score: toneId ? TONE_SCORE[toneId] : null,
  quote: toneId ? 'a quote' : null, rationale: toneId ? 'a reason' : 'no evidence'
});

test('planQuarters asks about everything when the store is empty', () => {
  const store = freshStore();
  const plan = planQuarters({ store, companyId: 'igl', quarters: QUARTERS, fingerprint: 'fp1' });
  assert.deepEqual(plan.ask, QUARTERS);
  assert.equal(plan.settled, 0);
});

test('a real tone is settled; a null is settled only while the fingerprint holds', () => {
  const store = freshStore();
  mergeIntoStore({
    store, companyId: 'igl', fingerprint: 'fp1', at: 't0',
    docByQuarter: { 'Q1 FY26': 'Concall AI summary (Q1 FY26)' },
    tones: [toneCell('Q1 FY26', 'confident'), toneCell('Q2 FY26', null)]
  });
  // same inputs: the real tone and the recorded null are both settled
  let plan = planQuarters({ store, companyId: 'igl', quarters: QUARTERS, fingerprint: 'fp1' });
  assert.deepEqual(plan.ask, ['Q3 FY26', 'Q4 FY26']);
  assert.equal(plan.settled, 2);
  // inputs changed: the null re-opens, the real tone stays settled
  plan = planQuarters({ store, companyId: 'igl', quarters: QUARTERS, fingerprint: 'fp2' });
  assert.deepEqual(plan.ask, ['Q2 FY26', 'Q3 FY26', 'Q4 FY26']);
});

test('a null NEVER overwrites a real tone', () => {
  const store = freshStore();
  mergeIntoStore({
    store, companyId: 'igl', fingerprint: 'fp1', at: 't0', model: 'gpt-4o',
    docByQuarter: { 'Q1 FY26': 'Concall AI summary (Q1 FY26)' },
    tones: [toneCell('Q1 FY26', 'constructive')]
  });
  const res = mergeIntoStore({
    store, companyId: 'igl', fingerprint: 'fp2', at: 't1',
    tones: [{ quarter: 'Q1 FY26', toneId: null, score: null, quote: null, rationale: 'missed it' }]
  });
  assert.equal(res.kept, 1);
  assert.equal(cellsOf(store, 'igl')['Q1 FY26'].toneId, 'constructive');
});

test('the first real reading of a quarter stands (no silent overwrite)', () => {
  const store = freshStore();
  mergeIntoStore({
    store, companyId: 'igl', fingerprint: 'fp1', at: 't0',
    tones: [toneCell('Q1 FY26', 'confident')]
  });
  const res = mergeIntoStore({
    store, companyId: 'igl', fingerprint: 'fp1', at: 't1',
    tones: [toneCell('Q1 FY26', 'defensive')]
  });
  assert.equal(res.gained, 0);
  assert.equal(res.kept, 1);
  assert.equal(cellsOf(store, 'igl')['Q1 FY26'].toneId, 'confident');
});

test('mergeIntoStore records a null miss with the fingerprint and bumps attempts', () => {
  const store = freshStore();
  mergeIntoStore({
    store, companyId: 'igl', fingerprint: 'fp1', at: 't0',
    tones: [{ quarter: 'Q1 FY26', toneId: null, score: null, quote: null, rationale: 'no outlook given' }]
  });
  const cell = cellsOf(store, 'igl')['Q1 FY26'];
  assert.equal(cell.toneId, null);
  assert.equal(cell.fingerprint, 'fp1');
  assert.equal(cell.attempts, 1);
  assert.equal(cell.rationale, 'no outlook given');
});

test('mergeIntoStore records the source document for provenance', () => {
  const store = freshStore();
  mergeIntoStore({
    store, companyId: 'igl', fingerprint: 'fp1', at: 't0',
    docByQuarter: { 'Q1 FY26': 'Concall AI summary (Q1 FY26)' },
    tones: [toneCell('Q1 FY26', 'neutral')]
  });
  assert.equal(cellsOf(store, 'igl')['Q1 FY26'].doc, 'Concall AI summary (Q1 FY26)');
});

test('renderTimeline aligns to the window and marks null quarters honestly', () => {
  const store = freshStore();
  mergeIntoStore({
    store, companyId: 'igl', fingerprint: 'fp1', at: 't0',
    docByQuarter: { 'Q1 FY26': 'doc-a', 'Q3 FY26': 'doc-c' },
    tones: [toneCell('Q1 FY26', 'constructive'), toneCell('Q3 FY26', 'confident'),
      { quarter: 'Q2 FY26', toneId: null, score: null, quote: null, rationale: 'no call cached' }]
  });
  const tl = renderTimeline({ store, companyId: 'igl', quarters: QUARTERS });
  assert.equal(tl.length, 4);
  assert.deepEqual(tl.map((t) => t.toneId), ['constructive', null, 'confident', null]);
  assert.equal(tl[0].score, 4);
  assert.equal(tl[1].rationale, 'no call cached');   // null keeps its reason
  assert.equal(tl[3].rationale, null);               // never seen -> nothing to say
  assert.equal(tl[2].doc, 'doc-c');
});

test('isSettled: real always, null only on fingerprint match', () => {
  assert.equal(isSettled({ toneId: 'neutral' }, 'anything'), true);
  assert.equal(isSettled({ toneId: null, fingerprint: 'fp1' }, 'fp1'), true);
  assert.equal(isSettled({ toneId: null, fingerprint: 'fp1' }, 'fp2'), false);
  assert.equal(isSettled(null, 'fp1'), false);
});

test('storeTotals sums real tones across companies', () => {
  const store = freshStore();
  mergeIntoStore({ store, companyId: 'igl', fingerprint: 'fp1', at: 't0',
    tones: [toneCell('Q1 FY26', 'confident'), toneCell('Q2 FY26', null)] });
  mergeIntoStore({ store, companyId: 'mahanagar-gas', fingerprint: 'fp1', at: 't0',
    tones: [toneCell('Q1 FY26', 'cautious')] });
  const t = storeTotals(store);
  assert.equal(t.companies, 2);
  assert.equal(t.real, 2);
  assert.equal(t.cells, 3);
});

test('fingerprint moves when the documents change, holds when they do not', () => {
  const base = { promptVersion: COMMENTARY_PROMPT_VERSION, kpiSpec: 'commentary-tone' };
  const a = fingerprintFor({ ...base, docs: ['sumQ1:3000', 'sumQ2:2500'] });
  const b = fingerprintFor({ ...base, docs: ['sumQ2:2500', 'sumQ1:3000'] });   // order-independent
  const c = fingerprintFor({ ...base, docs: ['sumQ1:3200', 'sumQ2:2500'] });   // a doc grew
  assert.equal(a, b);
  assert.notEqual(a, c);
});
