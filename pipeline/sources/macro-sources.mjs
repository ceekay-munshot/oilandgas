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
   Series with no free source at all.

   Each throws with a reason written for the tile, not for a log. With a
   scraper key the page fetch below runs for real; without one the tile says
   what is missing. Neither path ever invents a number.

   NOT YET VERIFIED AGAINST A LIVE RESPONSE. The extraction is pure and tested
   against fixtures (parsers/quote.mjs), but no request has been made with a
   real key, so the labels and plausible ranges below are a first pass. Run
   `node pipeline/fetch-macro.mjs --probe <id>` with a key set to see exactly
   what comes back.
   ------------------------------------------------------------------------- */

const NEEDS_SCRAPER = ['FIRECRAWL_API_KEY', 'SCRAPEDO_API_KEY'];

function hasScraper(env) {
  return Boolean(env.FIRECRAWL_API_KEY || env.SCRAPEDO_API_KEY);
}

/** Shared shape: scrape one page, read one number, return one dated point. */
async function singleQuote({ env, today, url, labels, plausible, source, sourceTag, unit, notes }) {
  const { html, via } = await scrapePage(url, { env });
  const value = extractLabelledNumber(html, { labels, plausible, source: unit });
  return {
    points: [{ date: `${String(today).slice(0, 7)}-01`, value, partial: true }],
    source: `${source} (scraped via ${via}, ${url})`,
    sourceTag,
    notes
  };
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
 * APM - the administered domestic gas ceiling, a gazetted figure. PPAC posts it
 * monthly, but only as a scanned one-page PDF with no text layer: pdf-parse
 * returns an empty string, so it needs a rendered page or OCR, not a PDF pass.
 */
export async function fetchApmGas({ env = process.env, today } = {}) {
  if (!hasScraper(env)) {
    throw new MissingCredentialError(
      NEEDS_SCRAPER,
      'PPAC publishes APM as scanned PDFs only - add a scraper key'
    );
  }
  return singleQuote({
    env, today,
    url: 'https://ppac.gov.in/natural-gas/gas-price',
    labels: [/APM[^0-9]{0,40}/, /administered price[^0-9]{0,40}/, /domestic gas price[^0-9]{0,40}/],
    plausible: [1, 20],           // $/mmbtu
    source: 'PPAC, Ministry of Petroleum & Natural Gas - administered (APM) gas price',
    sourceTag: 'official',
    unit: 'APM $/mmbtu'
  });
}

/**
 * BDTI. The Baltic Exchange licenses its indices and publishes no free feed;
 * the Dry Index (BDI) is widely republished but measures dry bulk, not crude
 * tankers, so it is not a stand-in for this tile.
 */
export async function fetchBalticDirty({ env = process.env, today } = {}) {
  if (!hasScraper(env)) {
    throw new MissingCredentialError(
      NEEDS_SCRAPER,
      'Baltic Exchange licenses BDTI - add a scraper key to read a republisher'
    );
  }
  return singleQuote({
    env, today,
    url: 'https://tradingeconomics.com/commodity/baltic-dirty-tanker',
    labels: [/Baltic Dirty Tanker/, /BDTI/],
    plausible: [100, 5000],       // index points
    source: 'Baltic Dirty Tanker Index, free republisher',
    sourceTag: 'external',
    unit: 'BDTI index'
  });
}

export { scrapePage, SourceUnavailableError };
