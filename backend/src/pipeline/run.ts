import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateJob, type JobPatch, type JobRecord } from "../db/job-store";
import { publishJobUpdate } from "../queue/events";
import { buildWpPackage } from "./build";
import { crawlSite } from "./crawl";
import { ingestWpConverter } from "./ingest";
import {
  analyzeForms,
  analyzeNavigation,
  collectAssets,
  collectMedia,
  extractAllContentZones,
  injectTestimonialPanelPlaceholders,
} from "./parse";

export interface RunConversionInput {
  jobId: string;
  siteUrl: string;
  siteTitle: string;
}

export interface RunConversionOutput {
  zipPath: string;
  zipByteSize: number;
  pageCount: number;
  zoneCount: number;
}

// Wraps updateJob() so every stage transition is mirrored onto the in-process
// JobEventBus that the WebSocket route subscribes to.
async function transition(
  jobId: string,
  patch: JobPatch,
): Promise<JobRecord> {
  const row = await updateJob(jobId, patch);
  publishJobUpdate(row);
  return row;
}

// Single orchestration of the conversion pipeline. Writes stage transitions
// to the `jobs` row as it progresses. Throws on any stage failure — the
// caller (the BullMQ worker) is responsible for marking the row failed on
// the final retry.
export async function runConversion(
  input: RunConversionInput,
): Promise<RunConversionOutput> {
  const { jobId, siteUrl, siteTitle } = input;

  await transition(jobId, { status: "ingest" });
  const ingest = await ingestWpConverter(siteUrl);

  await transition(jobId, { status: "crawl" });
  const crawl = await crawlSite(ingest);

  await transition(jobId, { status: "parse" });
  const assets = collectAssets(crawl);
  const media = collectMedia(crawl);
  // Inject testimonial-panel placeholders BEFORE content-zone extraction
  // so the comment ends up inside whichever container the panel lived
  // in — page-template HTML or a content zone's inner HTML — without
  // panel detection needing to know which. The build step substitutes
  // the placeholders for shortcode calls.
  const testimonialPanels = injectTestimonialPanelPlaceholders(
    crawl,
    ingest.testimonials,
  );
  const contentZones = extractAllContentZones(crawl, ingest.contentZoneIds);
  const formAnalysis = analyzeForms(crawl);
  const navAnalysis = analyzeNavigation(crawl);

  await transition(jobId, { status: "build" });
  const jobRootDir = join(tmpdir(), "scorpion-conversions", jobId);
  const buildOutput = await buildWpPackage({
    jobRootDir,
    siteUrl: ingest.siteUrl,
    siteTitle,
    ingest,
    crawl,
    assets,
    media,
    contentZones,
    formAnalysis,
    navAnalysis,
    testimonialPanelCount: testimonialPanels.length,
  });

  await transition(jobId, {
    status: "ready",
    outputPath: buildOutput.zipPath,
    completedAt: new Date(),
  });

  return {
    zipPath: buildOutput.zipPath,
    zipByteSize: buildOutput.zipByteSize,
    pageCount: buildOutput.pageCount,
    zoneCount: buildOutput.zoneCount,
  };
}
