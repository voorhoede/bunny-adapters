# @bunny.net/astro-adapter

Run [Astro](https://astro.build/) on
[bunny.net Edge Scripting](https://bunny.net/docs/scripting).

> ### Status: lab, work in progress
>
> **This is version 0.1.0, the first release.** The adapter's options, its build
> output, and the `.bunny/build.json` it writes can all change in a minor
> release. So pin the version you install, and read the changelog before you
> raise it. Do not run this in production.

Astro's server renders pages and runs API routes inside the Edge Script, per
request, on a node near your visitor. The build's client assets and prerendered
pages are read from [Bunny Storage](https://bunny.net/docs/storage).

```
browser ──▶ pull zone ──▶ Edge Script (Astro SSR)
                              │
                              └─ assets and prerendered pages ─▶ Bunny Storage
```

**[See it running](https://astro-ssr-demo.bunny.run)** ·
[source of that site](https://github.com/BunnyWay/bunny-adapters/tree/main/examples/astro-showcase)
· [guide](https://bunny.net/docs/scripting/frameworks/astro)

## Install

```bash
npx astro add @bunny.net/astro-adapter
```

That installs the adapter and writes the config. To do it yourself:

```bash
npm install @bunny.net/astro-adapter
```

Either way, the config is the same:

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import bunny from "@bunny.net/astro-adapter";

export default defineConfig({
  output: "server",
  adapter: bunny(),
});
```

## Deploy

```bash
bunny lab deploy astro
```

That is the whole thing. The [bunny CLI](https://bunny.net/docs/cli) builds the
site, creates what it needs the first time, uploads the build, and publishes the
script:

- a storage zone for the build's files and the site's sessions,
- an Edge Script for Astro's server, with the pull zone that gives the site its
  URL,
- every variable the script reads, set from what the CLI already knows. No
  password passes through your terminal.

Each deploy goes to its own folder in the zone, and the build writes
`.bunny/build.json` so the CLI knows what to send where. So a published release
can only read the files it was built against.

```bash
bunny lab deploy astro          # build and publish
bunny lab undeploy astro        # delete the app and everything it runs on
```

Those two commands are the whole interface. `lab` says it is still being shaped,
so expect to update a workflow built on it.

The CLI also applies the pull zone settings this adapter asks for, and says which
ones it changed: cookies pass through, Smart Cache goes off so the adapter's own
cache headers count, and the zone's cache override goes off so they reach a
visitor unchanged.

<details>
<summary>Deploying by hand</summary>

Nothing stops you. Upload `dist/client` to a storage zone, deploy `dist/index.js`
with `bunny scripts deploy`, and set the variables in the next section yourself.
Both halves have to go out together: Astro renames its CSS and JavaScript
bundles whenever they change, so a script deployed against last build's files
loses its styles.

Set `BUNNY_ASSET_PREFIX` when the files are in a folder rather than at the zone
root. `bunny lab deploy astro` sets it for you, in the bundle itself.

</details>

## Configure the script

`bunny lab deploy astro` sets all of these. The table is here for a deploy you
run yourself, and for reading a script's settings in the dashboard.

| Variable             | Purpose                                                          |
| -------------------- | ---------------------------------------------------------------- |
| `BUNNY_STORAGE_ZONE` | The zone holding `dist/client`                                   |
| `BUNNY_STORAGE_HOST` | The zone's regional endpoint. Defaults to `storage.bunnycdn.com` |
| `BUNNY_STORAGE_KEY`  | The zone's **read-only** password                                |
| `BUNNY_ASSET_PREFIX` | The folder inside the zone that holds this deploy                |
| `BUNNY_SESSION_ZONE` | Only for sessions. A zone the script may write to                |
| `BUNNY_SESSION_KEY`  | Only for sessions. That zone's **write** password                |
| `BUNNY_API_KEY`      | Only for cache purging                                           |
| `BUNNY_PULLZONE_ID`  | Only for cache purging                                           |

The script only reads the asset zone, so it gets the read-only password, never
the one that can write or delete. No password is ever an adapter option: it
would end up in the bundle.

```bash
bunny scripts env set BUNNY_API_KEY <key> --secret
```

## Local development

`astro dev` works as usual for day-to-day work.

`astro preview` runs the file you are about to deploy. A local storage zone
stands in for Bunny Storage, so assets, prerendered pages and sessions all work
with no account and no network:

```bash
npm run build
npx astro preview
```

It needs [Deno](https://deno.com/) 2, because Deno is the Edge Scripting
runtime. The `cdn-` request headers only exist on the bunny.net network, so
anything your code reads from them is absent locally.

A [build with no server](#a-site-with-no-server) has no file to run, so
`astro preview` serves `dist/client` from Astro's own static server. That needs
no Deno.

## What works

| Astro feature                                                | Supported                                                |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| Server-rendered pages                                        | Yes                                                      |
| `src/pages/api/` endpoints                                   | Yes                                                      |
| `src/middleware.ts`                                          | Yes                                                      |
| Dynamic routes and server islands                            | Yes                                                      |
| `Astro.request`, `Astro.locals`, `Astro.url`, `Astro.params` | Yes                                                      |
| `Astro.clientAddress`                                        | Yes, from `x-forwarded-for`                              |
| `Astro.cookies`, including `set()`                           | Yes, [see the note](#cookies)                            |
| `Astro.session`                                              | Yes, stored in a storage zone                            |
| `export const prerender = true`                              | Yes, served from Storage                                 |
| Prerendered `404.astro` and `500.astro`                      | Yes, served from Storage                                 |
| `routeRules` and cache purging                               | Yes. [Turn Smart Cache off](#turn-smart-cache-off-first) |
| Image transformation                                         | [Not yet](#images). Optimizer cannot read a script       |
| Range requests on a stored object                            | Yes, [see below](#large-files-and-range-requests)        |
| `node:fs` and the other built-ins Deno provides              | Yes. [See below](#node-built-ins)                        |
| `astro:env` secrets                                          | Yes, from script environment variables                   |
| `astro preview`                                              | Yes. With Deno for a server build                        |
| Static page headers, such as a CSP                           | Yes, [see below](#a-site-with-no-server)                 |
| `sharp` image service                                        | No. Native binaries cannot run on the edge               |
| Edge middleware as a separate function                       | No. Middleware runs inside the script                    |
| The script as a Bunny middleware script                      | Yes, [see below](#middleware-mode)                       |
| i18n domains                                                 | Untested. Tell us if you need it                         |

## A site with no server

A build whose every route is prerendered deploys no script. Astro reports it as
a static build, the adapter hands that answer back, and `bunny sites deploy` uploads
`dist/client` to a storage zone. The `bunny sites` router serves it, and nothing
is invoked per request:

```
[@bunny.net/astro-adapter] Every route is prerendered, so this build deploys no
script: `bunny sites deploy` uploads dist/client, and the site is served as files.
```

Files alone cannot answer a 404 with a page, send a redirect, or add a header.
The router does all three, for every framework, and it learns what to do from
three file names, the same three a static host reads:

| The router reads | What it does with it                                        |
| ---------------- | ----------------------------------------------------------- |
| `404.html`       | Answers a path the build never produced, with status 404    |
| `_redirects`     | Sends a redirect with a real status, not a `<meta>` refresh |
| `_headers`       | Adds the headers Bunny Storage cannot hold, such as a CSP   |

`404.html` is your own `404.astro`. The build writes the other two, from your
`redirects` config and from the headers Astro asks the host to set, and it names
the hashed asset directory in `_headers` so those files can be cached forever:

```
# dist/client/_headers
/_astro/*
  Cache-Control: public, max-age=31536000, immutable
/about
  content-security-policy: script-src 'self' 'sha256-…'
```

Astro still writes its own meta-refresh page for each redirect, so a deploy that
never reaches the router sends the visitor on all the same. The rule in
`_redirects` carries `!`, which is what makes the router's 301 win over it.

One case the routes cannot show: a prerendered page holding a `server:defer`
island still needs the script, and Astro reports such a project as a static
build. Say so:

```js
adapter: bunny({ deploy: "server" }),
```

## Middleware mode

By default the script is a standalone script, the pull zone's origin. A file
that misses the cache is read by the script from the storage zone's main
region, wherever the visitor is, so storage replicas never help.

`script: "middleware"` builds a Bunny middleware script instead, for a pull zone
whose origin is the storage zone. Astro's routes still render in the script.
Every other request goes on to the origin, inside the deploy's folder, and the
pull zone reads the file from the nearest storage replica.

```js
adapter: bunny({ script: "middleware" }),
```

Measured on 2026-09-30, with a main region in Frankfurt and a replica in New
York:

| A file missing the cache, median | Standalone | Middleware |
| -------------------------------- | ---------- | ---------- |
| From New York                    | 420 ms     | 90 ms      |
| From Europe                      | 105 ms     | 110 ms     |

So it pays off for visitors far from the main region, with a replica near them.
Near the main region it gains nothing: the script still runs on every cache
miss, files included.

What it asks of the deploy. `bunny lab deploy astro` does not set this up yet,
so for now it is a deploy you run yourself:

- A storage zone with the replication regions your visitors are near.
- An Edge Script of type **Middleware**, with the variables in
  [Configure the script](#configure-the-script). It still reads the prerendered
  404 and 500 pages through the Storage API.
- A pull zone whose origin is the storage zone, with that script attached, the
  script running after the cache, and the cache expiration set to respect the
  origin's `Cache-Control`. Cookies and Smart Cache as in
  [the build manifest](#the-build-manifest).

The pull zone's origin is the whole storage zone, and the script is what keeps
it private: it only sends a request on inside this deploy's folder, and never
to `_sessions/`. A script that throws answers 500; the request does not fall
through to storage.

Two differences from a standalone script:

- A `Range` request that misses the cache was answered with the whole file by
  the pull zone, measured on 2026-09-30, where a standalone script answers 206.
- With `assetManifest: false`, a page path is always read as
  `<route>/index.html`, so a site built with `build.format: "file"` gets 404s.
  Keep the file list on.

## Images

> **Optimizer cannot read from an Edge Script yet.** With Optimizer on, every
> image request that misses the CDN cache answers `523 Origin Connection
Failed`. We measured this on two script-backed pull zones in August 2026, and
> `npm run test:live -- --optimizer` reproduces it. The service below writes the
> right URLs, and nothing serves them yet. Leave `imageService` at its default
> until this is fixed.

Set `imageService: "bunny"` to resize and re-encode with
[Bunny Optimizer](https://bunny.net/docs/optimizer), at the edge, with no build
step and no `sharp`:

```js
bunny({
  imageService: "bunny",
  image: {
    widths: [360, 720, 1080], // used to build a srcset
    quality: 82,
    maxWidth: 3840, // a crafted URL cannot ask for more
  },
});
```

```astro
---
import { Image } from "astro:assets";
import hero from "../assets/hero.png";
---

<Image src={hero} widths={[360, 720, 1080]} alt="" />
```

Turn Optimizer on for the pull zone first. It is a paid feature, so the adapter
never enables it for you, and the default stays `"noop"`. Without Optimizer the
parameters are ignored and the original image is served.

Optimizer only works on files your own pull zone serves, so an image on another
host passes through untouched.

## Large files and range requests

A stored object can be fetched in pieces. The script answers a `Range` request
with `206` and a `Content-Range`, and it says `Accept-Ranges: bytes` on every
object it serves out of Bunny Storage.

That header is the part that matters. A pull zone will not answer a range from
its cache, and will not slice an object, unless the origin says it accepts
ranges. Without it a video is only seekable once it is fully cached, and a
player has to download the whole file to skip ahead.

For a large file that is not cached yet, turn on **Optimize for large object
delivery** in the pull zone's caching settings. It fetches the object in chunks,
so the first request is seekable too:

```bash
bunny api POST /pullzone/<pull-zone-id> --body '{"EnableCacheSlice": true}'
```

The script also passes `If-None-Match` and `If-Modified-Since` through, so a
browser and the pull zone both revalidate with a `304` instead of downloading
the object again.

## Sessions

`Astro.session` works out of the box. Each session is one object in a Bunny
Storage zone, so every edge node reads the same value.

`bunny lab deploy astro` sets this up: sessions go under `_sessions/` in the app's own
storage zone, which nothing serves, and only the session driver gets the
password that can write.

For a deploy you run yourself, give the script a zone it may write to, and keep
the asset zone read-only:

```bash
bunny scripts env set BUNNY_SESSION_ZONE my-site-sessions
bunny scripts env set BUNNY_SESSION_KEY <write password> --secret
```

Bunny Storage does not expire an object, so `session.ttl` controls the cookie
and not the stored object. Delete old objects yourself if the zone grows.

Pass `sessions: false` to configure your own driver instead.

## Caching and purging

Astro's `routeRules` become the headers the bunny.net CDN reads:

```js
export default defineConfig({
  adapter: bunny(),
  routeRules: {
    "/products/[...slug]": { maxAge: 3600, swr: 600, tags: ["products"] },
  },
});
```

```
Cache-Control: public, max-age=0, must-revalidate, s-maxage=3600, stale-while-revalidate=600
CDN-Tag: products,astro-path:/products/socks
```

`s-maxage` is for the CDN and `max-age` is for the browser. Splitting them is
what makes a purge take effect straight away. Set
`cache: { browserMaxAge: 30 }` if you would rather the browser cached too.

Purge by tag, or by path:

```ts
await Astro.cache.invalidate({ tags: ["products"] });
await Astro.cache.invalidate({ path: "/products/socks" });
```

That calls the [purge API](https://bunny.net/docs/cdn/purge-cache), so the
script needs `BUNNY_API_KEY` and `BUNNY_PULLZONE_ID`. The CLI sets the pull zone
id, and asks before it puts an account API key on a script. Pass `cache: false`
to configure your own provider.

### Turn Smart Cache off first

[Smart Cache](https://bunny.net/docs/cdn/smart-cache) only caches known static
file extensions, and HTML is not one of them. It is on by default, and while it
is on a `routeRules` entry has no effect: the page is rendered again for every
request.

`bunny lab deploy astro` turns it off, because the build manifest asks for that.
For a deploy you run yourself:

```bash
bunny api POST /pullzone/<pull-zone-id> --body '{"EnableSmartCache": false}'
```

Smart Cache exists to stop a misconfigured origin caching a personal page by
accident. The adapter covers that another way: see the next section.

### Why a dynamic page says no-store

A bunny.net pull zone applies its own expiration, by default 30 days, to any
response that carries no `Cache-Control`. With Smart Cache off, that would
cache a page rendered for one visitor and hand it to the next one.

So the adapter sets `Cache-Control: private, no-store` on every server-rendered
response that does not set one itself. A route with a `routeRules` entry, and a
route that sets its own header, both keep what they set. Change the default
with `serverCacheControl` if you know better for your site.

## The edge context

Every page gets `Astro.locals.runtime`:

```ts
const { country, requestId, clientAddress, waitUntil, caches, env } = Astro.locals.runtime;

// Keep working after the response has gone out.
waitUntil(recordVisit(country));
```

Add the types to your project:

```ts
// src/env.d.ts
type BunnyRuntime = import("@bunny.net/astro-adapter").BunnyRuntime;

declare namespace App {
  interface Locals {
    runtime: BunnyRuntime;
  }
}
```

## Node built-ins

Edge Scripting provides most `node:` modules, so a dependency that imports one
is usually fine. The adapter rewrites a bare `fs` to `node:fs` during the build,
because the runtime only answers to the prefixed name.

[`node:fs`](https://bunny.net/docs/scripting/node-fs) works over a virtual file
system. Know what that is before you rely on it:

- It starts empty on every cold start.
- One isolate cannot see what another wrote.
- What it holds counts against the script's memory.

So it is a scratch pad for one request, never a store. Anything that has to
outlive a request belongs in Bunny Storage, which is where the adapter keeps
assets and sessions. The showcase has a working endpoint at `/api/scratch`.

What does not work is a package with a native binary. `sharp` is the usual one.

## Cookies

A pull zone created for a script has **Disable cookies** switched on, which
strips `Set-Cookie` from every response. The build manifest asks for it to be
off, so `bunny lab deploy astro` turns it off and reports the change.

For a deploy you run yourself:

```bash
bunny api POST /pullzone/<pull-zone-id> --body '{"DisableCookies": false}'
```

## Options

Every option is optional. `bunny()` on its own is usually right.

```js
bunny({
  // Storage
  storageZone: "my-site-assets", // otherwise BUNNY_STORAGE_ZONE at runtime
  storageHost: "ny.storage.bunnycdn.com", // otherwise BUNNY_STORAGE_HOST
  assetCacheControl: "public, max-age=31536000, immutable",
  pageCacheControl: "public, max-age=60",
  serverCacheControl: "private, no-store", // for a page that sets none itself

  // Features
  imageService: "noop", // "bunny" for Optimizer, false to keep your own
  image: {}, // settings for the Optimizer service
  sessions: true, // false to configure your own driver
  cache: true, // false to configure your own provider

  // Build
  deploy: "auto", // "server" to deploy the script even with every route prerendered
  script: "standalone", // "middleware" to read files from the nearest storage replica
  outfile: "dist/index.js",
  bundle: true, // false to run your own bundler
  assetManifest: true, // or a file count, above which the script probes instead
  external: [], // modules esbuild must not bundle
  sourcemap: false,
  esbuild: (options) => options, // last resort
});
```

The storage password is never an option. It always comes from the environment,
so it stays out of the bundle.

### assetManifest

The adapter inlines the list of built client files into the script. A request
for something the build never produced then costs no lookup at all, and a
prerendered page costs one instead of two. A script may only make 50
subrequests, so this matters on a busy page.

Above 20 000 files the list would cost more space than it saves, and the script
goes back to asking Storage. Pass a number to move that line, or `false` to
switch it off.

## The build manifest

The build writes `.bunny/build.json`, which is how `bunny lab deploy astro` knows
what to deploy without knowing anything about Astro:

```jsonc
{
  "manifestVersion": 1,
  "adapter": { "package": "@bunny.net/astro-adapter", "version": "0.1.0" },
  "framework": { "name": "astro", "version": "7.2.4" },
  "kind": "ssr",
  "script": { "entry": "dist/index.js", "type": "standalone", "bytes": 668140 },
  "assets": { "dir": "dist/client" },
  "requires": {
    "pullZone": { "disableCookies": false, "enableSmartCache": false },
    "storage": { "write": true, "reason": "Astro.session" },
    "env": [{ "name": "BUNNY_STORAGE_ZONE", "reason": "the zone holding the client build" }],
  },
}
```

A static build names no script, and asks for nothing else: the files are the
whole deploy.

```jsonc
{
  "manifestVersion": 1,
  "adapter": { "package": "@bunny.net/astro-adapter", "version": "0.1.0" },
  "framework": { "name": "astro", "version": "7.2.4" },
  "kind": "static",
  "assets": { "dir": "dist/client" },
  "dev": { "command": "astro dev", "preview": "astro preview" },
}
```

It is a build output, so keep it out of version control.
[`docs/writing-an-adapter.md`](../../docs/writing-an-adapter.md) holds the
contract for the next adapter.

## Limits

Edge Scripting allows one JavaScript file of up to 10 MB, and gives a script
500 ms to start. The showcase in this repository bundles to roughly 660 kB. See
the [Edge Scripting limits](https://bunny.net/docs/scripting/limits).

## Troubleshooting

**The bundle fails on a Node-only module.** Most `node:` built-ins work, so
check which one it is. A package with a native binary never will. `sharp` is
the usual cause, and the adapter already replaces it. If another dependency
needs one, replace that dependency. See [Node built-ins](#node-built-ins).

**`Astro.rewrite("/404")` throws a 500.** A prerendered route has no server
component to rewrite to. Return `new Response(null, { status: 404 })` from the
page instead, and the adapter serves your prerendered 404 page out of Storage.
An endpoint in `src/pages/api/` keeps its own 404, so a JSON client is never
handed a web page.

**Prerendered pages 404.** The files and the script are out of step. Run
`bunny lab deploy astro`, which sends both in one step: the files go up first, and
the deploy's own folder name is written into the bundle, so a release cannot read
another deploy's files.

**A POST returns 403.** Astro checks the request origin for server output. This
is Astro's CSRF protection. Adjust `security.checkOrigin` if you need to.

**`Astro.cookies.set()` has no effect.** The pull zone is stripping the header.
See [Cookies](#cookies).

**The build warns about `Astro.request.headers`.** Middleware also runs while
Astro prerenders a page, where there is no live request. Guard it with
`if (context.isPrerendered) return next();`.

**A `routeRules` entry changes nothing.** Smart Cache is on, and it does not
cache HTML. See [above](#turn-smart-cache-off-first).

**A page shows another visitor's content.** Something removed the
`Cache-Control` the adapter sets. Check that no edge rule overrides it, and
that the page is not setting a `public` directive itself.

**Every request returns a storage error.** Check that `BUNNY_STORAGE_ZONE`
matches the zone name, that `BUNNY_STORAGE_KEY` is a password of that zone, and
that `BUNNY_STORAGE_HOST` matches its region. A zone created seconds ago can
answer `401` until it propagates.

## Licence

[MIT](./LICENSE)
