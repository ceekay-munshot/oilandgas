import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FLAG_SCORE, FLAG_WEIGHT, TONE_DIRECTION, NEUTRAL, levelOf, directionOf,
  scoreGroup, bucketScores, toneInputsByBucket, divergenceOf, stageCall,
  STAGE_RULES, tileDirection, tilePercentile, macroAgreement,
  toneDrift, coverageWarnings, buildAlerts, buildScores
} from '../lib/cycle-score.mjs';

/* ------------------------------------------------------------------ fixtures */

const FRAMEWORK = {
  cycleStages: [
    { id: 'trough',          label: 'Trough',            range: [0, 20] },
    { id: 'early-upcycle',   label: 'Early Upcycle',     range: [20, 40] },
    { id: 'mid-upcycle',     label: 'Mid Upcycle',       range: [40, 60] },
    { id: 'late-upcycle',    label: 'Late Upcycle/Peak', range: [60, 80] },
    { id: 'early-downcycle', label: 'Early Downcycle',   range: [80, 100] }
  ],
  themes: { items: [
    { id: 'upstream-capex', label: 'Upstream capex intent', bucket: 'leading', companyIds: ['a'] },
    { id: 'freight-shipping', label: 'Freight outlook', bucket: 'lagging', companyIds: ['c'] }
  ] },
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

test('the brief\'s weighting: inflections count DOUBLE, steady is zero', () => {
  assert.equal(FLAG_SCORE.steady, NEUTRAL);
  assert.equal(FLAG_SCORE.accelerating, 1);
  /* "early warning - often precedes an inflection", so it scores negative */
  assert.equal(FLAG_SCORE.decelerating, -1);
  assert.equal(FLAG_SCORE['inflecting-up'], 1);
  assert.equal(FLAG_SCORE['inflecting-down'], -1);
  /* the rule the whole scoring turns on */
  assert.equal(FLAG_WEIGHT['inflecting-up'], 2);
  assert.equal(FLAG_WEIGHT['inflecting-down'], 2);
  assert.equal(FLAG_WEIGHT.accelerating, 1);
  assert.equal(FLAG_WEIGHT.steady, 1);
  assert.equal(FLAG_WEIGHT.decelerating, 1);
});

test('levelOf speaks the 4b table\'s language on a signed scale', () => {
  assert.equal(levelOf(70), 'strong-positive');
  assert.equal(levelOf(20), 'positive');
  assert.equal(levelOf(0), 'flat');
  assert.equal(levelOf(-20), 'negative');
  assert.equal(levelOf(-70), 'strong-negative');
  assert.equal(levelOf(null), null);
  assert.equal(directionOf(9), 'rising');
  assert.equal(directionOf(-9), 'falling');
  assert.equal(directionOf(1), 'flat');
  assert.equal(directionOf(null), null);
});

/* --------------------------------------------------------------- group scores */

test('a group of rising KPIs scores high, falling scores low', () => {
  const kpis = kpisWith({ a: [RISING, RISING] });
  const g = { id: 'leading', companies: [{ id: 'a' }] };
  assert.equal(scoreGroup(kpis, g).score, 100);

  const down = kpisWith({ a: [FALLING, FALLING] });
  assert.equal(scoreGroup(down, g).score, -100);
});

test('a group with nothing flaggable scores null, never zero', () => {
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
  assert.equal(scoreGroup(kpis, g, 0).score, 100);    /* inflecting-up  = +1 */
  assert.equal(scoreGroup(kpis, g, 1).score, -100);   /* decelerating   = -1 */
});

test('bucketScores reports the delta between now and one quarter back', () => {
  const turn = [100, 60, 20, 90];
  const kpis = kpisWith({ a: [turn] });
  const s = bucketScores(kpis, groupsOf({ leading: ['a'] }));
  assert.equal(s.leading.score, 100);
  assert.equal(s.leading.prev, -100);
  assert.equal(s.leading.delta, 200);
  assert.equal(s.leading.direction, 'rising');
});

/* ---------------------------------------------------------------- divergence */

test('divergence is leading minus COINCIDENT, per the client definition', () => {
  const d = divergenceOf({ leading: { score: 80 }, coincident: { score: 30 }, lagging: { score: 0 } });
  assert.equal(d.value, 50);
});

test('the alert fires only when the two sit on opposite sides of neutral', () => {
  /* wide gap, both positive - not a divergence */
  assert.equal(divergenceOf({ leading: { score: 90 }, coincident: { score: 40 } }).signsDiffer, false);
  /* smaller gap ACROSS zero - this is the one worth waking someone for */
  assert.equal(divergenceOf({ leading: { score: 20 }, coincident: { score: -20 } }).signsDiffer, true);
  /* one bucket inside the dead band is not "the opposite" of anything */
  assert.equal(divergenceOf({ leading: { score: 70 }, coincident: { score: 0 } }).signsDiffer, false);
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

test('4b: leading turning negative while coincident compresses = Early Downcycle', () => {
  const call = stageCall({ leading: G(-20, 10), coincident: G(30, 45), lagging: G(40, 40) }, FRAMEWORK.cycleStages);
  assert.equal(call.stageId, 'early-downcycle');
});

test('4b: leading positive but flattening with coincident at peak = Late Upcycle', () => {
  const call = stageCall({ leading: G(30, 30), coincident: G(60, 60), lagging: G(70, 70) }, FRAMEWORK.cycleStages);
  assert.equal(call.stageId, 'late-upcycle');
});

test('4b: leading strongly positive with coincident positive = Mid Upcycle', () => {
  const call = stageCall({ leading: G(70, 40), coincident: G(30, 10), lagging: G(15, 0) }, FRAMEWORK.cycleStages);
  assert.equal(call.stageId, 'mid-upcycle');
});

test('4b: leading turning up off a low base, coincident not following = Early Upcycle', () => {
  const call = stageCall({ leading: G(20, -30), coincident: G(-25, -30), lagging: G(-40, -45) }, FRAMEWORK.cycleStages);
  assert.equal(call.stageId, 'early-upcycle');
  assert.equal(call.ruleId, 'early-upcycle');
});

test('4b: all three negative = Trough', () => {
  const call = stageCall({ leading: G(-40, -40), coincident: G(-50, -50), lagging: G(-60, -60) }, FRAMEWORK.cycleStages);
  assert.equal(call.stageId, 'trough');
});

test('nothing off zero calls NO stage rather than defaulting to mid-cycle', () => {
  const call = stageCall({ leading: G(0, 0), coincident: G(0, 0), lagging: G(0, 0) }, FRAMEWORK.cycleStages);
  assert.equal(call.ruleId, 'no-clear-signal');
  assert.equal(call.stageId, null);        /* a stage is a claim; this board has not earned one */
  assert.equal(call.position, null);
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
    [G(-20, 10), G(30, 45), G(40, 40)], [G(30, 30), G(60, 60), G(70, 70)],
    [G(70, 40), G(30, 10), G(15, 0)],   [G(20, -30), G(-25, -30), G(-40, -45)],
    [G(-40, -40), G(-50, -50), G(-60, -60)]
  ];
  cases.forEach(([L, C, Gg]) => {
    const call = stageCall({ leading: L, coincident: C, lagging: Gg }, FRAMEWORK.cycleStages);
    const stage = FRAMEWORK.cycleStages.find((x) => x.id === call.stageId);
    assert.ok(stage, 'expected a stage for ' + JSON.stringify([L.score, C.score]));
    assert.ok(call.position >= stage.range[0] && call.position <= stage.range[1],
      `${call.stageId} position ${call.position} outside ${stage.range}`);
  });
});

test('the stage call always names the row that produced it and cites the lagging bucket', () => {
  const call = stageCall({ leading: G(70, 40), coincident: G(30, 10), lagging: G(15, 0) }, FRAMEWORK.cycleStages);
  assert.ok(call.ruleLabel && call.because.length >= 2);
  assert.ok(/lagging/.test(call.because[0]));
});

/* ------------------------------------------------------------- tone -> scores */

test('tone routes into buckets by THEME, not by company group', () => {
  const commentary = { companies: {
    a: { name: 'A', tones: [{ quarter: 'Q3', toneId: 'confident', score: 5 }] },
    c: { name: 'C', tones: [{ quarter: 'Q3', toneId: 'defensive', score: 1 }] }
  } };
  const out = toneInputsByBucket(commentary, FRAMEWORK);
  assert.equal(out.leading.length, 1);
  assert.equal(out.leading[0].value, TONE_DIRECTION.confident);
  assert.equal(out.lagging.length, 1);
  assert.equal(out.lagging[0].value, TONE_DIRECTION.defensive);
  assert.equal(out.coincident.length, 0);
});

test('a two-step tone drift carries double weight, a one-step does not', () => {
  const two = { companies: { a: { name: 'A', tones: [
    { quarter: 'Q2', toneId: 'confident', score: 5 }, { quarter: 'Q3', toneId: 'neutral', score: 3 }
  ] } } };
  const one = { companies: { a: { name: 'A', tones: [
    { quarter: 'Q2', toneId: 'confident', score: 5 }, { quarter: 'Q3', toneId: 'constructive', score: 4 }
  ] } } };
  assert.equal(toneInputsByBucket(two, FRAMEWORK).leading[0].weight, 2);
  assert.equal(toneInputsByBucket(one, FRAMEWORK).leading[0].weight, 1);
});

test('tone actually moves the bucket score', () => {
  const kpis = kpisWith({ a: [FLAT, FLAT] });            /* steady = 0 contribution */
  const groups = groupsOf({ leading: ['a'] });
  const plain = bucketScores(kpis, groups).leading.score;
  const withTone = bucketScores(kpis, groups, { toneInputs: {
    leading: [{ companyId: 'a', company: 'A', theme: 'Upstream', value: -1, weight: 2, drift: -2 }]
  } }).leading.score;
  assert.equal(plain, 0);
  assert.ok(withTone < plain, 'a defensive two-step drift must pull the bucket down');
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

test('the coverage guard fires at the brief\'s one-third of stale or one-off KPIs', () => {
  const w = coverageWarnings({
    /* 8 of 20 stale+one-off = 40%, over a third */
    leading: { score: 60, kpisScored: 12, kpisTotal: 20, staleKpis: 6, oneOffKpis: 2, lowCoverage: true },
    /* 6 of 20 = 30%, under a third - no warning */
    coincident: { score: 60, kpisScored: 18, kpisTotal: 20, staleKpis: 6, oneOffKpis: 0, lowCoverage: false },
    lagging: { score: null, kpisScored: 0, kpisTotal: 6, staleKpis: 0, oneOffKpis: 0, lowCoverage: false }
  }, FRAMEWORK.groupMeta);
  const kinds = Object.fromEntries(w.map((x) => [x.groupId, x.kind]));
  assert.equal(kinds.leading, 'low-coverage');
  assert.equal(kinds.lagging, 'no-score');
  assert.equal(kinds.coincident, undefined);
  assert.ok(w[0].text.includes('Moves first'));
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
    /* company 'a' sits in the upstream-capex theme, which feeds LEADING */
    commentary: { companies: { a: { name: 'A', ...toned(['Q3', 'confident', 5], ['Q4', 'cautious', 2]) } } },
    generatedAt: '2026-07-28T00:00:00.000Z'
  });
  /* Two accelerating KPIs (+1, weight 1 each) against a three-step tone
     deterioration (-1 at DOUBLE weight) nets to exactly zero. That is the
     brief's rule doing its job: commentary is not decoration, it scores. */
  assert.equal(out.scores.leading.score, 0);
  assert.equal(out.scores.leading.tonesScored, 1);
  assert.equal(out.scores.coincident.score, -100);
  assert.equal(out.divergence.value, 100);
  /* leading is inside the dead band, so this is a gap, not a sign split */
  assert.equal(out.divergence.signsDiffer, false);
  assert.equal(out.sourceTag, 'derived');
  assert.equal(out.toneDrift.length, 1);
  assert.equal(out.divergenceSeries.length, 4);
  assert.equal(out.divergenceSeries[0], null);
  assert.ok(Array.isArray(out.summary) && Array.isArray(out.changes));
});

test('buildScores survives absent macro and commentary', () => {
  const kpis = kpisWith({ a: [RISING] });
  const companies = groupsOf({ leading: ['a'] });
  const out = buildScores({ kpis, companies, framework: FRAMEWORK, macro: null, commentary: null });
  assert.equal(out.scores.leading.score, 100);
  assert.equal(out.toneDrift.length, 0);
  assert.equal(out.macro.macroBias, null);
});

/* --------------------------------------------- summary / actions / changelog */

import { summaryLines, actionsFor, snapshotOf, changesSince } from '../lib/cycle-score.mjs';

const FW5 = Object.assign({}, FRAMEWORK, {
  stageActions: { byStage: {
    'early-upcycle': { why: 'order books inflect here first', research: [
      { label: 'Deep Industries', companyId: 'a' }, { label: 'Man Industries', companyId: null }] },
    'trough': { why: 'establish baselines', research: [{ label: 'ONGC', companyId: 'a' }] }
  } }
});

test('the summary follows the brief\'s 5a structure, in order', () => {
  const lines = summaryLines({
    scores: {
      leading: Object.assign(G(80, 60), { signals: [{ kind: 'kpi', company: 'Deep', label: 'Order book', flag: 'inflecting-up' }] }),
      coincident: Object.assign(G(-40, -50), { signals: [{ kind: 'tone', company: 'IOCL', label: 'Refining margin' }] }),
      lagging: G(30, 30)
    },
    stage: { stageId: 'early-upcycle', because: ['Leading 80, coincident -40.'] },
    divergence: { value: 120, signsDiffer: true },
    macro: { macroBias: 'up', scoreBias: 'up', agree: true, conflict: false, supporting: 3, opposing: 1,
             tiles: [{ label: 'Brent', direction: 'rising', percentile: 72 }] },
    drift: [{ name: 'ONGC', from: 'confident', to: 'cautious', direction: 'down', steps: -3 }]
  }, FW5);
  /* exactly the clauses the brief's fixed paragraph names, in its order */
  assert.deepEqual(lines.map((l) => l.id),
    ['call', 'leading', 'coincident', 'macro', 'divergence', 'watchlist', 'implication']);
  assert.ok(/driven by .*Deep/.test(lines[1].text));      /* strongest signals named */
  assert.ok(/72th pctile/.test(lines[3].text));           /* flags AND percentiles */
  assert.ok(/early-upcycle entry signal/.test(lines[4].text));
  assert.ok(/ONGC/.test(lines[5].text));
  assert.ok(!/undefined/.test(lines.map((l) => l.text).join(' ')));
});

test('the summary says so plainly when there is no call', () => {
  const lines = summaryLines({
    scores: { leading: G(null, null), coincident: G(null, null) },
    stage: { stageId: null, because: [] }, divergence: { value: null }, macro: {}, drift: []
  }, FW5);
  assert.equal(lines[0].id, 'call');
  assert.ok(/not called/i.test(lines[0].text));
  assert.ok(/No company moved two tone steps/i.test(lines.find((l) => l.id === 'watchlist').text));
});

test('the actionable list is the stage row, and says which row it is', () => {
  const a = actionsFor('early-upcycle', FW5);
  assert.equal(a.stageId, 'early-upcycle');
  assert.equal(a.stageLabel, 'Early Upcycle');
  assert.equal(a.research.length, 2);
  assert.ok(a.why);
  /* a name outside the 27-company backbone is kept, and marked as having no series */
  assert.equal(a.research[1].label, 'Man Industries');
  assert.equal(a.research[1].companyId, null);
  assert.notDeepEqual(actionsFor('trough', FW5).research, a.research);
  assert.equal(actionsFor('mid-upcycle', FW5), null);        /* no row, no invention */
});

test('the first run says it is the first run rather than inventing changes', () => {
  const changes = changesSince(null, { scores: {}, alerts: [] }, FW5);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'first-run');
});

test('the change log reports a stage move, a score move and only NEW alerts', () => {
  const prev = snapshotOf({
    generatedAt: 't0', asOf: 'Q3 FY26',
    stage: { stageId: 'trough' },
    scores: { leading: { score: 40 }, coincident: { score: 50 } },
    alerts: [{ id: 'old-one' }]
  });
  const now = {
    stage: { stageId: 'early-upcycle' },
    scores: { leading: { score: 60 }, coincident: { score: 50 } },
    alerts: [{ id: 'old-one', text: 'repeat' }, { id: 'new-one', text: 'something new' }]
  };
  const changes = changesSince(prev, now, FW5);
  const kinds = changes.map((c) => c.kind);
  assert.ok(kinds.includes('stage-call'));
  assert.ok(kinds.includes('score'));
  assert.equal(changes.filter((c) => c.kind === 'alert').length, 1);   /* not the repeat */
  assert.ok(changes.find((c) => c.kind === 'alert').text.includes('something new'));
  /* coincident did not move, so it earns no row */
  assert.ok(!changes.some((c) => c.kind === 'score' && /Moving now/.test(c.text)));
});

test('a quiet quarter says nothing moved rather than showing an empty panel', () => {
  const prev = snapshotOf({ stage: { stageId: 'trough' }, scores: { leading: { score: 40 } }, alerts: [] });
  const changes = changesSince(prev, { stage: { stageId: 'trough' }, scores: { leading: { score: 40 } }, alerts: [] }, FW5);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'none');
});

