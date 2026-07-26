#!/usr/bin/env node
/**
 * Client pipeline, step 2: gather the raw company material from Screener.
 *
 * This step GATHERS; it does not compute KPIs. For each company it logs in,
 * resolves the Screener slug (and saves it back so future runs go direct),
 * scrapes the financial statements as context, and downloads the recent concall
 * AI Summaries and transcripts plus the latest investor PPT, caching the text.
 * No KPI value is invented here - that is extract-kpis.mjs, reading this cache in
 * the same workflow run.
 *
 * Six summaries and six transcripts are fetched rather than four, because a
 * quarter whose summary is premium-gated or whose transcript is a scan should not
 * cost us that quarter: the extractor picks the four most recent quarters that
 * actually yielded text.
 *
 *   node pipeline/scrape-screener.mjs [--scope smoke|all] [--only id1,id2] [--headful]
 *
 * Writes data/financials.json + data/docs-manifest.json (and slugs back into
 * data/companies.json). Document text is cached under pipeline/cache/docs/ which
 * is gitignored - too large to commit, and prompt 7 reads it from the same run.
 *
 * Resilient by design: per-company failures are logged and skipped, already
 * cached documents are not re-downloaded, and outputs are written after every
 * company so a crash resumes rather than restarts.
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadEnv, screenerCredentials } from './lib/env.mjs';
import { openScreener, resolveSlug, getCompanyPage, downloadDoc, maskEmail } from './sources/screener-session.mjs';
import { parseAllFinancials } from './parsers/screener-financials.mjs';
import { parseConcalls, selectDocuments, looksLikeDoc } from './parsers/screener-docs.mjs';
import { parseProsCons } from './parsers/screener-summary.mjs';
import {
  insightsFromPage, insightsTableIndex, insightsMatrix, toggleQuarterlyInCard
} from './sources/screener-insights.mjs';
import { parseInsightsTable, parseInsightsMatrix, viewFromPeriods } from './parsers/screener-insights.mjs';
import { extractPdfText, isPdf, classifyHtml } from './lib/pdf.mjs';
import { scrapePage } from './lib/scrape.mjs';
import { toText } from './parsers/quote.mjs';
import { MissingCredentialError } from './lib/errors.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = resolve(ROOT, 'pipeline/cache/docs');
// Kept in step with the KPI extractor's smoke set so `--scope smoke` scrapes
// exactly the companies the extractor will then read from the cache.
const SMOKE = ['deep-industries', 'petronet-lng', 'igl', 'engineers-india'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i > -1 ? args[i + 1] : undefined; };
  return {
    scope: get('--scope') || 'all',
    only: (get('--only') || '').split(',').map((s) => s.trim()).filter(Boolean),
    headful: args.includes('--headful'),
    verbose: args.includes('--verbose') || (get('--scope') || '') === 'smoke'
  };
}

/** Flatten companies.json into a worklist, keeping a handle on the source object. */
function collectCompanies(doc) {
  const list = [];
  for (const g of doc.groups || []) {
    for (const co of g.companies || []) list.push({ ref: co, group: g.id });
  }
  return list;
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

async function writeJson(path, obj) {
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n');
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

function docCachePaths(slug, doc) {
  const key = `${doc.type}-${(doc.periodIso || doc.period || 'unknown').replace(/[^\w-]/g, '_')}`;
  const dir = resolve(CACHE_DIR, slug);
  return { dir, txt: resolve(dir, `${key}.txt`), meta: resolve(dir, `${key}.meta.json`) };
}

/** Fetch + extract one document, or return the cached meta if we already have it. */
async function gatherDoc(context, slug, doc, { env = process.env } = {}) {
  const { dir, txt, meta } = docCachePaths(slug, doc);
  const source = hostOf(doc.url);

  if (await exists(meta)) {
    const cached = await readJson(meta, null);
    if (cached) return { ...doc, source, ...cached, cache: relCache(txt), cached: true };
  }

  // An AI Summary is a Screener HTML page; transcripts and PPTs are PDFs. A
  // PDF-expected role that comes back as HTML is a miss (not_pdf) worth a scraper
  // retry; an HTML-expected role reads its text straight from the page.
  const htmlOk = doc.role === 'summary';

  await mkdir(dir, { recursive: true });
  let status, chars = 0, pages = null, errMsg = null, via = 'browser', sample = null;
  try {
    // Fallback transcripts get a short leash so a slow own-site host fails fast;
    // primaries are worth waiting a little longer for. The AI Summary is fetched
    // the way its modal does - as an XHR - so Screener returns the summary
    // fragment rather than the full app shell (whose chrome alone is ~900 chars).
    const timeout = doc.role === 'transcript' ? 25_000 : 40_000;
    const dlOpts = doc.role === 'summary'
      ? { timeout, headers: { 'x-requested-with': 'XMLHttpRequest', accept: 'text/html, */*; q=0.01' } }
      : { timeout };
    let dl = await downloadDoc(context, doc.url, dlOpts);
    // Screener rate-limits its own summary endpoint; a 429 clears on a short
    // back-off, so retry rather than record a miss.
    for (let a = 0; !dl.ok && dl.status === 429 && a < 3; a++) {
      await sleep(2500 * (a + 1));
      dl = await downloadDoc(context, doc.url, dlOpts);
    }
    if (!dl.ok) {
      status = `http_${dl.status}`;
    } else if (isPdf(dl.buffer)) {
      const ex = await extractPdfText(dl.buffer);
      status = ex.status;          // ok | ocr_needed | not_pdf
      chars = ex.chars;
      pages = ex.pages;
      if (status === 'ok') await writeFile(txt, ex.text || '');
    } else if (htmlOk) {
      const text = toText(dl.buffer.toString('utf8'));
      sample = text.slice(0, 160);
      /* Two things that are not a summary and must never be cached as one:
         the app shell (a plain GET returns the page frame - ~900 chars of nav),
         and the free-tier paywall notice ("Limit exceeded - Upgrade to premium.
         Free users can read 10 summaries within the last 30 days"). Both are
         recorded as their own status so the manifest shows what happened. */
      if (/Limit exceeded|Upgrade to premium|Get Premium|read \d+ summaries/i.test(text)) {
        status = 'gated'; chars = text.length;
      } else if (/Create a stock screen|Feed Screens Tools Account/i.test(text)) {
        status = 'shell'; chars = text.length;
      } else {
        const v = classifyHtml(text);
        status = v.status; chars = v.chars;             // ok | thin
        if (status === 'ok') await writeFile(txt, text);
      }
    } else {
      status = 'not_pdf';                                // expected a PDF, got a page
    }
  } catch (e) {
    status = 'error';
    errMsg = (e && e.message) ? e.message.slice(0, 160) : String(e);
  }

  // A failed primary document (AI Summary or PPT) gets one scraper retry - only
  // for URLs that name a document. Transcripts are the FALLBACK, so a failed one
  // is left flagged rather than chased through Firecrawl: paying 45s per own-site
  // transcript is what made ONGC take minutes, and the summary already covers it.
  const primary = doc.role === 'summary' || doc.role === 'ppt';
  if (status !== 'ok' && primary && looksLikeDoc(doc.url) && (env.FIRECRAWL_API_KEY || env.SCRAPEDO_API_KEY)) {
    try {
      const res = await scrapePage(doc.url, { env, timeoutMs: 45_000, retries: 1 });
      const text = toText(res.html);
      if (text.length >= 200) {
        await writeFile(txt, text);
        status = 'ok'; chars = text.length; via = res.via; pages = null; errMsg = null;
      } else {
        errMsg = errMsg || `scraper returned only ${text.length} chars`;
      }
    } catch (e) {
      errMsg = errMsg || (e && e.message ? e.message.slice(0, 160) : String(e));
    }
  }

  if (status !== 'ok') await writeFile(txt, '').catch(() => {});

  const record = { status, chars, pages, via, ...(sample ? { sample } : {}), ...(errMsg ? { error: errMsg } : {}) };
  await writeJson(meta, { ...record, url: doc.url, source, at: new Date().toISOString() });
  return { ...doc, source, ...record, cache: relCache(txt), cached: false };
}

function relCache(abs) { return abs.slice(ROOT.length + 1); }

/** Latest quarter label from the parsed quarterly table, for an "as of" stamp. */
function asOfFrom(fin) {
  const q = fin.tables?.quarters;
  if (!q || !q.periods.length) return null;
  return q.periodsIso[q.periods.length - 1] || q.periods[q.periods.length - 1];
}

async function main() {
  const opts = parseArgs(process.argv);
  loadEnv();

  // The paid login wins when present - only a subscribed account can read the
  // concall AI Summaries, which are the extractor's best source.
  const { email, password, tier } = screenerCredentials();
  if (!email || !password) {
    throw new MissingCredentialError(
      ['SCREENER_PAID_EMAIL/SCREENER_PAID_PASSWORD', 'SCREENER_EMAIL/SCREENER_PASSWORD'],
      'Screener needs an account login - set SCREENER_PAID_EMAIL and SCREENER_PAID_PASSWORD ' +
      '(or the free SCREENER_EMAIL and SCREENER_PASSWORD) as secrets'
    );
  }

  const companiesPath = resolve(ROOT, 'data/companies.json');
  const financialsPath = resolve(ROOT, 'data/financials.json');
  const manifestPath = resolve(ROOT, 'data/docs-manifest.json');
  const insightsPath = resolve(ROOT, 'data/insights.json');

  const companiesDoc = await readJson(companiesPath, null);
  if (!companiesDoc) throw new Error('data/companies.json not found or unreadable');

  const all = collectCompanies(companiesDoc);

  // Recon: the "AI Summary" button never parsed as a link, so dump the raw
  // concall markup for one company to see how Screener actually renders it.
  if (opts.scope === 'dump') { await dumpConcalls(all, opts, { email, password }); return; }

  let work = all;
  if (opts.only.length) work = all.filter((c) => opts.only.includes(c.ref.id));
  else if (opts.scope === 'smoke') work = all.filter((c) => SMOKE.includes(c.ref.id));

  console.log(`scrape-screener: ${opts.scope}${opts.only.length ? ' (--only)' : ''} -> ${work.length} of ${all.length} companies`);
  if (!work.length) { console.log('nothing selected; check --scope/--only against companies.json ids'); return; }

  // Keep the current header/schema but carry over any companies a previous run
  // wrote, so a partial run is not lost and stale header fields do not linger.
  const financials = { ...freshFinancials(), companies: (await readJson(financialsPath, {})).companies || {} };
  const manifest = { ...freshManifest(), companies: (await readJson(manifestPath, {})).companies || {} };
  const insights = { ...freshInsights(), companies: (await readJson(insightsPath, {})).companies || {} };

  const session = await openScreener({ email, password, headless: !opts.headful });
  console.log(`logged in as ${maskEmail(email)} (${tier} account)` +
    (tier === 'free' ? ' - AI summaries will be premium-gated' : '') + '\n');

  let ok = 0, failed = 0, docsCached = 0, docsOcr = 0, docsRecovered = 0, docsGated = 0;

  try {
    let i = 0;
    for (const { ref: co } of work) {
      i++;
      const t0 = Date.now();
      // Progress before the work, so a slow company never looks like a freeze.
      process.stdout.write(`[${i}/${work.length}] ${co.id} ...`);
      try {
        // 1. slug: stored wins; otherwise search by name and save it back.
        let slug = co.screenerSlug;
        let matchedName;
        if (!slug) {
          const r = await resolveSlug(session.context, co.name);
          slug = r.slug; matchedName = r.matchedName;
          co.screenerSlug = slug;
          if (matchedName) co.screenerName = matchedName;
          await writeJson(companiesPath, companiesDoc);   // persist immediately
        }

        // 2. financials + Screener's own Pros/Cons capsule
        // keepPage: the Investors view is read off this same page load.
        const { html, url, view, page: coPage } = await getCompanyPage(session.context, slug, { keepPage: true });
        const fin = parseAllFinancials(html);
        const asOf = asOfFrom(fin);
        const analysis = parseProsCons(html);
        financials.companies[co.id] = {
          name: co.name, slug, view, url, asOf,
          sourceTag: 'external', source: 'Screener.in',
          analysis,                       // Screener's auto Pros/Cons - the cheapest summary
          sectionsFound: fin.sectionsFound, sectionsMissing: fin.sectionsMissing,
          tables: fin.tables
        };

        /* 2b. Premium's Investors -> Insights grid. Structured per-period rows
               (Wells Drilled, Crude Oil Production, reserves...), so for the KPIs
               it covers the extractor needs no model at all. Best-effort: a
               company without it simply has an empty entry with the reason. */
        let ins;
        try {
          ins = await insightsFromPage(coPage);
        } catch (e) {
          ins = { html: null, view: 'unknown', url, note: (e && e.message) ? e.message.slice(0, 160) : String(e) };
        } finally {
          await coPage.close().catch(() => {});
        }
        /* The browser's text matrix is preferred - it has already resolved the
           <br> between a row's name and its unit, which the markup route could
           not see (it produced "Order BookRs Crore" and all-null values). The
           HTML parse stays as a fallback.

           Which path won is RECORDED. The first version swallowed it, so a run
           where the matrix silently returned nothing looked identical to one
           where it worked - and the committed output said "quarterly" over
           annual columns with every value null, with nothing to say why. */
        let insTable = null, insVia = null, insWhy = null;
        const tryParse = (fn, arg, via) => {
          if (insTable || arg == null) return;
          try {
            const t = fn(arg);
            if (t) { insTable = t; insVia = via; }
          } catch (e) {
            insWhy = [insWhy, `${via} parse failed: ${(e && e.message) || e}`].filter(Boolean).join('; ').slice(0, 180);
          }
        };
        // The quarterly fragment first (markup), then the browser text matrix,
        // then the annual table the page loaded with - so a quarterly view that
        // fails to parse falls back to annual data rather than to nothing.
        tryParse(parseInsightsTable, ins.html, 'quarterly-fragment');
        tryParse(parseInsightsMatrix, ins.matrix, 'matrix');
        tryParse(parseInsightsTable, ins.fallbackHtml, 'annual-fallback');
        // The SOURCE's reason wins over a generic one: "premium-gated" and "the
        // selector found nothing" are different problems, and a blanket note over
        // the top of the first is how a diagnostic stops telling them apart.
        if (!insTable) insWhy = ins.note || insWhy || 'no Insights table could be parsed';
        // Keep both notes when both say something - a table can parse fine AND
        // carry a real caveat, e.g. "kept the pre-click view".
        const insNote = [insWhy, ins.note].filter(Boolean)
          .filter((v, i, a) => a.indexOf(v) === i).join('; ') || null;
        // The view comes off the period headers, never off what got clicked.
        const insView = insTable ? viewFromPeriods(insTable.periods) : 'unknown';
        insights.companies[co.id] = insTable
          ? { name: co.name, slug, view: insView, url: ins.url,
              via: insVia, toggled: ins.toggled || null, note: insNote,
              periods: insTable.periods, periodsIso: insTable.periodsIso, rows: insTable.rows }
          : { name: co.name, slug, view: 'unknown', url: ins.url,
              via: null, toggled: ins.toggled || null,
              periods: [], rows: [], note: insNote || 'no Insights table found' };
        insights.generatedAt = new Date().toISOString();
        await writeJson(insightsPath, insights);

        /* 3. documents, in the extractor's priority order: Screener's per-quarter
              AI Summary first (dense, and one document per quarter, which is
              exactly what the KPI extractor needs), then the PPT, then the full
              transcripts as the fallback.

              The AI Summary needs a Screener account that can read summaries. On
              a free account the endpoint returns "Limit exceeded - Upgrade to
              premium" after ten reads in 30 days; gatherDoc detects that and
              records status "gated" rather than caching the notice, so a
              downgrade shows up as an honest gap and the transcripts still carry
              the quarter.

              Six of each, not four: a quarter whose summary is gated or whose
              transcript is a scan should not cost us the quarter, and the
              extractor picks the four most recent quarters that actually yielded
              text. */
        const concalls = parseConcalls(html);
        const picked = selectDocuments(concalls, { transcripts: 6, summaries: 6 });
        const docs = [...picked.summaries, ...(picked.ppt ? [picked.ppt] : []), ...picked.transcripts];

        const gathered = [];
        for (const d of docs) {
          const g = await gatherDoc(session.context, slug, d, { env: process.env });
          gathered.push(g);
          if (g.cached) docsCached++;
          if (g.status === 'ocr_needed') docsOcr++;
          if (g.status === 'gated') docsGated++;
          if (g.via && g.via !== 'browser') docsRecovered++;
          // The summary endpoint is Screener's own and rate-limited; the rest are
          // external hosts, so only the summaries need the wider gap.
          await sleep(d.role === 'summary' ? 500 : 200);
        }

        const manifestDoc = (g) => ({
          type: g.type, role: g.role || g.type, period: g.period, periodIso: g.periodIso,
          url: g.url, source: g.source, status: g.status, chars: g.chars, pages: g.pages,
          via: g.via, cache: g.cache,
          ...(g.sample ? { sample: g.sample } : {}), ...(g.error ? { error: g.error } : {})
        });
        const byRole = (r) => gathered.filter((g) => (g.role || g.type) === r).map(manifestDoc);
        const ppt = gathered.find((g) => (g.role || g.type) === 'ppt') || null;

        manifest.companies[co.id] = {
          name: co.name, slug, view, url,
          analysis: { pros: analysis.pros.length, cons: analysis.cons.length },
          summariesAvailable: concalls.filter((c) => c.summary).length,
          transcriptsFound: concalls.filter((c) => c.transcript).length,
          summaries: byRole('summary'),     // primary: per-quarter AI Summary
          ppt: ppt && manifestDoc(ppt),     // primary
          transcripts: byRole('transcript') // fallback text, per quarter
        };

        // 4. persist after every company (resumable)
        financials.generatedAt = new Date().toISOString();
        manifest.generatedAt = new Date().toISOString();
        await writeJson(financialsPath, financials);
        await writeJson(manifestPath, manifest);

        ok++;
        const man = manifest.companies[co.id];
        const secs = ((Date.now() - t0) / 1000).toFixed(0);
        if (opts.verbose) {
          console.log(` done (${secs}s)`);
          reportCompany(co, financials.companies[co.id], man, insights.companies[co.id]);
        } else {
          console.log(` ${view} · ${fin.sectionsFound.length} tables · ${analysis.pros.length + analysis.cons.length} pros/cons · ${man.ppt ? 'ppt · ' : ''}${man.transcripts.length} transcripts (${secs}s)`);
        }
      } catch (e) {
        failed++;
        const msg = (e && e.message ? e.message : String(e)).slice(0, 200);
        manifest.companies[co.id] = { ...(manifest.companies[co.id] || {}), name: co.name, error: msg };
        await writeJson(manifestPath, manifest).catch(() => {});
        console.log(` FAILED: ${msg}`);
      }
      await sleep(300);   // courtesy gap between companies
    }
  } finally {
    await session.close().catch(() => {});
  }

  console.log(
    `\ndone: ${ok} ok, ${failed} failed of ${work.length}. ` +
    `${docsRecovered} recovered via scraper, ${docsOcr} need OCR, ${docsGated} premium-gated, ` +
    `${docsCached} served from cache.`
  );
  console.log(`wrote ${relCache(financialsPath)}, ${relCache(manifestPath)} and ${relCache(insightsPath)}`);
  if (opts.scope !== 'all' && !opts.only.length) {
    console.log('\nsmoke run only. Scale up with:  node pipeline/scrape-screener.mjs --scope all');
  }
}

/**
 * Print the raw markup for the parts of a company page we read, so a selector is
 * written from evidence rather than guessed. Writes nothing.
 *
 * Two rounds of guessing on the "AI Summary" button earned this: it turned out to
 * be a <button data-url> loaded as an XHR, not a link, and no amount of reasoning
 * about it from the outside would have said so.
 *
 * Now also hunts Premium's Investors -> Insights table ("Extracted by Screener
 * AI") - a per-period grid of the operational KPIs this dashboard actually wants
 * (Wells Drilled, Crude Oil Production, reserves...). If that is inline in the
 * page we can parse it deterministically and skip the model entirely for those
 * KPIs; if it arrives by XHR we need the endpoint and the Quarterly toggle.
 */
async function dumpConcalls(all, opts, { email, password }) {
  // ONGC by default: it is the company whose Insights table we have a
  // screenshot of, so the dump can be checked against something known.
  const id = opts.only[0] || 'ongc';
  const entry = all.find((c) => c.ref.id === id);
  if (!entry) { console.log(`no company "${id}" in companies.json`); return; }
  const co = entry.ref;

  const session = await openScreener({ email, password, headless: true });
  try {
    const slug = co.screenerSlug || (await resolveSlug(session.context, co.name)).slug;
    const { html, url, view } = await getCompanyPage(session.context, slug);
    console.log(`DUMP ${co.name} [${slug}] - ${url} (${view}), ${html.length} bytes\n`);

    const window = (label, re, pad) => {
      const i = html.search(re);
      console.log(`===== ${label} @${i} =====`);
      console.log(i < 0 ? '(marker not found)\n' : html.slice(i, i + pad) + '\n');
    };
    window('CONCALLS LIST', /Concalls/i, 4000);
    window('AI SUMMARY', /AI\s*Summary/i, 1400);
    window('PROS BLOCK', /class="[^"]*\bpros\b/i, 900);

    /* --- Premium: Investors -> Insights ------------------------------------
       Is it in this HTML at all, and if so under what markup? These markers are
       from the real table: the heading, the "In beta" badge, the attribution, the
       Yearly/Quarterly toggle, and a couple of actual row labels. */
    console.log('===== INSIGHTS: which markers are present in the page HTML =====');
    for (const [name, re] of [
      ['Insights heading', /Insights/i],
      ['In beta badge', /In\s*beta/i],
      ['Extracted by Screener AI', /Extracted by Screener/i],
      ['Quarterly toggle', /Quarterly/i],
      ['investors section id/href', /investors/i],
      ['a real row label', /Proved Reserves|Wells Drilled|Production \(Standalone\)/i],
      ['data-url attributes', /data-url="[^"]*"/i]
    ]) {
      const i = html.search(re);
      console.log(`  [${name}] ${i < 0 ? 'NOT PRESENT' : '@' + i}`);
    }
    window('INSIGHTS BLOCK', /Insights/i, 5000);
    window('INVESTORS ANCHOR', /investors/i, 700);

    // Every data-url on the page: that is how the AI Summary was found, and the
    // Insights toggle may well use the same mechanism.
    const urls = [...html.matchAll(/data-url="([^"]+)"/g)].map((m) => m[1]);
    console.log(`\n===== all data-url values (${urls.length}) =====`);
    [...new Set(urls)].slice(0, 40).forEach((u) => console.log('  ' + u));

    // The Insights probe, on this company and on one from the smoke set - the
    // committed output for the smoke set is what showed the table was broken.
    await dumpInsights(session.context, slug, co.name);
    const other = all.find((c) => c.ref.id === 'deep-industries');
    if (other && other.ref.screenerSlug && other.ref.screenerSlug !== slug) {
      await dumpInsights(session.context, other.ref.screenerSlug, other.ref.name);
    }
  } finally {
    await session.close().catch(() => {});
  }
}

/**
 * Why the Insights table came back all-null - answered with evidence, not by
 * reading markup and guessing again.
 *
 * The first two attempts at this table were written from assumptions about the
 * markup and both were wrong: a child walk could not see the <br> between a row's
 * name and its unit, and the page-wide "Quarterly" click turned out to belong to
 * the Shareholding card. So this dump runs the ACTUAL functions the scraper uses -
 * insightsTableIndex, insightsMatrix, parseInsightsMatrix, parseInsightsTable -
 * and prints what each one really returned, alongside the raw row markup and the
 * innerText/textContent pair for one label cell. Whatever is broken has to show
 * up in one of those.
 */
async function dumpInsights(context, slug, name) {
  console.log(`\n\n########## INSIGHTS PROBE: ${name} [${slug}] ##########`);
  const page = await context.newPage();
  const xhr = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/screener\.in/.test(u) && !/\.(css|js|woff2?|png|jpe?g|svg|ico)(\?|$)/.test(u)) xhr.push(`${r.method()} ${u}`);
  });
  try {
    await page.goto(`https://www.screener.in/company/${slug}/consolidated/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(1500);

    /* Take the SAME route production takes before surveying anything. If the
       Insights card is only created when Investors is activated, a probe that
       merely loads and scrolls would report "no table" while the real scraper
       finds one - a diagnostic that contradicts the thing it is diagnosing. */
    for (const sel of ['a[href$="#investors"]', 'a[href*="investors" i]', 'text=/^\\s*Investors\\s*$/']) {
      try {
        const el = page.locator(sel).first();
        if (await el.count()) { await el.click({ timeout: 3500 }); console.log(`  (clicked Investors via ${sel})`); break; }
      } catch { /* try the next candidate */ }
    }
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(1500);

    // --- 1. every table on the page, and every Quarterly/Yearly control -----
    const survey = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const all = Array.from(document.querySelectorAll('table'));
      const tables = all.map((t, i) => ({
        i,
        rendered: t.offsetParent !== null,
        bodyRows: t.querySelectorAll('tbody tr').length,
        heads: Array.from(t.querySelectorAll('thead th, thead td')).map((h) => clean(h.textContent)).slice(0, 8),
        labels: Array.from(t.querySelectorAll('tbody tr')).slice(0, 3)
          .map((tr) => clean((tr.querySelector('td, th') || {}).textContent).slice(0, 46))
      }));
      const toggles = Array.from(document.querySelectorAll('button, a, label, input'))
        .map((el) => ({ el, text: clean(el.innerText || el.textContent || el.value) }))
        .filter((x) => /^(quarterly|yearly)$/i.test(x.text))
        .map(({ el, text }) => {
          // Which table, if any, sits in the same card as this control?
          let idx = null;
          for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            const t = p.querySelector('table');
            if (t) { idx = all.indexOf(t); break; }
          }
          return {
            text,
            tag: el.tagName.toLowerCase(),
            cls: String(el.className || '').slice(0, 50),
            onclick: String(el.getAttribute('onclick') || '').slice(0, 70),
            href: el.getAttribute('href') || null,
            dataUrl: el.getAttribute('data-url') || null,
            cardTable: idx
          };
        });
      const anchors = Array.from(document.querySelectorAll('a[href^="#"]'))
        .map((a) => `${clean(a.textContent).slice(0, 24)} -> ${a.getAttribute('href')}`);
      return { tables, toggles, anchors: [...new Set(anchors)] };
    });

    console.log(`\n--- tables on the page (${survey.tables.length}) ---`);
    for (const t of survey.tables) {
      console.log(`  [${t.i}] rendered=${t.rendered} rows=${t.bodyRows} heads: ${t.heads.join(' | ')}`);
      console.log(`       labels: ${t.labels.join(' ; ')}`);
    }
    console.log(`\n--- Quarterly/Yearly controls (${survey.toggles.length}) - cardTable is the table in the same card ---`);
    survey.toggles.forEach((t) => console.log('  ' + JSON.stringify(t)));
    console.log(`\n--- section anchors ---\n  ${survey.anchors.join('\n  ')}`);

    // --- 2. the real locator, then the real toggle, then the real reader -----
    let idx = await insightsTableIndex(page);
    console.log(`\n--- insightsTableIndex() = ${idx} ---`);
    if (idx == null) { console.log('  (nothing to read; stopping here)'); return; }

    const toggle = await toggleQuarterlyInCard(page, idx);
    console.log(`--- toggleQuarterlyInCard() = ${JSON.stringify(toggle)} ---`);
    if (toggle.clicked) {
      await page.waitForTimeout(2000);
      const again = await insightsTableIndex(page);
      console.log(`    re-located index after the click = ${again}`);
      if (again != null) idx = again;
    }

    // --- 3. the raw markup of the row that keeps coming back null -----------
    const raw = await page.evaluate((i) => {
      const t = document.querySelectorAll('table')[i];
      if (!t) return null;
      const tr = t.querySelector('tbody tr');
      const td = tr && tr.querySelector('td, th');
      const cs = getComputedStyle(t);
      return {
        display: cs.display, visibility: cs.visibility, rendered: t.offsetParent !== null,
        theadHtml: (t.querySelector('thead') || { outerHTML: '(no thead)' }).outerHTML.slice(0, 1200),
        rowHtml: tr ? tr.outerHTML.slice(0, 1600) : '(no tbody rows)',
        labelInnerText: td ? td.innerText : null,
        labelTextContent: td ? td.textContent : null,
        valueCells: tr ? Array.from(tr.querySelectorAll('td, th')).slice(1, 5)
          .map((c) => ({ innerText: c.innerText, textContent: c.textContent })) : []
      };
    }, idx);
    console.log('\n--- the located table, as the DOM actually has it ---');
    console.log(`  display=${raw.display} visibility=${raw.visibility} rendered=${raw.rendered}`);
    console.log(`  THEAD: ${raw.theadHtml}`);
    console.log(`  FIRST ROW: ${raw.rowHtml}`);
    console.log(`  label cell  innerText=${JSON.stringify(raw.labelInnerText)}`);
    console.log(`  label cell textContent=${JSON.stringify(raw.labelTextContent)}`);
    console.log(`  value cells: ${JSON.stringify(raw.valueCells)}`);

    // --- 4. what each parser makes of it ------------------------------------
    const matrix = await insightsMatrix(page, idx);
    console.log('\n--- insightsMatrix() ---');
    console.log('  ' + JSON.stringify(matrix, null, 1).slice(0, 1800));

    let viaMatrix = null, matrixErr = null;
    try { viaMatrix = parseInsightsMatrix(matrix); } catch (e) { matrixErr = String(e && e.message || e); }
    console.log(`\n--- parseInsightsMatrix() ${matrixErr ? 'THREW: ' + matrixErr : ''} ---`);
    console.log('  ' + JSON.stringify(viaMatrix, null, 1).slice(0, 1400));
    if (viaMatrix) console.log(`  view from periods: ${viewFromPeriods(viaMatrix.periods)}`);

    const html = await page.evaluate((i) => {
      const t = document.querySelectorAll('table')[i];
      return t ? t.outerHTML : null;
    }, idx);
    let viaHtml = null;
    try { viaHtml = parseInsightsTable(html); } catch (e) { viaHtml = { error: String(e && e.message || e) }; }
    console.log('\n--- parseInsightsTable() on the same table (the fallback) ---');
    console.log('  ' + JSON.stringify(viaHtml, null, 1).slice(0, 1000));

    console.log(`\n--- screener.in requests seen during this probe (${xhr.length}) ---`);
    [...new Set(xhr)].slice(0, 25).forEach((u) => console.log('  ' + u));
  } catch (e) {
    console.log(`  probe failed: ${(e && e.message) || e}`);
  } finally {
    await page.close().catch(() => {});
  }
}

function reportCompany(co, fin, man, ins) {
  const q = fin.tables?.quarters;
  const qLine = q ? `${q.periods[0]}..${q.periods[q.periods.length - 1]} (${q.periods.length} quarters)` : 'no quarterly table';
  const sampleRows = q ? ['Sales', 'OPM %', 'Net Profit'].filter((r) => q.rows[r]).map((r) => {
    const v = q.rows[r]; return `${r}=${v[v.length - 1]}`;
  }).join(', ') : '';
  console.log(`  ${co.name} [${fin.slug}] · ${fin.view}`);
  console.log(`     financials: ${fin.sectionsFound.join(', ') || 'none'} | quarters ${qLine}${sampleRows ? ' | latest ' + sampleRows : ''}`);
  console.log(`     pros/cons: ${fin.analysis.pros.length} pros, ${fin.analysis.cons.length} cons`);
  if (ins) {
    const filled = ins.rows.reduce((n, r) => n + r.values.filter((v) => v != null).length, 0);
    const cells = ins.rows.length * ins.periods.length;
    console.log(`     INSIGHTS (${ins.view}${ins.via ? ' via ' + ins.via : ''}): ` +
      `${ins.rows.length} rows x ${ins.periods.length} periods, ${filled}/${cells} values` +
      (ins.toggled ? ` | toggled ${ins.toggled}` : ' | NO toggle clicked') +
      (ins.note ? ` - ${ins.note}` : ''));
    // A yearly table is usable but it is NOT the quarterly trend the client asked
    // for, so say so rather than let it pass as one.
    if (ins.view === 'yearly') console.log('        ^ ANNUAL columns, not quarterly');
    ins.rows.slice(0, 5).forEach(function (r) {
      console.log(`        ${r.label} [${r.unit || '?'}]: ` +
        r.values.map(function (v) { return v == null ? '.' : v; }).join(' | '));
    });
  }
  const tag = (x) => `${x.periodIso || x.period}:${x.status}/${x.chars}c${x.via && x.via !== 'browser' ? `(${x.via})` : ''}`;
  var sums = man.summaries || [];
  console.log(`     AI summaries (primary): ${sums.filter(function (x) { return x.status === 'ok'; }).length} ok of ${man.summariesAvailable} available` +
    (sums.length ? ' -> ' + sums.map(tag).join(', ') : ''));
  console.log(`     ppt (primary): ${man.ppt ? tag(man.ppt) : 'none'}`);
  const t = man.transcripts || [];
  console.log(`     transcripts (primary text): ${t.length} cached of ${man.transcriptsFound} found` +
    (t.length ? ' -> ' + t.map(tag).join(', ') : ''));
}

function freshFinancials() {
  return {
    schemaVersion: 1,
    title: 'Company financials (raw context from Screener)',
    generatedBy: 'pipeline/scrape-screener.mjs',
    generatedAt: null,
    source: 'Screener.in (consolidated where available)',
    sourceTag: 'external',
    tag: '[External]',
    note: 'Raw financial statements scraped from Screener for context, plus Screener\'s auto ' +
          'Pros/Cons capsule per company under `analysis`. These are NOT the client KPIs - ' +
          'prompt 7\'s extractor derives those. Blank cells are null, never 0. Series run ' +
          'oldest -> newest, left as Screener labels them.',
    companies: {}
  };
}

function freshInsights() {
  return {
    schemaVersion: 1,
    title: 'Screener Premium Investors -> Insights, per company',
    generatedBy: 'pipeline/scrape-screener.mjs',
    generatedAt: null,
    note: 'Structured operational rows lifted straight from Screener\'s Insights grid - already ' +
          'per-period, so no model is involved and nothing is estimated. `view` says whether the ' +
          'quarterly or yearly toggle was captured; some rows (reserves, RRR) are only ever ' +
          'published annually. A blank period is null, never 0. Units come from the row label.',
    companies: {}
  };
}

function freshManifest() {
  return {
    schemaVersion: 2,
    title: 'Concall summary, PPT & transcript manifest',
    generatedBy: 'pipeline/scrape-screener.mjs',
    generatedAt: null,
    cacheDir: 'pipeline/cache/docs',
    sourcePriority: [
      'financials.json analysis (Screener Pros/Cons - the cheapest summary)',
      'summary (Screener\'s per-quarter "AI Summary" - dense, one document per quarter)',
      'ppt (investor presentation)',
      'transcript (full concall - fallback when the summary is missing or gated)'
    ],
    note: 'Per company: Screener\'s Pros/Cons capsule (in financials.json), its per-quarter ' +
          '"AI Summary" of each concall, the latest investor PPT, and the full transcripts. ' +
          'status ok = text extracted; gated = the summary endpoint returned the Premium paywall ' +
          'notice, which is never cached as content; ocr_needed = a scanned PDF with no text ' +
          'layer; shell = the app frame rather than the fragment; not_pdf/http_* = the link did ' +
          'not return a usable document. via names who fetched it. The extracted text is cached ' +
          'under cacheDir, which is gitignored.',
    companies: {}
  };
}

// Only run when invoked directly - importing this module (e.g. for looksLikeDoc
// in the tests) must not kick off a scrape.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error('scrape-screener failed outright:', e?.humanReason || e?.stack || e);
    process.exit(1);
  });
}
