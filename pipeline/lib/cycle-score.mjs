/**
 * The cycle-scoring spine. Pure arithmetic over data the pipeline already holds.
 *
 * Everything the client's Section 1 and Section 5 ask for hangs off this file:
 * the three bucket scores, the stage call, the divergence reading and the alert
 * strip. Until now those were a hardcoded `SEED` object in index.html; this
 * module replaces it with numbers that trace back to real KPI trajectories.
 *
 * The rules that govern it are the same ones that govern the KPI store:
 *
 *   - Never invent a number. A group with no flagged KPI scores `null`, not 50.
 *     A stage call with no scores behind it is `null`, not "Trough".
 *   - Every output says what it was computed from, so a reader can argue with it.
 *     Scores carry their KPI count; the stage call names the rule row that fired.
 *   - No model call. This is arithmetic on flags that were themselves computed in
 *     code (lib/kpi-flag.mjs), so the whole chain from a reported figure to the
 *     dial on the Cockpit is inspectable.
 *
 * The one judgement call is the momentum map below, and it is deliberately in
 * one place where it can be changed and argued with.
 */

import { flagFor, usableSeries } from './kpi-flag.mjs';
import { isOlderQuarter, quarterOrdinal } from './fiscal.mjs';

/**
 * Step 4a scoring, to the brief.
 *
 * A bucket score is the NET trajectory of its inputs on a signed -100..+100
 * scale, because the stage table in 4b is written in signed language: a bucket
 * is Negative, or flat, or Positive, or strongly positive. Zero is "no news".
 *
 * Two weighting rules come straight from the brief and are the whole point of
 * the scoring:
 *
 *   "Inflection flags carry double weight - a KPI that just turned matters more
 *    than one continuing an established trend."
 *   "A tone-drift deterioration of two steps or more also carries double weight."
 *
 * Decelerating scores negative even though the brief describes it as "still
 * positive vs. history but moderating", because its stated cycle meaning is
 * "early warning - often precedes an inflection". Reading it as mild strength
 * would invert the signal this dashboard exists to catch.
 */
export const FLAG_SCORE = {
  'accelerating':     1,
  'inflecting-up':    1,
  'steady':           0,
  'decelerating':    -1,
  'inflecting-down': -1
};

/** The brief's double weight for the two inflection flags. */
export const FLAG_WEIGHT = {
  'accelerating':     1,
  'inflecting-up':    2,
  'steady':           1,
  'decelerating':     1,
  'inflecting-down':  2
};

/** Latest-quarter tone -> direction flag, per Step 3's Positive/Neutral/Negative. */
export const TONE_DIRECTION = {
  'confident':     1,
  'constructive':  1,
  'neutral':       0,
  'cautious':     -1,
  'defensive':    -1
};

/** Neutral midpoint of every signed score in this module. */
export const NEUTRAL = 0;

/* Dead-bands. A score inside LEVEL_BAND of zero is flat rather than directional;
   a quarter-on-quarter move inside DELTA_BAND is noise. Without them a score of
   0.4 would read as a positive bucket. */
const LEVEL_BAND = 10;
const STRONG_BAND = 40;
const DELTA_BAND = 5;

/** The brief's coverage guard: more than a third unusable and the score is thin. */
export const COVERAGE_LIMIT = 1 / 3;

/**
 * How much weight a source tag carries, for confidence display only.
 *
 * Part D: "Derived values inherit the weakest tag among their inputs for
 * confidence display: a score built partly on [Estimate] inputs shows a
 * reduced-confidence marker even though the score itself is [Derived]."
 *
 * The order is the brief's own taxonomy read as a ladder: an audited filing is
 * the firmest thing on the board, a company's own unaudited slide is next, an
 * aggregator after that, then a forward-looking management claim, then a figure
 * the pipeline computed because nobody disclosed one. [Unknown] does not appear
 * because it never reaches a score - it is quarantined before the trend.
 */
export const TAG_CONFIDENCE = {
  'official':       5,
  'company-filing': 4,
  'external':       3,
  'mgmt-claim':     2,
  'estimate':       1,
  /* Cells written before the derive step was retagged carry 'derived' as their
     source. It means the same thing - the pipeline computed it to fill a gap -
     so it sits at the same confidence rather than falling out of the ladder and
     silently counting as firm. */
  'derived':        1
};

/* At or below this, the score carries a reduced-confidence marker. The brief
   names [Estimate] as the case that must show one. */
const REDUCED_AT = TAG_CONFIDENCE.estimate;

/**
 * Bump when a change would make today's scores incomparable with a stored one -
 * a new weighting, a new scale, a new input. The change log refuses to diff
 * across a bump, because "leading moved down 58 points" would then be describing
 * the method changing rather than the cycle moving.
 */
export const SCORING_VERSION = 2;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Where a signed score sits, in the language the 4b stage table uses.
 * 'strong-positive' | 'positive' | 'flat' | 'negative' | 'strong-negative'
 */
export function levelOf(score) {
  if (!isNum(score)) return null;
  if (score >= STRONG_BAND) return 'strong-positive';
  if (score >= LEVEL_BAND) return 'positive';
  if (score <= -STRONG_BAND) return 'strong-negative';
  if (score <= -LEVEL_BAND) return 'negative';
  return 'flat';
}

/** true when the score is on the positive side of the dead band */
export const isPositive = (s) => isNum(s) && s >= LEVEL_BAND;
/** true when the score is on the negative side of the dead band */
export const isNegative = (s) => isNum(s) && s <= -LEVEL_BAND;

/**
 * The quarter staleness is measured against: the end of the dashboard's own
 * reporting window.
 *
 * NOT the newest quarter any single company has filed. One company reporting
 * early would then mark every other company stale - on today's data a single
 * Q1 FY27 filer turns 21 of 27 rows grey - which inverts what the word means.
 * A company that has not yet reported the quarter after the current one is not
 * out of date; it is on time. The window's end is the reporting period the
 * grid is currently showing, and trailing THAT is what "stale" describes.
 */
export function latestReportedOf(kpisJson) {
  const qs = (kpisJson && kpisJson.quarters) || [];
  if (qs.length) return qs[qs.length - 1];
  /* no window: fall back to the newest asOf any company states */
  const cs = (kpisJson && kpisJson.companies) || {};
  let best = null, bestN = -Infinity;
  Object.keys(cs).forEach((id) => {
    const n = quarterOrdinal(cs[id] && cs[id].asOf);
    if (n !== null && n > bestN) { bestN = n; best = cs[id].asOf; }
  });
  return best;
}

