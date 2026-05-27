import * as cheerio from "cheerio";
import type { PageContentZones } from "../parse";
import {
  normalizePath,
  templateValueToDisplayName,
  type PageHierarchy,
} from "./hierarchy";
import { stripBlockedDomainContent } from "./strip-blocked-domains";
import { substituteSvgIcons } from "./svg-icons";
import { rewriteHtmlUrls } from "./url-rewriter";
import { sanitizeZoneId } from "./zone-meta";

const PLACEHOLDER_PATTERN = /<!--\s*WP_CLASSIC_BLOCK_(\d+)\s*-->/g;

export interface PageTemplateOutput {
  filename: string;
  slug: string;
  templateName: string;
  content: string;
}

export interface BuiltTemplates {
  templates: PageTemplateOutput[];
}

export interface Cf7Lookup {
  postId: number;
  title: string;
}

// One PHP template per page. Pages that share a Scorpion Template value
// (e.g. 22 service pages all assigned the same Scorpion template) still
// get their own PHP template here — per-page banner imagery, side
// navigation, and content zones that exist only on specific pages cannot
// be expressed by a shared template-per-Scorpion-template-value file
// without losing visual accuracy. Blog posts are excluded — they're
// routed through single.php instead. Each PHP file includes a
// `Template Name:` header so it shows up in the WP admin Page → Template
// dropdown; the title is the page's own title so admins can locate it
// in the list by content rather than by Scorpion template id.
export function buildPageTemplates(
  zones: PageContentZones[],
  hierarchy: PageHierarchy,
  pageTitleByPath: Map<string, string>,
  urlMap: Map<string, string>,
  iconMap: Map<string, string>,
  pathFormIdToCf7Lookup: Map<string, Cf7Lookup> = new Map(),
): BuiltTemplates {
  const templates: PageTemplateOutput[] = [];
  const zonesByPath = new Map<string, PageContentZones>();
  for (const z of zones) {
    zonesByPath.set(normalizePath(z.path), z);
  }

  for (const node of hierarchy.nodes) {
    if (node.isBlogPost) continue;
    const pageZones = zonesByPath.get(normalizePath(node.path));
    if (!pageZones) continue;
    // Template name shown in the WP admin dropdown. Prefer the page's
    // human-readable title (admins recognize pages by name); fall back to
    // Scorpion's Template column for pages with empty titles, then to the
    // path / page slug so the entry is never blank.
    const templateName = (() => {
      const title = (pageTitleByPath.get(node.path) ?? "").trim();
      if (title) return title;
      const id = node.page.template.trim();
      if (id) return templateValueToDisplayName(id);
      return node.path || node.pageSlug;
    })();
    templates.push(
      buildPageTemplate(
        pageZones,
        node.pageSlug,
        templateName,
        urlMap,
        iconMap,
        pathFormIdToCf7Lookup,
      ),
    );
  }

  return { templates };
}

// Build a single.php for post_type=post views. Uses the first blog-post
// node's HTML as the exemplar; sister posts inherit its chrome. Returns
// null when no blog posts exist on the site. Output omits the
// `Template Name:` header — WP picks single.php automatically based on
// the file name; it's not a user-selectable Page Template.
export function buildSinglePostTemplate(
  zones: PageContentZones[],
  hierarchy: PageHierarchy,
  urlMap: Map<string, string>,
  iconMap: Map<string, string>,
  pathFormIdToCf7Lookup: Map<string, Cf7Lookup> = new Map(),
): { content: string } | null {
  const blogNodes = hierarchy.nodes
    .filter((n) => n.isBlogPost)
    .sort((a, b) => a.postId - b.postId);
  if (blogNodes.length === 0) return null;

  const zonesByPath = new Map<string, PageContentZones>();
  for (const z of zones) zonesByPath.set(normalizePath(z.path), z);

  const exemplar = blogNodes[0];
  const exemplarZones = zonesByPath.get(normalizePath(exemplar.path));
  if (!exemplarZones) return null;

  const built = buildPageTemplate(
    exemplarZones,
    "single",
    "Single Post",
    urlMap,
    iconMap,
    pathFormIdToCf7Lookup,
    { omitHeader: true, replaceArticleWithTheContent: true },
  );
  return { content: built.content };
}

