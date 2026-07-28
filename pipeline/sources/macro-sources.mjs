/**
 * One fetcher per macro series: network in, dated monthly points out.
 * Each returns { points, source, sourceTag } or throws. The orchestrator turns
 * a throw into an honest "awaiting" tile - no fetcher ever substitutes a guess.
 */

import { getText, getJson, postForm } from '../lib/http.mjs';
import { scrapePage } from '../lib/scrape.mjs';
import { MissingCredentialError, SourceUnavailableError } from '../lib/errors.mjs';
import { crackSpread321 } from '../parsers/crack.mjs';
import { parseTradingEconomicsQuote } from '../parsers/tradingeconomics.mjs';
import { parseFredCsv } from '../parsers/fred.mjs';
import { parseFrankfurter } from '../parsers/frankfurter.mjs';
import { parsePpacFyTable, fyWindow } from '../parsers/ppac.mjs';
import { parsePpacGasNotification } from '../parsers/ppac-notification.mjs';
import { parseInvestingQuote } from '../parsers/investing.mjs';
import { findGasNotifications } from './ppac-docs.mjs';
import { monthlyAverage, takeLastMonths, lastMonths, round, markPartialMonth } from '../lib/dates.mjs';

const MONTHS = 12;

/** Federal Reserve Economic Data - daily spot, key-free CSV. */
async function fromFred(seriesId, { months = MONTHS, today } = {}) {
  const csv = await getText(
    `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`,
    { timeoutMs: 45_000 }
  );
  const daily = parseFredCsv(csv, seriesId);
  const monthly = takeLastMonths(monthlyAverage(daily), months).map((p) => ({ ...p, value: round(p.value, 2) }));
  return markPartialMonth(monthly, today);
}

export async function fetchBrent({ today }) {
  return {
    points: await fromFred('DCOILBRENTEU', { today }),
    source: 'FRED / U.S. EIA, Europe Brent spot FOB (DCOILBRENTEU), monthly mean of daily',
    sourceTag: 'official'
  };
}

export async function fetchWti({ today }) {
  return {
    points: await fromFred('DCOILWTICO', { today }),
    source: 'FRED / U.S. EIA, WTI spot Cushing (DCOILWTICO), monthly mean of daily',
    sourceTag: 'official'
  };
}

/** Frankfurter fronts the ECB reference rates. Key-free. */
export async function fetchUsdInr({ today }) {
  const window = lastMonths(MONTHS, today);
  const start = window[0];
  const json = await getJson(
    `https://api.frankfurter.app/${start}..${today}?base=USD&symbols=INR`,
    { timeoutMs: 45_000 }
  );
  const daily = parseFrankfurter(json, 'INR');
  return {
    points: markPartialMonth(
      takeLastMonths(monthlyAverage(daily), MONTHS).map((p) => ({ ...p, value: round(p.value, 2) })),
      today
    ),
    source: 'Frankfurter / European Central Bank reference rates, monthly mean of daily',
    sourceTag: 'official'
  };
}

/**
 * PPAC publishes the Indian Crude Basket monthly, already averaged, behind the
 * same AjaxController the page's own table calls. Two fiscal years are pulled
 * because 12 months always straddles an April boundary.
 */
export async function fetchIndianBasket({ today }) {
  const [prevFy, curFy] = fyWindow(today);
  const url = 'https://ppac.gov.in/AjaxController/getInternationalPricesCrudeOil';
  const params = { reportBy: '4', pageId: '30' }; // reportBy 4 = $/bbl

  const all = [];
  for (const fy of [prevFy, curFy]) {
    try {
      all.push(...parsePpacFyTable(await postForm(url, { ...params, financialYear: fy }), fy));
    } catch (e) {
      // A fiscal year with nothing published yet is normal in April; only fail
      // if neither year yielded anything.
      if (fy === curFy && all.length) continue;
      if (fy === prevFy) continue;
      throw e;
    }
  }
  if (!all.length) throw new Error('PPAC returned no published months for either fiscal year');

  const points = [...new Map(all.map((p) => [p.date, p])).values()].sort((a, b) =>
    a.date < b.date ? -1 : 1
  );
  return {
    points: markPartialMonth(takeLastMonths(points, MONTHS), today),
    source: 'PPAC, Ministry of Petroleum & Natural Gas - Indian Crude Basket, monthly average',
    sourceTag: 'official'
  };
}

/* -------------------------------------------------------------------------
   Refining margin.

   Singapore GRM itself is a Platts assessment behind a paywall. What is free
   is every leg of a US Gulf 3-2-1 crack spread, from the same EIA series the
   crude tiles use. That is a real refining margin - just not the Singapore
   one - so it ships tagged "derived" and labelled as a stand-in rather than
   quietly filling a tile that claims to be Singapore.
   ------------------------------------------------------------------------- */

