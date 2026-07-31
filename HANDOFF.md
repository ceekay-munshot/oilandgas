# Oil & Gas Cycle Dashboard — working context

Read this first if you are picking the project up in a new session. It is the
state of play, the rules that are not negotiable, and what to do next.

Last updated after building the client's full specification (Parts A-D) - the
cycle-scoring spine, all five dashboard sections, the refresh architecture and
the source-tagging rules. Branch `claude/company-data-derived-kpis-uwm535`.

**The specification is the authority.** It is a Word document held by the client
("Oil & Gas Cycle Dashboard - Pipeline Specification, Dashboard Layout & Refresh
Architecture - v2"). Where this file and the brief disagree, the brief wins. Two
places where an earlier reading of it was WRONG and has been corrected are called
out below, because both were the kind of mistake that looks right in code review.

---

## What this is

A static dashboard showing where India's oil & gas capex cycle is and which
companies benefit. Built over ~13 prompts for a client; prompts 1–7 are done.

- **Front end** — one `index.html`, plain HTML/CSS/JS, ECharts 5.5.1 from
  jsDelivr. No framework, no build step. The page never scrolls.
- **Pipeline** — Node ESM under `pipeline/`, run by GitHub Actions, writing JSON
  into `data/` and committing it to `main`.
- **Deploy** — Cloudflare Workers builds on every push to `main`.
- **Branch** — all work goes on `claude/oil-gas-dashboard-foundation-honnto`,
  then a PR to `main`. Never push to a different branch without asking.

---

## Non-negotiable rules

These came from the client and from mistakes already made. Breaking one is worse
than shipping nothing.

1. **Never invent a number.** A value that cannot be sourced is `null` with a
   short note saying why. Every honesty mechanism in the pipeline exists because
   this is the product.
2. **Never commit fabricated data to `data/`.** Not even as a fixture to check a
   render. Test fixtures live in `pipeline/test/`.
3. **All keys from `process.env`** (GitHub Actions secrets). Never hardcode,
   commit, or ship a key to the browser. `.env` is gitignored.
4. **Never put `[skip ci]` in a commit message.** Nothing on GitHub triggers on
   push, so it suppresses nothing there — its only effect is telling Cloudflare
   to skip the deploy, which is what puts refreshed data on the live site.
   Cloudflare scans the *whole* message, body included.
5. **`pipeline/cache/` is gitignored** (document text, ~8 MB). Commit only the
   JSON under `data/`.
6. **Keep all 27 companies.** The count is intentional.
7. **A label must describe what happened, not what was attempted.** This has been
   violated twice and caught twice — see "mistakes worth not repeating".

---

## Current state

| | |
|---|---|
| KPI coverage | **117 / 224 cells**, 30 of 58 KPIs have a trajectory flag |
| Companies | 27, all with financials, docs and an Insights table |
| Insights table | 26 of 27 on the **quarterly** view, **1,150 values** parsed |
| Deterministic mapping | 27 of 58 KPIs mapped → filled from Screener's table, no model call |
| Derived | **4 cells** computed from held figures (EBITDA/scm), formula in the note |
| Store | `data/kpi-store.json`, 27 companies, **121 cells held**, accumulates forever |

> How coverage got to 117: the deterministic Insights fill took it **97 → 113**
> (its first `scope: all` run), and the derived step took it **113 → 117**. It can
> only go up — a null never displaces a number.

### Data files (all committed)

| File | What it holds |
|---|---|
| `data/companies.json` | 27 companies in groups, with resolved Screener slugs |
| `data/kpi-spec.json` | The client's exact KPI list per company + `insightsRows` mapping |
| `data/framework.json` | Source tags, trajectory flags, `flatBandPct` dead-band |
| `data/macro.json` | 6 macro tiles |
| `data/financials.json` | Screener statements + Pros/Cons per company |
| `data/docs-manifest.json` | Which transcripts / PPTs / AI summaries were cached |
| `data/insights.json` | Screener's Investors → Insights grid, parsed, **with citations** |
| `data/kpis.json` | The dashboard's view: current window + flags |
| `data/kpi-store.json` | **The durable record.** Every value ever extracted |

---

## How the KPI pipeline works

```
scrape-screener.mjs      fetch-ppac-kpis.mjs      extract-kpis.mjs
  login (paid account)     findSnapshots()          1. seed store from kpis.json (once)
  resolve slug             scrapePage() -> OCR      2. fillFromInsights()  <- deterministic, cited
  financials + Pros/Cons   parseRefinerTotals()     3. planCompany()       <- what is still missing
  Insights grid (quarterly) parseDataMonth()        4. one LLM call for the gaps only
  AI summaries x6          applyPpacToStore()       5. mergeIntoStore()    <- rank rules
  PPT + transcripts x6       -> kpi-store.json      6. fillDerived()       <- arithmetic on held figures
     -> pipeline/cache/       tagged [Official]     7. mergeIntoStore()    <- gaps only, tagged estimate
                                                    8. renderWindow()      -> data/kpis.json
                                                       (unit guard applies here)
```

**Order matters.** `fetch-ppac-kpis` runs *before* `extract-kpis` so the
ministry's throughput figures are already in the store when the planner decides
what to ask. The model is then never asked — and never paid — for a number the
government already published.

### PPAC — refinery throughput, [Official]

`pipeline/fetch-ppac-kpis.mjs` + `lib/ppac-fill.mjs` + `parsers/ppac-snapshot.mjs`.

- The document is PPAC's **Snapshot of India's Oil & Gas Data / Monthly Ready
  Reckoner** — *not* the Flash Report, which the probe of 2026-07-29 settled is
  national product consumption with **no company named anywhere in it**.
- It is a scanned PDF: 559 characters of text layer from 539 KB. It needs
  Firecrawl's OCR, which is why this step needs a scraper key and why nothing
  about it can be tested locally.
- **Two column layouts under one heading** (9 numbers for IOCL/CPCL/BPCL/NRL,
  10 for ONGC/HPCL/HMEL/RIL — the second inserts an extra year). A row whose
  count matches neither is skipped, not guessed at.
- PPAC publishes **April-to-date**, so a quarter is a difference between
  consecutive year-to-date readings, and only editions at a quarter *end*
  (Jun/Sep/Dec/Mar) can close one. A mid-quarter edition is read and discarded.
- **There is no archive** of past editions on any PPAC listing page (checked:
  `/archives` has none, `/reports-studies` 500s, `/publications` lists only the
  Flash Reports). So the series accrues one quarter per edition, and a backfill
  needs `--url` with a URL found elsewhere.
- It **never fails the run**: no key, a listing page down, a layout change — all
  leave the store untouched, exit 0, and say so in the log.
- Test the OCR path with **`probe-macro.yml` → `ppac-kpis`**: it runs the whole
  fetcher with `--dry-run`, so discovery, OCR, parse, quarter arithmetic and the
  merge all happen for real and only the write is skipped.

### The store (`pipeline/lib/kpi-store.mjs`)

The single most important piece. Rules, in force:

- A `null` **never** displaces a number. Coverage can only go up.
- A KPI with no open cells is **not sent to the model**; a company with none
  makes **no call at all**. A steady-state run costs nothing.
- A known-empty cell is only re-asked when a **fingerprint** changes — the
  documents in the window, the KPI spec, or `PROMPT_VERSION` in
  `parsers/kpi-prompt.mjs`. Bump that version when a prompt change should change
  existing answers.
- **Rank**: `ppac: 4` beats `insights: 3` beats `derived: 2` beats `model: 1` /
  `seeded: 1`. Regulator data corrects an aggregator; a cited Insights value
  corrects a model-inferred one in place; a `derived` value (arithmetic on held
  figures) outranks the model but stays below Insights, and in practice only ever
  fills empty cells. Within a rank the first answer stands. The live case:
  BPCL's Q1 FY27 throughput was a **[Mgmt Claim] of 10.15** from a call, and PPAC
  publishes **10.2** — same quarter, independently sourced, agreeing to within a
  rounding step, and the cell is now [Official] with `replaced` recording what
  it displaced.
- What a correction replaced is kept on the cell (`replaced`), so it is auditable.
- **One unit per row.** The strongest-evidenced unit wins; a cell in another unit
  is withheld with the reason. Never rescaled.
- `--refresh` re-asks everything. Only after a fix that should change answers.

### Reliance's results deck — O2C EBITDA/tonne, [Company Filing]

`pipeline/parsers/ril-segments.mjs` + `lib/ril-fill.mjs`, run from `extract-kpis`
before the plan (so the model is never asked for what it answers).

- **What it closes.** "O2C EBITDA per tonne" is one of the four KPIs the brief
  names for Reliance and was blank. `lib/derive.mjs` refuses to compute it and is
  right to: the only EBITDA held elsewhere is **consolidated** — Jio and Retail
  and E&P as well as O2C — so dividing it by refinery tonnes would be a
  fabricated number wearing a formula. The segment EBITDA had to come from the
  filing.
- The deck carries both halves, ~24,000 characters apart, for the same two
  quarters: `Oil to Chemicals 14,511 17,010` (₹ crore) and `Throughput 19.1 18.1`
  (MMT). Q1 FY26 = ₹7,597/t, Q1 FY27 = ₹9,398/t.
- **The refusal that matters.** Those are two tables on two pages and nothing in
  the text guarantees they cover the same periods. Both headers are read and the
  result is refused unless they match — a deck reporting EBITDA year-on-year and
  volumes quarter-on-quarter would yield a number that looks exactly like a
  margin and is not.
- **₹/t, not $/t.** The deck states ₹ crore and MMT and no exchange rate. The
  only rate implied anywhere in it (the balance sheet's `$ Bn` column) belongs to
  the current quarter; applying it to the year-ago quarter would misprice the
  comparison. The brief says "GRM/O2C EBITDA per tonne" without a currency, and
  EBITDA/scm is already stated in rupees. The spec unit was changed to match.
- **Merged over the DECK's quarters, never the window** — same rule as PPAC. A
  deck covers two quarters and the window four; merging over the window writes
  null cells carrying the run's fingerprint, and a null cell with the current
  fingerprint counts as settled, so the model would never be asked about those
  quarters again.
- **Cadence**: two quarters per deck, so the row fills one quarter per refresh.
  Today one cell lands in the window (Q1 FY27) and Q1 FY26 waits in the store.
- **Header read BACKWARDS from the data row.** Anchoring forwards on `₹ crore`
  found the balance sheet's header — the phrase appears three times — and
  returned nothing.

**GAIL's petchem margin is NOT reachable this way.** The deck we cache for GAIL
is a corporate overview: EBITDA is annual (FY22–FY26) and there is no quarterly
segment table. It needs a different document than the one the scraper takes.

### Rows beyond the brief's KPI list (`beyondBrief`)

The brief names **exact KPIs per company** (Step 2, tables 2a/2b/2c). The grid now
carries 114 rows where the brief's list is 70. The extra 44 are marked and
**held out of the cycle score**.

- `beyondBrief: true` in `data/kpi-spec.json` → carried through `renderWindow` →
  `scoreGroup` skips the row entirely, including from `kpisTotal`, so the
  coverage guard keeps measuring the brief's list rather than a diluted version.
  The count comes back as `kpisBeyondBrief`.
- **Why**: Step 4's interpretation framework was specified against the brief's
  list. Letting the extras in would reweight every bucket by how much spare data
  a company happens to publish — IOCL would carry 8 rows into coincident where
  the brief gives it 3, and the refiners would outvote the gas utilities for no
  analytical reason.
- **12 rows carry no marker and DO score**, because the brief named them and the
  dashboard simply did not have them: Reliance's *upstream volume* (KG-D6),
  Petronet's *Kochi* terminal (the brief says "Dahej + Kochi"), Mahanagar's
  *industrial PNG mix*, ONGC/Oil India gas production ("production volume**s**"),
  GE Shipping's product-carrier rate and fleet deployment, Shipping Corp's second
  tanker rate, Jindal's second day rate, Gandhar's base-oil spread.
- `cycleRole` is set only where a row's own lead/lag behaviour is **not** its
  company's group — Thermax's order *intake* leads though Thermax is a lagging
  cross-check; Welspun's pipe *deliveries* coincide though Welspun leads on its
  order book. The row stays with its company (that is how the brief groups); the
  marker stops it reading as its neighbours' signal.
- The grid shows `extra` and, where set, `leads` / `lags` / `coincides`, plus a
  per-group "N scored · N extra" chip.

To go back to strictly the brief's list, drop every spec entry with
`beyondBrief: true` — nothing else references them.

### The Insights table (the best source)

Screener Premium's **Investors → Insights** grid. Each value cell carries the
citation inline:

```
11 Presentation - 07 May 2022 “Owns & Operates 8 Workover Rigs...” Page 24 · Source
```

- Value = the **leading** number, anchored at the start (so the `8` inside the
  quote is never mistaken for it).
- Unit is in a `<span class="sub">` after a `<br>`. Read the span, **not**
  `innerText` — the table sits in an inactive tab panel, so `offsetParent` is
  null and `innerText` silently degrades to `textContent`, fusing name and unit.
- The Quarterly control is an **XHR**, not a tab:
  `POST /insights/company/<id>/quarter/?is_consolidated=1`, needs
  `X-Requested-With: XMLHttpRequest` **and** `X-CSRFToken` (Django).
- The view is derived from the **month pattern** of the period headers, never
  from what was clicked (`viewFromPeriods`).

---

## The Commentary tab (management tone)

Tab 4. Built to the same honesty bar as the KPIs, and deliberately a **twin** of
the KPI pipeline rather than a new idea:

```
extract-commentary.mjs
  gather each quarter's own concall (AI summary preferred, transcript fills)
  window = 4 most recent quarters with text
  fingerprint (docs + prompt version)   -> commentary-store.mjs (durable)
  plan: ask the model ONLY about unsettled quarters
  one LLM call: tone per quarter on the 5-step scale + a verbatim quote + why
  merge (null never overwrites a real tone) -> render -> data/commentary.json
```

- **Files.** `parsers/commentary-prompt.mjs` (prompt, `TONE_SCHEMA`, `normalizeResult`,
  `COMMENTARY_PROMPT_VERSION`), `lib/commentary-store.mjs` (accumulate/plan/merge/render,
  reuses `fingerprintFor`/`docsSignature` from `kpi-store`), `extract-commentary.mjs`
  (orchestrator). Durable record: `data/commentary-store.json`; the view the tab reads:
  `data/commentary.json`. 18 tests in `test/commentary.test.mjs` (suite now **201**).
- **The five tones** mirror `framework.json` `toneScale` (confident 5 … defensive 1).
  An unrecognised label is dropped to null, never coerced; a quarter with no concall
  is null, never a guess; each real tone carries the quote it rests on.
- **Render.** `renderCommentary()` colours the heat strip from the tones and computes
  "What changed this quarter" (biggest quarter-on-quarter move per company) in the
  browser. `index.html` loads `data/commentary.json` optionally, so the tab degrades
  to "No data yet" until the pipeline writes it.
- **Rollout.** Wired into `refresh-company.yml` and `refresh-full.yml` after the KPI
  step (same job, same cache). Like the KPIs, real tone fills on the **next scheduled
  run** - the paid scrape/LLM can't run locally. A steady-state run classifies nothing
  and spends nothing.
- **Nothing is SEED any more.** The hardcoded object is gone; every number on
  screen is read from `data/*.json`.

---

## Workflows

| Workflow | Trigger | Scope |
|---|---|---|
| `refresh-company.yml` | manual + **05:30 UTC** — daily in earnings months (Jan/Feb, Apr/May, Jul/Aug, Oct/Nov), Mondays otherwise | `smoke` (4 cos) / `all` (27) / `dump` (recon) |
| `refresh-full.yml` | manual + **06:40 UTC**, same cadence an hour later | macro → screener → **ppac** → kpis → commentary → rescore |
| `refresh-macro.yml` | manual + daily all year | 6 macro tiles |
| `probe-macro.yml` | manual | source recon + `ppac-kpis` dry run |

That is the brief's own cadence: stages 2–6 daily during earnings months, weekly
the rest of the year. A run on unchanged data is a no-op — no new filing, nothing
asked, nothing committed — so the daily window costs Actions minutes, not spend.

The schedule runs **`all`**, so the dashboard refreshes itself.

`--scope dump` is the recon mode: it runs the *real* functions against a live
page and prints what each returned, plus raw markup and `innerText` vs
`textContent`. **Use it before writing any selector.** Three rounds were lost on
the Insights table by not doing this.

---

## What to do next

### 1. `scope: all` result — read ✓ (done)

The first `scope: all` run with the deterministic mapping, and the steady-state
run after it, are both in. What they showed:

- **Coverage 97 → 113 / 224** from the Insights fill, then **113 → 117** from the
  derived step. Store holds **121 / 226**.
- **17 stored values corrected** by cited Insights figures (each keeps a
  `replaced` audit trail). The bulk were scale fixes — Engineers India's order
  inflow/book were 10× too small (`1430 → 14292`, `12145 → 121443`), Jindal's
  charter day-rate (`88859 → 48324`), Oil India's production, GE/SCI freight.
- **Petronet's `27` was NOT corrected** — worth knowing. The Insights table
  carries Dahej regas for Q3/Q4 FY26 (94, 90.1) but no Q2 FY26 figure, and a
  correction needs a cited value for that exact cell. So the model's Kochi-terminal
  misread (27%) still stands for Q2 alone. A gap in the table, not a rule failure.
- **L&T is Larsen & Toubro** ✓ — slug `LT`, KPIs are Hydrocarbon order
  inflow/book (₹6–7 lakh cr order book), not the old L&T Finance retail loan book.
  One residue: `data/companies.json` still had `screenerName: "L&T Finance Ltd"`
  (the scraper only re-resolves the name when the slug is *absent*, and the slug
  was hand-fixed). Corrected to `Larsen & Toubro Ltd`; data was already right.

### 2. The remaining gaps, and what each is worth

| Kind | Examples | Prospect |
|---|---|---|
| **Not disclosed anywhere** | Deep's day-rate, EIL's bid pipeline | Won't fill. Commercially sensitive — discussed qualitatively, never quantified. Show as an honest gap. |
| **Market spreads, not company data** | base-oil spread, styrene–polystyrene | Belong in the **macro** pipeline, not company extraction. Different source entirely. |
| **Computable but not stated** | EBITDA/scm, O2C EBITDA/tonne, CNG+PNG volume *growth* | **Done — `lib/derive.mjs`.** See below for what filled and what honestly did not. |
| **Annual cadence** | ONGC's `New well count`, producers' reserves | Real data, but yearly. **Assessed (see §3a):** our *held* Insights evidence carries none of it — the producers' grids hold only quarterly production rows — so there is nothing to surface from what we hold today. The pipeline already withholds any annual figure that lands in a quarterly cell (Oil India's 6.64 case). Surfacing a labelled annual observation is a real feature but needs annual-report sourcing **and** render support, so it is left scoped, not built. |

#### The derived KPIs — what filled, and what stayed a gap

`lib/derive.mjs` computes a cell only when every input is held for that exact
quarter, **and** the formula reproduces the values the store already holds for
that KPI (or it refuses). Gaps only — a held value is never overwritten. Each
derived cell carries `origin: derived`, `sourceTag: derived`, and the formula in
its note. Outcome on the current data:

- **EBITDA/scm → +4 cells.** IGL Q2 FY26 (5.15) and Mahanagar Q1–Q3 FY26
  (12.35 / 7.96 / 8.26). Formula: EBITDA (Screener Operating Profit) ÷ (Total
  Sales Volume MMSCMD × days in quarter). It reproduces the quarters the model
  already had to **<1%**, which is what earns it the blanks between them. Both
  rows are now a full four-quarter series with a trajectory flag.
- **CNG+PNG volume growth → 0 cells, correctly.** IGL/Mahanagar already have all
  four quarters (model), so there is nothing to fill; and Mahanagar's *Total*
  Sales Volume yoy does **not** match its reported CNG+PNG growth (total carries
  industrial & commercial gas), so the reproduce-or-refuse gate rejects it rather
  than write a wrong-basis number. Gujarat Gas held no quarterly volume **on the
  dead shell it was pointed at**; after the `GUJGASLTD` repoint (§3) it should,
  so both EBITDA/scm and CNG+PNG growth become derivable for it on the next run.
- **O2C EBITDA/tonne → stays a gap.** We hold O2C *throughput* but not the O2C
  *segment's* EBITDA — only Reliance's consolidated operating profit (Jio, Retail
  and E&P as well as O2C). Dividing that by refinery tonnes would be a fabricated
  number, so it is deliberately not derived. This is the note-4 trap below.

### 3. Known smaller issues

- **Broken windows.** Some companies have short or gappy windows — Thermax has
  one quarter, ONGC has `Q3 FY25, Q4 FY25, Q2 FY26`. The window is the 4 most
  recent quarters that yielded documents, so a company with thin coverage gets a
  thin window. Worth deciding whether to pad or to state the gap.
- **Gujarat Gas — repointed to the live listing (was a dead shell).**
  `companies.json` pointed at slug `GUJRATGAS` = "Gujarat Gas Company Ltd(Merged)",
  whose data freezes at 2015 (Mar 2015 on the quarterly view; 2021-03 in our
  cached financials). The live city-gas company is **Gujarat Gas Ltd, slug
  `GUJGASLTD`** (mkt cap ~₹25k cr, FY25 revenue ~₹15.4k cr) — now repointed. This
  also **corrects a backwards claim in commit `f1d7bdd`'s message**, which said the
  survivor was GSPL, "a transmission company". It is the reverse: the 2024 composite
  scheme merges GSPC, **GSPL** and GEL *into* Gujarat Gas Ltd (GGL is the surviving,
  CGD-authorised entity), then demerges the transmission business out into a new
  "GSPL Transmission Ltd". So GGL is the correct entity for the city-gas KPIs, not
  a wrong-basis substitute. Real quarterly data — and a proper **quarterly** Insights
  grid (the dead shell's yearly-only view was a symptom of it being dead, not a
  missing-endpoint rule) — fills on the next scrape against the new slug. The store
  holds only nulls for `gujarat-gas`, so nothing stale blocks it, and the changed
  document window re-triggers the empty cells via the fingerprint. *(Data still
  fills on the next Actions run; the paid scrape can't run locally.)*
  - **RESOLVED 2026-07-30 — the watch below fired; now on `GUJENERGY`.**
    `GUJGASLTD` began returning **404** and every scrape since the repoint failed
    with `Screener company page HTTP 404 for GUJGASLTD`. The error was recorded
    honestly on the manifest and nothing said it out loud, so the entry kept the
    *previous* slug's data — `GUJRATGAS`, `asOf: 2021-03`, the dead shell — under
    a fresh run timestamp. Four days, one line in a 27-company log.
    Probed all candidates (2026-07-30):

    | slug | HTTP | page title |
    |---|---|---|
    | `GUJGASLTD` | **404** | — |
    | `GUJENERGY` | 200 | **Gujarat Energy Ltd** — quarterly to Mar 2026, 27 concalls, 15 PPTs |
    | `GUJRATGAS` | 200 | Gujarat Gas Company Ltd**(Merged)** — the dead shell |
    | `GSPL` | 200 | Gujarat State Petronet Ltd — *transmission*, being demerged OUT |

    So the standing "repoint to GSPL vs label-as-merged" question resolves to
    **neither**: GSPL is the wrong business for city-gas KPIs, and the company is
    not merged away — it was renamed. Now `GUJENERGY`, which is the same legal
    entity carrying live data. Fills on the next scrape.
  - **The silence was the real bug.** The scrape summary counted failures and
    never named them, and a failed company keeps its last good entry — stale
    numbers under a fresh timestamp, which reads as working. It now prints every
    failed company by name and slug, with the hint that a 404 usually means the
    slug moved.
- **Companies that returned 0 cells** (from the last `scope: all` run): Reliance,
  L&T, Castrol, Linde, Adani Ports. L&T and Gujarat Gas were both wrong slugs and
  are now fixed; the rest need checking individually.
- **`castrol-india`** returned 0 financial tables — likely standalone-only.
- **Cockpit scores are still `SEED`** — prompts 8+ cover commentary tone and
  rescoring.

### 3a. Annual-cadence data — the assessment (task done)

The question was whether any KPI arrives yearly and is being shown as four
quarterly blanks we could instead fill from **held** evidence. Checked against the
data we actually hold:

- **The producers' Insights grids hold only quarterly rows.** ONGC's grid is
  `Crude Oil Production` and `Natural Gas Production` — both quarterly, no well
  count, no reserves. So the one genuinely annual KPI in the spec, ONGC's
  **New well count**, has no held figure at *any* cadence; it would come from the
  annual report / a PPT, which the model read and returned null for. Nothing to
  surface from held evidence.
- **The dangerous case is already handled.** Where a yearly/cumulative figure
  *does* slip into a quarterly slot, the store's one-unit-per-row guard withholds
  it rather than display it: Oil India's `6.64 MMT / bcm` (an annual-basis number)
  is withheld against the quarterly `MMT` row of `0.85, 0.85, 0.86`. So we never
  show a wrong-cadence number — the honesty machinery covers this without new code.
- **Conclusion.** There is no quick win hiding in held data. Truly surfacing an
  annual observation (e.g. "N wells in FY25", labelled *annual*, in one cell of the
  quarterly grid) is a real feature that needs (a) annual-report sourcing the
  extractor doesn't do yet and (b) a render path that draws a single labelled cell
  instead of four blanks. Left scoped for a later prompt, not built blind — it
  can't be tested here without the paid scrape.

### 3b. The scoring spine (Step 4) - and two corrections worth remembering

`pipeline/lib/cycle-score.mjs` + `pipeline/rescore.mjs` -> `data/scores.json`.
Arithmetic only: no network, no model call, so the chain from a reported figure
to the stage on the dial is inspectable end to end. Run it any time with
`node pipeline/rescore.mjs` - it re-reads `data/` and costs nothing.

- **Bucket score** = net trajectory of the group's flagged KPIs **plus** the tone
  drift of the themes that feed it, signed -100..+100 with zero as "no news".
- **Inflection flags carry DOUBLE weight**, and so does a tone drift of two steps
  or more. This was implemented backwards at first (inflections at *half* weight,
  on the reasoning that a turn is not yet a trend). The brief says the opposite,
  twice, and it is the point of the instrument. Do not "simplify" it back.
- **A stock variable is flagged on its QoQ change row**, a seasonal one on YoY.
  `flagBasis` in `kpi-spec.json` has always carried this; `kpi-flag.mjs` ignored
  it for months and trended every KPI on its level. The dead band stays a
  fraction of the KPI's own level, not of its changes - see the Deep Industries
  case in `test/kpi.test.mjs`.
- **Stale = strictly OLDER than the reporting window's end.** Not "different
  from", which greys the company that reported *early*; and not "older than the
  newest quarter anyone filed", which lets one early filer grey 21 of 27 rows.
- `scoringVersion` guards the change log: a scoring change refuses to diff rather
  than reporting the rescale as movement. **Bump it whenever weights or scale
  change.**
- Every run appends to `data/scores-history.json`, one entry per quarter, so the
  instrument is back-testable against its own past calls (Part C).

### 3c. What the client's own tables drive

Three things in `data/framework.json` are the client's content, not ours, and are
meant to be edited there rather than in code:

- `themes` - the seven listening themes, each naming the companies it covers and
  the bucket its tone scores into.
- `stageActions` - the Step 5b research table, verbatim. Names outside the
  27-company backbone (Man Industries, ISGEC, JNK...) carry `companyId: null` and
  render "no series", because showing them plainly would make an uncovered name
  look covered.
- `standingSix` - unchanged, and still always rendered whatever the stage.

### 4. Deliberately unmapped (do not "fix" these)

Left out of `insightsRows` on purpose, because the row is *related* but is not
the KPI:

- Gandhar's `Manufacturing Gross Margin Spread` ≠ the client's base-oil spread
- IGL / Mahanagar's absolute `Total Sales Volume` ≠ volume **growth**
- Welspun's `Line Pipes Sales Volume` ≠ line-pipe order **inflow**
- Reliance's `O2C Refinery Throughput` ≠ O2C EBITDA per tonne

A wrong number carrying a page citation is worse than a gap, because the citation
makes it look checked.

---

## Mistakes worth not repeating

Each of these cost at least one round. They are here so they cost zero next time.

- **Writing a selector from assumptions about markup never looked at.** Three
  rounds on the Insights table. The `dump` mode existed the whole time.
- **`parseCell` demanded the whole cell be numeric** while Screener ships the
  citation inside it — the table was found, the rows were right, and every value
  was discarded for having its source attached.
- **Clicking "Quarterly" page-wide** hit the *Shareholding* card's toggle, and
  every company recorded `view: "quarterly"` over annual columns.
- **`via` reported `quarterly-fragment`** when the annual table had been parsed —
  a label describing intent rather than data. Introduced by me, two commits after
  building the honesty machinery it violated.
- **The extractor overwrote the whole company entry each run**, so a cell that
  came back real one week was wiped the next week when the pass missed it.
- **`gpt-4o-mini` was doing the extraction** — a default chosen when `llm.mjs`
  was a stub with no consumer, never revisited once it became the thing doing
  careful numeric work.
- **A single pooled context budget** let the newest transcript eat all 24k chars,
  so every KPI came back with one value and no flag. Budget is now reserved
  per source.
- **Quarter mapping from month-array arithmetic** was off by one. It is now an
  explicit table in `lib/fiscal.mjs` — `{6:1, 9:2, 12:3, 3:4}`.
- **Chasing the hard source while the easy one sat unopened.** PPAC took a probe,
  a parser for two column layouts, a quarter-differencing rule and a fetcher — and
  delivered 3 cells. Meanwhile 166 quarterly, page-cited values sat in
  `data/insights.json` waiting only for a `insightsRows` line in the spec. Before
  building an ingest for a new source, check what is already parsed and unmapped.
- **Re-binding a delegated listener on every render.** `el('kpiTable')` outlives
  its rows, so `tbl.addEventListener` inside `renderKpiTable` stacked one listener
  per render. Two listeners made one click run `toggleRow` twice — open, close,
  nothing. The drill-down worked on the first KPI group a reader opened and died
  silently on the next. Delegation is what survives a re-render; the **binding**
  must happen once (`dataset.rowsBound`). Same shape was latent on `toneHeat`.
- **A "% yoy" KPI pointed at an absolute-volume Insights row.** Castrol's
  `lubricant-volume` declared `Lubricant Volume` while its unit said `% yoy`.
  `fillFromInsights` takes the first declared row that is PRESENT, so the wrong
  row won and contributed nothing, and the fallback was never reached. Check the
  unit against the row before declaring it.

---

## Environment

Secrets already set in GitHub Actions:
`SCREENER_PAID_EMAIL`, `SCREENER_PAID_PASSWORD`, `SCREENER_EMAIL`,
`SCREENER_PASSWORD`, `OPENAI_API_KEY`, `MISTRAL_API_KEY`, `FIRECRAWL_API_KEY`,
`SCRAPEDO_API_KEY`.

Optional repo **variables**: `OPENAI_MODEL`, `MISTRAL_MODEL` — change the
extraction model with no code change. Defaults are `gpt-4o` and
`mistral-large-latest`.

Tests: `cd pipeline && npm test` — **183 passing**. Parsers are pure and tested
against fixtures taken from real responses; network and browser code is kept
separate and is not unit-tested.