/** 'rising' | 'falling' | 'flat' — which way a score moved since last quarter. */
export function directionOf(delta) {
  if (!isNum(delta)) return null;
  if (delta >= DELTA_BAND) return 'rising';
  if (delta <= -DELTA_BAND) return 'falling';
  return 'flat';
}

/**
 * Score one group from its companies' KPI trajectories.
 *
 * `drop` walks the whole calculation back in time: drop=1 recomputes every flag
 * as it would have read one quarter ago, using the same flag code on a shorter
 * series. That is what makes the quarter-on-quarter arrow honest — it is the
 * same measurement taken twice, not a stored guess about the past.
 *
 * A KPI whose series is too short to flag contributes nothing (kpi-flag returns
 * null below three points). A group where nothing can be flagged scores null.
 *
 * @param {object} kpisJson     data/kpis.json
 * @param {{id:string,companies:{id:string}[]}} group  a group from companies.json
 * @param {number} [drop=0]     how many quarters to walk back
 * @returns {{score:number|null, kpisScored:number, kpisTotal:number, companiesScored:number}}
 */
export function scoreGroup(kpisJson, group, drop = 0, opts = {}) {
  const band = isNum(kpisJson && kpisJson.flatBandPct) ? kpisJson.flatBandPct : 1.5;
  const byId = (kpisJson && kpisJson.companies) || {};
  const latestQuarter = opts.latestQuarter || null;
  let weighted = 0, weight = 0, scored = 0, total = 0, stale = 0, oneOff = 0, unknown = 0;
  /* shown on the grid but deliberately not scored - see the beyondBrief note below */
  let beyond = 0;
  const companies = new Set();
  /* the weakest tag among the cells that actually fed a score - Part D's
     confidence inheritance */
  let weakest = null, weakestRank = Infinity;
  /* the strongest signals, for the summary paragraph's "driven by ..." clause */
  const signals = [];

  (group.companies || []).forEach((c) => {
    const entry = byId[c.id];
    if (!entry || !Array.isArray(entry.kpis)) return;
    /* The brief's staleness test: a source strictly OLDER than the latest
       reported quarter. A company reporting behind the pack makes its whole row
       stale; one that has already filed the next quarter is ahead, not behind,
       and counting it as stale would penalise the freshest data on the board. */
    const isStale = isOlderQuarter(entry.asOf, latestQuarter);

    entry.kpis.forEach((k) => {
      /* Rows beyond the brief's named KPI list are shown, not scored.
         The interpretation framework in Step 4 was specified against the KPIs
         the brief names per company; letting extra rows in would reweight every
         bucket by how much spare data a company happens to publish - IOCL would
         carry eight rows into coincident where the brief gives it three, and
         the refiners would outvote the gas utilities for no analytical reason.
         Held out of `total` as well as the score, so the coverage guard keeps
         measuring the brief's list rather than a diluted version of it. */
      if (k.beyondBrief) { beyond++; return; }
      total++;
      if (isStale) stale++;
      if ((k.oneOffs || []).some(Boolean)) oneOff++;
      if ((k.sourceTags || []).some((t) => t === 'unknown')) unknown++;
      /* Hold out what the brief holds out before anything is trended: quarters
         a one-off distorted, and quarters whose provenance is unknown. */
      const values = usableSeries(Array.isArray(k.values) ? k.values : [],
        { oneOffs: k.oneOffs, sourceTags: k.sourceTags });
      /* Walking back means dropping the newest quarters, not the oldest: the
         window is oldest-first, so slice from the end. */
      const window = drop > 0 ? values.slice(0, values.length - drop) : values;
      const flag = flagFor(window, k.flagBasis, band);
      if (!flag || !isNum(FLAG_SCORE[flag])) return;
      /* A score inherits the weakest provenance among the quarters behind it:
         one estimated cell is enough to make the whole reading softer. Only the
         quarters that survived quarantine count - an unknown never feeds a
         score, so it cannot set its confidence either. */
      (k.sourceTags || []).forEach((t, i) => {
        if (!t || t === 'unknown') return;
        if (values[i] == null) return;
        const rank = TAG_CONFIDENCE[t];
        if (isNum(rank) && rank < weakestRank) { weakestRank = rank; weakest = t; }
      });
      const w = FLAG_WEIGHT[flag];
      weighted += FLAG_SCORE[flag] * w;
      weight += w;
      scored++;
      companies.add(c.id);
      if (w > 1) signals.push({ kind: 'kpi', companyId: c.id, company: entry.name || c.id, label: k.label, flag });
    });
  });

  /* Step 3's tone drift enters the bucket score too - the brief scores each
     bucket on "the KPI flags PLUS tone drift" for the themes that feed it. */
  const toneInputs = opts.toneInputs || [];
  let tones = 0;
  toneInputs.forEach((t) => {
    weighted += t.value * t.weight;
    weight += t.weight;
    tones++;
    if (t.weight > 1) signals.push({ kind: 'tone', companyId: t.companyId, company: t.company, label: t.theme, flag: t.drift > 0 ? 'tone-up' : 'tone-down' });
  });

  /* the brief's guard counts what cannot carry a trajectory: stale rows,
     one-off-distorted quarters, and quarantined provenance */
  const usable = total ? (stale + oneOff + unknown) / total : 0;

  return {
    score: weight ? Math.round((weighted / weight) * 100) : null,
    kpisScored: scored,
    kpisTotal: total,
    /* reported so the dashboard can say "3 of 8 rows score" rather than leaving
       a reader to wonder why a full-looking company moves the dial so little */
    kpisBeyondBrief: beyond,
    tonesScored: tones,
    companiesScored: companies.size,
    staleKpis: stale,
    oneOffKpis: oneOff,
    unknownKpis: unknown,
    lowCoverage: total > 0 && usable > COVERAGE_LIMIT,
    weakestTag: weakest,
    reducedConfidence: isNum(weakestRank) && weakestRank <= REDUCED_AT,
    signals
  };
}

