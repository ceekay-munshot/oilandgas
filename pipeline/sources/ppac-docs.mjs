/**
 * Finding PPAC's monthly gas-price notification.
 *
 * The gas-price page carries no price at all - it is a list of download links,
 * and the number only exists inside the PDFs. Those PDFs are scanned images with
 * no text layer, so pdf-parse returns nothing and they have to go through a
 * scraper that OCRs. Discovery itself needs no key: the listing pages answer a
 * plain GET.
 *
 * Two kinds of document appear in that list:
 *
 *   "Domestic Natural Gas Price for the period 1st July 2026 to 31st July 2026"
 *   "Gas Price Ceiling for the period April 2026 - September 2026"
 *
 * The monthly one is preferred because it carries both numbers - the notified
 * price and the ONGC/OIL ceiling - where the half-yearly one carries only the
 * ceiling. Filenames are prefixed with a unix timestamp, so within each kind the
 * largest prefix is the newest.
 */

import { getText } from '../lib/http.mjs';

const LISTING_PAGES = ['https://ppac.gov.in/natural-gas/gas-price', 'https://ppac.gov.in/'];

/* download.php?file=<folder>/<unixts>_<name>.pdf - the same document is posted
   under several folders, so both the timestamp and the folder vary. */
const PDF_LINK = /https:\/\/ppac\.gov\.in\/download\.php\?file=(?:gasprice|whatsnew|importantnews)\/(\d+)_([^"'\s]+?\.pdf)/gi;

/** Monthly notification filenames look like `Dom_Gas_Price_for_July_2026.pdf`. */
const MONTHLY = /dom\w*[_\s-]*gas[_\s-]*price/i;

/**
 * @param {object} [opts]
 * @param {number} [opts.limit=2] how many URLs to return
 * @returns {Promise<string[]>} newest first, monthly notifications ahead of
 *          half-yearly ceilings. Empty if neither listing page could be read.
 */
export async function findGasNotifications({ limit = 2 } = {}) {
  const found = new Map();                     // url -> { ts, monthly }

  for (const page of LISTING_PAGES) {
    let html;
    try {
      html = await getText(page, { timeoutMs: 30_000, retries: 1 });
    } catch {
      continue;                                // one listing down is not fatal
    }
    let m;
    PDF_LINK.lastIndex = 0;
    while ((m = PDF_LINK.exec(html)) !== null) {
      if (!/gas/i.test(m[2])) continue;        // gas-price documents only
      found.set(m[0], { ts: Number(m[1]), monthly: MONTHLY.test(m[2]) });
    }
  }

  return [...found.entries()]
    .sort((a, b) =>
      (b[1].monthly - a[1].monthly) ||         // monthly notification first
      (b[1].ts - a[1].ts))                     // then newest
    .slice(0, limit)
    .map(([url]) => url);
}

/* --------------------------------------------------------------------------
   The monthly Flash Report / snapshot.

   PPAC's own statistics bulletin, and the only free place company-level
   refinery throughput is published. It is linked from several PPAC pages under
   download.php with a cache-busting numeric prefix, so the URL cannot be
   constructed - it has to be discovered.

   Confirmed on 2026-07-28: the June-26 report downloads fine with a plain GET
   (539 KB) and yields 559 characters of text layer - i.e. it is a scanned
   document, exactly like the gas notification. Reading it needs the scraper's
   OCR, which is what the probe exists to test.
   -------------------------------------------------------------------------- */
const FLASH_PAGES = [
  'https://ppac.gov.in/prices/price-build-up',
  'https://ppac.gov.in/',
  'https://ppac.gov.in/reports-studies'
];

/**
 * Newest-first PDF links that look like the monthly flash report / data snapshot.
 *
 * @param {{limit?:number}} [opts]
 * @returns {Promise<string[]>}
 */
export async function findFlashReports({ limit = 3 } = {}) {
  const seen = new Set();
  const found = [];

  for (const page of FLASH_PAGES) {
    let html;
    try {
      html = await getText(page, { timeoutMs: 30_000, retries: 1 });
    } catch {
      continue;                       // a listing page being down is not fatal
    }
    const hrefs = [...html.matchAll(/href="([^"]+\.pdf[^"]*)"/gi)].map((m) => m[1]);
    for (const href of hrefs) {
      /* "Flash Report", "Snapshot of India's Oil and Gas Data", "Ready Reckoner" -
         PPAC has renamed this document more than once, so match the family. */
      if (!/flash[_%\s-]*report|snapshot.*oil|ready[_%\s-]*reckoner/i.test(href)) continue;
      const url = href.startsWith('http') ? href : new URL(href, page).toString();
      if (seen.has(url)) continue;
      seen.add(url);
      found.push(url);
    }
  }
  return found.slice(0, limit);
}

/* The Snapshot family only - "Snapshot of India's Oil and Gas Data", "Monthly
   Ready Reckoner". Deliberately NOT the Flash Report: the probe of 2026-07-29
   settled that question, and the Flash Report is national product consumption
   in TMT with no company named anywhere in it. Scraping it would spend an OCR
   credit to learn nothing, every run, forever. */
const SNAPSHOT_NAME = /snapshot[_%\s-]*of[_%\s-]*india|ready[_%\s-]*reckoner/i;

/**
 * Newest-first PDF links to PPAC's Snapshot / Ready Reckoner - the one free
 * publication that carries refinery throughput with COMPANY totals.
 *
 * There is no archive of past editions on any PPAC listing page (checked
 * 2026-07-29: /archives carries none, /reports-studies 500s, /publications
 * lists only the two current Flash Reports). So this returns the current
 * edition, the series accrues one quarter per edition, and a backfill has to be
 * driven by explicit URLs rather than discovery.
 *
 * @param {{limit?:number}} [opts]
 * @returns {Promise<string[]>}
 */
export function rankSnapshotUrls(urls, { limit = 2 } = {}) {
  const stamp = (u) => Number((/[?=/](\d{9,})_/.exec(u) || [])[1] || 0);
  /* The MONTHLY snapshot leads the annual Ready Reckoner: only the monthly one
     carries a "Data for <Mon> <Year>" line, and without it an edition cannot be
     dated and is discarded downstream. Each URL costs an OCR credit, so the one
     most likely to parse goes first. */
  const monthly = (u) => (/snapshot[_%\s-]*of[_%\s-]*india/i.test(u) ? 1 : 0);
  return (urls || [])
    .filter((u) => SNAPSHOT_NAME.test(u))
    .sort((a, b) => (monthly(b) - monthly(a)) || (stamp(b) - stamp(a)))
    .slice(0, limit);
}

export async function findSnapshots({ limit = 2 } = {}) {
  return rankSnapshotUrls(await findFlashReports({ limit: 50 }), { limit });
}
