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

/* ---------------------------------------------------------------- crack ---- */

import { crackSpread321 } from '../parsers/crack.mjs';
import { parseTradingEconomicsQuote } from '../parsers/tradingeconomics.mjs';
import { extractLabelledNumber, toText } from '../parsers/quote.mjs';

test('crackSpread321 applies the 3-2-1 formula in $/bbl', () => {
  const out = crackSpread321({
    gasoline:   [{ date: '2026-06-01', value: 3 }],      // $/gal
    distillate: [{ date: '2026-06-01', value: 3 }],      // $/gal
    crude:      [{ date: '2026-06-01', value: 80 }]      // $/bbl
  });
  // (2*3 + 3)/3 = 3 $/gal -> 126 $/bbl -> 126 - 80 = 46
  assert.deepEqual(out, [{ date: '2026-06-01', value: 46 }]);
});

test('crackSpread321 skips a month missing from any leg rather than part-computing', () => {
  const out = crackSpread321({
    gasoline:   [{ date: '2026-05-01', value: 3 }, { date: '2026-06-01', value: 3 }],
    distillate: [{ date: '2026-06-01', value: 3 }],                 // May absent
    crude:      [{ date: '2026-05-01', value: 80 }, { date: '2026-06-01', value: 80 }]
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].date, '2026-06-01');
});

test('crackSpread321 marks the month partial only when every leg is', () => {
  const one = (partial) => [{ date: '2026-06-01', value: 3, ...(partial ? { partial: true } : {}) }];
  assert.equal(crackSpread321({
    gasoline: one(true), distillate: one(true),
    crude: [{ date: '2026-06-01', value: 80, partial: true }]
  })[0].partial, true);
  assert.equal(crackSpread321({
    gasoline: one(true), distillate: one(false),
    crude: [{ date: '2026-06-01', value: 80, partial: true }]
  })[0].partial, undefined);
});

test('crackSpread321 throws on an empty leg', () => {
  assert.throws(() => crackSpread321({ gasoline: [], distillate: [{ date: 'x', value: 1 }], crude: [] }), ParseError);
});

/* ------------------------------------------------- trading economics ------- */

/* Trimmed from the real page fetched 2026-07-26. */
const TE_FIXTURE = `
<div><p>LNG JKM rose to 22 USD/MMBTU on July 24, 2026, up 0.80% from the previous day.</p>
<table><tr><td>Actual</td><td>Previous</td><td>Highest</td><td>Lowest</td><td>Dates</td><td>Unit</td><td>Frequency</td></tr>
<tr><td>22.00</td><td>21.83</td><td>69.96</td><td>2.00</td><td>2012 - 2026</td><td>USD/MMBTU</td><td>daily</td></tr></table></div>`;

test('parseTradingEconomicsQuote prefers the stats table and dates from the lede', () => {
  assert.deepEqual(
    parseTradingEconomicsQuote(TE_FIXTURE, { plausible: [1, 80], expectUnit: 'mmbtu' }),
    { value: 22, previous: 21.83, unit: 'USD/MMBTU', date: '2026-07-24' }
  );
});

test('parseTradingEconomicsQuote falls back to the lede when the table is gone', () => {
  const q = parseTradingEconomicsQuote('<p>LNG JKM fell to 18.4 USD/MMBTU on June 3, 2026.</p>', {});
  assert.equal(q.value, 18.4);
  assert.equal(q.date, '2026-06-03');
});

test('parseTradingEconomicsQuote rejects a value outside the plausible range', () => {
  // the page reformats and the parser lands on a year: must fail, not publish 2026
  assert.throws(
    () => parseTradingEconomicsQuote('<p>LNG JKM rose to 2026 USD/MMBTU on July 24, 2026.</p>', { plausible: [1, 80] }),
    ParseError
  );
});

test('parseTradingEconomicsQuote rejects the wrong unit', () => {
  assert.throws(() => parseTradingEconomicsQuote(TE_FIXTURE, { expectUnit: '$/bbl' }), ParseError);
});

