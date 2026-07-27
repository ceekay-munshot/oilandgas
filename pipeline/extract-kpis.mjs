#!/usr/bin/env node
/**
 * Client pipeline, step 3: turn the cached decks/transcripts into per-company
 * KPI numbers -> data/kpis.json.
 *
 * Reads the documents scrape-screener cached in the SAME workflow run (the cache
 * is gitignored, so this must follow the screener step in one job), pre-filters
 * each company's text to just the passages near its KPI keywords, and asks the
 * model - once per company - for the four-quarter value of each KPI with a unit
 * and a source tag. Trajectory flags are computed in code, never by the model.
 *
 *   node pipeline/extract-kpis.mjs [--scope smoke|all] [--only a,b] [--provider openai|mistral] [--dry-run] [--refresh]
 *
 * Honesty: a KPI/quarter the excerpts do not state comes back null with a note.
 * A company whose model call fails is written all-null with the error noted, and
 * the run continues - never a guessed number, never a red build for one company.
 *
 * ACCUMULATES. Extracted values are kept in data/kpi-store.json across runs, so a
 * run only asks the model about cells it does not already have and a null can
 * never overwrite a number. In the steady state - no new concall - a run makes
 * zero calls and spends nothing. --refresh re-asks everything (use after a prompt
 * or parser fix that should change existing answers).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadEnv } from './lib/env.mjs';
import { callLLM, availableProviders, resolvedModel } from './lib/llm.mjs';
import { reportedQuarter, quarterIndex, quarterLabel } from './lib/fiscal.mjs';
import { insightsToText } from './parsers/screener-insights.mjs';
import {
  preFilter, financialsToText, buildMessages, normalizeResult, coverageOf, KPI_SCHEMA,
  PROMPT_VERSION
} from './parsers/kpi-prompt.mjs';
import { flagFor } from './lib/kpi-flag.mjs';
import {
  freshStore, fingerprintFor, docsSignature, planCompany, mergeIntoStore,
  renderWindow, storeTotals, seedFromWindow, cellsOf
} from './lib/kpi-store.mjs';
import { fillFromInsights, fillTotals } from './lib/insights-fill.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE = ['deep-industries', 'petronet-lng', 'igl', 'engineers-india'];
/* Context budget, reserved per source rather than pooled. Pooling let the
   newest quarter's transcript eat everything and left the other three
   quarters unrepresented - see buildBlocks. */
const PER_QUARTER_CHARS = 6000;   // x4 quarters
const PPT_CHARS = 6000;
const FIN_CHARS = 4000;
const INSIGHTS_CHARS = 5000;

function parseArgs(argv) {
  const args = argv.slice(2);
  const get = (f) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : undefined; };
  return {
    scope: get('--scope') || 'all',
    only: (get('--only') || '').split(',').map((s) => s.trim()).filter(Boolean),
    provider: get('--provider'),
    dryRun: args.includes('--dry-run'),
    // Re-ask cells the store already answered. Only for after a fix that should
    // change existing answers - it spends the key on work already paid for.
    refresh: args.includes('--refresh')
  };
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}
async function readText(path) {
  try { const t = await readFile(path, 'utf8'); return t && t.trim() ? t : null; } catch { return null; }
}
async function writeJson(path, obj) { await writeFile(path, JSON.stringify(obj, null, 2) + '\n'); }

/**
 * Every cached per-quarter document for one company, newest quarter first, with
 * the AI Summary preferred over the transcript for the same quarter.
 *
 * The summary is Screener's own digest of that call - a few thousand characters
 * of exactly the operational numbers these KPIs want - so when both exist the
 * summary leads and the transcript follows as corroboration. Each is tagged with
 * the fiscal quarter it REPORTS (not its publication month), which is what tells
 * the model which slot a number belongs in.
 *
 * @returns {Map<string, {quarter:string, docs:{label:string,text:string}[]}>}
 *          keyed by quarter label, insertion-ordered newest first
 */
