// Generates the "Scorpion Migration Helper" — a self-contained WordPress
// plugin shipped in the export package so a NON-TECHNICAL user can finish a
// migration with one click instead of hand-installing plugins and running
// the importer.
//
// WHY THIS EXISTS
// A WordPress export (WXR / import.xml) is a content-only format. It carries
// pages, posts, menus, terms, and postmeta — it CANNOT install or activate
// the plugins those contents depend on (Contact Form 7 for the form posts,
// Custom Post Type UI for the testimonial CPT, Yoast for the SEO meta keys,
// etc.). That's a hard WordPress limitation. This plugin closes the gap: it
// installs+activates the required WP.org plugins, then imports the bundled
// WXR — replicating what scripts/import-to-wp.ts does over wp-cli, but
// through a wp-admin button for users with no shell access.
//
// DELIVERY
// build/index.ts writes this PHP into a `scorpion-migration-helper/` folder,
// copies import.xml / cptui-export.json / (redirects.csv) into its `data/`
// subdir, and zips the folder into `scorpion-migration-helper.zip`. The user
// uploads that zip at Plugins → Add New → Upload Plugin, activates it, then
// clicks "Run migration" under Tools → Scorpion Migration.

import { THEME_SLUG } from "./theme";

export const MIGRATION_HELPER_SLUG = "scorpion-migration-helper";

export interface MigrationHelperInputs {
  siteTitle: string;
  // Whether redirects.csv is bundled in the plugin's data/ dir. Drives
  // whether the Redirection plugin is added to the required-plugins list
  // and whether the redirect-import step runs.
  hasRedirects: boolean;
}

