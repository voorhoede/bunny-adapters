# Writing an adapter

This repository holds one adapter per framework. This document records what they
share, so the next one is quick to write and quick to review.

## What an adapter does

Edge Scripting runs one JavaScript file on the bunny.net network. It has no disk,
and it holds no build output. So every adapter here does four things:

1. **Bundle.** Take the framework's server build, and produce one file under
   10 MB that starts in under 500 ms.
2. **Serve.** Answer each request with the framework's own request handler.
3. **Delegate.** Read hashed assets and prerendered pages from Bunny Storage,
   because they cannot live in the script.
4. **Declare.** Write a [build manifest](#the-build-manifest), so the bunny CLI
   can deploy the result without knowing anything about the framework.

```
browser ──▶ pull zone ──▶ Edge Script (the framework's handler)
                              │
                              └─ assets and prerendered pages ─▶ Bunny Storage
```

## Naming

| Thing     | Rule                             | Example                    |
| --------- | -------------------------------- | -------------------------- |
| Directory | `packages/<framework>`           | `packages/astro`           |
| Package   | `@bunny.net/<framework>-adapter` | `@bunny.net/astro-adapter` |
| Example   | `examples/<framework>-showcase`  | `examples/astro-showcase`  |

An adapter ships no deploy command of its own. The CLI reads the manifest, and
which command reads it depends on what the build produced:

| The build reports | The command that deploys it                            |
| ----------------- | ------------------------------------------------------ |
| `kind: "ssr"`     | `bunny lab deploy astro`, one subcommand per framework |
| `kind: "static"`  | `bunny sites deploy`, which knows no framework at all  |

`lab` says the interface is still being shaped. A new framework adds a subcommand
there rather than a branch in an existing command: the two shapes shared one
command once, and each flow ended up carrying checks for the shape it was not.

### What a deploy command owns

The manifest describes the build. Everything below is the command's job, not the
adapter's, and a new adapter gets it for free:

| What                    | Why it is the command's                          |
| ----------------------- | ------------------------------------------------ |
| Installing the adapter  | It edits a `package.json` and a framework config |
| The framework's version | Only the command knows which peer range it needs |
| The resources           | A storage zone, a script, and a pull zone        |
| Every secret            | It reads them from the zone it made              |
| The pull zone settings  | From `requires.pullZone`, and never in silence   |

### The framework's own version

Name the framework versions the adapter runs on, in `peerDependencies`, and say
so in the guide. The deploy command reads the project's declared range and stops
before it installs anything, because the package manager's own error is not one a
developer can act on: `@bunny.net/astro-adapter` peers on `astro@^7`, and a
project on Astro 5 gets an ERESOLVE about peer ranges instead of "upgrade Astro".

A framework major is never the command's decision. It moves APIs, and the
developer takes it with their own tests in front of them.

## Package layout

```
packages/<framework>/
├─ src/
│  ├─ index.ts                 the build-time plugin or integration
│  ├─ server.ts                the runtime entry, which runs inside the script
│  ├─ types.ts                 the public option types
│  ├─ build/deploy-manifest.ts writes `.bunny/build.json`
│  └─ runtime/deploy.ts        reads which deploy this script is
├─ test/*.test.mjs    unit tests on the pure helpers, node:test
├─ package.json
├─ tsconfig.json
├─ README.md
└─ LICENSE            MIT, one copy per package
```

Keep `src/server.ts` small. It counts against the 500 ms start-up budget.

The two trees are a contract, and not a preference. Everything a runtime entry
reaches is bundled into the script, and nothing else is. So no runtime entry and
nothing under `runtime/` imports from `build/`: `build/bundle.ts` imports
esbuild, and one such import puts a build tool in a script that has 10 MB. An
`import type` is erased by the compiler, so it crosses the line freely.
`npm run check:style` enforces this.

Most `node:` built-ins are available, including `node:fs` over a virtual file
system. That file system is per isolate and lives in memory, so it is a scratch
pad and never a store. Persistent state belongs in Bunny Storage.

## Code style

An adapter is read by the framework's community, and not by us. An Astro
developer opens `packages/astro` after reading `@astrojs/cloudflare`, and a Nuxt
developer opens `packages/nuxt` after reading a Nitro preset. Each one must find
the code they expect.

So an adapter takes its style from the framework it adapts. This repository
imposes only the short list below, and every other rule comes from the
framework. Do not carry one adapter's idiom into the next one.

### What every adapter shares

These rules come from Edge Scripting, and no framework overrides them:

- A script has 500 ms to start. Keep the module top level cheap, and add no
  dependency the runtime can do without.
- Read every secret from the script environment at run time. Nothing reaches the
  bundle or the config.
- Detect a capability with `typeof X !== "undefined"`. One file runs on the
  edge, on Deno, and under a test.
- Read the environment through one small helper, and never from `process` or
  `Deno` at the call site.
- A missing file is not an exception. The request path answers with a page or a
  status, and it throws nothing.
- Report a broken configuration once per isolate. A message on every request
  buries the log and adds nothing.
- A comment says why the code has to exist. It carries the measurement, the
  limit, or the bug that made it necessary, with the date. `START_RISK_SIZE` in
  `packages/astro/src/build/bundle.ts` is the example: it holds both sizes and
  the month we measured them.
- Every public option carries a doc comment and a `@default`. That comment is
  the reference documentation, so write it for a user.
- No `any`, and no `!` non-null assertion, in `src/`. On this platform a wrong
  assumption arrives as one 500, or as a 400 with an empty body, and neither
  says where it came from. Narrow an `unknown`, or default the value.

### What every adapter takes from its framework

Answer these questions before you write the first line. Read three of the
framework's own adapters or presets, and read its formatter config. Most
frameworks publish no prose style guide, so the code and the config are the
guide.

| Question                                    | Where the answer is                     |
| ------------------------------------------- | --------------------------------------- |
| Formatter, indent, quotes, line width       | The config file at the repository root  |
| Import extension: `.js`, `.ts`, or none     | Any source file                         |
| Functions, factories, or classes            | The three adapters you read             |
| The error type a build failure throws       | Their build-time entry                  |
| The logger, at build time and at run time   | The same file                           |
| Option types: one shape, or user + resolved | Their `types.ts`                        |
| The utility libraries the community expects | Their dependencies, and their AGENTS.md |
| Comment density, and JSDoc conventions      | Measure it, do not guess                |
| File and directory names                    | Their `src/` tree                       |

Then copy the answers. Deviate only for a reason, and write the reason down in
the subsection below. A deviation nobody recorded looks like a mistake to the
next contributor, and it is one to the community.

Do the survey before you write the adapter. Its answer moves into a subsection
here when the adapter merges, and the commit message holds the reasoning.

Then it goes stale, because a framework's own style moves. The trigger to redo it
is the peer range: raise `astro`, or Nitro, to a new major, and survey again in
that same change. A major is when an idiom moves, and it is not a version anybody
raises by accident.

### Astro

Surveyed in August 2026, against `@astrojs/node`, `@astrojs/cloudflare`,
`@astrojs/netlify`, and `@astrojs/vercel`. All four now live in the
`withastro/astro` monorepo, under `packages/integrations/`. The old
`withastro/adapters` repository is archived, so do not read it.

| Convention      | What the official adapters do                                            |
| --------------- | ------------------------------------------------------------------------ |
| Formatter       | Biome. Tabs, single quotes, 100 columns, semicolons always               |
| Imports         | Explicit `.js` extension, `import type` for types                        |
| Shape           | Functions and object literals. One class in about 6,700 lines            |
| Entry           | `export default function createIntegration(options)`                     |
| Adapter object  | A separate `getAdapter()`, called from `astro:config:done`               |
| Build failure   | `AstroError` from `astro/errors`, which renders with a hint              |
| Runtime failure | Plain `Error`. `astro/errors` does not belong in a bundle                |
| Options         | `UserOptions` for what the user writes, `Options` for the resolved shape |
| Runtime config  | A virtual module from a `vite-plugin-config.ts`                          |
| Helpers         | `utils/` or `lib/`, one subject per file, kebab-case names               |
| Cache provider  | `cache/index.ts` and `cache/provider.ts`                                 |
| Comment density | 14% to 21% of non-blank lines                                            |

So Astro adapters are written with functions and plain data. State lives in a
closure, and a factory returns an object of methods. `createStorage` in
`src/runtime/storage.ts` is that pattern, and it matches
`cloudflare/src/utils/cf.ts` closely.

Three reasons hold the pattern in place, and none of them is taste:

1. Every contract Astro offers is already an object literal. An integration, a
   session driver, and a cache provider all are. A class only wraps the shape
   Astro asked for.
2. A method with no `this` survives being passed as a callback. Nothing needs
   `bind`, and nothing breaks when a handler travels.
3. Class machinery is bytes in a script that has 10 MB and 500 ms.

Where `packages/astro` differs from the four, and why:

| Difference                                  | Why                                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| Comments on 35% of lines                    | The measured limits of this platform are written nowhere else. Keep them               |
| `build/` and `runtime/` instead of `utils/` | The split is load-bearing here: one tree bundles into the script, the other never does |
| `cache.ts` instead of `cache/provider.ts`   | One file, one provider. Split it when it grows                                         |
| `define` instead of a virtual config module | Older Astro convention, and it still works. Move when we next touch it                 |

### Nuxt

Not built. Surveyed in August 2026 so the shape is known, because it is not the
shape of this repository.

A Nuxt deployment target is a **Nitro preset**, and not a package like
`packages/astro`. `nitrojs/nitro` holds every preset in `src/presets/<name>`,
with build-time config in `preset.ts` and the script entry in `runtime/`. A
preset is a `defineNitroPreset({ ... })` object.

Nitro's `AGENTS.md` states its conventions, so read that file first. What it
already says, and what differs from Astro:

- `oxlint` and `oxfmt`, not Biome and not Prettier. Two-space indent, and
  double quotes.
- Imports carry a `.ts` extension, not `.js`.
- `pathe` replaces `node:path`. `defu` merges config. `consola` logs at build
  time, and `console` logs at run time.
- `unstorage` is the storage abstraction the community expects.
- Runtime code stays runtime-agnostic and side-effect free, which agrees with
  our own list above.

So decide the delivery shape before the style: a preset upstream in Nitro, or a
module the user names in `nitro.preset`. That choice sets the directory, the
package, and the tests.

### Formatting

Each package is formatted by the tool its framework uses, and
`npm run format` applies it. Configure the difference in the repository's
Prettier config, or give the package its own tool. Never hand-format around
either one, and never argue with it in review.

`packages/astro` is tabs and single quotes, from an override in
`.prettierrc.json5`. Biome writes the same indent and the same quotes for every
official Astro adapter. Prettier does not copy Biome's wrapping exactly, and a
second formatter costs a second config and a second tool in CI, so the override
is where this stops.

### The rules a formatter cannot hold

`npm run check:style` runs `scripts/check-style.mjs`, and CI runs it beside
`npm run check`. It holds the rules above that no formatter can see: the one
`env()` helper, the `build/` and `runtime/` split, `any` and `!`, the deny list
of build-only imports, and, per package, the import extension, the absence of
classes, and the error type a build failure throws.

The per-package rules live in one table at the top of that script. Adding an
adapter means adding one row. A Nitro preset writes `.ts` on its imports, so the
script must never assume one framework's answer, and every failure it prints
names the section here that states the rule.

## The build contract

- Bundle with esbuild, `platform: "neutral"`, `format: "esm"`.
- Use the conditions `["deno", "worker", "import", "module", "default"]`. The
  `deno` condition is what picks the correct `@bunny.net/edgescript-sdk` build.
- Mark `node:*` external. The runtime provides those.
- Write one file, and report its size against the 10 MB limit.
- Delete the framework's intermediate server folder afterwards.

## The runtime contract

- Serve with `BunnySDK.net.http.serve(handler)`. For a middleware script,
  register `servePullZone().onOriginRequest().onOriginResponse()` instead, and
  write `"middleware"` as the script's type in the build manifest.
- A middleware script renders the framework's routes in `onOriginRequest`, and
  sends every other request on to the origin at `<assetPrefix>/<object>`, so
  the pull zone reads it from the nearest replica. It never sends one outside
  that folder. `onOriginResponse` gives the stored object the same headers a
  standalone script would.
- Away from bunny.net, run the two hooks yourself against a local origin.
  `servePullZone` has a local proxy, and in SDK 0.12.1 it answers every origin
  response with 200.
- Read the client IP from `x-forwarded-for`.
- Read the country from `cdn-requestcountrycode`, and the request id from
  `cdn-requestid`.
- Pass `Bunny.v1.waitUntil` to the framework when it accepts one.
- Read every secret from the environment, never from the bundle.

## A build with no server

An adapter reports what a build needs. It never decides how the host serves it.

So a build with no route to render per request writes no script at all. It
reports `kind: "static"`, and `bunny sites deploy` uploads the files: the
`bunny sites` router serves them, exactly as it serves a Hugo site. Ask the
framework whether a server is needed, and never read a config field that only
sets a default. Astro's `output` is such a field, and reading it deployed three
real projects with every dynamic route missing.

A static deploy still needs a 404 page, redirects, and headers, and the router
reads three file names for them:

| File         | What the router does with it                               |
| ------------ | ---------------------------------------------------------- |
| `404.html`   | Answers a path the deploy does not hold, with status 404   |
| `_redirects` | One rule per line: `from to status`. `!` beats a real file |
| `_headers`   | A path, then indented `Name: value` lines                  |

These names are a convention every static host reads, so a framework plugin
that already writes them needs nothing from us. Write what the framework cannot
express as a file, and write it under those names. Do not invent a manifest
field for it: the router must stay framework-neutral, or every new framework
needs a new CLI release.

Do not fail a build for being static. A project crosses that line in both
directions as its routes change, and a build that breaks on the commit which
prerenders the last dynamic route is hostile.

## The build manifest

The CLI knows no framework. At the end of the build, write
`.bunny/build.json` at the project root, and the CLI knows what to do with the
result. A new adapter needs no new CLI release.

```jsonc
{
  // Bump only for a change an older CLI cannot read. A new optional field is
  // not one: the CLI ignores what it does not know.
  "manifestVersion": 1,

  "adapter": { "package": "@bunny.net/astro-adapter", "version": "0.1.0" },
  "framework": { "name": "astro", "version": "7.2.4" },

  // "ssr" needs a script. "static" is files only, and deploys as a static site.
  "kind": "ssr",

  "script": {
    "entry": "dist/index.js", // one file, 10 MB at most
    "type": "standalone", // or "middleware", for a pull zone whose origin is the storage zone
    "bytes": 668140,
  },

  "assets": { "dir": "dist/client" },

  // What the CLI has to arrange before the site works. It applies each one,
  // reports every change, and never changes one back in silence.
  "requires": {
    "cliVersion": ">=1.2.3", // optional floor; omit unless a release must be ruled out
    "pullZone": { "disableCookies": false, "enableSmartCache": false },
    "storage": { "write": true, "reason": "sessions" },
    "env": [
      { "name": "BUNNY_STORAGE_ZONE", "reason": "the zone holding the client build" },
      { "name": "BUNNY_STORAGE_KEY", "reason": "that zone's read-only password", "secret": true },
      { "name": "BUNNY_API_KEY", "reason": "cache purging", "secret": true, "optional": true },
    ],
  },

  "dev": { "command": "astro dev", "preview": "astro preview" },
}
```

Rules:

- Paths are relative to the project root, and use forward slashes.
- The file is a build output. `.gitignore` covers it.
- The CLI validates it against `BuildManifestSchema` in `@bunny.net/config`. A
  shape it cannot read stops the deploy: half a deployed site is worse than none.
- Ask for everything in `requires`. A setting the CLI does not apply becomes a
  support ticket that reads "the site looks broken".

### Which deploy this script is

The deploy command puts each build in its own folder in the zone, and writes the
folder's name into the top of the bundle:

```js
globalThis.__BUNNY_DEPLOY__ = {
  id: "a1b2c3d4",
  assetPrefix: "deploys/a1b2c3d4",
  site: "my-site",
  environment: "production",
};
```

Read it, and join `assetPrefix` in front of every object path. The code and the
files it was built against then cannot drift apart, and publishing an earlier
release restores that release's files in the same operation. Fall back to
`BUNNY_ASSET_PREFIX`, and then to the zone root, so a deploy that does not go
through the CLI still works. Sessions do **not** take the prefix: a session
outlives a deploy.

## Configuration

| Variable             | Meaning                                           |
| -------------------- | ------------------------------------------------- |
| `BUNNY_STORAGE_ZONE` | The zone that holds the client build              |
| `BUNNY_STORAGE_HOST` | That zone's regional endpoint                     |
| `BUNNY_STORAGE_KEY`  | That zone's read-only password                    |
| `BUNNY_ASSET_PREFIX` | The folder inside the zone that holds this deploy |
| `BUNNY_API_KEY`      | Only when the adapter purges the cache            |
| `BUNNY_PULLZONE_ID`  | Only when the adapter purges the cache            |

Use the same names in every adapter. A user who moves between frameworks must
not have to learn a second set.

## Tests

There are four tiers. Each one answers a question the tier below it cannot.

**Unit tests** (`packages/<framework>/test/*.test.mjs`) cover the pure helpers
only: path handling, content types, option resolution, URL building. Anything
that needs a network belongs higher up.

**The showcase** (`examples/<framework>-showcase`) is one site that uses every
capability, and `tests/e2e.mjs` proves it. Each capability gets one page and one
check, so the demo and the suite cannot drift apart. It builds the example,
serves its client output from `startLocalZone`, runs the bundle on Deno, and
runs the checks.

**Fixtures** (`tests/fixtures/<name>`, asserted by `tests/suites/*.test.mjs`)
are one small project per configuration. The showcase proves one configuration
very well, and a real project changes the configuration: it sets a base path, it
adds redirects, it turns an option off. Each fixture is a whole Astro project,
and `serveFixture` in `tests/harness.mjs` builds it and runs it on Deno behind
the same local zone. A fixture needs no install of its own, because Node walks
up to the repository's `node_modules`.

Write a fixture whenever a behaviour depends on configuration. Write a showcase
page when it does not.

**The live tier** (`tests/live.mjs`) is the only one that can prove a pull zone
feature, and it is the only one that needs a credential. It runs by hand, never
in continuous integration. When it changes a paid setting, it reads the setting
first and puts it back at the end, including on Ctrl-C.

The runner is shared across all four. A new adapter supplies a `checks.mjs` and
a build command, and gets the whole harness.

## Release

Changesets. Add one with the change, and the merge to `main` publishes it.

The release job carries no npm token. npm trusted publishing exchanges the
workflow's OIDC token for a short-lived credential, and npm signs the provenance
itself. Two things hold it together, and both must agree: the workflow keeps
`id-token: write`, and the package's trusted publisher on npmjs.com names this
repository and `release.yml`. So renaming that file, or publishing from another
workflow, needs the npm setting changed in the same hour.