test('the snapshot stays flat, so the file cannot grow every run', () => {
  const snap = snapshotOf({ stage: { stageId: 'trough' }, scores: { leading: { score: 1 } }, alerts: [], previous: { deep: true } });
  assert.equal(snap.previous, undefined);
  assert.deepEqual(Object.keys(snap).sort(),
    ['alertIds', 'asOf', 'generatedAt', 'scores', 'scoringVersion', 'stageId']);
});

test('buildScores carries summary, actions and changes for Section 5', () => {
  const kpis = kpisWith({ a: [RISING] });
  const out = buildScores({ kpis, companies: groupsOf({ leading: ['a'] }), framework: FW5, macro: null, commentary: null });
  assert.ok(Array.isArray(out.summary) && out.summary.length);
  assert.ok(out.actions === null || Array.isArray(out.actions.research));
  assert.ok(Array.isArray(out.changes));
});

test('a scoring-method change refuses to diff rather than reporting a fake move', () => {
  const prev = snapshotOf({
    stage: { stageId: 'trough' }, scores: { leading: { score: 50 } },
    alerts: [], scoringVersion: 1
  });
  const changes = changesSince(prev, {
    stage: { stageId: 'trough' }, scores: { leading: { score: -8 } },
    alerts: [], scoringVersion: 2
  }, FW5);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'method-change');
  /* the 58-point "move" was the rescale, and must not be reported as one */
  assert.ok(!/58/.test(changes[0].text));
});