/**
 * Tone inputs per bucket, mapped through the seven themes.
 *
 * The brief routes commentary into the scores by theme, not by company group:
 * upstream-capex and capex-pipeline feed leading, refining/marketing/gas/spread
 * feed coincident, freight feeds lagging. A company appearing in two themes is
 * counted in each, which is intended - it is being listened to about two things.
 */
export function toneInputsByBucket(commentaryJson, framework) {
  const out = { leading: [], coincident: [], lagging: [] };
  const themes = ((framework && framework.themes && framework.themes.items) || []);
  const companies = (commentaryJson && commentaryJson.companies) || {};

  themes.forEach((theme) => {
    if (!out[theme.bucket]) out[theme.bucket] = [];
    (theme.companyIds || []).forEach((id) => {
      const c = companies[id];
      const toned = ((c && c.tones) || []).filter((t) => t && t.toneId && isNum(t.score));
      if (!toned.length) return;
      const latest = toned[toned.length - 1];
      const prior = toned.length > 1 ? toned[toned.length - 2] : null;
      const drift = prior ? latest.score - prior.score : 0;
      const value = isNum(TONE_DIRECTION[latest.toneId]) ? TONE_DIRECTION[latest.toneId] : 0;
      /* the brief's second double-weight rule: a two-step drift either way is
         the signal, not the level it landed on */
      const weight = Math.abs(drift) >= 2 ? 2 : 1;
      out[theme.bucket].push({
        companyId: id, company: (c && c.name) || id,
        theme: theme.label, themeId: theme.id,
        toneId: latest.toneId, quarter: latest.quarter,
        value, weight, drift
      });
    });
  });
  return out;
}

/**
 * All three bucket scores, each with the same measurement taken one quarter
 * back so the change arrow is real.
 *
 * @returns {Record<string, {score:number|null, prev:number|null, delta:number|null,
 *   level:string|null, direction:string|null, kpisScored:number, kpisTotal:number,
 *   companiesScored:number}>}
 */
export function bucketScores(kpisJson, companiesJson, opts = {}) {
  const out = {};
  const latestQuarter = latestReportedOf(kpisJson);
  const tone = opts.toneInputs || {};
  ((companiesJson && companiesJson.groups) || []).forEach((g) => {
    const now = scoreGroup(kpisJson, g, 0, { latestQuarter, toneInputs: tone[g.id] || [] });
    /* The prior quarter is the same computation on a shorter series. Tone is
       held out of it: commentary.json keeps only the current drift sequence, so
       including it would compare a KPI-and-tone score with a KPI-only one. */
    const before = scoreGroup(kpisJson, g, 1, { latestQuarter });
    const nowKpiOnly = scoreGroup(kpisJson, g, 0, { latestQuarter });
    const delta = isNum(nowKpiOnly.score) && isNum(before.score) ? nowKpiOnly.score - before.score : null;
    out[g.id] = {
      score: now.score,
      prev: before.score,
      delta,
      deltaBasis: 'kpi-only',
      level: levelOf(now.score),
      direction: directionOf(delta),
      kpisScored: now.kpisScored,
      kpisTotal: now.kpisTotal,
      /* shown but not scored - carried into scores.json so anything reading the
         bucket can say "40 of 58 rows scored" rather than implying all of them did */
      kpisBeyondBrief: now.kpisBeyondBrief,
      tonesScored: now.tonesScored,
      companiesScored: now.companiesScored,
      staleKpis: now.staleKpis,
      oneOffKpis: now.oneOffKpis,
      unknownKpis: now.unknownKpis,
      lowCoverage: now.lowCoverage,
      weakestTag: now.weakestTag,
      reducedConfidence: now.reducedConfidence,
      signals: now.signals
    };
  });
  return out;
}

/**
 * Divergence, exactly as the client defines it: leading minus **coincident**,
 * and the alert fires when the two sit on opposite sides of neutral.
 *
 * The sign test is the point of the indicator. Leading at 70 and coincident at
 * 60 is a wide gap but the same story; leading at 60 and coincident at 40 is a
 * smaller gap and a different story - the front of the chain has turned and the
 * middle has not followed. Only the second is worth waking someone for.
 */
export function divergenceOf(scores) {
  const L = scores && scores.leading ? scores.leading.score : null;
  const C = scores && scores.coincident ? scores.coincident.score : null;
  if (!isNum(L) || !isNum(C)) {
    return { value: null, signsDiffer: false, leadingSign: null, coincidentSign: null };
  }
  const sign = (x) => (isPositive(x) ? 1 : isNegative(x) ? -1 : 0);
  const ls = sign(L), cs = sign(C);
  return {
    value: L - C,
    leadingSign: ls,
    coincidentSign: cs,
    /* Both must be off neutral and on opposite sides. A group sitting in the
       dead band is not "the opposite" of anything. */
    signsDiffer: ls !== 0 && cs !== 0 && ls !== cs
  };
}

/**
 * The stage rulebook. Ordered; the first row whose condition holds wins, and
 * the row that fired is reported by id.
 *
 * A table rather than a formula because the client asks the Insight tab to show
 * "which stage row generated it" - the reasoning has to be nameable, not the
 * output of an angle in a plane nobody can check. Each row is one sentence of
 * cycle logic:
 *
 *   the front of the chain turns first, the middle follows, the back turns last.
 */
export const STAGE_RULES = [
  {
    id: 'early-downcycle',
    stageId: 'early-downcycle',
    label: 'Leading turning negative while coincident, still positive, compresses',
    /* "Turning negative - order inflow slows even as order books still execute;
        coincident still positive but compressing; lagging still positive (lags)" */
    when: (L, C) => (isNegative(L.score) || L.direction === 'falling') &&
                    isPositive(C.score) && C.direction !== 'rising'
  },
  {
    id: 'late-upcycle',
    stageId: 'late-upcycle',
    label: 'Leading positive but flattening, coincident at peak, lagging extended',
    /* "Positive but flattening; coincident at peak; lagging strongly positive" */
    when: (L, C, G) => isPositive(L.score) && L.direction !== 'rising' &&
                       isPositive(C.score) && (levelOf(G.score) === 'strong-positive' || isPositive(C.score))
  },
  {
    id: 'mid-upcycle',
    stageId: 'mid-upcycle',
    label: 'Leading strongly positive, coincident positive and accelerating, lagging turning',
    when: (L, C) => levelOf(L.score) === 'strong-positive' && isPositive(C.score)
  },
  {
    id: 'early-upcycle',
    stageId: 'early-upcycle',
    label: 'Leading turning positive off a low base, coincident not yet following',
    /* "Turning positive off a low base - inflections concentrated here; coincident
        still negative or flat, stabilizing; lagging still negative, starting to firm" */
    when: (L, C) => (isPositive(L.score) || L.direction === 'rising') && !isPositive(C.score)
  },
  {
    id: 'trough',
    stageId: 'trough',
    label: 'All three buckets negative',
    when: (L, C, G) => isNegative(L.score) && isNegative(C.score) &&
                       (G.score === null || isNegative(G.score) || levelOf(G.score) === 'flat')
  },
  {
    id: 'no-clear-signal',
    stageId: null,
    label: 'No bucket far enough from zero to place the cycle',
    confidence: 'low',
    when: () => true
  }
];

