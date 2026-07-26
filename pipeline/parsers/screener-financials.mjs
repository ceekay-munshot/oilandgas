/**
 * Screener company page -> financial tables. Pure: cheerio in, plain data out,
 * never touches the network.
 *
 * Screener server-renders every statement as one <table class="data-table">
 * inside a <section> whose id names it: #quarters (Quarterly Results),
 * #profit-loss (annual P&L), #balance-sheet, #cash-flow, #ratios. The header row
 * carries the period labels ("Mar 2023", "Jun 2023", ... or "Mar 2019" ... "TTM")
 * left-to-right oldest-to-newest; each body row is a line item and its values.
 *
 * This reads EVERY row it finds rather than a chosen few. Which of these become
 * KPIs is prompt 7's job, decided by the extractor - picking them here would be
 * guessing at the client's definitions, which this prompt must not do.
 *
 * A cell that is blank or "-" becomes null, never 0: a quarter a company has not
 * reported is missing, and a zero would read as "they earned nothing".
 */

import { load } from 'cheerio';

/** "Sales +" / "OPM %" -> "Sales" / "OPM %". Strips the expand-button plus. */
export function cleanLabel(raw) {
  return String(raw)
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*\+\s*$/, '')
    .trim();
}

/**
 * One statement cell -> number or null. Handles Indian digit grouping
 * ("1,23,456"), a trailing "%", and negatives; anything that is not a clean
 * number (blank, "-", a stray footnote mark) is null.
 */
export function parseCell(raw) {
  const s = String(raw).replace(/ /g, ' ').trim().replace(/,/g, '').replace(/%$/, '').trim();
  if (!s || s === '-') return null;
  return /^-?\d+(?:\.\d+)?$/.test(s) ? Number(s) : null;
}

/** "Mar 2023" -> "2023-03"; "TTM" or anything unparseable -> null. */
export function periodToIso(label) {
  const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
  };
  const m = String(label).trim().match(/^([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (!m) return null;
  const mm = MONTHS[m[1].toLowerCase()];
  return mm ? `${m[2]}-${String(mm).padStart(2, '0')}` : null;
}

/**
 * @param {string} html full company-page markup
 * @param {string} sectionId one of quarters | profit-loss | balance-sheet | cash-flow | ratios
 * @returns {{periods:string[], periodsIso:(string|null)[], rows:Object<string, (number|null)[]>}|null}
 *          null when the section is absent (e.g. a company with no consolidated cash-flow)
 */
export function parseFinancialTable(html, sectionId) {
  const $ = load(html);
  const table = $(`section#${sectionId} table.data-table`).first();
  if (!table.length) return null;

  const periods = [];
  table.find('thead th').each((i, th) => {
    if (i === 0) return;                    // the empty top-left corner
    const t = cleanLabel($(th).text());
    if (t) periods.push(t);
  });
  if (!periods.length) return null;

  const rows = {};
  const order = [];
  table.find('tbody tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 2) return;
    const label = cleanLabel($(cells.get(0)).text());
    if (!label) return;
    const values = [];
    cells.slice(1).each((_, td) => values.push(parseCell($(td).text())));
    // A row can be longer or shorter than the header; align to the periods.
    while (values.length < periods.length) values.push(null);
    rows[label] = values.slice(0, periods.length);
    if (!order.includes(label)) order.push(label);
  });
  if (!order.length) return null;

  return { periods, periodsIso: periods.map(periodToIso), rows, order };
}

const SECTIONS = ['quarters', 'profit-loss', 'balance-sheet', 'cash-flow', 'ratios'];

/**
 * Parse every statement present on the page.
 * @returns {{tables:Object, sectionsFound:string[], sectionsMissing:string[]}}
 */
export function parseAllFinancials(html) {
  const tables = {};
  const found = [];
  for (const id of SECTIONS) {
    const t = parseFinancialTable(html, id);
    if (t) { tables[id] = t; found.push(id); }
  }
  return {
    tables,
    sectionsFound: found,
    sectionsMissing: SECTIONS.filter((s) => !found.includes(s))
  };
}

export { SECTIONS };
