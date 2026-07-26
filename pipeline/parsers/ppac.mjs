/**
 * PPAC AjaxController payload -> dated monthly points. Pure.
 *
 * PPAC returns one object per table row keyed "1","2","3"...; the first is the
 * data row and the rest are footnotes. Months are Indian fiscal-year ordered
 * (April..March), so for FY 2025-26 April..December are 2025 and
 * January..March are 2026. Months not yet published come back as "".
 *
 *   { "result": { "1": { "title":"2025-26", "april":67.72, ..., "march":113.49 },
 *                 "2": { "title":"Notes :" } } }
 */

import { ParseError } from '../lib/errors.mjs';

const FY_MONTHS = [
  ['april', 4], ['may', 5], ['june', 6], ['july', 7], ['august', 8], ['september', 9],
  ['october', 10], ['november', 11], ['december', 12],
  ['january', 1], ['february', 2], ['march', 3]
];

/** The row carrying numbers, not the footnotes underneath it. */
export function findDataRow(result) {
  const rows = Object.values(result || {});
  return rows.find(
    (r) =>
      r &&
      /^\d{4}-\d{2}$/.test(String(r.title || '').trim()) &&
      FY_MONTHS.some(([m]) => Number.isFinite(Number(r[m])) && String(r[m]).trim() !== '')
  );
}

/**
 * @param {object} json    raw AjaxController payload
 * @param {string} fyLabel e.g. '2025-2026' (the value posted as financialYear)
 * @returns {{date:string,value:number}[]} oldest first, published months only
 */
export function parsePpacFyTable(json, fyLabel) {
  const row = findDataRow(json?.result);
  if (!row) {
    throw new ParseError(`PPAC payload had no data row for FY ${fyLabel}`, {
      source: 'ppac',
      sample: JSON.stringify(json).slice(0, 240)
    });
  }

  const startYear = Number(String(fyLabel).slice(0, 4));
  if (!Number.isFinite(startYear)) {
    throw new ParseError(`Unreadable financial year "${fyLabel}"`, { source: 'ppac' });
  }

  const out = [];
  for (const [name, month] of FY_MONTHS) {
    const raw = row[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    // April-December sit in the first calendar year, January-March in the next.
    const year = month >= 4 ? startYear : startYear + 1;
    out.push({ date: `${year}-${String(month).padStart(2, '0')}-01`, value: v });
  }

  if (!out.length) {
    throw new ParseError(`PPAC row for FY ${fyLabel} had no published months`, {
      source: 'ppac',
      sample: JSON.stringify(row).slice(0, 240)
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** The two Indian fiscal years covering the 12 months ending at `iso`. */
export function fyWindow(iso) {
  const [y, m] = String(iso).slice(0, 7).split('-').map(Number);
  const currentFyStart = m >= 4 ? y : y - 1;
  return [`${currentFyStart - 1}-${currentFyStart}`, `${currentFyStart}-${currentFyStart + 1}`];
}
