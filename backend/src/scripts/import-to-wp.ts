import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { desc, eq, isNotNull } from "drizzle-orm";
import { closeDb, db } from "../db/client";
import { jobs } from "../db/schema";
import { MIGRATION_HELPER_SLUG } from "../pipeline/build/migration-helper-plugin";

const WP_HOST_PORT = 8080;
const WP_CONTAINER = "scorpion-wp-converter-wp";
const ADMIN_USER = "admin";
const ADMIN_PASS = "admin";
const ADMIN_EMAIL = "admin@example.test";
const THEME_SLUG = "scorpion-converted";

// When the backend runs in a container, output paths in the DB use the
// container's TEMP_DIR (/tmp/scorpion-conversions). On the host those
// files live under <repo-root>/.conversions/ via the compose bind mount.
// Translate so this script (which runs on the host) can still find them.
const CONTAINER_TEMP_PREFIX = "/tmp/scorpion-conversions/";
const HOST_CONVERSIONS_DIR =
  process.env.HOST_CONVERSIONS_DIR ??
  resolve(process.cwd(), "..", ".conversions");

function toHostPath(p: string): string {
  if (!p.startsWith(CONTAINER_TEMP_PREFIX)) return p;
  return join(HOST_CONVERSIONS_DIR, p.slice(CONTAINER_TEMP_PREFIX.length));
}

// Latest stable WordPress importer plugin version. The wp-cli installer is
// fussy about activating a freshly-downloaded plugin within the same call, so
// we install + activate separately.

function docker(
  args: string[],
  { capture = false }: { capture?: boolean } = {},
): string {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    const detail = capture ? result.stderr || result.stdout || "" : "";
    throw new Error(
      `docker ${args.join(" ")} → exit ${result.status}\n${detail}`,
    );
  }
  return result.stdout ?? "";
}

