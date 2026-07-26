/**
 * PDF -> plain text, with an honest verdict when there is no text to get.
 *
 * pdf-parse v2 exports a PDFParse class (the v1 default-function API is gone).
 * Many Indian filings - especially older concall transcripts and scanned PPTs -
 * have no text layer: they are page images. pdf-parse returns (almost) nothing
 * for those, and the right answer is "ocr_needed", not "failed" and never a
 * guess at what the pages might say.
 *
 * The pure helpers (isPdf, classify) are separated from the async extract so
 * they can be unit-tested without a real PDF and without loading pdf-parse.
 */

/** A real PDF starts with "%PDF-". A login redirect or 404 page will not. */
export function isPdf(buffer) {
  if (!buffer || !buffer.length) return false;
  const head = Buffer.from(buffer.subarray(0, 5)).toString('latin1');
  return head === '%PDF-';
}

/** Collapse whitespace the way a char-count should see it. */
export function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Decide what a downloaded document actually is.
 * @param {Buffer} buffer raw bytes
 * @param {string} text   whatever pdf-parse extracted (may be empty)
 * @returns {{status:'ok'|'ocr_needed'|'not_pdf', chars:number}}
 */
export function classify(buffer, text) {
  if (!isPdf(buffer)) return { status: 'not_pdf', chars: normalizeText(text).length };
  const chars = normalizeText(text).length;
  // A genuine transcript runs to tens of thousands of characters. A scanned one
  // yields a handful at most (stray embedded text, page numbers). 200 is well
  // clear of both.
  return chars < 200 ? { status: 'ocr_needed', chars } : { status: 'ok', chars };
}

/**
 * Verdict for an HTML document (a Screener Notes page, say) rather than a PDF.
 * There is no OCR case here - HTML either carries text or it does not.
 * @returns {{status:'ok'|'thin', chars:number}}
 */
export function classifyHtml(text) {
  const chars = normalizeText(text).length;
  return { status: chars >= 200 ? 'ok' : 'thin', chars };
}

/**
 * Extract text from a PDF buffer.
 * @param {Buffer} buffer
 * @returns {Promise<{status:string, chars:number, text:string, pages:number|null}>}
 */
export async function extractPdfText(buffer) {
  if (!isPdf(buffer)) {
    return { status: 'not_pdf', chars: 0, text: '', pages: null };
  }
  const { PDFParse } = await import('pdf-parse');
  let text = '', pages = null;
  try {
    const parser = new PDFParse({ data: buffer });
    const res = await parser.getText();
    text = res?.text ?? '';
    pages = res?.total ?? res?.numpages ?? (Array.isArray(res?.pages) ? res.pages.length : null);
  } catch {
    // A malformed or encrypted PDF is a no-text-layer case for our purposes:
    // there is nothing to hand the extractor, so it needs OCR or a human.
    return { status: 'ocr_needed', chars: 0, text: '', pages: null };
  }
  const verdict = classify(buffer, text);
  return { status: verdict.status, chars: verdict.chars, text, pages };
}
