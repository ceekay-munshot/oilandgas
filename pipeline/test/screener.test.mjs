/**
 * Pure-parser tests for the Screener scraper. No browser, no network - the
 * fixtures below mirror the Screener DOM the live pages actually serve. The
 * logged-in Playwright half is exercised by the "Refresh company data" workflow,
 * not here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseFinancialTable, parseAllFinancials, cleanLabel, parseCell, periodToIso
} from '../parsers/screener-financials.mjs';
import { parseConcalls, selectDocuments, absoluteUrl, looksLikeDoc } from '../parsers/screener-docs.mjs';
import { parseProsCons } from '../parsers/screener-summary.mjs';
import { parseCompanySlug, slugFromUrl } from '../parsers/screener-search.mjs';
import { isPdf, classify, classifyHtml, normalizeText } from '../lib/pdf.mjs';
import { ParseError } from '../lib/errors.mjs';

/* ------------------------------------------------------------ financials --- */

const FIN_HTML = `
<section id="quarters"><div class="responsive-holder">
  <table class="data-table responsive-text-nowrap">
    <thead><tr>
      <th class="text"></th><th>Mar 2024</th><th>Jun 2024</th><th>Sep 2024</th>
    </tr></thead>
    <tbody>
      <tr><td class="text"><button class="button-plain">Sales<span class="blue">&nbsp;+</span></button></td>
          <td>1,23,456</td><td>1,30,000</td><td>1,25,500</td></tr>
      <tr><td class="text">Operating Profit</td><td>20,000</td><td>22,000</td><td>-1,500</td></tr>
      <tr><td class="text">OPM&nbsp;%</td><td>16%</td><td>17%</td><td>-1%</td></tr>
      <tr><td class="text">Net Profit</td><td>10,000</td><td>11,000</td><td></td></tr>
    </tbody>
  </table>
</div></section>
<section id="profit-loss"><table class="data-table"><thead><tr>
  <th class="text"></th><th>Mar 2023</th><th>Mar 2024</th><th>TTM</th>
</tr></thead><tbody>
  <tr><td class="text">Sales</td><td>4,00,000</td><td>5,00,000</td><td>5,20,000</td></tr>
</tbody></table></section>`;

test('parseFinancialTable reads periods, iso, and rows oldest->newest', () => {
  const q = parseFinancialTable(FIN_HTML, 'quarters');
  assert.deepEqual(q.periods, ['Mar 2024', 'Jun 2024', 'Sep 2024']);
  assert.deepEqual(q.periodsIso, ['2024-03', '2024-06', '2024-09']);
  assert.deepEqual(q.rows['Sales'], [123456, 130000, 125500]);
  assert.deepEqual(q.rows['Operating Profit'], [20000, 22000, -1500]);
});

test('a percent row keeps its % label and parses the numbers', () => {
  const q = parseFinancialTable(FIN_HTML, 'quarters');
  assert.deepEqual(q.rows['OPM %'], [16, 17, -1]);
});

test('a blank cell is null, never 0 - an unreported quarter is not zero earnings', () => {
  const q = parseFinancialTable(FIN_HTML, 'quarters');
  assert.deepEqual(q.rows['Net Profit'], [10000, 11000, null]);
});

test('parseAllFinancials reports which statements are present and which absent', () => {
  const all = parseAllFinancials(FIN_HTML);
  assert.deepEqual(all.sectionsFound, ['quarters', 'profit-loss']);
  assert.deepEqual(all.sectionsMissing, ['balance-sheet', 'cash-flow', 'ratios']);
});

test('a TTM column parses but has no iso month', () => {
  const p = parseFinancialTable(FIN_HTML, 'profit-loss');
  assert.deepEqual(p.periods, ['Mar 2023', 'Mar 2024', 'TTM']);
  assert.deepEqual(p.periodsIso, ['2023-03', '2024-03', null]);
});

test('parseFinancialTable returns null for an absent section', () => {
  assert.equal(parseFinancialTable(FIN_HTML, 'cash-flow'), null);
});

test('cleanLabel strips the expand-button plus but keeps a real %', () => {
  assert.equal(cleanLabel('Sales +'), 'Sales');
  assert.equal(cleanLabel('OPM %'), 'OPM %');
});

test('parseCell handles Indian grouping, percent, negatives and blanks', () => {
  assert.equal(parseCell('1,23,456'), 123456);
  assert.equal(parseCell('16%'), 16);
  assert.equal(parseCell('-1,500'), -1500);
  assert.equal(parseCell(''), null);
  assert.equal(parseCell('-'), null);
  assert.equal(parseCell('N/A'), null);
});

test('periodToIso maps month-year, rejects TTM', () => {
  assert.equal(periodToIso('Mar 2024'), '2024-03');
  assert.equal(periodToIso('September 2023'), '2023-09');
  assert.equal(periodToIso('TTM'), null);
});

