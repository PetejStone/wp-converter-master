# EXTRACTION.md — Crawler and DOM Extraction Rules

This is the most critical document for the backend pipeline. Read this before touching anything related to crawling or DOM parsing.

---

## Step 0 — `/wp-converter/` Ingestion (Before Any Crawling)

This is always the first thing the tool does. No crawling begins until this succeeds.

```
GET {site_url}/wp-converter/
```

Parse the response HTML with Cheerio:

### `#SiteMapListTable` → Page list
```
- Skip the first row (header)
- For each subsequent row:
    col[0] → page.path      (e.g. "/about")
    col[1] → page.title     (e.g. "About Us")
    col[2] → page.metaTitle
    col[3] → page.metaDescription
    constructed → page.canonical = site_url + page.path
```

### `#SiteContentIdsTable` → Content zone ID set
```
- Skip the first row (header)
- For each subsequent row:
    col[0] → content zone ID string (e.g. "main-content")
- Store as a Set for O(1) lookup during DOM parsing
```

### Failure behaviour
If `/wp-converter/` is unreachable, returns a non-200 status, or either table is missing:
- Fail the job immediately
- Surface a clear error to the user — do not proceed with crawling
- Log the failure with the site URL and HTTP status

---

## Step 1 — Crawling (Puppeteer)

Crawl every page URL from `#SiteMapListTable`. Every page gets the same treatment — no template grouping, no two-pass strategy.

### Crawl behaviour
- Use Puppeteer in **headless mode**
- Wait for `networkidle2` before capturing — ensures JS-rendered content and async stylesheet loads are complete
- Capture **fully rendered HTML** via `page.content()` after JS execution — not the raw HTTP response
- Set a timeout of **30 seconds** per page
- Do not follow links — the page list from `/wp-converter/` is the complete and authoritative source of URLs to crawl
- Do not crawl `/wp-converter/` itself as a site page

### What to capture per page
- Full rendered HTML (post-JS execution)
- All `<link rel="stylesheet" href="...">` values **anywhere in the document** — real Scorpion sites render the main CSS bundle into `<body>`, not `<head>`
- All `<style>` tag text content — Scorpion sites inject 30–50 KB of per-site theme tokens (CSS custom properties for colours, spacing, typography) inline; a link-only capture path misses this and breaks visual accuracy
- All `<script src="...">` values anywhere in the document
- All image `src` and `srcset` values
- The primary navigation menu — see Step 5 for how it's selected (the `[role="menubar"]` subtree, not the whole `<nav>`)

> Hostname filtering happens in the parse stage, not the crawl stage. The crawler captures every matching URL; the parser decides what's same-origin and what's third-party.

### Per-page error handling
| Scenario | Behaviour |
|---|---|
| Page load timeout (>30s) | Skip page, log warning, flag in review wizard |
| Page returns non-200 | Skip page, log warning, flag in review wizard |
| No content zones found on page | Log info — not an error, page may be fully static |
| `<nav>` element not found | Log warning — navigation will be incomplete for this page |

Do not fail the entire job for individual page failures. Continue crawling remaining pages.

---

## Step 2 — Stylesheet Discovery

After crawling all pages, build a **deduplicated list** of all unique stylesheet URLs and inline `<style>` blocks discovered across all pages.

