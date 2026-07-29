#!/usr/bin/env node
/**
 * Refinery throughput straight from the ministry -> data/kpi-store.json.
 *
 * The deterministic half of step 3. extract-kpis asks a model to read what a
 * manager said on a call; this reads what PPAC published, which for the three
 * OMCs is the same quantity from a better source. It runs BEFORE extract-kpis in
 * the workflow on purpose: whatever lands here is already in the store, so the
 * planner counts those cells settled and the model is never asked - and never
 * paid - for a number the government already published.
 *
 *   node pipeline/fetch-ppac-kpis.mjs [--dry-run] [--discover-only] [--limit N] [--url <pdf>]...
 *
 *     --dry-run        read, parse and merge in memory; print what WOULD change
 *                      and write nothing. This is what the probe workflow runs.
 *     --discover-only  list the editions discovery finds and stop. No OCR credit.
 *     --url            an explicit edition, repeatable, for a backfill.
 *
 * WHAT IT IS WORTH. Today: IOCL and HPCL have no Q1 FY27 throughput at all, and
 * BPCL's is a [Mgmt Claim] of 10.15. PPAC has all three - 19.2, 6.5 and 10.2 -
 * as [Official], the firmest tag on the Part D ladder. Two gaps closed, one
 * claim corroborated and promoted, and one more quarter every month from here.
 *
 * WHY IT NEVER BREAKS THE RUN. PPAC is a scanned PDF behind an OCR credit and a
 * government site that 500s on a bad day. Every failure here - no scraper key,
 * a listing page down, a layout change - is reported loudly and exits 0 with the
 * store untouched, because the refresh behind it must still deliver the other
 * 26 companies. The one thing it must never do is write a number it is unsure
 * of: an edition that will not parse is dropped, not guessed at.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv } from './lib/env.mjs';
import { scrapePage, scrapersAvailable } from './lib/scrape.mjs';
import { toText } from './parsers/quote.mjs';
import { findSnapshots } from './sources/ppac-docs.mjs';
import { parseRefinerTotals, parseDataMonth } from './parsers/ppac-snapshot.mjs';
import { applyPpacToStore, quartersFromEditions } from './lib/ppac-fill.mjs';
import { freshStore, storeTotals } from './lib/kpi-store.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* Bumped when a change here should re-open cells this fetcher previously left
   empty. It only affects empty cells - a stored value is never re-opened by a
   fingerprint change - so bumping it is safe and costs nothing. */
const PPAC_FETCH_VERSION = 1;

function parseArgs(argv) {
  const args = argv.slice(2);
  const get = (f) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : undefined; };
  return {
    /* Read the document, parse it, work out exactly what would change - and
       write nothing. This is the mode the probe workflow runs, because the OCR
       path cannot be exercised locally and "what would this have written?" is
       the only question worth asking before it writes. */
    dryRun: args.includes('--dry-run'),
    /* List the editions discovery finds and stop. Spends no OCR credit, so it
       is the one mode that is free to run repeatedly. */
    discoverOnly: args.includes('--discover-only'),
    /* Each URL is one OCR credit, and a monthly cadence needs exactly one
       edition per run. The second is a fallback for the month PPAC renames the
       file, not a backfill. */
    limit: Number(get('--limit') || 2),
    /* Explicit editions, for a backfill. PPAC publishes no archive of past
       Snapshots, so older quarters can only be filled by pointing this at URLs
       found elsewhere - and when they are given, discovery is skipped entirely. */
    urls: args.reduce((acc, a, i) => (a === '--url' && args[i + 1] ? [...acc, args[i + 1]] : acc), [])
  };
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

/**
 * Scrape and parse one Snapshot edition.
 *
 * @returns {Promise<{url:string, dataMonth:object, totals:object[], chars:number}|null>}
 *          null when the document could not be read or dated - never a partial
 *          edition, because a total with no month cannot be filed to a quarter.
 */
async function readEdition(url, { env = process.env } = {}) {
  let res;
  try {
    res = await scrapePage(url, { env });
  } catch (e) {
    console.log(`    scrape failed: ${e.name}: ${e.message.slice(0, 160)}`);
    return null;
  }

  const text = toText(res.html);
  console.log(`    scraped via ${res.via} (${res.format}), ${res.bytes} bytes -> ${text.length} chars`);

  const dataMonth = parseDataMonth(text);
  if (!dataMonth) {
    /* The cover month and the data month differ by one, so there is no safe
       fallback here: guessing from the filename would date every figure a month
       late, and the numbers themselves would still look right. */
    console.log('    no "Data for <Mon> <Year>" line - cannot date this edition, dropped');
    return null;
  }

  let totals;
  try {
    totals = parseRefinerTotals(text);
  } catch (e) {
    console.log(`    ${e.name}: ${e.message.slice(0, 160)}`);
    return null;
  }

  const named = totals.filter((t) => t.companyId);
  console.log(`    data for ${dataMonth.month}/${dataMonth.year} · ${totals.length} company totals ` +
              `(${named.length} mapped: ${named.map((t) => t.companyId).join(', ') || 'none'})`);
  return { url, dataMonth, totals, chars: text.length };
}

