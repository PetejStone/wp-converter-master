import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { desc, eq, isNotNull } from "drizzle-orm";
import { closeDb, db } from "../db/client";
import { jobs } from "../db/schema";

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
