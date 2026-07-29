/**
 * Reliance's quarterly results deck -> O2C segment EBITDA per tonne.
 *
 * Pure: extracted PDF text in, structured rows out. Written against the real
 * text of the Q1 FY27 deck (BSE, 77 pages, 45,180 characters), read on
 * 2026-07-29. Every rule below comes off that document, not from documentation.
 *
 * WHY THIS EXISTS. "O2C EBITDA per tonne" is one of the four KPIs the brief
 * names for Reliance, and it was blank. lib/derive.mjs explicitly refuses to
 * compute it, and is right to: the only EBITDA the pipeline held was Reliance's
 * CONSOLIDATED operating profit, which is Jio and Retail and E&P as well as
 * O2C. Dividing that by refinery tonnes would be a fabricated number wearing a
 * formula. The segment EBITDA had to come from the filing itself.
 *
 * The deck carries both halves, two pages apart, for the same two quarters:
 *
 *   ₹ crore Q1 FY26 Q1 FY27 YoY Change %
 *   Oil to Chemicals 14,511 17,010 17.2%          <- segment EBITDA, ₹ crore
 *
 *   Volume (in MMT) Q1 FY26 Q1 FY27
 *   Throughput 19.1 18.1                           <- crude processed, MMT
 *
 * THE TRAP THIS PARSER EXISTS TO AVOID. Those are two different tables on two
 * different pages, and nothing in the text guarantees they cover the same
 * periods - a deck that reports EBITDA year-on-year and volumes quarter-on-
 * quarter would produce a number that looks exactly like a margin and is not.
 * So the quarter labels are read from BOTH headers and the result is refused
 * unless they match. A gap is recoverable; a plausible wrong margin is not.
 *
 * WHY ₹/t AND NOT $/t. The deck states ₹ crore and MMT, and nothing else. A
 * dollar figure would need an exchange rate the document does not carry: the
 * only rate implied anywhere in it (the consolidated table's "$ Bn" column)
 * belongs to the current quarter, and applying it to the year-ago quarter would
 * silently misprice a comparison. The brief says "GRM/O2C EBITDA per tonne"
 * without naming a currency, and the dashboard already states the other Indian
 * margin KPI - EBITDA/scm - in rupees. So this stays in the unit the filing
 * supports, and both quarters survive instead of one.
 *
 * CADENCE. One deck yields the current quarter and the same quarter a year
 * earlier - never a run of four. The row therefore fills one quarter per
 * refresh, accumulating in the store exactly as PPAC's throughput does.
 */

import { ParseError } from '../lib/errors.mjs';

/** A quarter's crude processing, in MMT. Jamnagar runs ~17-20 per quarter. */
const THROUGHPUT_RANGE = [5, 35];
/** O2C segment EBITDA for a quarter, ₹ crore. */
const EBITDA_RANGE = [1_000, 200_000];

/** OCR and PDF extraction wrap labels mid-phrase ("Oil to\nChemicals"). */
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const num = (s) => {
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** 'Q1 FY26' from however the PDF broke it up. */
function quartersIn(chunk) {
  const out = [];
  const re = /Q(\d)\s*FY\s*(\d{2})/g;
  let m;
  while ((m = re.exec(chunk)) !== null) out.push(`Q${m[1]} FY${m[2]}`);
  return out;
}

/**
 * A two-column data row plus the quarters its own table header names.
 *
 * Anchored on the DATA ROW and reading the header backwards from it, not the
 * other way round. Anchoring forwards from "₹ crore" found the balance sheet's
 * header instead - that phrase appears three times in the deck - and returned
 * nothing. The row is the unambiguous landmark; its header is whatever sits
 * immediately above it.
 *
 * @param {string} t        flattened deck text
 * @param {RegExp} rowRe    matches the label and captures its two numbers
 * @param {[number,number]} range  plausible values, or the row is not what we think
 * @returns {{quarters:string[], values:number[]}|null}
 */
function rowWithHeader(t, rowRe, range) {
  const m = rowRe.exec(t);
  if (!m) return null;

  const values = [num(m[1]), num(m[2])];
  if (values.some((v) => v === null)) return null;
  if (values.some((v) => v < range[0] || v > range[1])) return null;

  /* The header sits just above the row. 220 characters is comfortably more than
     one table header and comfortably less than the previous page's, so the
     LAST two quarter labels before the row are this table's own. */
  const before = t.slice(Math.max(0, m.index - 220), m.index);
  const qs = quartersIn(before);
  if (qs.length < 2) return null;
  return { quarters: qs.slice(-2), values };
}

/**
 * O2C segment EBITDA, ₹ crore, for the two quarters the segment table covers.
 *
 * "Oil to Chemicals" is the segment's printed name, and it wraps across a line
 * break in the PDF - which `flat` has already closed up.
 *
 * @returns {{quarters:string[], values:number[]}|null}
 */
export function parseO2CEbitda(text) {
  return rowWithHeader(flat(text),
    /Oil\s*to\s*Chemicals\s+(-?[\d,]+)\s+(-?[\d,]+)/i, EBITDA_RANGE);
}

/**
 * O2C crude throughput, MMT, for the two quarters the volume table covers.
 *
 * @returns {{quarters:string[], values:number[]}|null}
 */
export function parseO2CThroughput(text) {
  return rowWithHeader(flat(text),
    /Throughput\s+(-?[\d.]+)\s+(-?[\d.]+)/i, THROUGHPUT_RANGE);
}

/**
 * O2C EBITDA per tonne, ₹/t, per quarter.
 *
 * Refuses rather than guesses whenever the two tables disagree about which
 * quarters they describe - see the header note. Refuses on a missing half too:
 * one number without the other is not a margin.
 *
 * @param {string} text  extracted deck text
 * @returns {{quarter:string, ebitdaCrore:number, throughputMmt:number, rupeesPerTonne:number}[]}
 * @throws {ParseError} when the deck carries the tables but they cannot be reconciled
 */
export function parseRilO2C(text) {
  const ebitda = parseO2CEbitda(text);
  const volume = parseO2CThroughput(text);
  if (!ebitda || !volume) return [];

  if (ebitda.quarters.join('|') !== volume.quarters.join('|')) {
    throw new ParseError(
      `O2C tables cover different periods - EBITDA ${ebitda.quarters.join(', ')} ` +
      `vs volume ${volume.quarters.join(', ')}; refusing to divide across them`,
      { source: 'ril-segments' }
    );
  }

  return ebitda.quarters.map((quarter, i) => {
    const ebitdaCrore = ebitda.values[i];
    const throughputMmt = volume.values[i];
    /* ₹ crore -> ₹, MMT -> tonnes. 1 crore = 10^7; 1 MMT = 10^6 t. */
    const rupeesPerTonne = (ebitdaCrore * 1e7) / (throughputMmt * 1e6);
    return {
      quarter,
      ebitdaCrore,
      throughputMmt,
      rupeesPerTonne: Math.round(rupeesPerTonne)
    };
  });
}
