#!/usr/bin/env node
/**
 * Client pipeline, step 4: read the cached concalls and classify how each
 * company's management SOUNDED, quarter by quarter -> data/commentary.json, which
 * the Commentary tab draws as a tone heat strip.
 *
 *   node pipeline/extract-commentary.mjs [--scope smoke|all] [--only a,b] [--provider openai|mistral] [--dry-run] [--refresh]
 *
 * Reads the same per-quarter documents scrape-screener cached in this run (the
 * cache is gitignored, so this must follow the screener step in one job), takes
 * each quarter's own concall - the AI summary when there is one, else the
 * transcript - and asks the model, once per company, for the tone of each quarter
 * on the five-step scale in data/framework.json, with the quote it rests on.
 *
 * Honesty (mirrors extract-kpis): a quarter with no cached concall comes back null,
 * never a guessed tone. A company whose call fails is left as it was and the run
 * continues. ACCUMULATES: tones live in data/commentary-store.json across runs, so
 * a run only classifies quarters it does not already have, a null never overwrites
 * a real tone, and a steady-state run (no new concall) makes zero calls and spends
 * nothing. --refresh re-asks everything (use after a prompt fix).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadEnv } from './lib/env.mjs';
import { callLLM, availableProviders, resolvedModel } from './lib/llm.mjs';
import { reportedQuarter } from './lib/fiscal.mjs';
import {
  buildMessages, normalizeResult, coverageOf, TONE_SCHEMA, COMMENTARY_PROMPT_VERSION
} from './parsers/commentary-prompt.mjs';
import {
  freshStore, fingerprintFor, docsSignature, planQuarters, mergeIntoStore,
  renderTimeline, storeTotals, cellsOf
} from './lib/commentary-store.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE = ['deep-industries', 'petronet-lng', 'igl', 'engineers-india'];
/* Per-quarter text budget. The AI summary (~7k chars of digest) is the cleanest
   tone signal, so it leads; a transcript only fills the remainder. Four quarters
   at this cap is one modest call. */
const TONE_CHARS = 4500;

