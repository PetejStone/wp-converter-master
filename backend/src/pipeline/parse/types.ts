export interface ExtractedZone {
  zoneId: string;
  index: number;
  innerHtml: string;
}

export interface PageContentZones {
  pageUrl: string;
  path: string;
  zones: ExtractedZone[];
  template: string;
  // Inner HTML of the first `<article class="cnt-stl">` we find on the
  // page. Scorpion uses this element as the "body content" container,
  // especially for blog posts where the article body has no matching id
  // in SiteContentIdsTable and the zone extractor would otherwise miss it.
  // For pages that don't use `.cnt-stl`, this is the empty string.
  bodyHtml: string;
}
