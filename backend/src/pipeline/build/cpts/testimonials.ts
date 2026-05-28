// Testimonials CPT — schema + CPT UI definition. The single source of truth
// for how testimonial fields are emitted to WXR postmeta AND surfaced in the
// purpose-built admin metabox in functions.php. See DECISIONS.md → "CPT
// field editability" for the rationale.

import type { Testimonial } from "../../ingest";
import type { CptMetaboxSpec } from "../cpt-metabox";
import type { CptUiPostType } from "../cpt-ui-export";

export const TESTIMONIAL_POST_TYPE = "scorpion_testimonial";

// CptMetaField is the per-CPT field schema. selector() pulls the source value
// off the parsed entity at WXR build time; the rest of the entry feeds the
// generated metabox PHP. Selector is generic over the entity type so each
// system declares its own without losing type safety.
export interface CptMetaField<T> {
  metaKey: string;
  label: string;
  // Metabox input shape:
  //  - text/date/number → single-line <input type="…">
  //  - textarea         → multi-line <textarea> (preserves newlines)
  //  - wp_editor        → WP's TinyMCE rich-text editor (Visual + Text tabs)
  // Use 'date' only when the selector returns a YYYY-MM-DD string —
  // browsers ignore values that don't match the HTML5 date format. The
  // toIsoDate() helper below normalizes Scorpion's freeform review-date
  // cell ("12/25/2024", "December 25, 2024", …) into that shape.
  inputType: "text" | "date" | "number" | "textarea" | "wp_editor";
  // Read-only fields render `readonly` in the metabox AND are always emitted
  // to WXR (no skip-when-empty). Used for join keys that anchor re-import
  // idempotency — the Scorpion ID here is the join for the
  // [scorpion_testimonials] shortcode's meta_query.
  readOnly?: boolean;
  selector: (entity: T) => string;
}

// Normalize Scorpion's freeform review-date strings (e.g. "12/25/2024",
// "December 25, 2024") into YYYY-MM-DD so the metabox's type="date" picker
// can render them. Falls back to the trimmed original when Date.parse can't
// interpret it — the date picker then shows blank but the original string
// is still preserved in postmeta, so re-import doesn't silently destroy it.
function toIsoDate(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return trimmed;
  const d = new Date(parsed);
  if (Number.isNaN(d.getTime())) return trimmed;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Every editable field for the Testimonial CPT. Order here is the visual
// order in the admin metabox. Caption + body moved out of post_excerpt /
// post_content (where they previously lived) into postmeta so admins edit
// every field in one consistent surface — see the CPT UI definition below
// where 'editor' and 'excerpt' are dropped from `supports`.
export const TESTIMONIAL_META_FIELDS: ReadonlyArray<CptMetaField<Testimonial>> = [
  {
    metaKey: "_testimonial_scorpion_id",
    label: "Scorpion ID",
    inputType: "text",
    readOnly: true,
    selector: (t) => t.reviewId,
  },
  {
    metaKey: "_testimonial_author",
    label: "Author",
    inputType: "text",
    selector: (t) => t.author,
  },
  {
    metaKey: "_testimonial_review_date",
    label: "Review Date",
    inputType: "date",
    selector: (t) => toIsoDate(t.reviewDate),
  },
  {
    metaKey: "_testimonial_caption",
    label: "Caption",
    inputType: "textarea",
    selector: (t) => t.caption,
  },
  {
    metaKey: "_testimonial_body",
    label: "Testimonial",
    inputType: "wp_editor",
    selector: (t) => t.body,
  },
];

// CPT UI plugin's post-type definition. `supports` is deliberately minimal:
// 'custom-fields' is absent (stock key/value Custom Fields metabox hidden),
// 'editor' and 'excerpt' are absent (caption + body live in postmeta and
// surface through the purpose-built metabox below — keeps the admin to one
// editing surface). 'title' and 'revisions' remain so the post title is
// search/listable and admins can undo title edits.
export function testimonialCptUiDefinition(): CptUiPostType {
  return {
    name: TESTIMONIAL_POST_TYPE,
    label: "Testimonials",
    singular_label: "Testimonial",
    description:
      "Customer reviews migrated from Scorpion CMS's #TestimonialTable. Rendered on the front-end via the [scorpion_testimonials] shortcode.",
    public: "false",
    publicly_queryable: "false",
    show_ui: "true",
    show_in_nav_menus: "false",
    show_in_rest: "true",
    rest_base: "",
    rest_controller_class: "",
    rest_namespace: "",
    has_archive: "false",
    has_archive_string: "",
    exclude_from_search: "true",
    capability_type: "post",
    hierarchical: "false",
    rewrite: "false",
    rewrite_slug: "",
    rewrite_withfront: "true",
    query_var: "true",
    query_var_slug: "",
    menu_position: "",
    show_in_menu: "true",
    show_in_menu_string: "",
    menu_icon: "dashicons-format-quote",
    supports: ["title", "revisions"],
    taxonomies: [],
    labels: {
      menu_name: "Testimonials",
      all_items: "All Testimonials",
      add_new: "Add New",
      add_new_item: "Add New Testimonial",
      edit_item: "Edit Testimonial",
      new_item: "New Testimonial",
      view_item: "View Testimonial",
      view_items: "View Testimonials",
      search_items: "Search Testimonials",
      not_found: "No testimonials found",
      not_found_in_trash: "No testimonials found in trash",
      parent_item_colon: "",
      featured_image: "Featured image",
      set_featured_image: "Set featured image",
      remove_featured_image: "Remove featured image",
      use_featured_image: "Use as featured image",
      archives: "Testimonial archives",
      insert_into_item: "Insert into testimonial",
      uploaded_to_this_item: "Uploaded to this testimonial",
      filter_items_list: "Filter testimonials list",
      items_list_navigation: "Testimonials list navigation",
      items_list: "Testimonials list",
      attributes: "Testimonial attributes",
      name_admin_bar: "Testimonial",
      item_published: "Testimonial published.",
      item_published_privately: "Testimonial published privately.",
      item_reverted_to_draft: "Testimonial reverted to draft.",
      item_scheduled: "Testimonial scheduled.",
      item_updated: "Testimonial updated.",
    },
    custom_supports: "",
    enter_title_here: "Add testimonial headline (e.g. \"Great service!\")",
    show_in_graphql: "false",
    graphql_single_name: "",
    graphql_plural_name: "",
  };
}

// Metabox spec consumed by buildCptMetaboxPhp() in cpt-metabox.ts. Same
// fields drive both the WXR postmeta emission (via the selector) and the
// rendered admin metabox.
export const TESTIMONIAL_METABOX: CptMetaboxSpec = {
  postType: TESTIMONIAL_POST_TYPE,
  titleSingular: "Testimonial",
  fields: TESTIMONIAL_META_FIELDS,
};