async function gatherByQuarter(man) {
  const perQuarter = new Map();
  const add = (q, doc) => {
    if (!perQuarter.has(q)) perQuarter.set(q, { quarter: q, docs: [] });
    perQuarter.get(q).docs.push(doc);
  };

  // Summaries first so they lead within each quarter.
  for (const kind of ['summaries', 'transcripts']) {
    for (const d of (man && man[kind]) || []) {
      if (d.status !== 'ok' || !d.cache) continue;
      const q = reportedQuarter(d.periodIso);
      if (!q) continue;
      const text = await readText(resolve(ROOT, d.cache));
      if (!text) continue;
      add(q, {
        label: kind === 'summaries'
          ? `CONCALL AI SUMMARY - reports ${q}`
          : `CONCALL TRANSCRIPT [management call] - reports ${q}`,
        text
      });
    }
  }

  // Newest quarter first.
  return new Map([...perQuarter.entries()].sort((a, b) => (qKey(b[0]) - qKey(a[0]))));
}

/** 'Q3 FY26' -> a sortable integer (FY*10 + quarter). */
function qKey(label) {
  const m = String(label).match(/^Q(\d)\s*FY(\d{2})$/);
  return m ? Number(m[2]) * 10 + Number(m[1]) : -1;
}

/**
 * The window this company is actually reported on: the four most recent quarters
 * that yielded text, oldest first. Rolling by construction - when a new concall
 * lands on Screener the newest quarter enters and the oldest drops out, with no
 * hardcoded quarter list to maintain.
 */
function windowFor(perQuarter, fallback) {
  const have = [...perQuarter.keys()].slice(0, 4);
  if (!have.length) return (fallback || []).slice(-4);
  return have.slice().sort((a, b) => qKey(a) - qKey(b));   // oldest -> newest
}

/**
 * Blocks for the model, with a budget RESERVED PER QUARTER.
 *
 * The first version pooled one budget across every document and spent it in
 * order, which starved the trend it was supposed to build: the newest quarter's
 * transcript alone filled all 24,000 characters, the other three quarters never
 * reached the model at all, and every KPI came back with exactly one value and no
 * flag. Coverage looked like an extraction problem and was really an allocation
 * one.
 *
 * So each quarter now gets its own slice, and the PPT and financials get theirs.
 * A quarter with little text does not hand its leftover to a greedier neighbour -
 * four thin quarters beat one exhaustive one, because three points is what a
 * trajectory needs and one is worth nothing.
 */
async function buildBlocks(perQuarter, quarters, man, fin, keywords, ins) {
  const blocks = [];
  let sourceCount = 0;

  /* Insights first, and never keyword-filtered. It is Screener's own structured
     grid - one row per operational KPI, one column per period, units printed -
     so it is both the most reliable thing in the context and small enough to pass
     whole. For the KPIs it covers the model is just reading a table. */
  const insText = insightsToText(ins, quarterLabel);
  if (insText) {
    sourceCount++;
    blocks.push({
      label: 'SCREENER INSIGHTS [company filing] - structured operational metrics, ' +
             'one row per metric, each column labelled with the quarter it closes. ' +
             'PREFER THIS over anything said on a call when both give the same metric.',
      text: insText.slice(0, INSIGHTS_CHARS)
    });
  }

  for (const q of [...quarters].reverse()) {            // newest first
    const bucket = perQuarter.get(q);
    if (!bucket || !bucket.docs.length) continue;
    sourceCount += bucket.docs.length;
    // Summaries lead inside the bucket, so a compact summary is what survives the
    // slice and a 45,000-character transcript is only drawn on for the remainder.
    blocks.push(...preFilter(bucket.docs, keywords, { maxChars: PER_QUARTER_CHARS }));
  }

  if (man && man.ppt && man.ppt.status === 'ok' && man.ppt.cache) {
    const t = await readText(resolve(ROOT, man.ppt.cache));
    if (t) {
      const q = reportedQuarter(man.ppt.periodIso);
      sourceCount++;
      blocks.push(...preFilter([{
        label: `INVESTOR PPT [company filing] - published ${man.ppt.periodIso || '?'}` +
               (q ? `, reports ${q}` : '') + '; may contain a multi-quarter trend table',
        text: t
      }], keywords, { maxChars: PPT_CHARS }));
    }
  }

  const finText = financialsToText(fin);
  if (finText) {
    sourceCount++;
    // Not keyword-filtered: it is already a compact table and every row is
    // labelled with the quarter it closes, which is the whole point of including it.
    blocks.push({
      label: 'SCREENER FINANCIALS [company filing] - quarterly table, each column labelled with the quarter it closes',
      text: finText.slice(0, FIN_CHARS)
    });
  }

  return { blocks, sourceCount };
}

