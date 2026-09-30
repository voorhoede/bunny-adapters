/**
 * The end-to-end run. It needs no bunny.net account and no network.
 *
 *   1. Build the showcase with the adapter.
 *   2. Check the build output itself.
 *   3. Serve `dist/client` from a local zone that answers like Bunny Storage.
 *   4. Run the deployed bundle on Deno, which is the Edge Scripting runtime.
 *   5. Run every check from the showcase against it.
 *
 * With `--middleware`, the showcase is built as a middleware script, and it
 * reads its files through a local pull zone origin instead of the Storage API.
 *
 * Usage: node tests/e2e.mjs [--skip-build] [--middleware]
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { startLocalZone } from "../packages/astro/dist/build/local-zone.js";
import { checks } from "../examples/astro-showcase/e2e/checks.mjs";
import { freePort, runChecks, waitForSite } from "./runner.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const showcase = path.join(repo, "examples/astro-showcase");
const dist = path.join(showcase, "dist");
const bundle = path.join(dist, "index.js");
const SIZE_LIMIT = 10 * 1024 * 1024;
const script = process.argv.includes("--middleware") ? "middleware" : "standalone";

let failures = 0;
function check(name, ok, detail = "") {
  const mark = ok ? "\u001b[32mpass\u001b[0m" : "\u001b[31mFAIL\u001b[0m";
  console.log(`  ${mark}  ${name}${detail ? `  \u001b[2m(${detail})\u001b[0m` : ""}`);
  if (!ok) failures++;
}

function haveDeno() {
  return spawnSync("deno", ["--version"], { stdio: "ignore" }).status === 0;
}

if (!haveDeno()) {
  console.error("Deno is not on the PATH. Edge Scripting runs on Deno, so the tests do too.");
  console.error("Install it: curl -fsSL https://deno.land/install.sh | sh");
  process.exit(1);
}

// 1. Build.
if (!process.argv.includes("--skip-build")) {
  console.log(`building the showcase as a ${script} script\n`);
  rmSync(dist, { recursive: true, force: true });
  const build = spawnSync("npm", ["run", "build"], {
    cwd: showcase,
    stdio: "inherit",
    env: { ...process.env, SHOWCASE_SCRIPT: script },
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

// 2. The build output.
console.log("\nbuild output");
check("dist/index.js exists", existsSync(bundle));
if (!existsSync(bundle)) process.exit(1);

check("dist/server was cleared away", !existsSync(path.join(dist, "dist/server")));
check(
  "the prerendered page is in dist/client",
  existsSync(path.join(dist, "client/about/index.html")),
);
check("the 404 page is in dist/client", existsSync(path.join(dist, "client/404.html")));

const code = readFileSync(bundle, "utf8");
check("no node-only server was pulled in", !code.includes("@hono/node-server"));
check(
  "the client file list is inlined",
  code.includes('"404.html"') && code.includes('"about/index.html"'),
);

const manifest = JSON.parse(readFileSync(path.join(showcase, ".bunny/build.json"), "utf8"));
check(`the manifest names a ${script} script`, manifest.script?.type === script);

const size = statSync(bundle).size;
check("one file, under the 10 MB limit", size < SIZE_LIMIT, `${(size / 1024).toFixed(0)} kB`);

// 3 and 4. A storage zone and the bundle on Deno.
const zone = await startLocalZone({ dir: path.join(dist, "client"), zone: "e2e" });
// Sessions get a zone of their own, over a folder outside the client build.
const sessions = await startLocalZone({
  dir: path.join(dist, ".test-sessions"),
  zone: "e2e-sessions",
});
// A middleware script reads its files through the pull zone's origin.
const origin =
  script === "middleware"
    ? await startLocalZone({ dir: path.join(dist, "client"), origin: true })
    : undefined;
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

console.log(`\nrunning the bundle on Deno at ${baseUrl}`);
const server = spawn("deno", ["run", "-A", bundle], {
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...process.env,
    PORT: String(port),
    BUNNY_HOSTNAME: "127.0.0.1",
    BUNNY_STORAGE_ZONE: zone.zone,
    BUNNY_STORAGE_HOST: zone.host,
    BUNNY_STORAGE_KEY: "e2e",
    BUNNY_SESSION_ZONE: sessions.zone,
    BUNNY_SESSION_HOST: sessions.host,
    BUNNY_SESSION_KEY: "e2e",
    ...(origin ? { BUNNY_ORIGIN_URL: origin.host } : {}),
  },
});

try {
  await waitForSite(baseUrl, { isAlive: () => server.exitCode === null });
  console.log("\nchecks");
  failures += await runChecks(checks, { baseUrl, mode: "local" });
} catch (error) {
  console.error(`\n${error.message}`);
  failures++;
} finally {
  server.kill();
  await Promise.all([zone.close(), sessions.close(), origin?.close()]);
}

// The session check above has run by now. dist/client is what a deploy
// uploads, so a session must never have landed in it.
console.log("\nafter the run");
check(
  "no session was written into the folder a deploy uploads",
  !existsSync(path.join(dist, "client/_sessions")),
);

console.log(
  failures === 0
    ? "\n\u001b[32mall checks passed\u001b[0m"
    : `\n\u001b[31m${failures} check(s) failed\u001b[0m`,
);
process.exit(failures === 0 ? 0 : 1);
