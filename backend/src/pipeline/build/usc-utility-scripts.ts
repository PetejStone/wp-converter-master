import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Matches "/common/usc/p/<name>.<ext>" inside JS source. Scorpion's USC
// framework dynamically loads helper scripts via require2() against this
// hardcoded path; the references are baked into bundle JS strings, so the
// path needs both rewriting (so existing files resolve) and discovery (so
// runtime-only references that the crawler never saw still get downloaded).
const USC_PATH_RE = /\/common\/usc\/p\/([a-zA-Z0-9._-]+\.(?:js|html|css))/g;
const USC_PATH_PREFIX = "/common/usc/p/";

export interface UscUtilityScriptOptions {
  siteUrl: string;
  jsDir: string;
  // WP path that JS files are served from in the converted theme, e.g.
  // "/wp-content/themes/scorpion-converted/js". Used both as the literal
  // path that replaces "/common/usc/p/" inside downloaded JS, and as the
  // wpPath value recorded in the urlMap for newly-downloaded files.
  jsWpPathPrefix: string;
  // URL → filename for the JS bundles that have already been downloaded.
  // Used as the starting set so we don't re-fetch files Scorpion already
  // included in a page's static <script> tags.
  jsFilenameByUrl: Map<string, string>;
}

export interface UscUtilityScriptResult {
  // Newly-downloaded URL → on-disk filename. Caller merges into the global
  // jsFilenameByUrl + urlMap so per-page enqueue + HTML rewriting see them.
  newlyDownloaded: Map<string, string>;
  // Filenames of the JS files whose contents were rewritten (the existing
  // bundles plus any newly downloaded utility scripts).
  rewrittenFilenames: string[];
  // Names referenced inside JS that we tried but failed to download. Empty
  // when everything resolved.
  failedDownloads: { url: string; error: string }[];
}

// Discover and fetch Scorpion's runtime-loaded utility scripts.
//
// Operates in two phases:
//   1. Scan every JS file already in `jsDir` for `/common/usc/p/<name>.js`
//      occurrences. The set of unique basenames is the runtime dependency
//      list — these are the scripts Scorpion will require2() at runtime.
//   2. For each referenced basename that we don't already have a local
//      copy of, fetch it from `<siteUrl>/common/usc/p/<name>.js` and save
//      under `jsDir/<name>.js`. (index.ts then copies every jsDir file into
//      the export's `common/usc/p/` directory, and functions.php serves
//      `/common/usc/p/<name>.js` from the theme — so the path resolves on
//      the WP host.)
//
// IMPORTANT: we deliberately do NOT rewrite the "/common/usc/p/" prefix
// inside the JS to the theme path. Scorpion's require2() module loader only
// recognises `usc/p/<name>` and `/common/usc/p/<name>.js` as fetchable
// module locations; any other path (e.g. /wp-content/themes/.../js/<name>.js)
// is treated as an already-satisfied module, so the loader fires the
// dependency callback WITHOUT ever loading the file. Rewriting therefore
// silently breaks every runtime-loaded utility — most visibly the tabbable
// subsystem (mobile drawer + desktop fly-out menus), whose
// passive-tabbable-init.js never executes and leaves USC.tabbable undefined.
// Leaving the path as `/common/usc/p/` lets the loader fetch it correctly
// (verified: all five tabbable modules load 200 and USC.tabbable is defined).
export async function discoverAndRewriteUscUtilityScripts(
  options: UscUtilityScriptOptions,
): Promise<UscUtilityScriptResult> {
  // jsWpPathPrefix is intentionally unused now — see the no-rewrite note above.
  const { siteUrl, jsDir, jsFilenameByUrl } = options;
  const newlyDownloaded = new Map<string, string>();
  const failedDownloads: { url: string; error: string }[] = [];

  // Filenames we already have on disk (from the main JS download pass).
  // Newly fetched utility files are appended as we go so two references
  // to the same script don't redownload.
  const haveFilename = new Set<string>();
  for (const filename of jsFilenameByUrl.values()) {
    haveFilename.add(filename.toLowerCase());
  }

  // ---- Phase 1: scan every JS file for /common/usc/p/ references ----
  const jsFiles = (await readdir(jsDir)).filter((f) =>
    f.toLowerCase().endsWith(".js"),
  );
  const referencedBasenames = new Set<string>();
  const fileContents = new Map<string, string>();
  for (const filename of jsFiles) {
    const filePath = join(jsDir, filename);
    const content = await readFile(filePath, "utf8");
    fileContents.set(filename, content);
    for (const match of content.matchAll(USC_PATH_RE)) {
      const ref = match[1];
      if (ref.toLowerCase().endsWith(".js")) {
        referencedBasenames.add(ref);
      }
    }
  }

  // ---- Phase 2: download any referenced .js we don't already have ----
  const baseOrigin = new URL(siteUrl).origin;
  for (const basename of referencedBasenames) {
    if (haveFilename.has(basename.toLowerCase())) continue;
    const url = `${baseOrigin}${USC_PATH_PREFIX}${basename}`;
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "ScorpionWPConverter/0.1 (+https://scorpion.co; conversion-tool)",
        },
        redirect: "follow",
      });
      if (!response.ok) {
        failedDownloads.push({ url, error: `HTTP ${response.status}` });
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const destPath = join(jsDir, basename);
      await writeFile(destPath, buffer);
      newlyDownloaded.set(url, basename);
      haveFilename.add(basename.toLowerCase());

      // Load into fileContents so phase 3 picks it up too — newly fetched
      // utility scripts can reference further utility scripts.
      fileContents.set(basename, buffer.toString("utf8"));
    } catch (err) {
      failedDownloads.push({
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // NOTE: no rewrite phase. The "/common/usc/p/" references are left intact
  // so Scorpion's require2() loader resolves and fetches them (see the
  // function-level comment above). `rewrittenFilenames` stays empty; it's
  // retained on the result for API compatibility.
  return { newlyDownloaded, rewrittenFilenames: [], failedDownloads };
}
