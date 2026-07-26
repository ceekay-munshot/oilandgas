/**
 * HTTP with timeout, bounded retry and typed failures.
 * Network only - nothing in here knows what the bytes mean.
 */

import { HttpError } from './errors.mjs';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0 Safari/537.36 oilandgas-dashboard/0.3 (+https://github.com/ceekay-munshot/oilandgas)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000]
 * @param {number} [opts.retries=3]      attempts after the first
 * @param {string} [opts.method='GET']
 * @param {object} [opts.headers]
 * @param {string} [opts.body]
 * @returns {Promise<Response>}
 */
export async function request(url, opts = {}) {
  const { timeoutMs = 30_000, retries = 3, method = 'GET', headers = {}, body } = opts;
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'user-agent': UA, accept: '*/*', ...headers },
        body,
        redirect: 'follow',
        signal: ac.signal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new HttpError(`${res.status} ${res.statusText} for ${url}`, {
          status: res.status,
          url,
          body: text.slice(0, 400)
        });
        if (err.retryable && attempt < retries) { lastErr = err; continue; }
        throw err;
      }
      return res;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      lastErr = new HttpError(`Request failed for ${url}: ${e.message}`, { url, cause: e });
      if (attempt >= retries) throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export async function getText(url, opts) {
  return (await request(url, opts)).text();
}

export async function getJson(url, opts) {
  return (await request(url, opts)).json();
}

export async function postForm(url, params, opts = {}) {
  const res = await request(url, {
    ...opts,
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-requested-with': 'XMLHttpRequest',
      ...(opts.headers || {})
    },
    body: new URLSearchParams(params).toString()
  });
  return res.json();
}
