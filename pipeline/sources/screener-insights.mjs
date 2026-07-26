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
/**
 * Read the table as TEXT in the browser, not as markup.
 *
 * The markup route failed twice over: the label cell turned out to separate its
 * name from its unit with a <br> (or bare text nodes), so cheerio's child walk saw
 * nothing and produced labels like "Order BookRs Crore" with no unit, and every
 * value came back null. innerText is the right tool - the browser has already
 * resolved <br>, block boundaries and nested spans into lines, so there is no
 * structure left to guess at.
 *
 * @returns {Promise<{periods:string[], rows:{lines:string[], cells:string[]}[]}|null>}
 */
export async function insightsMatrix(page, tableIndexHint) {
  return page.evaluate((hint) => {
    const lines = (el) => String((el && (el.innerText || el.textContent)) || '')
      .split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const t = hint != null ? document.querySelectorAll('table')[hint] : null;
    if (!t) return null;

    const heads = Array.from(t.querySelectorAll('thead th, thead td')).map((th) =>
      String((th.innerText || th.textContent) || '').replace(/\s+/g, ' ').trim());
    const PERIOD = /^(?:[A-Z][a-z]{2}\s+\d{4}|TTM|Q[1-4]\s*FY\d{2})$/;
    const first = heads.findIndex((h) => PERIOD.test(h));
    if (first === -1) return null;
    const periods = heads.slice(first).filter(Boolean);

    const rows = [];
    for (const tr of Array.from(t.querySelectorAll('tbody tr'))) {
      const cells = Array.from(tr.querySelectorAll('td, th'));
      if (cells.length < 2) continue;
      rows.push({
        lines: lines(cells[0]),
        cells: cells.slice(1).map((c) =>
          String((c.innerText || c.textContent) || '').replace(/\s+/g, ' ').trim())
      });
    }
    return rows.length ? { periods, rows } : null;
  }, tableIndexHint);
}

/** Index of the Insights table among document.querySelectorAll('table'), or null. */
export async function insightsTableIndex(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const PERIOD = /^(?:[A-Z][a-z]{2}\s+\d{4}|TTM|Q[1-4]\s*FY\d{2})$/;
    const PNL = /^(sales|expenses|operating profit|opm ?%|other income|interest|depreciation|profit before tax|tax ?%|net profit|eps)\b/i;
    const all = Array.from(document.querySelectorAll('table'));

    const hasPeriods = (t) => Array.from(t.querySelectorAll('thead th, thead td'))
      .map((th) => clean(th.textContent)).filter((h) => PERIOD.test(h)).length >= 2;
    const looksLikePnl = (t) => {
      const labels = Array.from(t.querySelectorAll('tbody tr'))
        .map((tr) => clean((tr.querySelector('td, th') || {}).textContent)).filter(Boolean);
      if (!labels.length) return true;
      return labels.filter((l) => PNL.test(l)).length >= Math.max(2, Math.ceil(labels.length * 0.5));
    };

    const markers = Array.from(document.querySelectorAll('body *')).filter((el) => {
      if (el.children.length > 2) return false;
      const t = clean(el.textContent);
      return /Extracted by Screener/i.test(t) || /^Insights\b/i.test(t) || /^In ?beta$/i.test(t);
    });
    for (const m of markers) {
      for (let el = m; el && el !== document.body; el = el.parentElement) {
        const t = el.querySelector('table');
        if (t && hasPeriods(t) && !looksLikePnl(t)) return all.indexOf(t);
      }
    }
    for (const t of all) if (hasPeriods(t) && !looksLikePnl(t)) return all.indexOf(t);
    return null;
  });
}

/**
 * Click the Quarterly control that belongs to the INSIGHTS CARD.
 *
 * Not "the first Quarterly on the page" - that was the bug. Screener's
 * Shareholding Pattern card carries its own Quarterly/Yearly pair, the page-wide
 * click found that one first, and every company came back recording view
 * "quarterly" while the Insights table sat on Mar 2016..Mar 2026. Annual numbers
 * quietly filed as quarters is the worst failure available here, so the control
 * is located by walking UP from the Insights table itself: whatever card holds the
 * table holds the toggle that redraws it.
 *
 * Clicked in-page rather than through a Playwright locator because the anchor is
 * an element we already have a handle on, not a selector we can name.
 *
 * @returns {Promise<{clicked:boolean, what:string|null}>}
 */
