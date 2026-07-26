/**
 * Screener "Documents / Concalls" section -> the transcript and PPT links.
 * Pure: cheerio in, link records out.
 *
 * Screener lists each earnings call as a row carrying a month label and a set of
 * anchors whose visible text names them - "Transcript", "Notes", "PPT", "REC":
 *
 *   <div class="documents concalls">
 *     <ul class="list-links">
 *       <li>
 *         <div class="ink-600 ...">Aug 2025</div>
 *         <a href="https://.../transcript.pdf">Transcript</a>
 *         <a href="...">Notes</a>
 *         <a href="https://.../ppt.pdf">PPT</a>
 *       </li>
 *       ...
 *     </ul>
 *   </div>
 *
 * Anchored on that link text, not on class names, because the text is the stable
 * part - a restyle renames a class, not the word "Transcript". Rows are returned
 * newest-first, the order Screener lists them.
 */

import { load } from 'cheerio';

const MONTH_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})\b/;
const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

function periodIso(label) {
  const m = String(label).match(MONTH_RE);
  if (!m) return null;
  return `${m[2]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}`;
}

/**
 * A URL that names an actual document, so it is worth a scraper retry when a
 * direct download fails. Index / landing / HTML pages are excluded on purpose:
 * recovering ONGC's "/investors/transcription" listing would hand back a nav
 * menu dressed up as a transcript, the kind of fake this pipeline refuses.
 */
export function looksLikeDoc(url) {
  return /\.pdf(\/|\?|$)/i.test(url) || /AnnPdfOpen|AttachLive|corpfiling/i.test(url);
}

/** Make a possibly-relative Screener href absolute. */
export function absoluteUrl(href, base = 'https://www.screener.in') {
  const h = String(href || '').trim();
  if (!h) return null;
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith('//')) return `https:${h}`;
  return base.replace(/\/$/, '') + (h.startsWith('/') ? h : `/${h}`);
}

/** Classify a concall anchor by its visible text. */
function linkKind(text) {
  const t = String(text).toLowerCase();
  if (t.includes('transcript')) return 'transcript';
  if (t.includes('ppt') || t.includes('present')) return 'ppt';
  if (t.includes('note')) return 'notes';
  if (t.includes('rec')) return 'rec';
  return null;
}

/**
 * @param {string} html full company-page markup
 * @returns {{period:string, periodIso:string|null, transcript:string|null,
 *            ppt:string|null, notes:string|null}[]} newest first
 */
export function parseConcalls(html) {
  const $ = load(html);
  const out = [];

  // The concalls block, however Screener nests it. Fall back to any list under
  // #documents if the class name ever moves.
  let items = $('.documents.concalls li');
  if (!items.length) items = $('#documents .concalls li');

  items.each((_, li) => {
    const $li = $(li);
    const label = ($li.text().match(MONTH_RE) || [])[0] || null;

    const links = { transcript: null, ppt: null, notes: null };
    $li.find('a').each((__, a) => {
      const kind = linkKind($(a).text());
      if (!kind || kind === 'rec') return;
      if (!links[kind]) links[kind] = absoluteUrl($(a).attr('href'));
    });

    if (label && (links.transcript || links.ppt || links.notes)) {
      out.push({ period: label, periodIso: periodIso(label), ...links });
    }
  });

  return out;
}

/**
 * The raw material prompt 7 reads, in the priority the extractor should try:
 *   notes   - Screener's own concise concall summary (dense, cheap, HTML)
 *   ppt     - the latest investor presentation (guidance, capex, segments)
 *   transcripts - the full calls, FALLBACK only when the above fall short
 *
 * Each doc carries a `role` naming which of those it is; `role` also tells the
 * downloader whether to expect a PDF (transcript/ppt) or HTML (notes).
 *
 * @returns {{notes:object[], ppt:object|null, transcripts:object[]}}
 */
export function selectDocuments(concalls, { transcripts = 4, notes = 4 } = {}) {
  const pick = (key, role, n) => concalls.filter((c) => c[key]).slice(0, n)
    .map((c) => ({ type: role, role, period: c.period, periodIso: c.periodIso, url: c[key] }));

  const firstPpt = concalls.find((c) => c.ppt);
  return {
    notes: pick('notes', 'notes', notes),
    ppt: firstPpt
      ? { type: 'ppt', role: 'ppt', period: firstPpt.period, periodIso: firstPpt.periodIso, url: firstPpt.ppt }
      : null,
    transcripts: pick('transcript', 'transcript', transcripts)
  };
}
