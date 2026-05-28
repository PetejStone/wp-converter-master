import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CrawlResult } from "../crawl";
import {
  downloadAssetUrls,
  downloadMedia,
  type DownloadOutcome,
} from "../download";
import type { IngestResult } from "../ingest";
import type { SiteRedirect } from "../ingest";
import type {
  AssetInventory,
  FormAnalysis,
  MediaInventory,
  NavAnalysis,
  PageContentZones,
} from "../parse";
import { buildCf7Forms, type Cf7Form } from "./cf7-forms";
import { buildMigrationChecklist } from "./checklist";
import { buildCptUiExport } from "./cpt-ui-export";
import { TESTIMONIAL_METABOX } from "./cpts/testimonials";
import { buildPageHierarchy } from "./hierarchy";
import { stripBlockedDomainsFromJs } from "./strip-blocked-domains";
import {
  buildErrorTemplates,
  buildPageTemplates,
  buildSinglePostTemplate,
} from "./templates";
import {
  buildFunctionsPhp,
  buildHtaccessAdditions,
  buildIndexPhp,
  buildStyleCss,
  THEME_SLUG,
} from "./theme";
import { rewriteCssUrls } from "./url-rewriter";
import { discoverAndRewriteUscUtilityScripts } from "./usc-utility-scripts";
import { buildWxrXml } from "./wxr";
import { zipDirectory } from "./zip";

export interface BuildInputs {
  jobRootDir: string;
  siteUrl: string;
  siteTitle: string;
  ingest: IngestResult;
  crawl: CrawlResult;
  assets: AssetInventory;
  media: MediaInventory;
  contentZones: PageContentZones[];
  formAnalysis: FormAnalysis;
  navAnalysis: NavAnalysis;
  // How many testimonial panels the parse-time detector replaced with
  // shortcode placeholders. Surfaced in the migration checklist so
  // admins can sanity-check that the CPT-driven panels match what the
  // original site rendered. Optional — older callers pass undefined.
  testimonialPanelCount?: number;
}

export interface BuildStats {
  ok: number;
  failed: number;
  totalBytes: number;
}

export interface BuildOutput {
  outputDir: string;
  zipPath: string;
  zipByteSize: number;
  css: BuildStats;
  js: BuildStats;
  mediaDownload: BuildStats;
  pageCount: number;
  zoneCount: number;
}