/**
 * Place the cycle on the 0-100 dial and name the stage.
 *
 * The rule picks the stage, which fixes the band (framework.json gives each
 * stage its own 0-100 range). Within that band the position is the centre,
 * nudged by how fast things are moving: a stage that is strengthening sits
 * later in its own band, one that is weakening sits earlier. The nudge is
 * capped at a quarter of the band so the position can never imply a stage it
 * was not called as.
 *
 * @param {object} scores      output of bucketScores
 * @param {object[]} cycleStages  framework.json cycleStages (each with range)
 * @returns {{stageId:string|null, position:number|null, ruleId:string|null,
 *   ruleLabel:string|null, confidence:string, because:string[]}}
 */
export function stageCall(scores, cycleStages) {
  const L = scores && scores.leading, C = scores && scores.coincident;
  const G = (scores && scores.lagging) || { score: null, direction: null };
  if (!L || !C || !isNum(L.score) || !isNum(C.score)) {
    return {
      stageId: null, position: null, ruleId: null, ruleLabel: null,
      confidence: 'none',
      because: ['No cycle call: the leading or coincident bucket has no scored input yet.']
    };
  }

  const rule = STAGE_RULES.find((r) => r.when(L, C, G)) || STAGE_RULES[STAGE_RULES.length - 1];
  /* The catch-all row places no stage: "mid upcycle" is a claim, and a board
     with nothing off zero has not earned one. */
  if (!rule.stageId) {
    return {
      stageId: null, position: null, ruleId: rule.id, ruleLabel: rule.label,
      confidence: 'low',
      because: [
        `Leading ${L.score} (${L.level}), coincident ${C.score} (${C.level})` +
        (isNum(G.score) ? `, lagging ${G.score} (${G.level})` : '') + '.',
        rule.label + '.'
      ]
    };
  }
  const stage = (cycleStages || []).find((s) => s.id === rule.stageId);
  const range = (stage && Array.isArray(stage.range)) ? stage.range : [0, 100];
  const [lo, hi] = range;

  /* average of the deltas we actually have, so a group with no prior quarter
     does not drag the nudge toward zero */
  const deltas = [L.delta, C.delta].filter(isNum);
  const avgDelta = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
  const nudge = clamp01((avgDelta + 20) / 40) - 0.5;          /* -0.5 .. +0.5 */
  const t = 0.5 + nudge * 0.5;                                 /* 0.25 .. 0.75 */

  const because = [
    `Leading ${L.score} (${L.level}${L.direction ? ', ' + L.direction : ''}), ` +
    `coincident ${C.score} (${C.level}${C.direction ? ', ' + C.direction : ''})` +
    (isNum(G.score) ? `, lagging ${G.score} (${G.level})` : '') + '.',
    rule.label + '.'
  ];

  return {
    stageId: rule.stageId,
    position: Math.round(lo + t * (hi - lo)),
    ruleId: rule.id,
    ruleLabel: rule.label,
    confidence: rule.confidence || (L.kpisScored + C.kpisScored >= 10 ? 'normal' : 'low'),
    because
  };
}

/**
 * The Macro backdrop column of the 4b stage table: what crude should be doing
 * if the stage the scores called is the stage we are actually in.
 *
 * 4a is explicit that macro flags "do not enter the scores - they are the
 * sanity check", so this never changes the call. It corroborates it, and a
 * disagreement raises the manual-review flag the brief asks for rather than
 * being quietly dropped.
 *
 * "Low" and "elevated" are read off the 12-month percentile, which is what the
 * brief means by "near cycle lows" and "elevated" - 90th percentile crude reads
 * very differently from 40th even when both are Rising.
 */
export const STAGE_MACRO = {
  'trough':          { text: 'crude near cycle lows',  wants: { maxPercentile: 35 } },
  'early-upcycle':   { text: 'crude recovering',       wants: { direction: 'rising' } },
  'mid-upcycle':     { text: 'crude trending up',      wants: { direction: 'rising' } },
  'late-upcycle':    { text: 'crude elevated',         wants: { minPercentile: 65 } },
  'early-downcycle': { text: 'crude falling',          wants: { direction: 'falling' } }
};

/**
 * Does the crude backdrop corroborate the stage the scores called?
 *
 * Returns null when there is nothing to check against - no call, or no crude
 * tile with enough history. An unknown backdrop is not a disagreement.
 */
export function stageMacroCheck(stageId, macroVerdict) {
  const want = STAGE_MACRO[stageId];
  if (!want) return null;
  const tiles = (macroVerdict && macroVerdict.tiles) || [];
  /* Brent is the reference the 4b column is written against */
  const crude = tiles.find((t) => t.id === 'brent') || tiles.find((t) => /crude|brent/i.test(t.id || ''));
  if (!crude || (!crude.direction && !isNum(crude.percentile))) return null;

  const checks = [];
  if (want.wants.direction) {
    checks.push({
      ok: crude.direction === want.wants.direction,
      saw: `crude ${crude.direction || 'flat'}`
    });
  }
  if (isNum(want.wants.maxPercentile)) {
    checks.push({
      ok: isNum(crude.percentile) ? crude.percentile <= want.wants.maxPercentile : null,
      saw: isNum(crude.percentile) ? `${crude.percentile}th percentile` : 'no percentile'
    });
  }
  if (isNum(want.wants.minPercentile)) {
    checks.push({
      ok: isNum(crude.percentile) ? crude.percentile >= want.wants.minPercentile : null,
      saw: isNum(crude.percentile) ? `${crude.percentile}th percentile` : 'no percentile'
    });
  }
  const decided = checks.filter((c) => c.ok !== null);
  if (!decided.length) return null;

  const agrees = decided.every((c) => c.ok);
  return {
    stageId,
    expected: want.text,
    observed: decided.map((c) => c.saw).join(', '),
    agrees
  };
}