// Build the /error/404 and /error/500 pages as theme files (theme/404.php
// and theme/500.php). These pages aren't navigable WP pages — they don't
// appear in import.xml as items and don't get post_ids. Returns whichever
// of the two were present in the captured zones (each is independent —
// a site may ship one without the other).
//
// Content zones on these pages are rendered INLINE — no [scorpion_zone]
// shortcode call, no postmeta. The shortcode handler needs a post_id to
// read meta from, and we deliberately dropped these from the WP post
// table. Inline-substituted zones lose the "edit via Scorpion Zones
// metabox" capability, which is a fair trade for the error pages since
// admins rarely edit them; if they need to, the source HTML is right
// there in the PHP file.
export function buildErrorTemplates(
  zones: PageContentZones[],
  hierarchy: PageHierarchy,
  urlMap: Map<string, string>,
  iconMap: Map<string, string>,
  pathFormIdToCf7Lookup: Map<string, Cf7Lookup> = new Map(),
): { kind: "404" | "500"; filename: string; content: string }[] {
  const out: { kind: "404" | "500"; filename: string; content: string }[] =
    [];
  const zonesByPath = new Map<string, PageContentZones>();
  for (const z of zones) zonesByPath.set(normalizePath(z.path), z);

  for (const { kind, page: ingestPage } of hierarchy.errorPages) {
    const captured = zonesByPath.get(normalizePath(ingestPage.path));
    if (!captured) continue;
    const built = buildPageTemplate(
      captured,
      kind,
      `Error ${kind}`,
      urlMap,
      iconMap,
      pathFormIdToCf7Lookup,
      {
        omitHeader: true,
        inlineZones: true,
        // 500.php may be served by Apache (ErrorDocument 500) outside the
        // normal WP request lifecycle, so it must bootstrap WP itself for
        // wp_head() / wp_footer() to fire and the enqueue layer to find
        // the page slug. 404.php is served by WP's template hierarchy,
        // which has WP already loaded — no bootstrap needed.
        bootstrap: kind === "500" ? PHP_500_BOOTSTRAP : undefined,
      },
    );
    out.push({
      kind,
      filename: `${kind}.php`,
      content: built.content,
    });
  }

  return out;
}

// Bootstrap snippet prepended to theme/500.php. Loads WP if available so
// wp_head() / wp_footer() fire and our enqueue + page-slug detection
// works; if wp-load.php is missing (e.g. theme installed outside a WP
// root, or WP itself is too broken to load), the snippet silently skips
// the require and the file still emits its static markup so the browser
// gets *something* — better than Apache's default 500 page.
const PHP_500_BOOTSTRAP = `<?php
$scorpion_wp_load = $_SERVER['DOCUMENT_ROOT'] . '/wp-load.php';
if (file_exists($scorpion_wp_load)) {
    require_once $scorpion_wp_load;
    define('SCORPION_RENDERING_500', true);
    status_header(500);
    nocache_headers();
}
?>
`;

