#!/usr/bin/env node
/**
 * Client pipeline, step 1: refresh data/macro.json.
 *
 * Each series is fetched independently. A series that comes back is written
 * with status "live"; a series that throws - no key, source down, shape changed
 * - is written with an empty series array, sourceTag "unknown" and status
 * "awaiting". Nothing is ever estimated, carried forward or filled in.
 *
 *   node pipeline/fetch-macro.mjs [--dry-run] [--out path]
 *
 * Exit codes: 0 wrote (or would write) a file, 1 could not write one at all.
 * A run where every source fails still exits 0 with an all-awaiting file - the
 * dashboard is designed to render that honestly, and a red build for a source
 * outage would be noise.
 */

import { writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { todayIso } from './lib/dates.mjs';
import { loadEnv, credentialReport } from './lib/env.mjs';
import { probeScrapeTarget, SCRAPE_TARGETS } from './sources/probe.mjs';
import {
  fetchBrent, fetchWti, fetchUsdInr, fetchIndianBasket,
  fetchCrackSpread, fetchApmGas, fetchJkm, fetchNaphtha, fetchBalticDirty
} from './sources/macro-sources.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* --------------------------------------------------------------------------
   Tile definitions. Presentation metadata (colours, plain labels, the
   supports/supportsWhy judgement) lives here because it is editorial, not
   fetched. Only `series`, `source`, `sourceTag`, `asOf` and `status` are
   written by the fetch.
   -------------------------------------------------------------------------- */
const TILES = [
  {
    /* Section 2.1 asks for "crude (Brent + Indian basket overlaid)". They were
       two tiles, which showed both numbers and hid the thing worth seeing: the
       gap between the world price and what India's refiners actually pay. On
       one axis that gap is the chart. Brent stays primary, so it drives the
       flag and the percentile - including 4b's crude backdrop check, which
       reads this tile by id. WTI rides along because Step 1 pairs it with
       Brent as one metric. */
    id: 'brent', label: 'Crude Oil', shortLabel: 'Crude',
    plainSub: 'Brent, what India pays, and WTI', unit: '$/bbl', decimals: 1,
    supports: 'up', supportsWhy: 'Dearer crude pays for more drilling and new projects.',
    lines: [
      { id: 'brent', label: 'Brent', shortLabel: 'Brent', color: '#E8590C', primary: true, fetch: fetchBrent },
      { id: 'indian-basket', label: 'Indian Basket', shortLabel: 'Indian', color: '#9A3412', primary: false, fetch: fetchIndianBasket },
      { id: 'wti', label: 'WTI', shortLabel: 'WTI', color: '#0891B2', primary: false, fetch: fetchWti }
    ]
  },
  {
    id: 'crack-spread', label: 'Refining Margin - crack spread', shortLabel: 'Crack spread',
    plainSub: 'Profit on each barrel refined', unit: '$/bbl', decimals: 1,
    supports: 'up', supportsWhy: 'Fatter margins pay for refinery upgrades.',
    lines: [
      { id: 'crack-321', label: '3-2-1 crack (US Gulf)', shortLabel: 'Crack', color: '#0F7A3A', primary: true, fetch: fetchCrackSpread }
    ]
  },
  {
    /* The cost side of every petrochemical margin in the backbone. Reliance,
       GAIL and Supreme Petrochem all crack naphtha; when it runs away from the
       polymer price their margins compress, and this is the half of that
       equation that is honestly available. The polymer half is quoted CNY/T on
       every free source, i.e. Chinese domestic, so the spread itself is left
       unstated rather than mixed across currencies and geographies. */
    id: 'naphtha', label: 'Petrochemical Feedstock - naphtha', shortLabel: 'Naphtha',
    plainSub: 'What crackers pay for feedstock', unit: '$/t', decimals: 0,
    supports: 'down', supportsWhy: 'Cheaper feedstock widens petrochemical margins.',
    standIn: 'The cost side only - no free Indian polymer assessment exists to pair it with, so this is not a petchem margin.',
    lines: [
      { id: 'naphtha', label: 'Naphtha', shortLabel: 'Naphtha', color: '#7C3AED', primary: true, fetch: fetchNaphtha }
    ]
  },
  {
    id: 'domestic-gas', label: 'Gas Price - APM and JKM', shortLabel: 'Gas (JKM)',
    plainSub: 'imported vs home-set', unit: '$/mmbtu', decimals: 2,
    supports: 'down', supportsWhy: 'Cheaper imported gas means more of it gets burned here.',
    lines: [
      { id: 'jkm', label: 'JKM (imported)', shortLabel: 'JKM', color: '#7C3AED', primary: true, fetch: fetchJkm },
      { id: 'apm', label: 'APM (home-set)', shortLabel: 'APM', color: '#0891B2', primary: false, fetch: fetchApmGas }
    ]
  },
  {
    id: 'inr-usd', label: 'Rupee vs US Dollar', shortLabel: 'USD/INR',
    plainSub: 'How dear imports are', unit: 'Rs/$', decimals: 1,
    supports: 'down', supportsWhy: 'A stronger rupee makes imported crude and kit cheaper.',
    lines: [
      { id: 'inr-usd', label: 'USD/INR', color: '#DB2777', primary: true, fetch: fetchUsdInr }
    ]
  },
  {
    id: 'baltic-dirty', label: 'Freight - Baltic Dirty Tanker', shortLabel: 'Freight',
    plainSub: 'Cost of shipping crude by sea', unit: 'index', decimals: 0,
    supports: 'up', supportsWhy: 'Busier tankers mean more cargoes are actually moving.',
    lines: [
      { id: 'baltic-dirty', label: 'Baltic Dirty Tanker', color: '#B91C1C', primary: true, fetch: fetchBalticDirty }
    ]
  }
];

async function fetchLine(line, ctx) {
  const { fetch: fn, ...meta } = line;
  try {
    const { points, source, sourceTag, standIn, notes } = await fn(ctx);
    if (!Array.isArray(points) || !points.length) throw new Error('source returned no points');
    return {
      ...meta,
      status: 'live',
      source,
      sourceTag,
      ...(standIn ? { standIn } : {}),
      ...(notes ? { notes } : {}),
      asOf: points[points.length - 1].date,
      series: points
    };
  } catch (e) {
    return {
      ...meta,
      status: 'awaiting',
      source: null,
      sourceTag: 'unknown',
      asOf: null,
      series: [],
      /* written for the tile, not for a log */
      awaitingReason: e?.humanReason || (e?.message || String(e)).slice(0, 160)
    };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const probeIdx = args.indexOf('--probe');

  // Local runs pick up a gitignored .env; in CI the secrets are already set.
  const loaded = loadEnv();
  const creds = credentialReport();
  console.log(
    `  credentials: ${creds.filter((c) => c.present).map((c) => c.name).join(', ') || 'none'}` +
    (loaded.loaded ? '  (.env loaded)' : '  (no .env - using the environment)')
  );
  console.log('');

  /* --probe <lineId>: run one fetcher and dump what actually came back, so an
     unverified scrape can be fixed against a real response instead of a guess. */
  if (probeIdx > -1) {
    const wanted = args[probeIdx + 1];

    /* Scraper-backed lines get the full diagnostic: which provider answered,
       how big the document was, context around every keyword worth anchoring
       on, and what the current extractors make of it. That output is the whole
       point - it is what turns a guessed selector into a written one. */
    if (SCRAPE_TARGETS[wanted]) {
      const ok = await probeScrapeTarget(wanted, { env: process.env });
      /* Always exit 0: a probe that proves a source is unreachable has done its
         job, and a red job would hide the log behind a failure badge. */
      console.log(ok ? '\nresult: usable value found' : '\nresult: no usable value (see context above)');
      return;
    }

    const all = TILES.flatMap((t) => t.lines.map((l) => ({ tile: t, line: l })));
    const hit = all.find((x) => x.line.id === wanted);
    if (!hit) {
      console.error(
        `unknown line "${wanted}". Scrape targets: ${Object.keys(SCRAPE_TARGETS).join(', ')}. ` +
        `Lines: ${all.map((x) => x.line.id).join(', ')}`
      );
      process.exit(1);
    }
    console.log(`  probing ${hit.tile.id}/${hit.line.id} ...`);
    try {
      const r = await hit.line.fetch({ today: todayIso(), env: process.env });
      console.log(JSON.stringify(r, null, 2));
    } catch (e) {
      console.error(`  FAILED: ${e?.name}: ${e?.message}`);
      if (e?.humanReason) console.error(`  tile would read: "${e.humanReason}"`);
      if (e?.meta?.sample) console.error(`  page text sample:\n${e.meta.sample}`);
      process.exit(1);
    }
    return;
  }

  const outIdx = args.indexOf('--out');
  const outPath = outIdx > -1 ? resolve(args[outIdx + 1]) : resolve(ROOT, 'data/macro.json');
  const today = todayIso();
  const ctx = { today, env: process.env };

  const tiles = [];
  for (const def of TILES) {
    const { lines, ...tileMeta } = def;
    const built = [];
    for (const line of lines) built.push(await fetchLine(line, ctx));

    const live = built.filter((l) => l.status === 'live');
    // The tile inherits the primary line's provenance; the dashboard still
    // renders one chip per distinct source across the lines.
    const primary = built.find((l) => l.primary) || built[0];
    const standIn = built.find((l) => l.standIn);
    tiles.push({
      ...tileMeta,
      status: live.length ? 'live' : 'awaiting',
      ...(standIn ? { standIn: standIn.standIn } : {}),
      source: primary.source,
      sourceTag: primary.sourceTag,
      asOf: primary.asOf,
      lines: built
    });
  }

  const liveTiles = tiles.filter((t) => t.status === 'live');
  const doc = {
    schemaVersion: 2,
    title: 'Market backdrop',
    generatedBy: 'pipeline/fetch-macro.mjs',
    generatedAt: new Date().toISOString(),
    note:
      'Fetched from public sources. Series that could not be fetched are written ' +
      'with an empty series array and status "awaiting" - never estimated, never ' +
      'carried forward. Each line holds monthly points, oldest first.',
    months: 12,
    flatBandPct: 1.5,
    flagLookbackMonths: 3,
    coverage: {
      tilesLive: liveTiles.length,
      tilesTotal: tiles.length,
      linesLive: tiles.flatMap((t) => t.lines).filter((l) => l.status === 'live').length,
      linesTotal: tiles.flatMap((t) => t.lines).length
    },
    tiles,
    directionFlags: [
      { id: 'rising', label: 'Rising', glyph: '↑', color: '#2563EB' },
      { id: 'flat', label: 'Flat', glyph: '→', color: '#7C8496' },
      { id: 'falling', label: 'Falling', glyph: '↓', color: '#E07C05' }
    ]
  };

  for (const t of tiles) {
    for (const l of t.lines) {
      const tag = l.status === 'live' ? `live  ${l.series.length} pts, to ${l.asOf}` : `AWAITING  (${l.awaitingReason})`;
      console.log(`  ${(t.id + '/' + l.id).padEnd(28)} ${tag}`);
    }
  }
  console.log(
    `\n  ${doc.coverage.linesLive}/${doc.coverage.linesTotal} lines live, ` +
    `${doc.coverage.tilesLive}/${doc.coverage.tilesTotal} tiles live`
  );

  if (dryRun) {
    console.log('\n  --dry-run: nothing written');
    return;
  }

  // Keep the byte-for-byte diff small so the daily commit is readable.
  const next = JSON.stringify(doc, null, 2) + '\n';
  const prev = await readFile(outPath, 'utf8').catch(() => null);
  if (prev !== null && stripVolatile(prev) === stripVolatile(next)) {
    console.log('\n  no change beyond the timestamp - leaving the file alone');
    return;
  }
  await writeFile(outPath, next);
  console.log(`\n  wrote ${outPath}`);
}

/** generatedAt moves every run; ignore it when deciding whether anything changed. */
function stripVolatile(json) {
  return json.replace(/"generatedAt":\s*"[^"]*",?\n?/, '');
}

main().catch((e) => {
  console.error('fetch-macro failed outright:', e?.stack || e);
  process.exit(1);
});
