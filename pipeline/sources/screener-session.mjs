/**
 * The one networked piece of the Screener scraper: a logged-in Playwright
 * session. Everything that reads a page lives in parsers/ and is pure; this file
 * only fetches - logs in, resolves slugs, hands back raw HTML, downloads a PDF
 * through the browser's cookie jar. Keeping the two apart is what lets the
 * parsers be tested without a browser or a login.
 */

import { chromium } from 'playwright';
import { HttpError, MissingCredentialError } from '../lib/errors.mjs';
import { parseCompanySlug } from '../parsers/screener-search.mjs';

const BASE = 'https://www.screener.in';
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

/** Show that a credential is present without ever printing it. */
export function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at < 1) return s ? '(set)' : '(missing)';
  return `${s[0]}***${s.slice(at)}`;
}

/**
 * Launch a browser and log into Screener.
 * @returns {Promise<{browser, context, page, close:Function}>}
 */
export async function openScreener({ email, password, headless = true, timeout = 45_000 } = {}) {
  if (!email || !password) {
    throw new MissingCredentialError(
      ['SCREENER_EMAIL', 'SCREENER_PASSWORD'],
      'Screener needs an account login - set SCREENER_EMAIL and SCREENER_PASSWORD'
    );
  }

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ userAgent: UA, acceptDownloads: true });
  const page = await context.newPage();

  await page.goto(`${BASE}/login/`, { waitUntil: 'domcontentloaded', timeout });
  await page.fill('#id_username', email);
  await page.fill('#id_password', password);
  // Screener does a full-page POST/redirect on login; wait for that navigation.
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout }).catch(() => {}),
    page.click('button[type="submit"]')
  ]);
  await page.waitForTimeout(500);

  if (!(await isLoggedIn(page))) {
    const onLogin = page.url().includes('/login');
    await browser.close();
    throw new HttpError(
      onLogin
        ? 'Screener rejected the login - check SCREENER_EMAIL / SCREENER_PASSWORD'
        : 'Screener login did not complete (no session established)',
      { url: `${BASE}/login/`, status: onLogin ? 401 : undefined }
    );
  }

  return { browser, context, page, close: () => browser.close() };
}

async function isLoggedIn(page) {
  // A rejected login re-renders /login/ with the form still on it. A successful
  // one redirects away and the password field is gone. That pair is more robust
  // than hunting for a logout link, which Screener tucks behind a JS menu.
  if (page.url().includes('/login')) return false;
  const stillHasForm = await page.locator('#id_password').count().catch(() => 0);
  return stillHasForm === 0;
}

/**
 * Resolve a company name to its Screener slug via the autocomplete API, using
 * the logged-in cookies.
 * @returns {Promise<{slug:string, matchedName:string, url:string}>}
 */
export async function resolveSlug(context, query, { timeout = 30_000 } = {}) {
  const url = `${BASE}/api/company/search/?q=${encodeURIComponent(query)}&v=3&fts=1`;
  const resp = await context.request.get(url, {
    timeout,
    headers: { 'x-requested-with': 'XMLHttpRequest', referer: `${BASE}/` }
  });
  if (!resp.ok()) {
    throw new HttpError(`Screener search HTTP ${resp.status()} for "${query}"`, {
      url, status: resp.status()
    });
  }
  return parseCompanySlug(await resp.json(), { query });
}

/**
 * Fetch a company page, consolidated when it exists and standalone otherwise,
 * with a best-effort expansion of the "+" schedule breakdowns so their rows land
 * in the returned HTML.
 * @returns {Promise<{html:string, url:string, view:'consolidated'|'standalone', status:number}>}
 */
export async function getCompanyPage(context, slug, { timeout = 45_000, expand = true } = {}) {
  const page = await context.newPage();
  try {
    let view = 'consolidated';
    let resp = await page.goto(`${BASE}/company/${slug}/consolidated/`, {
      waitUntil: 'domcontentloaded', timeout
    });
    if (!resp || resp.status() === 404) {
      view = 'standalone';
      resp = await page.goto(`${BASE}/company/${slug}/`, { waitUntil: 'domcontentloaded', timeout });
    }
    if (!resp || !resp.ok()) {
      throw new HttpError(`Screener company page HTTP ${resp ? resp.status() : 'no response'} for ${slug}`, {
        url: page.url(), status: resp ? resp.status() : undefined
      });
    }

    if (expand) await expandSchedules(page).catch(() => {});

    const html = await page.content();
    return { html, url: page.url(), view, status: resp.status() };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Click the collapsed "+" line items so their child rows render. Best-effort. */
async function expandSchedules(page) {
  const buttons = await page.$$(
    'section#quarters button.button-plain, section#profit-loss button.button-plain'
  );
  for (const b of buttons.slice(0, 16)) {
    try {
      await b.click({ timeout: 1200 });
      await page.waitForTimeout(120);
    } catch {
      /* a button that will not expand is not a failure worth stopping for */
    }
  }
}

/**
 * Download a document through the browser context (so it carries the session
 * cookies). Returns the raw bytes; interpreting them is lib/pdf.mjs's job.
 * @returns {Promise<{status:number, ok:boolean, contentType:string, buffer:Buffer}>}
 */
export async function downloadDoc(context, url, { timeout = 60_000, headers = {} } = {}) {
  const resp = await context.request.get(url, {
    timeout,
    maxRedirects: 8,
    // Some hosts (BSE, company sites) serve an interstitial to requests that
    // arrive with no referer or an unhelpful Accept; look like the browser did.
    // Callers can add headers (the AI Summary needs an XHR header to get the
    // fragment instead of the app shell).
    headers: {
      referer: `${BASE}/`,
      accept: 'application/pdf,application/octet-stream,*/*',
      ...headers
    }
  });
  const buffer = Buffer.from(await resp.body());
  return {
    status: resp.status(),
    ok: resp.ok(),
    contentType: resp.headers()['content-type'] || '',
    buffer
  };
}