async function main() {
  const opts = parseArgs(process.argv);
  loadEnv();

  const spec = await readJson(resolve(ROOT, 'data/kpi-spec.json'), null);
  if (!spec) throw new Error('data/kpi-spec.json not found');

  const keys = scrapersAvailable();
  console.log(`fetch-ppac-kpis: scraper keys ${keys.length ? keys.join(', ') : 'NONE'}`);
  if (!keys.length && !opts.discoverOnly) {
    /* Not an error. A fork with no secrets, or a run where the credit ran out,
       leaves the store exactly as it was and the model still answers everything
       else. Exiting non-zero here would take the whole refresh down with it. */
    console.log('SKIPPED: the Snapshot is a scanned PDF and needs an OCR scraper ' +
                '(FIRECRAWL_API_KEY or SCRAPEDO_API_KEY). Store unchanged.');
    return;
  }

  let urls = opts.urls;
  if (urls.length) {
    console.log(`using ${urls.length} URL(s) given on the command line`);
  } else {
    try {
      urls = await findSnapshots({ limit: opts.limit });
    } catch (e) {
      console.log(`discovery failed: ${e.name}: ${e.message.slice(0, 160)}`);
      urls = [];
    }
    console.log(`discovered ${urls.length} Snapshot edition(s) by plain GET`);
  }
  if (!urls.length) {
    console.log('SKIPPED: no Snapshot edition found on any PPAC listing page. Store unchanged.');
    return;
  }

  const editions = [];
  for (const url of urls) {
    console.log(`\n  ${url}`);
    if (opts.discoverOnly) { console.log('    (--discover-only: not scraped)'); continue; }
    const ed = await readEdition(url);
    if (ed) editions.push(ed);
    /* One good edition is a month's work, so a discovered list stops at the
       first that reads - the rest exist in case that one is unreadable, not to
       be read as well. Explicit URLs are different: a backfill is asking for
       several editions on purpose, and stopping early would silently deliver
       one quarter of the run someone paid for. */
    if (ed && !opts.urls.length) break;
  }

  if (!editions.length) {
    console.log(opts.discoverOnly
      ? '\n--discover-only: nothing scraped, nothing written.'
      : '\nSKIPPED: no edition could be read and dated. Store unchanged, and the ' +
        'keyword context from `--probe ppac-flash` is what to re-anchor the parser on.');
    return;
  }

  const byCompany = quartersFromEditions(editions);
  console.log('\nquarters closed from the editions held:');
  if (!byCompany.size) console.log('  none - a quarter needs an edition at a quarter END (Jun/Sep/Dec/Mar)');
  for (const [companyId, quarters] of byCompany) {
    console.log(`  ${companyId.padEnd(12)} ${[...quarters].map(([q, v]) => `${q}=${v}`).join('  ')}`);
  }

  const storePath = resolve(ROOT, 'data/kpi-store.json');
  const store = { ...freshStore(), ...(await readJson(storePath, {})) };
  if (!store.companies) store.companies = {};
  const before = storeTotals(store);

  const at = new Date().toISOString();
  const applied = applyPpacToStore({
    store, editions, spec, at,
    fingerprint: `ppac:v${PPAC_FETCH_VERSION}:` +
      editions.map((e) => `${e.dataMonth.year}-${e.dataMonth.month}`).join(',')
  });

  console.log('\nmerged into the store:');
  for (const r of applied.rows) {
    console.log(`  ${r.companyId.padEnd(12)}` + (r.skipped
      ? r.skipped
      : `+${r.gained} new · ${r.corrected} corrected · ${r.kept} already held`));
  }

  /* The merge above ran against the store in memory either way, so a dry run
     reports the same numbers the real one would - which is the point: the OCR
     path cannot be exercised locally, so "what would this have written?" has to
     be answerable without writing it. */
  if (!opts.dryRun) {
    store.generatedAt = at;
    await writeFile(storePath, JSON.stringify(store, null, 2) + '\n');
  }

  const after = storeTotals(store);
  console.log(`\nstore: ${after.real}/${after.cells} cells filled (was ${before.real}/${before.cells}) · ` +
              `+${applied.gained} new, ${applied.corrected} corrected, ${applied.kept} held`);
  console.log(opts.dryRun
    ? 'DRY RUN - data/kpi-store.json was NOT written. The counts above are what a real run would do.'
    : 'These cells are tagged [Official] and the model will not be asked about them.');
}

main().catch((e) => {
  /* Anything unexpected still exits 0: this fetcher is one source among many
     and the refresh behind it has 26 other companies to deliver. The label says
     what happened so a silent decay is visible in the run log. */
  console.error(`fetch-ppac-kpis FAILED: ${e.name}: ${e.message}`);
  console.error('Store unchanged; the rest of the refresh continues.');
});
