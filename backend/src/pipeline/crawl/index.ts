import puppeteer from "puppeteer";
import type { IngestResult } from "../ingest";
import { crawlPage, DEFAULT_PAGE_TIMEOUT_MS } from "./crawl-page";
import type { CrawlOptions, CrawlResult, CrawledPage } from "./types";

const DEFAULT_CONCURRENCY = 4;

export async function crawlSite(
  ingest: IngestResult,
  options: CrawlOptions = {},
): Promise<CrawlResult> {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const timeoutMs = options.perPageTimeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;
  const startedAt = new Date();

  if (ingest.pages.length === 0) {
    return {
      siteUrl: ingest.siteUrl,
      pages: [],
      startedAt,
      finishedAt: new Date(),
    };
  }

  // `--no-sandbox` is required when running as root inside the dev
  // Docker container (the puppeteer base image runs as root). It's a no-op
  // on host runs where the OS user already isn't root. The other flags
  // shrink Chromium's footprint inside the container.
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
  try {
    const indexed = ingest.pages.map((page, index) => ({ page, index }));
    const results: CrawledPage[] = new Array(ingest.pages.length);
    let next = 0;

    // Each worker gets its own isolated browser context. Puppeteer's network
    // event listeners interfere across parallel pages in a shared context —
    // CSS / JS response events go missing on some pages — so per-worker
    // contexts are required for per-page resource capture to be reliable.
    // Pages within a single worker run serially, so they don't interfere
    // with each other.
    async function worker(): Promise<void> {
      const context = await browser.createBrowserContext();
      try {
        while (true) {
          const cursor = next++;
          if (cursor >= indexed.length) return;
          const { page, index } = indexed[cursor];
          results[index] = await crawlPage(
            context,
            page.canonical,
            page.path,
            timeoutMs,
          );
        }
      } finally {
        await context.close();
      }
    }

    const workerCount = Math.min(concurrency, indexed.length);
    await Promise.all(
      Array.from({ length: workerCount }, () => worker()),
    );

    return {
      siteUrl: ingest.siteUrl,
      pages: results,
      startedAt,
      finishedAt: new Date(),
    };
  } finally {
    await browser.close();
  }
}

export type {
  CrawledPage,
  CrawlResult,
  CrawlOptions,
  CrawlPageStatus,
} from "./types";