/**
 * Which way a macro tile has moved, mirroring what the browser draws so the
 * pipeline's verdict and the tab's badges cannot disagree.
 */
export function tileDirection(tile, lookback, bandPct) {
  const lines = (tile && tile.lines) || [];
  const primary = lines.find((l) => l.primary) || lines[0];
  const series = (primary && primary.series) || [];
  const values = series.map((p) => p && p.value).filter(isNum);
  if (values.length < lookback + 1) return null;         /* a spot quote has no direction */
  const latest = values[values.length - 1];
  const prior = values[values.length - 1 - lookback];
  const diff = latest - prior;
  const pct = prior === 0 ? null : (diff / Math.abs(prior)) * 100;
  if (pct === null) return diff === 0 ? 'flat' : (diff > 0 ? 'rising' : 'falling');
  return pct > bandPct ? 'rising' : (pct < -bandPct ? 'falling' : 'flat');
}

/** Where the latest point ranks inside its own 12 months, 0-100, or null. */
export function tilePercentile(tile) {
  const lines = (tile && tile.lines) || [];
  const primary = lines.find((l) => l.primary) || lines[0];
  const values = ((primary && primary.series) || []).map((p) => p && p.value).filter(isNum);
  if (values.length < 2) return null;
  const latest = values[values.length - 1];
  const below = values.filter((v) => v < latest).length;
  return Math.round((below / (values.length - 1)) * 100);
}

/**
 * Does the macro backdrop agree with the scores?
 *
 * Each tile carries `supports` in the data - which direction of that price backs
 * a stronger capex cycle - because it is a judgement and belongs where it can be
 * argued with. A tile moving its supporting way is a vote for the cycle; against
 * is a vote away. The verdict compares that balance with whether the scores are
 * actually improving, and flags for review when the two disagree.
 */
export function macroAgreement(macroJson, scores) {
  const lookback = isNum(macroJson && macroJson.flagLookbackMonths) ? macroJson.flagLookbackMonths : 3;
  const band = isNum(macroJson && macroJson.flatBandPct) ? macroJson.flatBandPct : 1.5;
  let supporting = 0, opposing = 0, silent = 0;
  const tiles = [];

  ((macroJson && macroJson.tiles) || []).forEach((t) => {
    const dir = tileDirection(t, lookback, band);
    let vote = 'silent';
    if (dir === 'rising' || dir === 'falling') {
      if (t.supports === 'up' || t.supports === 'down') {
        const backs = (t.supports === 'up' && dir === 'rising') ||
                      (t.supports === 'down' && dir === 'falling');
        vote = backs ? 'supports' : 'opposes';
      }
    }
    if (vote === 'supports') supporting++;
    else if (vote === 'opposes') opposing++;
    else silent++;
    tiles.push({
      id: t.id, label: t.shortLabel || t.label, direction: dir,
      /* the brief's Step 1 output is "flag + percentile" - 90th percentile crude
         reads very differently from 40th even when both are Rising */
      percentile: tilePercentile(t),
      supports: t.supports, vote
    });
  });

  const voting = supporting + opposing;
  const macroBias = !voting ? null : (supporting > opposing ? 'up' : (opposing > supporting ? 'down' : 'mixed'));

  /* the scores' own direction: the average move across the groups that have one */
  const deltas = Object.values(scores || {}).map((s) => s && s.delta).filter(isNum);
  const avg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;
  const scoreBias = !isNum(avg) ? null : (avg >= DELTA_BAND ? 'up' : (avg <= -DELTA_BAND ? 'down' : 'flat'));

  let agree = null, conflict = false;
  if (macroBias && scoreBias && macroBias !== 'mixed' && scoreBias !== 'flat') {
    agree = macroBias === scoreBias;
    conflict = !agree;
  }

  return { supporting, opposing, silent, macroBias, scoreBias, agree, conflict, tiles };
}

/**
 * Companies whose management tone moved `minSteps` or more on the five-point
 * scale between their two most recent classified quarters.
 *
 * The scale is ordinal (confident 5 ... defensive 1), so a two-step move is a
 * genuine change of posture rather than a wording difference - which is why the
 * client asks for exactly this on the alert strip.
 */
export function toneDrift(commentaryJson, minSteps = 2) {
  const out = [];
  const companies = (commentaryJson && commentaryJson.companies) || {};
  Object.keys(companies).forEach((id) => {
    const c = companies[id];
    const toned = ((c && c.tones) || []).filter((t) => t && t.toneId && isNum(t.score));
    if (toned.length < 2) return;
    const latest = toned[toned.length - 1], prior = toned[toned.length - 2];
    const steps = latest.score - prior.score;
    if (Math.abs(steps) < minSteps) return;
    out.push({
      companyId: id,
      name: c.name || id,
      from: prior.toneId,
      to: latest.toneId,
      fromQuarter: prior.quarter,
      quarter: latest.quarter,
      steps,
      direction: steps > 0 ? 'up' : 'down'
    });
  });
  /* biggest move first - the alert strip is short and the largest drift earns the row */
  return out.sort((a, b) => Math.abs(b.steps) - Math.abs(a.steps));
}

/**
 * Groups resting on too little evidence to carry a score with a straight face.
 * The client asks for this on the alert strip, and it is the honest counterweight
 * to putting a single number on a gauge.
 */
export function coverageWarnings(scores, groupMeta) {
  const nameOf = (id) => {
    const g = (groupMeta || []).find((m) => m.id === id);
    return (g && (g.plainLabel || g.label)) || id;
  };
  const out = [];
  Object.keys(scores || {}).forEach((id) => {
    const s = scores[id];
    if (!s) return;
    if (s.score === null) {
      out.push({ groupId: id, kind: 'no-score', text: `${nameOf(id)}: nothing in this bucket can be scored yet.` });
      return;
    }
    /* The brief's guard, exactly: more than a third of the bucket's KPIs stale
       (source older than the latest reported quarter) or one-off-flagged means
       the score renders with a low-coverage warning rather than false confidence. */
    if (s.lowCoverage) {
      const bad = (s.staleKpis || 0) + (s.oneOffKpis || 0);
      out.push({
        groupId: id,
        kind: 'low-coverage',
        text: `${nameOf(id)}: ${bad} of ${s.kpisTotal} KPIs are stale or one-off-flagged ` +
              `(over a third), so the score carries a low-coverage warning.`
      });
    }
  });
  return out;
}