/** The latest quarter label that has any value, for an "as of" stamp. */
function asOfFrom(kpiObjects, quarters) {
  for (let i = quarters.length - 1; i >= 0; i--) {
    if (kpiObjects.some((k) => k.values[i] != null)) return quarters[i];
  }
  return null;
}

async function main() {
  const opts = parseArgs(process.argv);
  loadEnv();

  const spec = await readJson(resolve(ROOT, 'data/kpi-spec.json'), null);
  if (!spec) throw new Error('data/kpi-spec.json not found');
  const financials = await readJson(resolve(ROOT, 'data/financials.json'), { companies: {} });
  const manifest = await readJson(resolve(ROOT, 'data/docs-manifest.json'), { companies: {} });
  const insightsDoc = await readJson(resolve(ROOT, 'data/insights.json'), { companies: {} });
  const companiesDoc = await readJson(resolve(ROOT, 'data/companies.json'), null);

  const nameById = {};
  for (const g of (companiesDoc && companiesDoc.groups) || []) {
    for (const c of g.companies) nameById[c.id] = c.name;
  }

  // spec.quarters is only a fallback now: each company's real window is derived
  // from the quarters its own cached documents report.
  const fallbackQuarters = spec.quarters || [];
  const flatBandPct = spec.flatBandPct ?? 1.5;

  let ids = Object.keys(spec.companies);
  if (opts.only.length) ids = ids.filter((id) => opts.only.includes(id));
  else if (opts.scope === 'smoke') ids = ids.filter((id) => SMOKE.includes(id));

  const providers = opts.provider ? [opts.provider] : availableProviders();
  console.log(`extract-kpis: ${opts.scope}${opts.only.length ? ' (--only)' : ''} -> ${ids.length} companies`);
  console.log(`providers available: ${providers.map((p) => `${p} (${resolvedModel(p)})`).join(', ') || 'NONE'}`);
  if (!opts.dryRun && !providers.length) {
    throw new Error('no LLM provider key set (OPENAI_API_KEY or MISTRAL_API_KEY)');
  }
  console.log('');

  // Merge into any previous kpis.json so a partial run is not lost.
  const out = {
    ...freshDoc(fallbackQuarters, flatBandPct),
    companies: (await readJson(resolve(ROOT, 'data/kpis.json'), {})).companies || {}
  };

  // The durable store: every value ever extracted, for every quarter ever seen.
  const storePath = resolve(ROOT, 'data/kpi-store.json');
  const store = { ...freshStore(), companies: (await readJson(storePath, {})).companies || {} };

  /* Adopt what earlier runs already extracted. Those numbers were paid for before
     the store existed; without this, the first run under the new scheme would buy
     every one of them a second time. Only companies with nothing in the store are
     seeded, so this quietly stops mattering after the first run. */
  let seeded = 0;
  for (const [id, prev] of Object.entries(out.companies)) {
    if (Object.keys(cellsOf(store, id)).length) continue;
    seeded += seedFromWindow({
      store, companyId: id, kpiObjects: prev.kpis, quarters: prev.quarters,
      at: new Date().toISOString()
    });
  }
  if (seeded) console.log(`seeded ${seeded} previously extracted cells from data/kpis.json\n`);

  let usedProvider = null;
  let calls = 0, skippedCalls = 0, totalGained = 0, totalKept = 0;
  let insFilledCells = 0, insCorrected = 0;
  for (const id of ids) {
    const kpis = spec.companies[id];
    const name = nameById[id] || id;
    const fin = financials.companies && financials.companies[id];
    const man = manifest.companies && manifest.companies[id];
    const slug = (fin && fin.slug) || (man && man.slug) || null;
    // The previous entry, before this run overwrites it: a company that needs no
    // call keeps the provenance of the run that actually produced its numbers,
    // rather than reporting provider null because nothing was asked today.
    const prior = out.companies[id] || null;
    let called = false;

    process.stdout.write(`  ${id.padEnd(20)} `);
    const perQuarter = await gatherByQuarter(man);
    const quarters = windowFor(perQuarter, fallbackQuarters);
    const { blocks, sourceCount } = await buildBlocks(
      perQuarter, quarters, man, fin, kpis.flatMap((k) => k.keywords),
      insightsDoc.companies && insightsDoc.companies[id]);
    const ctxChars = blocks.reduce((n, b) => n + b.text.length, 0);

    /* What is actually worth asking about. The fingerprint covers the documents
       in this window, this company's KPI spec and the prompt version, so an
       unchanged run asks nothing and a new concall (or a prompt fix) re-opens
       exactly the cells whose answer could now differ. */
    const fingerprint = fingerprintFor({
      promptVersion: PROMPT_VERSION, docs: docsSignature(blocks), kpiSpec: kpis
    });

    /* Deterministic first. Screener's Insights table already holds most of what
       the client asked for, quarterly and cited to a document and page, so those
       cells are transcribed rather than re-derived - and they outrank anything
       the model inferred, which is what corrects a value read off the wrong
       terminal or the wrong segment. Whatever this fills, the model is not asked
       about, so it is also the cheapest coverage available. */
    const insCo = insightsDoc.companies && insightsDoc.companies[id];
    const filled = opts.dryRun ? [] : fillFromInsights({ insights: insCo, kpis, quarters, quarterLabel });
    let insMerged = { gained: 0, corrected: 0 };
    if (filled.length) {
      insMerged = mergeIntoStore({
        store, companyId: id, kpiObjects: filled, quarters, fingerprint,
        origin: 'insights', at: new Date().toISOString()
      });
      const t = fillTotals(filled);
      insFilledCells += insMerged.gained; insCorrected += insMerged.corrected;
      process.stdout.write(`insights ${t.cells} cells/${t.kpis} KPIs` +
        (insMerged.corrected ? ` (${insMerged.corrected} corrected)` : '') + ' · ');
    }

    const plan = opts.refresh
      ? { ask: kpis, skip: [], settledCells: 0, openCells: kpis.length * quarters.length }
      : planCompany({ store, companyId: id, kpis, quarters, fingerprint });

    if (opts.dryRun) {
      console.log(`window ${quarters.join(' ')} · ${sourceCount} sources · ${ctxChars} chars · ` +
        `ask ${plan.ask.length}/${kpis.length} KPIs (${plan.openCells} open cells) (dry-run)`);
      continue;
    }

    let note = null, merged = { gained: 0, kept: 0 };
    if (!plan.ask.length) {
      // Everything already answered against these inputs: no call, no spend.
      skippedCalls++;
      console.log(`complete · ${quarters.join(' ')} · ${plan.settledCells} cells held, no call made`);
    } else if (!blocks.length) {
      // No cached text at all - honest all-null, still no wasted call.
      note = 'no cached documents to read';
      merged = mergeIntoStore({
        store, companyId: id, quarters, fingerprint, model: null, at: new Date().toISOString(),
        kpiObjects: normalizeResult({ kpis: [] }, plan.ask, quarters, { flatBandPct })
      });
      console.log(`0 gained · ${note}`);
    } else {
      // Ask about the incomplete KPIs only. A company with one open KPI sends one
      // KPI, which is cheaper AND a narrower question than asking for all of them.
      const { system, user } = buildMessages({ companyName: name, kpis: plan.ask, quarters, blocks });
      let raw = null, err = null;
      for (const provider of providers) {
        try {
          raw = await callLLM({ provider, system, user, schema: KPI_SCHEMA, schemaName: 'kpis', maxTokens: 3000 });
          usedProvider = provider;
          break;
        } catch (e) { err = e; }
      }
      calls++; called = true;
      const at = new Date().toISOString();
      if (raw) {
        merged = mergeIntoStore({
          store, companyId: id, quarters, fingerprint,
          model: usedProvider ? resolvedModel(usedProvider) : null, at,
          kpiObjects: normalizeResult(raw, plan.ask, quarters, { flatBandPct })
        });
      } else {
        // A failed call records nothing: the cells stay open for the next run
        // rather than being written off as unavailable.
        note = `extraction failed: ${(err && err.message ? err.message : String(err)).slice(0, 140)}`;
      }
      console.log(`asked ${plan.ask.length}/${kpis.length} KPIs · +${merged.gained} new` +
        (plan.settledCells ? ` · ${plan.settledCells} held` : '') +
        (note ? ' · ' + note : ''));
    }
    totalGained += merged.gained; totalKept += plan.settledCells;

    // The window view the dashboard reads, rendered from the store - so it shows
    // everything we have ever learned, not only what this run happened to return.
    const kpiObjects = renderWindow({ store, companyId: id, kpis, quarters, flagFor, flatBandPct });
    const cov = coverageOf(kpiObjects);
    out.companies[id] = {
      name, slug, quarters, asOf: asOfFrom(kpiObjects, quarters),
      provider: called && usedProvider ? usedProvider : (prior && prior.provider) || null,
      model: called && usedProvider ? resolvedModel(usedProvider) : (prior && prior.model) || null,
      ctxChars,
      ...(note ? { note } : {}),
      kpis: kpiObjects
    };
    store.generatedAt = new Date().toISOString();
    await writeJson(storePath, store);
    await writeJson(resolve(ROOT, 'data/kpis.json'), withCoverage(out));

    console.log(`      -> ${cov.real}/${cov.cells} cells now filled`);
    for (const k of kpiObjects) {
      const shown = k.values.map((v) => (v == null ? '·' : v)).join(', ');
      console.log(`      ${k.label.padEnd(28)} [${shown}] ${k.unit || ''} ${k.flag ? '· ' + k.flag : ''}`);
    }
  }

  const doc = withCoverage(out);
  if (!opts.dryRun) await writeJson(resolve(ROOT, 'data/kpis.json'), doc);
  console.log(
    `\ndone: ${doc.coverage.realCells}/${doc.coverage.kpiCells} cells filled across ` +
    `${doc.coverage.companies} companies (${doc.coverage.nullCells} null).`
  );
  if (!opts.dryRun) {
    const t = storeTotals(store);
    console.log(
      `store: ${t.real}/${t.cells} cells held across ${t.companies} companies and ` +
      `every quarter seen so far -> data/kpi-store.json`
    );
    console.log(
      `insights: ${insFilledCells} cells filled deterministically from Screener's table` +
      (insCorrected ? `, ${insCorrected} model values corrected` : '') + '.'
    );
    console.log(
      `spend: ${calls} model call${calls === 1 ? '' : 's'} made, ${skippedCalls} skipped ` +
      `(already complete), +${totalGained} new cell${totalGained === 1 ? '' : 's'} this run, ` +
      `${totalKept} carried over.`
    );
    if (!calls && !skippedCalls) console.log('       (nothing selected)');
    else if (!calls) console.log('       nothing new to extract - this run cost nothing.');
  }
  if (opts.scope !== 'all' && !opts.only.length) {
    console.log('smoke run only. Scale up with: node pipeline/extract-kpis.mjs --scope all');
  }
}

