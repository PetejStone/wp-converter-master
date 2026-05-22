export interface ScorpionPage {
  path: string;
  title: string;
  metaTitle: string;
  metaDescription: string;
  canonical: string;
  // Scorpion's logical template grouping from #SiteMapListTable's
  // "Template" column (e.g. "Home", "Parent", "System", "System - Blog",
  // or a numeric template ID like "423727"). Pages with the same value
  // share one WordPress page template. Empty string when the column is
  // missing. Drives the page's `_wp_page_template` slug — keep it ID-based
  // so renames don't break assignments.
  template: string;
  // Human-readable template name from the "Template Name" column added
  // to /wp-converter/ alongside the numeric ID. Surfaced as the WP admin
  // dropdown label (the `Template Name:` PHP header) so editors see
  // "Home Page" instead of "Template 423727". Empty when the column is
  // absent or blank — the builder falls back to a derived display name.
  templateName: string;
}

// A single 301 source → destination pair, sourced from `#SiteRedirectTable`
// on /wp-converter/. `from` is always a site-relative path with a leading
// + trailing slash and no query string; original casing is preserved so
// the Redirection plugin's URL matcher can honor it. `to` is verbatim so
// absolute URLs and query strings on the target survive.
export interface SiteRedirect {
  from: string;
  to: string;
}

// A blog category from `#BlogCategories` on /wp-converter/. `id` is the
// Scorpion-internal numeric identifier used to join against BlogEntry's
// categoryIds. `slug` is derived from the name at parse time and used as
// the WordPress term nicename so the WXR import stays deterministic.
export interface BlogCategory {
  id: string;
  name: string;
  slug: string;
}

// A blog entry from `#BlogTable` on /wp-converter/. The `path` joins to
// the matching ScorpionPage entry from #SiteMapListTable (those entries
// are already emitted as `post_type=post` via the blog-shape URL match
// in build/hierarchy.ts). `categoryIds` is the comma-separated list from
// the Categories column; an empty array means uncategorized.
export interface BlogEntry {
  path: string;
  categoryIds: string[];
}

export interface IngestResult {
  siteUrl: string;
  pages: ScorpionPage[];
  contentZoneIds: Set<string>;
  // iconName → inner SVG markup (e.g. `<path d="…"/>`). Sourced from
  // `#SiteIconTable` on /wp-converter/. Empty if the site hasn't been
  // updated to expose the table yet — substitution becomes a no-op.
  iconMap: Map<string, string>;
  // Site-level 301 rules from `#SiteRedirectTable`. Written to
  // `redirects.csv` in the build output and ingested by the Redirection
  // plugin via `wp redirection import …` in the wp:import step. Empty
  // when the site hasn't been updated to expose the table yet.
  redirects: SiteRedirect[];
  // Blog categories from `#BlogCategories`. Emitted as `<wp:category>`
  // entries in the WXR. Empty when the site hasn't been updated to
  // expose the table yet.
  blogCategories: BlogCategory[];
  // Blog entry → category mappings from `#BlogTable`. The WXR builder
  // attaches `<category>` elements to the matching post items by path.
  // Empty when the site hasn't been updated to expose the table yet.
  blogEntries: BlogEntry[];
}
