/**
 * FRED CSV -> dated points. Pure: takes text, returns data, touches nothing.
 *
 * Shape:
 *   observation_date,DCOILBRENTEU
 *   2026-07-20,86.99
 *
 * FRED writes '.' for a missing observation (holidays, non-trading days); those
 * rows are dropped, never zero-filled.
 */

import { ParseError } from '../lib/errors.mjs';

/**
 * @param {string} csv
 * @param {string} [seriesId] expected value-column header, checked when given
 * @returns {{date:string,value:number}[]} oldest first
 */
export function parseFredCsv(csv, seriesId) {
  const lines = String(csv).trim().split(/\r?\n/);
  if (lines.length < 2) {
    throw new ParseError('FRED CSV had no rows', { source: 'fred', sample: String(csv).slice(0, 200) });
  }

  const header = lines[0].split(',').map((h) => h.trim());
  if (header.length < 2) {
    throw new ParseError('FRED CSV header had no value column', { source: 'fred', sample: lines[0] });
  }
  if (seriesId && header[1] !== seriesId) {
    throw new ParseError(`FRED CSV value column was "${header[1]}", expected "${seriesId}"`, {
      source: 'fred',
      sample: lines[0]
    });
  }

  const out = [];
  for (const line of lines.slice(1)) {
    const [date, raw] = line.split(',');
    if (!date || raw === undefined) continue;
    const v = Number(String(raw).trim());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim()) || !Number.isFinite(v)) continue;
    out.push({ date: date.trim(), value: v });
  }

  if (!out.length) {
    throw new ParseError('FRED CSV had no usable observations', {
      source: 'fred',
      sample: lines.slice(0, 3).join(' | ')
    });
  }
  return out;
}
