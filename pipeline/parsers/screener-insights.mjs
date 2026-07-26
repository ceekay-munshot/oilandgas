/**
 * Screener Premium's Investors -> Insights table -> per-period rows. Pure.
 *
 * This is the best source the pipeline has for operational KPIs. It is already a
 * grid, so it parses deterministically - no model, no hallucination risk, exact
 * units off the row label, and every period at once rather than one quarter per
 * document. For ONGC it carries Wells Drilled (Total), Crude Oil Production,
 * Natural Gas Production, 1P Proved Reserves, Reserves Accretion, VAP and RRR.
 *
 * The row label cell holds the name, the unit, and sometimes a scope note:
 *
 *   Crude Oil Production (Standalone)
 *   MMT · Standalone data
 *
 * Parsed by walking the table generically rather than by class name: the header
 * gives the periods, each body row gives a label, a unit and its values. A
 * generic walk survives a restyle, which a class selector does not - and this
 * table is badged "In beta", so it will be restyled.
 */

import { load } from 'cheerio';

const clean = (s) => String(s).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

/** 'Mar 2025' -> '2025-03'; 'Q1 FY26' and anything else -> null. */
export function periodToIso(label) {
  const m = clean(label).match(/^([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (!m) return null;
  const mm = MONTHS[m[1].toLowerCase()];
  return mm ? `${m[2]}-${String(mm).padStart(2, '0')}` : null;
}

/** Does this header text look like a reporting period? */
export function looksLikePeriod(label) {
  return Boolean(periodToIso(label)) || /^(TTM|Q[1-4]\s*FY\d{2})$/i.test(clean(label));
}

/**
 * One cell -> number or null. Indian digit grouping, a stray info-icon glyph and
 * a trailing % are all tolerated; anything that is not a clean number is null,
 * never 0 - a period a company did not report is missing, not zero.
 */
export function parseCell(raw) {
  const s = clean(raw)
    .replace(/[\u24D8\u2139\u24BE]/g, '')      // info glyphs the cell may carry
    .replace(/,/g, '')
    .replace(/%$/, '')
    .trim();
  if (!s || s === '-' || s === '–' || s === '—' || /^n\/?a$/i.test(s)) return null;
  return /^-?\d+(?:\.\d+)?$/.test(s) ? Number(s) : null;
}

/**
 * Split the label cell into its name, unit and scope note.
 * "Crude Oil Production (Standalone) MMT · Standalone data"
 *   -> { label: 'Crude Oil Production (Standalone)', unit: 'MMT', scope: 'Standalone data' }
 *
 * @param {import('cheerio').CheerioAPI} $
 */
function splitLabelCell($, td) {
  // The name is the cell's first link or its first block child; the unit line
  // follows it. Falling back to line-splitting the text keeps this working if the
  // markup flattens.
  const name = clean($(td).find('a').first().text()) ||
               clean($(td).children().first().text());
  const all = clean($(td).text());

  let rest = all;
  if (name && all.startsWith(name)) rest = clean(all.slice(name.length));

  const [unitPart, ...noteParts] = rest.split(/[·|]/);
  const label = name || all;
  let unit = clean(unitPart) || null;
  // A cell with no separate unit line leaves `rest` equal to the label itself;
  // reporting that as the unit gave rows like "Operating Profit [Operating Profit]".
  if (unit && (unit === label || unit.length >= all.length)) unit = null;
  return { label, unit, scope: noteParts.length ? clean(noteParts.join(' ')) : null };
}

/**
 * @param {string} html markup containing the Insights table (the table itself is
 *        enough; a whole page also works - the first table with period headers wins)
 * @returns {{periods:string[], periodsIso:(string|null)[],
 *            rows:{label:string, unit:string|null, scope:string|null, values:(number|null)[]}[]}|null}
 *          null when no period-headed table is present
 */
export function parseInsightsTable(html) {
  const $ = load(String(html || ''));

  // The right table is the one whose header carries reporting periods.
  let chosen = null, periods = null;
  $('table').each((_, t) => {
    if (chosen) return;
    const heads = $(t).find('thead th, thead td').map((__, th) => clean($(th).text())).get();
    const periodCells = heads.filter(looksLikePeriod);
    if (periodCells.length >= 2) { chosen = t; periods = heads.filter((h, i) => i > 0 || looksLikePeriod(h)); }
  });
  if (!chosen) return null;

  // Header cells, minus the empty top-left corner.
  const heads = $(chosen).find('thead th, thead td').map((_, th) => clean($(th).text())).get();
  const firstPeriod = heads.findIndex(looksLikePeriod);
  if (firstPeriod === -1) return null;
  periods = heads.slice(firstPeriod).filter((h) => h !== '');

  const rows = [];
  $(chosen).find('tbody tr').each((_, tr) => {
    const cells = $(tr).find('td, th');
    if (cells.length < 2) return;
    const { label, unit, scope } = splitLabelCell($, cells.get(0));
    if (!label) return;

    const values = [];
    cells.slice(1).each((__, td) => values.push(parseCell($(td).text())));
    while (values.length < periods.length) values.push(null);

    rows.push({ label, unit, scope, values: values.slice(0, periods.length) });
  });

  if (!rows.length) return null;
  return { periods, periodsIso: periods.map(periodToIso), rows };
}

/**
 * Flatten the table into the compact text the KPI extractor puts in front of the
 * model - one line per row, each period labelled with the fiscal quarter it
 * closes so a value can be filed without the model working out India's
 * April-March year for itself.
 *
 * @param {object} table  output of parseInsightsTable
 * @param {(y:number,m:number)=>string|null} quarterLabel from lib/fiscal.mjs
 */
export function insightsToText(table, quarterLabel) {
  if (!table || !table.rows.length) return '';
  const heads = table.periods.map((p, i) => {
    const iso = table.periodsIso[i];
    const fq = iso && quarterLabel
      ? quarterLabel(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)))
      : null;
    return fq ? `${p} (${fq})` : p;
  });

  const lines = [`periods: ${heads.join(' | ')}`];
  for (const r of table.rows) {
    lines.push(
      `${r.label}${r.unit ? ` [${r.unit}]` : ''}: ` +
      r.values.map((v) => (v == null ? '-' : v)).join(' | ')
    );
  }
  return lines.join('\n');
}

/**
 * Interpret the TEXT MATRIX the browser extracts (sources/screener-insights).
 *
 * Preferred over parseInsightsTable: the browser has already resolved <br>, block
 * boundaries and nested spans into lines, so the label/unit split is reading data
 * rather than inferring structure. The markup route produced "Order BookRs Crore"
 * with no unit and every value null, because the cell separates its name from its
 * unit with a <br> that a child walk cannot see.
 *
 * A label cell arrives as lines, e.g.
 *   ['Order Book', 'Rs Crore']
 *   ['Consultancy Order Book', 'INR mn ・Standalone data']
 *
 * @param {{periods:string[], rows:{lines:string[], cells:string[]}[]}} matrix
 * @returns {{periods:string[], periodsIso:(string|null)[],
 *            rows:{label:string, unit:string|null, scope:string|null, values:(number|null)[]}[]}|null}
 */
export function parseInsightsMatrix(matrix) {
  if (!matrix || !Array.isArray(matrix.rows) || !matrix.rows.length) return null;
  const periods = (matrix.periods || []).map(clean).filter(Boolean);
  if (!periods.length) return null;

  const rows = [];
  for (const r of matrix.rows) {
    const lines = (r.lines || []).map(clean).filter(Boolean);
    if (!lines.length) continue;

    const label = lines[0];
    // Everything after the name is the unit line, which may carry a scope note
    // after a separator. Screener uses a katakana middle dot here, not a Latin one.
    const rest = lines.slice(1).join(' ');
    const [unitPart, ...noteParts] = rest.split(/[·・|]/);
    const unit = clean(unitPart) || null;

    const values = (r.cells || []).map(parseCell);
    while (values.length < periods.length) values.push(null);

    rows.push({
      label,
      unit,
      scope: noteParts.length ? clean(noteParts.join(' ')) : null,
      values: values.slice(0, periods.length)
    });
  }

  if (!rows.length) return null;
  return { periods, periodsIso: periods.map(periodToIso), rows };
}
