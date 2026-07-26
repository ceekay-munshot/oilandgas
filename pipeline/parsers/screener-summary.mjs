/**
 * Screener's own capsule view of a company -> {pros, cons}. Pure.
 *
 * Every Screener company page carries an auto-generated Pros and Cons list - a
 * handful of plain-English bullets distilled from the financials. It is the
 * cheapest, densest "what's the story here" Screener offers, so the extractor in
 * prompt 7 reads it before it reaches for a 50,000-character transcript.
 *
 *   <div class="pros"><p class="title">Pros</p><ul><li>...</li>...</ul></div>
 *   <div class="cons"><p class="title">Cons</p><ul><li>...</li>...</ul></div>
 *
 * Bullets only - the section title and any footnote are dropped. Absent lists
 * come back empty, never invented.
 */

import { load } from 'cheerio';

function bullets($, selector) {
  return $(selector).find('li').map((_, li) =>
    $(li).text().replace(/ /g, ' ').replace(/\s+/g, ' ').trim()
  ).get().filter(Boolean);
}

/**
 * @param {string} html full company-page markup
 * @returns {{pros:string[], cons:string[]}}
 */
export function parseProsCons(html) {
  const $ = load(html);
  return { pros: bullets($, '.pros'), cons: bullets($, '.cons') };
}