/* ------------------------------------------------------------- documents --- */

// Mirrors the real Screener concall row: Transcript and PPT are <a href>; the AI
// Summary is a <button> carrying its endpoint in data-url; PPT is greyed out (no
// href) on the older quarters.
const DOC_HTML = `
<section id="documents"><div class="documents concalls"><h3>Concalls</h3>
  <ul class="list-links">
    <li><div class="ink-600">Aug 2025</div>
      <a href="https://www.bseindia.com/x/aug-transcript.pdf">Transcript</a>
      <button class="concall-link" type="button" data-url="/concalls/summary/23052054/" onclick="Modal.openInModal(event)">AI Summary</button>
      <a href="https://www.bseindia.com/x/aug-ppt.pdf">PPT</a>
      <a href="https://rec.example/audio">REC</a></li>
    <li><div class="ink-600">May 2025</div>
      <a href="https://site.example/may-transcript.pdf">Transcript</a>
      <button class="concall-link" type="button" data-url="/concalls/summary/23052055/">AI Summary</button>
      <a>PPT</a></li>
    <li><div class="ink-600">Feb 2025</div>
      <a href="//cdn.example/feb-transcript.pdf">Transcript</a>
      <button class="concall-link" type="button" data-url="/concalls/summary/23052056/">AI Summary</button>
      <a href="https://site.example/feb-ppt.pdf">PPT</a></li>
  </ul>
</div></section>`;

test('parseConcalls returns rows newest-first with classified links', () => {
  const c = parseConcalls(DOC_HTML);
  assert.equal(c.length, 3);
  assert.equal(c[0].period, 'Aug 2025');
  assert.equal(c[0].periodIso, '2025-08');
  assert.equal(c[0].transcript, 'https://www.bseindia.com/x/aug-transcript.pdf');
  assert.equal(c[0].ppt, 'https://www.bseindia.com/x/aug-ppt.pdf');
  assert.equal(c[0].summary, 'https://www.screener.in/concalls/summary/23052054/');
});

test('parseConcalls reads the AI Summary from the button data-url, and a greyed PPT is null', () => {
  const c = parseConcalls(DOC_HTML);
  assert.equal(c[1].period, 'May 2025');
  assert.equal(c[1].summary, 'https://www.screener.in/concalls/summary/23052055/');
  assert.equal(c[1].ppt, null);                        // <a>PPT</a> with no href
});

test('parseConcalls still accepts the older "Notes" label as a summary', () => {
  const old = '<div class="documents concalls"><ul><li><div>Aug 2025</div> ' +
    '<a href="/n/">Notes</a></li></ul></div>';
  assert.equal(parseConcalls(old)[0].summary, 'https://www.screener.in/n/');
});

test('absoluteUrl resolves protocol-relative and site-relative hrefs', () => {
  assert.equal(absoluteUrl('//cdn.example/a.pdf'), 'https://cdn.example/a.pdf');
  assert.equal(absoluteUrl('/company/x/'), 'https://www.screener.in/company/x/');
  assert.equal(absoluteUrl('https://x/y.pdf'), 'https://x/y.pdf');
});

test('selectDocuments takes AI summaries and PPT as primary, transcripts as fallback', () => {
  const c = parseConcalls(DOC_HTML);
  const picked = selectDocuments(c, { transcripts: 4, summaries: 4 });
  assert.equal(picked.transcripts.length, 3);          // three rows carry a transcript
  assert.equal(picked.transcripts[0].periodIso, '2025-08');
  assert.equal(picked.transcripts[0].role, 'transcript');
  assert.equal(picked.ppt.periodIso, '2025-08');       // newest real PPT, not the greyed one
  assert.equal(picked.ppt.role, 'ppt');
  assert.equal(picked.summaries.length, 3);            // every quarter has an AI Summary
  assert.equal(picked.summaries[0].role, 'summary');
  assert.equal(picked.summaries[0].url, 'https://www.screener.in/concalls/summary/23052054/');
});

test('selectDocuments caps transcripts at the requested count', () => {
  const c = parseConcalls(DOC_HTML);
  assert.equal(selectDocuments(c, { transcripts: 2 }).transcripts.length, 2);
});

/* --------------------------------------------------- screener pros/cons ---- */

const PROSCONS_HTML = `
<div class="company-info">
  <div class="pros"><p class="title">Pros</p><ul>
    <li>Company is almost debt free.</li>
    <li>Company has delivered good profit growth of 25% CAGR.</li>
  </ul></div>
  <div class="cons"><p class="title">Cons</p><ul>
    <li>Stock is trading at 4x its book value.</li>
  </ul></div>
</div>`;

