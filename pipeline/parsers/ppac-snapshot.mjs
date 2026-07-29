/**
 * PPAC's "Snapshot of India's Oil & Gas data - Monthly Ready Reckoner" ->
 * refinery throughput by company. Pure: OCR'd text in, structured rows out.
 *
 * Written against the real Firecrawl OCR of the July-26 edition (data for
 * June 2026), captured by `--probe ppac-flash` on 2026-07-29. Every rule below
 * is read off that output, not from documentation.
 *
 * WHY THIS SOURCE. Refinery throughput for IOCL, BPCL and HPCL was previously
 * only available if a manager happened to say a number on a call - a
 * [Mgmt Claim] at best. PPAC publishes it monthly, per refinery, with company
 * totals, as the ministry's own statistics: [Official], the firmest tag on the
 * ladder.
 *
 * THE TRAP. The table carries TWO column layouts under one heading. The first
 * block (IOCL, CPCL, BPCL, NRL) runs:
 *
 *   capacity | FY-2 | FY-1 | Jun[FY-1, FY(T), FY(P)] | AprJun[FY-1, FY(T), FY(P)]   = 9 numbers
 *     1 Barauni (1964)  6.0  6.5  6.4  0.6 0.6 0.5  1.6 1.8 1.6
 *
 * and the second (ONGC, HPCL, HMEL, RIL) inserts an extra year:
 *
 *   capacity | FY-3 | FY-2 | FY-1 | Jun[...] | AprJun[...]                          = 10 numbers
 *     HPCL-TOTAL  24.5 22.3 25.3 26.0  2.1 2.1 2.2  6.7 6.1 6.5
 *
 * A parser assuming one shape reads HPCL's numbers one column out and returns a
 * plausible wrong answer. So the row is keyed on how many numbers it actually
 * has, and a row whose count matches neither layout is skipped rather than
 * guessed at.
 *
 * CADENCE. The last six numbers are the month and the fiscal-year-to-date, each
 * for the prior year, this year's target, and this year's provisional. April-June
 * IS Q1: the year-to-date column at the June edition is the quarter. Later
 * quarters are the difference between consecutive year-to-date figures, which is
 * why quarterFromCumulative exists rather than a single-month read.
 */

import { ParseError } from '../lib/errors.mjs';

/** Company totals the Snapshot prints, mapped to this dashboard's company ids. */
export const REFINER_TOTALS = {
  'IOCL-TOTAL': 'iocl',
  'BPCL-TOTAL': 'bpcl',
  'HPCL-TOTAL': 'hpcl',
  'RIL-TOTAL': 'reliance',
  /* CPCL and ONGC-TOTAL (MRPL) are refiners in the table but are not part of
     the 27-company backbone's refining KPIs, so they are read and ignored
     rather than silently mapped onto a company they do not describe. */
  'CPCL-TOTAL': null,
  'ONGC-TOTAL': null
};

/* The two layouts, by how many numbers the row carries. Named so a mismatch
   reports which shape it expected rather than an index. */
const LAYOUTS = {
  9:  { years: 2, label: 'capacity + 2 annual + month(3) + ytd(3)' },
  10: { years: 3, label: 'capacity + 3 annual + month(3) + ytd(3)' }
};

