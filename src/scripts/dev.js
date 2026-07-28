#!/usr/bin/env node
/**
 * Local development orchestrator for the MarkSnip extension.
 *
 * One command -> rebuild .build/<browser>/ on every src/ change, then signal
 * web-ext to reload the extension. web-ext is told to watch only the sentinel
 * file (--watch-file) so reloads never fire mid-rebuild.
 *
 *   npm run dev               # chrome, default
 *   npm run dev:chrome        # explicit
 *   npm run dev:firefox       # firefox (uses background.scripts[] manifest)
 *   node scripts/dev.js --browser=firefox --url=https://example.com --verbose
 *
 * Any unknown --flag is forwarded to web-ext (e.g. --chromium-binary, --bc).
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { buildBrowserManifests } = require("./generate-browser-manifests");

const SRC_DIR = path.resolve(__dirname, "..");
const BUILD_ROOT = path.join(SRC_DIR, ".build");

// Anything under these top-level src/ entries should NOT trigger an extension
// rebuild. tests/ and scripts/ don't ship in the extension; node_modules and
// .build are obvious; web-ext-artifacts is output-only.
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

function parseArgs(argv) {
  const args = { browser: "chrome", url: null, verbose: false, forwarded: [] };
  for (const token of argv.slice(2)) {
    if (token.startsWith("--browser=")) args.browser = token.slice(10);
    else if (token.startsWith("--url=")) args.url = token.slice(6);
    else if (token === "--verbose") args.verbose = true;
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
  // buildBrowserManifests rewrites BOTH chrome and firefox dirs. We only need
  // the active one, but rebuilding both is cheap (~100ms) and keeps the other
  // browser's build warm for a quick `npm run dev:firefox` switch.
  buildBrowserManifests({
    srcDir: SRC_DIR,
    buildRoot: BUILD_ROOT,
    logger: (line) => log("build  ", line.replace(SRC_DIR + "/", "")),
  });
  const targetDir = path.join(BUILD_ROOT, browser);
  const sentinel = path.join(targetDir, ".reload-trigger");
  fs.writeFileSync(sentinel, String(Date.now()));
  log("build  ", `${browser} rebuilt in ${Date.now() - before}ms (sentinel touched)`);
}

function watchSrc(onChange) {
  let timer = null;
  // Recursive fs.watch is supported on macOS, Windows, and Linux (node >=19).
  // We're on node 20 in CI and locally. Fall back is not needed.
  const watcher = fs.watch(SRC_DIR, { recursive: true }, (event, filename) => {
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

function spawnWebExt(browser, url, forwarded, verbose) {
  const targetDir = path.join(BUILD_ROOT, browser);
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
    browser === "firefox" ? "firefox-desktop" : "chromium",
    ...(url ? ["--start-url", url] : []),
    ...forwarded,
  ];

  if (verbose) log("web-ext", `spawn: web-ext ${webExtArgs.join(" ")}`);

  const child = spawn(webextBin, webExtArgs, {
    stdio: "inherit",
    env: { ...process.env, WEB_EXT_TARGET: browser },
  });

  child.on("exit", (code) => {
    log("web-ext", `exited with ${code}`);
    process.exit(code ?? 0);
  });

  return child;
}

function main() {
  const args = parseArgs(process.argv);
  const url = args.url || "https://en.wikipedia.org/wiki/Web_scraping";

  // eslint-disable-next-line no-console
  console.log(
    `
 MarkSnip dev mode
 -----------------
 browser : ${args.browser}
 source  : ${path.relative(process.cwd(), SRC_DIR)}
 build   : ${path.relative(process.cwd(), path.join(BUILD_ROOT, args.browser))}
 start   : ${url}

 Saving any source file rebuilds the extension and reloads it.
 Ctrl+C stops web-ext and this watcher.
`
  );

  rebuild(args.browser);
  const child = spawnWebExt(args.browser, url, args.forwarded, args.verbose);
  const watcher = watchSrc((filename) => {
    log("change ", filename);
    rebuild(args.browser);
  });

  const shutdown = (sig) => {
    log("dev    ", `${sig} received, shutting down`);
    watcher.close();
    if (!child.killed) child.kill(sig);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
