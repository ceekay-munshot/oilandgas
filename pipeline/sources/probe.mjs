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
import { toText, extractLabelledNumber } from '../parsers/quote.mjs';
import { parsePpacGasNotification } from '../parsers/ppac-notification.mjs';
import { parseInvestingQuote } from '../parsers/investing.mjs';
import { findGasNotifications, findFlashReports } from './ppac-docs.mjs';

/**
 * The scraper-backed targets. `candidates` are the URLs worth trying in order;
 * `keywords` are what to show context around; `parsers` are the extractors the
 * fetcher now relies on, so a re-run says whether they still read the page.
 */
export const SCRAPE_TARGETS = {
  apm: {
    label: 'APM - domestic gas notification (notified price and ONGC/OIL ceiling)',
    unit: '$/mmbtu',
    plausible: [1, 20],
    /* The PPAC gas-price page carries NO price - it is a list of download links,
       and the number only exists inside monthly PDFs that are scanned images.
       So the probe discovers the newest PDF with a plain GET (that part works
       without a key) and points the scraper at the PDF itself, where Firecrawl's
       OCR is the thing being tested. */
    discover: findGasNotifications,
    candidates: ['https://ppac.gov.in/natural-gas/gas-price'],
    keywords: ['APM', 'administered', 'MMBTU', 'MMBtu', 'ceiling', 'US$', 'GCV', 'Dated'],
    labels: [/APM[^0-9]{0,40}/, /administered price[^0-9]{0,40}/, /ceiling[^0-9]{0,40}/],
    parsers: [['parsePpacGasNotification', (html) => parsePpacGasNotification(html)]]
  },
  'ppac-flash': {
    label: 'PPAC monthly snapshot - refinery-wise crude processing by company',
    unit: 'MMT',
    plausible: [0, 500],
    /* SETTLED by the run of 2026-07-29, and the answer moved.
    
       The Flash Report is national product consumption only - petrol, diesel,
       ATF in TMT with YoY - and names no company at all. Useful as a demand
       series; useless for a company KPI.
    
       The prize is the OTHER document PPAC publishes the same month: the
       Snapshot / Monthly Ready Reckoner. Firecrawl OCR'd it to 46,090
       characters of clean text, and it carries crude processing refinery by
       refinery WITH company totals -
    
         9 Paradip (2016) 15.0 14.7 16.3 1.4 1.4 1.2 4.2 4.1 3.7
           IOCL-TOTAL     70.3 71.6 75.5 6.2 6.1 6.1 18.7 18.4 19.2
           CPCL-TOTAL     10.5 10.5 11.7 1.0 0.0 0.9 3.0 0.0 2.8
    
       - plus domestic and overseas production for ONGC and OIL, and the crude
       pipeline network by company. The columns run annual, then the month,
       then April-to-date, each for the prior and current fiscal year.
    
       The keywords below are the anchors that document actually contains, read
       off that run rather than guessed, and the context window is widened
       because the table is what has to be read, not a single number. */
    discover: findFlashReports,
    candidates: [],
    contextPad: 1400,
    contextMax: 2,
    keywords: [
      'IOCL-TOTAL', 'BPCL-TOTAL', 'HPCL-TOTAL', 'CPCL-TOTAL', 'RIL-TOTAL',
      'crude oil processing', 'Refinery-wise', 'Paradip', 'Manali',
      'Total domestic production', 'Ready Reckoner'
    ],
    labels: [/IOCL-TOTAL[^0-9]{0,40}/, /crude oil processing[^0-9]{0,80}/],
    parsers: []
  },
  'pngrb-cgd': {
    label: 'PNGRB monthly CGD MIS - CNG/PNG volumes by CGD entity',
    unit: 'MMSCM',
    plausible: [0, 100000],
    /* SETTLED by the run of 2026-07-29, half good.
    
       The data-bank page DOES render through the scraper - scrapedo returned
       201 KB and 18,386 characters, and the file rows are all there:
    
         CGD MIS - Month of May 2026   22/07/2026  pdf (Size: 13.6 MB)
         CGD MIS - Month of April 2026 16/06/2026  pdf (Size: 12.9 MB)
    
       So the monthly CGD MIS is current and large. Two things the run also
       settled, both worth keeping written down:
    
       1. "Natural Gas Sales (CNG+PNG) by CGD Companies" - the dataset whose
          NAME is exactly what we want - is ABANDONED. Its newest entry is
          H-1 Apr-Sept 2016. Chasing it would have been a dead end.
       2. No company name appears on the listing page, because the volumes live
          inside the 13.6 MB PDF. The listing gives the link; the PDF is where
          the numbers are, so that is the next thing to read.
    
       The second candidate URL from the first pass returned an empty document
       and has been dropped - it does not exist. */
    candidates: ['https://pngrb.gov.in/eng-web/data-bank.html'],
    contextPad: 700,
    contextMax: 2,
    keywords: [
      'CGD MIS - Month of', 'Monthly CGD MIS', 'Download pdf',
      'Indraprastha', 'Mahanagar', 'Gujarat Gas', 'MMSCM'
    ],
    labels: [/CGD MIS - Month of[^0-9]{0,40}/],
    parsers: []
  },
  'baltic-dirty': {
    label: 'BDTI - Baltic Dirty Tanker Index',
    unit: 'index',
    plausible: [100, 5000],
    /* Checked by plain GET first: hellenicshippingnews and balticexchange.com do
       not mention BDTI at all, so they are not listed. investing.com does, but
       answers a plain GET with 403 - a bot wall, which is precisely the case
       Firecrawl is here for. Trading Economics was probed too and returned a
       page with no mention of the index, so it is gone from the fetcher; it
       stays here only so a future run can tell if that ever changes. */
    candidates: [
      'https://www.investing.com/indices/baltic-dirty-tanker',
      'https://tradingeconomics.com/commodity/baltic-dirty-tanker'
    ],
    keywords: ['BDTI', 'Dirty Tanker', 'Baltic Dirty', 'Tanker Index', 'live stock price', 'ticker symbol'],
    labels: [/Baltic Dirty Tanker Index/, /Baltic Dirty Tanker/, /BDTI/],
    parsers: [['parseInvestingQuote', (html) => parseInvestingQuote(html, {
      name: 'Baltic Dirty Tanker', ticker: 'BAID', plausible: [100, 5000], source: 'BDTI'
    })]]
  }
};

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
    for (const w of contextWindows(text, target.keywords, {
      pad: target.contextPad || 220, max: target.contextMax || 4
    })) {
      if (w.at < 0) { console.log(`  [${w.keyword}] NOT PRESENT`); continue; }
      console.log(`  [${w.keyword}] @${w.at}: ...${w.context.replace(/\s+/g, ' ')}...`);
    }

    console.log('\n  -- what the extractors make of it --');
    /* The real parser first: this is the one the fetcher runs, so its verdict is
       the one that decides whether the tile goes live. */
    for (const [name, fn] of target.parsers || []) {
      try {
        console.log(`  ${name} -> ${JSON.stringify(fn(res.html))}`);
        success = true;
      } catch (e) {
        console.log(`  ${name} -> ${e.name}: ${e.message.slice(0, 220)}`);
      }
    }
    /* The generic label scan, kept as a sanity check: it finds a number without
       understanding it, so a disagreement between the two is worth seeing. */
    try {
      const v = extractLabelledNumber(res.html, {
        labels: target.labels, plausible: target.plausible, source: id
      });
      console.log(`  extractLabelledNumber (generic) -> ${v}`);
    } catch (e) {
      console.log(`  extractLabelledNumber (generic) -> ${e.name}: ${e.message.slice(0, 220)}`);
    }
  }

  console.log(`\n${RULE}`);
  console.log(success
    ? `PROBE ${id}: the fetcher's own parser read this page - the tile would go live.`
    : `PROBE ${id}: the fetcher's parser could not read any candidate. The keyword ` +
      'context above is what to re-anchor on.');
  console.log(RULE);
  return success;
}
