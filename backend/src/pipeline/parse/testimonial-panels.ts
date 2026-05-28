import * as cheerio from "cheerio";
import type { Testimonial } from "../ingest";
import type { CrawlResult } from "../crawl";

// Marker the build stage substitutes for either a PHP do_shortcode call
// (when the panel lives in static page-template HTML) or a bare
// [scorpion_testimonials] shortcode tag (when the panel was captured
// inside a content zone's inner HTML and lands in postmeta). The `ids`
// list is encoded in the comment so substitution is fully self-contained
// — no out-of-band state needed.
export const TESTIMONIAL_PANEL_COMMENT_RE =
  /<!--\s*WP_TESTIMONIAL_PANEL\s+ids="([0-9,\s]+)"\s*-->/g;

export interface DetectedTestimonialPanel {
  pagePath: string;
  // ReviewIDs found on this page, grouped by panel root (each entry =
  // one panel). Order within each entry reflects DOM order on the source
  // page so the rendered shortcode preserves the panel's curation.
  reviewIds: string[];
}

// Replace every testimonial panel on each crawled page's rendered HTML
// with a placeholder comment, in place. Runs before content-zone
// extraction so the comment travels with whichever container the panel
// lived in — page-template HTML, or a content zone's inner HTML, or both
// — without the panel-detection logic needing to know.
//
// Detection key: Scorpion renders every CPT-backed element with a
// `data-key="<ScorpionID>"` attribute matching the ID column on the
// `/wp-converter/` system table (verified on tennesseeplumbinginc.com:
// `<li … data-key="5690791">` joins to #TestimonialTable's row with the
// same data-key). Substring matching the testimonial body would be more
// fragile (truncation, entity encoding, partial display) and the data
// attribute is the canonical join already in the markup.
//
// Sanity check: the matched element's text content must contain the
// first ~40 normalized chars of its testimonial Caption (or body if the
// Caption is shorter). Defends against ID collisions across systems —
// the rendered HTML on the test site also carries data-keys in the
// 10464–10469 and 268057–268065 ranges, which belong to different
// Scorpion systems (services / locations / etc.); without the text check
// a future site adding a 9-digit reviewId that happens to match a service
// id would silently produce false replacements.
export function injectTestimonialPanelPlaceholders(
  crawl: CrawlResult,
  testimonials: Testimonial[],
): DetectedTestimonialPanel[] {
  if (testimonials.length === 0) return [];

  const testimonialById = new Map<string, Testimonial>();
  for (const t of testimonials) {
    testimonialById.set(t.reviewId, t);
  }

  const detected: DetectedTestimonialPanel[] = [];

  for (const page of crawl.pages) {
    if (page.status !== "ok" || !page.fullHtml) continue;
    const result = injectForPage(page.fullHtml, testimonialById);
    if (result.panels.length === 0) continue;
    page.fullHtml = result.html;
    for (const panel of result.panels) {
      detected.push({ pagePath: page.path, reviewIds: panel.reviewIds });
    }
  }

  return detected;
}

function injectForPage(
  html: string,
  testimonialById: Map<string, Testimonial>,
): { html: string; panels: { reviewIds: string[] }[] } {
  // Fast-path: skip the cheerio parse when the page can't possibly
  // contain a matching panel. Every testimonial card has data-key= and
  // the table is keyed by reviewId, so a single absence check rules out
  // the whole page cheaply.
  if (!html.includes("data-key=")) return { html, panels: [] };

  const $ = cheerio.load(html);

  // Collect every matched element first so the parent-grouping step
  // operates on a stable snapshot — cheerio's removeChild during iteration
  // can otherwise shift sibling indices.
  type Match = {
    el: cheerio.Cheerio<any>;
    reviewId: string;
  };
  const matches: Match[] = [];

  $("[data-key]").each((_, raw) => {
    const $el = $(raw);
    const key = ($el.attr("data-key") ?? "").trim();
    if (!key) return;
    const testimonial = testimonialById.get(key);
    if (!testimonial) return;
    if (!textConfirms($el.text(), testimonial)) return;
    matches.push({ el: $el, reviewId: key });
  });

  if (matches.length === 0) return { html, panels: [] };

  // Group matches by parent element so each <ul> (or whatever container
  // Scorpion uses) becomes one panel — even if a page has multiple
  // disconnected testimonial widgets (e.g. a slider in the hero and a
  // grid in the footer), they get one shortcode call each.
  type Group = { parent: any; matches: Match[] };
  const groups: Group[] = [];
  for (const m of matches) {
    const parent = m.el.parent().get(0);
    if (!parent) continue;
    const existing = groups.find((g) => g.parent === parent);
    if (existing) existing.matches.push(m);
    else groups.push({ parent, matches: [m] });
  }

  for (const group of groups) {
    const reviewIds = group.matches.map((m) => m.reviewId);
    const placeholder = `<!-- WP_TESTIMONIAL_PANEL ids="${reviewIds.join(",")}" -->`;
    // Replace the FIRST matched sibling with the placeholder, then
    // remove the rest. Preserves the parent's other children (e.g. a
    // "View All" link) and the parent itself + its classes, which the
    // shortcode-rendered <li>s slot into.
    const [first, ...rest] = group.matches;
    first.el.replaceWith(placeholder);
    for (const m of rest) m.el.remove();
  }

  return {
    html: $.html(),
    panels: groups.map((g) => ({
      reviewIds: g.matches.map((m) => m.reviewId),
    })),
  };
}

// True when the element's text content carries at least the first ~40
// chars of one of the testimonial's text fields, after whitespace +
// case normalization. 40 is short enough to survive Scorpion's
// "first N chars + ellipsis" truncation in compact panels, long enough
// to make accidental collisions vanishingly unlikely.
function textConfirms(elementText: string, t: Testimonial): boolean {
  const elNorm = normalize(elementText);
  if (!elNorm) return false;
  for (const candidate of [t.caption, t.body, t.title]) {
    const cand = normalize(candidate);
    if (!cand) continue;
    const probe = cand.slice(0, 40);
    if (elNorm.includes(probe)) return true;
  }
  return false;
}

function normalize(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/[ ​]/g, " ")
    .trim()
    .toLowerCase();
}
