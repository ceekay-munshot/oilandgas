# Oil & Gas Cycle Dashboard

An instrument that shows where India's oil & gas capex cycle is right now, and
which companies benefit.

**Steps 1–2 of ~12 are in.** The shell, the navigation and the design system are
done; the **Cockpit** and **Macro** tabs are built. Every number on both is a
clearly-labelled placeholder shaped exactly like the real thing. There is no
scoring logic and no real KPI or commentary data yet.

---

## Run it

```bash
python3 -m http.server 8000
```

Then open **http://localhost:8000**.

You need the tiny server because the page fetches its data from `/data/*.json` at
runtime, and browsers block local file reads when you open `index.html` straight
off the disk (`file://`). If you do open it directly, the page tells you this and
shows the command above — nothing is silently broken.

Any static host works the same way. On Cloudflare Pages, point it at this folder
with no build command and no output directory; it is plain static files.

---

## What's in the box

```
index.html              everything: design system, shell, navigation, charts
data/companies.json     the company backbone, grouped
data/framework.json     the fixed vocabulary (flags, tone, stages, source tags)
data/macro.json         six market series, 12 monthly points each
README.md
```

One external dependency: **Apache ECharts 5.5.1** from jsDelivr, used for every
chart. No frameworks, no build step, no bundler.

---

## Navigation

Five tabs, and three subtabs under KPIs:

| # | Tab | What it answers |
|---|-----|-----------------|
| 1 | **Cockpit** | Where are we in the cycle — the five-second answer |
| 2 | **Macro** | The market backdrop: six price and freight series |
| 3 | **KPIs** | Company numbers over the last four quarters — *Leading / Coincident / Lagging* |
| 4 | **Commentary** | How upbeat or worried management sounded |
| 5 | **Insight & Action** | The summary, and what to research now |

- The page itself never scrolls. Each tab is sized to fit the screen; only an
  inner panel (a long table, the heat strip) scrolls, and only when it must.
- Tabs are deep-linkable: `#cockpit`, `#macro`, `#kpis/coincident`,
  `#commentary`, `#insight`.
- Keyboard: `1`–`5` jump to a tab; `←` `→` `Home` `End` move along the tab bar.

---

## What is real, and what is a placeholder

**Real** — loaded from the JSON files at runtime, not hardcoded:

- Every company name, its group, and what it does
- Every cycle stage, tone step, trajectory flag and source tag, with its colour
  and its plain-English label
- The standing six, and which companies each slot points at

**Placeholder (`SEED`)** — the Cockpit's numbers. They live in one `SEED` object
near the top of the `<script>` in `index.html`, and they are marked `SEED` in the
header and on every card that uses them:

```js
var SEED = {
  cyclePosition: 52,                    // 0-100 along the five stages
  scores: { leading:    { score: 72, prev: 66 },
            coincident: { score: 58, prev: 56 },
            lagging:    { score: 41, prev: 44 } },
  divergence: [18, 22, 27, 31],         // leading minus lagging, oldest first
  alerts: [ … ]
};
```

The stage name shown on the dial is **derived** from `cyclePosition` against the
ranges in `framework.json` — set the number and the words, the colour and the
"you are here" marker all follow. Replacing this object with a fetch of a real
scores file is the natural next step.

**Placeholder (`data/macro.json`)** — the Macro tab's six series. The *shape* is
final; only the values are stand-ins, and the file says so (`"placeholder": true`).
Everything the tab displays is computed from those points, not stored:

- the **current value** is the last point
- the **3-month flag** compares the latest point with the one `flagLookbackMonths`
  earlier, with a `flatBandPct` dead-band so small wobbles don't read as a trend
- the **12-month percentile** is the rank of the latest point inside its own series

Two edge cases the flag handles, because a refining margin genuinely crosses zero:
a **negative baseline** keeps its sign (the denominator is `Math.abs`, so −4.0 → −1.0
reads as Rising), and a **zero baseline** has no percentage at all, so it falls back
to the raw move rather than being called Flat.

So swapping in the live feed changes no code — the flags and percentiles
recompute themselves.

The remaining three tabs are on-brand empty layouts: the right cards, the right
titles, the right shapes — with a visible *"No data yet"* on each tile. Nothing
shows an invented number.

---

## Design system

Defined once as CSS custom properties at the top of `index.html`.

**Colour.** Light, and deliberately colourful. Every data colour was checked for
colour-blind separation and contrast against the white chart surface rather than
picked by eye:

