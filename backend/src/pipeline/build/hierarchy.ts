import type { ScorpionPage } from "../ingest";

// One node per real page from the Scorpion sitemap. The hierarchy walk
// assigns parent post_ids based on path containment so WordPress can resolve
// nested URLs (`/a/b/c/`) via post_name + post_parent lookup at each level.
export interface PageNode {
  // Normalized path with leading + trailing slash, e.g. "/", "/about-us/",
  // "/services/water/". This is the canonical key for `byPath`.
  path: string;
  // Slug derived from the Scorpion Template column (e.g. "system",
  // "system-no-banner", "home", "parent"). Many pages share the same value
  // — one PHP template per unique slug is emitted into theme/templates/.
  // Empty Template values fall back to "generic". Used as the page's
  // _wp_page_template assignment.
  templateSlug: string;
  // 1-based unique post_id. Parents are always assigned before children.
  postId: number;
  // WordPress post_name: last URL segment only (or "home" for "/").
  // Must be unique within parentPostId — disambiguated with `-1`, `-2`, …
  // if collisions occur.
  postName: string;
  // 0 = top-level. Non-zero = the parent's postId. If a path's parent is
  // missing from the sitemap, parentPostId is 0 (page falls back to
  // top-level — WP serves it at /<postName>/ instead of the nested URL).
  parentPostId: number;
  // True when the path matches a blog-post URL shape
  // (`/<blog-root>/YYYY/<month>/<slug>/`). Routed to post_type=post in
  // WXR instead of `page`; excluded from the page-hierarchy parent walk.
  isBlogPost: boolean;
  // The original ingest record. Used by the WXR builder for title /
  // canonical / Yoast meta. v1 emits one node per real ingest page; no
  // stub-page synthesis for missing intermediates.
  page: ScorpionPage;
}

export interface PageHierarchy {
  nodes: PageNode[];
  byPath: Map<string, PageNode>;
  // Largest post_id used. Downstream emitters (e.g. nav menu items in the
  // WXR) start their post_ids at maxPostId + 1.
  maxPostId: number;
}

export function buildPageHierarchy(pages: ScorpionPage[]): PageHierarchy {
  const realByPath = new Map<string, ScorpionPage>();
  for (const p of pages) realByPath.set(normalizePath(p.path), p);

  // Parents must be inserted before their children so post_id allocation is
  // topologically valid. Sort by depth, then alphabetically for determinism.
  const sortedPaths = [...realByPath.keys()].sort((a, b) => {
    const da = depth(a);
    const db = depth(b);
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });

  const byPath = new Map<string, PageNode>();
  const nodes: PageNode[] = [];
  const takenPostNameByParent = new Map<number, Set<string>>();

  for (const path of sortedPaths) {
    const page = realByPath.get(path)!;
    const segments = path.split("/").filter(Boolean);
    const blogPost = isBlogPostPath(path);

    let parentPostId = 0;
    if (segments.length > 1 && !blogPost) {
      const parentPath = "/" + segments.slice(0, -1).join("/") + "/";
      const parent = byPath.get(parentPath);
      if (parent) parentPostId = parent.postId;
      // else: missing parent — leave at 0 (URL flattens to top-level)
    }

    const lastSegment = segments[segments.length - 1] ?? "";
    let postName = sanitizeSlug(lastSegment) || "home";

    let nameSet = takenPostNameByParent.get(parentPostId);
    if (!nameSet) {
      nameSet = new Set<string>();
      takenPostNameByParent.set(parentPostId, nameSet);
    }
    let candidate = postName;
    let counter = 1;
    while (nameSet.has(candidate)) {
      candidate = `${postName}-${counter}`;
      counter++;
    }
    postName = candidate;
    nameSet.add(postName);

    const templateSlug = templateValueToSlug(page.template);

    const node: PageNode = {
      path,
      templateSlug,
      postId: nodes.length + 1,
      postName,
      parentPostId,
      isBlogPost: blogPost,
      page,
    };
    nodes.push(node);
    byPath.set(path, node);
  }

  return {
    nodes,
    byPath,
    maxPostId: nodes.length,
  };
}

// Maps a Scorpion Template column value to a filesystem-safe slug used
// for both the `templates/page-<slug>.php` filename and the page's
// `_wp_page_template` assignment. Empty values map to "generic". Pure-
// numeric values (Scorpion now ships template IDs like "423727" instead
// of names like "System") get a `template-` prefix so the slug isn't
// just digits — WordPress + various PHP helpers handle "423727" oddly in
// places that expect a string identifier.
export function templateValueToSlug(template: string): string {
  const trimmed = template.trim();
  if (!trimmed) return "generic";
  if (/^\d+$/.test(trimmed)) return `template-${trimmed}`;
  return (
    trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "generic"
  );
}

// Human-friendly admin display name for the Template Name header. For
// numeric Scorpion template IDs we don't have a readable name in
// /wp-converter/, so we surface "Template <id>" — better than a raw
// number alone in the admin dropdown.
export function templateValueToDisplayName(template: string): string {
  const trimmed = template.trim();
  if (!trimmed) return "Generic";
  if (/^\d+$/.test(trimmed)) return `Template ${trimmed}`;
  return trimmed;
}

// Blog posts have URLs like `/our-blog/2025/october/how-to-….-/` —
// three path segments after the blog root, with the second being a year
// and the third being a month name. Anything matching that shape is
// emitted as post_type=post and excluded from the page parent walk.
export function isBlogPostPath(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 4) return false;
  const root = segments[0].toLowerCase();
  if (root !== "our-blog" && root !== "blog" && root !== "news") return false;
  if (!/^\d{4}$/.test(segments[1])) return false;
  if (!/^[a-z]+$/i.test(segments[2])) return false;
  return true;
}

export function normalizePath(path: string): string {
  if (!path || path === "/") return "/";
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  return "/" + trimmed + "/";
}

function depth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

function sanitizeSlug(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

