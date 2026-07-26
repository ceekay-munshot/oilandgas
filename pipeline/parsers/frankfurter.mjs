/**
 * Frankfurter time-series JSON -> dated points. Pure.
 *
 * Shape:
 *   { "base":"USD", "rates": { "2026-07-01": { "INR": 95.25 }, ... } }
 *
 * Frankfurter publishes business days only; weekends are simply absent, which
 * is why callers average by month rather than assuming a fixed point count.
 */

import { ParseError } from '../lib/errors.mjs';

/**
 * @param {object} json
 * @param {string} symbol e.g. 'INR'
 * @returns {{date:string,value:number}[]} oldest first
 */
export function parseFrankfurter(json, symbol) {
  const rates = json?.rates;
  if (!rates || typeof rates !== 'object') {
    throw new ParseError('Frankfurter payload had no rates object', {
      source: 'frankfurter',
      sample: JSON.stringify(json).slice(0, 200)
    });
  }

  const out = [];
  for (const [date, row] of Object.entries(rates)) {
    const v = Number(row?.[symbol]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(v)) continue;
    out.push({ date, value: v });
  }

  if (!out.length) {
    throw new ParseError(`Frankfurter payload had no ${symbol} observations`, {
      source: 'frankfurter',
      sample: JSON.stringify(json).slice(0, 200)
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