test('parseTradingEconomicsQuote throws when no anchor is present', () => {
  assert.throws(() => parseTradingEconomicsQuote('<p>Nothing quoted here.</p>', {}), ParseError);
});

/* -------------------------------------------------------------- quote ------ */

test('toText strips markup and collapses whitespace', () => {
  assert.equal(toText('<div>a <script>x=1</script> <b>b</b>&nbsp;c</div>'), 'a b c');
});

test('extractLabelledNumber refuses a value outside the plausible range', () => {
  assert.throws(
    () => extractLabelledNumber('<p>BDTI page updated 2026</p>', { labels: [/BDTI/], plausible: [100, 1000] }),
    ParseError
  );
});

test('a plausible range cannot catch a wrong number that falls inside it', () => {
  // "2026" is a year, but BDTI legitimately trades in the hundreds-to-thousands,
  // so the range lets it through. This is a real limit of label-anchored
  // extraction, and the reason BDTI is no longer read this way: it now goes
  // through parseInvestingQuote, which anchors on a whole sentence. The generic
  // scanner stays for probes, where a loose second opinion is useful.
  assert.equal(
    extractLabelledNumber('<p>BDTI page updated 2026</p>', { labels: [/BDTI/], plausible: [100, 5000] }),
    2026
  );
});

test('extractLabelledNumber reads the nearest number after the label', () => {
  assert.equal(
    extractLabelledNumber('<p>Baltic Dirty Tanker Index 1,234 points</p>', {
      labels: [/Baltic Dirty Tanker Index/], plausible: [100, 5000]
    }),
    1234
  );
});

test('extractLabelledNumber reads a 4-digit number whole, not its first three digits', () => {
  // regression: the comma-grouped alternative used `*`, so "2026" matched as 202
  assert.equal(extractLabelledNumber('<p>BDTI 2026</p>', { labels: [/BDTI/] }), 2026);
  assert.equal(extractLabelledNumber('<p>BDTI 1,234</p>', { labels: [/BDTI/] }), 1234);
  assert.equal(extractLabelledNumber('<p>BDTI 12.75</p>', { labels: [/BDTI/] }), 12.75);
});

/* ------------------------------------------------- ppac notification (APM) -- */

import { parsePpacGasNotification } from '../parsers/ppac-notification.mjs';
import { parseInvestingQuote } from '../parsers/investing.mjs';

/* Verbatim OCR of the July 2026 notification, as Firecrawl returned it in the
   probe run on 2026-07-26. Not a hand-written fixture - this is the text the
   parser has to survive. */
const APM_JULY_2026 =
  'No. PPAC/Gas Pricing/June 2026 Petroleum Planning & Analysis Cell ' +
  '(Ministry of Petroleum & Natural Gas, Govt. of India) Dated: 30.06.2026 NOTIFICATION ' +
  'Sub: Domestic Natural Gas Price for the period 1st July 2026 to 31st July 2026. ' +
  'In accordance with MoPNG’s Notification No. L-12015/1/2022-GP-II dated 7th April 2023, ' +
  'the price of Domestic Natural Gas for the period 1st July 2026 to 31st July 2026 is ' +
  'notified as US$ 8.73/MMBTU on Gross Calorific Value (GCV) basis. Further, in accordance ' +
  'with Para 4 of the said notification, for the gas produced by ONGC/OIL from their ' +
  'nomination fields, the above-mentioned APM price shall be subject to a ceiling of ' +
  'US$ 7.00/MMBTU on GCV basis for the same period. (P. Manoj Kumar) Director General';

test('parsePpacGasNotification reads both prices out of the real July 2026 notification', () => {
  const d = parsePpacGasNotification(APM_JULY_2026);
  assert.equal(d.notified, 8.73);
  assert.equal(d.ceiling, 7);
  assert.equal(d.periodStart, '2026-07-01');
  assert.equal(d.periodLabel, '1 July 2026 to 31 July 2026');
  assert.equal(d.publishedOn, '2026-06-30');
});