**Rules:**
- Match `<link rel="stylesheet" href="...">` anywhere in the document — Scorpion's main CSS bundle (`/cms/includes/{hex}.{timestamp}.css`) typically renders into `<body>`, not `<head>`
- Capture every `<style>` tag's text content — Scorpion injects 30–50 KB of per-site theme tokens (CSS custom properties) inline, which a link-only path would miss
- Deduplicate URLs by full URL; deduplicate inline blocks by exact text content
- Exclude third-party stylesheet URLs (anything not on the Scorpion site's domain)
- Exception: do NOT attempt to separately download Google Fonts — they are already embedded via `@import` inside Scorpion's compiled stylesheets and travel with them automatically
- Download each stylesheet as-is — **do not modify, minify, or refactor CSS content**
- Preserve original filenames where possible

---

## Step 3 — JavaScript Discovery

Same approach as stylesheets.

**Rules:**
- Include `<script src="...">` tags anywhere in the document — not inline `<script>` blocks
- Deduplicate by full URL
- Include only JS files hosted on the Scorpion site's domain — exclude third-party JS (analytics, chat widgets, tag managers, etc.)
- Download as-is — do not modify
- Enqueue in WordPress footer (`$in_footer = true`) to match Scorpion's loading behaviour

> Scorpion-controlled sibling domains (e.g. `sc-connect.scorpion.co`, `api.scorpion.co`) are dropped by the strict same-host filter today. The review wizard will eventually surface the excluded list so a user can opt these back in per script.

> **Flag for implementation review:** Inline `<script>` blocks may contain Scorpion utility initialisation code (e.g. passing config options to a slider). Assess during implementation whether these need to be captured and carried over, and how.

---

## Step 4 — Content Zone Extraction (Cheerio)

This is the core content extraction step. Run against every crawled page.

```
Load rendered page HTML into Cheerio

For each element in the DOM that has an id attribute:
  If element.id exists in the content zone ID Set:
    1. Extract element.innerHTML (inner HTML only — not the wrapper element)
    2. Store: { pageUrl, zoneId: element.id, index, innerHtml }
    3. Replace element in the template with:
       <!-- WP_CLASSIC_BLOCK_{index} -->

All remaining HTML (outside replaced zones) = static page template
```

**Rules:**
- Content zone IDs from `#SiteContentIdsTable` are the **sole signal** for editable content
- No class-based detection — `.cnt-stl` or any other class is NOT used
- Extract **inner HTML only** — do not include the wrapper element's opening/closing tags
- Preserve inner HTML **exactly as-is** — no tag stripping, attribute modification, or whitespace changes
- If the same content zone ID appears more than once on a page (unexpected but possible) — extract all instances, index them separately
- Content zones are not nested — treat every match as independent

---

## Step 5 — Navigation Extraction (Cheerio)

Run against every crawled page. Navigation can vary per page — this must be detected.

```
For each crawled page:
  1. Find the primary menu
     - PREFER the [role="menubar"] subtree (Scorpion marks the desktop
       menu's root <ul> with role="menubar"; its nested role="menu" <ul>s
       hold the flyout sub-items). Capture that element's outerHTML.
       If several menubars exist, use the one with the most <a> children.
     - FALL BACK to the largest <nav>'s inner HTML only when no menubar
       exists at all (non-Scorpion / atypical markup).
  2. Extract all <a> elements within it: { href, text }
  3. Infer hierarchy from ul > li > ul nesting depth
  4. Normalise hrefs — convert absolute URLs to root-relative paths
  5. Store nav structure keyed to page URL

After all pages processed:
  1. Serialise each page's nav structure to a comparable string
  2. If all pages produce identical nav → single nav, use globally
  3. If variations exist → collect unique nav variants, flag in review wizard
     → user selects which becomes the WordPress primary menu
```

> **Why the menubar subtree, not the whole `<nav>`.** An earlier "most `<a>`
> children" heuristic pulled in far too much. After JS hydration the desktop
> nav's enclosing `<nav>` also contains the **mobile drawer** — a flattened
> duplicate of the menu interleaved with `"Main Menu"` section-header links —
> plus the header's **social / phone / maps** links. On the Tennessee Plumbing
> test site that produced **58** menu items (with duplicates, empty-href
> headers, and Facebook/Instagram/tel: links) instead of the real **23**. The
> `[role="menubar"]` subtree is exactly the hierarchical desktop menu and
> nothing else, so capturing it directly yields a clean menu with correct
> depth nesting. The selection lives in `pipeline/crawl/crawl-page.ts`.

---

## Step 6 — Media Asset Extraction (Cheerio)

Run against every crawled page.

**Sources to check:**
- `<img src="...">` and `<img srcset="...">`
- `<source src="...">` and `<source srcset="...">` (within `<picture>` or `<video>`)
- `<a href="...">` linking to downloadable files (`.pdf`, `.doc`, `.docx`, `.zip`, etc.)
- Inline `style` attributes containing `background-image: url(...)`

**Rules:**
- Deduplicate by full URL across all pages
- Exclude external media (anything not on the Scorpion site's domain)
- Download to: `/tmp/scorpion-conversions/{job_id}/media/`
- Preserve original filenames — use a flat directory structure
- If filename collision: append a numeric suffix (e.g. `hero-1.jpg`, `hero-2.jpg`)
- After download, rewrite all references in page template HTML and Classic block inner HTML:
  - From: `https://scorpion-site.com/assets/images/hero.jpg`
  - To: `/wp-content/uploads/scorpion-migration/hero.jpg`
- Also rewrite any `url()` references in extracted stylesheets that point to site-hosted assets

**Per-asset error handling:**
- If a media asset download fails: log warning, flag in review wizard — do not fail the job
- Include a list of failed media downloads in the export migration checklist

---

## Step 7 — Form Extraction (Cheerio)

Run against every crawled page.

```
For each <form> element:
  1. Skip the form entirely if it has data-search="1" — these are
     Scorpion's AJAX search/filter forms (site search, blog filter,
     gallery filter, etc.) that submit to JS handlers, not server
     endpoints. They are not user-fillable forms we migrate.
  2. Extract action and method attributes
  3. Extract all <input>, <select>, <textarea> elements:
     - name, type, placeholder, required attributes
     - associated <label> text (matched by for/id or parent wrapping)
  4. Store form structure keyed to page URL
```

After all pages processed, fingerprint each extracted form by its **structural** content (field tags, input types, labels, placeholders, required flags, select options, method) — **excluding** form id, action, and field name. Scorpion auto-generates positional identifiers like `Form_ContactS2` vs `Form_ContactS21` and field names like `ContactS2Form$ITM0$FirstName` that differ only by the form's index on the page; structural fingerprinting collapses these into a single variant while the occurrences list preserves per-page assignment. Most Scorpion sites have 80%+ form duplication across pages.

---

## Legacy Framework Detection

Run before `/wp-converter/` ingestion as a lightweight pre-check.

The goal of this check is to confirm the site is a USC-based Scorpion site at all — **not** to identify the specific USC version. The USC version is supplied by the user at job start via a constrained dropdown (USC 3.0, USC 4.0, or USC 4.2) and is not reliably distinguishable from rendered page markup.

```
1. Simple HTTP GET to the site homepage (no Puppeteer)
2. Check for USC framework markers (any version) in:
   - HTML comments
   - <meta> tags
   - CSS/JS filenames in <link> and <script> tags
   - Body class names
3. If no USC marker found:
   - Return UNSUPPORTED_FRAMEWORK error to frontend
   - Do not proceed with /wp-converter/ request or crawl
   - Log the site URL for analysis
```

Pre-USC 3.0 sites are not supported. The supported version floor is enforced by the dropdown — older variants are simply not selectable. There is no in-crawler check that rejects a pre-3.0 site after the fact; if a user converts one, the extraction output will be unreliable.

---

## Temp Directory Structure

```
/tmp/scorpion-conversions/
  {job_id}/
    stylesheets/     ← downloaded CSS bundles (as-is)
    js/              ← downloaded JS utility files (as-is)
    media/           ← downloaded images and files
    html/            ← captured rendered HTML per page URL
    output/          ← assembled WordPress package pre-zip
    export.zip       ← final deliverable
```

Entire `{job_id}/` directory is deleted immediately after export `.zip` is delivered to the user.