export async function toggleQuarterlyInCard(page, tableIdx, want = 'Quarterly') {
  return page.evaluate(({ idx, want }) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const table = document.querySelectorAll('table')[idx];
    if (!table) return { clicked: false, what: null };

    const wanted = new RegExp(`^${want}$`, 'i');
    for (let card = table.parentElement; card && card !== document.body; card = card.parentElement) {
      /* Stop at the card boundary. Without this the walk keeps climbing into
         page-level wrappers and finds Shareholding's Quarterly control - the very
         bug this function exists to fix, recurring on exactly the cards that have
         no toggle of their own. A second table in the ancestor means we have left
         our card, so anything found from here belongs to someone else. */
      if (card.querySelectorAll('table').length > 1) break;

      const controls = Array.from(card.querySelectorAll('button, a, label, input[type="radio"]'))
        .filter((el) => wanted.test(clean(el.innerText || el.textContent || el.value)));
      if (!controls.length) continue;
      const el = controls[0];
      const what = `${el.tagName.toLowerCase()}` +
        (el.className ? `.${String(el.className).split(/\s+/)[0]}` : '') +
        ` "${clean(el.innerText || el.textContent || el.value).slice(0, 24)}"`;
      el.click();
      return { clicked: true, what };
    }
    return { clicked: false, what: null };
  }, { idx: tableIdx, want });
}

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
    // Open the Investors section. Note this is Screener's nav label for the
    // shareholding area, so reaching it does NOT mean the Insights card is in
    // view - it only makes sure lazily-rendered cards below the fold exist.
    await clickAny(page, [
      'a[href$="#investors"]', 'a[href*="investors" i]',
      'nav >> text=/^\\s*Investors\\s*$/', 'text=/^\\s*Investors\\s*$/'
    ]);
    await page.waitForTimeout(1200);

    // Find the table BEFORE touching any toggle: the toggle we want is the one
    // inside this table's own card, and there is no way to know which that is
    // until the table is located.
    let idx = await insightsTableIndex(page);
    if (idx == null) {
      // Nothing yet - scroll the page to trigger any lazy render and retry once.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await page.waitForTimeout(1500);
      idx = await insightsTableIndex(page);
    }
    if (idx == null) {
      const premium = await page.locator('text=/Upgrade to premium|Get Premium|Subscribe/i').count().catch(() => 0);
      return {
        html: null, matrix: null, view: 'unknown', toggled: null, url: page.url(),
        note: premium
          ? 'Insights appears to be premium-gated on this account'
          : 'no Insights table on this page (the P&L table is deliberately not accepted)'
      };
    }

    /* Read the table BEFORE touching the toggle.
       The index is a position in document.querySelectorAll('table'), not an
       element handle, so any click that adds or removes a table invalidates it.
       Reading first means a toggle that fails, or that swaps in a table we cannot
       re-locate, costs us nothing: we still have the annual view, which is worth
       having. Never end up with less than we started with. */
    const before = {
      matrix: await insightsMatrix(page, idx),
      html: await insightsTableHtml(page)
    };

    // Quarterly is what the KPI window needs. Yearly stays as the fallback: some
    // rows (reserves, RRR) are only ever published annually, and an annual value
    // labelled as annual beats four empty quarters.
    const toggle = await toggleQuarterlyInCard(page, idx);
    if (!toggle.clicked) {
      return { ...before, view: 'unknown', url: page.url(), toggled: null,
        note: 'no Quarterly control inside the Insights card - this is the default view' };
    }

    await page.waitForTimeout(1800);
    let after = await insightsTableIndex(page);
    if (after == null) {                       // mid-swap? give it one more beat
      await page.waitForTimeout(1500);
      after = await insightsTableIndex(page);
    }
    if (after == null) {
      return { ...before, view: 'unknown', url: page.url(), toggled: toggle.what,
        note: 'Quarterly click left no locatable Insights table; kept the pre-click view' };
    }

    const matrix = await insightsMatrix(page, after);
    const html = await insightsTableHtml(page);
    if (!matrix) {
      return { ...before, view: 'unknown', url: page.url(), toggled: toggle.what,
        note: 'post-toggle table could not be read; kept the pre-click view' };
    }

    // `view` is deliberately NOT set from the click - the caller derives it from
    // the period headers, which is the only trustworthy signal.
    return { html, matrix, view: 'unknown', url: page.url(), toggled: toggle.what, note: null };
  } catch (e) {
    return {
      html: null, matrix: null, view: 'unknown', toggled: null, url: page.url(),
      note: (e && e.message ? e.message : String(e)).slice(0, 160)
    };
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