| Role | Colours |
|------|---------|
| Groups — Leading / Coincident / Lagging | `#7C3AED` `#0D9488` `#E07C05` |
| Cycle stages (Trough → Early Downcycle) | `#6155DE` `#0E9FC0` `#0F7A3A` `#E9A526` `#D02F3C` |
| Tone (Confident → Defensive) | `#0F7A3A` `#59B061` `#AEB4C0` `#E9A526` `#C42433` |
| Trajectory flags | `#0F7A3A` `#2563EB` `#E07C05` `#0E9FC0` `#C42433` |
| Macro tiles | `#E8590C` `#9A3412` `#0F7A3A` `#7C3AED`+`#0891B2` `#DB2777` `#B91C1C` |
| Direction flags — Rising / Flat / Falling | `#2563EB` `#7C8496` `#E07C05` |
| Source tags | eight chips, listed in `framework.json` |

Three colours are intentionally low-chroma and would fail a naive palette check:
the **grey tone midpoint** (a diverging scale needs a neutral middle), the **grey
"Unknown" source chip**, and **grey "Flat"** (grey *is* the meaning in all three).
Each always carries a written label.

Two deliberate choices on the Macro tab:

- **The two crude tiles share one hue** (`#E8590C` / `#9A3412`). Brent and the
  Indian basket are the same measure priced differently, so a common hue family
  says so. It also gets the tab down to five distinct hues, which is what actually
  validates — no six-colour set clears the all-pairs gate.
- **Direction flags are blue/grey/orange, not green/red.** Green and amber already
  mean *agree* and *conflict* in the strip beneath the tiles; reusing them for
  up/down would put two meanings of green on one screen. Rising isn't good or bad
  on its own — dearer crude helps producers and hurts refiners — so a
  judgement-free pair is the honest encoding.

The only place colour carries identity *within* one chart is the gas tile's two
lines (`#7C3AED` vs `#0891B2`), which clears every gate with room to spare
(CVD ΔE 15.0, normal-vision 24.5). It also ships a legend, as the two current
values above the sparkline.

**Rules the charts follow.** One colour per entity, never reassigned by rank.
Bars capped at 22px with a 4px rounded end and a square base. Solid hairline
gridlines, never dashed. A 2px white gap between touching fills, and a 2px white
ring on the dial's marker. Only the latest bar is directly labelled — no number
on every point. Text never wears a data colour; a coloured dot beside it carries
the identity instead. Chart colours are never used for interface chrome, and the
tab accent colours are never used for data.

**Words.** Plain English first, the technical term second and quieter —
"Moves first" then *Leading*, "Picking up speed" then *Mid Upcycle*. Both strings
live in the JSON, so the vocabulary changes in one place.

---

## Data files

`data/companies.json` — three groups, each with a colour, a plain-English label
and a description, and its companies (`id`, `name`, `what`). `quarterLabels` at
the top level drives every four-quarter axis in the app, and is the fixed quarter
convention: `["Q2 FY26","Q3 FY26","Q4 FY26","Q1 FY27"]`, oldest first.

`data/macro.json` — `tiles[]`, each with `id`, `label`, `shortLabel`, `plainSub`,
`unit`, `decimals`, `source`, `sourceTag` (an id from `framework.json`), `asOf`,
and `supports` / `supportsWhy`. Points live one level down, in `lines[]`:

```jsonc
{ "id": "brent", "label": "Crude Oil - Brent", "unit": "$/bbl",
  "sourceTag": "external", "asOf": "2026-07-01", "supports": "up",
  "lines": [
    { "id": "brent", "color": "#E8590C", "primary": true,
      "series": [ {"date": "2025-08-01", "value": 68.9}, … ] }   // 12 monthly points
  ] }
```

Every tile carries an array of lines even when it has only one, so the gas tile's
two lines need no special case. `primary: true` names the line that drives the
flag and the percentile. `supports` (`"up"` / `"down"`) says which direction backs
a stronger capex cycle — that is a judgement call, so it lives in the data where
it can be argued with, not buried in code.

`data/framework.json` — `trajectoryFlags`, `toneScale` (diverging, with a named
neutral), `cycleStages` (each with a 0–100 `range`), `sourceTags`, `standingSix`
(slots pointing at company ids), and `groupMeta`. Every entry has an `id`, a
`label`, a `plainLabel`, a `color` and a `meaning`.

Both files carry a `schemaVersion` so later steps can extend them safely.

### One note on the company list

The brief called this a 26-company backbone, but the list it gave contains **27**
names — Leading 8, Coincident 16, Lagging 3. All 27 are in `companies.json` as
given; nothing was dropped to reach 26. Counts shown in the interface are computed
from the file, so correcting the list in either direction needs no code change.

---

## Not in this step

No real market feed, no KPI or commentary data, no scoring maths, no deployment
config.

The **"Scores agree / Conflict"** strip under the Macro tiles is deliberately
crude for now: it counts how many tiles are moving in their `supports` direction
and compares that with whether `SEED.scores` are improving. It is wired to the
placeholder scores and marked as such on screen. It becomes meaningful once real
scoring lands.
