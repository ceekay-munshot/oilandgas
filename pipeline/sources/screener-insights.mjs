/**
 * Reach Screener Premium's Investors -> Insights table and hand back its markup.
 *
 * Deliberately done in the browser rather than by reverse-engineering an
 * endpoint. We already hold a logged-in Playwright context, so opening the tab
 * and clicking "Quarterly" is both simpler and more durable than guessing at a
 * URL - and guessing is exactly what cost two rounds on the AI Summary. The only
 * thing this file decides is HOW TO GET THERE; reading the table is the pure
 * parser's job (parsers/screener-insights.mjs).
 *
 * Quarterly is preferred and Yearly is the fallback: some rows (reserves, RRR)
 * are only ever published annually, and an annual value labelled as annual is
 * worth more than four empty quarters.
 */

const BASE = 'https://www.screener.in';

/** Click the first thing that matches any of these, or return false. */
async function clickAny(page, selectors, timeout = 3500) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ timeout }); return true; }
    } catch { /* try the next candidate */ }
  }
  return false;
}

/** Serialise the table that carries reporting periods, if the page has one. */
async function tableHtml(page) {
  return page.evaluate(() => {
    const period = /^(?:[A-Z][a-z]{2}\s+\d{4}|TTM|Q[1-4]\s*FY\d{2})$/;
    for (const t of Array.from(document.querySelectorAll('table'))) {
      const heads = Array.from(t.querySelectorAll('thead th, thead td'))
        .map((th) => (th.textContent || '').replace(/\s+/g, ' ').trim());
      if (heads.filter((h) => period.test(h)).length >= 2) return t.outerHTML;
    }
    return null;
  });
}

/**
 * @param {import('playwright').BrowserContext} context logged in
 * @param {string} slug Screener company slug
 * @returns {Promise<{html:string|null, view:'quarterly'|'yearly'|'unknown', url:string, note:string|null}>}
 */
export async function fetchInsights(context, slug, { timeout = 45_000 } = {}) {
  const page = await context.newPage();
  try {
    let url = `${BASE}/company/${slug}/consolidated/`;
    let resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    if (!resp || resp.status() === 404) {
      url = `${BASE}/company/${slug}/`;
      resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    }
    if (!resp || !resp.ok()) {
      return { html: null, view: 'unknown', url: page.url(), note: `company page HTTP ${resp ? resp.status() : 'none'}` };
    }

    // Open the Investors section. It may be a tab link, an anchor, or already
    // rendered further down the page.
    await clickAny(page, [
      'a[href$="#investors"]', 'a[href*="investors" i]',
      'nav >> text=/^\\s*Investors\\s*$/', 'text=/^\\s*Investors\\s*$/'
    ]);
    await page.waitForTimeout(1200);

    // Quarterly is what the KPI window needs; Yearly is the fallback.
    let view = 'unknown';
    if (await clickAny(page, ['button:has-text("Quarterly")', 'label:has-text("Quarterly")', 'text=/^\\s*Quarterly\\s*$/'])) {
      view = 'quarterly';
      await page.waitForTimeout(1800);
    }

    let html = await tableHtml(page);
    if (!html && view !== 'yearly') {
      // No quarterly grid - fall back to whatever the default (yearly) view shows.
      if (await clickAny(page, ['button:has-text("Yearly")', 'label:has-text("Yearly")', 'text=/^\\s*Yearly\\s*$/'])) {
        view = 'yearly';
        await page.waitForTimeout(1500);
        html = await tableHtml(page);
      }
    }

    if (!html) {
      const premium = await page.locator('text=/Upgrade to premium|Get Premium|Subscribe/i').count().catch(() => 0);
      return {
        html: null, view, url: page.url(),
        note: premium ? 'Insights appears to be premium-gated on this account' : 'no period-headed table found on the Investors view'
      };
    }
    return { html, view, url: page.url(), note: null };
  } catch (e) {
    return { html: null, view: 'unknown', url: `${BASE}/company/${slug}/`, note: (e && e.message ? e.message : String(e)).slice(0, 160) };
  } finally {
    await page.close().catch(() => {});
  }
}
