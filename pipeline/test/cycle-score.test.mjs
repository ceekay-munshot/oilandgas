import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FLAG_MOMENTUM, NEUTRAL, levelOf, directionOf, scoreGroup, bucketScores,
  divergenceOf, stageCall, STAGE_RULES, tileDirection, macroAgreement,
  toneDrift, coverageWarnings, buildAlerts, buildScores
} from '../lib/cycle-score.mjs';

/* ------------------------------------------------------------------ fixtures */

const FRAMEWORK = {
  cycleStages: [
    { id: 'trough',          range: [0, 20] },
    { id: 'early-upcycle',   range: [20, 40] },
    { id: 'mid-upcycle',     range: [40, 60] },
    { id: 'late-upcycle',    range: [60, 80] },
    { id: 'early-downcycle', range: [80, 100] }
  ],
  groupMeta: [
    { id: 'leading', plainLabel: 'Moves first' },
    { id: 'coincident', plainLabel: 'Moving now' },
    { id: 'lagging', plainLabel: 'Moves last' }
  ]
};

/* a rising series flags accelerating; a falling one decelerating */
const RISING = [10, 20, 40, 80];
const FALLING = [80, 40, 20, 10];
const FLAT = [50, 50, 50, 50];

function kpisWith(map, flatBandPct = 1.5) {
  const companies = {};
  Object.keys(map).forEach((id) => {
    companies[id] = { kpis: map[id].map((values, i) => ({ id: 'k' + i, flagBasis: 'level', values })) };
  });
  return { flatBandPct, quarters: ['Q1', 'Q2', 'Q3', 'Q4'], companies };
}
const groupsOf = (spec) => ({
  groups: Object.keys(spec).map((id) => ({ id, companies: spec[id].map((c) => ({ id: c })) }))
});

/* ------------------------------------------------------------ momentum & bands */

test('every trajectory flag has a momentum value, neutral in the middle', () => {
  assert.equal(FLAG_MOMENTUM.steady, NEUTRAL);
  assert.equal(FLAG_MOMENTUM.accelerating, 100);
  assert.equal(FLAG_MOMENTUM.decelerating, 0);
  /* inflections are half steps - a turn is not yet a trend */
  assert.ok(FLAG_MOMENTUM['inflecting-up'] > NEUTRAL && FLAG_MOMENTUM['inflecting-up'] < 100);
  assert.ok(FLAG_MOMENTUM['inflecting-down'] < NEUTRAL && FLAG_MOMENTUM['inflecting-down'] > 0);
});

test('levelOf and directionOf respect their dead bands', () => {
  assert.equal(levelOf(70), 'strong');
  assert.equal(levelOf(30), 'weak');
  assert.equal(levelOf(52), 'neutral');           /* inside the band */
  assert.equal(levelOf(null), null);
  assert.equal(directionOf(5), 'rising');
  assert.equal(directionOf(-5), 'falling');
  assert.equal(directionOf(1), 'flat');           /* inside the band */
  assert.equal(directionOf(null), null);
});

/* --------------------------------------------------------------- group scores */

test('a group of rising KPIs scores high, falling scores low', () => {
  const kpis = kpisWith({ a: [RISING, RISING] });
  const g = { id: 'leading', companies: [{ id: 'a' }] };
  assert.equal(scoreGroup(kpis, g).score, 100);

  const down = kpisWith({ a: [FALLING, FALLING] });
  assert.equal(scoreGroup(down, g).score, 0);
});

test('a group with nothing flaggable scores null, never 50', () => {
  /* two points is below the three the flag needs */
  const kpis = kpisWith({ a: [[1, 2]] });
  const g = { id: 'leading', companies: [{ id: 'a' }] };
  const out = scoreGroup(kpis, g);
  assert.equal(out.score, null);
  assert.equal(out.kpisScored, 0);
  assert.equal(out.kpisTotal, 1);
});

test('a missing company contributes nothing and does not throw', () => {
  const kpis = kpisWith({ a: [RISING] });
  const g = { id: 'leading', companies: [{ id: 'a' }, { id: 'ghost' }] };
  const out = scoreGroup(kpis, g);
  assert.equal(out.score, 100);
  assert.equal(out.companiesScored, 1);
});

