/**
 * 3-2-1 crack spread. Pure arithmetic on series already fetched elsewhere.
 *
 * Three barrels of crude in, two of gasoline and one of distillate out - the
 * standard refiner's rule of thumb. Product prices are quoted in $/gal, crude
 * in $/bbl, so products are multiplied by 42 gallons before subtracting.
 *
 *   crack = (2*gasoline + 1*distillate) / 3 * 42 - crude
 *
 * This is a US Gulf Coast figure, NOT the Singapore GRM it stands in for. The
 * two track each other loosely but sit at different levels, so whatever renders
 * it has to say which one it is.
 */

import { ParseError } from '../lib/errors.mjs';

const GALLONS_PER_BARREL = 42;

/**
 * @param {{gasoline:{date,value}[], distillate:{date,value}[], crude:{date,value}[]}} inputs
 *        each oldest-first, $/gal for products and $/bbl for crude
 * @returns {{date:string,value:number}[]} months present in all three, oldest first
 */
export function crackSpread321({ gasoline, distillate, crude }) {
  for (const [name, arr] of Object.entries({ gasoline, distillate, crude })) {
    if (!Array.isArray(arr) || !arr.length) {
      throw new ParseError(`crack spread: ${name} series was empty`, { source: 'crack' });
    }
  }

  const byDate = (arr) => new Map(arr.map((p) => [p.date, p]));
  const G = byDate(gasoline), D = byDate(distillate), C = byDate(crude);

  const out = [];
  for (const date of [...C.keys()].sort()) {
    const g = G.get(date), d = D.get(date), c = C.get(date);
    // A month missing from any leg is skipped, never part-computed.
    if (!g || !d || !c) continue;
    const products = ((2 * g.value + d.value) / 3) * GALLONS_PER_BARREL;
    const value = Math.round((products - c.value) * 100) / 100;
    // The trailing month is partial only if every leg agrees it is.
    const partial = Boolean(g.partial && d.partial && c.partial);
    out.push(partial ? { date, value, partial: true } : { date, value });
  }

  if (!out.length) {
    throw new ParseError('crack spread: no month had all three legs', { source: 'crack' });
  }
  return out;
}