const num = (s) => {
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Pull the numbers that follow a label, stopping at the next label.
 * OCR runs the whole table onto one line, so "next label" is the only boundary.
 */
function numbersAfter(text, label) {
  const i = text.indexOf(label);
  if (i < 0) return null;
  const after = text.slice(i + label.length);
  /* Stop at the next serial-numbered refinery row or the next TOTAL, whichever
     comes first - otherwise the run of digits swallows the following block.
     The refinery name after the serial number may be all-caps ("20 HMEL-
     Bathinda"), so this must not require a lowercase second letter: demanding
     one let HPCL's row run into HMEL's and produced a number count matching no
     layout, which the parser then correctly refused - a silent loss rather than
     a wrong value, but a loss all the same. */
  const stop = after.search(/[A-Z]{2,}-TOTAL|\b\d{1,2}\s+[A-Z]/);
  const window = stop > 0 ? after.slice(0, stop) : after;
  const found = window.match(/-?\d+(?:\.\d+)?/g) || [];
  return found.map(num).filter((x) => x !== null);
}

/**
 * One company's throughput row.
 *
 * @param {string} text  OCR'd Snapshot text
 * @param {string} label e.g. "IOCL-TOTAL"
 * @returns {{label:string, companyId:string|null, capacityMmtpa:number,
 *            annual:number[], month:{prior:number,target:number,provisional:number},
 *            yearToDate:{prior:number,target:number,provisional:number},
 *            layout:string}|null}
 */
export function parseRefinerTotal(text, label) {
  const nums = numbersAfter(String(text || ''), label);
  if (!nums || !nums.length) return null;

  /* The row may be followed by the next block's serial number, so trim to the
     longest recognised layout that fits rather than demanding an exact length. */
  const layout = LAYOUTS[nums.length] || LAYOUTS[nums.length - 1];
  if (!layout) return null;
  const take = layout === LAYOUTS[9] ? 9 : 10;
  const row = nums.slice(0, take);

  const annualCount = layout.years;
  const capacityMmtpa = row[0];
  const annual = row.slice(1, 1 + annualCount);
  const rest = row.slice(1 + annualCount);
  if (rest.length < 6) return null;

  return {
    label,
    companyId: Object.prototype.hasOwnProperty.call(REFINER_TOTALS, label)
      ? REFINER_TOTALS[label] : null,
    capacityMmtpa,
    annual,
    month: { prior: rest[0], target: rest[1], provisional: rest[2] },
    yearToDate: { prior: rest[3], target: rest[4], provisional: rest[5] },
    layout: layout.label
  };
}

/**
 * Every company total the document carries.
 *
 * @param {string} text
 * @returns {object[]} one row per label found, in table order
 */
export function parseRefinerTotals(text) {
  const s = String(text || '');
  const out = [];
  for (const label of Object.keys(REFINER_TOTALS)) {
    const row = parseRefinerTotal(s, label);
    if (row) out.push(row);
  }
  if (!out.length) {
    throw new ParseError('No refinery company totals found - the Snapshot layout has probably changed', {
      source: 'ppac-snapshot'
    });
  }
  return out;
}

/**
 * Which month's data the edition carries: "MONTHLY READY RECKONER July-26
 * (Data for Jun 2026)" -> { month: 6, year: 2026 }.
 *
 * The cover month and the DATA month differ by one, and it is the data month
 * that a value belongs to. Reading the cover would date every figure a month
 * late, which is the sort of error that survives review because the number
 * itself is right.
 */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function parseDataMonth(text) {
  const m = /Data\s+for\s+([A-Za-z]{3,9})[’'`\s]*(\d{2,4})/i.exec(String(text || ''));
  if (!m) return null;
  const idx = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  if (idx < 0) return null;
  let year = Number(m[2]);
  if (year < 100) year += 2000;
  return { month: idx + 1, year };
}

/**
 * A quarter's throughput from two fiscal-year-to-date readings.
 *
 * PPAC prints April-to-date every month, so Q1 is the June edition's figure and
 * every later quarter is a difference: Q2 = Sep YTD - Jun YTD. Subtracting the
 * wrong pair, or subtracting across a fiscal year, produces a number that looks
 * like a quarter and is not - so a later reading that is SMALLER than the
 * earlier one is refused rather than returned as a negative throughput.
 *
 * @param {number|null} ytdEarlier  year-to-date at the start of the quarter (null for Q1)
 * @param {number|null} ytdLater    year-to-date at the end of the quarter
 * @returns {number|null}
 */
export function quarterFromCumulative(ytdEarlier, ytdLater) {
  if (typeof ytdLater !== 'number' || !Number.isFinite(ytdLater)) return null;
  if (ytdEarlier === null || ytdEarlier === undefined) return ytdLater;   // Q1
  if (typeof ytdEarlier !== 'number' || !Number.isFinite(ytdEarlier)) return null;
  const q = ytdLater - ytdEarlier;
  /* Year-to-date only rises within a fiscal year. A fall means the two readings
     are not from the same year, and the difference is meaningless. */
  return q < 0 ? null : q;
}
