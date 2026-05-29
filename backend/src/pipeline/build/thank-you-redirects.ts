import type { ScorpionPage } from "../ingest";

export interface ThankYouRedirects {
  // Map of "host" page path → its direct "thank-you/" child path. Built
  // from the ingest page list — only entries where BOTH paths exist are
  // included so the JS handler can't redirect to a 404.
  perPage: Map<string, string>;
  // Fallback thank-you URL used when the page that hosts the submitted
  // form doesn't have a thank-you child of its own. Prefers
  // /contact-us/thank-you/ then /contact/thank-you/, then the shallowest
  // */thank-you/ page in the ingest, alphabetically broken. null when
  // the site has no thank-you pages at all (handler becomes a no-op).
  fallback: string | null;
}

const THANK_YOU_SUFFIX = "thank-you/";

export function buildThankYouRedirects(
  pages: ScorpionPage[],
): ThankYouRedirects {
  const allPaths = new Set(pages.map((p) => p.path));
  const perPage = new Map<string, string>();

  for (const page of pages) {
    if (!page.path.endsWith("/" + THANK_YOU_SUFFIX)) continue;
    const parent = page.path.slice(0, page.path.length - THANK_YOU_SUFFIX.length);
    if (allPaths.has(parent)) {
      perPage.set(parent, page.path);
    }
  }

  const allThankYou = [...allPaths].filter((p) =>
    p.endsWith("/" + THANK_YOU_SUFFIX),
  );

  let fallback: string | null = null;
  if (allPaths.has("/contact-us/thank-you/")) {
    fallback = "/contact-us/thank-you/";
  } else if (allPaths.has("/contact/thank-you/")) {
    fallback = "/contact/thank-you/";
  } else if (allThankYou.length > 0) {
    fallback = [...allThankYou].sort((a, b) => {
      const da = a.split("/").length;
      const db = b.split("/").length;
      if (da !== db) return da - db;
      return a.localeCompare(b);
    })[0];
  }

  return { perPage, fallback };
}