export async function buildWpPackage(
  inputs: BuildInputs,
): Promise<BuildOutput> {
  const outputDir = join(inputs.jobRootDir, "output");
  const themeDir = join(outputDir, "theme", THEME_SLUG);
  const cssDir = join(themeDir, "css");
  const jsDir = join(themeDir, "js");
  const templatesDir = join(themeDir, "templates");
  const mediaOutDir = join(outputDir, "media");

  await mkdir(cssDir, { recursive: true });
  await mkdir(jsDir, { recursive: true });
  await mkdir(templatesDir, { recursive: true });
  await mkdir(mediaOutDir, { recursive: true });

  const [cssOutcome, jsOutcome, mediaOutcome] = await Promise.all([
    downloadAssetUrls(inputs.assets.stylesheets, cssDir, {
      wpPathPrefix: `/wp-content/themes/${THEME_SLUG}/css`,
      fallbackExtension: ".css",
    }),
    downloadAssetUrls(inputs.assets.scripts, jsDir, {
      wpPathPrefix: `/wp-content/themes/${THEME_SLUG}/js`,
      fallbackExtension: ".js",
    }),
    downloadMedia(inputs.media, mediaOutDir),
  ]);

  const urlMap = new Map<string, string>([
    ...cssOutcome.urlMap,
    ...jsOutcome.urlMap,
    ...mediaOutcome.urlMap,
  ]);

  // Rewrite url() references inside the downloaded stylesheets so background
  // images and font references point at the local media / theme paths.
  for (const r of cssOutcome.results) {
    if (r.status !== "ok" || !r.filename) continue;
    const cssPath = join(cssDir, r.filename);
    const css = await readFile(cssPath, "utf8");
    const rewritten = rewriteCssUrls(css, r.url, urlMap);
    if (rewritten !== css) {
      await writeFile(cssPath, rewritten);
    }
  }

  // Downloaded asset URL → on-disk filename, derived once for per-page
  // handle mapping below.
  const cssFilenameByUrl = new Map<string, string>();
  for (const r of cssOutcome.results) {
    if (r.status === "ok" && r.filename) cssFilenameByUrl.set(r.url, r.filename);
  }
  const jsFilenameByUrl = new Map<string, string>();
  for (const r of jsOutcome.results) {
    if (r.status === "ok" && r.filename) jsFilenameByUrl.set(r.url, r.filename);
  }

  // Neutralise references to third-party domains we don't want running on
  // the converted site (e.g. AudioEye, which is tied to the original
  // Scorpion license). Replaces matching string literals inside JS with
  // empty strings so dynamic `n.src = "https://…audioeye.com/…"` style
  // injections become no-ops. Runs before the USC discovery pass so the
  // discoverer doesn't pick up dependencies of stripped scripts.
  // Configured list lives in backend/src/config/stripped-domains.ts.
  await stripBlockedDomainsFromJs(jsDir);

  // Discover, fetch, and rewrite Scorpion's runtime-loaded `/common/usc/p/`
  // utility scripts. Without this pass, dynamic require2() calls inside
  // downloaded JS bundles 404 against the WP host because the literal path
  // points back at the original site root. Run after the main JS download
  // so we can scan every bundle's contents for the dependency list.
  const jsWpPathPrefix = `/wp-content/themes/${THEME_SLUG}/js`;
  const uscOutcome = await discoverAndRewriteUscUtilityScripts({
    siteUrl: inputs.siteUrl,
    jsDir,
    jsWpPathPrefix,
    jsFilenameByUrl,
  });
  for (const [url, filename] of uscOutcome.newlyDownloaded) {
    jsFilenameByUrl.set(url, filename);
    // Also surface in the urlMap so any HTML still pointing at the
    // original /common/usc/p/<name>.js absolute URL gets rewritten by the
    // HTML rewriter to the theme path.
    urlMap.set(url, `${jsWpPathPrefix}/${filename}`);
  }

  // Scorpion's cookie consent banner (`manage-cookies.js`) is dropped from
  // the bundle. The script fetches a `manage-cookies.html` companion at
  // runtime that we don't ship; the fetch 404s and the script's
  // DOMParser fallback attaches WP's 404 page (site title + recent posts)
  // to a Shadow DOM on every page. The converted WP site gets a proper
  // cookie plugin (Complianz, installed by import-to-wp.ts) instead.
  // Removed from disk + lookup maps so it's neither registered nor
  // referenced by the per-page enqueue layer.
  const COOKIE_BANNER_BLOCKLIST = /^manage-cookies\./i;
  for (const [url, filename] of Array.from(jsFilenameByUrl)) {
    if (!COOKIE_BANNER_BLOCKLIST.test(filename)) continue;
    jsFilenameByUrl.delete(url);
    urlMap.delete(url);
    await rm(join(jsDir, filename), { force: true });
  }

  // Build the hierarchy now so per-page inline CSS files can be named after
  // each page's pageSlug — that's the same key the enqueue logic uses
  // at request time.
  const pageTitleByPath = new Map(
    inputs.ingest.pages.map((p) => [p.path, p.title]),
  );
  const hierarchy = buildPageHierarchy(inputs.ingest.pages);

  // Per-page inline <style> blocks: one inline-<pageSlug>.css file per
  // page that has any. Each page's PHP template enqueues its own file, so
  // pages don't pick up other pages' tokens. Blog posts are excluded —
  // single.php uses the dominant blog template's inline CSS.
  const inlineFilenameByPageSlug = new Map<string, string>();
  for (const node of hierarchy.nodes) {
    if (node.isBlogPost) continue;
    const indices = inputs.assets.pageInlineStyleIndices.get(node.page.path) ?? [];
    if (indices.length === 0) continue;
    const inlineCss = indices
      .map((idx, i) => {
        const block = inputs.assets.inlineStyles[idx] ?? "";
        return `/* === inline block ${i + 1} === */\n${block}`;
      })
      .join("\n\n");
    const rewritten = rewriteCssUrls(inlineCss, inputs.siteUrl, urlMap);
    const filename = `inline-${node.pageSlug}.css`;
    await writeFile(join(cssDir, filename), rewritten);
    inlineFilenameByPageSlug.set(node.pageSlug, filename);
  }

  // Blog posts share a single inline-<templateSlug>.css matching single.php's
  // chrome (picked further down). Aggregate the dominant blog template's
  // exemplar inline styles here so the file is on disk before functions.php
  // wires it up.
  const blogTemplateCounts = new Map<string, number>();
  for (const node of hierarchy.nodes) {
    if (!node.isBlogPost) continue;
    blogTemplateCounts.set(
      node.templateSlug,
      (blogTemplateCounts.get(node.templateSlug) ?? 0) + 1,
    );
  }
  let dominantBlogTemplateSlug: string | null = null;
  let bestBlogCount = 0;
  for (const [slug, count] of blogTemplateCounts) {
    if (count > bestBlogCount) {
      bestBlogCount = count;
      dominantBlogTemplateSlug = slug;
    }
  }
  let blogExemplarPageSlug: string | null = null;
  if (dominantBlogTemplateSlug) {
    let exemplar: typeof hierarchy.nodes[number] | null = null;
    for (const node of hierarchy.nodes) {
      if (!node.isBlogPost) continue;
      if (node.templateSlug !== dominantBlogTemplateSlug) continue;
      if (!exemplar || node.postId < exemplar.postId) exemplar = node;
    }
    if (exemplar) {
      blogExemplarPageSlug = exemplar.pageSlug;
      const indices = inputs.assets.pageInlineStyleIndices.get(exemplar.page.path) ?? [];
      if (indices.length > 0 && !inlineFilenameByPageSlug.has(exemplar.pageSlug)) {
        const inlineCss = indices
          .map((idx, i) => {
            const block = inputs.assets.inlineStyles[idx] ?? "";
            return `/* === inline block ${i + 1} === */\n${block}`;
          })
          .join("\n\n");
        const rewritten = rewriteCssUrls(inlineCss, inputs.siteUrl, urlMap);
        const filename = `inline-${exemplar.pageSlug}.css`;
        await writeFile(join(cssDir, filename), rewritten);
        inlineFilenameByPageSlug.set(exemplar.pageSlug, filename);
      }
    }
  }

  // CF7 layout + label/sizing overrides for the .ui-contact-form panel.
  // Written once per build, enqueued on every page below so it always wins
  // over the bundled Scorpion CSS.
  const cf7OverridesFilename = "cf7-overrides.css";
  await writeFile(
    join(cssDir, cf7OverridesFilename),
    buildCf7OverridesCss(),
  );

  const cssFilenames: string[] = [];
  for (const r of cssOutcome.results) {
    if (r.status === "ok" && r.filename) cssFilenames.push(r.filename);
  }
  // Per-page inline CSS files are part of the registered stylesheet
  // handle set so the enqueue logic can reference them.
  for (const filename of inlineFilenameByPageSlug.values()) {
    cssFilenames.push(filename);
  }
  cssFilenames.push(cf7OverridesFilename);
  const jsFilenames: string[] = [];
  for (const r of jsOutcome.results) {
    if (r.status !== "ok" || !r.filename) continue;
    // Drop blocklisted scripts from the registered handle set so nothing
    // accidentally enqueues them.
    if (COOKIE_BANNER_BLOCKLIST.test(r.filename)) continue;
    jsFilenames.push(r.filename);
  }

  // pageSlug → ordered list of CSS / JS filenames each Scorpion page
  // loaded, in document order. The page's own inline file goes FIRST so
  // the downloaded bundles cascade over it (matches the original site
  // where <style> blocks live in <head> and the main bundle renders into
  // <body>, making the bundle authoritative on any selector they both
  // touch — reversing causes :root token fights).
  const cssFilenamesByPageSlug = new Map<string, string[]>();
  const jsFilenamesByPageSlug = new Map<string, string[]>();
  const buildAssetsForNode = (node: typeof hierarchy.nodes[number]) => {
    const path = node.page.path;

    const cssForPage: string[] = [];
    const inlineFile = inlineFilenameByPageSlug.get(node.pageSlug);
    if (inlineFile) cssForPage.push(inlineFile);
    const cssUrls = inputs.assets.pageStylesheets.get(path) ?? [];
    for (const url of cssUrls) {
      const filename = cssFilenameByUrl.get(url);
      if (filename) cssForPage.push(filename);
    }
    // CF7 overrides go last so they win on equal-specificity selectors.
    cssForPage.push(cf7OverridesFilename);
    cssFilenamesByPageSlug.set(node.pageSlug, cssForPage);

    const jsUrls = inputs.assets.pageScripts.get(path) ?? [];
    const jsForPage: string[] = [];
    for (const url of jsUrls) {
      const filename = jsFilenameByUrl.get(url);
      if (filename) jsForPage.push(filename);
    }
    jsFilenamesByPageSlug.set(node.pageSlug, jsForPage);
  };

  for (const node of hierarchy.nodes) {
    if (node.isBlogPost) continue;
    buildAssetsForNode(node);
  }
  // Blog exemplar's asset bundle drives single.php (blog posts share one
  // template). Add it under its own pageSlug so the runtime enqueue map
  // resolves it — without this, post views render with no Scorpion CSS/JS.
  if (blogExemplarPageSlug) {
    const exemplarNode = hierarchy.nodes.find(
      (n) => n.isBlogPost && n.pageSlug === blogExemplarPageSlug,
    );
    if (exemplarNode) buildAssetsForNode(exemplarNode);
  }

  // Synthetic asset bundles for theme/404.php and theme/500.php. The slugs
  // here aren't path-derived (the error pages don't have pageSlugs — they
  // never reach the hierarchy.nodes loop) but match the literal strings
  // scorpion_converted_current_page_slug() returns for is_404() and
  // SCORPION_RENDERING_500.
  for (const { kind, page: errorPage } of hierarchy.errorPages) {
    const slug = kind; // '404' or '500'
    const path = errorPage.path;

    // Per-error-page inline CSS file, mirroring the per-page treatment.
    const indices = inputs.assets.pageInlineStyleIndices.get(path) ?? [];
    if (indices.length > 0) {
      const inlineCss = indices
        .map((idx, i) => {
          const block = inputs.assets.inlineStyles[idx] ?? "";
          return `/* === inline block ${i + 1} === */\n${block}`;
        })
        .join("\n\n");
      const rewritten = rewriteCssUrls(inlineCss, inputs.siteUrl, urlMap);
      const filename = `inline-${slug}.css`;
      await writeFile(join(cssDir, filename), rewritten);
      // Pushed to cssFilenames below alongside the per-page set so it gets
      // registered with wp_register_style.
      inlineFilenameByPageSlug.set(slug, filename);
      cssFilenames.push(filename);
    }

    const cssForPage: string[] = [];
    const inlineFile = inlineFilenameByPageSlug.get(slug);
    if (inlineFile) cssForPage.push(inlineFile);
    const cssUrls = inputs.assets.pageStylesheets.get(path) ?? [];
    for (const url of cssUrls) {
      const filename = cssFilenameByUrl.get(url);
      if (filename) cssForPage.push(filename);
    }
    cssForPage.push(cf7OverridesFilename);
    cssFilenamesByPageSlug.set(slug, cssForPage);

    const jsUrls = inputs.assets.pageScripts.get(path) ?? [];
    const jsForPage: string[] = [];
    for (const url of jsUrls) {
      const filename = jsFilenameByUrl.get(url);
      if (filename) jsForPage.push(filename);
    }
    jsFilenamesByPageSlug.set(slug, jsForPage);
  }

  await writeFile(
    join(themeDir, "style.css"),
    buildStyleCss(inputs.siteTitle),
  );

  await writeFile(
    join(themeDir, "functions.php"),
    buildFunctionsPhp({
      siteTitle: inputs.siteTitle,
      cssFilenames,
      jsFilenames,
      perPage: {
        cssFilenamesByPageSlug,
        jsFilenamesByPageSlug,
      },
      // single.php uses the dominant blog template's exemplar page-slug
      // for its asset bundle. null when the site has no blog posts.
      postPageSlug: blogExemplarPageSlug,
      // Purpose-built admin metaboxes for each Scorpion-system CPT. The
      // schema in cpts/<system>.ts drives both the metabox PHP and the
      // matching WXR postmeta emission in wxr.ts.
      cptMetaboxes: [TESTIMONIAL_METABOX],
    }),
  );

  // Emit a CSV the Redirection plugin can ingest via `wp redirection import`.
  // We only write the file when there's something to import — wp:import
  // looks for the file's existence as the install/import trigger so it
  // doesn't bother installing the plugin on sites with no redirects.
  if (inputs.ingest.redirects.length > 0) {
    await writeFile(
      join(outputDir, "redirects.csv"),
      buildRedirectsCsv(inputs.ingest.redirects),
    );
  }
  await writeFile(join(themeDir, "index.php"), buildIndexPhp());

  const iconMap = inputs.ingest.iconMap;

  // CF7 forms: allocate post_ids after pages + primary nav items + footer
  // Quick Links items so they don't collide. Primary nav claims
  // hierarchy.maxPostId + 1 .. + items.length inside wxr.ts; footer Quick
  // Links runs from there to + footerItems.length; CF7 posts start after.
  const dominantNav = inputs.navAnalysis?.variants[0];
  const navItemCount = dominantNav?.items.length ?? 0;
  const footerNavItemCount =
    inputs.navAnalysis?.footerQuickLinks?.length ?? 0;
  const cf7BasePostId =
    hierarchy.maxPostId + navItemCount + footerNavItemCount + 1;
  const cf7Forms: Cf7Form[] = buildCf7Forms({
    variants: inputs.formAnalysis.variants,
    basePostId: cf7BasePostId,
    siteTitle: inputs.siteTitle,
  });
  // Key the form lookup by `<path>|<formId>` (NOT just formId). Scorpion
  // reuses the same `<form id="...">` shell on different pages with
  // different inner fields — e.g. Form_ContactSystemS3 carries the contact
  // form on /contact-us/ and a job-application form on /careers/. Both
  // share the same form id but fingerprint to different variants. Keying
  // by form-id alone caused a last-write-wins overwrite where one page's
  // shortcode resolved to the other variant's CF7 post. variant.occurrences
  // gives us the path → formId attribution from analyzeForms, so each
  // (path, formId) tuple maps cleanly to exactly the variant that page
  // fingerprinted into.
  const pathFormIdToCf7Lookup = new Map<
    string,
    { postId: number; title: string }
  >();
  for (const cf7 of cf7Forms) {
    const variant = inputs.formAnalysis.variants.find(
      (v) => v.fingerprint === cf7.fingerprint,
    );
    if (!variant) continue;
    for (const occ of variant.occurrences) {
      if (!occ.formId) continue;
      pathFormIdToCf7Lookup.set(`${occ.path}|${occ.formId}`, {
        postId: cf7.postId,
        title: cf7.title,
      });
    }
  }

  const { templates } = buildPageTemplates(
    inputs.contentZones,
    hierarchy,
    pageTitleByPath,
    urlMap,
    iconMap,
    pathFormIdToCf7Lookup,
  );
  for (const t of templates) {
    await writeFile(join(templatesDir, t.filename), t.content);
  }

  // single.php for post_type=post views. WP picks it up automatically by
  // filename — uses the first blog post's HTML as the chrome exemplar.
  const singleTemplate = buildSinglePostTemplate(
    inputs.contentZones,
    hierarchy,
    urlMap,
    iconMap,
    pathFormIdToCf7Lookup,
  );
  if (singleTemplate) {
    await writeFile(join(themeDir, "single.php"), singleTemplate.content);
  }

  // 404.php and 500.php for Scorpion's /error/404 and /error/500 pages.
  // These get peeled off the regular WXR page list in hierarchy.ts so
  // they don't show up as navigable WP pages — they're served by WP's
  // 404 template hierarchy and Apache's ErrorDocument 500 (see
  // htaccess-additions.txt) respectively.
  const errorTemplates = buildErrorTemplates(
    inputs.contentZones,
    hierarchy,
    urlMap,
    iconMap,
    pathFormIdToCf7Lookup,
  );
  for (const t of errorTemplates) {
    await writeFile(join(themeDir, t.filename), t.content);
  }

  // Testimonials: post_ids start after CF7 forms so nothing collides with
  // pages / nav items / CF7 entries already allocated above.
  const testimonialBasePostId = cf7BasePostId + cf7Forms.length;

  const wxr = buildWxrXml({
    siteUrl: inputs.siteUrl,
    siteTitle: inputs.siteTitle,
    hierarchy,
    contentZones: inputs.contentZones,
    urlMap,
    iconMap,
    navAnalysis: inputs.navAnalysis,
    cf7Forms,
    blogCategories: inputs.ingest.blogCategories,
    blogEntries: inputs.ingest.blogEntries,
    testimonials: inputs.ingest.testimonials,
    testimonialBasePostId,
  });
  await writeFile(join(outputDir, "import.xml"), wxr);

  await writeFile(
    join(outputDir, "htaccess-additions.txt"),
    buildHtaccessAdditions(),
  );

  // CPT UI plugin import file. The wp:import script auto-installs the
  // plugin and imports this JSON so the converted site has the right
  // post types registered the moment the import finishes. Always
  // emitted (even if no testimonials were found) — keeps the wp:import
  // step deterministic and gives admins a starting schema if they later
  // add testimonials by hand.
  await writeFile(
    join(outputDir, "cptui-export.json"),
    JSON.stringify(buildCptUiExport(), null, 2) + "\n",
  );

  const totalZones = inputs.contentZones.reduce(
    (n, p) => n + p.zones.length,
    0,
  );
  const limitations = collectLimitations(cssOutcome, jsOutcome, mediaOutcome);
  await writeFile(
    join(outputDir, "MIGRATION-CHECKLIST.md"),
    buildMigrationChecklist({
      siteTitle: inputs.siteTitle,
      pageCount: inputs.ingest.pages.length,
      zoneCount: totalZones,
      mediaCount: mediaOutcome.okCount,
      failedMedia: mediaOutcome.failedCount,
      formVariantCount: inputs.formAnalysis.variants.length,
      redirectCount: inputs.ingest.redirects.length,
      blogCategoryCount: inputs.ingest.blogCategories.length,
      blogPostCount: inputs.ingest.blogEntries.filter(
        (e) => e.categoryIds.length > 0,
      ).length,
      testimonialCount: inputs.ingest.testimonials.length,
      testimonialPanelCount: inputs.testimonialPanelCount ?? 0,
      knownLimitations: limitations,
    }),
  );

  // Duplicate every JS file into `common/usc/p/` at the export root so
  // the SFTP'd directory tree resolves Scorpion's `/common/usc/p/<name>.js`
  // requests as static files at the WP root. This bypasses the theme's
  // `init`-hook intercept entirely, which is required on hosts (GoDaddy
  // Managed WordPress) that 404 unknown static-file paths at the edge
  // before WordPress boots. The files are byte-for-byte copies of what
  // already lives in theme/scorpion-converted/js/ — kilobytes of dup, no
  // host-level rewrites needed.
  const commonUscPDir = join(outputDir, "common", "usc", "p");
  await mkdir(commonUscPDir, { recursive: true });
  const jsFiles = (await readdir(jsDir)).filter((f) =>
    f.toLowerCase().endsWith(".js"),
  );
  await Promise.all(
    jsFiles.map((f) => copyFile(join(jsDir, f), join(commonUscPDir, f))),
  );

  const zipPath = join(inputs.jobRootDir, "export.zip");
  const { byteSize } = await zipDirectory(outputDir, zipPath);

  return {
    outputDir,
    zipPath,
    zipByteSize: byteSize,
    css: outcomeStats(cssOutcome),
    js: outcomeStats(jsOutcome),
    mediaDownload: outcomeStats(mediaOutcome),
    pageCount: inputs.ingest.pages.length,
    zoneCount: totalZones,
  };
}

