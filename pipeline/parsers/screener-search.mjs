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
 * A listing Screener marks as merged/amalgamated/delisted: a dead entity whose
 * data stops at the corporate action. Screener flags it in the name itself, e.g.
 * "Gujarat Gas Company Ltd(Merged)". Searching "L&T" used to surface "L&T
 * Finance" first the same way - the wrong entity wearing the right-ish name.
 */
const isDefunct = (name) => /\((?:merged|amalgamated|demerged|delisted)\)/i.test(String(name || ''));

/**
 * @param {any} json array from the search API
 * @param {object} [opts]
 * @param {string} [opts.query] what was searched, for the error message
 * @returns {{slug:string, matchedName:string, url:string}} the best match
 *
 * Prefer an ACTIVE listing over a merged shell. The search often returns the
 * defunct entity first (it matches the plain name), so taking result[0] blindly
 * is how a company resolves to a dead ticker. Falling back to the first usable
 * hit when every result looks defunct means this only ever helps - it never
 * turns a resolvable company into an error.
 */
export function parseCompanySlug(json, { query = '' } = {}) {
  const arr = Array.isArray(json) ? json : [];
  const usable = arr.filter((r) => slugFromUrl(r && r.url));
  const pick = usable.find((r) => !isDefunct(r.name)) || usable[0];
  if (pick) {
    return { slug: slugFromUrl(pick.url), matchedName: String(pick.name || '').trim(), url: pick.url };
  }
  throw new ParseError(`Screener search returned no usable company for "${query}"`, {
    source: 'screener-search',
    sample: JSON.stringify(json).slice(0, 200)
  });
}