function wpCli(args: string[], { capture = false } = {}): string {
  return docker(
    [
      "compose",
      "run",
      "--rm",
      "--user",
      "33:33",
      "wpcli",
      "wp",
      "--path=/var/www/html",
      ...args,
    ],
    { capture },
  );
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const jobIdArg = argv.find((a) => !a.startsWith("--"));
  const clean = argv.includes("--clean");
  // --via-plugin drives the entire migration through the generated
  // scorpion-migration-helper plugin (PHP) instead of the wp-cli steps below.
  // This is the real end-to-end test of the one-click flow a non-technical
  // user runs: the plugin must install every required plugin, register the
  // CPTs, import the WXR, wire redirects + menus, and pin the front page —
  // all from PHP, with no wp-cli scaffolding. Combine with --clean for a
  // from-scratch run: `npm run wp:import -- --via-plugin --clean`.
  const viaPlugin = argv.includes("--via-plugin");

  // ---- 1. Pick a job ----
  let job;
  if (jobIdArg) {
    job =
      (await db
        .select()
        .from(jobs)
        .where(eq(jobs.id, jobIdArg))
        .limit(1))[0] ?? null;
  } else {
    job =
      (await db
        .select()
        .from(jobs)
        .where(isNotNull(jobs.outputPath))
        .orderBy(desc(jobs.createdAt))
        .limit(1))[0] ?? null;
  }
  if (!job) {
    console.error("No job found. Pass a jobId or have ≥1 ready job in the DB.");
    process.exit(1);
  }
  if (!job.outputPath) {
    console.error(`Job ${job.id} has no outputPath.`);
    process.exit(1);
  }

  const outputDir = join(dirname(toHostPath(job.outputPath)), "output");
  const themeSrc = join(outputDir, "theme", THEME_SLUG);
  const mediaSrc = join(outputDir, "media");
  const wxrSrc = join(outputDir, "import.xml");
  const redirectsSrc = join(outputDir, "redirects.csv");
  const cptUiSrc = join(outputDir, "cptui-export.json");

  if (!existsSync(themeSrc) || !existsSync(wxrSrc)) {
    console.error(`Expected files missing in ${outputDir}`);
    console.error("  Re-run the conversion to regenerate.");
    process.exit(1);
  }

  console.log(`Job:         ${job.id}`);
  console.log(`Site title:  ${job.siteTitle}`);
  console.log(`Output dir:  ${outputDir}`);
  console.log(`Clean mode:  ${clean ? "yes (will empty existing content)" : "no"}`);

  // ---- 2. Ensure WP services are up ----
  console.log("\nEnsuring WP services are up…");
  docker(["compose", "up", "-d", "wpdb", "wordpress"]);

  console.log("Waiting for WP HTTP to respond…");
  await waitForHttp(
    `http://localhost:${WP_HOST_PORT}/wp-includes/version.php`,
    60_000,
  );

  // ---- 3. Install WP if needed ----
  const installed = (() => {
    try {
      wpCli(["core", "is-installed"], { capture: true });
      return true;
    } catch {
      return false;
    }
  })();

  if (!installed) {
    console.log("\nInstalling WordPress…");
    wpCli([
      "core",
      "install",
      `--url=http://localhost:${WP_HOST_PORT}`,
      "--title=Scorpion Import Test",
      `--admin_user=${ADMIN_USER}`,
      `--admin_password=${ADMIN_PASS}`,
      `--admin_email=${ADMIN_EMAIL}`,
      "--skip-email",
    ]);
    wpCli(["rewrite", "structure", "/%postname%/", "--hard"]);
  } else {
    console.log("\nWordPress is already installed.");
    if (clean) {
      console.log("--clean: emptying existing content + deleting Scorpion media…");
      wpCli(["site", "empty", "--yes"]);
      docker([
        "exec",
        WP_CONTAINER,
        "rm",
        "-rf",
        "/var/www/html/wp-content/uploads/scorpion-migration",
      ]);
    }
  }

  // ---- 4. Copy theme into the WP container ----
  console.log("\nCopying theme into WP container…");
  docker([
    "exec",
    WP_CONTAINER,
    "rm",
    "-rf",
    `/var/www/html/wp-content/themes/${THEME_SLUG}`,
  ]);
  docker([
    "cp",
    themeSrc,
    `${WP_CONTAINER}:/var/www/html/wp-content/themes/`,
  ]);
  docker([
    "exec",
    WP_CONTAINER,
    "chown",
    "-R",
    "www-data:www-data",
    `/var/www/html/wp-content/themes/${THEME_SLUG}`,
  ]);

  console.log("Activating theme…");
  wpCli(["theme", "activate", THEME_SLUG]);

  // ---- 5. Copy media into uploads/scorpion-migration/ ----
  if (existsSync(mediaSrc) && readdirSync(mediaSrc).length > 0) {
    console.log("\nCopying media into WP container…");
    docker([
      "exec",
      WP_CONTAINER,
      "mkdir",
      "-p",
      "/var/www/html/wp-content/uploads/scorpion-migration",
    ]);
    docker([
      "cp",
      `${mediaSrc}/.`,
      `${WP_CONTAINER}:/var/www/html/wp-content/uploads/scorpion-migration/`,
    ]);
    docker([
      "exec",
      WP_CONTAINER,
      "chown",
      "-R",
      "www-data:www-data",
      "/var/www/html/wp-content/uploads/scorpion-migration",
    ]);
  } else {
    console.log("\n(no media to copy)");
  }

  // ---- 6′. (--via-plugin) Drive the migration through the helper plugin ----
  // End-to-end test of scorpion-migration-helper: copy it into the container,
  // activate it, and run smh_run_migration() over wp eval so every step
  // (plugin install, CPT registration, WXR import, redirects, menus, front
  // page) executes from PHP exactly as it would when a user clicks "Run
  // migration" in wp-admin. Returns early — the wp-cli steps below are the
  // alternative path and must not also run.
  if (viaPlugin) {
    const helperSrc = join(outputDir, MIGRATION_HELPER_SLUG);
    if (!existsSync(helperSrc)) {
      console.error(
        `Helper plugin not found at ${helperSrc} — re-run the conversion to regenerate the export.`,
      );
      process.exit(1);
    }

    console.log("\n[--via-plugin] Copying helper plugin into WP container…");
    docker([
      "exec",
      WP_CONTAINER,
      "rm",
      "-rf",
      `/var/www/html/wp-content/plugins/${MIGRATION_HELPER_SLUG}`,
    ]);
    docker(["cp", helperSrc, `${WP_CONTAINER}:/var/www/html/wp-content/plugins/`]);
    docker([
      "exec",
      WP_CONTAINER,
      "chown",
      "-R",
      "www-data:www-data",
      `/var/www/html/wp-content/plugins/${MIGRATION_HELPER_SLUG}`,
    ]);

    console.log("[--via-plugin] Activating helper plugin…");
    wpCli(["plugin", "activate", MIGRATION_HELPER_SLUG]);

    console.log(
      "[--via-plugin] Running smh_run_migration() — installs plugins + imports content from PHP…",
    );
    // Print one tab-separated row per step, then halt non-zero if any step
    // reported 'error' so this verification fails loudly in CI / locally.
    const evalPhp = [
      "$log = smh_run_migration();",
      "$bad = 0;",
      'foreach ($log as $r) { echo $r[0] . "\\t" . strtoupper($r[1]) . "\\t" . $r[2] . "\\n"; if ($r[1] === "error") { $bad++; } }',
      'if ($bad > 0) { WP_CLI::halt(1); }',
    ].join(" ");
    const log = wpCli(["eval", evalPhp], { capture: true });
    console.log("\nStep\tStatus\tDetail");
    console.log(log.trim());

    // The plugin installs WP Mail SMTP but (by design) leaves SMTP creds to
    // the admin. Point it at Mailpit here so staging form-mail tests still
    // deliver — mirrors the wp-cli path's step 6b.1 configuration.
    console.log("\n[--via-plugin] Pointing WP Mail SMTP at Mailpit…");
    const mailpitConfig = JSON.stringify({
      mail: {
        from_email: "noreply@scorpion.test",
        from_name: "Scorpion Test",
        from_email_force: false,
        from_name_force: false,
        mailer: "smtp",
        return_path: false,
      },
      smtp: {
        autotls: false,
        auth: false,
        host: "mailpit",
        port: 1025,
        encryption: "none",
        user: "",
        pass: "",
      },
    });
    wpCli(["option", "update", "wp_mail_smtp", mailpitConfig, "--format=json"]);

    console.log("\n✅ [--via-plugin] Plugin-driven migration complete.");
    console.log(`   Public:  http://localhost:${WP_HOST_PORT}/`);
    console.log(
      `   Admin:   http://localhost:${WP_HOST_PORT}/wp-admin/ (user: ${ADMIN_USER} / pass: ${ADMIN_PASS})`,
    );
    console.log(
      `   Helper:  http://localhost:${WP_HOST_PORT}/wp-admin/tools.php?page=scorpion-migration`,
    );
    return;
  }

  // ---- 6. Install + activate the WordPress Importer plugin ----
  console.log("\nInstalling wordpress-importer plugin…");
  wpCli(["plugin", "install", "wordpress-importer", "--force"]);
  wpCli(["plugin", "activate", "wordpress-importer"]);

  // ---- 6b. Install + activate Contact Form 7 ----
  // Generated wpcf7_contact_form posts in the WXR are no-ops without
  // the CF7 plugin loaded — it owns the [contact-form-7] shortcode + the
  // post type.
  console.log("\nInstalling contact-form-7 plugin…");
  wpCli(["plugin", "install", "contact-form-7", "--force"]);
  wpCli(["plugin", "activate", "contact-form-7"]);

  // ---- 6b.1. Install + activate Flamingo + WP Mail SMTP ----
  // Flamingo: persists every CF7 submission to wp-admin → Flamingo →
  // Inbound Messages. Lets us verify submissions independent of mail.
  // WP Mail SMTP: routes wp_mail() through SMTP (configured below to
  // point at the local Mailpit container) so we can verify the admin
  // notification + user auto-responder without a real mail provider.
  console.log("\nInstalling flamingo plugin (CF7 submission log)…");
  wpCli(["plugin", "install", "flamingo", "--force"]);
  wpCli(["plugin", "activate", "flamingo"]);
  console.log("\nInstalling wp-mail-smtp plugin…");
  wpCli(["plugin", "install", "wp-mail-smtp", "--force"]);
  wpCli(["plugin", "activate", "wp-mail-smtp"]);

  // Point WP Mail SMTP at Mailpit. Mailpit's SMTP listener is on host
  // `mailpit` port 1025 on the docker network (no auth, no TLS — it's a
  // dev catcher). Stored in the wp_mail_smtp option as the plugin's
  // settings array.
  console.log("Configuring WP Mail SMTP to route through Mailpit…");
  const wpMailSmtpJson = JSON.stringify({
    mail: {
      from_email: "noreply@scorpion.test",
      from_name: "Scorpion Test",
      from_email_force: false,
      from_name_force: false,
      mailer: "smtp",
      return_path: false,
    },
    smtp: {
      autotls: false,
      auth: false,
      host: "mailpit",
      port: 1025,
      encryption: "none",
      user: "",
      pass: "",
    },
  });
  wpCli([
    "option",
    "update",
    "wp_mail_smtp",
    wpMailSmtpJson,
    "--format=json",
  ]);

  // ---- 6c. Install + activate Complianz (cookie consent banner) ----
  // Replaces Scorpion's manage-cookies banner (which we drop from the
  // theme bundle during build because its companion HTML 404s and the
  // script's fallback renders WP's 404 page in a shadow root). Complianz
  // is the most popular free WP consent plugin — auto-detects scripts,
  // jurisdiction-aware (GDPR / CCPA / etc.), and ships with a sensible
  // default banner before the admin finishes the wizard. Admins complete
  // setup at wp-admin → Complianz to customise categories / wording.
  console.log("\nInstalling complianz-gdpr plugin (cookie consent)…");
  wpCli(["plugin", "install", "complianz-gdpr", "--force"]);
  wpCli(["plugin", "activate", "complianz-gdpr"]);

  // ---- 6d. Install + activate Custom Post Type UI + import CPT schema ----
  // CPT UI registers the scorpion_testimonial post type (and any future
  // Scorpion-system CPTs) at WP init so the WXR import in step 7 can land
  // its scorpion_testimonial <item>s without WP rejecting an unknown
  // post_type. Schema lives in outputDir/cptui-export.json; the inner
  // `post_types` / `taxonomies` objects get written directly to the
  // plugin's WP options (CPT UI reads those on every init).
  if (existsSync(cptUiSrc)) {
    console.log("\nInstalling custom-post-type-ui plugin…");
    wpCli(["plugin", "install", "custom-post-type-ui", "--force"]);
    wpCli(["plugin", "activate", "custom-post-type-ui"]);

    console.log("Loading CPT UI schema…");
    const cptUiRaw = readFileSync(cptUiSrc, "utf8");
    const cptUiJson = JSON.parse(cptUiRaw) as {
      post_types?: Record<string, unknown>;
      taxonomies?: Record<string, unknown>;
    };
    wpCli([
      "option",
      "update",
      "cptui_post_types",
      JSON.stringify(cptUiJson.post_types ?? {}),
      "--format=json",
    ]);
    wpCli([
      "option",
      "update",
      "cptui_taxonomies",
      JSON.stringify(cptUiJson.taxonomies ?? {}),
      "--format=json",
    ]);
  }

  // ---- 6c. Install + activate Redirection (only when there's a CSV) ----
  // Redirection owns the 301 rules ingested from Scorpion's
  // #SiteRedirectTable. The build emits redirects.csv only when the table
  // had rows, so the install + import only runs when there's something
  // to import. Admins edit afterwards at Tools → Redirection.
  if (existsSync(redirectsSrc)) {
    console.log("\nInstalling redirection plugin…");
    wpCli(["plugin", "install", "redirection", "--force"]);
    wpCli(["plugin", "activate", "redirection"]);

    // Redirection's tables (wp_redirection_groups, wp_redirection_items)
    // aren't created by `plugin activate` — the plugin normally installs
    // them when an admin first visits Tools → Redirection. The CLI ships
    // `database install` to do the same thing headlessly. Idempotent.
    console.log("Installing redirection database schema…");
    try {
      wpCli(["redirection", "database", "install"]);
    } catch (err) {
      // Older Redirection versions don't ship the `database install`
      // subcommand; fall back to invoking the installer class directly.
      console.log("  database install subcommand unavailable, using fallback…");
      wpCli([
        "eval",
        "if (class_exists('Red_Database')) { (new Red_Database())->apply_upgrade((new Red_Database())->get_latest_database_version()); }",
      ]);
    }

    console.log("Copying redirects.csv into WP container…");
    docker([
      "exec",
      WP_CONTAINER,
      "rm",
      "-f",
      "/var/www/html/scorpion-redirects.csv",
    ]);
    docker([
      "cp",
      redirectsSrc,
      `${WP_CONTAINER}:/var/www/html/scorpion-redirects.csv`,
    ]);
    docker([
      "exec",
      WP_CONTAINER,
      "chown",
      "www-data:www-data",
      "/var/www/html/scorpion-redirects.csv",
    ]);

    console.log("Importing redirects via wp redirection import…");
    // --format=csv is required: the plugin does NOT auto-detect format from
    // the file extension and silently fails to JSON parsing without it.
    // --group=1 targets the default "Redirections" group created by
    // `database install`. The CLI defaults to the first available group
    // when omitted but pinning is explicit and easier to debug.
    wpCli([
      "redirection",
      "import",
      "/var/www/html/scorpion-redirects.csv",
      "--format=csv",
      "--group=1",
    ]);
  } else {
    console.log("\n(no redirects.csv — skipping Redirection plugin)");
  }

  // ---- 7. Copy WXR into the container and import ----
  console.log("\nCopying WXR into container…");
  docker([
    "exec",
    WP_CONTAINER,
    "rm",
    "-f",
    "/var/www/html/scorpion-import.xml",
  ]);
  docker([
    "cp",
    wxrSrc,
    `${WP_CONTAINER}:/var/www/html/scorpion-import.xml`,
  ]);
  docker([
    "exec",
    WP_CONTAINER,
    "chown",
    "www-data:www-data",
    "/var/www/html/scorpion-import.xml",
  ]);

  console.log("\nRunning WXR import (this can take a couple of minutes)…");
  wpCli([
    "import",
    "/var/www/html/scorpion-import.xml",
    "--authors=create",
  ]);

  // ---- 8. Set the imported home page as the WP front page ----
  // Scorpion has a "home" page at `/`; in WP, `/` defaults to the blog
  // listing unless show_on_front is changed. Pick the page named "home"
  // (matches our slug allocation for the `/` path) and pin it.
  console.log("\nPinning front page to the imported home page…");
  // Filter to top-level (parent=0) so we don't accidentally pick up a
  // /style-guide/home/ or similar sub-page that happens to share the
  // post_name "home" within its own parent.
  const homeIdRaw = wpCli(
    [
      "post",
      "list",
      "--post_type=page",
      "--name=home",
      "--post_parent=0",
      "--field=ID",
      "--format=ids",
    ],
    { capture: true },
  ).trim();
  if (homeIdRaw) {
    wpCli(["option", "update", "show_on_front", "page"]);
    wpCli(["option", "update", "page_on_front", homeIdRaw]);
    console.log(`  front page set to post id ${homeIdRaw}`);
  } else {
    console.log("  (no page with slug 'home' found — skipping)");
  }

  // ---- 8b. Assign imported nav menus to theme locations ----
  // The WXR imports the menus as terms ("Primary Menu", "Footer Quick
  // Links"); the theme registers matching locations in functions.php.
  // wp-cli's `menu location assign` is the glue that connects them so
  // wp_nav_menu(['theme_location' => 'primary']) resolves to the
  // imported menu. Idempotent — re-running assigns the same location to
  // the same menu without error.
  console.log("\nAssigning imported nav menus to theme locations…");
  for (const [slug, location] of [
    ["primary-menu", "primary"],
    ["footer-quick-links", "footer-quick-links"],
  ]) {
    try {
      wpCli(["menu", "location", "assign", slug, location], {
        capture: true,
      });
      console.log(`  '${slug}' → ${location}`);
    } catch (err) {
      // The "Footer Quick Links" menu may not exist yet on sites where
      // the build hasn't captured a footer-nav variant; skip silently.
      const detail = err instanceof Error ? err.message : String(err);
      console.log(`  skipped ${slug} → ${location}: ${detail.split("\n")[0]}`);
    }
  }

  // ---- 9. Done ----
  console.log("\n✅ Import complete.");
  console.log(`   Public:  http://localhost:${WP_HOST_PORT}/`);
  console.log(
    `   Admin:   http://localhost:${WP_HOST_PORT}/wp-admin/ (user: ${ADMIN_USER} / pass: ${ADMIN_PASS})`,
  );
  console.log(
    `   Open a page directly, e.g. http://localhost:${WP_HOST_PORT}/about-us/`,
  );
}

main()
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await closeDb().catch(() => {});
    process.exit(1);
  })
  .then(async () => {
    await closeDb().catch(() => {});
  });