test('drop walks the calculation back a quarter, dropping newest first', () => {
  /* falls then turns up hard on the last quarter: now inflecting-up, before falling */
  const turn = [100, 60, 20, 90];
  const kpis = kpisWith({ a: [turn] });
  const g = { id: 'leading', companies: [{ id: 'a' }] };
  assert.equal(scoreGroup(kpis, g, 0).score, FLAG_MOMENTUM['inflecting-up']);
  assert.equal(scoreGroup(kpis, g, 1).score, FLAG_MOMENTUM['decelerating']);
});

test('bucketScores reports the delta between now and one quarter back', () => {
  const turn = [100, 60, 20, 90];
  const kpis = kpisWith({ a: [turn] });
  const s = bucketScores(kpis, groupsOf({ leading: ['a'] }));
  assert.equal(s.leading.score, 75);
  assert.equal(s.leading.prev, 0);
  assert.equal(s.leading.delta, 75);
  assert.equal(s.leading.direction, 'rising');
});

/* ---------------------------------------------------------------- divergence */

test('divergence is leading minus COINCIDENT, per the client definition', () => {
  const d = divergenceOf({ leading: { score: 80 }, coincident: { score: 30 }, lagging: { score: 0 } });
  assert.equal(d.value, 50);
});

test('the alert fires only when the two sit on opposite sides of neutral', () => {
  /* wide gap, same side - not a divergence */
  assert.equal(divergenceOf({ leading: { score: 90 }, coincident: { score: 60 } }).signsDiffer, false);
  /* smaller gap, opposite sides - this is the one worth waking someone for */
  assert.equal(divergenceOf({ leading: { score: 60 }, coincident: { score: 40 } }).signsDiffer, true);
  /* one group inside the dead band is not "the opposite" of anything */
  assert.equal(divergenceOf({ leading: { score: 70 }, coincident: { score: 50 } }).signsDiffer, false);
});

test('divergence with a missing score is null, not zero', () => {
  const d = divergenceOf({ leading: { score: null }, coincident: { score: 40 } });
  assert.equal(d.value, null);
  assert.equal(d.signsDiffer, false);
});

/* --------------------------------------------------------------- stage rules */

const G = (score, prev) => ({
  score, prev,
  delta: (score !== null && prev !== null) ? score - prev : null,
  level: levelOf(score),
  direction: directionOf((score !== null && prev !== null) ? score - prev : null),
  kpisScored: 8, kpisTotal: 10
});

test('leading rolling over while coincident is hot calls the peak', () => {
  const call = stageCall({ leading: G(60, 80), coincident: G(75, 75) }, FRAMEWORK.cycleStages);
  assert.equal(call.ruleId, 'leading-rolls-over');
  assert.equal(call.stageId, 'late-upcycle');
});

test('leading weak with coincident falling calls the downcycle', () => {
  const call = stageCall({ leading: G(30, 32), coincident: G(40, 60) }, FRAMEWORK.cycleStages);
  assert.equal(call.ruleId, 'weakness-spreading');
  assert.equal(call.stageId, 'early-downcycle');
});

test('both strong is mid upcycle; leading alone is early upcycle', () => {
  assert.equal(stageCall({ leading: G(80, 80), coincident: G(70, 70) }, FRAMEWORK.cycleStages).stageId, 'mid-upcycle');
  assert.equal(stageCall({ leading: G(80, 80), coincident: G(45, 45) }, FRAMEWORK.cycleStages).stageId, 'early-upcycle');
});

test('both weak is the trough', () => {
  const call = stageCall({ leading: G(20, 20), coincident: G(25, 25) }, FRAMEWORK.cycleStages);
  assert.equal(call.ruleId, 'broad-weakness');
  assert.equal(call.stageId, 'trough');
});

test('nothing off neutral falls through to the low-confidence row', () => {
  const call = stageCall({ leading: G(50, 50), coincident: G(50, 50) }, FRAMEWORK.cycleStages);
  assert.equal(call.ruleId, 'no-clear-signal');
  assert.equal(call.confidence, 'low');
});

test('the rule table is exhaustive - the last row always matches', () => {
  assert.equal(STAGE_RULES[STAGE_RULES.length - 1].when(), true);
});

test('no scores means no stage call, not a default stage', () => {
  const call = stageCall({ leading: G(null, null), coincident: G(null, null) }, FRAMEWORK.cycleStages);
  assert.equal(call.stageId, null);
  assert.equal(call.position, null);
  assert.equal(call.confidence, 'none');
});