function buildPageTemplate(
  page: PageContentZones,
  slug: string,
  templateName: string,
  urlMap: Map<string, string>,
  iconMap: Map<string, string>,
  pathFormIdToCf7Lookup: Map<string, Cf7Lookup>,
  options: {
    omitHeader?: boolean;
    /**
     * When true, replace the inner HTML of the first
     * `<article class="cnt-stl">` element with a `<?php the_content(); ?>`
     * call. Used by single.php so each blog post renders its own captured
     * body (stored in post_content) instead of the exemplar's body.
     */
    replaceArticleWithTheContent?: boolean;
    /**
     * When true, substitute each WP_CLASSIC_BLOCK_<i> placeholder with the
     * captured zone's inner HTML directly (URL-rewritten + SVG-iconified
     * + blocked-domain-stripped) rather than a [scorpion_zone] shortcode
     * call. Used by theme/404.php and theme/500.php, which have no
     * matching post in the database for the shortcode handler to read
     * postmeta from.
     */
    inlineZones?: boolean;
    /**
     * Raw text prepended to the file before any other content. Used by
     * theme/500.php to bootstrap WP from outside the normal request
     * lifecycle (Apache's ErrorDocument serves the file directly).
     */
    bootstrap?: string;
  } = {},
): PageTemplateOutput {
  let html = rewriteHtmlUrls(page.template, page.pageUrl, urlMap);
  html = substituteSvgIcons(html, iconMap);
  html = stripBlockedDomainContent(html);

  // Strip externally-loaded CSS/JS — WordPress wp_enqueue handles those.
  // Strip <style> blocks too — the orchestrator writes them out as a
  // single inline-bundle.css that is enqueued globally.
  const $ = cheerio.load(html);
  $('link[rel="stylesheet"]').remove();
  $("script[src]").remove();
  $("style").remove();

  // single.php (the post template): swap the exemplar's blog body for a
  // placeholder that becomes `<?php the_content(); ?>` so each post
  // renders its own captured `<article class="cnt-stl">` content (stored
  // on the post's content:encoded → post_content).
  const articleContentToken = "WP_THE_CONTENT_MARKER";
  if (options.replaceArticleWithTheContent) {
    const $article = $("article.cnt-stl").first();
    if ($article.length > 0) {
      $article.empty();
      $article.append(`<!-- ${articleContentToken} -->`);
    }
  }

  // Swap Scorpion's contact form for the matching CF7 shortcode. Scorpion
  // wraps each contact panel in a <form> shell (ASP.NET WebForms) with the
  // actual field repeater in a <div class="…ui-contact-form…"> — surrounded
  // by the panel heading, description, and layout markup we want to keep.
  // So:
  //   1. Replace each <div class="ui-contact-form"> with the CF7 shortcode
  //      for the variant of its enclosing <form>.
  //   2. Unwrap that <form> (drop the tag + its hidden control inputs but
  //      keep its children) so the surrounding panel survives.
  //   3. Skip data-search forms (site search / blog filter).
  //   4. Fall back to whole-form replacement when no inner div matches —
  //      preserves coverage for sites that don't follow this markup.
  // Replacement strings are stashed in a sidecar map and re-injected after
  // cheerio serializes (cheerio escapes raw <?php). The shortcode includes
  // both `id` (preferred) and `title` (fallback for when the wordpress-
  // importer reassigns post_ids on a dirty target DB), plus html_id /
  // html_class so the rendered CF7 <form> can be styled alongside the
  // original Scorpion classes.
  const cf7Replacements = new Map<string, string>();
  const formsToUnwrap = new Set<unknown>();

  const makeShortcode = (lookup: Cf7Lookup): string =>
    `<?php echo do_shortcode('[contact-form-7 id="${lookup.postId}" title="${escapePhpSingleQuotes(lookup.title)}" html_id="Form" html_class="ui-contact-form"]'); ?>`;

  // Scorpion uses different ids for the inner field-repeater across
  // sections — `<div id="Form" …>` on /contact-us/ but
  // `<div id="ContactS21Form" …>` on the home page, etc. The class
  // `ui-contact-form` is the consistent signal.
  // Look up the variant CF7 form by (page.path, form id). Form ids alone
  // aren't unique across the site — same Scorpion `<form id="...">` shell
  // can host different inner fields on different pages (e.g. contact form
  // on /contact-us/, careers form on /careers/). The path-qualified key
  // resolves to whichever variant THIS exemplar fingerprinted into.
  const lookupCf7 = (formId: string): Cf7Lookup | undefined =>
    pathFormIdToCf7Lookup.get(`${page.path}|${formId}`);

  $("div.ui-contact-form").each((_, divEl) => {
    const $div = $(divEl);
    const $form = $div.closest("form");
    if ($form.length === 0) return;
    const formId = $form.attr("id");
    if (!formId) return;
    const lookup = lookupCf7(formId);
    if (!lookup) return;
    const token = `WP_CF7_FORM_${cf7Replacements.size}`;
    cf7Replacements.set(token, makeShortcode(lookup));
    $div.replaceWith(`<!-- ${token} -->`);
    formsToUnwrap.add($form.get(0));
  });

  // Fallback: forms with no inner ui-contact-form div get whole-form swap.
  $("form").each((_, formEl) => {
    const $form = $(formEl);
    if ($form.attr("data-search") === "1") return;
    if (formsToUnwrap.has(formEl)) return;
    const id = $form.attr("id");
    if (!id) return;
    const lookup = lookupCf7(id);
    if (!lookup) return;
    const token = `WP_CF7_FORM_${cf7Replacements.size}`;
    cf7Replacements.set(token, makeShortcode(lookup));
    $form.replaceWith(`<!-- ${token} -->`);
  });

  // Unwrap the outer <form> shells that contained an inner-div replacement.
  // Drop their hidden control inputs (e.g. ASP.NET _m_/_VIEWSTATE) — they
  // have no recipient on the WP side.
  for (const formEl of formsToUnwrap) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const $form = $(formEl as any);
    $form.find('input[type="hidden"]').remove();
    $form.replaceWith($form.contents());
  }

  html = $.html();
  if (options.replaceArticleWithTheContent) {
    html = html.replace(
      `<!-- ${articleContentToken} -->`,
      "<?php the_content(); ?>",
    );
  }
  for (const [token, shortcode] of cf7Replacements) {
    html = html.replace(`<!-- ${token} -->`, shortcode);
  }

  // Inject wp_head() / wp_footer() so the theme's enqueued assets load.
  html = html.replace(/<\/head>/i, "<?php wp_head(); ?>\n</head>");
  html = html.replace(/<\/body>/i, "<?php wp_footer(); ?>\n</body>");

  // Replace each WP_CLASSIC_BLOCK_<index> placeholder with either a
  // per-zone shortcode call (default — zone HTML lives in postmeta
  // `_scorpion_zone_<id>`, emitted by the WXR builder; the shortcode
  // handler reads it) or the captured zone HTML inline (when there's no
  // matching post for the handler to read meta from, e.g. error pages).
  html = html.replace(PLACEHOLDER_PATTERN, (_match, indexStr: string) => {
    const i = Number.parseInt(indexStr, 10);
    const zone = page.zones[i];
    if (!zone) return "";
    if (options.inlineZones) {
      let innerHtml = rewriteHtmlUrls(zone.innerHtml, page.pageUrl, urlMap);
      innerHtml = substituteSvgIcons(innerHtml, iconMap);
      innerHtml = stripBlockedDomainContent(innerHtml);
      return innerHtml;
    }
    const safeId = sanitizeZoneId(zone.zoneId);
    return `<?php echo do_shortcode('[scorpion_zone id="${safeId}"]'); ?>`;
  });

  const header = options.omitHeader
    ? ""
    : `<?php
/* Template Name: ${escapePhpComment(templateName)} */
?>
`;
  const bootstrap = options.bootstrap ?? "";

  return {
    filename: `page-${slug}.php`,
    slug,
    templateName,
    content: bootstrap + header + html,
  };
}

function escapePhpComment(value: string): string {
  return value.replace(/\*\//g, "*\\/");
}

function escapePhpSingleQuotes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
