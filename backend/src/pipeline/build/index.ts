import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { buildPageHierarchy } from "./hierarchy";
import { stripBlockedDomainsFromJs } from "./strip-blocked-domains";
import { buildPageTemplates, buildSinglePostTemplate } from "./templates";
import {
  buildFunctionsPhp,
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

  // Build the hierarchy now so per-page inline CSS files can be named after
  // each page's templateSlug — that's the same key the enqueue logic uses
  // at request time.
  const pageTitleByPath = new Map(
    inputs.ingest.pages.map((p) => [p.path, p.title]),
  );
  const hierarchy = buildPageHierarchy(inputs.ingest.pages);

  // Many pages share a templateSlug now (one per unique Scorpion Template
  // value). Pick the lowest-postId non-blog page in each group as the
  // exemplar — its inline styles and asset deps become the template's.
  const exemplarByTemplateSlug = new Map<string, typeof hierarchy.nodes[0]>();
  for (const node of hierarchy.nodes) {
    if (node.isBlogPost) continue;
    const existing = exemplarByTemplateSlug.get(node.templateSlug);
    if (!existing || node.postId < existing.postId) {
      exemplarByTemplateSlug.set(node.templateSlug, node);
    }
  }

  // Per-template inline <style> blocks are written to inline-<slug>.css
  // so each template only loads its exemplar's tokens. Pages in the same
  // group inherit those (the alternative — generate per-page inline CSS —
  // would defeat the consolidation goal).
  const inlineFilenameBySlug = new Map<string, string>();
  for (const [slug, node] of exemplarByTemplateSlug) {
    const path = node.page.path;
    const indices = inputs.assets.pageInlineStyleIndices.get(path) ?? [];
    if (indices.length === 0) continue;
    const inlineCss = indices
      .map((idx, i) => {
        const block = inputs.assets.inlineStyles[idx] ?? "";
        return `/* === inline block ${i + 1} === */\n${block}`;
      })
      .join("\n\n");
    const rewritten = rewriteCssUrls(inlineCss, inputs.siteUrl, urlMap);
    const filename = `inline-${slug}.css`;
    await writeFile(join(cssDir, filename), rewritten);
    inlineFilenameBySlug.set(slug, filename);
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
  // Per-template inline CSS files are part of the registered stylesheet
  // handle set so the enqueue logic can reference them.
  for (const filename of inlineFilenameBySlug.values()) {
    cssFilenames.push(filename);
  }
  cssFilenames.push(cf7OverridesFilename);
  const jsFilenames: string[] = [];
  for (const r of jsOutcome.results) {
    if (r.status === "ok" && r.filename) jsFilenames.push(r.filename);
  }

  // Slug → ordered list of CSS / JS filenames the exemplar's Scorpion
  // page loaded, in document order. Per-template inline file goes FIRST so
  // the downloaded bundles cascade over it (matches the original site
  // where <style> blocks live in <head> and the main bundle renders into
  // <body>, making the bundle authoritative on any selector they both
  // touch — reversing causes :root token fights).
  const cssFilenamesByTemplateSlug = new Map<string, string[]>();
  const jsFilenamesByTemplateSlug = new Map<string, string[]>();
  for (const [slug, node] of exemplarByTemplateSlug) {
    const path = node.page.path;

    const cssForPage: string[] = [];
    const inlineFile = inlineFilenameBySlug.get(slug);
    if (inlineFile) cssForPage.push(inlineFile);
    const cssUrls = inputs.assets.pageStylesheets.get(path) ?? [];
    for (const url of cssUrls) {
      const filename = cssFilenameByUrl.get(url);
      if (filename) cssForPage.push(filename);
    }
    // CF7 overrides go last so they win on equal-specificity selectors.
    cssForPage.push(cf7OverridesFilename);
    cssFilenamesByTemplateSlug.set(slug, cssForPage);

    const jsUrls = inputs.assets.pageScripts.get(path) ?? [];
    const jsForPage: string[] = [];
    for (const url of jsUrls) {
      const filename = jsFilenameByUrl.get(url);
      if (filename) jsForPage.push(filename);
    }
    jsFilenamesByTemplateSlug.set(slug, jsForPage);
  }

  await writeFile(
    join(themeDir, "style.css"),
    buildStyleCss(inputs.siteTitle),
  );
  // Pick the dominant Scorpion template among blog posts — single.php
  // uses that template's chrome + asset bundle. Falls back to null when
  // the site has no blog posts.
  const blogTemplateCounts = new Map<string, number>();
  for (const node of hierarchy.nodes) {
    if (!node.isBlogPost) continue;
    blogTemplateCounts.set(
      node.templateSlug,
      (blogTemplateCounts.get(node.templateSlug) ?? 0) + 1,
    );
  }
  let postTemplateSlug: string | null = null;
  let bestCount = 0;
  for (const [slug, count] of blogTemplateCounts) {
    if (count > bestCount) {
      bestCount = count;
      postTemplateSlug = slug;
    }
  }

  await writeFile(
    join(themeDir, "functions.php"),
    buildFunctionsPhp({
      siteTitle: inputs.siteTitle,
      cssFilenames,
      jsFilenames,
      perPage: {
        cssFilenamesByTemplateSlug,
        jsFilenamesByTemplateSlug,
      },
      postTemplateSlug,
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

  // CF7 forms: allocate post_ids after pages + nav menu items so they
  // don't collide. The dominant nav variant claims hierarchy.maxPostId + 1
  // .. + items.length inside wxr.ts; CF7 posts start after that.
  const dominantNav = inputs.navAnalysis?.variants[0];
  const navItemCount = dominantNav?.items.length ?? 0;
  const cf7BasePostId = hierarchy.maxPostId + navItemCount + 1;
  const cf7Forms: Cf7Form[] = buildCf7Forms({
    variants: inputs.formAnalysis.variants,
    basePostId: cf7BasePostId,
    siteTitle: inputs.siteTitle,
  });
  const formIdToCf7Lookup = new Map<string, { postId: number; title: string }>();
  for (const cf7 of cf7Forms) {
    const variant = inputs.formAnalysis.variants.find(
      (v) => v.fingerprint === cf7.fingerprint,
    );
    if (!variant) continue;
    for (const fid of variant.formIds) {
      formIdToCf7Lookup.set(fid, { postId: cf7.postId, title: cf7.title });
    }
  }

  const { templates } = buildPageTemplates(
    inputs.contentZones,
    hierarchy,
    pageTitleByPath,
    urlMap,
    iconMap,
    formIdToCf7Lookup,
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
    formIdToCf7Lookup,
  );
  if (singleTemplate) {
    await writeFile(join(themeDir, "single.php"), singleTemplate.content);
  }

  const wxr = buildWxrXml({
    siteUrl: inputs.siteUrl,
    siteTitle: inputs.siteTitle,
    hierarchy,
    contentZones: inputs.contentZones,
    urlMap,
    iconMap,
    navAnalysis: inputs.navAnalysis,
    cf7Forms,
  });
  await writeFile(join(outputDir, "import.xml"), wxr);

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
      knownLimitations: limitations,
    }),
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
    "}",
    "",
    "/* Textareas — same look, height 80% of containing box. */",
    ".ui-contact-form textarea.wpcf7-form-control {",
    "  padding: 0.5rem 0.75rem;",
    "  box-sizing: border-box;",
    "  width: 100%;",
    "  height: 80%;",
    "  background-color: #fff;",
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
// a header row. regex=0 forces literal URL matching; code=301 is the
// permanent-redirect default. Fields that contain a comma or quote are
// double-quoted per RFC 4180; embedded quotes are doubled.
function buildRedirectsCsv(redirects: SiteRedirect[]): string {
  const escape = (v: string): string =>
    /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

  const lines: string[] = ["source,target,regex,code"];
  for (const { from, to } of redirects) {
    lines.push(`${escape(from)},${escape(to)},0,301`);
  }
  return lines.join("\n") + "\n";
}
