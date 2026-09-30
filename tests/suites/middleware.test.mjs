/**
 * The script as middleware, in front of a pull zone whose origin is the storage
 * zone.
 *
 * Astro's own routes are rendered before the request reaches storage. Every
 * other request is passed through to the pull zone's origin at the path of this
 * deploy's folder, so the pull zone reads the file from the nearest storage
 * replica instead of the script reading it from the main region.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { after, before, describe, it } from "node:test";
import { serveFixture, textOf } from "../harness.mjs";

const PREFIX = "deploys/a1b2c3d4";

describe("middleware", () => {
  /** @type {Awaited<ReturnType<typeof serveFixture>>} */
  let site;

  before(async () => {
    site = await serveFixture("middleware", { assetPrefix: PREFIX });
  });
  after(() => site?.close());

  /** What reached the pull zone's origin, and the Storage API, while `run` ran. */
  async function requestsDuring(run) {
    const origin = site.origin.requests.length;
    const api = site.zone.requests.length;
    const result = await run();
    return {
      result,
      origin: site.origin.requests.slice(origin),
      api: site.zone.requests.slice(api),
    };
  }

  it("tells the deploy command it built a middleware script", () => {
    const manifest = site.manifest();
    assert.equal(manifest.kind, "ssr");
    assert.equal(manifest.script.type, "middleware");
    assert.deepEqual(manifest.requires.pullZone, {
      disableCookies: false,
      enableSmartCache: false,
      enableCacheSlice: false,
    });
  });

  it("registers origin middleware on bunny.net, not a request handler", () => {
    // The platform's own entry point, with nothing else of bunny.net around it.
    const probe = `
      let middlewares, served = 0;
      globalThis.Bunny = { v1: { registerMiddlewares(m) { middlewares = m; }, serve() { served += 1; } } };
      await import("file://${site.dist}/index.js");
      console.log(JSON.stringify({ served, request: middlewares?.onOriginRequest?.length, response: middlewares?.onOriginResponse?.length }));
    `;
    const run = spawnSync("deno", ["eval", probe], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout.trim().split("\n").at(-1)), {
      served: 0,
      request: 1,
      response: 1,
    });
  });

  it("renders an on-demand route without asking the origin or storage", async () => {
    const { result: first, origin, api } = await requestsDuring(() => site.get("/live"));
    const second = await site.get("/live");
    assert.equal(first.status, 200);
    assert.notEqual(textOf(first.body, "rendered-at"), textOf(second.body, "rendered-at"));
    assert.equal(first.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(origin, []);
    assert.deepEqual(api, []);
  });

  it("accepts a POST from the site itself, at the URL the visitor asked for", async () => {
    // On bunny.net the hooks see the origin's URL, and the visitor's host only in
    // the host header. Astro refuses a POST whose Origin is not the request's.
    const response = await site.get("/api/echo", {
      method: "POST",
      headers: { origin: site.baseUrl, "content-type": "text/plain" },
      body: "twelve bytes",
    });
    assert.equal(response.status, 200, response.body);
    assert.deepEqual(JSON.parse(response.body), { url: `${site.baseUrl}/api/echo`, received: 12 });
  });

  it("renders an endpoint", async () => {
    const response = await site.get("/api/now");
    assert.equal(response.status, 200);
    assert.equal(typeof JSON.parse(response.body).now, "number");
  });

  it("passes a prerendered page through to the origin, inside this deploy's folder", async () => {
    const { result: page, origin, api } = await requestsDuring(() => site.get("/about"));
    assert.equal(page.status, 200);
    assert.equal(textOf(page.body, "prerendered"), "yes");
    assert.deepEqual(origin, [`/${PREFIX}/about/index.html`]);
    assert.deepEqual(api, []);
  });

  it("gives a page from the origin the page's own headers", async () => {
    const page = await site.get("/about");
    assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(page.headers.get("cache-control"), "public, max-age=60");
    assert.match(page.headers.get("content-security-policy") ?? "", /sha256-/);
  });

  it("gives an asset from the origin the asset lifetime and its content type", async () => {
    const page = await site.get("/about");
    const href = page.body.match(/href="(\/_astro\/[^"]+\.css)"/)?.[1];
    assert.ok(href, "the page links no stylesheet");

    const { result: asset, origin } = await requestsDuring(() => site.get(href));
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("content-type"), "text/css; charset=utf-8");
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(asset.headers.get("content-security-policy"), null);
    assert.deepEqual(origin, [`/${PREFIX}${href}`]);
  });

  it("answers a redirect Astro turned into a page, without asking the origin", async () => {
    const { result, origin } = await requestsDuring(() => site.get("/old"));
    assert.equal(result.status, 301);
    assert.equal(result.headers.get("location"), "/about");
    assert.deepEqual(origin, []);
  });

  it("shows the site's 404 page for a path the build never produced, without asking the origin", async () => {
    const { result, origin } = await requestsDuring(() => site.get("/nothing-here"));
    assert.equal(result.status, 404);
    assert.equal(textOf(result.body, "not-found"), "nothing here");
    assert.deepEqual(origin, []);
  });

  it("keeps the origin's own status on a conditional request", async () => {
    const first = await site.get("/robots.txt");
    const etag = first.headers.get("etag");
    assert.ok(etag, "the origin sent no etag");

    const again = await site.get("/robots.txt", { headers: { "if-none-match": etag } });
    assert.equal(again.status, 304);
  });

  it("forwards a range request to the origin", async () => {
    // Measured on bunny.net on 2026-09-30, a storage-origin pull zone answered a
    // visitor's range with the whole file. This checks the script's own part:
    // it asks for the range and keeps the origin's 206.
    const piece = await site.get("/large.txt", { headers: { range: "bytes=0-99" } });
    assert.equal(piece.status, 206);
    assert.equal(piece.body.length, 100);
    assert.match(piece.headers.get("content-range") ?? "", /^bytes 0-99\//);
  });

  it("refuses to write to a stored object", async () => {
    const { result, origin } = await requestsDuring(() => site.get("/about", { method: "POST" }));
    assert.equal(result.status, 405);
    assert.deepEqual(origin, []);
  });

  it("never lets the origin serve anything outside this deploy's folder", async () => {
    // The origin is the whole storage zone. Through the script, a visitor only
    // reaches this deploy's files.
    for (const path of [`/${PREFIX}/about/index.html`, "/_sessions/abc.json"]) {
      const { result, origin } = await requestsDuring(() => site.get(path));
      assert.equal(result.status, 404, path);
      assert.deepEqual(origin, [], path);
    }
  });

  it("keeps a path that climbs out inside this deploy's folder", async () => {
    // `fetch` resolves `..` before sending, so the path goes out as written here.
    const raw = (path) =>
      new Promise((resolve, reject) => {
        request(site.baseUrl, { path }, (response) => {
          response.resume();
          response.on("end", resolve);
        })
          .on("error", reject)
          .end();
      });
    for (const path of [
      "/../../about/index.html",
      "/..%2f..%2fdeploys/other/about/index.html",
      "/%2e%2e/%2e%2e/secret.txt",
    ]) {
      const { origin } = await requestsDuring(() => raw(path));
      assert.ok(
        origin.every((request) => request.startsWith(`/${PREFIX}/`)),
        `${path} reached ${origin}`,
      );
    }
  });
});