function freshDoc(quarters, flatBandPct) {
  return {
    schemaVersion: 2,
    title: 'Per-company KPIs, extracted from Screener documents',
    generatedBy: 'pipeline/extract-kpis.mjs',
    generatedAt: new Date().toISOString(),
    quarters,
    flatBandPct,
    note: 'Each KPI value is taken straight from a company filing/PPT or a management statement on ' +
          'the concall - never estimated. A quarter the sources do not state is null. Trajectory ' +
          'flags are computed in code from the four values. sourceTags name where each value came ' +
          'from (framework.json). Each company carries its OWN `quarters` - the four most recent ' +
          'quarters its documents actually report, oldest first - so values[i] aligns to that ' +
          'company\'s quarters[i], not to the top-level list, which is only a display fallback. ' +
          'The window rolls forward on its own as new concalls appear on Screener.',
    coverage: { companies: 0, kpiCells: 0, realCells: 0, nullCells: 0 },
    companies: {}
  };
}

function withCoverage(doc) {
  let kpiCells = 0, realCells = 0, flagged = 0, totalKpis = 0;
  const list = Object.values(doc.companies);
  const windows = new Map();
  for (const c of list) {
    for (const k of c.kpis) {
      totalKpis++;
      if (k.flag) flagged++;
      for (const v of k.values) { kpiCells++; if (v != null) realCells++; }
    }
    if (Array.isArray(c.quarters) && c.quarters.length) {
      const key = c.quarters.join('|');
      windows.set(key, (windows.get(key) || 0) + 1);
    }
  }
  // The top-level window is whichever one the most companies are on - a display
  // fallback for the table header; each company's own list stays authoritative.
  let common = doc.quarters;
  let best = 0;
  for (const [key, n] of windows) if (n > best) { best = n; common = key.split('|'); }

  return {
    ...doc,
    quarters: common,
    generatedAt: doc.generatedAt || new Date().toISOString(),
    coverage: {
      companies: list.length, kpiCells, realCells, nullCells: kpiCells - realCells,
      kpis: totalKpis, kpisWithTrend: flagged
    }
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error('extract-kpis failed outright:', e?.stack || e);
    process.exit(1);
  });
}

export { asOfFrom, windowFor, qKey };
