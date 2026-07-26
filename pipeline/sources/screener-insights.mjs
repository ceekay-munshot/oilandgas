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

/**
 * Serialise the INSIGHTS table specifically.
 *
 * Anchored on the card's own wording - "Extracted by Screener AI" / "Insights" /
 * "In beta" - and not on "the first table with period headers". That looser rule
 * was tried and it silently returned the ordinary Quarterly Results table
 * instead: Sales, Expenses, OPM %, Interest, Depreciation, every one of them a
 * real period-headed table and none of them what we came for.
 *
 * A row-label check backs the anchor up: if the rows read like a standard P&L, it
 * is the wrong table however it was found.
 */
async function insightsTableHtml(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const PERIOD = /^(?:[A-Z][a-z]{2}\s+\d{4}|TTM|Q[1-4]\s*FY\d{2})$/;
    const PNL = /^(sales|expenses|operating profit|opm ?%|other income|interest|depreciation|profit before tax|tax ?%|net profit|eps)\b/i;

    const hasPeriods = (t) => Array.from(t.querySelectorAll('thead th, thead td'))
      .map((th) => clean(th.textContent)).filter((h) => PERIOD.test(h)).length >= 2;

    const looksLikePnl = (t) => {
      const labels = Array.from(t.querySelectorAll('tbody tr'))
        .map((tr) => clean((tr.querySelector('td, th') || {}).textContent)).filter(Boolean);
      if (!labels.length) return true;
      const hits = labels.filter((l) => PNL.test(l)).length;
      return hits >= Math.max(2, Math.ceil(labels.length * 0.5));
    };

    // Walk up from the marker to the card that contains a table.
    const markers = Array.from(document.querySelectorAll('body *')).filter((el) => {
      if (el.children.length > 2) return false;         // leaf-ish nodes only
      const t = clean(el.textContent);
      return /Extracted by Screener/i.test(t) || /^Insights\b/i.test(t) || /^In ?beta$/i.test(t);
    });

    for (const m of markers) {
      for (let el = m; el && el !== document.body; el = el.parentElement) {
        const t = el.querySelector('table');
        if (t && hasPeriods(t) && !looksLikePnl(t)) return t.outerHTML;
      }
    }

    // No marker: accept a period-headed table only if it is clearly NOT the P&L.
    for (const t of Array.from(document.querySelectorAll('table'))) {
      if (hasPeriods(t) && !looksLikePnl(t)) return t.outerHTML;
    }
    return null;
  });
}

/**
 * Pull the Insights table out of a page that is ALREADY on the company.
 *
 * Takes an open page rather than opening its own, because opening a second page
 * per company is what earned Screener's rate limiter: the first run of this got
 * HTTP 429 on the third and fourth companies. The caller already loads the company
 * page for the financials, so the Investors view is one click away on that page
 * and costs no extra request.
 *
 * @param {import('playwright').Page} page already on the company page
 * @returns {Promise<{html:string|null, view:'quarterly'|'yearly'|'unknown', url:string, note:string|null}>}
 */
export async function insightsFromPage(page) {
  try {
    // Open the Investors section - a tab link, an anchor, or already rendered.
    await clickAny(page, [
      'a[href$="#investors"]', 'a[href*="investors" i]',
      'nav >> text=/^\\s*Investors\\s*$/', 'text=/^\\s*Investors\\s*$/'
    ]);
    await page.waitForTimeout(1200);

    // Quarterly is what the KPI window needs; Yearly is the fallback, because
    // reserves and RRR are only ever published annually.
    let view = 'unknown';
    if (await clickAny(page, ['button:has-text("Quarterly")', 'label:has-text("Quarterly")', 'text=/^\\s*Quarterly\\s*$/'])) {
      view = 'quarterly';
      await page.waitForTimeout(1800);
    }

    let html = await insightsTableHtml(page);
    if (!html) {
      if (await clickAny(page, ['button:has-text("Yearly")', 'label:has-text("Yearly")', 'text=/^\\s*Yearly\\s*$/'])) {
        view = 'yearly';
        await page.waitForTimeout(1500);
        html = await insightsTableHtml(page);
      }
    }

    if (!html) {
      const premium = await page.locator('text=/Upgrade to premium|Get Premium|Subscribe/i').count().catch(() => 0);
      return {
        html: null, view, url: page.url(),
        note: premium
          ? 'Insights appears to be premium-gated on this account'
          : 'no Insights table on this page (the P&L table is deliberately not accepted)'
      };
    }
    return { html, view, url: page.url(), note: null };
  } catch (e) {
    return { html: null, view: 'unknown', url: page.url(), note: (e && e.message ? e.message : String(e)).slice(0, 160) };
  }
}

/**
 * Standalone form: opens its own page. Kept for one-off use (a probe, a single
 * company); the batch scrape should use insightsFromPage on a page it already has.
 */
export async function fetchInsights(context, slug, { timeout = 45_000 } = {}) {
  const page = await context.newPage();
  try {
    let resp = await page.goto(`${BASE}/company/${slug}/consolidated/`, { waitUntil: 'domcontentloaded', timeout });
    if (!resp || resp.status() === 404) {
      resp = await page.goto(`${BASE}/company/${slug}/`, { waitUntil: 'domcontentloaded', timeout });
    }
    if (!resp || !resp.ok()) {
      return { html: null, view: 'unknown', url: page.url(), note: `company page HTTP ${resp ? resp.status() : 'none'}` };
    }
    return await insightsFromPage(page);
  } catch (e) {
    return { html: null, view: 'unknown', url: `${BASE}/company/${slug}/`, note: (e && e.message ? e.message : String(e)).slice(0, 160) };
  } finally {
    await page.close().catch(() => {});
  }
}