test('the reported value is the ONGC/OIL ceiling, not the notified price', () => {
  // The two differ by 25%. Reading the wrong one gives a number that looks
  // entirely reasonable, which is exactly why this is pinned by a test.
  assert.equal(parsePpacGasNotification(APM_JULY_2026).value, 7);
});

test('parsePpacGasNotification falls back to the notified price when no ceiling is set', () => {
  const noCeiling = APM_JULY_2026.replace(
    /Further,[\s\S]*?same period\./,
    ''
  );
  const d = parsePpacGasNotification(noCeiling);
  assert.equal(d.ceiling, null);
  assert.equal(d.value, 8.73);
});

test('parsePpacGasNotification refuses a document with no price at all', () => {
  assert.throws(
    () => parsePpacGasNotification('NOTIFICATION Sub: Domestic Natural Gas Price. Download the PDF.'),
    ParseError
  );
});

test('parsePpacGasNotification rejects an OCR misread outside any plausible price', () => {
  // A dropped decimal point turns 7.00 into 700 - in range for nothing.
  assert.throws(
    () => parsePpacGasNotification(APM_JULY_2026.replace('US$ 7.00/MMBTU', 'US$ 700/MMBTU')),
    ParseError
  );
});

test('parsePpacGasNotification handles OCR that loses the space after US$', () => {
  const tight = APM_JULY_2026.replace('US$ 7.00/MMBTU', 'US$7.00 / MMBTU');
  assert.equal(parsePpacGasNotification(tight).ceiling, 7);
});

/* ------------------------------------------------------- investing.com ----- */

/* Verbatim from the same probe run - investing.com answers a plain GET with 403,
   so this is what came back through Firecrawl. */
const BDTI_PAGE =
  'Advertisement Baltic Dirty Tanker (BAID) Find here information about the Baltic Dirty ' +
  'Tanker index (BAID). Assess the Baltic Dirty Tanker stock price and overall performance. ' +
  'How Is The Baltic Dirty Tanker Doing Today? The Baltic Dirty Tanker live stock price is ' +
  '1,107.00. What Is the Baltic Dirty Tanker Ticker Symbol? BAID is the ticker symbol of the ' +
  'Baltic Dirty Tanker index. Is Baltic Dirty Tanker a Good Stock Market Index to Invest In?';

const BDTI_OPTS = { name: 'Baltic Dirty Tanker', ticker: 'BAID', plausible: [100, 5000], source: 'BDTI' };

test('parseInvestingQuote reads the real BDTI level, comma group and all', () => {
  const q = parseInvestingQuote(BDTI_PAGE, BDTI_OPTS);
  assert.equal(q.value, 1107);
  assert.equal(q.ticker, 'BAID');
});

test('parseInvestingQuote refuses a page served for a different instrument', () => {
  // Same template, different index - the number would parse perfectly and be wrong.
  const wrong = BDTI_PAGE.replace('BAID is the ticker symbol', 'BDRY is the ticker symbol');
  assert.throws(() => parseInvestingQuote(wrong, BDTI_OPTS), ParseError);
});

test('parseInvestingQuote throws when the quote sentence is gone', () => {
  const gutted = BDTI_PAGE.replace('live stock price is 1,107.00', 'is currently unavailable');
  assert.throws(() => parseInvestingQuote(gutted, BDTI_OPTS), ParseError);
});

test('parseInvestingQuote rejects a level outside the plausible range', () => {
  const silly = BDTI_PAGE.replace('1,107.00', '4.00');
  assert.throws(() => parseInvestingQuote(silly, BDTI_OPTS), ParseError);
});

test('parseInvestingQuote will not take a number belonging to another sentence', () => {
  // The name has to sit directly in front of "live stock price is". A nearby
  // number - an ad, a related index - must not be picked up instead.
  const noisy = 'Baltic Dirty Tanker 999 Advertisement. Brent Crude live stock price is 82.10.';
  assert.throws(() => parseInvestingQuote(noisy, BDTI_OPTS), ParseError);
});
