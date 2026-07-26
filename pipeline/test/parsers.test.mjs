/**
 * Parser + date-helper tests. Pure functions only, so no network and no
 * fixtures beyond the literals here. Run with `npm test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseFredCsv } from '../parsers/fred.mjs';
import { parseFrankfurter } from '../parsers/frankfurter.mjs';
import { parsePpacFyTable, fyWindow, findDataRow } from '../parsers/ppac.mjs';
import { monthlyAverage, lastMonths, markPartialMonth, monthKey } from '../lib/dates.mjs';
import { stripCodeFence, availableProviders } from '../lib/llm.mjs';
import { ParseError } from '../lib/errors.mjs';

test('parseFredCsv reads observations and drops FRED\'s "." gaps', () => {
  const csv = [
    'observation_date,DCOILBRENTEU',
    '2026-07-01,80.10',
    '2026-07-02,.',          // FRED writes '.' on non-trading days
    '2026-07-03,81.40'
  ].join('\n');
  const out = parseFredCsv(csv, 'DCOILBRENTEU');
  assert.deepEqual(out, [
    { date: '2026-07-01', value: 80.1 },
    { date: '2026-07-03', value: 81.4 }
  ]);
});

test('parseFredCsv rejects the wrong series rather than mislabelling it', () => {
  const csv = 'observation_date,DCOILWTICO\n2026-07-01,70.0';
  assert.throws(() => parseFredCsv(csv, 'DCOILBRENTEU'), ParseError);
});

test('parseFredCsv throws when there is nothing usable', () => {
  assert.throws(() => parseFredCsv('observation_date,X\n', 'X'), ParseError);
});

test('parseFrankfurter pulls one symbol out and sorts oldest first', () => {
  const json = {
    base: 'USD',
    rates: { '2026-07-03': { INR: 95.2 }, '2026-07-01': { INR: 95.0 } }
  };
  assert.deepEqual(parseFrankfurter(json, 'INR'), [
    { date: '2026-07-01', value: 95.0 },
    { date: '2026-07-03', value: 95.2 }
  ]);
});

test('parseFrankfurter throws for a symbol that is not in the payload', () => {
  assert.throws(() => parseFrankfurter({ rates: { '2026-07-01': { INR: 95 } } }, 'JPY'), ParseError);
});

test('monthlyAverage means each calendar month and dates it to the first', () => {
  assert.deepEqual(
    monthlyAverage([
      { date: '2026-06-10', value: 10 },
      { date: '2026-06-20', value: 20 },
      { date: '2026-07-05', value: 30 }
    ]),
    [
      { date: '2026-06-01', value: 15 },
      { date: '2026-07-01', value: 30 }
    ]
  );
});

test('monthlyAverage skips non-finite values instead of poisoning the mean', () => {
  const out = monthlyAverage([
    { date: '2026-06-10', value: 10 },
    { date: '2026-06-11', value: Number.NaN },
    { date: '2026-06-12', value: 20 }
  ]);
  assert.deepEqual(out, [{ date: '2026-06-01', value: 15 }]);
});

test('lastMonths walks back across a year boundary', () => {
  assert.deepEqual(lastMonths(3, '2026-02-14'), ['2025-12-01', '2026-01-01', '2026-02-01']);
});

test('monthKey normalises any day to the first of its month', () => {
  assert.equal(monthKey('2026-07-24'), '2026-07-01');
});

test('markPartialMonth flags a current month that has not finished', () => {
  const pts = [{ date: '2026-06-01', value: 1 }, { date: '2026-07-01', value: 2 }];
  assert.equal(markPartialMonth(pts, '2026-07-24').at(-1).partial, true);
});

test('markPartialMonth leaves a completed month alone', () => {
  const pts = [{ date: '2026-06-01', value: 1 }, { date: '2026-07-01', value: 2 }];
  assert.equal(markPartialMonth(pts, '2026-07-31').at(-1).partial, undefined);
  assert.equal(markPartialMonth(pts, '2026-08-02').at(-1).partial, undefined);
});

test('markPartialMonth copes with an empty series', () => {
  assert.deepEqual(markPartialMonth([], '2026-07-24'), []);
});

test('parsePpacFyTable maps Indian fiscal months onto real calendar years', () => {
  const json = {
    result: {
      1: { title: '2025-26', april: 67.72, may: '', december: 62.2, january: 63.08, march: 113.49 },
      2: { title: 'Notes :' },
      3: { title: '- The Indian basket of Crude Oil represents...' }
    }
  };
  assert.deepEqual(parsePpacFyTable(json, '2025-2026'), [
    { date: '2025-04-01', value: 67.72 },   // April is the first year
    { date: '2025-12-01', value: 62.2 },
    { date: '2026-01-01', value: 63.08 },   // January rolls into the next
    { date: '2026-03-01', value: 113.49 }
  ]);
});

test('findDataRow ignores the footnote rows underneath the table', () => {
  const rows = { 1: { title: 'Notes :' }, 2: { title: '2025-26', april: 1.5 } };
  assert.equal(findDataRow(rows).title, '2025-26');
});

test('parsePpacFyTable throws when only footnotes came back', () => {
  assert.throws(() => parsePpacFyTable({ result: { 1: { title: 'Notes :' } } }, '2025-2026'), ParseError);
});

test('fyWindow straddles the April boundary the Indian fiscal year turns on', () => {
  assert.deepEqual(fyWindow('2026-07-24'), ['2025-2026', '2026-2027']); // FY26-27 in progress
  assert.deepEqual(fyWindow('2026-02-10'), ['2024-2025', '2025-2026']); // still FY25-26
});

test('stripCodeFence unwraps a fenced JSON reply', () => {
  assert.equal(stripCodeFence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripCodeFence('{"a":1}'), '{"a":1}');
});

test('availableProviders reports only providers with a key present', () => {
  assert.deepEqual(availableProviders({ OPENAI_API_KEY: 'x' }), ['openai']);
  assert.deepEqual(availableProviders({}), []);
});
