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

// One PHP template per unique Scorpion Template value, NOT per page. Many
// pages share a template (e.g. 22 "System" pages → one page-system.php).
// We pick the exemplar (lowest-postId page in the group) as the source for
// the template HTML; sister pages assigned to it inherit its chrome.
// Blog posts are excluded — they're routed through single.php instead.
// The PHP files include a `Template Name:` header so each shows up as an
// option in the WP admin Page → Template dropdown.
export function buildPageTemplates(
  zones: PageContentZones[],
  hierarchy: PageHierarchy,
  pageTitleByPath: Map<string, string>,
  urlMap: Map<string, string>,
  iconMap: Map<string, string>,
  formIdToCf7Lookup: Map<string, Cf7Lookup> = new Map(),
): BuiltTemplates {
  const templates: PageTemplateOutput[] = [];
  const zonesByPath = new Map<string, PageContentZones>();
  for (const z of zones) {
    zonesByPath.set(normalizePath(z.path), z);
  }

  const groupBySlug = new Map<string, typeof hierarchy.nodes>();
  for (const node of hierarchy.nodes) {
    if (node.isBlogPost) continue;
    const list = groupBySlug.get(node.templateSlug) ?? [];
    list.push(node);
    groupBySlug.set(node.templateSlug, list);
  }

  for (const [slug, group] of groupBySlug) {
    group.sort((a, b) => a.postId - b.postId);
    const exemplar = group[0];
    const exemplarZones = zonesByPath.get(normalizePath(exemplar.path));
    if (!exemplarZones) continue;
    // The template name shown in the admin dropdown. When both the
    // human-readable "Template Name" column and the underlying template
    // ID are present we show "Name (id)" so two templates that happen to
    // share a display name stay distinguishable in the dropdown. Falls
    // back to name-only, then templateValueToDisplayName for ID-only
    // rows, and finally to the page title / path so it's never blank.
    const templateName = (() => {
      const name = exemplar.page.templateName.trim();
      const id = exemplar.page.template.trim();
      if (name && id && name !== id) return `${name} (${id})`;
      if (name) return name;
      if (id) return templateValueToDisplayName(id);
      return pageTitleByPath.get(exemplar.path) || exemplar.path || slug;
    })();
    templates.push(
      buildPageTemplate(
        exemplarZones,
        slug,
        templateName,
        urlMap,
        iconMap,
        formIdToCf7Lookup,
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
  formIdToCf7Lookup: Map<string, Cf7Lookup> = new Map(),
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
    formIdToCf7Lookup,
    { omitHeader: true, replaceArticleWithTheContent: true },
  );
  return { content: built.content };
}

function buildPageTemplate(
  page: PageContentZones,
  slug: string,
  templateName: string,
  urlMap: Map<string, string>,
  iconMap: Map<string, string>,
  formIdToCf7Lookup: Map<string, Cf7Lookup>,
  options: {
    omitHeader?: boolean;
    /**
     * When true, replace the inner HTML of the first
     * `<article class="cnt-stl">` element with a `<?php the_content(); ?>`
     * call. Used by single.php so each blog post renders its own captured
     * body (stored in post_content) instead of the exemplar's body.
     */
    replaceArticleWithTheContent?: boolean;
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
  $("div.ui-contact-form").each((_, divEl) => {
    const $div = $(divEl);
    const $form = $div.closest("form");
    if ($form.length === 0) return;
    const formId = $form.attr("id");
    if (!formId) return;
    const lookup = formIdToCf7Lookup.get(formId);
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
    const lookup = formIdToCf7Lookup.get(id);
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

  // Replace each WP_CLASSIC_BLOCK_<index> placeholder with a per-zone
  // shortcode call. The zone HTML lives in postmeta `_scorpion_zone_<id>`
  // (emitted by the WXR builder); the shortcode handler in functions.php
  // echoes it. This preserves exact per-zone placement on multi-zone pages.
  html = html.replace(PLACEHOLDER_PATTERN, (_match, indexStr: string) => {
    const i = Number.parseInt(indexStr, 10);
    const zone = page.zones[i];
    if (!zone) return "";
    const safeId = sanitizeZoneId(zone.zoneId);
    return `<?php echo do_shortcode('[scorpion_zone id="${safeId}"]'); ?>`;
  });

  const header = options.omitHeader
    ? ""
    : `<?php
/* Template Name: ${escapePhpComment(templateName)} */
?>
`;

  return {
    filename: `page-${slug}.php`,
    slug,
    templateName,
    content: header + html,
  };
}

function escapePhpComment(value: string): string {
  return value.replace(/\*\//g, "*\\/");
}

function escapePhpSingleQuotes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
