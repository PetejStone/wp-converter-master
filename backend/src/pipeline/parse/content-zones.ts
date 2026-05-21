import * as cheerio from "cheerio";
import type { CrawlResult } from "../crawl";
import type { ExtractedZone, PageContentZones } from "./types";

const PLACEHOLDER_PREFIX = "WP_CLASSIC_BLOCK_";

export function extractContentZones(
  fullHtml: string,
  contentZoneIds: Set<string>,
  pageUrl: string,
  path: string,
): PageContentZones {
  const $ = cheerio.load(fullHtml);
  const zones: ExtractedZone[] = [];
  let index = 0;

  $("[id]").each((_, el) => {
    const $el = $(el);
    const id = $el.attr("id");
    if (!id || !contentZoneIds.has(id)) return;

    const innerHtml = $el.html() ?? "";
    zones.push({ zoneId: id, index, innerHtml });
    // Keep the original container (tag, id, classes like `.cnt-stl`, and
    // other attributes) so its Scorpion styling survives into the template.
    // Only the inner HTML is swapped for the placeholder; the shortcode
    // later rendered in its place will echo the zone's HTML inside this
    // container.
    $el.empty().append(`<!-- ${PLACEHOLDER_PREFIX}${index} -->`);
    index++;
  });

  // Scorpion's blog post body lives in `<article class="cnt-stl">` —
  // not listed in SiteContentIdsTable so the zone walk above doesn't
  // touch it. Capture the first one's inner HTML separately so the WXR
  // builder can emit it as post_content for blog posts (and so single.php
  // can render the_content() in place of the article).
  const $body = $("article.cnt-stl").first();
  const bodyHtml = $body.length > 0 ? ($body.html() ?? "") : "";

  return {
    pageUrl,
    path,
    zones,
    template: $.html(),
    bodyHtml,
  };
}

export function extractAllContentZones(
  crawl: CrawlResult,
  contentZoneIds: Set<string>,
): PageContentZones[] {
  const out: PageContentZones[] = [];
  for (const page of crawl.pages) {
    if (page.status !== "ok" || !page.fullHtml) continue;
    out.push(
      extractContentZones(
        page.fullHtml,
        contentZoneIds,
        page.pageUrl,
        page.path,
      ),
    );
  }
  return out;
}

