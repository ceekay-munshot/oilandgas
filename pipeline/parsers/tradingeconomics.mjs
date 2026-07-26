/**
 * Trading Economics commodity quote -> { value, previous, unit, date }. Pure.
 *
 * Two independent anchors, because a quote page is a moving target:
 *
 *   1. the stats table   "Actual Previous Highest Lowest ... 22.00 21.83 69.96 2.00 ... USD/MMBTU"
 *   2. the lede sentence "LNG JKM rose to 22 USD/MMBTU on July 24, 2026"
 *
 * The table is preferred - it carries full precision, where the sentence rounds.
 * The sentence is where the observation date lives, so both are read and the
 * results combined.
 *
 * A naive "first number after the label" approach was tried first and is a trap:
 * on this page it lands in the nav bar and returns a number that happens to look
 * like a plausible price. Anything here that cannot find a real anchor throws
 * rather than returning whatever it stumbled across.
 */

import { ParseError } from '../lib/errors.mjs';
import { toText } from './quote.mjs';

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};

const num = (s) => Number(String(s).replace(/,/g, ''));

/**
 * @param {string} html
 * @param {object} [opts]
 * @param {[number,number]} [opts.plausible] reject a value outside this range
 * @param {string} [opts.expectUnit] substring the unit must contain, case-insensitive
 * @param {string} [opts.source='tradingeconomics']
 * @returns {{value:number, previous:number|null, unit:string|null, date:string|null}}
 */
export function parseTradingEconomicsQuote(html, { plausible, expectUnit, source = 'tradingeconomics' } = {}) {
  const text = toText(html);

  // 1. stats table
  let value = null, previous = null, unit = null;
  const table = text.match(
    /Actual\s+Previous\s+Highest\s+Lowest\s+Dates\s+Unit\s+Frequency\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d\s-]+?)\s+(\S+)\s+(daily|weekly|monthly|quarterly|yearly)/i
  );
  if (table) {
    value = num(table[1]);
    previous = num(table[2]);
    unit = table[6];
  }

  // 2. lede sentence - the only place the observation date appears
  let date = null;
  const lede = text.match(
    /(?:rose|fell|increased|decreased|was|traded|climbed|dropped)\s+to\s+([\d.,]+)\s*([A-Za-z%$/]+)?\s+on\s+([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/i
  );
  if (lede) {
    const month = MONTHS[String(lede[3]).toLowerCase()];
    if (month) {
      date = `${lede[5]}-${String(month).padStart(2, '0')}-${String(num(lede[4])).padStart(2, '0')}`;
    }
    if (value === null) {
      value = num(lede[1]);
      unit = unit || lede[2] || null;
    }
  }

  if (value === null || !Number.isFinite(value)) {
    throw new ParseError('No Trading Economics quote found (neither stats table nor lede sentence)', {
      source,
      sample: text.slice(0, 300)
    });
  }
  if (expectUnit && unit && !unit.toLowerCase().includes(expectUnit.toLowerCase())) {
    throw new ParseError(`Quote unit was "${unit}", expected something containing "${expectUnit}"`, {
      source,
      sample: text.slice(0, 300)
    });
  }
  if (plausible && (value < plausible[0] || value > plausible[1])) {
    throw new ParseError(
      `Quote ${value} is outside the plausible range ${plausible[0]}..${plausible[1]} - the page shape has probably changed`,
      { source, sample: text.slice(0, 300) }
    );
  }

  return { value, previous, unit, date };
}
