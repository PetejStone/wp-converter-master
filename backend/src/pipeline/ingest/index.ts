import { fetchWpConverterHtml } from "./fetch";
import { parseWpConverter } from "./parse";
import type { IngestResult } from "./types";

export async function ingestWpConverter(
  siteUrl: string,
): Promise<IngestResult> {
  const normalized = new URL(siteUrl).origin;
  const html = await fetchWpConverterHtml(normalized);
  const { pages, contentZoneIds, iconMap, redirects } = parseWpConverter(
    html,
    normalized,
  );
  return {
    siteUrl: normalized,
    pages,
    contentZoneIds,
    iconMap,
    redirects,
  };
}

export type { IngestResult, ScorpionPage, SiteRedirect } from "./types";
export type { IngestFetchCategory } from "./errors";
export { IngestError, IngestFetchError, IngestParseError } from "./errors";
