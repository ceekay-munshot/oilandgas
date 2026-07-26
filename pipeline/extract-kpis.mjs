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
 *   node pipeline/extract-kpis.mjs [--scope smoke|all] [--only a,b] [--provider openai|mistral] [--dry-run]
 *
 * Honesty: a KPI/quarter the excerpts do not state comes back null with a note.
 * A company whose model call fails is written all-null with the error noted, and
 * the run continues - never a guessed number, never a red build for one company.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadEnv } from './lib/env.mjs';
import { callLLM, availableProviders } from './lib/llm.mjs';
import { reportedQuarter, quarterIndex } from './lib/fiscal.mjs';
import {
  preFilter, financialsToText, buildMessages, normalizeResult, coverageOf, KPI_SCHEMA
} from './parsers/kpi-prompt.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE = ['deep-industries', 'petronet-lng', 'igl', 'engineers-india'];
const MAX_CONTEXT = 24000;

function parseArgs(argv) {
  const args = argv.slice(2);
  const get = (f) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : undefined; };
  return {
    scope: get('--scope') || 'all',
    only: (get('--only') || '').split(',').map((s) => s.trim()).filter(Boolean),
    provider: get('--provider'),
    dryRun: args.includes('--dry-run')
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
 * Ordered source texts for one company: PPT, then transcripts, then financials.
 *
 * Every document is labelled with the fiscal quarter it REPORTS (not its own
 * publication month), because that label is what tells the model which slot a
 * number belongs in. A document reporting a quarter outside the target window is
 * dropped: its numbers are real but belong to no column here, and leaving them in
 * only invites them to be filed against the wrong quarter.
 */
async function gatherSources(man, fin, quarters) {
  const sources = [];
  const skipped = [];

  if (man && man.ppt && man.ppt.status === 'ok' && man.ppt.cache) {
    const t = await readText(resolve(ROOT, man.ppt.cache));
    if (t) {
      // A deck usually carries a multi-quarter trend table, so it is not pinned
      // to one slot - it is labelled with what it reports and left to the model.
      const q = reportedQuarter(man.ppt.periodIso);
      sources.push({
        label: `INVESTOR PPT [company filing] - published ${man.ppt.periodIso || '?'}` +
               (q ? `, reports ${q}` : '') + '; may contain a multi-quarter trend table',
        text: t
      });
    }
  }

  for (const tr of (man && man.transcripts) || []) {
    if (tr.status !== 'ok' || !tr.cache) continue;
    const q = reportedQuarter(tr.periodIso);
    if (!q || quarterIndex(q, quarters) === -1) {
      skipped.push(`${tr.periodIso}->${q || '?'}`);
      continue;
    }
    const t = await readText(resolve(ROOT, tr.cache));
    if (t) sources.push({ label: `CONCALL TRANSCRIPT [management call] - reports ${q}`, text: t });
  }

  const finText = financialsToText(fin);
  if (finText) {
    sources.push({
      label: 'SCREENER FINANCIALS [company filing] - quarterly table, columns are labelled with their quarter-end month',
      text: finText
    });
  }
  return { sources, skipped };
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
  const companiesDoc = await readJson(resolve(ROOT, 'data/companies.json'), null);

  const nameById = {};
  for (const g of (companiesDoc && companiesDoc.groups) || []) {
    for (const c of g.companies) nameById[c.id] = c.name;
  }

  const quarters = spec.quarters;
  const flatBandPct = spec.flatBandPct ?? 1.5;

  let ids = Object.keys(spec.companies);
  if (opts.only.length) ids = ids.filter((id) => opts.only.includes(id));
  else if (opts.scope === 'smoke') ids = ids.filter((id) => SMOKE.includes(id));

  const providers = opts.provider ? [opts.provider] : availableProviders();
  console.log(`extract-kpis: ${opts.scope}${opts.only.length ? ' (--only)' : ''} -> ${ids.length} companies`);
  console.log(`providers available: ${providers.join(', ') || 'NONE'}`);
  if (!opts.dryRun && !providers.length) {
    throw new Error('no LLM provider key set (OPENAI_API_KEY or MISTRAL_API_KEY)');
  }
  console.log('');

  // Merge into any previous kpis.json so a partial run is not lost.
  const out = {
    ...freshDoc(quarters, flatBandPct),
    companies: (await readJson(resolve(ROOT, 'data/kpis.json'), {})).companies || {}
  };

  let usedProvider = null;
  for (const id of ids) {
    const kpis = spec.companies[id];
    const name = nameById[id] || id;
    const fin = financials.companies && financials.companies[id];
    const man = manifest.companies && manifest.companies[id];
    const slug = (fin && fin.slug) || (man && man.slug) || null;

    process.stdout.write(`  ${id.padEnd(20)} `);
    const { sources, skipped } = await gatherSources(man, fin, quarters);
    const blocks = preFilter(sources, kpis.flatMap((k) => k.keywords), { maxChars: MAX_CONTEXT });
    const ctxChars = blocks.reduce((n, b) => n + b.text.length, 0);

    if (opts.dryRun) {
      console.log(`sources: ${sources.length} · filtered ${ctxChars} chars · KPIs ${kpis.length} (dry-run, no call)`);
      if (skipped.length) console.log(`      outside the window: ${skipped.join(', ')}`);
      continue;
    }

    let kpiObjects, note = null;
    if (!blocks.length) {
      // No cached text at all - honest all-null, no wasted call.
      kpiObjects = normalizeResult({ kpis: [] }, kpis, quarters, { flatBandPct });
      note = 'no cached documents to read';
    } else {
      const { system, user } = buildMessages({ companyName: name, kpis, quarters, blocks });
      let raw = null, err = null;
      for (const provider of providers) {
        try {
          raw = await callLLM({ provider, system, user, schema: KPI_SCHEMA, schemaName: 'kpis', maxTokens: 3000 });
          usedProvider = provider;
          break;
        } catch (e) { err = e; }
      }
      if (raw) {
        kpiObjects = normalizeResult(raw, kpis, quarters, { flatBandPct });
      } else {
        kpiObjects = normalizeResult({ kpis: [] }, kpis, quarters, { flatBandPct });
        note = `extraction failed: ${(err && err.message ? err.message : String(err)).slice(0, 140)}`;
      }
    }

    const cov = coverageOf(kpiObjects);
    out.companies[id] = {
      name, slug, asOf: asOfFrom(kpiObjects, quarters),
      provider: usedProvider, ctxChars,
      ...(note ? { note } : {}),
      kpis: kpiObjects
    };
    await writeJson(resolve(ROOT, 'data/kpis.json'), withCoverage(out));

    console.log(`${cov.real}/${cov.cells} cells${note ? ' · ' + note : ''}`);
    // A couple of example values for the log.
    for (const k of kpiObjects) {
      const shown = k.values.map((v, i) => (v == null ? '·' : v)).join(', ');
      console.log(`      ${k.label.padEnd(28)} [${shown}] ${k.unit || ''} ${k.flag ? '· ' + k.flag : ''}`);
    }
  }

  const doc = withCoverage(out);
  if (!opts.dryRun) await writeJson(resolve(ROOT, 'data/kpis.json'), doc);
  console.log(
    `\ndone: ${doc.coverage.realCells}/${doc.coverage.kpiCells} cells filled across ` +
    `${doc.coverage.companies} companies (${doc.coverage.nullCells} null).`
  );
  if (opts.scope !== 'all' && !opts.only.length) {
    console.log('smoke run only. Scale up with: node pipeline/extract-kpis.mjs --scope all');
  }
}

function freshDoc(quarters, flatBandPct) {
  return {
    schemaVersion: 1,
    title: 'Per-company KPIs, extracted from Screener documents',
    generatedBy: 'pipeline/extract-kpis.mjs',
    generatedAt: new Date().toISOString(),
    quarters,
    flatBandPct,
    note: 'Each KPI value is taken straight from a company filing/PPT or a management statement on ' +
          'the concall - never estimated. A quarter the sources do not state is null. Trajectory ' +
          'flags are computed in code from the four values on the KPI\'s flagBasis. sourceTags name ' +
          'where each value came from (framework.json).',
    coverage: { companies: 0, kpiCells: 0, realCells: 0, nullCells: 0 },
    companies: {}
  };
}

function withCoverage(doc) {
  let kpiCells = 0, realCells = 0;
  const list = Object.values(doc.companies);
  for (const c of list) {
    for (const k of c.kpis) for (const v of k.values) { kpiCells++; if (v != null) realCells++; }
  }
  return {
    ...doc,
    generatedAt: doc.generatedAt || new Date().toISOString(),
    coverage: { companies: list.length, kpiCells, realCells, nullCells: kpiCells - realCells }
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error('extract-kpis failed outright:', e?.stack || e);
    process.exit(1);
  });
}

export { asOfFrom, gatherSources };