/* ------------------------------------------------------- 4.3 theme rollup */

import { themeRollup } from '../lib/cycle-score.mjs';

test('a theme states the balance of its own companies and who moved', () => {
  const commentary = { companies: {
    a: { name: 'ONGC', tones: [
      { quarter: 'Q3', toneId: 'confident', score: 5, direction: 'positive' },
      { quarter: 'Q4', toneId: 'cautious', score: 2, direction: 'negative' }] }
  } };
  const out = themeRollup(commentary, FRAMEWORK);
  const upstream = out.find((t) => t.id === 'upstream-capex');
  assert.equal(upstream.members.length, 1);
  assert.equal(upstream.mood, 'negative');
  assert.ok(/ONGC moved 3 steps down/.test(upstream.state));
  assert.equal(upstream.drivers[0].name, 'ONGC');
});

test('a theme with nothing heard says so instead of implying calm', () => {
  const out = themeRollup({ companies: {} }, FRAMEWORK);
  assert.ok(out.length >= 2);
  out.forEach((t) => {
    assert.equal(t.members.length, 0);
    assert.equal(t.mood, null);
    assert.ok(/no company/i.test(t.state));
  });
});

test('every theme carries the bucket it scores into and what to listen for', () => {
  const out = themeRollup({ companies: {} }, FRAMEWORK);
  const ids = out.map((t) => t.id);
  assert.ok(ids.includes('upstream-capex') && ids.includes('freight-shipping'));
  assert.equal(out.find((t) => t.id === 'freight-shipping').bucket, 'lagging');
});