function outcomeStats(o: {
  okCount: number;
  failedCount: number;
  totalBytes: number;
}): BuildStats {
  return { ok: o.okCount, failed: o.failedCount, totalBytes: o.totalBytes };
}

// Layout + sizing + label-colour rules for the CF7 form that replaces the
// Scorpion contact panel. Targets `.ui-contact-form` (we pass that class
// via the [contact-form-7] shortcode's html_class attribute) so the rules
// don't leak to other forms on the site. Uses `:has()` — supported in all
// current Chrome / Edge / Safari / Firefox (Firefox stable late 2023).
function buildCf7OverridesCss(): string {
  return [
    "/* CF7 layout overrides for the .ui-contact-form panel. */",
    "",
    ".ui-contact-form {",
    "  display: flex;",
    "  flex-wrap: wrap;",
    "  gap: 0.5rem;",
    "  padding: 0;",
    "}",
    "",
    "/* CF7 wraps every tag in a <p> with default agent margins — kill them",
    " * so flex layout owns the spacing. Default each row to full width;",
    " * narrower fields opt in via the :has() rules below. */",
    ".ui-contact-form > p {",
    "  flex: 0 1 100%;",
    "  margin: 0;",
    "  box-sizing: border-box;",
    "}",
    "",
    "/* Single-line inputs + selects — match the original panel proportions. */",
    ".ui-contact-form input.wpcf7-form-control:not([type=\"checkbox\"]):not([type=\"radio\"]):not([type=\"submit\"]),",
    ".ui-contact-form select.wpcf7-form-control {",
    "  height: 2.5rem;",
    "  padding: 0 0.75rem;",
    "  box-sizing: border-box;",
    "  width: 100%;",
    "  background-color: #fff;",
    "  color: #000;",
    "  border: 1px solid #000;",
    "}",
    "",
    "/* Select option list — keep option text readable on every theme. */",
    ".ui-contact-form select.wpcf7-form-control option {",
    "  color: #000;",
    "  background-color: #fff;",
    "}",
    "",
    "/* Textareas — same look, height 80% of containing box. */",
    ".ui-contact-form textarea.wpcf7-form-control {",
    "  padding: 0.5rem 0.75rem;",
    "  box-sizing: border-box;",
    "  width: 100%;",
    "  height: 80%;",
    "  background-color: #fff;",
    "  color: #000;",
    "  border: 1px solid #000;",
    "}",
    "",
    "/* Checkbox + radio — give them the same visible border as the rest. */",
    ".ui-contact-form input[type=\"checkbox\"].wpcf7-form-control,",
    ".ui-contact-form input[type=\"radio\"].wpcf7-form-control {",
    "  border: 1px solid #000;",
    "}",
    "",
    "/* ≥ 700px: text-like single-line fields go half width so two share a row. */",
    "@media (min-width: 700px) {",
    "  .ui-contact-form > p:has(input.wpcf7-text),",
    "  .ui-contact-form > p:has(input.wpcf7-tel),",
    "  .ui-contact-form > p:has(input.wpcf7-email),",
    "  .ui-contact-form > p:has(input.wpcf7-number),",
    "  .ui-contact-form > p:has(input.wpcf7-url),",
    "  .ui-contact-form > p:has(input.wpcf7-password) {",
    "    flex: 0 1 calc(50% - 0.25rem);",
    "  }",
    "",
    "  /* Address stays full-width even though it's typically a text input. */",
    "  .ui-contact-form > p:has(.wpcf7-form-control-wrap[data-name*=\"address\"]) {",
    "    flex: 0 1 100%;",
    "  }",
    "}",
    "",
    "/* Submit button — match the site's primary button colour, size to its label. */",
    ".ui-contact-form input.wpcf7-submit {",
    "  background: var(--buttons);",
    "  width: fit-content;",
    "  padding: 1rem;",
    "}",
    "",
    "/* Label colour follows the section background contract:",
    " *   .lt-bg panel  → black labels by default, white when nested in .ulk-bg",
    " *   .dk-bg panel  → white labels by default, black when nested in .ulk-bg",
    " * The 3-class rule (.ulk-bg in between) is more specific and overrides",
    " * the 2-class default when present. */",
    ".lt-bg .ui-contact-form label { color: #000; }",
    ".dk-bg .ui-contact-form label { color: #fff; }",
    ".lt-bg .ulk-bg .ui-contact-form label { color: #fff; }",
    ".dk-bg .ulk-bg .ui-contact-form label { color: #000; }",
    "",
  ].join("\n");
}

