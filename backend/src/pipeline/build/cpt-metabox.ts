// Generates the purpose-built admin metabox PHP for a Scorpion-system CPT.
// One metabox per system, registered on that system's post type, surfacing
// each schema field as a labeled HTML5 input. Read-only fields render
// `readonly` and are skipped by the save handler so the join key can't drift
// on re-import. See DECISIONS.md → "CPT field editability" for context.

// Structural shape consumed by the generator — matches CptMetaField from
// cpts/<system>.ts but drops the typed selector since the PHP layer doesn't
// touch source values. ReadonlyArray of an inline shape rather than the
// full CptMetaField<T> so we don't need to thread the entity generic
// through this layer.
export interface CptMetaboxSpec {
  // Post type slug, e.g. 'scorpion_testimonial'. Used to scope the
  // save_post_<type> hook so the save handler only runs for this CPT.
  postType: string;
  // Singular display label used in the metabox title ('Testimonial' →
  // "Testimonial Fields").
  titleSingular: string;
  fields: ReadonlyArray<{
    metaKey: string;
    label: string;
    inputType: "text" | "date" | "number" | "textarea" | "wp_editor";
    readOnly?: boolean;
  }>;
}

// Input types that store multi-line / HTML content. Saved via wp_unslash
// only — `sanitize_text_field` would collapse newlines and strip the HTML
// admins typed into wp_editor, defeating the point of either control. The
// front-end shortcode `esc_html`s on output, so unsanitized storage isn't
// an XSS risk on the converted site's render path.
const RICH_INPUT_TYPES = new Set(["textarea", "wp_editor"]);

export function buildCptMetaboxPhp(spec: CptMetaboxSpec): string {
  const fnSlug = phpIdentifier(spec.postType);
  const metaboxId = `${spec.postType.replace(/_/g, "-")}-fields`;
  const nonceKey = `${fnSlug}_metabox_save`;
  const nonceField = `${fnSlug}_metabox_nonce`;

  const renderRows = spec.fields
    .map((f) => renderFieldRow(spec.postType, f))
    .join("\n");

  // Only non-readonly fields participate in save. Read-only fields are the
  // join key — re-import is the only allowed writer for them. Rich-text
  // fields skip sanitize_text_field so newlines and inline HTML survive.
  const saveStatements = spec.fields
    .filter((f) => !f.readOnly)
    .map((f) => {
      const inputName = inputNameFor(spec.postType, f.metaKey);
      const isRich = RICH_INPUT_TYPES.has(f.inputType);
      const storeExpr = isRich ? "$value" : "sanitize_text_field($value)";
      return [
        `    if (array_key_exists('${escapePhp(inputName)}', $_POST)) {`,
        `        $value = wp_unslash($_POST['${escapePhp(inputName)}']);`,
        `        if (!is_string($value)) { $value = ''; }`,
        `        update_post_meta($post_id, '${escapePhp(f.metaKey)}', ${storeExpr});`,
        `    }`,
      ].join("\n");
    })
    .join("\n");

  return `/**
 * "${escapePhpComment(spec.titleSingular)} Fields" metabox — purpose-built editor
 * for the ${escapePhpComment(spec.postType)} CPT's postmeta. Generated from the field
 * schema in pipeline/build/cpts/. Each non-readonly field is rendered as
 * a labeled HTML5 input and saved on update. Read-only fields render
 * 'readonly' and are never written by this handler — they're the
 * idempotency join key and only the WXR re-import updates them.
 */
function ${fnSlug}_register_metabox() {
    add_meta_box(
        '${escapePhp(metaboxId)}',
        '${escapePhp(spec.titleSingular)} Fields',
        '${fnSlug}_render_metabox',
        '${escapePhp(spec.postType)}',
        'normal',
        'high'
    );
}
add_action('add_meta_boxes', '${fnSlug}_register_metabox');

function ${fnSlug}_render_metabox($post) {
    wp_nonce_field('${escapePhp(nonceKey)}', '${escapePhp(nonceField)}');
${renderRows}
}

function ${fnSlug}_save_metabox($post_id) {
    if (!isset($_POST['${escapePhp(nonceField)}'])) {
        return;
    }
    if (!wp_verify_nonce(wp_unslash($_POST['${escapePhp(nonceField)}']), '${escapePhp(nonceKey)}')) {
        return;
    }
    if (defined('DOING_AUTOSAVE') && DOING_AUTOSAVE) {
        return;
    }
    if (!current_user_can('edit_post', $post_id)) {
        return;
    }
${saveStatements || "    // (no editable fields — all schema entries are read-only)"}
}
add_action('save_post_${escapePhp(spec.postType)}', '${fnSlug}_save_metabox');
`;
}

function renderFieldRow(
  postType: string,
  field: CptMetaboxSpec["fields"][number],
): string {
  const inputName = inputNameFor(postType, field.metaKey);
  const inputId = `${phpIdentifier(postType)}_${phpIdentifier(field.metaKey)}`;

  const lines = [
    `    $value = get_post_meta($post->ID, '${escapePhp(field.metaKey)}', true);`,
    `    if (!is_string($value)) { $value = ''; }`,
    `    echo '<div style="margin:0 0 1em;">';`,
    `    echo '<label for="${escapePhp(inputId)}" style="display:block;font-weight:600;margin-bottom:0.25em;">${escapePhp(field.label)}</label>';`,
  ];

  if (field.inputType === "wp_editor") {
    // wp_editor() prints directly — must run outside the surrounding
    // echo chain. media_buttons=false because admins editing a single
    // testimonial body shouldn't need to insert media; turning it off
    // keeps the metabox compact.
    lines.push(
      `    wp_editor($value, '${escapePhp(inputId)}', array(`,
      `        'textarea_name' => '${escapePhp(inputName)}',`,
      `        'media_buttons' => false,`,
      `        'tinymce'       => array('wpautop' => false),`,
      `        'quicktags'     => true,`,
      `        'editor_height' => 200,`,
      `    ));`,
    );
  } else if (field.inputType === "textarea") {
    const readonlyAttr = field.readOnly ? " readonly" : "";
    lines.push(
      `    echo '<textarea id="${escapePhp(inputId)}" name="${escapePhp(inputName)}" rows="3" style="width:100%;font-family:inherit;"${readonlyAttr}>' . esc_textarea($value) . '</textarea>';`,
    );
  } else {
    const readonlyAttr = field.readOnly ? " readonly" : "";
    lines.push(
      `    echo '<input type="${field.inputType}" id="${escapePhp(inputId)}" name="${escapePhp(inputName)}" value="' . esc_attr($value) . '" style="width:100%;"${readonlyAttr} />';`,
    );
  }

  if (field.readOnly) {
    lines.push(
      `    echo '<span style="display:block;margin-top:0.25em;color:#666;font-size:12px;">Read-only — required for re-import idempotency.</span>';`,
    );
  }
  lines.push(`    echo '</div>';`);
  return lines.join("\n");
}

// $_POST input name for a field. We avoid leading underscores in the form
// name (WP strips them from $_POST in some setups) by trimming them.
function inputNameFor(postType: string, metaKey: string): string {
  const trimmedKey = metaKey.replace(/^_+/, "");
  return `${postType}_${trimmedKey}`;
}

function phpIdentifier(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_");
}

function escapePhp(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function escapePhpComment(value: string): string {
  return value.replace(/\*\//g, "*\\/");
}
