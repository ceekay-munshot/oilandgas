/**
 * PPAC monthly gas-price notification -> the two prices it carries. Pure.
 *
 * The notification is a scanned one-page PDF; Firecrawl OCRs it. Verified
 * against the real July 2026 document (probe run 2026-07-26), which reads:
 *
 *   "...the price of Domestic Natural Gas for the period 1st July 2026 to
 *    31st July 2026 is notified as US$ 8.73/MMBTU on Gross Calorific Value
 *    (GCV) basis. Further, in accordance with Para 4 of the said notification,
 *    for the gas produced by ONGC/OIL from their nomination fields, the
 *    above-mentioned APM price shall be subject to a ceiling of US$ 7.00/MMBTU
 *    on GCV basis for the same period."
 *
 * Two different numbers, and the difference matters. 8.73 is the notified
 * domestic gas price; 7.00 is the ceiling that actually applies to ONGC and Oil
 * India's nomination-field gas. What those producers realise is the ceiling, so
 * that is the APM figure - but both are returned, because reading the wrong one
 * would be a 25% error that still looks entirely plausible.
 */

import { ParseError } from '../lib/errors.mjs';
import { toText } from './quote.mjs';

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};

/**
 * @param {string} html OCR'd document text or markup
 * @returns {{ceiling:number|null, notified:number|null, value:number,
 *            periodStart:string|null, periodLabel:string|null, publishedOn:string|null}}
 */
export function parsePpacGasNotification(html) {
  const text = toText(html);

  // "...subject to a ceiling of US$ 7.00/MMBTU..."
  const ceilingMatch = text.match(/ceiling\s+of\s+US\$?\s*([\d.,]+)\s*\/?\s*MMBTU/i);
  // "...is notified as US$ 8.73/MMBTU..."
  const notifiedMatch = text.match(/notified\s+as\s+US\$?\s*([\d.,]+)\s*\/?\s*MMBTU/i);

  const num = (m) => (m ? Number(String(m[1]).replace(/,/g, '')) : null);
  const ceiling = num(ceilingMatch);
  const notified = num(notifiedMatch);

  // The ceiling is what ONGC/OIL nomination gas actually realises; fall back to
  // the notified price only if the ceiling paragraph is absent.
  const value = ceiling ?? notified;
  if (!Number.isFinite(value)) {
    throw new ParseError('PPAC notification had neither a ceiling nor a notified price', {
      source: 'ppac-notification',
      sample: text.slice(0, 400)
    });
  }
  if (value <= 0 || value > 40) {
    throw new ParseError(`PPAC gas price ${value} $/MMBTU is outside any plausible range`, {
      source: 'ppac-notification',
      sample: text.slice(0, 400)
    });
  }

  // "for the period 1st July 2026 to 31st July 2026"
  let periodStart = null, periodLabel = null;
  const period = text.match(
    /for\s+the\s+period\s+(\d{1,2})\s*(?:st|nd|rd|th)?\s*([A-Za-z]+)\s*(\d{4})\s*to\s*(\d{1,2})\s*(?:st|nd|rd|th)?\s*([A-Za-z]+)\s*(\d{4})/i
  );
  if (period) {
    const m = MONTHS[String(period[2]).toLowerCase()];
    if (m) {
      periodStart = `${period[3]}-${String(m).padStart(2, '0')}-01`;
      periodLabel = `${period[1]} ${period[2]} ${period[3]} to ${period[4]} ${period[5]} ${period[6]}`;
    }
  }

  // "Dated: 30.06.2026" - when the notification was issued, which is the day
  // before the period it covers. Kept as provenance, not used as the data date.
  let publishedOn = null;
  const dated = text.match(/Dated\s*:?\s*(\d{2})\.(\d{2})\.(\d{4})/i);
  if (dated) publishedOn = `${dated[3]}-${dated[2]}-${dated[1]}`;

  return { ceiling, notified, value, periodStart, periodLabel, publishedOn };
}