test('the position always lands inside the called stage band', () => {
  const cases = [
    [G(80, 60), G(70, 70)], [G(20, 20), G(25, 25)],
    [G(60, 80), G(75, 75)], [G(80, 80), G(45, 45)], [G(50, 50), G(50, 50)]
  ];
  cases.forEach(([L, C]) => {
    const call = stageCall({ leading: L, coincident: C }, FRAMEWORK.cycleStages);
    const stage = FRAMEWORK.cycleStages.find((s) => s.id === call.stageId);
    assert.ok(call.position >= stage.range[0] && call.position <= stage.range[1],
      `${call.stageId} position ${call.position} outside ${stage.range}`);
  });
});

test('the stage call always names the row that produced it', () => {
  const call = stageCall({ leading: G(80, 80), coincident: G(45, 45) }, FRAMEWORK.cycleStages);
  assert.ok(call.ruleLabel && call.because.length >= 2);
});

/* -------------------------------------------------------------------- macro */

const tile = (id, supports, values) => ({
  id, supports,
  lines: [{ primary: true, series: values.map((v, i) => ({ date: '2026-0' + (i + 1) + '-01', value: v })) }]
});

test('tileDirection needs enough history, else says nothing', () => {
  assert.equal(tileDirection(tile('x', 'up', [10]), 3, 1.5), null);
  assert.equal(tileDirection(tile('x', 'up', [10, 11, 12, 20]), 3, 1.5), 'rising');
  assert.equal(tileDirection(tile('x', 'up', [20, 12, 11, 10]), 3, 1.5), 'falling');
  assert.equal(tileDirection(tile('x', 'up', [10, 10, 10, 10]), 3, 1.5), 'flat');
});

test('a tile moving its supporting way is a vote for the cycle', () => {
  const macro = { flagLookbackMonths: 3, flatBandPct: 1.5, tiles: [
    tile('a', 'up', [10, 11, 12, 20]),      /* rising, supports up  -> supports */
    tile('b', 'down', [10, 11, 12, 20]),    /* rising, supports down -> opposes */
    tile('c', 'up', [10])                   /* no history            -> silent  */
  ] };
  const out = macroAgreement(macro, { leading: { delta: 10 } });
  assert.equal(out.supporting, 1);
  assert.equal(out.opposing, 1);
  assert.equal(out.silent, 1);
  assert.equal(out.macroBias, 'mixed');
});

test('macro conflict is flagged when backdrop and scores point opposite ways', () => {
  const macro = { flagLookbackMonths: 3, flatBandPct: 1.5, tiles: [
    tile('a', 'up', [20, 15, 12, 10]),      /* falling, supports up -> opposes */
    tile('b', 'up', [20, 15, 12, 10])
  ] };
  const out = macroAgreement(macro, { leading: { delta: 10 }, coincident: { delta: 10 } });
  assert.equal(out.macroBias, 'down');
  assert.equal(out.scoreBias, 'up');
  assert.equal(out.agree, false);
  assert.equal(out.conflict, true);
});

test('no macro and no deltas is an open verdict, not a false agreement', () => {
  const out = macroAgreement({ tiles: [] }, {});
  assert.equal(out.macroBias, null);
  assert.equal(out.agree, null);
  assert.equal(out.conflict, false);
});

/* --------------------------------------------------------------- tone drift */

const toned = (...steps) => ({ tones: steps.map(([q, id, sc]) => ({ quarter: q, toneId: id, score: sc })) });

test('a two-step tone move is reported, a one-step move is not', () => {
  const c = { companies: {
    big: { name: 'Big', ...toned(['Q3', 'confident', 5], ['Q4', 'neutral', 3]) },
    small: { name: 'Small', ...toned(['Q3', 'confident', 5], ['Q4', 'constructive', 4]) }
  } };
  const out = toneDrift(c, 2);
  assert.equal(out.length, 1);
  assert.equal(out[0].companyId, 'big');
  assert.equal(out[0].steps, -2);
  assert.equal(out[0].direction, 'down');
});

test('nulls are skipped and the two most recent CLASSIFIED quarters compared', () => {
  const c = { companies: { a: { name: 'A', tones: [
    { quarter: 'Q1', toneId: 'defensive', score: 1 },
    { quarter: 'Q2', toneId: null, score: null },
    { quarter: 'Q3', toneId: 'confident', score: 5 }
  ] } } };
  const out = toneDrift(c, 2);
  assert.equal(out.length, 1);
  assert.equal(out[0].steps, 4);
  assert.equal(out[0].fromQuarter, 'Q1');
  assert.equal(out[0].quarter, 'Q3');
});

