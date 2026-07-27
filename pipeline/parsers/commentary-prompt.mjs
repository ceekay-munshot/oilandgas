/**
 * Everything the commentary scorer does that is NOT the network call: turn a
 * company's cached concall text into a per-quarter management TONE, and normalise
 * the model reply into the shape data/commentary.json stores. Pure and tested.
 *
 * The rules mirror the KPI extractor's, because the honesty bar is the same:
 *  - NEVER invent a tone. A quarter with no concall text comes back null, not a
 *    guess. Tone is a reading of what management SAID; with nothing said there is
 *    nothing to read.
 *  - GROUND every judgement. Each non-null tone carries the single most
 *    representative quote from that quarter's own document and a one-line reason,
 *    so a reader can check the call instead of trusting the label.
 *  - Judge the WORDS, not the world. Tone is how management sounded about their
 *    business and outlook - not the share price, not our view of the numbers, not
 *    prior knowledge of the company.
 */

/**
 * The five tone steps, mirroring data/framework.json `toneScale`. The score is the
 * diverging-scale position the dashboard colours by (5 = most upbeat ... 1 = most
 * worried). Kept in sync with framework.json by hand: the legend renders from the
 * data file, and this validates the model's reply against the same five ids. If a
 * step is ever added or renamed there, change it here and bump PROMPT_VERSION.
 */
export const TONE_SCORE = {
  confident: 5,
  constructive: 4,
  neutral: 3,
  cautious: 2,
  defensive: 1
};
export const TONE_IDS = Object.keys(TONE_SCORE);

/* A short gloss per tone, so the model is anchored to the same meanings the
   dashboard legend shows the reader. */
const TONE_GLOSS = {
  confident: 'very upbeat - sure of themselves, talks about growth and new spending',
  constructive: 'positive - hopeful, sees things improving',
  neutral: 'flat - neither good nor bad, wait and see',
  cautious: 'careful - holding back, talks about risks and delays',
  defensive: 'worried - protecting the business, talks about cutting costs'
};

/**
 * Bump whenever a change here could change the tone for a quarter the store
 * already recorded as null. The store will not re-ask a settled cell, so
 * "settled" has to mean "settled given this prompt" - without a version an
 * improved prompt keeps being served the old null as though it were established.
 *
 *   1  first commentary scorer
 */
export const COMMENTARY_PROMPT_VERSION = 1;

/* Keep quotes and reasons short: they ride in a hover title, and a whole
   paragraph pasted from a transcript is neither a quote nor checkable. */
const QUOTE_MAX = 200;
const WHY_MAX = 240;

/**
 * Build the system + user messages for one company.
 *
 * @param {object} opts
 * @param {string} opts.companyName
 * @param {{quarter:string, text:string}[]} opts.quarterBlocks  one block per
 *        quarter we are asking about, each holding that quarter's own concall text
 * @returns {{system:string, user:string}}
 */
export function buildMessages({ companyName, quarterBlocks }) {
  const labels = TONE_IDS.map((id) => `"${id}" (${TONE_GLOSS[id]})`).join(', ');
  const system = [
    'You classify how a company\'s management SOUNDED on its earnings calls, quarter by quarter, for an Indian oil & gas company.',
    'For each quarter you are given that quarter\'s own concall summary or transcript text. Read ONLY that text.',
    `Choose exactly one tone per quarter from these five: ${labels}.`,
    'Judge the tone of management\'s words about their business, demand, spending and outlook - NOT the share price, NOT whether you personally think the results were good, NOT anything you know about the company from elsewhere.',
    'Ground every tone: quote the single most representative phrase VERBATIM from that quarter\'s text (at most 160 characters), and give a one-line reason.',
    'If a quarter\'s text is missing, or says nothing about how the business is going, return tone null with a short reason - never guess a tone with no evidence.',
    'Output STRICT JSON matching the schema and nothing else.'
  ].join(' ');

  const blocks = (quarterBlocks || [])
    .map((b) => `### ${b.quarter}\n${b.text || '(no concall text cached for this quarter)'}`)
    .join('\n\n');

  const user = [
    `Company: ${companyName}`,
    '',
    'Classify these quarters. Return one object per quarter; tone is one of ' +
      TONE_IDS.join(', ') + ', or null when the text does not support a judgement:',
    (quarterBlocks || []).map((b) => `- ${b.quarter}`).join('\n'),
    '',
    'Quarter texts:',
    blocks || '(no text provided - return null tone for every quarter)'
  ].join('\n');

  return { system, user };
}

/** JSON Schema for the reply (OpenAI strict json_schema compatible). */
export const TONE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    quarters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          quarter: { type: 'string' },
          tone: { type: ['string', 'null'] },
          quote: { type: ['string', 'null'] },
          why: { type: ['string', 'null'] }
        },
        required: ['quarter', 'tone', 'quote', 'why']
      }
    }
  },
  required: ['quarters']
};

const clean = (s, max) =>
  (typeof s === 'string' && s.trim()) ? s.trim().replace(/\s+/g, ' ').slice(0, max) : null;

/**
 * Normalise the model reply against the quarters we asked about.
 *
 * Returns one tone cell per quarter, in the SAME order as `quarters`. A tone the
 * scale does not recognise is dropped to null rather than coerced - a wrong label
 * with a real quote behind it is exactly the confident-looking mistake the honesty
 * rules exist to stop. A null tone keeps its reason but never a quote, because a
 * quote with no judgement is noise.
 *
 * @param {object} raw  the model reply ({quarters:[{quarter,tone,quote,why}]})
 * @param {string[]} quarters  the quarters asked about, in order
 * @returns {{quarter:string, toneId:string|null, score:number|null,
 *            quote:string|null, rationale:string|null}[]}
 */
export function normalizeResult(raw, quarters) {
  const byQuarter = new Map(
    ((raw && raw.quarters) || [])
      .filter((q) => q && typeof q.quarter === 'string')
      .map((q) => [q.quarter.trim(), q])
  );

  return (quarters || []).map((quarter) => {
    const got = byQuarter.get(quarter) || {};
    const rawTone = typeof got.tone === 'string' ? got.tone.trim().toLowerCase() : null;
    const toneId = TONE_IDS.includes(rawTone) ? rawTone : null;
    const why = clean(got.why, WHY_MAX);

    if (!toneId) {
      return {
        quarter,
        toneId: null,
        score: null,
        quote: null,
        rationale: why || (rawTone ? `model returned an unrecognised tone "${rawTone}"` : 'no tone stated for this quarter')
      };
    }
    return {
      quarter,
      toneId,
      score: TONE_SCORE[toneId],
      quote: clean(got.quote, QUOTE_MAX),
      rationale: why
    };
  });
}

/** Count quarters that got a tone, for the run summary. */
export function coverageOf(tones) {
  let cells = 0, real = 0;
  for (const t of tones || []) { cells++; if (t && t.toneId) real++; }
  return { cells, real, nullCells: cells - real };
}
