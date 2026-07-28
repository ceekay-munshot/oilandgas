/**
 * Part C, step 2: "For each backbone company, check exchange filings / IR pages
 * / Screener for any result, presentation or transcript newer than the stored
 * latest." Pure comparison, no network.
 *
 * The company's Screener page has to be loaded either way - that IS the filing
 * check. What this decides is whether the expensive part follows: downloading a
 * dozen PDFs and summary pages per company, which is what makes a full run
 * fourteen minutes rather than two.
 *
 * The hazard this module exists to make safe: the document cache is gitignored,
 * so it is empty on every CI run. Skipping the downloads therefore leaves a
 * company with NO text, and the extractors key their fingerprint on the
 * documents they can see. An empty document set is a different fingerprint,
 * which re-opens settled cells and sends the model a question with no source
 * attached - paying for an answer that can only be null. So a skip is never
 * inferred from an empty cache; it is recorded explicitly on the manifest, and
 * the extractors skip the company outright rather than re-deriving anything.
 */

/** Every period this manifest entry holds a document for. */
export function periodsOf(entry) {
  if (!entry) return [];
  const out = [];
  const take = (d) => { if (d && d.periodIso) out.push(d.periodIso); };
  (entry.summaries || []).forEach(take);
  (entry.transcripts || []).forEach(take);
  take(entry.ppt);
  return out;
}

/** The newest period the manifest already holds for a company, or null. */
export function newestPeriodIso(entry) {
  const ps = periodsOf(entry).filter(Boolean).sort();
  return ps.length ? ps[ps.length - 1] : null;
}

/**
 * Is there anything on the page we have not already gathered?
 *
 * True whenever a document carries a period newer than the stored latest, and
 * true whenever we hold nothing at all - a company with no manifest has to be
 * gathered before it can be skipped.
 *
 * Deliberately conservative: a document whose period cannot be read counts as
 * new. Skipping on an unparsable date would silently freeze a company, and the
 * cost of being wrong in this direction is one extra gather, not a wrong number.
 *
 * @param {object|null} prevEntry the stored manifest entry for this company
 * @param {{periodIso?:string}[]} docs  what the page lists now
 */
export function hasNewFiling(prevEntry, docs) {
  const stored = newestPeriodIso(prevEntry);
  if (!stored) return true;                       // nothing held: gather
  const list = Array.isArray(docs) ? docs : [];
  if (!list.length) return false;                 // page lists nothing new to take
  return list.some((d) => !d || !d.periodIso || d.periodIso > stored);
}

/**
 * Did the previous run actually leave usable text for this company?
 *
 * A company whose documents all failed - gated summaries, scans needing OCR -
 * must never be skipped: there is nothing stored to fall back on, and skipping
 * would make the failure permanent.
 */
export function hasUsableDocs(prevEntry) {
  if (!prevEntry) return false;
  /* !! because a missing ppt makes the && chain evaluate to null, and a
     predicate that answers "null" to a yes/no question invites a caller to
     treat it as neither. */
  const ok = (d) => !!(d && d.status === 'ok' && (d.chars || 0) > 0);
  return (prevEntry.summaries || []).some(ok) ||
         (prevEntry.transcripts || []).some(ok) ||
         ok(prevEntry.ppt);
}

/**
 * The decision, with the reason it was taken - so a skipped company says why
 * in the run log rather than just going quiet.
 *
 * @returns {{skip:boolean, reason:string}}
 */
export function filingDecision(prevEntry, docs, { incremental = false } = {}) {
  if (!incremental) return { skip: false, reason: 'full gather (incremental off)' };
  if (!hasUsableDocs(prevEntry)) {
    return { skip: false, reason: 'nothing usable stored from the last run' };
  }
  if (hasNewFiling(prevEntry, docs)) {
    return { skip: false, reason: 'a newer filing is listed' };
  }
  return { skip: true, reason: `nothing newer than ${newestPeriodIso(prevEntry)}` };
}
