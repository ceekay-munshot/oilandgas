#!/usr/bin/env node
/**
 * Client pipeline, step 5: turn the KPI trajectories, the macro backdrop and the
 * commentary tones already in data/ into the cycle reading -> data/scores.json,
 * which the Cockpit, the macro consistency panel and the Insight tab all read.
 *
 *   node pipeline/rescore.mjs [--dry-run]
 *
 * This is the step that retires the hardcoded `SEED` object in index.html. It
 * makes no network call and no model call: every number it writes is arithmetic
 * over files the earlier steps produced, so the chain from a figure a company
 * reported to the stage on the dial is inspectable end to end.
 *
 * Honesty: a group with no flagged KPI scores null and the dial says so, rather
 * than defaulting to the middle of the cycle. The stage call names the rule row
 * that produced it. Nothing here carries a value forward from a previous run -
 * if the inputs cannot support a reading today, today has no reading.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildScores, snapshotOf } from './lib/cycle-score.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');

async function readJson(name, { optional = false } = {}) {
  try {
    return JSON.parse(await readFile(resolve(DATA, name), 'utf8'));
  } catch (err) {
    if (optional) return null;
    throw new Error(`cannot read data/${name}: ${err.message}`);
  }
}

async function main() {
  /* kpis + companies + framework are required - there is no scoring without them.
     macro and commentary are optional: they add the consistency verdict and the
     tone-drift alerts, and their absence costs those features, not the run. */
  const [kpis, companies, framework, macro, commentary] = await Promise.all([
    readJson('kpis.json'),
    readJson('companies.json'),
    readJson('framework.json'),
    readJson('macro.json', { optional: true }),
    readJson('commentary.json', { optional: true })
  ]);

  /* The reading this run replaces. Kept as a compact snapshot inside the new
     file so the change log diffs against something real rather than against
     assumptions about what last week looked like. `previous.previous` is never
     nested - only the snapshot is carried, so the file cannot grow each run. */
  const prior = await readJson('scores.json', { optional: true });
  const previous = snapshotOf(prior);

  const payload = buildScores({
    kpis, companies, framework, macro, commentary, previous,
    generatedAt: new Date().toISOString()
  });

  const s = payload.scores;
  const line = (id) => {
    const g = s[id];
    if (!g) return `${id}: -`;
    if (g.score === null) return `${id}: no score (0 of ${g.kpisTotal} KPIs flagged)`;
    const arrow = g.delta === null ? '' : (g.delta > 0 ? ` +${g.delta}` : ` ${g.delta}`);
    return `${id}: ${g.score}${arrow} (${g.kpisScored}/${g.kpisTotal} KPIs)`;
  };

  console.log('Cycle scores');
  console.log('  ' + line('leading'));
  console.log('  ' + line('coincident'));
  console.log('  ' + line('lagging'));
  console.log(`  stage: ${payload.stage.stageId || 'no call'}` +
    (payload.stage.position === null ? '' : ` at ${payload.stage.position}/100`) +
    (payload.stage.ruleId ? ` [${payload.stage.ruleId}]` : ''));
  console.log(`  divergence: ${payload.divergence.value === null ? '-' : payload.divergence.value}` +
    (payload.divergence.signsDiffer ? '  ** signs differ **' : ''));
  if (payload.macro.macroBias) {
    console.log(`  macro: ${payload.macro.supporting} support / ${payload.macro.opposing} oppose` +
      ` -> ${payload.macro.macroBias}` + (payload.macro.conflict ? '  ** conflict **' : ''));
  }
  console.log(`  alerts: ${payload.alerts.length}`);
  payload.alerts.forEach((a) => console.log(`    - [${a.severity}] ${a.text}`));
  console.log(`  actions for this stage: ${payload.actions.length}`);
  console.log('  changed since last run:');
  payload.changes.forEach((c) => console.log(`    - ${c.text}`));

  if (DRY) {
    console.log('\n--dry-run: nothing written.');
    return;
  }
  await writeFile(resolve(DATA, 'scores.json'), JSON.stringify(payload, null, 2) + '\n');
  console.log('\nWrote data/scores.json');
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
