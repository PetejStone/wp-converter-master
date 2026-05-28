import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crawlSite } from "../pipeline/crawl";
import { downloadMedia } from "../pipeline/download";
import { ingestWpConverter } from "../pipeline/ingest";
import {
  analyzeForms,
  analyzeNavigation,
  collectAssets,
  collectMedia,
  extractAllContentZones,
  injectTestimonialPanelPlaceholders,
} from "../pipeline/parse";

async function main() {
  const args = process.argv.slice(2);
  const siteUrl = args.find((a) => !a.startsWith("--")) ?? "";
  const shouldDownload = args.includes("--download");
  if (!siteUrl) {
    console.error(
      "Usage: tsx src/scripts/run-extract.ts <site_url> [--download]",
    );
    process.exit(1);
  }

  try {
    console.log(`Ingesting ${siteUrl}…`);
    const ingest = await ingestWpConverter(siteUrl);
    console.log(
      `  pages: ${ingest.pages.length}  content zone IDs: ${ingest.contentZoneIds.size}`,
    );
    if (ingest.contentZoneIds.size === 0) {
      console.log("\nNo content zone IDs registered for this site.");
    }
    if (ingest.pages.length === 0) {
      console.log("\nNo pages to crawl.");
      return;
    }

    console.log(`\nCrawling ${ingest.pages.length} pages…`);
    const crawl = await crawlSite(ingest);
    const crawlSec = (
      (crawl.finishedAt.getTime() - crawl.startedAt.getTime()) /
      1000
    ).toFixed(1);
    console.log(`  done in ${crawlSec}s`);

    const okPages = crawl.pages.filter((p) => p.status === "ok");
    const failedPages = crawl.pages.filter((p) => p.status !== "ok");
    console.log(`  ok: ${okPages.length}  failed: ${failedPages.length}`);
    if (failedPages.length > 0) {
      console.log("\nFailed pages:");
      for (const p of failedPages.slice(0, 10)) {
        const reason = p.error ?? `HTTP ${p.httpStatus ?? "?"}`;
        console.log(`  ${p.status.padEnd(18)} ${p.path}  (${reason})`);
      }
    }

    console.log(`\nExtracting content zones from ${okPages.length} OK pages…`);
    const testimonialPanels = injectTestimonialPanelPlaceholders(
      crawl,
      ingest.testimonials,
    );
    if (testimonialPanels.length > 0) {
      console.log(
        `  testimonial panels detected: ${testimonialPanels.length} (across ${new Set(testimonialPanels.map((p) => p.pagePath)).size} pages)`,
      );
    }
    const extracted = extractAllContentZones(crawl, ingest.contentZoneIds);

    const totalZones = extracted.reduce((n, p) => n + p.zones.length, 0);
    const pagesWithZones = extracted.filter((p) => p.zones.length > 0).length;
    const pagesWithoutZones = extracted.length - pagesWithZones;
    const avg = extracted.length
      ? (totalZones / extracted.length).toFixed(1)
      : "0";

    console.log("\nContent zone summary:");
    console.log(`  registered zone IDs: ${ingest.contentZoneIds.size}`);
    console.log(`  total zone matches:  ${totalZones}`);
    console.log(`  pages with ≥1 zone:  ${pagesWithZones}`);
    console.log(`  pages with 0 zones:  ${pagesWithoutZones}`);
    console.log(`  avg zones per page:  ${avg}`);

    const perZoneCounts = new Map<string, { matches: number; pages: number }>();
    for (const id of ingest.contentZoneIds) {
      perZoneCounts.set(id, { matches: 0, pages: 0 });
    }
    for (const page of extracted) {
      const seenOnThisPage = new Set<string>();
      for (const z of page.zones) {
        const stat = perZoneCounts.get(z.zoneId);
        if (!stat) continue;
        stat.matches++;
        if (!seenOnThisPage.has(z.zoneId)) {
          stat.pages++;
          seenOnThisPage.add(z.zoneId);
        }
      }
    }

    console.log("\nPer-zone-ID counts:");
    const sortedIds = [...perZoneCounts.entries()].sort(
      (a, b) => b[1].matches - a[1].matches,
    );
    for (const [id, stat] of sortedIds) {
      const orphan = stat.matches === 0 ? "  (orphan)" : "";
      console.log(
        `  ${id.padEnd(28)} ${String(stat.matches).padStart(4)} matches on ${String(stat.pages).padStart(3)} pages${orphan}`,
      );
    }

    const firstWithZones = extracted.find((p) => p.zones.length > 0);
    if (firstWithZones) {
      console.log(`\nFirst page detail (path: ${firstWithZones.path}):`);
      console.log(`  zones: ${firstWithZones.zones.length}`);
      for (const z of firstWithZones.zones) {
        console.log(
          `    [${z.index}] ${z.zoneId.padEnd(24)} ${z.innerHtml.length.toLocaleString()} chars`,
        );
      }
      const templateBytes = firstWithZones.template.length;
      console.log(`  template after placeholder replacement: ${templateBytes.toLocaleString()} bytes`);
    }

    const assets = collectAssets(crawl);
    const inlineStyleBytes = assets.inlineStyles.reduce(
      (n, s) => n + s.length,
      0,
    );
    console.log("\nAsset inventory:");
    console.log(`  site hostname:      ${assets.siteHostname}`);
    console.log(`  stylesheets (same): ${assets.stylesheets.length}`);
    console.log(`  scripts (same):     ${assets.scripts.length}`);
    console.log(
      `  inline <style>:     ${assets.inlineStyles.length} unique blocks (${inlineStyleBytes.toLocaleString()} bytes)`,
    );
    console.log(`  stylesheets (3rd):  ${assets.excludedStylesheets.length}`);
    console.log(`  scripts (3rd):      ${assets.excludedScripts.length}`);

    if (assets.stylesheets.length > 0) {
      console.log(`\n  Same-origin stylesheets:`);
      for (const url of assets.stylesheets.slice(0, 15)) console.log(`    ${url}`);
      if (assets.stylesheets.length > 15) {
        console.log(`    …and ${assets.stylesheets.length - 15} more`);
      }
    }
    if (assets.scripts.length > 0) {
      console.log(`\n  Same-origin scripts:`);
      for (const url of assets.scripts.slice(0, 15)) console.log(`    ${url}`);
      if (assets.scripts.length > 15) {
        console.log(`    …and ${assets.scripts.length - 15} more`);
      }
    }
    if (assets.excludedStylesheets.length > 0) {
      console.log(`\n  Third-party stylesheets (excluded):`);
      for (const url of assets.excludedStylesheets.slice(0, 10)) console.log(`    ${url}`);
      if (assets.excludedStylesheets.length > 10) {
        console.log(`    …and ${assets.excludedStylesheets.length - 10} more`);
      }
    }
    if (assets.excludedScripts.length > 0) {
      console.log(`\n  Third-party scripts (excluded):`);
      for (const url of assets.excludedScripts.slice(0, 10)) console.log(`    ${url}`);
      if (assets.excludedScripts.length > 10) {
        console.log(`    …and ${assets.excludedScripts.length - 10} more`);
      }
    }

    const media = collectMedia(crawl);
    const sameTotal =
      media.images.length +
      media.downloadables.length +
      media.backgrounds.length;
    const excludedTotal =
      media.excludedImages.length +
      media.excludedDownloadables.length +
      media.excludedBackgrounds.length;
    console.log("\nMedia inventory:");
    console.log(`  same-origin total:    ${sameTotal}`);
    console.log(`    images:             ${media.images.length}`);
    console.log(`    downloadables:      ${media.downloadables.length}`);
    console.log(`    background-images:  ${media.backgrounds.length}`);
    console.log(`  third-party total:    ${excludedTotal}`);
    console.log(`    images:             ${media.excludedImages.length}`);
    console.log(`    downloadables:      ${media.excludedDownloadables.length}`);
    console.log(`    background-images:  ${media.excludedBackgrounds.length}`);

    if (media.images.length > 0) {
      console.log(`\n  Same-origin images (first 10):`);
      for (const url of media.images.slice(0, 10)) console.log(`    ${url}`);
      if (media.images.length > 10) {
        console.log(`    …and ${media.images.length - 10} more`);
      }
    }
    if (media.downloadables.length > 0) {
      console.log(`\n  Downloadable files:`);
      for (const url of media.downloadables.slice(0, 10)) console.log(`    ${url}`);
      if (media.downloadables.length > 10) {
        console.log(`    …and ${media.downloadables.length - 10} more`);
      }
    }
    if (media.backgrounds.length > 0) {
      console.log(`\n  Background-images (first 10):`);
      for (const url of media.backgrounds.slice(0, 10)) console.log(`    ${url}`);
      if (media.backgrounds.length > 10) {
        console.log(`    …and ${media.backgrounds.length - 10} more`);
      }
    }
    if (media.excludedImages.length > 0) {
      console.log(`\n  Excluded third-party images (first 5):`);
      for (const url of media.excludedImages.slice(0, 5)) console.log(`    ${url}`);
      if (media.excludedImages.length > 5) {
        console.log(`    …and ${media.excludedImages.length - 5} more`);
      }
    }

    if (shouldDownload) {
      const jobId = randomUUID();
      const destDir = join(
        tmpdir(),
        "scorpion-conversions",
        jobId,
        "media",
      );
      console.log(`\nDownloading media → ${destDir}`);
      const t0 = Date.now();
      const outcome = await downloadMedia(media, destDir);
      const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
      const mb = (outcome.totalBytes / 1024 / 1024).toFixed(2);
      console.log(
        `  done in ${elapsedSec}s  ok: ${outcome.okCount}  failed: ${outcome.failedCount}  total: ${mb} MB`,
      );

      const samples = [...outcome.urlMap.entries()].slice(0, 8);
      if (samples.length > 0) {
        console.log("\n  URL rewrite map (first 8):");
        for (const [orig, wp] of samples) {
          console.log(`    ${orig}`);
          console.log(`      → ${wp}`);
        }
        if (outcome.urlMap.size > 8) {
          console.log(`    …and ${outcome.urlMap.size - 8} more`);
        }
      }

      const failures = outcome.results.filter((r) => r.status === "failed");
      if (failures.length > 0) {
        console.log(`\n  Failed downloads:`);
        for (const f of failures.slice(0, 10)) {
          console.log(`    ${f.error?.padEnd(30) ?? "error"} ${f.url}`);
        }
        if (failures.length > 10) {
          console.log(`    …and ${failures.length - 10} more`);
        }
      }
    }

    const formAnalysis = analyzeForms(crawl);
    const totalOccurrences = formAnalysis.variants.reduce(
      (n, v) => n + v.occurrences.length,
      0,
    );

    console.log("\nForm analysis:");
    console.log(`  unique form variants: ${formAnalysis.variants.length}`);
    console.log(`  total occurrences:    ${totalOccurrences}`);
    console.log(`  pages without forms:  ${formAnalysis.pagesWithoutForms.length}`);

    for (let i = 0; i < formAnalysis.variants.length; i++) {
      const v = formAnalysis.variants[i];
      console.log(
        `\n  Variant ${i + 1}: ${v.occurrences.length} occurrences, ${v.fields.length} fields, method=${v.method ?? "-"}`,
      );
      if (v.formIds.length > 0) {
        const idsPreview = v.formIds.slice(0, 5).join(", ");
        const more =
          v.formIds.length > 5 ? `, …+${v.formIds.length - 5}` : "";
        console.log(`    form ids: ${idsPreview}${more}`);
      }
      console.log(`    fields:`);
      for (const f of v.fields.slice(0, 10)) {
        const tagDesc =
          f.tag === "input" ? `input[${f.inputType ?? "?"}]` : f.tag;
        const reqMark = f.required ? " *" : "";
        const labelOrPh = f.label ?? f.placeholder ?? "";
        console.log(`      ${tagDesc.padEnd(14)} ${labelOrPh}${reqMark}`);
      }
      if (v.fields.length > 10) {
        console.log(`      …and ${v.fields.length - 10} more fields`);
      }
      console.log(`    appears on (first 5 pages):`);
      for (const occ of v.occurrences.slice(0, 5)) {
        const idTag = occ.formId ? `  [${occ.formId}]` : "";
        console.log(`      ${occ.path}${idTag}`);
      }
      if (v.occurrences.length > 5) {
        console.log(`      …and ${v.occurrences.length - 5} more`);
      }
    }

    const navAnalysis = analyzeNavigation(crawl);
    console.log("\nNavigation analysis:");
    console.log(`  unique nav variants: ${navAnalysis.variants.length}`);
    console.log(`  pages without nav:   ${navAnalysis.pagesWithoutNav.length}`);

    if (navAnalysis.variants.length === 1) {
      const only = navAnalysis.variants[0];
      console.log(
        `  → all ${only.pages.length} pages share one nav (${only.items.length} items) — global menu`,
      );
    } else if (navAnalysis.variants.length > 1) {
      console.log(
        `  → variations detected — review wizard required to pick primary menu`,
      );
    }

    for (let i = 0; i < navAnalysis.variants.length; i++) {
      const v = navAnalysis.variants[i];
      console.log(
        `\n  Variant ${i + 1}: ${v.pages.length} pages, ${v.items.length} items`,
      );
      console.log(`    pages (first 5):`);
      for (const p of v.pages.slice(0, 5)) {
        console.log(`      ${p.path}`);
      }
      if (v.pages.length > 5) {
        console.log(`      …and ${v.pages.length - 5} more`);
      }
      console.log(`    items (first 15):`);
      for (const item of v.items.slice(0, 15)) {
        const indent = "  ".repeat(item.depth);
        console.log(`      ${indent}• ${item.text || "(empty)"} → ${item.href}`);
      }
      if (v.items.length > 15) {
        console.log(`      …and ${v.items.length - 15} more items`);
      }
    }

    if (navAnalysis.pagesWithoutNav.length > 0) {
      console.log(`\n  Pages without <nav>:`);
      for (const p of navAnalysis.pagesWithoutNav.slice(0, 10)) {
        console.log(`    ${p.path}`);
      }
      if (navAnalysis.pagesWithoutNav.length > 10) {
        console.log(
          `    …and ${navAnalysis.pagesWithoutNav.length - 10} more`,
        );
      }
    }
  } catch (err) {
    console.error("Extract failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
