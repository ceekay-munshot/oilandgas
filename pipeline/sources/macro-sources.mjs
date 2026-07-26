/**
 * One fetcher per macro series: network in, dated monthly points out.
 * Each returns { points, source, sourceTag } or throws. The orchestrator turns
 * a throw into an honest "awaiting" tile - no fetcher ever substitutes a guess.
 */

import { getText, getJson, postForm } from '../lib/http.mjs';
import { scrapePage } from '../lib/scrape.mjs';
import { MissingCredentialError } from '../lib/errors.mjs';
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
   Series with no key-free public source. Each needs FIRECRAWL_API_KEY or
   SCRAPEDO_API_KEY; without one they throw MissingCredentialError and the tile
   is written as "awaiting" rather than filled with a plausible-looking number.

   Left deliberately unimplemented rather than half-implemented: writing a
   selector against a page this pipeline has never once loaded would be a guess
   dressed as code. They are wired up in the prompt that first has the keys.
   ------------------------------------------------------------------------- */

const NEEDS_SCRAPER = ['FIRECRAWL_API_KEY', 'SCRAPEDO_API_KEY'];

export async function fetchSingaporeGrm({ env = process.env } = {}) {
  if (!env.FIRECRAWL_API_KEY && !env.SCRAPEDO_API_KEY) throw new MissingCredentialError(NEEDS_SCRAPER);
  throw new MissingCredentialError(NEEDS_SCRAPER); // selector work lands with the key
}

export async function fetchJkm({ env = process.env } = {}) {
  if (!env.FIRECRAWL_API_KEY && !env.SCRAPEDO_API_KEY) throw new MissingCredentialError(NEEDS_SCRAPER);
  throw new MissingCredentialError(NEEDS_SCRAPER);
}

/**
 * PPAC publishes the administered (APM) gas price monthly, but only as scanned
 * one-page PDFs with no text layer - pdf-parse returns an empty string, so this
 * needs OCR or the scraper fallback, not a PDF text pass.
 */
export async function fetchApmGas({ env = process.env } = {}) {
  if (!env.FIRECRAWL_API_KEY && !env.SCRAPEDO_API_KEY) throw new MissingCredentialError(NEEDS_SCRAPER);
  throw new MissingCredentialError(NEEDS_SCRAPER);
}

export async function fetchBalticDirty({ env = process.env } = {}) {
  if (!env.FIRECRAWL_API_KEY && !env.SCRAPEDO_API_KEY) throw new MissingCredentialError(NEEDS_SCRAPER);
  throw new MissingCredentialError(NEEDS_SCRAPER);
}

export { scrapePage };