// PHP-single-quote escaping: backslash and single quote only.
function phpSingleQuote(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function buildMigrationHelperPlugin(
  inputs: MigrationHelperInputs,
): string {
  const headerTitle = inputs.siteTitle.replace(/[\r\n]+/g, " ").trim();
  const titleLiteral = phpSingleQuote(headerTitle);

  // Required WP.org plugins, keyed by repo slug. The runtime resolves each
  // slug to its real main-file by directory match (smh_plugin_file_for_slug)
  // so we never hard-code fragile main-file names (e.g. Complianz ships
  // `complianz-gpdr.php`, misspelled). Redirection is conditional on a
  // bundled redirects.csv — same gate scripts/import-to-wp.ts uses.
  const requiredPluginsPhp = [
    "    $plugins = array(",
    "        'wordpress-importer'  => 'WordPress Importer (runs the content import)',",
    "        'custom-post-type-ui' => 'Custom Post Type UI (registers Scorpion system post types)',",
    "        'contact-form-7'      => 'Contact Form 7 (powers the converted contact forms)',",
    "        'flamingo'            => 'Flamingo (stores every form submission in wp-admin)',",
    "        'wp-mail-smtp'        => 'WP Mail SMTP (reliable form-notification email delivery)',",
    "        'complianz-gdpr'      => 'Complianz (GDPR/CCPA cookie-consent banner)',",
    "        'wordpress-seo'       => 'Yoast SEO (reads the imported SEO title/description/canonical meta)',",
    inputs.hasRedirects
      ? "        'redirection'         => 'Redirection (301 redirects carried over from the old site)',"
      : null,
    "    );",
  ]
    .filter((l): l is string => l !== null)
    .join("\n");

  return `<?php
/**
 * Plugin Name: Scorpion Migration Helper — ${headerTitle}
 * Description: One-click setup for a Scorpion → WordPress conversion. Installs the WordPress plugins the converted site depends on, then imports the converted content (pages, posts, menus, testimonials, SEO meta), wires up redirects, and pins the home page. A WordPress export file cannot carry plugins itself — this installs them for you.
 * Version: 1.0
 * Author: Scorpion CMS → WordPress Conversion Tool
 * Requires at least: 5.6
 */

if (!defined('ABSPATH')) { exit; }

define('SMH_VERSION', '1.0');
define('SMH_THEME_SLUG', '${THEME_SLUG}');
define('SMH_SITE_TITLE', '${titleLiteral}');

// Must be defined BEFORE the WordPress Importer plugin's main file is ever
// included. That file guards its WP_Import class behind
// "if (!defined('WP_LOAD_IMPORTERS')) return;" — so if the constant is not
// set when activate_plugin() includes the file (which happens mid-migration,
// or at bootstrap when the importer is already active), the class is never
// defined and require_once later can't re-trigger it. Defining it here, in a
// plugin that loads ahead of the importer, guarantees the class is available.
if (!defined('WP_LOAD_IMPORTERS')) {
    define('WP_LOAD_IMPORTERS', true);
}

/**
 * Required WP.org plugins: repo slug => human-readable label. The converted
 * content is inert without these (form posts, the testimonial CPT, the SEO
 * meta keys, etc.), so the helper installs+activates them before importing.
 */
function smh_required_plugins() {
${requiredPluginsPhp}
    return $plugins;
}

/**
 * Optional plugins: a failed install is a warning, not a blocker. The SEO
 * meta is imported as postmeta regardless of which SEO plugin (if any) reads
 * it — Yoast keys are just the default — so Yoast failing to install (e.g.
 * its latest release requiring a newer WordPress than the target site) must
 * not fail the migration.
 */
function smh_is_optional_plugin($slug) {
    return $slug === 'wordpress-seo';
}

/**
 * Resolve a repo slug to the installed plugin's main file (e.g.
 * 'contact-form-7' => 'contact-form-7/wp-contact-form-7.php') by matching the
 * plugin directory, so we never depend on knowing the main-file name. Returns
 * null when the plugin isn't installed.
 */
function smh_plugin_file_for_slug($slug) {
    if (!function_exists('get_plugins')) {
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
    }
    foreach (array_keys(get_plugins()) as $file) {
        if (strpos($file, $slug . '/') === 0) {
            return $file;
        }
    }
    return null;
}

/**
 * Locate a bundled data file. Checks the plugin's own data/ dir first (the
 * normal case — files travel inside the plugin zip), then the WordPress root
 * as a fallback for installs where a large import.xml was SFTP'd separately
 * to keep the plugin zip under the host's upload limit.
 */
function smh_data_file($name) {
    $candidates = array(
        plugin_dir_path(__FILE__) . 'data/' . $name,
        trailingslashit(ABSPATH) . $name,
    );
    foreach ($candidates as $path) {
        if (file_exists($path)) {
            return $path;
        }
    }
    return null;
}

/**
 * Install (if missing) and activate a plugin by repo slug. Returns true on
 * success or a WP_Error describing the failure (surfaced per-row in the UI).
 */
function smh_install_activate($slug) {
    if (!function_exists('is_plugin_active')) {
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
    }
    $file = smh_plugin_file_for_slug($slug);

    if (!$file) {
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/misc.php';
        require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
        require_once ABSPATH . 'wp-admin/includes/plugin-install.php';

        $api = plugins_api('plugin_information', array(
            'slug'   => $slug,
            'fields' => array('sections' => false),
        ));
        if (is_wp_error($api)) {
            return $api;
        }

        $skin = new Automatic_Upgrader_Skin();
        $upgrader = new Plugin_Upgrader($skin);
        $result = $upgrader->install($api->download_link);
        if (is_wp_error($result)) {
            return $result;
        }
        if (is_wp_error($skin->result)) {
            return $skin->result;
        }
        if (!$result) {
            // Surface the upgrader's own messages — they carry the real reason
            // (e.g. "Minimum WordPress requirement is 6.8" when the latest
            // release outranks the target site, or a filesystem-permissions
            // error on locked-down managed hosts).
            $messages = method_exists($skin, 'get_upgrade_messages') ? $skin->get_upgrade_messages() : array();
            $detail = !empty($messages)
                ? trim(strip_tags(implode(' ', $messages)))
                : 'Install failed (download/extraction, or a filesystem-permissions restriction on managed hosts).';
            return new WP_Error('smh_install_failed', $detail);
        }

        wp_clean_plugins_cache();
        $file = smh_plugin_file_for_slug($slug);
        if (!$file) {
            return new WP_Error('smh_no_file', 'Installed but the plugin main file could not be located.');
        }
    }

    if (is_plugin_active($file)) {
        return true;
    }
    $activated = activate_plugin($file);
    if (is_wp_error($activated)) {
        return $activated;
    }
    return true;
}

/**
 * Apply the bundled CPT UI schema and register the post types in THIS request.
 * Critical: WP_Import skips any <item> whose post_type isn't registered, and
 * CPT UI only registers on 'init' (which already fired before this admin POST
 * runs). Writing the option alone is not enough for the same-request import —
 * we must register the types now too.
 */
function smh_import_cptui() {
    $file = smh_data_file('cptui-export.json');
    if (!$file) {
        return array('Custom post types (CPT UI)', 'skip', 'cptui-export.json not bundled — skipped.');
    }
    $data = json_decode(file_get_contents($file), true);
    if (!is_array($data)) {
        return array('Custom post types (CPT UI)', 'error', 'Could not parse cptui-export.json.');
    }

    if (isset($data['post_types'])) {
        update_option('cptui_post_types', $data['post_types']);
    }
    if (isset($data['taxonomies'])) {
        update_option('cptui_taxonomies', $data['taxonomies']);
    }

    // Register for the current request so the import below doesn't skip
    // scorpion_* items. Prefer CPT UI's own registrar (honours every option);
    // fall back to a minimal register_post_type so the import still lands.
    if (function_exists('cptui_create_custom_post_types')) {
        cptui_create_custom_post_types();
    } else if (isset($data['post_types']) && is_array($data['post_types'])) {
        foreach ($data['post_types'] as $slug => $def) {
            if (post_type_exists($slug)) {
                continue;
            }
            $label = isset($def['label']) ? $def['label'] : $slug;
            register_post_type($slug, array(
                'public'  => true,
                'label'   => $label,
                'show_ui' => true,
            ));
        }
    }

    return array('Custom post types (CPT UI)', 'ok', 'Schema applied and post types registered.');
}

/**
 * Run the bundled WXR import via the WordPress Importer's WP_Import class.
 * Attachments are NOT fetched — media is uploaded separately to
 * wp-content/uploads/scorpion-migration/ (see the migration checklist).
 */
function smh_import_wxr() {
    $file = smh_data_file('import.xml');
    if (!$file) {
        return array('Content import (WXR)', 'error', 'import.xml not found in the plugin or at the site root.');
    }

    if (!defined('WP_LOAD_IMPORTERS')) {
        define('WP_LOAD_IMPORTERS', true);
    }
    require_once ABSPATH . 'wp-admin/includes/import.php';

    $importer_main = smh_plugin_file_for_slug('wordpress-importer');
    if ($importer_main) {
        $path = WP_PLUGIN_DIR . '/' . $importer_main;
        if (file_exists($path)) {
            require_once $path;
        }
    }
    if (!class_exists('WP_Import')) {
        return array('Content import (WXR)', 'error', 'WordPress Importer is not available — make sure the plugin step above succeeded, then retry.');
    }

    @set_time_limit(0);
    $importer = new WP_Import();
    $importer->fetch_attachments = false;

    // WP_Import echoes progress HTML; capture and discard it so the admin
    // page renders our own clean result table instead.
    ob_start();
    $importer->import($file);
    ob_end_clean();

    return array('Content import (WXR)', 'ok', 'Pages, posts, menus, testimonials, and SEO meta imported.');
}

/**
 * Best-effort import of redirects.csv into the Redirection plugin. The
 * plugin's importer API varies across versions, so any failure degrades to a
 * non-fatal warning telling the admin to import the bundled CSV by hand.
 */
function smh_import_redirects() {
    $file = smh_data_file('redirects.csv');
    if (!$file) {
        return array('Redirects', 'skip', 'No redirects.csv bundled — nothing to import.');
    }
    try {
        if (class_exists('Red_Database')) {
            $db = new Red_Database();
            if (method_exists($db, 'get_latest_database_version') && method_exists($db, 'apply_upgrade')) {
                $db->apply_upgrade($db->get_latest_database_version());
            }
        }
        if (!class_exists('Red_FileIO')) {
            return array('Redirects', 'warn', 'Redirection not fully loaded — import data/redirects.csv manually at Tools → Redirection → Import/Export.');
        }

        $group_id = 1;
        if (class_exists('Red_Group') && method_exists('Red_Group', 'get_all')) {
            $groups = Red_Group::get_all();
            if (!empty($groups) && isset($groups[0]['id'])) {
                $group_id = $groups[0]['id'];
            }
        }

        $importer = Red_FileIO::create('csv');
        if (!$importer) {
            return array('Redirects', 'warn', 'Could not create the CSV importer — import data/redirects.csv manually at Tools → Redirection.');
        }
        $count = $importer->load($group_id, $file, file_get_contents($file));
        $n = is_int($count) ? $count : 0;
        return array('Redirects', 'ok', $n . ' redirect rule(s) imported into Redirection.');
    } catch (Throwable $e) {
        return array('Redirects', 'warn', 'Redirect import failed (' . $e->getMessage() . ') — import data/redirects.csv manually at Tools → Redirection.');
    }
}

/**
 * Assign the imported nav menus to the converted theme's menu locations.
 * Menu term-slugs come from the WXR ('primary-menu', 'footer-quick-links');
 * the theme registers matching locations in functions.php.
 */
function smh_assign_menus() {
    $map = array(
        'primary-menu'        => 'primary',
        'footer-quick-links'  => 'footer-quick-links',
    );
    $locations = get_theme_mod('nav_menu_locations', array());
    if (!is_array($locations)) {
        $locations = array();
    }
    $assigned = array();
    foreach ($map as $slug => $location) {
        $menu = wp_get_nav_menu_object($slug);
        if ($menu && !is_wp_error($menu)) {
            $locations[$location] = $menu->term_id;
            $assigned[] = $location;
        }
    }
    set_theme_mod('nav_menu_locations', $locations);

    if (empty($assigned)) {
        return array('Navigation menus', 'warn', 'No imported menu matched a theme location (the site may not have a captured menu).');
    }
    return array('Navigation menus', 'ok', 'Assigned to location(s): ' . implode(', ', $assigned) . '.');
}

/**
 * Pin the imported "home" page as the static front page. Scorpion serves home
 * at "/"; WordPress shows the blog index there unless this is set.
 */
function smh_set_front_page() {
    $home = get_page_by_path('home');
    if (!$home) {
        return array('Front page', 'warn', 'No top-level page with slug "home" found — set the front page manually under Settings → Reading.');
    }
    update_option('show_on_front', 'page');
    update_option('page_on_front', $home->ID);
    return array('Front page', 'ok', 'Imported home page pinned as the site front page.');
}

/**
 * Force pretty permalinks (/%postname%/) and rebuild the rewrite rules.
 * Every converted page URL, menu link, and redirect is path-based, but a
 * fresh WordPress defaults to "plain" permalinks (?p=123). On a plain
 * install none of the pretty URLs resolve — WordPress serves the front page
 * for every unrecognised path, so every page appears to render the home
 * page. Setting this is mandatory for the converted site to work.
 */
function smh_set_permalinks() {
    global $wp_rewrite;
    $target = '/%postname%/';
    if (get_option('permalink_structure') !== $target) {
        update_option('permalink_structure', $target);
    }
    if (is_object($wp_rewrite)) {
        $wp_rewrite->set_permalink_structure($target);
        $wp_rewrite->flush_rules(true); // hard flush — also rewrites .htaccess on Apache
    } else {
        flush_rewrite_rules(true);
    }
    return array('Permalinks', 'ok', 'Set to /%postname%/ and rewrite rules flushed.');
}

/**
 * Run every migration step in order, collecting a (step, status, message)
 * row per step. Each step is wrapped so one failure never aborts the rest —
 * the admin sees exactly which steps succeeded and which need attention.
 */
function smh_run_migration() {
    @set_time_limit(0);
    $log = array();

    // 1. Plugins first — the import depends on them.
    foreach (smh_required_plugins() as $slug => $label) {
        try {
            $res = smh_install_activate($slug);
            if (is_wp_error($res)) {
                if (smh_is_optional_plugin($slug)) {
                    $log[] = array('Plugin: ' . $slug, 'warn', $res->get_error_message() . ' (optional — install a compatible SEO plugin by hand; your SEO data was imported either way).');
                } else {
                    $log[] = array('Plugin: ' . $slug, 'error', $res->get_error_message());
                }
            } else {
                $log[] = array('Plugin: ' . $slug, 'ok', 'Installed and activated.');
            }
        } catch (Throwable $e) {
            $status = smh_is_optional_plugin($slug) ? 'warn' : 'error';
            $log[] = array('Plugin: ' . $slug, $status, $e->getMessage());
        }
    }

    $steps = array('smh_import_cptui', 'smh_import_wxr');
    if (smh_data_file('redirects.csv')) {
        $steps[] = 'smh_import_redirects';
    }
    $steps[] = 'smh_set_permalinks';
    $steps[] = 'smh_assign_menus';
    $steps[] = 'smh_set_front_page';

    foreach ($steps as $fn) {
        try {
            $log[] = call_user_func($fn);
        } catch (Throwable $e) {
            $log[] = array($fn, 'error', $e->getMessage());
        }
    }

    // Rebuild rewrite rules so the freshly-imported pages resolve.
    flush_rewrite_rules(false);

    return $log;
}

/**
 * Register the admin screen under Tools → Scorpion Migration.
 */
function smh_admin_menu() {
    add_management_page(
        'Scorpion Migration',
        'Scorpion Migration',
        'manage_options',
        'scorpion-migration',
        'smh_render_page'
    );
}
add_action('admin_menu', 'smh_admin_menu');

function smh_status_badge($status) {
    $map = array(
        'ok'    => '#2271b1',
        'warn'  => '#bd8600',
        'error' => '#d63638',
        'skip'  => '#646970',
    );
    $color = isset($map[$status]) ? $map[$status] : '#646970';
    return '<span style="color:' . $color . ';font-weight:600">' . esc_html(strtoupper($status)) . '</span>';
}

function smh_render_page() {
    if (!current_user_can('manage_options')) {
        return;
    }

    $log = null;
    if (isset($_POST['smh_run']) && check_admin_referer('smh_run_migration')) {
        $log = smh_run_migration();
    }

    echo '<div class="wrap">';
    echo '<h1>Scorpion Migration</h1>';
    echo '<p>This finishes setting up <strong>' . esc_html(SMH_SITE_TITLE) . '</strong>. One click installs the WordPress plugins the converted site needs, imports your content (pages, posts, menus, testimonials, SEO settings), wires up redirects, and pins the home page.</p>';
    echo '<p><em>A WordPress export file can only carry content — it cannot carry plugins. This helper installs them for you so the import works.</em></p>';

    // Bundled data files.
    echo '<h2>Bundled data</h2><table class="widefat striped" style="max-width:640px"><tbody>';
    foreach (array('import.xml', 'cptui-export.json', 'redirects.csv') as $name) {
        $found = smh_data_file($name);
        echo '<tr><td>' . esc_html($name) . '</td><td>' . ($found ? smh_status_badge('ok') . ' found' : esc_html('not bundled')) . '</td></tr>';
    }
    echo '</tbody></table>';

    // Required-plugin status.
    echo '<h2>Required plugins</h2><table class="widefat striped" style="max-width:640px"><thead><tr><th>Plugin</th><th>Status</th></tr></thead><tbody>';
    foreach (smh_required_plugins() as $slug => $label) {
        $file = smh_plugin_file_for_slug($slug);
        if (!$file) {
            $status = 'not installed';
        } else if (function_exists('is_plugin_active') && is_plugin_active($file)) {
            $status = 'active';
        } else {
            $status = 'installed (inactive)';
        }
        echo '<tr><td>' . esc_html($label) . '</td><td>' . esc_html($status) . '</td></tr>';
    }
    echo '</tbody></table>';

    // Run button.
    echo '<form method="post" style="margin-top:1.5em">';
    wp_nonce_field('smh_run_migration');
    echo '<input type="hidden" name="smh_run" value="1" />';
    submit_button('Run migration', 'primary', 'submit', false);
    echo ' <span class="description">Safe to run more than once — it skips work already done.</span>';
    echo '</form>';

    // Result log.
    if (is_array($log)) {
        echo '<h2 style="margin-top:1.5em">Result</h2>';
        echo '<table class="widefat striped"><thead><tr><th>Step</th><th>Status</th><th>Detail</th></tr></thead><tbody>';
        foreach ($log as $row) {
            $step = isset($row[0]) ? $row[0] : '';
            $st   = isset($row[1]) ? $row[1] : '';
            $msg  = isset($row[2]) ? $row[2] : '';
            echo '<tr><td>' . esc_html($step) . '</td><td>' . smh_status_badge($st) . '</td><td>' . esc_html($msg) . '</td></tr>';
        }
        echo '</tbody></table>';

        echo '<h3>Next, by hand</h3><ul style="list-style:disc;margin-left:1.4em">';
        echo '<li><strong>Theme + media</strong>: confirm the <code>' . esc_html(SMH_THEME_SLUG) . '</code> theme is uploaded and activated, and that <code>media/</code> is uploaded to <code>wp-content/uploads/scorpion-migration/</code> (see MIGRATION-CHECKLIST.md).</li>';
        echo '<li><strong>Form email</strong>: set each form\\'s real "To" address under Contact → Edit, and point WP Mail SMTP at the client\\'s mail provider.</li>';
        echo '<li><strong>Cookie banner</strong>: complete the Complianz wizard to pick jurisdictions and categorise scripts.</li>';
        echo '</ul>';
        echo '<p><a class="button button-primary" href="' . esc_url(home_url('/')) . '" target="_blank" rel="noopener">View the site</a></p>';
    }

    echo '</div>';
}
`;
}
