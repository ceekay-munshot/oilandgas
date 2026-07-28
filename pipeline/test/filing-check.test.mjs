import test from 'node:test';
import assert from 'node:assert/strict';

import {
  periodsOf, newestPeriodIso, hasNewFiling, hasUsableDocs, filingDecision
} from '../lib/filing-check.mjs';

const doc = (periodIso, status = 'ok', chars = 5000) => ({ periodIso, status, chars });

const entry = (periods) => ({
  summaries: periods.map((p) => doc(p)),
  transcripts: [],
  ppt: null
});

test('the newest stored period is read across summaries, transcripts and the PPT', () => {
  const e = {
    summaries: [doc('2026-03-31'), doc('2025-12-31')],
    transcripts: [doc('2026-06-30')],
    ppt: doc('2025-09-30')
  };
  assert.equal(periodsOf(e).length, 4);
  assert.equal(newestPeriodIso(e), '2026-06-30');
  assert.equal(newestPeriodIso(null), null);
});

test('a newer filing is detected; an unchanged page is not', () => {
  const held = entry(['2026-03-31']);
  assert.equal(hasNewFiling(held, [doc('2026-06-30')]), true);
  assert.equal(hasNewFiling(held, [doc('2026-03-31'), doc('2025-12-31')]), false);
});

test('holding nothing means gather - a company cannot be skipped into existence', () => {
  assert.equal(hasNewFiling(null, [doc('2026-03-31')]), true);
  assert.equal(hasNewFiling({ summaries: [], transcripts: [], ppt: null }, [doc('2026-03-31')]), true);
});

test('an unreadable period counts as new, because the cost of being wrong is one extra gather', () => {
  const held = entry(['2026-03-31']);
  assert.equal(hasNewFiling(held, [{ periodIso: null }]), true);
  assert.equal(hasNewFiling(held, [{}]), true);
});

test('a company whose documents all failed is never skipped', () => {
  /* gated summaries and scans left nothing to fall back on: skipping would make
     the failure permanent */
  const gated = { summaries: [doc('2026-03-31', 'gated', 0)], transcripts: [doc('2026-03-31', 'ocr_needed', 0)], ppt: null };
  assert.equal(hasUsableDocs(gated), false);
  assert.equal(filingDecision(gated, [doc('2026-03-31')], { incremental: true }).skip, false);

  const good = entry(['2026-03-31']);
  assert.equal(hasUsableDocs(good), true);
});

test('the decision is off unless incremental is asked for, and always says why', () => {
  const held = entry(['2026-03-31']);
  const off = filingDecision(held, [doc('2026-03-31')]);
  assert.equal(off.skip, false);
  assert.match(off.reason, /incremental off/);

  const on = filingDecision(held, [doc('2026-03-31')], { incremental: true });
  assert.equal(on.skip, true);
  assert.match(on.reason, /nothing newer than 2026-03-31/);

  const fresh = filingDecision(held, [doc('2026-06-30')], { incremental: true });
  assert.equal(fresh.skip, false);
  assert.match(fresh.reason, /newer filing/);
});
