#!/usr/bin/env node
/**
 * Local development orchestrator for the MarkSnip extension.
 *
 * Chrome:  uses Playwright's launchPersistentContext to load the unpacked
 *          extension via --load-extension (the same mechanism our e2e tests
 *          use). Reloads happen programmatically via chrome.runtime.reload().
 *
 * Firefox: uses web-ext run (Mozilla's official tool), which works correctly
 *          for Firefox. Reloads are triggered via the --watch-file sentinel.
 *
 *   npm run dev               # chrome (default)
 *   npm run dev:chrome
 *   npm run dev:firefox
 *   node scripts/dev.js --browser=firefox --url=https://example.com
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { buildBrowserManifests } = require("./generate-browser-manifests");

const SRC_DIR = path.resolve(__dirname, "..");
const BUILD_ROOT = path.join(SRC_DIR, ".build");

const WATCH_IGNORED_TOP = new Set([
  "node_modules",
  ".build",
  "tests",
  "scripts",
  "web-ext-artifacts",
  "coverage",
  "test-artifacts",
  "test-results",
  ".web-extension-id",
]);

const DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { browser: "chrome", url: null, forwarded: [] };
  for (const token of argv.slice(2)) {
    if (token.startsWith("--browser=")) args.browser = token.slice(10);
    else if (token.startsWith("--url=")) args.url = token.slice(6);
    else if (token.startsWith("--no-")) args.forwarded.push(token);
    else if (token.startsWith("--")) {
      const [key, value] = token.slice(2).split("=");
      if (value === undefined) args.forwarded.push(`--${key}`);
      else args.forwarded.push(`--${key}`, value);
    }
  }
  if (args.browser !== "chrome" && args.browser !== "firefox") {
    throw new Error(`--browser must be chrome or firefox, got "${args.browser}"`);
  }
  return args;
}

function log(tag, message) {
  const stamp = new Date().toISOString().slice(11, 23);
  // eslint-disable-next-line no-console
  console.log(`[${stamp}] ${tag} ${message}`);
}

function rebuild(browser) {
  const before = Date.now();
  buildBrowserManifests({
    srcDir: SRC_DIR,
    buildRoot: BUILD_ROOT,
    logger: (line) => log("build  ", line.replace(SRC_DIR + "/", "")),
  });
  log("build  ", `${browser} rebuilt in ${Date.now() - before}ms`);
}

function watchSrc(onChange) {
  let timer = null;
  const watcher = fs.watch(SRC_DIR, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const top = filename.split(path.sep)[0];
    if (WATCH_IGNORED_TOP.has(top)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange(filename);
    }, DEBOUNCE_MS);
  });
  watcher.on("error", (err) => {
    log("watch  ", `error: ${err.message}`);
    process.exit(1);
  });
  return watcher;
}

// ---------------------------------------------------------------------------
// Chrome strategy: Playwright launchPersistentContext
// ---------------------------------------------------------------------------

async function launchChrome(targetDir, url) {
  const { chromium } = require("@playwright/test");

  const profileDir = path.join(BUILD_ROOT, ".dev-profile-chrome");
  fs.mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${targetDir}`,
      `--load-extension=${targetDir}`,
      "--window-size=1280,900",
    ],
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(url).catch(() => {});

  // Wait for the service worker so we can confirm the extension loaded
  let [sw] = context.serviceWorkers();
  if (!sw) {
    sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
  }
  const extensionId = new URL(sw.url()).host;

  return { context, page, extensionId };
}

async function reloadChrome(targetDir, url, prevContext) {
  // chrome.runtime.reload() doesn't reliably restart the service worker in
  // Playwright's persistent context with --load-extension. Full browser restart
  // is ~3s but guarantees a clean reload. The persistent profile preserves
  // extension storage, cookies, etc.
  await prevContext.close().catch(() => {});
  return launchChrome(targetDir, url);
}

// ---------------------------------------------------------------------------
// Firefox strategy: web-ext (unchanged, works correctly for Firefox)
// ---------------------------------------------------------------------------

function startFirefox(targetDir, url, forwarded) {
  const sentinel = path.join(targetDir, ".reload-trigger");
  const webextBin = path.join(SRC_DIR, "node_modules", ".bin", "web-ext");

  const webExtArgs = [
    "run",
    "--no-config-discovery",
    "--source-dir",
    targetDir,
    "--watch-file",
    sentinel,
    "--target",
    "firefox-desktop",
    ...(url ? ["--start-url", url] : []),
    ...forwarded,
  ];

  log("firefox", `spawning: web-ext ${webExtArgs.join(" ")}`);

  const child = spawn(webextBin, webExtArgs, {
    stdio: "inherit",
  });

  child.on("exit", (code) => {
    log("firefox", `web-ext exited with ${code}`);
    process.exit(code ?? 0);
  });

  // Firefox still needs the sentinel touched after each rebuild
  return {
    afterRebuild: () => {
      fs.writeFileSync(sentinel, String(Date.now()));
    },
    child,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const url = args.url || "https://en.wikipedia.org/wiki/Web_scraping";

  // eslint-disable-next-line no-console
  console.log(
    `
 MarkSnip dev mode
 -----------------
 browser : ${args.browser}
 build   : ${path.relative(process.cwd(), path.join(BUILD_ROOT, args.browser))}
 start   : ${url}

 Save any source file -> rebuild -> reload.
 Ctrl+C to stop.
`
  );

  // Initial build
  rebuild(args.browser);

  let watcher;
  let shutdownFns = [];

  if (args.browser === "chrome") {
    const targetDir = path.join(BUILD_ROOT, "chrome");
    log("chrome ", "launching browser...");
    let session = await launchChrome(targetDir, url);
    log("chrome ", `extension loaded (id: ${session.extensionId})`);

    let reloading = false;
    watcher = watchSrc(async (filename) => {
      if (reloading) return;
      reloading = true;
      log("change ", filename);
      rebuild("chrome");
      log("reload ", "restarting browser with fresh build...");
      session = await reloadChrome(targetDir, url, session.context);
      log("reload ", `done (id: ${session.extensionId})`);
      reloading = false;
    });

    shutdownFns.push(async () => {
      await session.context.close().catch(() => {});
    });
  } else {
    const targetDir = path.join(BUILD_ROOT, "firefox");
    const ff = startFirefox(targetDir, url, args.forwarded);

    watcher = watchSrc((filename) => {
      log("change ", filename);
      rebuild("firefox");
      ff.afterRebuild();
    });

    shutdownFns.push(() => {
      if (!ff.child.killed) ff.child.kill("SIGTERM");
    });
  }

  const shutdown = async (sig) => {
    log("dev    ", `${sig} received, shutting down`);
    watcher.close();
    for (const fn of shutdownFns) await fn();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log("dev    ", `fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
