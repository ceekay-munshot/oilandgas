# Oil & Gas Cycle Dashboard — working context

Read this first if you are picking the project up in a new session. It is the
state of play, the rules that are not negotiable, and what to do next.

Last updated at commit `13b4f7a` (PR #32 merged).

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
| KPI coverage | **97 / 224 cells**, 23 of 58 KPIs have a trajectory flag |
| Companies | 27, all with financials, docs and an Insights table |
| Insights table | 26 of 27 on the **quarterly** view, **1,150 values** parsed |
| Deterministic mapping | 27 of 58 KPIs mapped → **71 cells** fill with no model call |
| Store | `data/kpi-store.json`, 27 companies, accumulates forever |

> The 97 figure predates the deterministic fill — it is from the last full run.
> **The next `scope: all` run is the first to include the mapping**, so expect it
> to move well past 97.

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
scrape-screener.mjs          extract-kpis.mjs
  login (paid account)         1. seed store from kpis.json (once)
  resolve slug                 2. fillFromInsights()  <- deterministic, cited
  financials + Pros/Cons       3. planCompany()       <- what is still missing
  Insights grid (quarterly)    4. one LLM call for the gaps only
  AI summaries x6              5. mergeIntoStore()    <- rank rules
  PPT + transcripts x6         6. renderWindow()      -> data/kpis.json
     -> pipeline/cache/           (unit guard applies here)
```

### The store (`pipeline/lib/kpi-store.mjs`)

The single most important piece. Rules, in force:

- A `null` **never** displaces a number. Coverage can only go up.
- A KPI with no open cells is **not sent to the model**; a company with none
  makes **no call at all**. A steady-state run costs nothing.
- A known-empty cell is only re-asked when a **fingerprint** changes — the
  documents in the window, the KPI spec, or `PROMPT_VERSION` in
  `parsers/kpi-prompt.mjs`. Bump that version when a prompt change should change
  existing answers.
- **Rank**: `insights: 3` beats `model: 1` / `seeded: 1`. A cited Insights value
  corrects a model-inferred one in place. Within a rank the first answer stands.
- What a correction replaced is kept on the cell (`replaced`), so it is auditable.
- **One unit per row.** The strongest-evidenced unit wins; a cell in another unit
  is withheld with the reason. Never rescaled.
- `--refresh` re-asks everything. Only after a fix that should change answers.

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

## Workflows

| Workflow | Trigger | Scope |
|---|---|---|
| `refresh-company.yml` | manual + **Mon 05:30 UTC** | `smoke` (4 cos) / `all` (27) / `dump` (recon) |
| `refresh-full.yml` | manual + Mon 06:40 UTC | macro → screener → kpis |
| `refresh-macro.yml` | manual + daily | 6 macro tiles |
| `probe-macro.yml` | manual | source recon |

The weekly schedule runs **`all`**, so the dashboard refreshes itself.

`--scope dump` is the recon mode: it runs the *real* functions against a live
page and prints what each returned, plus raw markup and `innerText` vs
`textContent`. **Use it before writing any selector.** Three rounds were lost on
the Insights table by not doing this.

---

## What to do next

### 1. Run `scope: all` and read the result

First run that includes the deterministic mapping. Check:
- how far past 97/224 coverage moves
- how many stored values the citations **corrected** (Petronet's `27` should be)
- that **L&T** comes back as Larsen & Toubro, not L&T Finance (slug was `LTF`,
  now `LT` — its KPIs had been retail loan book and MFI collection efficiency)

### 2. The remaining gaps, and what each is worth

| Kind | Examples | Prospect |
|---|---|---|
| **Not disclosed anywhere** | Deep's day-rate, EIL's bid pipeline | Won't fill. Commercially sensitive — discussed qualitatively, never quantified. Show as an honest gap. |
| **Market spreads, not company data** | base-oil spread, styrene–polystyrene | Belong in the **macro** pipeline, not company extraction. Different source entirely. |
| **Computable but not stated** | EBITDA/scm, O2C EBITDA/tonne, CNG+PNG volume *growth* | Derivable from figures already held — volume ÷ EBITDA, or yoy from the quarterly volume row. **Biggest remaining win.** Tag `derived`, put the formula in the note. |
| **Annual cadence** | reserves, RRR, wells drilled | Real data, but yearly. Currently skipped because the window is quarterly — surface with the cadence labelled rather than as four blanks. |

The third row is honest arithmetic, not inference. Do it next.

### 3. Known smaller issues

- **Broken windows.** Some companies have short or gappy windows — Thermax has
  one quarter, ONGC has `Q3 FY25, Q4 FY25, Q2 FY26`. The window is the 4 most
  recent quarters that yielded documents, so a company with thin coverage gets a
  thin window. Worth deciding whether to pad or to state the gap.
- **Six companies returned 0 cells**: Reliance, L&T, Gujarat Gas, Castrol, Linde,
  Adani Ports. L&T was the wrong slug; the others need checking individually.
- **Gujarat Gas** is the one company still on the yearly Insights view (no
  Quarterly endpoint on its card).
- **`castrol-india`** returned 0 financial tables — likely standalone-only.
- **Cockpit scores are still `SEED`** — prompts 8+ cover commentary tone and
  rescoring.

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

---

## Environment

Secrets already set in GitHub Actions:
`SCREENER_PAID_EMAIL`, `SCREENER_PAID_PASSWORD`, `SCREENER_EMAIL`,
`SCREENER_PASSWORD`, `OPENAI_API_KEY`, `MISTRAL_API_KEY`, `FIRECRAWL_API_KEY`,
`SCRAPEDO_API_KEY`.

Optional repo **variables**: `OPENAI_MODEL`, `MISTRAL_MODEL` — change the
extraction model with no code change. Defaults are `gpt-4o` and
`mistral-large-latest`.

Tests: `cd pipeline && npm test` — **167 passing**. Parsers are pure and tested
against fixtures taken from real responses; network and browser code is kept
separate and is not unit-tested.
