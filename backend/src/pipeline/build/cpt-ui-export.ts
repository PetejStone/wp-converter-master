// Builds the cptui-export.json file shipped in the export package. The
// CPT UI plugin reads this file via Tools → CPT UI → Tools → Import,
// and the `wp:import` script automates that step the same way it
// automates CF7 / Flamingo / Complianz import. CPT definitions go in
// `post_types` keyed by post_type slug; taxonomies (none for now) go
// in `taxonomies`.
//
// CPT UI's JSON format stores every boolean as the string "true" /
// "false" rather than a JSON boolean — that's not a typo, it's how the
// plugin reads the file. The shape was verified against the plugin's
// own Tools → Export output on a reference WP install.
//
// Per-system CPT definitions live in pipeline/build/cpts/<system>.ts so
// the schema, CPT UI shape, and metabox spec all sit alongside each
// other. This file is the registry that gathers them into the export.

import { testimonialCptUiDefinition } from "./cpts/testimonials";

export interface CptUiExport {
  post_types: Record<string, CptUiPostType>;
  taxonomies: Record<string, never>;
}

export interface CptUiPostType {
  name: string;
  label: string;
  singular_label: string;
  description: string;
  public: "true" | "false";
  publicly_queryable: "true" | "false";
  show_ui: "true" | "false";
  show_in_nav_menus: "true" | "false";
  show_in_rest: "true" | "false";
  rest_base: string;
  rest_controller_class: string;
  rest_namespace: string;
  has_archive: "true" | "false";
  has_archive_string: string;
  exclude_from_search: "true" | "false";
  capability_type: string;
  hierarchical: "true" | "false";
  rewrite: "true" | "false";
  rewrite_slug: string;
  rewrite_withfront: "true" | "false";
  query_var: "true" | "false";
  query_var_slug: string;
  menu_position: string;
  show_in_menu: "true" | "false";
  show_in_menu_string: string;
  menu_icon: string;
  supports: string[];
  taxonomies: string[];
  labels: Record<string, string>;
  custom_supports: string;
  enter_title_here: string;
  show_in_graphql: "true" | "false";
  graphql_single_name: string;
  graphql_plural_name: string;
}

// Registry of every Scorpion-system CPT shipped in the export. Adding a new
// system means importing its definition from cpts/<system>.ts and including
// it in this map.
export function buildCptUiExport(): CptUiExport {
  return {
    post_types: {
      scorpion_testimonial: testimonialCptUiDefinition(),
    },
    taxonomies: {},
  };
}