test('parseProsCons reads Screener\'s auto capsule, bullets only', () => {
  const { pros, cons } = parseProsCons(PROSCONS_HTML);
  assert.deepEqual(pros, [
    'Company is almost debt free.',
    'Company has delivered good profit growth of 25% CAGR.'
  ]);
  assert.deepEqual(cons, ['Stock is trading at 4x its book value.']);
});

test('parseProsCons returns empty lists when the section is absent', () => {
  assert.deepEqual(parseProsCons('<div>no analysis here</div>'), { pros: [], cons: [] });
});

/* ---------------------------------------------------------------- search --- */

test('parseCompanySlug takes the best match and reads its slug', () => {
  const json = [
    { id: 1, name: 'Reliance Industries Ltd', url: '/company/RELIANCE/consolidated/' },
    { id: 2, name: 'Reliance Power Ltd', url: '/company/RPOWER/' }
  ];
  const r = parseCompanySlug(json, { query: 'Reliance' });
  assert.equal(r.slug, 'RELIANCE');
  assert.equal(r.matchedName, 'Reliance Industries Ltd');
});

test('parseCompanySlug skips a merged shell and prefers the active listing', () => {
  // A merged/defunct entity often matches the plain name and comes back first;
  // taking result[0] is how a company resolves to a dead ticker.
  const json = [
    { id: 1234, name: 'Gujarat Gas Company Ltd(Merged)', url: '/company/GUJRATGAS/consolidated/' },
    { id: 9, name: 'Gujarat Gas Ltd', url: '/company/GUJGAS/consolidated/' }
  ];
  const r = parseCompanySlug(json, { query: 'Gujarat Gas' });
  assert.equal(r.slug, 'GUJGAS');
  assert.equal(r.matchedName, 'Gujarat Gas Ltd');
});

test('parseCompanySlug falls back to the merged shell when no active listing exists', () => {
  // The entity really was amalgamated away - better to resolve to the known
  // shell than to throw and fail the company outright.
  const json = [{ id: 1234, name: 'Gujarat Gas Company Ltd(Merged)', url: '/company/GUJRATGAS/consolidated/' }];
  assert.equal(parseCompanySlug(json, { query: 'Gujarat Gas' }).slug, 'GUJRATGAS');
});

test('slugFromUrl pulls the slug out of either url shape', () => {
  assert.equal(slugFromUrl('/company/ONGC/consolidated/'), 'ONGC');
  assert.equal(slugFromUrl('/company/DEEPINDS/'), 'DEEPINDS');
  assert.equal(slugFromUrl('/nonsense'), null);
});

test('parseCompanySlug throws when nothing matched', () => {
  assert.throws(() => parseCompanySlug([], { query: 'zzz' }), ParseError);
});

/* ------------------------------------------------------------------- pdf --- */

const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(20, 0x20)]);
const HTML_BYTES = Buffer.from('<!doctype html><title>login</title>');

test('isPdf recognises the magic header only', () => {
  assert.equal(isPdf(PDF_BYTES), true);
  assert.equal(isPdf(HTML_BYTES), false);
  assert.equal(isPdf(Buffer.alloc(0)), false);
});

test('classify separates real text, scanned PDFs and non-PDFs', () => {
  assert.equal(classify(PDF_BYTES, 'x'.repeat(500)).status, 'ok');
  assert.equal(classify(PDF_BYTES, 'only a few chars').status, 'ocr_needed');
  assert.equal(classify(HTML_BYTES, 'whatever').status, 'not_pdf');
});

test('normalizeText collapses whitespace for an honest char count', () => {
  assert.equal(normalizeText('  a\n\n  b  '), 'a b');
  assert.equal(classify(PDF_BYTES, '   \n  ').status, 'ocr_needed');   // whitespace-only = scanned
});

test('classifyHtml passes a real page and flags a near-empty one as thin', () => {
  assert.equal(classifyHtml('x'.repeat(500)).status, 'ok');
  assert.equal(classifyHtml('   ').status, 'thin');
});

/* ---------------------------------------------------- scraper-retry gate --- */

test('looksLikeDoc allows real document URLs', () => {
  // ONGC's own-site PDF (Liferay-style path with .pdf mid-URL) and BSE filings.
  assert.equal(looksLikeDoc('https://ongcindia.com/documents/77751/x/Transcription181125.pdf/6f9e'), true);
  assert.equal(looksLikeDoc('https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=abc.pdf'), true);
  assert.equal(looksLikeDoc('https://site/report.pdf'), true);
  assert.equal(looksLikeDoc('https://site/report.pdf?v=2'), true);
});

test('looksLikeDoc refuses index/landing/HTML pages so they are not faked', () => {
  // Recovering these would hand back a nav menu, not a transcript.
  assert.equal(looksLikeDoc('https://ongcindia.com/web/eng/investors/transcription'), false);
  assert.equal(looksLikeDoc('https://www.morningstar.com/stocks/xnse/ongc/earnings-transcript'), false);
});