export async function fetchCrackSpread({ today }) {
  const [gasoline, distillate, crude] = await Promise.all([
    fromFred('DGASUSGULF', { today }),   // conventional gasoline, US Gulf, $/gal
    fromFred('DHOILNYH', { today }),     // No.2 heating oil, NY Harbor, $/gal
    fromFred('DCOILWTICO', { today })    // WTI - US Gulf refiners price off it
  ]);
  return {
    points: takeLastMonths(crackSpread321({ gasoline, distillate, crude }), MONTHS),
    source:
      'Derived 3-2-1 crack spread from FRED / U.S. EIA spot prices ' +
      '(US Gulf gasoline, NY Harbor heating oil, WTI), monthly mean of daily',
    sourceTag: 'derived',
    standIn: 'US Gulf Coast crack spread, standing in for Singapore GRM (a paywalled Platts assessment)'
  };
}

/* -------------------------------------------------------------------------
   Series behind a paywall, a bot wall or a scanned PDF.

   Each throws with a reason written for the tile, not for a log. With a
   scraper key the page fetch below runs for real; without one the tile says
   what is missing. Neither path ever invents a number.

   All three have now completed a real request from CI (probe run 2026-07-26),
   and the parsers below are anchored on the text those responses actually
   contained - not on documentation. Re-run
   `node pipeline/fetch-macro.mjs --probe <id>` to see the current pages.
   ------------------------------------------------------------------------- */

const NEEDS_SCRAPER = ['FIRECRAWL_API_KEY', 'SCRAPEDO_API_KEY'];

function hasScraper(env) {
  return Boolean(env.FIRECRAWL_API_KEY || env.SCRAPEDO_API_KEY);
}

/**
 * JKM - the Northeast Asia LNG spot benchmark. The Platts assessment itself is
 * paywalled, but Trading Economics republishes the headline number and its page
 * reads fine with a plain GET, so this needs no key. The scraper is only a
 * fallback for the day that stops being true.
 *
 * Spot only: there is no free history behind it, so this line carries a single
 * point and the tile shows no trend rather than a one-point line.
 */
export async function fetchJkm({ env = process.env, today } = {}) {
  const url = 'https://tradingeconomics.com/commodity/liquefied-natural-gas-japan-korea';
  let html, via = 'direct fetch';
  try {
    html = await getText(url, { timeoutMs: 30_000, retries: 2 });
  } catch (e) {
    if (!hasScraper(env)) {
      throw new SourceUnavailableError(
        'LNG tracker unreachable and no scraper key set',
        { detail: e.message, cause: e }
      );
    }
    ({ html } = await scrapePage(url, { env }));
    via = 'scraper';
  }

  const q = parseTradingEconomicsQuote(html, {
    plausible: [1, 80],        // $/mmbtu - a misread lands well outside this
    expectUnit: 'mmbtu',
    source: 'JKM'
  });

  return {
    points: [{ date: q.date || `${String(today).slice(0, 7)}-01`, value: q.value, spot: true }],
    source: `Trading Economics - LNG Japan/Korea Marker spot (${via})`,
    sourceTag: 'external',
    notes: 'Spot quote only - no free history is published, so this line has no 12-month trend.'
  };
}

/**
 * Naphtha, the feedstock every Indian cracker runs on.
 *
 * Trading Economics quotes it in USD/T, which is why it is here and the polymer
 * pages are not: polyethylene, polypropylene and styrene are all quoted CNY/T,
 * i.e. Chinese domestic prices. Subtracting a global USD feedstock from a
 * Chinese domestic polymer would produce a number that looks like a petchem
 * margin and is neither Indian nor internally consistent - the wrong-basis trap
 * this pipeline exists to avoid. So this tile carries the COST side only, and
 * says so; the margin itself stays an honest gap until a real Indian polymer
 * assessment is available.
 *
 * Spot only, like JKM: no free history is published.
 */
export async function fetchNaphtha({ env = process.env, today } = {}) {
  const url = 'https://tradingeconomics.com/commodity/naphtha';
  let html, via = 'direct fetch';
  try {
    html = await getText(url, { timeoutMs: 30_000, retries: 2 });
  } catch (e) {
    if (!hasScraper(env)) {
      throw new SourceUnavailableError(
        'Naphtha tracker unreachable and no scraper key set',
        { detail: e.message, cause: e }
      );
    }
    ({ html } = await scrapePage(url, { env }));
    via = 'scraper';
  }

  const q = parseTradingEconomicsQuote(html, {
    plausible: [200, 1600],     // $/tonne - a misread lands well outside this
    expectUnit: 'usd',          // refuses the CNY-quoted pages outright
    source: 'Naphtha'
  });

  return {
    points: [{ date: q.date || `${String(today).slice(0, 7)}-01`, value: q.value, spot: true }],
    source: `Trading Economics - naphtha spot (${via})`,
    sourceTag: 'external',
    notes: 'Spot quote only - no free history is published, so this line has no 12-month trend.'
  };
}