function parseArgs(argv) {
  const args = argv.slice(2);
  const get = (f) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : undefined; };
  return {
    scope: get('--scope') || 'all',
    only: (get('--only') || '').split(',').map((s) => s.trim()).filter(Boolean),
    provider: get('--provider'),
    dryRun: args.includes('--dry-run'),
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

/** 'Q3 FY26' -> a sortable integer (FY*10 + quarter). */
function qKey(label) {
  const m = String(label).match(/^Q(\d)\s*FY(\d{2})$/);
  return m ? Number(m[2]) * 10 + Number(m[1]) : -1;
}

/**
 * One capped text block per quarter, newest quarter first, the AI summary leading
 * and the transcript filling the remainder of the budget. Each block records the
 * document it is credited to (the summary when present) for provenance.
 * @returns {Map<string,{quarter:string,text:string,doc:string}>}
 */
async function gatherByQuarter(man) {
  const perQuarter = new Map();
  // Summaries first so they lead within each quarter and are the credited doc.
  for (const kind of ['summaries', 'transcripts']) {
    for (const d of (man && man[kind]) || []) {
      if (d.status !== 'ok' || !d.cache) continue;
      const q = reportedQuarter(d.periodIso);
      if (!q) continue;
      const text = await readText(resolve(ROOT, d.cache));
      if (!text) continue;
      const label = kind === 'summaries' ? `Concall AI summary (${q})` : `Concall transcript (${q})`;
      if (!perQuarter.has(q)) perQuarter.set(q, { quarter: q, parts: [], doc: label });
      perQuarter.get(q).parts.push(text);
    }
  }

  const out = new Map();
  for (const [q, b] of perQuarter) {
    let text = '';
    for (const part of b.parts) {
      if (text.length >= TONE_CHARS) break;
      text += (text ? '\n\n' : '') + part.slice(0, TONE_CHARS - text.length);
    }
    out.set(q, { quarter: q, text: text.trim(), doc: b.doc });
  }
  // Newest quarter first.
  return new Map([...out.entries()].sort((a, b) => qKey(b[0]) - qKey(a[0])));
}

/**
 * The window this company is reported on: the four most recent quarters that
 * yielded concall text, oldest first. Rolls forward on its own as calls appear.
 */
function windowFor(perQuarter, fallback) {
  const have = [...perQuarter.keys()].slice(0, 4);
  if (!have.length) return (fallback || []).slice(-4);
  return have.slice().sort((a, b) => qKey(a) - qKey(b));
}

/** The latest quarter that carries a tone, for an "as of" stamp. */
function asOfFrom(tones) {
  for (let i = tones.length - 1; i >= 0; i--) if (tones[i] && tones[i].toneId) return tones[i].quarter;
  return null;
}

async function main() {
  const opts = parseArgs(process.argv);
  loadEnv();

  const companiesDoc = await readJson(resolve(ROOT, 'data/companies.json'), null);
  if (!companiesDoc) throw new Error('data/companies.json not found');
  const manifest = await readJson(resolve(ROOT, 'data/docs-manifest.json'), { companies: {} });

  const fallbackQuarters = companiesDoc.quarterLabels || [];
  const roster = [];
  for (const g of companiesDoc.groups || []) {
    for (const c of g.companies) roster.push({ id: c.id, name: c.name, slug: c.screenerSlug || null });
  }

  let ids = roster.map((c) => c.id);
  if (opts.only.length) ids = ids.filter((id) => opts.only.includes(id));
  else if (opts.scope === 'smoke') ids = ids.filter((id) => SMOKE.includes(id));
  const nameById = Object.fromEntries(roster.map((c) => [c.id, c.name]));
  const slugById = Object.fromEntries(roster.map((c) => [c.id, c.slug]));

  const providers = opts.provider ? [opts.provider] : availableProviders();
  console.log(`extract-commentary: ${opts.scope}${opts.only.length ? ' (--only)' : ''} -> ${ids.length} companies`);
  console.log(`providers available: ${providers.map((p) => `${p} (${resolvedModel(p)})`).join(', ') || 'NONE'}`);
  if (!opts.dryRun && !providers.length) {
    throw new Error('no LLM provider key set (OPENAI_API_KEY or MISTRAL_API_KEY)');
  }
  console.log('');

  // Merge into any previous commentary.json so a partial run is not lost.
  const out = {
    ...freshDoc(),
    companies: (await readJson(resolve(ROOT, 'data/commentary.json'), {})).companies || {}
  };
  const storePath = resolve(ROOT, 'data/commentary-store.json');
  const store = { ...freshStore(), companies: (await readJson(storePath, {})).companies || {} };

  let usedProvider = null, usedModel = null;
  let calls = 0, skippedCalls = 0, totalGained = 0;
  for (const id of ids) {
    const name = nameById[id] || id;
    const man = manifest.companies && manifest.companies[id];
    const prior = out.companies[id] || null;
    let called = false;

    process.stdout.write(`  ${id.padEnd(20)} `);

    /* Part C: the scrape checked this company and found nothing newer, so it
       fetched no documents for it. Skip rather than read an empty cache: an
       empty document set changes the fingerprint, which would re-open settled
       quarters and ask the model about a call it cannot see. */
    if (man && man.unchanged) {
      console.log('unchanged since last run - no new concall, nothing asked');
      continue;
    }

    const perQuarter = await gatherByQuarter(man);
    const quarters = windowFor(perQuarter, fallbackQuarters);

    const blocks = quarters
      .map((q) => perQuarter.get(q))
      .filter(Boolean)
      .map((b) => ({ label: b.doc, text: b.text }));
    const fingerprint = fingerprintFor({
      promptVersion: COMMENTARY_PROMPT_VERSION, docs: docsSignature(blocks), kpiSpec: 'commentary-tone'
    });

    const plan = opts.refresh
      ? { ask: quarters.slice(), settled: 0 }
      : planQuarters({ store, companyId: id, quarters, fingerprint });

    if (opts.dryRun) {
      console.log(`window ${quarters.join(' ') || '(none)'} · ${blocks.length} quarters with text · ` +
        `ask ${plan.ask.length}/${quarters.length} (dry-run)`);
      continue;
    }

    const at = new Date().toISOString();
    const askWithText = plan.ask.filter((q) => (perQuarter.get(q) || {}).text);
    const askNoText = plan.ask.filter((q) => !(perQuarter.get(q) || {}).text);

    // Quarters with no cached concall are null by construction - recorded, never asked.
    if (askNoText.length) {
      mergeIntoStore({
        store, companyId: id, fingerprint, at,
        tones: askNoText.map((q) => ({
          quarter: q, toneId: null, score: null, quote: null,
          rationale: 'no concall document cached for this quarter'
        }))
      });
    }

    let note = null, merged = { gained: 0 };
    if (!plan.ask.length) {
      skippedCalls++;
      console.log(`complete · ${quarters.join(' ')} · ${plan.settled} tones held, no call made`);
    } else if (!askWithText.length) {
      note = 'no cached concall text in this window';
      console.log(`0 gained · ${note}`);
    } else {
      const quarterBlocks = askWithText.map((q) => ({ quarter: q, text: perQuarter.get(q).text }));
      const docByQuarter = Object.fromEntries(askWithText.map((q) => [q, perQuarter.get(q).doc]));
      const { system, user } = buildMessages({ companyName: name, quarterBlocks });
      let raw = null, err = null;
      for (const provider of providers) {
        try {
          raw = await callLLM({ provider, system, user, schema: TONE_SCHEMA, schemaName: 'commentary', maxTokens: 1500 });
          usedProvider = (raw && raw.__provider) || provider;
          usedModel = (raw && raw.__model) || null;
          break;
        } catch (e) { err = e; }
      }
      calls++; called = true;
      if (raw) {
        merged = mergeIntoStore({
          store, companyId: id, fingerprint, at, docByQuarter,
          model: usedModel || (usedProvider ? resolvedModel(usedProvider) : null),
          tones: normalizeResult(raw, askWithText),
          /* --refresh re-asks a settled quarter on purpose, so its answer has to
             be allowed to land. Without this the run pays for every call and
             then discards the result, and a prompt change can never take. */
          overwrite: opts.refresh
        });
      } else {
        // A failed call records nothing: the quarters stay open for the next run.
        note = `classification failed: ${(err && err.message ? err.message : String(err)).slice(0, 140)}`;
      }
      console.log(`asked ${askWithText.length} quarter${askWithText.length === 1 ? '' : 's'} · +${merged.gained} new` +
        (merged.replaced ? ` · ${merged.replaced} re-read` : '') +
        (plan.settled ? ` · ${plan.settled} held` : '') + (note ? ' · ' + note : ''));
    }
    totalGained += merged.gained;

    const tones = renderTimeline({ store, companyId: id, quarters });
    const cov = coverageOf(tones);
    out.companies[id] = {
      name, slug: slugById[id], quarters, asOf: asOfFrom(tones),
      provider: called && usedProvider ? usedProvider : (prior && prior.provider) || null,
      model: called && usedProvider ? (usedModel || resolvedModel(usedProvider)) : (prior && prior.model) || null,
      ...(note ? { note } : {}),
      tones
    };
    store.generatedAt = at;
    await writeJson(storePath, store);
    await writeJson(resolve(ROOT, 'data/commentary.json'), withCoverage(out));

    const strip = tones.map((t) => (t.toneId ? t.toneId[0].toUpperCase() : '·')).join('');
    console.log(`      ${cov.real}/${cov.cells} quarters toned  [${strip}]`);
  }

  const doc = withCoverage(out);
  if (!opts.dryRun) await writeJson(resolve(ROOT, 'data/commentary.json'), doc);
  console.log(
    `\ndone: ${doc.coverage.tonedQuarters}/${doc.coverage.quarterCells} quarters toned across ` +
    `${doc.coverage.companies} companies (${doc.coverage.nullQuarters} null).`
  );
  if (!opts.dryRun) {
    const t = storeTotals(store);
    console.log(`store: ${t.real}/${t.cells} tones held across ${t.companies} companies -> data/commentary-store.json`);
    console.log(
      `spend: ${calls} model call${calls === 1 ? '' : 's'} made, ${skippedCalls} skipped ` +
      `(already complete), +${totalGained} new tone${totalGained === 1 ? '' : 's'} this run.`
    );
    if (!calls && !skippedCalls) console.log('       (nothing selected)');
    else if (!calls) console.log('       nothing new to classify - this run cost nothing.');
  }
  if (opts.scope !== 'all' && !opts.only.length) {
    console.log('smoke run only. Scale up with: node pipeline/extract-commentary.mjs --scope all');
  }
}

function freshDoc() {
  return {
    schemaVersion: 1,
    title: 'Per-company management tone, classified from concall documents',
    generatedBy: 'pipeline/extract-commentary.mjs',
    generatedAt: new Date().toISOString(),
    note: 'Each quarter\'s tone is a reading of how management sounded on that ' +
          'quarter\'s earnings call - one of five steps in framework.json toneScale - ' +
          'grounded in a quote from the call, never a number the company reported and ' +
          'never a guess. A quarter with no cached concall is null. Each company carries ' +
          'its OWN `quarters` (the four most recent its concalls report, oldest first); ' +
          'tones[i] aligns to quarters[i].',
    toneScaleVersion: COMMENTARY_PROMPT_VERSION,
    coverage: { companies: 0, quarterCells: 0, tonedQuarters: 0, nullQuarters: 0 },
    companies: {}
  };
}

function withCoverage(doc) {
  let quarterCells = 0, tonedQuarters = 0;
  const list = Object.values(doc.companies);
  const windows = new Map();
  for (const c of list) {
    for (const t of c.tones || []) { quarterCells++; if (t && t.toneId) tonedQuarters++; }
    if (Array.isArray(c.quarters) && c.quarters.length) {
      const key = c.quarters.join('|');
      windows.set(key, (windows.get(key) || 0) + 1);
    }
  }
  // The display-fallback window is whichever the most companies share.
  let common = [];
  let best = 0;
  for (const [key, n] of windows) if (n > best) { best = n; common = key.split('|'); }

  return {
    ...doc,
    quarters: common,
    generatedAt: doc.generatedAt || new Date().toISOString(),
    coverage: {
      companies: list.length, quarterCells, tonedQuarters, nullQuarters: quarterCells - tonedQuarters
    }
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error('extract-commentary failed outright:', e?.stack || e);
    process.exit(1);
  });
}

export { asOfFrom, windowFor, qKey, gatherByQuarter, withCoverage };
