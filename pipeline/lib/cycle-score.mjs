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

import { flagFor } from './kpi-flag.mjs';

/**
 * What each trajectory flag is worth, 0-100, with 50 as "no news".
 *
 * The two inflection flags sit half a step off neutral rather than at the
 * extremes: a series that has *just* turned is a turn, not yet a trend, and the
 * client's own framing treats "just turned up" as the early-warning subset
 * rather than as strength already delivered. Accelerating and decelerating are
 * the poles because they describe momentum that is already in the numbers.
 */
export const FLAG_MOMENTUM = {
  'accelerating':    100,
  'inflecting-up':    75,
  'steady':           50,
  'inflecting-down':  25,
  'decelerating':      0
};

/** Neutral midpoint of every 0-100 score in this module. */
export const NEUTRAL = 50;

/* A score this far off neutral is "strong" / "weak" rather than middling, and a
   quarter-on-quarter move this big is a real direction rather than noise. Both
   are dead-bands: without them a 50.4 would read as strength. */
const LEVEL_BAND = 5;
const DELTA_BAND = 2;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** 'strong' | 'weak' | 'neutral' — where a 0-100 score sits against midpoint. */
export function levelOf(score) {
  if (!isNum(score)) return null;
  if (score >= NEUTRAL + LEVEL_BAND) return 'strong';
  if (score <= NEUTRAL - LEVEL_BAND) return 'weak';
  return 'neutral';
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
export function scoreGroup(kpisJson, group, drop = 0) {
  const band = isNum(kpisJson && kpisJson.flatBandPct) ? kpisJson.flatBandPct : 1.5;
  const byId = (kpisJson && kpisJson.companies) || {};
  let sum = 0, scored = 0, total = 0;
  const companies = new Set();

  (group.companies || []).forEach((c) => {
    const entry = byId[c.id];
    if (!entry || !Array.isArray(entry.kpis)) return;
    entry.kpis.forEach((k) => {
      total++;
      const values = Array.isArray(k.values) ? k.values : [];
      /* Walking back means dropping the newest quarters, not the oldest: the
         window is oldest-first, so slice from the end. */
      const window = drop > 0 ? values.slice(0, values.length - drop) : values;
      const flag = flagFor(window, k.flagBasis, band);
      const momentum = flag ? FLAG_MOMENTUM[flag] : undefined;
      if (!isNum(momentum)) return;
      sum += momentum;
      scored++;
      companies.add(c.id);
    });
  });

  return {
    score: scored ? Math.round(sum / scored) : null,
    kpisScored: scored,
    kpisTotal: total,
    companiesScored: companies.size
  };
}

/**
 * All three bucket scores, each with the same measurement taken one quarter
 * back so the change arrow is real.
 *
 * @returns {Record<string, {score:number|null, prev:number|null, delta:number|null,
 *   level:string|null, direction:string|null, kpisScored:number, kpisTotal:number,
 *   companiesScored:number}>}
 */
export function bucketScores(kpisJson, companiesJson) {
  const out = {};
  ((companiesJson && companiesJson.groups) || []).forEach((g) => {
    const now = scoreGroup(kpisJson, g, 0);
    const before = scoreGroup(kpisJson, g, 1);
    const delta = isNum(now.score) && isNum(before.score) ? now.score - before.score : null;
    out[g.id] = {
      score: now.score,
      prev: before.score,
      delta,
      level: levelOf(now.score),
      direction: directionOf(delta),
      kpisScored: now.kpisScored,
      kpisTotal: now.kpisTotal,
      companiesScored: now.companiesScored
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
  const sign = (x) => (x > NEUTRAL + LEVEL_BAND ? 1 : x < NEUTRAL - LEVEL_BAND ? -1 : 0);
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
    id: 'leading-rolls-over',
    label: 'Leading rolling over while coincident is still hot',
    stageId: 'late-upcycle',
    when: (L, C) => L.direction === 'falling' && C.level === 'strong'
  },
  {
    id: 'weakness-spreading',
    label: 'Leading weak and coincident now falling with it',
    stageId: 'early-downcycle',
    when: (L, C) => L.level === 'weak' && C.direction === 'falling'
  },
  {
    id: 'broad-strength',
    label: 'Leading and coincident both strong',
    stageId: 'mid-upcycle',
    when: (L, C) => L.level === 'strong' && C.level === 'strong'
  },
  {
    id: 'leading-turns-first',
    label: 'Leading strong or rising, coincident not yet following',
    stageId: 'early-upcycle',
    when: (L, C) => (L.level === 'strong' || L.direction === 'rising') && C.level !== 'strong'
  },
  {
    id: 'broad-weakness',
    label: 'Leading and coincident both weak',
    stageId: 'trough',
    when: (L, C) => L.level === 'weak' && C.level === 'weak'
  },
  {
    id: 'no-clear-signal',
    label: 'No group far enough from neutral to call a turn',
    stageId: 'mid-upcycle',
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
  if (!L || !C || !isNum(L.score) || !isNum(C.score)) {
    return {
      stageId: null, position: null, ruleId: null, ruleLabel: null,
      confidence: 'none',
      because: ['No cycle call: the leading or coincident group has no scored KPI yet.']
    };
  }

  const rule = STAGE_RULES.find((r) => r.when(L, C)) || STAGE_RULES[STAGE_RULES.length - 1];
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
    `coincident ${C.score} (${C.level}${C.direction ? ', ' + C.direction : ''}).`,
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
    tiles.push({ id: t.id, label: t.shortLabel || t.label, direction: dir, supports: t.supports, vote });
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
export function coverageWarnings(scores, groupMeta, minKpis = 5, minShare = 0.4) {
  const nameOf = (id) => {
    const g = (groupMeta || []).find((m) => m.id === id);
    return (g && (g.plainLabel || g.label)) || id;
  };
  const out = [];
  Object.keys(scores || {}).forEach((id) => {
    const s = scores[id];
    if (!s) return;
    if (s.score === null) {
      out.push({ groupId: id, kind: 'no-score', text: `${nameOf(id)}: no KPI has enough quarters to flag yet.` });
      return;
    }
    const share = s.kpisTotal ? s.kpisScored / s.kpisTotal : 0;
    if (s.kpisScored < minKpis || share < minShare) {
      out.push({
        groupId: id,
        kind: 'thin',
        text: `${nameOf(id)}: scored on ${s.kpisScored} of ${s.kpisTotal} KPIs.`
      });
    }
  });
  return out;
}

/**
 * The alert strip, in the order the client listed it: macro conflict first
 * (it questions the whole reading), then thin coverage, then tone drift.
 */
export function buildAlerts({ macro, scores, coverage, drift, divergence }) {
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
 * Assemble the whole scores payload - what data/scores.json holds and what the
 * Cockpit, the macro consistency panel and the Insight tab all read.
 */
export function buildScores({ kpis, companies, framework, macro, commentary, generatedAt }) {
  const scores = bucketScores(kpis, companies);
  const divergence = divergenceOf(scores);
  const stage = stageCall(scores, framework && framework.cycleStages);
  const macroVerdict = macroAgreement(macro, scores);
  const drift = toneDrift(commentary, 2);
  const coverage = coverageWarnings(scores, framework && framework.groupMeta);
  const alerts = buildAlerts({ macro: macroVerdict, scores, coverage, drift, divergence });

  /* The divergence history: the same calculation walked back a quarter at a time.
     Only the steps that still have enough quarters to flag produce a number; the
     rest are null rather than carried forward. */
  const divergenceSeries = [3, 2, 1, 0].map((drop) => {
    const at = {};
    ((companies && companies.groups) || []).forEach((g) => { at[g.id] = scoreGroup(kpis, g, drop); });
    const L = at.leading && at.leading.score, C = at.coincident && at.coincident.score;
    return (isNum(L) && isNum(C)) ? L - C : null;
  });

  return {
    schemaVersion: 1,
    title: 'Cycle scores',
    generatedBy: 'pipeline/rescore.mjs',
    generatedAt: generatedAt || null,
    note: 'Bucket scores are the mean momentum of every flagged KPI in the group, ' +
          '0-100 with 50 neutral. The previous quarter is the same calculation on a ' +
          'series one quarter shorter, so the change arrow is a measurement, not a memory. ' +
          'A group with nothing flagged scores null.',
    sourceTag: 'derived',
    momentumMap: FLAG_MOMENTUM,
    quarters: (kpis && kpis.quarters) || [],
    asOf: (kpis && kpis.quarters && kpis.quarters[kpis.quarters.length - 1]) || null,
    scores,
    divergence,
    divergenceSeries,
    stage,
    macro: macroVerdict,
    toneDrift: drift,
    coverageWarnings: coverage,
    alerts
  };
}
