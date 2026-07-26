/**
 * investing.com index quote -> { value, ticker }. Pure.
 *
 * Written against the real page (probe run 2026-07-26), which reads:
 *
 *   "Baltic Dirty Tanker (BAID) Find here information about the Baltic Dirty
 *    Tanker index (BAID). Assess the Baltic Dirty Tanker stock price and overall
 *    performance. How Is The Baltic Dirty Tanker Doing Today? The Baltic Dirty
 *    Tanker live stock price is 1,107.00. What Is the Baltic Dirty Tanker Ticker
 *    Symbol? BAID is the ticker symbol of the Baltic Dirty Tanker index."
 *
 * The quote is taken from that FAQ sentence rather than from the header widget,
 * for one reason: the sentence is what the probe actually captured, so it is the
 * only anchor there is evidence for. The header block sits elsewhere in the
 * 15k characters the scrape returned and was never seen, so guessing at its
 * markup would be inventing a selector all over again.
 *
 * The instrument name is required to sit immediately before "live stock price
 * is" and the ticker sentence has to corroborate it. investing.com serves the
 * same template for every instrument, so without both checks a redirect to a
 * different index would return a confident, wrong number.
 */

import { ParseError } from '../lib/errors.mjs';
import { toText } from './quote.mjs';

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {string} html
 * @param {object} opts
 * @param {string} opts.name    instrument name as the page writes it
 * @param {string} opts.ticker  expected ticker, e.g. "BAID"
 * @param {[number,number]} [opts.plausible]
 * @param {string} [opts.source='investing']
 * @returns {{value:number, ticker:string|null, name:string}}
 */
export function parseInvestingQuote(html, { name, ticker, plausible, source = 'investing' } = {}) {
  const text = toText(html);

  /* "BAID is the ticker symbol of the Baltic Dirty Tanker index."
     Case-sensitive on purpose: it keeps the heading two sentences earlier
     ("What Is the Baltic Dirty Tanker Ticker Symbol?") from matching, and a
     ticker is uppercase anyway. If the page ever restyles this away the match
     simply goes missing and the corroboration is skipped rather than misfiring. */
  let seenTicker = null;
  const tick = text.match(/\b([A-Z0-9.=^-]{2,8}) is the ticker symbol of the ([^.]{2,60}?) index/);
  if (tick) seenTicker = tick[1];

  if (ticker && seenTicker && seenTicker.toUpperCase() !== String(ticker).toUpperCase()) {
    throw new ParseError(
      `Page is for ticker ${seenTicker}, expected ${ticker} - it is not the instrument we asked for`,
      { source, sample: text.slice(0, 300) }
    );
  }

  // "The Baltic Dirty Tanker live stock price is 1,107.00."
  const quote = text.match(new RegExp(
    esc(name) + '\\s+live\\s+stock\\s+price\\s+is\\s+(-?\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?)',
    'i'
  ));
  if (!quote) {
    throw new ParseError(
      `No "${name} live stock price is <number>" sentence on the page`,
      { source, sample: text.slice(0, 300) }
    );
  }

  const value = Number(quote[1].replace(/,/g, ''));
  if (!Number.isFinite(value)) {
    throw new ParseError(`Unreadable quote "${quote[1]}"`, { source, sample: text.slice(0, 300) });
  }
  if (plausible && (value < plausible[0] || value > plausible[1])) {
    throw new ParseError(
      `Quote ${value} is outside the plausible range ${plausible[0]}..${plausible[1]} - the page shape has probably changed`,
      { source, sample: text.slice(0, 300) }
    );
  }

  return { value, ticker: seenTicker, name };
}