/**
 * The alert strip, in the order the client listed it: macro conflict first
 * (it questions the whole reading), then thin coverage, then tone drift.
 */
export function buildAlerts({ macro, scores, coverage, drift, divergence, stageMacro }) {
  const alerts = [];

  if (divergence && divergence.signsDiffer) {
    alerts.push({
      id: 'divergence',
      severity: 'high',
      kind: 'divergence',
      text: `Leading and coincident have split: ${divergence.value > 0 ? 'the front of the chain has turned up while the middle has not' : 'the middle is holding up while the front has turned down'}.`
    });
  }
  if (macro && macro.conflict) {
    alerts.push({
      id: 'macro-conflict',
      severity: 'review',
      kind: 'macro-conflict',
      text: `Flagged for review: the market backdrop points ${macro.macroBias} while the scores are moving ${macro.scoreBias}.`
    });
  }
  /* The 4b table pairs each stage with a crude backdrop. The scores make the
     call; when crude does not corroborate it, the brief wants that shown rather
     than resolved. */
  if (stageMacro && stageMacro.agrees === false) {
    alerts.push({
      id: 'stage-macro',
      severity: 'review',
      kind: 'stage-macro',
      text: `Flagged for review: this stage expects ${stageMacro.expected}, but ${stageMacro.observed}.`
    });
  }
  (coverage || []).forEach((w) => {
    alerts.push({ id: 'coverage-' + w.groupId, severity: 'info', kind: 'low-coverage', text: w.text });
  });
  (drift || []).forEach((d) => {
    alerts.push({
      id: 'tone-' + d.companyId,
      severity: d.direction === 'down' ? 'warn' : 'info',
      kind: 'tone-drift',
      text: `${d.name} moved ${Math.abs(d.steps)} tone steps ${d.direction === 'down' ? 'down' : 'up'} (${d.from} → ${d.to}) in ${d.quarter}.`
    });
  });

  return alerts;
}

/**
 * Section 4.3: the seven listening themes, each with a one-line state and the
 * companies driving it.
 *
 * The state is computed from the member companies' own reads rather than asked
 * of a model a second time. That keeps it [Derived] - arithmetic on tagged
 * inputs - so a reader can check it against the cards underneath, and a theme
 * can never say something none of its companies said. The companies "driving"
 * it are the ones that actually moved: a two-step tone drift first, then a
 * direction away from neutral.
 */
export function themeRollup(commentaryJson, framework) {
  const themes = ((framework && framework.themes && framework.themes.items) || []);
  const companies = (commentaryJson && commentaryJson.companies) || {};

  return themes.map((theme) => {
    const members = [];
    (theme.companyIds || []).forEach((id) => {
      const c = companies[id];
      const toned = ((c && c.tones) || []).filter((t) => t && t.toneId);
      if (!toned.length) return;
      const latest = toned[toned.length - 1];
      const prior = toned.length > 1 ? toned[toned.length - 2] : null;
      const drift = (prior && isNum(latest.score) && isNum(prior.score)) ? latest.score - prior.score : 0;
      members.push({
        companyId: id, name: (c && c.name) || id,
        toneId: latest.toneId, quarter: latest.quarter,
        direction: latest.direction || null, driver: latest.driver || null,
        drift
      });
    });

    if (!members.length) {
      return {
        id: theme.id, label: theme.label, bucket: theme.bucket, listenFor: theme.listenFor,
        state: 'No company in this theme has a classified quarter yet.',
        mood: null, members: [], drivers: []
      };
    }

    /* the balance of what the member companies sounded like */
    const pos = members.filter((m) => (m.direction ? m.direction === 'positive' : TONE_DIRECTION[m.toneId] > 0)).length;
    const neg = members.filter((m) => (m.direction ? m.direction === 'negative' : TONE_DIRECTION[m.toneId] < 0)).length;
    const mood = pos > neg ? 'positive' : (neg > pos ? 'negative' : 'mixed');

    /* who moved: a two-step drift is the loudest thing a theme can contain */
    const drivers = members.slice()
      .sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift))
      .filter((m, i) => Math.abs(m.drift) >= 2 || i < 2)
      .slice(0, 3);

    const moved = members.filter((m) => Math.abs(m.drift) >= 2);
    const word = mood === 'positive' ? 'leaning positive'
               : mood === 'negative' ? 'leaning negative' : 'split';
    const state =
      `${members.length} compan${members.length === 1 ? 'y' : 'ies'} heard, ${word} ` +
      `(${pos} positive, ${neg} negative)` +
      (moved.length
        ? `; ${moved.map((m) => `${m.name} moved ${Math.abs(m.drift)} step${Math.abs(m.drift) === 1 ? '' : 's'} ${m.drift > 0 ? 'up' : 'down'}`).join(', ')}.`
        : '; no two-step move this quarter.');

    return {
      id: theme.id, label: theme.label, bucket: theme.bucket, listenFor: theme.listenFor,
      state, mood, members, drivers
    };
  });
}

/**
 * The summary read, assembled in a fixed structure so it says the same KINDS of
 * thing every quarter and only the facts move. Returned as labelled lines
 * rather than one blob, so the tab can lay them out and a test can check them.
 *
 * It states only what the scores already say. There is no sentence here that
 * needs a judgement the pipeline has not made.
 */
