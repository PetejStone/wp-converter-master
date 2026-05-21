import * as cheerio from "cheerio";

export function rewriteHtmlUrls(
  html: string,
  pageUrl: string,
  urlMap: Map<string, string>,
): string {
  // isDocument=false so fragments (content-zone inner HTML) don't get
  // auto-wrapped in <html><head></head><body>. Full documents are still
  // preserved because their existing wrapper tags are kept as-is.
  // (Note: we used to early-return when urlMap was empty, but the
  // blog-date-prefix collapse below runs unconditionally too.)
  const $ = cheerio.load(html, null, false);

  $("img, source, audio, video, iframe, embed, script").each((_, el) => {
    rewriteAttr($(el), "src", pageUrl, urlMap);
  });
  // Scorpion uses `data-src` / `data-srcset` for lazy-load — the real URL
  // lives in those attrs and the JS swaps them into src/srcset at runtime.
  // Rewrite them too so downloaded assets resolve when the page loads.
  $("img[data-src], source[data-src]").each((_, el) => {
    rewriteAttr($(el), "data-src", pageUrl, urlMap);
  });
  $("a, link").each((_, el) => {
    rewriteAttr($(el), "href", pageUrl, urlMap);
    // Collapse Scorpion blog-post URLs to WP's /%postname%/ permalink.
    // Scorpion serves articles at /<blog-root>/YYYY/<monthname>/<slug>/
    // but the wordpress-importer + our rewrite structure put them at
    // /<slug>/, so any internal href to the dated path 404s. Strip the
    // date prefix at build time so the link resolves directly.
    collapseBlogPermalink($(el), "href");
  });
  $("object[data]").each((_, el) => {
    rewriteAttr($(el), "data", pageUrl, urlMap);
  });
  $("img[srcset], source[srcset]").each((_, el) => {
    const $el = $(el);
    const srcset = $el.attr("srcset");
    if (!srcset) return;
    const rewritten = rewriteSrcset(srcset, pageUrl, urlMap);
    if (rewritten !== srcset) $el.attr("srcset", rewritten);
  });
  $("img[data-srcset], source[data-srcset]").each((_, el) => {
    const $el = $(el);
    const srcset = $el.attr("data-srcset");
    if (!srcset) return;
    const rewritten = rewriteSrcset(srcset, pageUrl, urlMap);
    if (rewritten !== srcset) $el.attr("data-srcset", rewritten);
  });
  $("[style*='url(']").each((_, el) => {
    const $el = $(el);
    const style = $el.attr("style") ?? "";
    const rewritten = rewriteCssUrls(style, pageUrl, urlMap);
    if (rewritten !== style) $el.attr("style", rewritten);
  });

  return $.html();
}

export function rewriteSrcset(
  srcset: string,
  baseUrl: string,
  urlMap: Map<string, string>,
): string {
  if (srcset.includes("data:")) return srcset;
  return srcset
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return trimmed;
      const [url, ...descriptor] = trimmed.split(/\s+/);
      const abs = resolveAbsolute(url, baseUrl);
      const newUrl = abs && urlMap.has(abs) ? urlMap.get(abs)! : url;
      return descriptor.length > 0
        ? `${newUrl} ${descriptor.join(" ")}`
        : newUrl;
    })
    .join(", ");
}

export function rewriteCssUrls(
  css: string,
  baseUrl: string,
  urlMap: Map<string, string>,
): string {
  return css.replace(
    /url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g,
    (match, quote: string, urlVal: string) => {
      if (!urlVal || urlVal.startsWith("data:")) return match;
      const abs = resolveAbsolute(urlVal, baseUrl);
      if (abs && urlMap.has(abs)) {
        return `url(${quote}${urlMap.get(abs)}${quote})`;
      }
      return match;
    },
  );
}

function rewriteAttr(
  $el: cheerio.Cheerio<any>,
  attr: string,
  pageUrl: string,
  urlMap: Map<string, string>,
): void {
  const val = $el.attr(attr);
  if (!val) return;
  const abs = resolveAbsolute(val, pageUrl);
  if (abs && urlMap.has(abs)) {
    $el.attr(attr, urlMap.get(abs)!);
  }
}

// Matches Scorpion's dated blog-post URL shape (root-relative or
// absolute): `/(our-blog|blog|news)/YYYY/<monthname>/<slug>/`. The slug
// segment is captured. Optional trailing slash; optional ?query / #hash
// follow on the original URL and are preserved by `collapseBlogPermalink`.
// Blog *index* / category paths like `/our-blog/` or `/our-blog/categories/`
// don't match — they lack the year + month segments.
const BLOG_DATED_PATH_RE =
  /^(?:https?:\/\/[^/]+)?\/(?:our-blog|blog|news)\/\d{4}\/[a-z]+\/([a-z0-9_-]+)\/?(?:[?#].*)?$/i;

function collapseBlogPermalink(
  $el: cheerio.Cheerio<any>,
  attr: string,
): void {
  const val = $el.attr(attr);
  if (!val) return;
  const m = BLOG_DATED_PATH_RE.exec(val);
  if (!m) return;
  const slug = m[1];
  // Preserve query / hash if present.
  const tailIdx = val.search(/[?#]/);
  const tail = tailIdx >= 0 ? val.slice(tailIdx) : "";
  $el.attr(attr, `/${slug}/${tail}`);
}

function resolveAbsolute(href: string, baseUrl: string): string | null {
  if (
    !href ||
    href.startsWith("data:") ||
    href.startsWith("#") ||
    href.startsWith("javascript:") ||
    href.startsWith("mailto:") ||
    href.startsWith("tel:")
  ) {
    return null;
  }
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}