test('one classified quarter cannot drift', () => {
  const c = { companies: { a: { name: 'A', ...toned(['Q4', 'confident', 5]) } } };
  assert.equal(toneDrift(c, 2).length, 0);
});

test('drift is sorted with the biggest move first', () => {
  const c = { companies: {
    a: { name: 'A', ...toned(['Q3', 'confident', 5], ['Q4', 'cautious', 2]) },
    b: { name: 'B', ...toned(['Q3', 'confident', 5], ['Q4', 'defensive', 1]) }
  } };
  assert.equal(toneDrift(c, 2)[0].companyId, 'b');
});

/* ------------------------------------------------------------ coverage/alerts */

test('a thin or absent group raises a coverage warning', () => {
  const w = coverageWarnings({
    leading: { score: 60, kpisScored: 2, kpisTotal: 20 },
    coincident: { score: 60, kpisScored: 18, kpisTotal: 20 },
    lagging: { score: null, kpisScored: 0, kpisTotal: 6 }
  }, FRAMEWORK.groupMeta);
  const kinds = Object.fromEntries(w.map((x) => [x.groupId, x.kind]));
  assert.equal(kinds.leading, 'thin');
  assert.equal(kinds.lagging, 'no-score');
  assert.equal(kinds.coincident, undefined);
  assert.ok(w[0].text.includes('Moves first'));      /* plain label, not the id */
});

test('the alert strip leads with divergence, then macro conflict', () => {
  const alerts = buildAlerts({
    divergence: { signsDiffer: true, value: 20 },
    macro: { conflict: true, macroBias: 'down', scoreBias: 'up' },
    coverage: [{ groupId: 'lagging', kind: 'thin', text: 'thin' }],
    drift: [{ companyId: 'x', name: 'X', from: 'confident', to: 'cautious', steps: -3, direction: 'down', quarter: 'Q4' }]
  });
  assert.deepEqual(alerts.map((a) => a.kind),
    ['divergence', 'macro-conflict', 'low-coverage', 'tone-drift']);
  assert.equal(alerts[0].severity, 'high');
});

test('a clean board raises no alerts', () => {
  assert.equal(buildAlerts({ divergence: { signsDiffer: false }, macro: { conflict: false }, coverage: [], drift: [] }).length, 0);
});

/* -------------------------------------------------------------- whole payload */

test('buildScores assembles a payload with every section the tabs read', () => {
  const kpis = kpisWith({ a: [RISING, RISING], b: [FALLING], c: [FLAT] });
  const companies = groupsOf({ leading: ['a'], coincident: ['b'], lagging: ['c'] });
  const out = buildScores({
    kpis, companies, framework: FRAMEWORK,
    macro: { flagLookbackMonths: 3, flatBandPct: 1.5, tiles: [tile('a', 'up', [10, 11, 12, 20])] },
    commentary: { companies: { a: { name: 'A', ...toned(['Q3', 'confident', 5], ['Q4', 'cautious', 2]) } } },
    generatedAt: '2026-07-28T00:00:00.000Z'
  });
  assert.equal(out.scores.leading.score, 100);
  assert.equal(out.scores.coincident.score, 0);
  assert.equal(out.divergence.value, 100);
  assert.equal(out.divergence.signsDiffer, true);
  assert.ok(out.stage.stageId);
  assert.equal(out.sourceTag, 'derived');
  assert.equal(out.toneDrift.length, 1);
  assert.ok(out.alerts.some((a) => a.kind === 'divergence'));
  assert.equal(out.divergenceSeries.length, 4);
  /* the oldest steps have too few quarters to flag, so they are null not carried */
  assert.equal(out.divergenceSeries[0], null);
  assert.equal(out.divergenceSeries[3], 100);
});

test('buildScores survives absent macro and commentary', () => {
  const kpis = kpisWith({ a: [RISING] });
  const companies = groupsOf({ leading: ['a'] });
  const out = buildScores({ kpis, companies, framework: FRAMEWORK, macro: null, commentary: null });
  assert.equal(out.scores.leading.score, 100);
  assert.equal(out.toneDrift.length, 0);
  assert.equal(out.macro.macroBias, null);
});
