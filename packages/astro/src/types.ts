import type { BuildOptions } from 'esbuild';

export type { BuildManifest, BunnyRuntime, RuntimeOptions } from './runtime/types.js';

/**
 * How images are transformed.
 *
 * - `"noop"` leaves every image at its original size. The default, because it
 *   costs nothing and needs no pull zone feature.
 * - `"bunny"` uses [Bunny
 *   Optimizer](https://bunny.net/docs/optimizer), which resizes and re-encodes
 *   at the edge. Turn Optimizer on for the pull zone first. It is a paid
 *   feature, so the adapter never enables it for you.
 *
 *   Optimizer does not reach an Edge Script origin today. With Optimizer on,
 *   every image request that misses the CDN cache answers `523 Origin
 *   Connection Failed`. Measured on two script-backed pull zones in August
 *   2026, with `tests/live.mjs --optimizer`. So the URLs this service writes
 *   are correct, and nothing serves them yet. Leave `imageService` at its
 *   default until Optimizer can read from a script.
 * - `false` keeps whatever the project already configures. Use it when you want
 *   `sharp` for prerendered pages, and you never render an image on demand.
 */
export type ImageServiceMode = 'noop' | 'bunny' | false;

/** The type of Edge Script, `ScriptType` in the bunny.net API. */
export type ScriptType = 'standalone' | 'middleware';

export interface BunnyImageServiceConfig {
	/** Widths used to build a `srcset`. */
	widths?: number[];
	/** Default quality, 1 to 100. Optimizer decides when this is absent. */
	quality?: number;
	/**
	 * Largest width the service will ask for. A request above it is clamped, so a
	 * crafted URL cannot make the Optimizer render a huge image.
	 * @default 3840
	 */
	maxWidth?: number;
}

export interface BunnyAdapterOptions {
	/**
	 * Storage zone that holds `dist/client`.
	 * Defaults to the `BUNNY_STORAGE_ZONE` environment variable at runtime.
	 */
	storageZone?: string;

	/**
	 * Storage endpoint for that zone's region, for example `ny.storage.bunnycdn.com`.
	 * Defaults to the `BUNNY_STORAGE_HOST` environment variable, then
	 * `storage.bunnycdn.com`.
	 */
	storageHost?: string;

	/**
	 * Where to write the single deployable file, relative to the project root.
	 * @default "dist/index.js"
	 */
	outfile?: string;

	/**
	 * Bundle the server output into one file after the build.
	 * Turn this off only if you run your own bundler.
	 * @default true
	 */
	bundle?: boolean;

	/**
	 * Which image service to use.
	 * @default "noop"
	 */
	imageService?: ImageServiceMode;

	/**
	 * What a deploy sends.
	 *
	 * - `"auto"` follows Astro. A route that renders per request makes this a
	 *   server build, and the deploy is the script plus the files it renders
	 *   from: `bunny lab deploy astro` sends both. Every route prerendered makes
	 *   it a static build, and the deploy is the files alone: `bunny sites deploy`
	 *   uploads them, and the `bunny sites` router answers a miss with your
	 *   `404.html`, sends your redirects, and applies your headers.
	 * - `"server"` always builds and deploys the script. Use it when every route
	 *   is prerendered and a page holds a `server:defer` component: Astro reports
	 *   such a project as a static build, so nothing else can tell it apart from
	 *   a project that never uses one.
	 *
	 * @default "auto"
	 */
	deploy?: 'auto' | 'server';

	/**
	 * The type of Edge Script to build, as bunny.net calls it.
	 *
	 * - `"standalone"` is the pull zone's origin. It renders Astro's routes and
	 *   reads every other file from the storage zone's main region.
	 * - `"middleware"` is attached to a pull zone whose origin is the storage
	 *   zone. It renders Astro's routes, and sends every other request on to the
	 *   origin, so the pull zone reads the file from the nearest storage
	 *   replica. It runs on every cache miss, files included. Measured from
	 *   New York on 2026-09-30, a file missing the cache took about 90 ms this
	 *   way and about 420 ms from a standalone script reading Frankfurt; from
	 *   Europe the two were the same. The deploy has to set the pull zone up
	 *   this way, which `bunny lab deploy astro` does not do yet.
	 *
	 * @default "standalone"
	 */
	script?: ScriptType;

	/** Settings for the Bunny Optimizer image service. Ignored otherwise. */
	image?: BunnyImageServiceConfig;

	/** `Cache-Control` for hashed assets. @default "public, max-age=31536000, immutable" */
	assetCacheControl?: string;

	/** `Cache-Control` for prerendered HTML. @default "public, max-age=60" */
	pageCacheControl?: string;

	/**
	 * `Cache-Control` for a server-rendered response that sets none itself.
	 *
	 * This is not a performance setting. A bunny.net pull zone applies its own
	 * expiration to a response that carries no directive, so without this a
	 * personalised page could be cached and served to somebody else. A route
	 * that sets its own header, or that matches a `routeRules` entry, keeps it.
	 *
	 * @default "private, no-store"
	 */
	serverCacheControl?: string;

	/**
	 * Store sessions in the storage zone when the project turns sessions on.
	 * Set it to `false` to configure your own driver.
	 * @default true
	 */
	sessions?: boolean;

	/**
	 * Register the bunny.net CDN cache provider, which turns Astro's
	 * `routeRules` into `Cache-Control` and `CDN-Tag` headers, and purges by tag.
	 * Set it to `false` to configure your own provider.
	 * @default true
	 */
	cache?: boolean;

	/**
	 * Inline the list of built client files into the bundle, so the script knows
	 * what Storage holds without asking. Pass a number to change the file count
	 * above which the adapter gives up and probes instead.
	 * @default 20000
	 */
	assetManifest?: boolean | number;

	/** Modules esbuild must not bundle. They have to exist at runtime. */
	external?: string[];

	/**
	 * Emit a source map beside the bundle. `"inline"` keeps one file, at the cost
	 * of size against the 10 MB limit.
	 * @default false
	 */
	sourcemap?: boolean | 'inline' | 'external' | 'linked';

	/**
	 * Last resort. Change the esbuild options before the bundle is written.
	 * Mutate the object, or return a new one.
	 */
	esbuild?: (options: BuildOptions) => BuildOptions | void;
}
