/// <reference lib="dom" />
import { TimeoutError, type BrowserContext } from "puppeteer";
import type { CrawledPage } from "./types";

export const DEFAULT_PAGE_TIMEOUT_MS = 30_000;

interface InPageExtraction {
  stylesheetUrls: string[];
  scriptUrls: string[];
  imageUrls: string[];
  inlineStyles: string[];
  navHtml: string | null;
}

export async function crawlPage(
  context: BrowserContext,
  pageUrl: string,
  path: string,
  timeoutMs: number = DEFAULT_PAGE_TIMEOUT_MS,
): Promise<CrawledPage> {
  const start = Date.now();
  const page = await context.newPage();

  // Capture stylesheet / script URLs from network responses *as they happen*,
  // not from the post-load DOM. Scorpion's USC framework inlines bundle CSS
  // into <style> blocks at runtime and then removes the original
  // <link rel="stylesheet"> element. Under concurrent crawl pressure the
  // element is often gone by the time we'd query the DOM, so DOM-only
  // extraction returns nothing. Response events fire when the browser
  // requests the resource — they survive any later DOM mutation.
  const networkStylesheetUrls: string[] = [];
  const networkScriptUrls: string[] = [];
  const seenStylesheets = new Set<string>();
  const seenScripts = new Set<string>();
  page.on("response", (response) => {
    const status = response.status();
    if (status < 200 || status >= 400) return;
    const url = response.url();
    const ct = (response.headers()["content-type"] ?? "").toLowerCase();
    if (ct.includes("text/css")) {
      if (!seenStylesheets.has(url)) {
        seenStylesheets.add(url);
        networkStylesheetUrls.push(url);
      }
    } else if (
      ct.includes("javascript") ||
      ct.includes("ecmascript") ||
      ct.includes("application/x-javascript")
    ) {
      if (!seenScripts.has(url)) {
        seenScripts.add(url);
        networkScriptUrls.push(url);
      }
    }
  });

  try {
    const response = await page.goto(pageUrl, {
      waitUntil: "networkidle2",
      timeout: timeoutMs,
    });

    if (!response) {
      return {
        pageUrl,
        path,
        status: "navigation_error",
        error: "No response from navigation",
        durationMs: Date.now() - start,
      };
    }

    const httpStatus = response.status();
    if (httpStatus < 200 || httpStatus >= 300) {
      return {
        pageUrl,
        path,
        status: "non_200",
        httpStatus,
        durationMs: Date.now() - start,
      };
    }

    const fullHtml = await page.content();
    const extracted = await page.evaluate(extractInPage);

    // Prefer the DOM-extracted order (authored cascade order) but fall back
    // to network-captured URLs so we don't miss bundles whose <link> was
    // removed before extraction. Items found only in the network log are
    // appended at the end in request order.
    const stylesheetUrls = mergeOrdered(
      extracted.stylesheetUrls,
      networkStylesheetUrls,
    );
    const scriptUrls = mergeOrdered(extracted.scriptUrls, networkScriptUrls);

    return {
      pageUrl,
      path,
      status: "ok",
      httpStatus,
      durationMs: Date.now() - start,
      fullHtml,
      stylesheetUrls,
      scriptUrls,
      imageUrls: extracted.imageUrls,
      inlineStyles: extracted.inlineStyles,
      navHtml: extracted.navHtml,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      pageUrl,
      path,
      status: err instanceof TimeoutError ? "timeout" : "navigation_error",
      error: message,
      durationMs: Date.now() - start,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

function mergeOrdered(primary: string[], fallback: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const url of primary) {
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  for (const url of fallback) {
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

// Runs inside the browser page context — must be self-contained.
// `document`, `HTMLLinkElement`, etc. resolve in the browser, not in Node.
function extractInPage(): InPageExtraction {
  // Match <link rel="stylesheet"> anywhere in the document — Scorpion's
  // main CSS bundle is rendered into <body>, not <head>.
  const stylesheetUrls = Array.from(
    document.querySelectorAll('link[rel="stylesheet"][href]'),
  ).map((el) => (el as HTMLLinkElement).href);

  const scriptUrls = Array.from(
    document.querySelectorAll("script[src]"),
  ).map((el) => (el as HTMLScriptElement).src);

  const inlineStyles: string[] = [];
  document.querySelectorAll("style").forEach((style) => {
    const content = style.textContent ?? "";
    if (content.length > 0) inlineStyles.push(content);
  });

  const imageUrls: string[] = [];
  document.querySelectorAll("img").forEach((img) => {
    if (img.src) imageUrls.push(img.src);
    if (img.srcset) {
      img.srcset.split(",").forEach((part) => {
        const url = part.trim().split(/\s+/)[0];
        if (url) imageUrls.push(url);
      });
    }
  });

  // Capture the desktop primary menu. Scorpion (following the ARIA pattern)
  // marks the desktop menu's root <ul> with role="menubar", and its nested
  // role="menu" <ul>s hold the flyout sub-items — so the menubar subtree IS
  // the complete hierarchical menu, and nothing else. We grab that subtree's
  // outerHTML directly rather than the enclosing <nav>, because after JS
  // hydration the <nav> ALSO contains the mobile drawer (a flattened
  // duplicate of the menu interleaved with "Main Menu" section-header links)
  // and the header's social / phone / maps links. Selecting the <nav> — or
  // the nav with the most <a>, the old heuristic — swept all of that into the
  // WordPress menu (e.g. 58 polluted items vs the real 23). Pick the richest
  // menubar if a page has several. Only when no menubar exists at all do we
  // fall back to the largest <nav>'s inner HTML (non-Scorpion / atypical
  // markup) so non-USC pages still get a best-effort nav.
  const menubars = Array.from(document.querySelectorAll('[role="menubar"]'));
  let navHtml: string | null = null;
  if (menubars.length > 0) {
    let bestMenubar = menubars[0];
    let bestMenubarLinks = -1;
    for (const mb of menubars) {
      const count = mb.querySelectorAll("a").length;
      if (count > bestMenubarLinks) {
        bestMenubarLinks = count;
        bestMenubar = mb;
      }
    }
    navHtml = bestMenubar.outerHTML;
  } else {
    const navs = Array.from(document.querySelectorAll("nav"));
    let primaryNav: Element | null = null;
    let maxLinks = -1;
    for (const nav of navs) {
      const count = nav.querySelectorAll("a").length;
      if (count > maxLinks) {
        maxLinks = count;
        primaryNav = nav;
      }
    }
    navHtml = primaryNav ? primaryNav.innerHTML : null;
  }

  return {
    stylesheetUrls,
    scriptUrls,
    imageUrls,
    inlineStyles,
    navHtml,
  };
}
