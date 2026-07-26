/**
 * Pull a single labelled number out of a scraped page. Pure: takes markup or
 * text, returns a number, never touches the network.
 *
 * Used by the series that only exist on rendered pages (JKM, BDTI). The scrape
 * itself is unverified until someone runs it with a key - which is exactly why
 * the extraction lives here, behind tests, instead of inline in the fetcher.
 *
 * The approach is deliberately not a CSS selector. Selectors on a quote page
 * break on the next redesign and break silently. Anchoring on the label text
 * and taking the nearest plausible number survives a re-skin, and when it does
 * fail it fails loudly because no number is found at all.
 */

import { ParseError } from '../lib/errors.mjs';

/** Markup -> collapsed visible text. */
export function toText(html) {
  return String(html)
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;?/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

/* The comma-grouped branch must REQUIRE a group. With `*` it matched the first
   three digits of a plain "2026" and the alternation stopped there, silently
   yielding 202 - a wrong number that still looked like an index value. */
const NUM = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/;

/**
 * Find the number nearest a label.
 *
 * @param {string} html
 * @param {object} opts
 * @param {(string|RegExp)[]} opts.labels  any one of these anchors the search
 * @param {number} [opts.window=120]       characters after the label to search
 * @param {[number,number]} [opts.plausible] reject values outside this range -
 *        a page that reformats and hands back a year or a page number should
 *        fail, not publish 2026 as a price
 * @param {string} [opts.source='quote']
 * @returns {number}
 */
export function extractLabelledNumber(html, { labels, window = 120, plausible, source = 'quote' } = {}) {
  const text = toText(html);
  const tried = [];

  for (const label of labels || []) {
    const re = label instanceof RegExp
      ? new RegExp(label.source, label.flags.includes('i') ? label.flags : label.flags + 'i')
      : new RegExp(String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    let m;
    const scan = new RegExp(re.source, 'gi');
    while ((m = scan.exec(text)) !== null) {
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + window);
      const hit = after.match(NUM);
      if (!hit) continue;
      const value = Number(hit[0].replace(/,/g, ''));
      if (!Number.isFinite(value)) continue;
      if (plausible && (value < plausible[0] || value > plausible[1])) {
        tried.push(`${label} -> ${value} (outside ${plausible[0]}..${plausible[1]})`);
        continue;
      }
      return value;
    }
    tried.push(`${label} -> no number within ${window} chars`);
  }

  throw new ParseError(
    `Could not read a value for ${source}: ${tried.join('; ') || 'no label matched'}`,
    { source, sample: text.slice(0, 300) }
  );
}
