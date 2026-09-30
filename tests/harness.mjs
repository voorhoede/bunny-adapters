/**
 * Build one fixture, and serve it the way bunny.net does.
 *
 * The showcase proves one configuration very well. A real project changes the
 * configuration, so the adapter needs a project per configuration. That is how
 * a framework's own adapters test theirs, and it is what this file makes
 * cheap.
 *
 * A fixture is a complete Astro project under `tests/fixtures/<name>`. It needs
 * no install of its own: Node walks up to the repository's own `node_modules`,
 * which holds `astro` and a link to the adapter.
 *
 * ```js
 * const site = await buildFixture("base-path");
 * after(() => site.close());
 * const page = await site.get("/docs/about");
 * ```
 *
 * Set `SKIP_BUILD=1` to reuse the last build while you write a check.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { startLocalZone } from "../packages/astro/dist/build/local-zone.js";
import { freePort, waitForSite } from "./runner.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const astroBin = path.join(repo, "node_modules/astro/bin/astro.mjs");

/** True when Deno is on the PATH. Edge Scripting runs on Deno, so the tests do. */
export function haveDeno() {
  return spawnSync("deno", ["--version"], { stdio: "ignore" }).status === 0;
}

/** Every file under `dir`, as POSIX paths relative to it. */
async function listFiles(dir, base = dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return listFiles(full, base);
      return [path.relative(base, full).split(path.sep).join("/")];
    }),
  );
  return nested.flat();
}

/**
 * Build a fixture, and return what the build produced.
 *
 * A test that only reads the build output uses this, and it costs no Deno
 * process. The build log comes back too, because some of what the adapter
 * promises it says in the log and nowhere else.
 */
export async function buildFixture(name, { expectFailure = false } = {}) {
  const dir = path.join(repo, "tests/fixtures", name);
  if (!existsSync(dir)) throw new Error(`No fixture called "${name}".`);

  const dist = path.join(dir, "dist");
  const bundle = path.join(dist, "index.js");

  let log = "";
  let status = 0;
  if (!process.env.SKIP_BUILD || !existsSync(bundle)) {
    const result = spawnSync(process.execPath, [astroBin, "build"], {
      cwd: dir,
      encoding: "utf8",
      // A fixture must not inherit the credentials of a live run.
      env: { ...process.env, BUNNY_STORAGE_ZONE: "", BUNNY_STORAGE_KEY: "", FORCE_COLOR: "0" },
    });
    log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    status = result.status ?? 1;
    if (status !== 0 && !expectFailure) {
      throw new Error(`Building the "${name}" fixture failed:\n${log}`);
    }
  }

  return {
    name,
    dir,
    dist,
    /** Everything the build printed. Some promises live only in the log. */
    log,
    /** The build's exit status. Useful only with `expectFailure`. */
    status,
    /** The deployable file, as text. */
    code: () => (existsSync(bundle) ? readFileSync(bundle, "utf8") : ""),
    /** Every file the build put in `dist/client`. */
    files: () => listFiles(path.join(dist, "client")),
    /** One file out of `dist/client`. */
    read: (relative) => readFileSync(path.join(dist, "client", relative), "utf8"),
    hasBundle: () => existsSync(bundle),
    /** What the build told `bunny sites deploy`. The CLI reads nothing else. */
    manifest: () => JSON.parse(readFileSync(path.join(dir, ".bunny/build.json"), "utf8")),
  };
}

/**
 * Build a fixture, then run its bundle on Deno behind a local storage zone.
 *
 * This is the whole deployment, minus the network: the file that would be
 * deployed, running on the runtime it would run on, reading the zone it would
 * read.
 */
export async function serveFixture(name, { env = {}, assetPrefix, ...options } = {}) {
  const built = await buildFixture(name, options);
  if (!built.hasBundle()) throw new Error(`The "${name}" fixture built no bundle.`);

  // `bunny sites deploy` puts each deploy in its own folder and tells the script the
  // name, so a published release can only read the files it was built with.
  // Reproduce that layout: the zone root holds `<prefix>/`, and nothing else.
  let clientDir = path.join(built.dist, "client");
  if (assetPrefix) {
    const root = path.join(built.dist, ".test-prefixed");
    await rm(root, { recursive: true, force: true });
    await cp(clientDir, path.join(root, assetPrefix), { recursive: true });
    clientDir = root;
  }

  const zone = await startLocalZone({ dir: clientDir, zone: "fixture" });
  // Sessions never touch dist/client. That folder is what a deploy uploads,
  // so a session written by a test must not end up looking like an asset.
  const sessions = await startLocalZone({
    dir: path.join(built.dist, ".test-sessions"),
    zone: "fixture-sessions",
  });
  // A middleware build sits in front of a pull zone whose origin is the storage
  // zone, so the files reach it through the pull zone, not the Storage API.
  const middleware = built.manifest().script?.type === "middleware";
  const origin = middleware ? await startLocalZone({ dir: clientDir, origin: true }) : undefined;
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const server = spawn("deno", ["run", "-A", path.join(built.dist, "index.js")], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      BUNNY_HOSTNAME: "127.0.0.1",
      BUNNY_STORAGE_ZONE: zone.zone,
      BUNNY_STORAGE_HOST: zone.host,
      BUNNY_STORAGE_KEY: "fixture",
      BUNNY_SESSION_ZONE: sessions.zone,
      BUNNY_SESSION_HOST: sessions.host,
      BUNNY_SESSION_KEY: "fixture",
      ...(assetPrefix ? { BUNNY_ASSET_PREFIX: assetPrefix } : {}),
      ...(origin ? { BUNNY_ORIGIN_URL: origin.host } : {}),
      ...env,
    },
  });

  // Kept so a failing check can say what the script complained about.
  let stderr = "";
  server.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });

  const close = async () => {
    server.kill();
    await Promise.all([zone.close(), sessions.close(), origin?.close()]);
  };

  try {
    await waitForSite(baseUrl, { isAlive: () => server.exitCode === null });
  } catch (error) {
    await close();
    throw new Error(`${error.message}\n${stderr}`);
  }

  /**
   * Fetch a path. Redirects are never followed, because the status and the
   * `Location` header are usually the thing under test.
   */
  const get = async (pathname, init = {}) => {
    const response = await fetch(new URL(pathname, baseUrl), {
      redirect: init.redirect ?? "manual",
      ...init,
    });
    const body = init.method === "HEAD" ? "" : await response.text();
    return { status: response.status, headers: response.headers, body, response };
  };

  return { ...built, baseUrl, get, zone, origin, stderr: () => stderr, close };
}

/** The text inside the element with this id. Enough for a fixture page. */
export function textOf(html, id) {
  const pattern = new RegExp(`id=["']${id}["'][^>]*>([\\s\\S]*?)<`, "i");
  return html.match(pattern)?.[1]?.trim();
}

/** The value of an attribute on the element with this id. */
export function attrOf(html, id, attribute) {
  const tag = html.match(new RegExp(`<[^>]*id=["']${id}["'][^>]*>`, "i"))?.[0];
  return tag?.match(new RegExp(`${attribute}=["']([^"']*)["']`, "i"))?.[1];
}