export function summaryLines({ scores, stage, divergence, macro, drift }, framework) {
  const stageOf = (id) => ((framework && framework.cycleStages) || []).find((s) => s.id === id);
  const s = scores || {};
  const lines = [];

  const st = stage && stage.stageId ? stageOf(stage.stageId) : null;
  const stageWords = st
    ? ((st.plainLabel && st.label && st.plainLabel !== st.label)
        ? `${st.label} (${st.plainLabel})` : (st.label || st.plainLabel || st.id))
    : 'not called';

  /* The direction word each bucket gets in the paragraph, in the language of
     the 4b table rather than a number. */
  const WORD = {
    'strong-positive': 'strongly positive', 'positive': 'positive', 'flat': 'flat',
    'negative': 'negative', 'strong-negative': 'strongly negative'
  };
  const dirOf = (id) => {
    const g = s[id];
    if (!g || !isNum(g.score)) return 'not yet scoreable';
    const w = WORD[g.level] || 'flat';
    return g.direction && g.direction !== 'flat' ? `${w} and ${g.direction}` : w;
  };
  /* "driven by [strongest 2-3 signals]" - the double-weighted inputs, which are
     precisely the ones the brief says matter most. */
  const signalsOf = (id) => {
    const g = s[id];
    const sig = (g && g.signals) || [];
    if (!sig.length) return null;
    return sig.slice(0, 3).map((x) => x.kind === 'tone'
      ? `${x.company} tone on ${x.label}`
      : `${x.company} ${x.label}`).join(', ');
  };

  lines.push({ id: 'call', label: 'Cycle call', text: stageWords + '.' });

  const lSig = signalsOf('leading');
  lines.push({
    id: 'leading', label: 'Leading indicators',
    text: `Leading indicators are ${dirOf('leading')}` + (lSig ? ` — driven by ${lSig}.` : '.')
  });

  const cSig = signalsOf('coincident');
  lines.push({
    id: 'coincident', label: 'Coincident indicators',
    text: `Coincident indicators are ${dirOf('coincident')}` + (cSig ? ` — ${cSig}.` : '.')
  });

  /* "Macro backdrop: [Step 1 flags + percentiles]" - the tiles themselves, each
     with its direction and where it sits in its own 12 months. */
  if (macro && (macro.tiles || []).length) {
    const named = macro.tiles.filter((t) => t.direction).map((t) =>
      `${t.label} ${t.direction}${isNum(t.percentile) ? ` (${t.percentile}th pctile)` : ''}`);
    lines.push({
      id: 'macro', label: 'Macro backdrop',
      text: (named.length ? named.join('; ') + '.' : 'No market series has a direction yet.') +
        (macro.conflict ? ' Flagged for manual review: the backdrop and the scores disagree.' : '')
    });
  }

  if (divergence && isNum(divergence.value)) {
    lines.push({
      id: 'divergence', label: 'Divergence',
      text: `Leading minus coincident is ${divergence.value > 0 ? '+' : ''}${divergence.value}. ` +
        (divergence.signsDiffer
          ? (divergence.value > 0
              ? 'The two buckets are on opposite sides of zero with leading ahead — the early-upcycle entry signal.'
              : 'The two buckets are on opposite sides of zero with leading behind — leading is rolling over while coincident still looks strong, the highest-value warning this instrument produces.')
          : 'Both buckets sit on the same side of zero, so this is a matter of degree rather than a turn.')
    });
  }

  const d = drift || [];
  lines.push({
    id: 'watchlist', label: 'Tone drift watchlist',
    text: d.length
      ? d.slice(0, 6).map((x) => `${x.name} (${x.from} → ${x.to})`).join('; ') +
        (d.length > 6 ? `; and ${d.length - 6} more` : '') + '.'
      : 'No company moved two tone steps or more this quarter.'
  });

  /* "Implication for the next 1-2 quarters: [one sentence]" - taken from the
     called stage's own meaning, not invented per run. */
  lines.push({
    id: 'implication', label: 'Implication for the next 1–2 quarters',
    text: st
      ? (st.implication || st.meaning || 'See the stage description.')
      : 'No stage has been called, so no implication is drawn.'
  });

  return lines;
}

/**
 * The research shortlist for the called stage - the client's stage-5b table,
 * read from framework.json so the wording is theirs to change. Every row
 * carries the stage it came from, because the panel has to show that.
 */
export function actionsFor(stageId, framework) {
  const table = (framework && framework.stageActions && framework.stageActions.byStage) || {};
  const row = table[stageId];
  if (!row) return null;
  const stage = ((framework && framework.cycleStages) || []).find((s) => s.id === stageId);
  return {
    stageId,
    stageLabel: (stage && stage.label) || stageId,
    stagePlainLabel: (stage && stage.plainLabel) || stageId,
    why: row.why || '',
    research: (row.research || []).map((r) => ({ ...r }))
  };
}

/**
 * Append this reading to the run history, so the instrument can be checked
 * against itself.
 *
 * The brief: "Never overwrite history: each refresh is versioned. Prior stage
 * calls, scores and reads are retained so the dashboard's own call history can
 * be audited against what actually happened - the instrument should be
 * back-testable against itself."
 *
 * Only the reading is kept, not the whole payload: the point is to be able to
 * ask "what did this dashboard say in Q2, and was it right?", which needs the
 * call, the scores and the divergence - not a second copy of every alert.
 *
 * A re-run inside the same quarter REPLACES that quarter's entry rather than
 * appending a second one, because a quarter has one reading, not one per time
 * somebody pressed refresh. The scoring version rides along so a later reader
 * can tell which entries are comparable with which.
 */
export function appendHistory(history, payload, limit = 80) {
  const prior = (history && Array.isArray(history.readings)) ? history.readings.slice() : [];
  const entry = {
    asOf: payload.asOf || null,
    generatedAt: payload.generatedAt || null,
    scoringVersion: payload.scoringVersion || null,
    stageId: (payload.stage && payload.stage.stageId) || null,
    stageRuleId: (payload.stage && payload.stage.ruleId) || null,
    position: (payload.stage && payload.stage.position) ?? null,
    scores: Object.fromEntries(Object.keys(payload.scores || {}).map(
      (k) => [k, payload.scores[k] ? payload.scores[k].score : null])),
    divergence: (payload.divergence && payload.divergence.value) ?? null,
    signsDiffer: !!(payload.divergence && payload.divergence.signsDiffer),
    macroConflict: !!(payload.macro && payload.macro.conflict),
    alertCount: (payload.alerts || []).length
  };

  const at = entry.asOf ? prior.findIndex((r) => r.asOf === entry.asOf) : -1;
  if (at > -1) prior[at] = entry; else prior.push(entry);

  return {
    schemaVersion: 1,
    title: 'Cycle reading history',
    note: 'One entry per reported quarter, oldest first. Re-running inside a ' +
          'quarter replaces that quarter\'s entry rather than adding another: a ' +
          'quarter has one reading, not one per refresh. scoringVersion says ' +
          'which entries are comparable with which.',
    readings: prior.slice(-limit)
  };
}

