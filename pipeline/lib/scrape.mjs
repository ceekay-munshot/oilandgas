/**
 * Rendered-page fetch for sources a plain GET cannot reach: JS challenges,
 * bot walls, geo-fencing. Tries Firecrawl, then Scrape.do, then gives up.
 *
 * Both need a key. With neither set this throws MissingCredentialError and the
 * caller records the series as "awaiting" - that is the intended path, not a
 * failure, and it is why a fork with no secrets still produces a valid file.
 */

import { MissingCredentialError, HttpError } from './errors.mjs';
import { request } from './http.mjs';

export function scrapersAvailable(env = process.env) {
  return [
    env.FIRECRAWL_API_KEY ? 'firecrawl' : null,
    env.SCRAPEDO_API_KEY ? 'scrapedo' : null
  ].filter(Boolean);
}

async function viaFirecrawl(url, { apiKey, timeoutMs, formats, retries = 2 }) {
  const res = await request('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ url, formats, onlyMainContent: false }),
    timeoutMs,
    retries
  });
  const json = await res.json();
  const data = json?.data ?? {};
  const out = data.html ?? data.rawHtml ?? data.markdown;
  if (typeof out !== 'string' || !out.length) {
    throw new HttpError(
      `Firecrawl returned no document (keys: ${Object.keys(data).join(', ') || 'none'})`,
      { url, status: res.status, body: JSON.stringify(json).slice(0, 400) }
    );
  }
  return { html: out, via: 'firecrawl', bytes: out.length, format: data.html ? 'html' : (data.rawHtml ? 'rawHtml' : 'markdown') };
}

async function viaScrapeDo(url, { apiKey, timeoutMs, render, retries = 2 }) {
  const qs = new URLSearchParams({ token: apiKey, url, render: String(Boolean(render)) });
  const res = await request(`https://api.scrape.do/?${qs}`, { timeoutMs, retries });
  const html = await res.text();
  if (!html.length) throw new HttpError('Scrape.do returned an empty document', { url, status: res.status });
  return { html, via: 'scrapedo', bytes: html.length, format: 'html' };
}

/**
 * @param {string} url
 * @param {object} [opts]
 * @param {boolean} [opts.render=true]  execute JS before returning
 * @param {number}  [opts.timeoutMs=90000]
 * @param {number}  [opts.retries=2]    transport-level retries per provider
 * @returns {Promise<{html:string, via:'firecrawl'|'scrapedo'}>}
 */
export async function scrapePage(url, opts = {}) {
  const { render = true, timeoutMs = 90_000, retries = 2, env = process.env } = opts;
  const formats = ['html'];
  const attempts = [];

  if (env.FIRECRAWL_API_KEY) {
    try {
      return await viaFirecrawl(url, { apiKey: env.FIRECRAWL_API_KEY, timeoutMs, formats, retries });
    } catch (e) {
      attempts.push(`firecrawl: ${e.message}`);
    }
  }
  if (env.SCRAPEDO_API_KEY) {
    try {
      return await viaScrapeDo(url, { apiKey: env.SCRAPEDO_API_KEY, timeoutMs, render, retries });
    } catch (e) {
      attempts.push(`scrapedo: ${e.message}`);
    }
  }

  if (!attempts.length) throw new MissingCredentialError(['FIRECRAWL_API_KEY', 'SCRAPEDO_API_KEY']);
  const err = new HttpError(`Every scraper failed for ${url} (${attempts.join('; ')})`, { url });
  err.attempts = attempts;
  throw err;
}
