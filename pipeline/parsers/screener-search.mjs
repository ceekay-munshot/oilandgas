/**
 * Screener search payload -> a company slug. Pure.
 *
 * The autocomplete endpoint (https://www.screener.in/api/company/search/?q=...)
 * returns an array of matches, best first, each with a `url` like
 * "/company/RELIANCE/consolidated/". The slug is the path segment after
 * /company/.
 */

import { ParseError } from '../lib/errors.mjs';

export function slugFromUrl(url) {
  const m = String(url || '').match(/\/company\/([^/]+)\/?/);
  return m ? m[1] : null;
}

/**
 * @param {any} json array from the search API
 * @param {object} [opts]
 * @param {string} [opts.query] what was searched, for the error message
 * @returns {{slug:string, matchedName:string, url:string}} the best match
 */
export function parseCompanySlug(json, { query = '' } = {}) {
  const arr = Array.isArray(json) ? json : [];
  for (const r of arr) {
    const slug = slugFromUrl(r && r.url);
    if (slug) return { slug, matchedName: String(r.name || '').trim(), url: r.url };
  }
  throw new ParseError(`Screener search returned no usable company for "${query}"`, {
    source: 'screener-search',
    sample: JSON.stringify(json).slice(0, 200)
  });
}