function collectLimitations(
  cssOutcome: { failedCount: number },
  jsOutcome: { failedCount: number },
  mediaOutcome: DownloadOutcome,
): string[] {
  const out: string[] = [];
  if (cssOutcome.failedCount > 0) {
    out.push(
      `${cssOutcome.failedCount} stylesheet(s) failed to download. Pages may render with missing styles.`,
    );
  }
  if (jsOutcome.failedCount > 0) {
    out.push(
      `${jsOutcome.failedCount} script(s) failed to download. Some interactive components may not work.`,
    );
  }
  if (mediaOutcome.failedCount > 0) {
    const sample = mediaOutcome.results
      .filter((r) => r.status === "failed")
      .slice(0, 5)
      .map((r) => `\`${r.url}\` (${r.error ?? "unknown"})`)
      .join(", ");
    out.push(
      `${mediaOutcome.failedCount} media asset(s) failed to download. Examples: ${sample}.`,
    );
  }
  return out;
}

// Redirection plugin's CSV import expects `source,target,regex,code` with
// a header row. Literal rules emit regex=0. Wildcard rules from Scorpion's
// #SiteRedirectTable (e.g. `/blog/*` → `/our-blog/*`) emit regex=1 with
// the source `*` converted to a greedy capture `(.*)` and the target `*`
// to backreference `$1` — Scorpion treats the wildcard as multi-segment.
// Only the 1*-per-side pairing seen in real Scorpion exports is supported;
// anything else is dropped so a broken rule can't silently 404 visitors.
// code=301 is the permanent-redirect default. Fields containing a comma
// or quote are double-quoted per RFC 4180; embedded quotes are doubled.
function buildRedirectsCsv(redirects: SiteRedirect[]): string {
  const escape = (v: string): string =>
    /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

  const lines: string[] = ["source,target,regex,code"];
  for (const { from, to } of redirects) {
    const fromStars = (from.match(/\*/g) ?? []).length;
    const toStars = (to.match(/\*/g) ?? []).length;

    if (fromStars === 0 && toStars === 0) {
      lines.push(`${escape(from)},${escape(to)},0,301`);
      continue;
    }
    if (fromStars === 1 && toStars === 1) {
      const source = `^${escapeRegexExceptStar(from).replace("*", "(.*)")}$`;
      const target = to.replace("*", "$1");
      lines.push(`${escape(source)},${escape(target)},1,301`);
      continue;
    }
    console.warn(
      `[redirects] skipping unsupported wildcard rule (source ${fromStars}× *, target ${toStars}× *): ${from} -> ${to}`,
    );
  }
  return lines.join("\n") + "\n";
}

// Escape regex metacharacters in a URL path so it can be embedded in a
// regex pattern verbatim. `*` is left alone — the caller substitutes it
// with `(.*)` after escaping.
function escapeRegexExceptStar(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
