/**
 * Indian fiscal quarters, and which one a document reports. Pure.
 *
 * FY26 runs April 2025 - March 2026, so:
 *   Q1 FY26 = Apr-Jun 2025   Q3 FY26 = Oct-Dec 2025
 *   Q2 FY26 = Jul-Sep 2025   Q4 FY26 = Jan-Mar 2026
 *
 * A concall does not report the quarter it happens in - it reports the one that
 * just ended. A call in May 2026 discusses Q4 FY26 (Jan-Mar 2026); one in
 * November 2025 discusses Q2 FY26. Getting this mapping wrong is what made the
 * first extraction run file every number it found into the first quarter slot:
 * the model was handed four transcripts labelled only with their own dates and
 * had no way to know which column each belonged in.
 */

const QUARTER_ENDS = [3, 6, 9, 12];   // Mar, Jun, Sep, Dec

/* Quarter-end month -> which fiscal quarter it closes. Written out rather than
   derived from the array index: FY starts in April, so June closes Q1 while
   March closes Q4 of the FY that began the previous April - arithmetic on the
   month order gets this off by one, which it did. */
const CLOSES = { 6: 1, 9: 2, 12: 3, 3: 4 };

/** 'YYYY-MM' or 'YYYY-MM-DD' -> {year, month} or null. */
function ym(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year: Number(m[1]), month };
}

/** A quarter-end (year, month) -> 'Q2 FY26'. */
export function quarterLabel(year, endMonth) {
  const q = CLOSES[endMonth];
  if (!q) return null;
  // March closes the FY it falls in; Jun/Sep/Dec belong to the FY ending next March.
  const fyEndYear = endMonth === 3 ? year : year + 1;
  return `Q${q} FY${String(fyEndYear).slice(2)}`;
}

/**
 * The fiscal quarter a document dated `iso` reports on: the most recent quarter
 * that had ended before it was published.
 * @param {string} iso 'YYYY-MM' or 'YYYY-MM-DD'
 * @returns {string|null} e.g. 'Q4 FY26'
 */
export function reportedQuarter(iso) {
  const d = ym(iso);
  if (!d) return null;
  // Largest quarter-end month strictly before this month; wrap to December of
  // the previous year when the document lands in January.
  const prior = QUARTER_ENDS.filter((m) => m <= d.month - 1);
  const endMonth = prior.length ? prior[prior.length - 1] : 12;
  const year = prior.length ? d.year : d.year - 1;
  return quarterLabel(year, endMonth);
}

/**
 * Index of a quarter label inside the target window, or -1.
 * @param {string} label e.g. 'Q4 FY26'
 * @param {string[]} quarters the window, oldest first
 */
export function quarterIndex(label, quarters) {
  return (quarters || []).indexOf(label);
}

/**
 * "Q3 FY26" -> a sortable number, so two quarter labels can be COMPARED rather
 * than merely matched.
 *
 * Needed wherever "older than" is the question. Comparing the labels as strings
 * puts Q1 FY27 before Q4 FY26, which is backwards by a quarter and would mark
 * the company that reported earliest as the stale one.
 *
 * @param {string} label e.g. "Q3 FY26"
 * @returns {number|null} null when the label is not a quarter
 */
export function quarterOrdinal(label) {
  const m = /^Q([1-4])\s*FY\s*(\d{2,4})$/i.exec(String(label || '').trim());
  if (!m) return null;
  let year = Number(m[2]);
  if (year < 100) year += 2000;
  return year * 4 + Number(m[1]);
}

/** true when `label` names a quarter strictly older than `latest`. */
export function isOlderQuarter(label, latest) {
  const a = quarterOrdinal(label), b = quarterOrdinal(latest);
  return a !== null && b !== null && a < b;
}