/* ------------------------------------------------- Part C: run history */

import { appendHistory } from '../lib/cycle-score.mjs';

const reading = (asOf, stageId, leading) => ({
  asOf, generatedAt: asOf + 'T00:00:00Z', scoringVersion: 2,
  stage: { stageId, ruleId: stageId, position: 30 },
  scores: { leading: { score: leading } },
  divergence: { value: 10, signsDiffer: false }, macro: { conflict: false }, alerts: []
});

test('each refresh is retained, oldest first', () => {
  let h = appendHistory(null, reading('Q3 FY26', 'trough', -40));
  h = appendHistory(h, reading('Q4 FY26', 'early-upcycle', 10));
  assert.equal(h.readings.length, 2);
  assert.deepEqual(h.readings.map((r) => r.asOf), ['Q3 FY26', 'Q4 FY26']);
  assert.equal(h.readings[0].stageId, 'trough');
  assert.equal(h.readings[1].scores.leading, 10);
});

test('re-running inside a quarter replaces that quarter, it does not stack', () => {
  let h = appendHistory(null, reading('Q4 FY26', 'trough', -40));
  h = appendHistory(h, reading('Q4 FY26', 'early-upcycle', 12));
  assert.equal(h.readings.length, 1);           /* one quarter, one reading */
  assert.equal(h.readings[0].stageId, 'early-upcycle');
});

test('history carries the scoring version so entries are comparable knowingly', () => {
  const h = appendHistory(null, reading('Q4 FY26', 'trough', -40));
  assert.equal(h.readings[0].scoringVersion, 2);
});

test('history is capped so the file cannot grow without bound', () => {
  let h = null;
  for (let i = 0; i < 12; i++) h = appendHistory(h, reading('Q' + i, 'trough', i), 5);
  assert.equal(h.readings.length, 5);
  assert.equal(h.readings[4].asOf, 'Q11');       /* the newest are the ones kept */
});