/**
 * A compact snapshot of a reading, small enough to keep inside the next one so
 * the change log has something real to diff against.
 */
export function snapshotOf(payload) {
  if (!payload) return null;
  const scores = {};
  Object.keys(payload.scores || {}).forEach((k) => { scores[k] = payload.scores[k] ? payload.scores[k].score : null; });
  return {
    generatedAt: payload.generatedAt || null,
    asOf: payload.asOf || null,
    scoringVersion: payload.scoringVersion || null,
    stageId: (payload.stage && payload.stage.stageId) || null,
    scores,
    /* the alert identities, so a repeat of the same alert is not "new" */
    alertIds: (payload.alerts || []).map((a) => a.id).sort()
  };
}

/**
 * What moved since the previous run. The client asks a returning reader to be
 * able to read the delta rather than the whole board.
 *
 * The first run has nothing to compare against and says so - it does not
 * manufacture a change list out of its own starting state.
 */
export function changesSince(prev, payload, framework) {
  if (!prev) {
    return [{ kind: 'first-run', text: 'First reading on record - nothing to compare against yet.' }];
  }
  /* A scoring change makes the numbers incomparable. Saying "leading moved down
     58 points" across a rescale would be describing the method, not the cycle. */
  if ((prev.scoringVersion || null) !== (payload.scoringVersion || null)) {
    return [{
      kind: 'method-change',
      text: 'The scoring method changed since the last refresh, so this quarter\'s ' +
            'scores are not comparable with the stored ones. The change log resumes next run.'
    }];
  }
  const out = [];
  const stageOf = (id) => ((framework && framework.cycleStages) || []).find((s) => s.id === id);
  const nameOf = (id) => {
    const g = ((framework && framework.groupMeta) || []).find((m) => m.id === id);
    return (g && (g.plainLabel || g.label)) || id;
  };

  const nowStage = (payload.stage && payload.stage.stageId) || null;
  if (prev.stageId !== nowStage) {
    const a = prev.stageId ? (stageOf(prev.stageId) || {}).plainLabel || prev.stageId : 'no call';
    const b = nowStage ? (stageOf(nowStage) || {}).plainLabel || nowStage : 'no call';
    out.push({ kind: 'stage-call', text: `The cycle call moved from ${a} to ${b}.` });
  }

  Object.keys(payload.scores || {}).forEach((id) => {
    const before = prev.scores ? prev.scores[id] : null;
    const after = payload.scores[id] ? payload.scores[id].score : null;
    if (!isNum(before) || !isNum(after)) {
      if (!isNum(before) && isNum(after)) out.push({ kind: 'score', text: `${nameOf(id)} has a score for the first time (${after}).` });
      return;
    }
    const move = after - before;
    if (Math.abs(move) >= DELTA_BAND) {
      out.push({ kind: 'score', text: `${nameOf(id)} moved ${move > 0 ? 'up' : 'down'} ${Math.abs(move)} points to ${after}.` });
    }
  });

  const seen = new Set(prev.alertIds || []);
  (payload.alerts || []).forEach((a) => {
    if (!seen.has(a.id)) out.push({ kind: 'alert', text: 'New alert: ' + a.text });
  });

  if (!out.length) out.push({ kind: 'none', text: 'Nothing material moved since the last refresh.' });
  return out;
}

/**
 * Assemble the whole scores payload - what data/scores.json holds and what the
 * Cockpit, the macro consistency panel and the Insight tab all read.
 */
export function buildScores({ kpis, companies, framework, macro, commentary, generatedAt, previous }) {
  const toneInputs = toneInputsByBucket(commentary, framework);
  const scores = bucketScores(kpis, companies, { toneInputs });
  const divergence = divergenceOf(scores);
  const stage = stageCall(scores, framework && framework.cycleStages);
  const macroVerdict = macroAgreement(macro, scores);
  /* 4b's Macro backdrop column: does crude corroborate the called stage? */
  const stageMacro = stageMacroCheck(stage.stageId, macroVerdict);
  const drift = toneDrift(commentary, 2);
  const coverage = coverageWarnings(scores, framework && framework.groupMeta);
  const alerts = buildAlerts({ macro: macroVerdict, scores, coverage, drift, divergence, stageMacro });

  /* The divergence history: the same calculation walked back a quarter at a time.
     Only the steps that still have enough quarters to flag produce a number; the
     rest are null rather than carried forward. */
  const divergenceSeries = [3, 2, 1, 0].map((drop) => {
    const at = {};
    ((companies && companies.groups) || []).forEach((g) => { at[g.id] = scoreGroup(kpis, g, drop); });
    const L = at.leading && at.leading.score, C = at.coincident && at.coincident.score;
    return (isNum(L) && isNum(C)) ? L - C : null;
  });

  const payload = {
    schemaVersion: 1,
    title: 'Cycle scores',
    generatedBy: 'pipeline/rescore.mjs',
    generatedAt: generatedAt || null,
    note: 'Bucket scores are the mean momentum of every flagged KPI in the group, ' +
          '0-100 with 50 neutral. The previous quarter is the same calculation on a ' +
          'series one quarter shorter, so the change arrow is a measurement, not a memory. ' +
          'A group with nothing flagged scores null.',
    sourceTag: 'derived',
    scoringVersion: SCORING_VERSION,
    /* the weighting published with the numbers, so the score is arguable */
    scoringMap: { score: FLAG_SCORE, weight: FLAG_WEIGHT, toneDirection: TONE_DIRECTION },
    quarters: (kpis && kpis.quarters) || [],
    asOf: (kpis && kpis.quarters && kpis.quarters[kpis.quarters.length - 1]) || null,
    scores,
    divergence,
    divergenceSeries,
    stage,
    macro: macroVerdict,
    stageMacro,
    toneDrift: drift,
    coverageWarnings: coverage,
    alerts
  };

  /* Section 5 reads these three off the same payload, so the summary, the
     shortlist and the change log can never describe a different reading from
     the one the Cockpit is showing. */
  payload.summary = summaryLines(
    { scores, stage, divergence, macro: macroVerdict, drift }, framework);
  payload.actions = actionsFor(stage.stageId, framework);
  payload.themes = themeRollup(commentary, framework);
  payload.changes = changesSince(previous, payload, framework);
  payload.previous = previous || null;

  return payload;
}
