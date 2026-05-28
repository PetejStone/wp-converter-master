import * as cheerio from "cheerio";
import type { CrawlResult } from "../crawl";

export interface NavItem {
  href: string;
  text: string;
  depth: number;
}

export interface NavVariant {
  fingerprint: string;
  items: NavItem[];
  pages: { pageUrl: string; path: string }[];
}

export interface NavAnalysis {
  variants: NavVariant[];
  pagesWithoutNav: { pageUrl: string; path: string }[];
  // Footer "Quick Links" pulled from `<div id="FooterS3Nav">` on the
  // first page that has it. Flat (all depth=0) since the footer doesn't
  // have submenus. Empty when no page exposes the element.
  footerQuickLinks: NavItem[];
}

export function analyzeNavigation(crawl: CrawlResult): NavAnalysis {
  const hostname = new URL(crawl.siteUrl).hostname;
  const byFingerprint = new Map<string, NavVariant>();
  const pagesWithoutNav: { pageUrl: string; path: string }[] = [];

  for (const page of crawl.pages) {
    if (page.status !== "ok") continue;
    if (!page.navHtml) {
      pagesWithoutNav.push({ pageUrl: page.pageUrl, path: page.path });
      continue;
    }

    const items = parseNavHtml(page.navHtml, hostname);
    const fingerprint = JSON.stringify(items);

    let variant = byFingerprint.get(fingerprint);
    if (!variant) {
      variant = { fingerprint, items, pages: [] };
      byFingerprint.set(fingerprint, variant);
    }
    variant.pages.push({ pageUrl: page.pageUrl, path: page.path });
  }

  const variants = [...byFingerprint.values()].sort(
    (a, b) => b.pages.length - a.pages.length,
  );

  return {
    variants,
    pagesWithoutNav,
    footerQuickLinks: extractFooterQuickLinks(crawl, hostname),
  };
}

// Scan crawled pages for `<div id="FooterS3Nav">` (Scorpion's footer
// Quick Links container) and return its `<a>` items. The footer is
// consistent across pages so we take the first non-empty match.
function extractFooterQuickLinks(
  crawl: CrawlResult,
  hostname: string,
): NavItem[] {
  for (const page of crawl.pages) {
    if (page.status !== "ok" || !page.fullHtml) continue;
    const $ = cheerio.load(page.fullHtml);
    const $nav = $("#FooterS3Nav");
    if ($nav.length === 0) continue;

    const items: NavItem[] = [];
    $nav.find("a").each((_, a) => {
      const $a = $(a);
      const href = normaliseHref($a.attr("href") ?? "", hostname);
      const text = $a.text().trim().replace(/\s+/g, " ");
      if (!href && !text) return;
      items.push({ href, text, depth: 0 });
    });
    if (items.length > 0) return items;
  }
  return [];
}

function parseNavHtml(html: string, hostname: string): NavItem[] {
  const $ = cheerio.load(`<div id="__nav_root__">${html}</div>`);
  const root = $("#__nav_root__");
  const items: NavItem[] = [];

  root.find("a").each((_, a) => {
    const $a = $(a);
    const href = normaliseHref($a.attr("href") ?? "", hostname);
    const text = $a.text().trim().replace(/\s+/g, " ");
    if (!href && !text) return;

    // Depth = count of <ul> ancestors, with top-level = 0
    const ulAncestors = $a.parentsUntil("#__nav_root__", "ul").length;
    const depth = Math.max(0, ulAncestors - 1);
    items.push({ href, text, depth });
  });

  return items;
}

function normaliseHref(href: string, hostname: string): string {
  if (!href) return "";
  try {
    const url = new URL(href, `https://${hostname}/`);
    if (url.hostname === hostname) {
      return url.pathname + url.search + url.hash;
    }
    return url.toString();
  } catch {
    return href;
  }
}