/**
 * APM - the administered domestic gas price, a gazetted figure. PPAC posts it
 * monthly, but only as a scanned one-page PDF with no text layer: pdf-parse
 * returns an empty string, so it takes an OCR pass rather than a PDF pass.
 *
 * The notification carries two prices. The July 2026 one reads "notified as
 * US$ 8.73/MMBTU", then caps ONGC and Oil India's nomination gas at "a ceiling
 * of US$ 7.00/MMBTU". The ceiling is what those producers actually realise, so
 * that is the number on the tile - but both are reported, because the gap
 * between them is 25% and either would look perfectly plausible alone.
 *
 * One point, not twelve: a 12-month history would mean OCR-ing twelve separate
 * PDFs on every run. The tile shows the current month and says so.
 */
export async function fetchApmGas({ env = process.env, today } = {}) {
  if (!hasScraper(env)) {
    throw new MissingCredentialError(
      NEEDS_SCRAPER,
      'PPAC publishes APM as scanned PDFs only - add a scraper key'
    );
  }

  const docs = await findGasNotifications();
  if (!docs.length) {
    throw new SourceUnavailableError(
      'PPAC listed no gas-price notification to read',
      { detail: 'no download.php links matched on either listing page' }
    );
  }

  // Usually the same document posted under two folders, so the second is a
  // free retry rather than a different reading.
  const attempts = [];
  for (const url of docs) {
    let html;
    try {
      ({ html } = await scrapePage(url, { env }));
    } catch (e) {
      attempts.push(`${url}: ${e.message}`);
      continue;
    }
    let doc;
    try {
      doc = parsePpacGasNotification(html);
    } catch (e) {
      attempts.push(`${url}: ${e.message}`);
      continue;
    }

    const bothPrices = doc.ceiling !== null && doc.notified !== null;
    return {
      points: [{ date: doc.periodStart || `${String(today).slice(0, 7)}-01`, value: doc.value }],
      source:
        'PPAC, Ministry of Petroleum & Natural Gas - domestic gas notification' +
        (doc.periodLabel ? ` for ${doc.periodLabel}` : '') +
        (doc.publishedOn ? `, issued ${doc.publishedOn}` : '') +
        ` (${url})`,
      sourceTag: 'official',
      notes: bothPrices
        ? `ONGC/OIL nomination-gas ceiling of $${doc.ceiling.toFixed(2)}/mmbtu, ` +
          `below the notified price of $${doc.notified.toFixed(2)}. This month only - ` +
          'PPAC publishes each month as a separate scanned notification.'
        : 'This month only - PPAC publishes each month as a separate scanned notification.'
    };
  }

  throw new SourceUnavailableError(
    'Could not read the PPAC gas notification',
    { detail: attempts.join('; ') }
  );
}

/**
 * BDTI. The Baltic Exchange licenses its indices and publishes no free feed;
 * the Dry Index (BDI) is widely republished but measures dry bulk, not crude
 * tankers, so it is not a stand-in for this tile.
 *
 * investing.com republishes the number and answers a plain GET with 403 - a bot
 * wall, which is what the scraper is for. Trading Economics was the intended
 * fallback and has been dropped: its page returned 4,656 characters with no
 * mention of the index at all, so it is not a second source, just a second way
 * to fail.
 *
 * Spot only: the free page carries the latest value, no history.
 */
export async function fetchBalticDirty({ env = process.env, today } = {}) {
  if (!hasScraper(env)) {
    throw new MissingCredentialError(
      NEEDS_SCRAPER,
      'Baltic Exchange licenses BDTI - add a scraper key to read a republisher'
    );
  }

  const url = 'https://www.investing.com/indices/baltic-dirty-tanker';
  const { html, via } = await scrapePage(url, { env });
  const q = parseInvestingQuote(html, {
    name: 'Baltic Dirty Tanker',
    ticker: 'BAID',
    plausible: [100, 5000],      // index points
    source: 'BDTI'
  });

  return {
    points: [{ date: `${String(today).slice(0, 7)}-01`, value: q.value, spot: true }],
    source: `investing.com - Baltic Dirty Tanker (BAID), latest published level (scraped via ${via})`,
    sourceTag: 'external',
    notes: 'Latest level only - the Baltic Exchange licenses the history, so this line has no 12-month trend.'
  };
}

export { scrapePage, SourceUnavailableError };
