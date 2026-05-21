import * as cheerio from "cheerio";
import { IngestParseError } from "./errors";
import type { ScorpionPage, SiteRedirect } from "./types";

export interface ParsedTables {
  pages: ScorpionPage[];
  contentZoneIds: Set<string>;
  iconMap: Map<string, string>;
  redirects: SiteRedirect[];
}

export function parseWpConverter(
  html: string,
  siteUrl: string,
): ParsedTables {
  const $ = cheerio.load(html);
  const pages = parseSiteMapTable($, siteUrl);
  const contentZoneIds = parseContentIdsTable($, siteUrl);
  const iconMap = parseSiteIconTable($);
  const redirects = parseSiteRedirectTable($);
  return { pages, contentZoneIds, iconMap, redirects };
}

function parseSiteMapTable(
  $: cheerio.CheerioAPI,
  siteUrl: string,
): ScorpionPage[] {
  const table = $("#SiteMapListTable");
  if (table.length === 0) {
    throw new IngestParseError(
      siteUrl,
      "#SiteMapListTable not found in /wp-converter/ response",
    );
  }

  // Header → column index, so a new column (like "Template Name") works
  // no matter where Scorpion places it. Falls back to the historical
  // positions (path=0, title=1, meta title=2, meta description=3,
  // template=4) when the header row is missing or unrecognized.
  const headerCells = table.find("tr").first().find("th, td");
  const headerIndex = new Map<string, number>();
  headerCells.each((i, el) => {
    headerIndex.set($(el).text().trim().toLowerCase(), i);
  });
  const idxOr = (labels: string[], fallback: number): number => {
    for (const label of labels) {
      const i = headerIndex.get(label);
      if (i !== undefined) return i;
    }
    return fallback;
  };
  const pathIdx = idxOr(["path", "url"], 0);
  const titleIdx = idxOr(["title", "page title"], 1);
  const metaTitleIdx = idxOr(["meta title", "seo title"], 2);
  const metaDescIdx = idxOr(["meta description", "description"], 3);
  const templateIdx = idxOr(["template", "template id"], 4);
  const templateNameIdx = headerIndex.get("template name");

  const pages: ScorpionPage[] = [];
  table.find("tr").each((index, tr) => {
    if (index === 0) return;
    const cells = $(tr).find("td");
    if (cells.length < 4) return;

    const cellText = (i: number): string =>
      cells.length > i ? cells.eq(i).text().trim() : "";

    const path = cellText(pathIdx);
    if (!path) return;
    if (isWpConverterPath(path)) return;

    pages.push({
      path,
      title: cellText(titleIdx),
      metaTitle: cellText(metaTitleIdx),
      metaDescription: cellText(metaDescIdx),
      canonical: new URL(path, siteUrl).toString(),
      template: cellText(templateIdx),
      templateName:
        templateNameIdx !== undefined ? cellText(templateNameIdx) : "",
    });
  });

  return pages;
}

// Per EXTRACTION.md Step 1: the /wp-converter/ endpoint must not be
// crawled as a site page even though it appears in #SiteMapListTable.
function isWpConverterPath(path: string): boolean {
  return path.replace(/\/$/, "").toLowerCase() === "/wp-converter";
}

function parseContentIdsTable(
  $: cheerio.CheerioAPI,
  siteUrl: string,
): Set<string> {
  const table = $("#SiteContentIdsTable");
  if (table.length === 0) {
    throw new IngestParseError(
      siteUrl,
      "#SiteContentIdsTable not found in /wp-converter/ response",
    );
  }

  const ids = new Set<string>();
  table.find("tr").each((index, tr) => {
    if (index === 0) return;
    const cells = $(tr).find("td");
    if (cells.length < 1) return;

    const id = cells.eq(0).text().trim();
    if (id) ids.add(id);
  });

  return ids;
}

// #SiteIconTable holds inline SVG icons keyed by name. Cells are
// (IconID, IconName, Size, Path), and Path contains the literal
// `<svg><path d="…"/></svg>` markup. We store the inner contents of
// each cell's <svg> — the templates' parent <svg viewBox="…"> element
// will keep its own attributes; substitution only replaces the inner
// `<use data-href="…#name">` element with the looked-up paths.
//
// The table is optional: older /wp-converter/ versions don't include it.
// In that case the build pipeline runs without icon substitution and
// the `<use data-href>` references survive into the output (where they
// don't render unless Scorpion's lazy-load JS is also loaded).
function parseSiteIconTable($: cheerio.CheerioAPI): Map<string, string> {
  const table = $("#SiteIconTable");
  if (table.length === 0) return new Map();

  const map = new Map<string, string>();
  table.find("tr").each((index, tr) => {
    if (index === 0) return;
    const cells = $(tr).find("td");
    if (cells.length < 4) return;

    const iconName = cells.eq(1).text().trim();
    if (!iconName) return;
    const $svg = cells.eq(3).find("svg").first();
    if ($svg.length === 0) return;
    const inner = $svg.html();
    if (inner && inner.trim().length > 0) {
      map.set(iconName, inner);
    }
  });
  return map;
}

// #SiteRedirectTable holds the site's 301 rules — (Original Path,
// Redirect Path). Written to `redirects.csv` in the build output and
// ingested by the Redirection plugin via `wp redirection import` in the
// wp:import step. The table is optional: when it's absent the build
// pipeline emits no CSV and wp:import skips the plugin install.
function parseSiteRedirectTable($: cheerio.CheerioAPI): SiteRedirect[] {
  const table = $("#SiteRedirectTable");
  if (table.length === 0) return [];

  // Header → column index. Falls back to positional (0 = from, 1 = to)
  // so future column reordering doesn't break the parser.
  const headerCells = table.find("tr").first().find("th, td");
  const headerIndex = new Map<string, number>();
  headerCells.each((i, el) => {
    headerIndex.set($(el).text().trim().toLowerCase(), i);
  });
  const idxOr = (labels: string[], fallback: number): number => {
    for (const label of labels) {
      const i = headerIndex.get(label);
      if (i !== undefined) return i;
    }
    return fallback;
  };
  const fromIdx = idxOr(["original path", "from", "source"], 0);
  const toIdx = idxOr(["redirect path", "to", "destination"], 1);

  const seenFrom = new Set<string>();
  const out: SiteRedirect[] = [];
  table.find("tr").each((index, tr) => {
    if (index === 0) return;
    const cells = $(tr).find("td");
    if (cells.length < 2) return;

    const rawFrom = cells.eq(fromIdx).text().trim();
    const rawTo = cells.eq(toIdx).text().trim();
    if (!rawFrom || !rawTo) return;

    const from = normalizeRedirectSource(rawFrom);
    const to = rawTo;
    if (!from) return;
    if (from === to) return; // no-op
    // First-write-wins on duplicate sources — keeps the lookup deterministic
    // if /wp-converter/ ever emits the same path twice.
    if (seenFrom.has(from)) return;
    seenFrom.add(from);
    out.push({ from, to });
  });
  return out;
}

// Strip query strings and ensure leading + trailing slash. Case is
// preserved — the Redirection plugin handles URL matching downstream and
// has its own per-rule case-sensitivity setting, so pre-lowercasing here
// would just throw away information.
function normalizeRedirectSource(raw: string): string {
  let s = raw.trim();
  const q = s.indexOf("?");
  if (q >= 0) s = s.substring(0, q);
  if (!s) return "";
  if (!s.startsWith("/")) s = "/" + s;
  if (!s.endsWith("/")) s += "/";
  return s;
}
