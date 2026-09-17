# Superstore Sales Dashboard

**Live demo → [khegayanton11.github.io/superstore-sales-dashboard](https://khegayanton11.github.io/superstore-sales-dashboard/)**

An interactive analytics dashboard for US retail sales data (2014–2017). Built as a data analyst portfolio project: the goal was not to make a pretty chart, but to follow a question through — from raw CSV to a reproducible finding — without lying in any number along the way.

The central question: **revenue grew by 20% in 2017. Did the business actually get more profitable?**

Short answer: no. Margin fell from 13.4% to 12.7%. The full breakdown is on the page.

---

## What's inside

### The finding that drives the page

Discounts above 20% are systematically unprofitable:

| Discount tier | Margin |
|---|---|
| No discount | 29.9% |
| Up to 20% | 13.3% |
| Above 20% | **−44.3%** |

Deals with discounts above 20% generated $107K in revenue and a $47.6K **loss**. Without them, 2017 profit would have been 51% higher. This is not a rounding issue — it's a pricing policy problem hiding inside a growth story.

### Other signals surfaced by the data

- **South region:** revenue +31.3%, margin collapsed from 18.9% → 7.2%
- **Central region:** flat revenue (−0.2%), margin fell 13.5% → 5.1%
- **4 unprofitable sub-categories** out of 17: Tables (−13.4%), Machines (−8.1%), Bookcases (−1.2%), Supplies (−7.8%)
- **80 customers stopped buying** in 2017 vs 2016; they had contributed $22K in margin

---

## Data

**Source:** [Sample - Superstore](https://community.tableau.com/s/question/0D54T00000CWeX8SAL/sample-superstore-sales-excelxls) — a public teaching dataset from Tableau.  
US retail orders, 4 regions, 3 customer segments, 1,862 products, 793 customers.

| | |
|---|---|
| Raw rows | 9,994 |
| Date range | 2014-01-03 — 2017-12-30 |
| After cleaning | 9,993 (1 duplicate removed) |
| Fact table grain | month × region × segment × discount bucket × product × customer |
| Fact rows in browser | 9,985 |
| Total revenue | $2,296,919 |
| Total profit | $286,409 |
| Drift (rounding) | 0.09 ppm |

The comparison period is **2017 vs 2016** (full calendar years). All figures on the page are computed by rolling up this single fact table in the browser — there are no pre-aggregated numbers, so different blocks cannot show conflicting totals.

---

## Project structure

```
build_data.py            Python pipeline: raw CSV → data contract (JSON)
test_rollup.mjs          Verifies browser rollup matches Python totals
test_render.mjs          Smoke-tests the full render path on a DOM stub

public/
  index.html             Page structure
  app.css                All palette & typography as CSS variables
  app.js                 Rollup engine + SVG charts (no libraries)
  data/
    meta.json            Periods, cleaning log, reconciliation checks
    facts.json           Fact table — 9,985 rows, columnar array
    products.json        Product catalogue with demand classification
    subcategories.json   ADI × CV² demand patterns (sub-category level)
    customers.json       Customer directory

.github/
  workflows/
    deploy-pages.yml     Auto-deploy public/ to GitHub Pages on push
```

---

## How the data pipeline works

```bash
python build_data.py --src "data/Sample - Superstore.csv" --out public/data
```

The script:
1. **Auto-detects date format** from the data itself (MM/DD vs DD/MM) — not from a flag
2. **Logs every dropped row** with a reason (bad date, non-positive sales, duplicate)
3. **Reconciles totals**: revenue, profit, quantity, product count, customer count must match the raw file to within rounding. If they don't, the script exits with an error — it does not silently export wrong numbers
4. **Classifies discount into three buckets** (`none / upto20 / over20`) as a fact dimension, so margin-by-discount requires no extra query
5. **Classifies demand** using ADI × CV² (Syntetos–Boylan) at sub-category level. At SKU level the history is too sparse (median ADI = 9.6 months), so the classification is shown at sub-category instead

---

## How the browser side works

All aggregation happens client-side via a single `scan()` function that iterates the fact table. Filters (region, period, metric) are applied as masks. There are no pre-computed aggregates anywhere — every number on the page is a live rollup. This means:

- Cross-filtering is instant (the fact table is ~500 KB, fits in L2 cache)
- The same metric shown in two different blocks will always be identical
- Adding a new dimension only requires including it in the fact table row

No charting libraries. Every SVG element — bars, lines, dots, the quadrant scatter — is constructed with `createElementNS`. The entire dependency list is three Google Fonts.

---

## Running locally

```bash
cd public && python3 -m http.server 8000
```

Open `http://localhost:8000`. The page uses `fetch()` to load JSON, so it must be served — opening `index.html` directly with `file://` will not work.

### Running the tests

```bash
node test_rollup.mjs   # reconciles browser rollup against Python totals
node test_render.mjs   # smoke-tests render() across all filter combinations
```

Both must stay green after any change.

---

## Deploying

Push to `main` → GitHub Actions runs `.github/workflows/deploy-pages.yml` → `public/` is published to GitHub Pages in ~20 seconds.

---

## Built with

| | |
|---|---|
| **Language** | Python 3 (pipeline), Vanilla JS ES2022 (frontend) |
| **Charts** | Hand-written SVG — no D3, no Chart.js |
| **Fonts** | Google Fonts (Oranienbaum, Golos Text, IBM Plex Mono) |
| **Data** | Sample Superstore — public domain teaching dataset |
| **Hosting** | GitHub Pages (static, no backend) |
| **CI/CD** | GitHub Actions |
| **Tests** | Node.js (no test framework — plain assertions) |

---

## Data disclaimer

Sample Superstore is a fictional retail dataset created by Tableau for teaching purposes. The companies, customers and products in it are not real. The analytical findings are real in the sense that they correctly describe what is in the data — but they do not describe any actual business.
