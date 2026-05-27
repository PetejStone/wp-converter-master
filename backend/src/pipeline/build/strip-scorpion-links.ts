import * as cheerio from "cheerio";

// Hostnames whose anchor backlinks should be scrubbed from converted HTML.
// Suffix-matched, so `scorpion.co` catches `www.scorpion.co`, `careers.
// scorpion.co`, etc. Each matched `<a>` is removed in full — children
// included — so the footer "Powered by Scorpion" line, the wrapped logo,
// and any nested branding markup all go with it. The converted site is
// no longer running on the original platform, so the backlinks would be
// both stale and inappropriate to ship.
//
// This is intentionally separate from the STRIPPED_DOMAINS list in
// config/stripped-domains.ts. That list pulls third-party CSS/JS bundles
// (e.g. AudioEye) and their inline references out of the build entirely;
// listing scorpion.co there would also strip Scorpion-owned utility
// scripts the converted theme legitimately needs.
const STRIPPED_ANCHOR_DOMAINS: readonly string[] = ["scorpion.co"];

// Remove every `<a href="…">` whose href points at a stripped domain,
// along with all of its descendants. Returns the input unchanged if
// nothing matches — and short-circuits the cheerio parse when no
// candidate substring is present so the rewrite cost stays near zero
// on pages without Scorpion backlinks.
export function stripScorpionLinks(html: string): string {
  if (!html) return html;
  if (!STRIPPED_ANCHOR_DOMAINS.some((d) => html.includes(d))) return html;

  const $ = cheerio.load(html, null, false);
  let changed = false;

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (hrefMatchesStrippedDomain(href)) {
      $(el).remove();
      changed = true;
    }
  });

  return changed ? $.html() : html;
}

// Exposed for nav-menu emission in wxr.ts so navigation items pointing
// at a stripped domain can be filtered before they become wp:postmeta
// menu items. Same matching semantics as the in-HTML anchor strip.
export function isStrippedScorpionLink(href: string): boolean {
  return hrefMatchesStrippedDomain(href);
}

function hrefMatchesStrippedDomain(href: string): boolean {
  if (!href) return false;
  try {
    const host = new URL(href, "https://placeholder.invalid/").hostname;
    return STRIPPED_ANCHOR_DOMAINS.some(
      (d) => host === d || host.endsWith("." + d),
    );
  } catch {
    // URL parse fails on unusual shapes (e.g. `javascript:`, malformed).
    // Fall back to a substring check so protocol-relative `//host/path`
    // and bare hostnames still match. Lowercased for safety.
    const lower = href.toLowerCase();
    return STRIPPED_ANCHOR_DOMAINS.some((d) => lower.includes(d));
  }
}
