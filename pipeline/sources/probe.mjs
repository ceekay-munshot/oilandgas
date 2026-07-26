/**
 * Diagnostics for the two fetchers that have never run against a live response.
 *
 * The point is not to pass or fail - it is to print enough of the real page that
 * a selector can be written from evidence instead of from a guess. So it reports
 * the scrape itself (which provider answered, how many bytes, what format), then
 * a context window around every keyword worth anchoring on, then what the current
 * extraction makes of it.
 *
 * Run from CI, where the keys live:
 *   node pipeline/fetch-macro.mjs --probe apm
 */

import { scrapePage } from '../lib/scrape.mjs';
import { getText } from '../lib/http.mjs';
import { toText, extractLabelledNumber } from '../parsers/quote.mjs';
import { parseTradingEconomicsQuote } from '../parsers/tradingeconomics.mjs';

/**
 * The unverified targets. `candidates` are the URLs worth trying in order;
 * `keywords` are what to show context around so the next version can anchor
 * properly.
 */
export const SCRAPE_TARGETS = {
  apm: {
    label: 'APM - administered domestic gas ceiling',
    unit: '$/mmbtu',
    plausible: [1, 20],
    /* The PPAC gas-price page carries NO price - it is a list of download links,
       and the number only exists inside monthly PDFs that are scanned images.
       So the probe discovers the newest PDF with a plain GET (that part works
       without a key) and points the scraper at the PDF itself, where Firecrawl's
       document handling is the thing being tested. */
    discover: discoverLatestApmPdf,
    candidates: ['https://ppac.gov.in/natural-gas/gas-price'],
    keywords: ['APM', 'administered', 'MMBTU', 'MMBtu', 'ceiling', 'US$', 'GCV', 'per unit'],
    labels: [/APM[^0-9]{0,40}/, /administered price[^0-9]{0,40}/, /ceiling[^0-9]{0,40}/]
  },
  'baltic-dirty': {
    label: 'BDTI - Baltic Dirty Tanker Index',
    unit: 'index',
    plausible: [100, 5000],
    /* Checked by plain GET first: hellenicshippingnews and balticexchange.com do
       not mention BDTI at all, so they are not listed. investing.com does, but
       answers a plain GET with 403 - a bot wall, which is precisely the case
       Firecrawl is here for. */
    candidates: [
      'https://www.investing.com/indices/baltic-dirty-tanker',
      'https://tradingeconomics.com/commodity/baltic-dirty-tanker'
    ],
    keywords: ['BDTI', 'Dirty Tanker', 'Baltic Dirty', 'Tanker Index', 'TD3C', 'Worldscale'],
    labels: [/Baltic Dirty Tanker Index/, /Baltic Dirty Tanker/, /BDTI/]
  }
};

/**
 * Newest monthly gas-price PDF PPAC has posted. They appear under two paths and
 * the filenames are prefixed with a unix timestamp, so the largest prefix wins.
 * Uses a plain GET - the listing pages are reachable without a key.
 */
export async function discoverLatestApmPdf() {
  const pages = ['https://ppac.gov.in/natural-gas/gas-price', 'https://ppac.gov.in/'];
  const found = new Map();
  for (const page of pages) {
    let html;
    try { html = await getText(page, { timeoutMs: 30_000, retries: 1 }); } catch { continue; }
    const re = /https:\/\/ppac\.gov\.in\/download\.php\?file=(?:gasprice|whatsnew|importantnews)\/(\d+)_([^"'\s]+?\.pdf)/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (!/gas/i.test(m[2])) continue;                 // gas-price documents only
      found.set(m[0], Number(m[1]));
    }
  }
  if (!found.size) return [];
  return [...found.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([url]) => url);
}

const RULE = '-'.repeat(72);

function contextWindows(text, keywords, { pad = 220, max = 4 } = {}) {
  const out = [];
  for (const kw of keywords) {
    const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    let m, n = 0;
    while ((m = re.exec(text)) !== null && n < max) {
      out.push({
        keyword: kw,
        at: m.index,
        context: text.slice(Math.max(0, m.index - pad), m.index + pad)
      });
      n++;
    }
    if (!n) out.push({ keyword: kw, at: -1, context: null });
  }
  return out;
}

/**
 * @param {string} id  key of SCRAPE_TARGETS
 * @param {object} [opts]
 * @returns {Promise<boolean>} true if a usable value was read
 */
export async function probeScrapeTarget(id, { env = process.env } = {}) {
  const target = SCRAPE_TARGETS[id];
  if (!target) {
    console.log(`No scrape target called "${id}". Known: ${Object.keys(SCRAPE_TARGETS).join(', ')}`);
    return false;
  }

  console.log(RULE);
  console.log(`PROBE  ${id}  -  ${target.label}`);
  console.log(`expecting ${target.unit}, plausible ${target.plausible[0]}..${target.plausible[1]}`);
  console.log(`scraper keys: FIRECRAWL=${env.FIRECRAWL_API_KEY ? 'set' : 'MISSING'}  SCRAPEDO=${env.SCRAPEDO_API_KEY ? 'set' : 'MISSING'}`);
  console.log(RULE);

  let success = false;
  let urls = [...target.candidates];

  if (target.discover) {
    try {
      const found = await target.discover();
      console.log(`\ndiscovered ${found.length} document(s) by plain GET:`);
      found.forEach((u) => console.log(`  ${u}`));
      urls = [...found, ...urls];      // the document first, the listing page after
    } catch (e) {
      console.log(`\ndiscovery failed: ${e.name}: ${e.message}`);
    }
  }

  for (const url of urls) {
    console.log(`\n### ${url}`);
    let res;
    try {
      res = await scrapePage(url, { env });
    } catch (e) {
      console.log(`  SCRAPE FAILED  ${e.name}: ${e.message}`);
      if (e.attempts) e.attempts.forEach((a) => console.log(`    attempt: ${a}`));
      if (e.body) console.log(`    body: ${String(e.body).slice(0, 300)}`);
      continue;
    }

    const text = toText(res.html);
    console.log(`  scraped OK via ${res.via} (${res.format}), ${res.bytes} bytes -> ${text.length} chars of text`);
    console.log(`  first 300 chars: ${JSON.stringify(text.slice(0, 300))}`);

    console.log('\n  -- keyword context --');
    for (const w of contextWindows(text, target.keywords)) {
      if (w.at < 0) { console.log(`  [${w.keyword}] NOT PRESENT`); continue; }
      console.log(`  [${w.keyword}] @${w.at}: ...${w.context.replace(/\s+/g, ' ')}...`);
    }

    console.log('\n  -- what the current extractors make of it --');
    try {
      const v = extractLabelledNumber(res.html, {
        labels: target.labels, plausible: target.plausible, source: id
      });
      console.log(`  extractLabelledNumber -> ${v}`);
      success = true;
    } catch (e) {
      console.log(`  extractLabelledNumber -> ${e.name}: ${e.message.slice(0, 220)}`);
    }
    try {
      const q = parseTradingEconomicsQuote(res.html, { plausible: target.plausible, source: id });
      console.log(`  parseTradingEconomicsQuote -> ${JSON.stringify(q)}`);
      success = true;
    } catch (e) {
      console.log(`  parseTradingEconomicsQuote -> ${e.name}: ${e.message.slice(0, 220)}`);
    }
  }

  console.log(`\n${RULE}`);
  console.log(success
    ? `PROBE ${id}: at least one extractor produced a plausible value.`
    : `PROBE ${id}: no extractor produced a value. The keyword context above is what to anchor on.`);
  console.log(RULE);
  return success;
}
