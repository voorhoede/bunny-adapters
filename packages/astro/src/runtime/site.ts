/**
 * What both kinds of script share: the Astro app, the storage client, and the
 * rules for rendering a route and for turning a stored object into a response.
 *
 * `server.ts` serves every request with it as a standalone script, and
 * `middleware.ts` uses it in front of a storage-origin pull zone.
 *
 * Keep this file small. A script has 500 ms to start.
 */
import { createApp } from 'astro/app/entrypoint';
import { setGetEnv } from 'astro/env/setup';
import { assetPrefix } from './deploy.js';
import { contentType, isHtml } from './mime.js';
import { objectCandidates, resolveObject, stripBase } from './paths.js';
import { createStorage } from './storage.js';
import type { RouteData } from 'astro';
import type { BuildManifest, BunnyRuntime, RuntimeOptions } from './types.js';

/** Replaced with a literal by Vite, from the adapter options. */
declare const __BUNNY_ADAPTER_OPTIONS__: RuntimeOptions;

/**
 * Replaced with a literal by esbuild, after the client build is on disk.
 * Absent when the user turns bundling off, so every read goes through `typeof`.
 */
declare const __BUNNY_BUILD_MANIFEST__: BuildManifest | undefined;

declare const Bunny: { v1?: { waitUntil?(promise: Promise<unknown>): void } } | undefined;
declare const Deno: { env: { get(key: string): string | undefined } } | undefined;
declare const process: { env: Record<string, string | undefined> } | undefined;

/** Read an environment variable on the edge, on Deno, or on Node. */
export function env(key: string): string | undefined {
	if (typeof Deno !== 'undefined') return Deno.env.get(key);
	if (typeof process !== 'undefined') return process.env[key];
	return undefined;
}

setGetEnv((key) => env(key));

export const options = __BUNNY_ADAPTER_OPTIONS__;
export const build: BuildManifest =
	typeof __BUNNY_BUILD_MANIFEST__ !== 'undefined'
		? __BUNNY_BUILD_MANIFEST__
		: { assets: null, headers: null, redirects: null };

/**
 * The set of files the build produced. When it is present the script knows
 * whether Storage holds a path, so a miss costs no subrequest at all.
 */
export const assets: ReadonlySet<string> | null = build.assets ? new Set(build.assets) : null;

const storage = createStorage({
	zone: options.storageZone || env('BUNNY_STORAGE_ZONE') || '',
	host: options.storageHost || env('BUNNY_STORAGE_HOST') || 'storage.bunnycdn.com',
	key: env('BUNNY_STORAGE_KEY') || '',
	// `bunny lab deploy astro` gives each deploy its own folder, and writes the name into
	// the bundle. So this release can only read the files it was built with.
	prefix: assetPrefix(),
});

/** Extend the isolate's life. A no-op away from the bunny.net network. */
function waitUntil(promise: Promise<unknown>): void {
	if (typeof Bunny !== 'undefined' && Bunny?.v1?.waitUntil) {
		Bunny.v1.waitUntil(promise);
		return;
	}
	// Nothing keeps the isolate alive here, but a rejection must not go unheard.
	void Promise.resolve(promise).catch(() => {});
}

/**
 * The visitor's IP.
 *
 * bunny.net puts it in `x-forwarded-for`. The left-most entry is the client;
 * anything after it was added by a proxy in front of us.
 *
 * The fallback matters. `Astro.clientAddress` throws when the adapter hands it
 * nothing, so a page would fail rather than show an unknown IP. On the
 * bunny.net network the header is always there; away from it the request
 * really does come from this machine.
 */
function clientAddress(request: Request): string {
	const forwarded = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip');
	return forwarded?.split(',')[0]?.trim() || '127.0.0.1';
}

/** Everything the edge knows about this request, for `Astro.locals.runtime`. */
function runtimeContext(request: Request): BunnyRuntime {
	return {
		country: request.headers.get('cdn-requestcountrycode') ?? undefined,
		requestId: request.headers.get('cdn-requestid') ?? undefined,
		clientAddress: clientAddress(request),
		waitUntil,
		caches: typeof caches !== 'undefined' ? caches : undefined,
		env,
	};
}

const app = createApp();

/** The route Astro owns for this request, if it owns one. */
export function match(request: Request): RouteData | undefined {
	return app.match(request);
}

/**
 * Request headers that change which bytes of an object come back.
 *
 * Bunny Storage answers all of them, so they are passed straight through. That
 * is what makes the script a range-capable origin: without it a pull zone has
 * to treat every object as one blob, and a large file is only seekable once it
 * is fully cached.
 */
const FETCH_REFINING_HEADERS = ['range', 'if-range', 'if-none-match', 'if-modified-since'];

/** The subset of a request's headers that Storage should see. */
function refiningHeaders(request: Request): Headers {
	const forward = new Headers();
	for (const name of FETCH_REFINING_HEADERS) {
		const value = request.headers.get(name);
		if (value) forward.set(name, value);
	}
	return forward;
}

/** A response with no body of its own, whatever the object holds. */
function isBodyless(status: number): boolean {
	return status === 304 || status === 416;
}

/** Turn a Storage response into the response the visitor gets. */
export function fromStorageResponse(object: string, upstream: Response, method: string): Response {
	const type = contentType(object);
	const headers = new Headers({
		'content-type': type,
		'cache-control': isHtml(type) ? options.pageCacheControl : options.assetCacheControl,
		// Say the object can be fetched in pieces. A pull zone will not slice an
		// object, and will not answer a range from its cache, unless the origin
		// says it may.
		'accept-ranges': 'bytes',
	});

	// Let the pull zone and the browser revalidate instead of re-downloading,
	// and let them ask for one piece at a time.
	for (const name of ['etag', 'last-modified', 'content-range']) {
		const value = upstream.headers.get(name);
		if (value) headers.set(name, value);
	}

	// Only when the body arrives as it is stored. A decompressed body is a
	// different length from the one the header names.
	if (!upstream.headers.get('content-encoding')) {
		const length = upstream.headers.get('content-length');
		if (length) headers.set('content-length', length);
	}

	// Headers Astro asked for on this prerendered page, such as a CSP.
	for (const [name, value] of build.headers?.[object] ?? []) {
		headers.set(name, value);
	}

	// 206 and the two bodyless answers are the visitor's, and anything else that
	// got this far is a whole object.
	const status = upstream.status === 206 || isBodyless(upstream.status) ? upstream.status : 200;

	if (method === 'HEAD' || isBodyless(status)) {
		void upstream.body?.cancel();
		// A 304 must not name a length, because it describes no body.
		if (status === 304) headers.delete('content-length');
		return new Response(null, { status, headers });
	}
	return new Response(upstream.body, { status, headers });
}

/**
 * Answer a redirect the build prerendered, or return `null`.
 *
 * Astro turns an internal redirect to a prerendered page into a page of its
 * own, which carries a `Location` header. Serving that page would answer 200,
 * and a browser ignores `Location` on a 200.
 */
export function fromRedirects(pathname: string, method: string): Response | null {
	if (!build.redirects) return null;

	const local = stripBase(pathname, options.base);
	if (local === null) return null;

	for (const object of objectCandidates(local)) {
		const entry = build.redirects[object];
		if (!entry) continue;
		// Astro's own rule when the route configured no status of its own.
		const status = entry.status ?? (method === 'GET' ? 301 : 308);
		return new Response(null, {
			status,
			headers: { location: entry.to, 'cache-control': options.pageCacheControl },
		});
	}
	return null;
}

/** True for the two methods that read an object and change nothing. */
export function isRead(method: string): boolean {
	return method === 'GET' || method === 'HEAD';
}

/** A stored object is read-only, whatever the visitor asked to do to it. */
export function methodNotAllowed(): Response {
	return new Response(null, {
		status: 405,
		headers: { allow: 'GET, HEAD', 'cache-control': options.serverCacheControl },
	});
}

/**
 * Read one object for this request path, or return `null`.
 *
 * With the build manifest this makes at most one subrequest, and none at all
 * for a path the build never produced. Without it, a path with no extension
 * costs two, because the page may be `<route>/index.html` or `<route>.html`.
 *
 * A method other than `GET` or `HEAD` is refused, but only once the object is
 * known to be there. A `POST` to a path the build never produced has to carry
 * on to Astro, which answers it with the site's own 404 page.
 */
async function fromStorage(
	pathname: string,
	method = 'GET',
	forward?: Headers,
): Promise<Response | null> {
	if (!storage.enabled) return null;

	// The build on disk has no `base` prefix, and every request carries one.
	const local = stripBase(pathname, options.base);
	if (local === null) return null;

	let candidates: string[];
	if (assets) {
		const object = resolveObject(local, assets);
		if (!object) return null;
		// The manifest already proves the object exists, so refuse without paying
		// for a subrequest.
		if (!isRead(method)) return methodNotAllowed();
		candidates = [object];
	} else {
		candidates = objectCandidates(local);
	}

	for (const object of candidates) {
		const upstream = await storage.get(object, forward);
		if (!upstream) continue;
		if (!isRead(method)) {
			void upstream.body?.cancel();
			return methodNotAllowed();
		}
		return fromStorageResponse(object, upstream, method);
	}
	return null;
}

/**
 * Astro calls this to find a prerendered `404.html` or `500.html`. Without it
 * the visitor gets a bare status code, even though the page sits in Storage.
 *
 * The 500 page leaves with no caching. Astro reuses these headers on the
 * response the visitor gets, and a pull zone that caches a 500 hands one
 * transient failure to everybody who asks for that path. A 404 keeps the page
 * lifetime, because a missing path stays missing until the next deploy.
 */
async function prerenderedErrorPageFetch(url: string): Promise<Response> {
	const { pathname } = new URL(url);
	const response = await fromStorage(pathname);
	if (!response) throw new Error(`No prerendered error page for ${url}`);

	const local = stripBase(pathname, options.base) ?? pathname;
	if (/\/500(\.html|\/index\.html)?$/.test(local)) {
		response.headers.set('cache-control', options.serverCacheControl);
	}
	return response;
}

/**
 * Say how a rendered response may be cached, unless it already says.
 *
 * A bunny.net pull zone applies its own expiration to a response that carries
 * no `Cache-Control`. Without this, a page rendered for one visitor could be
 * cached and handed to the next one. A route that sets its own header, and a
 * route matched by `routeRules`, both keep what they set.
 */
function withCacheControl(response: Response): Response {
	if (response.headers.has('cache-control')) return response;
	try {
		response.headers.set('cache-control', options.serverCacheControl);
		return response;
	} catch {
		// `Response.redirect()` and `Response.error()` give immutable headers, and
		// Astro builds an external redirect with the first of the two. Writing to
		// them throws, so copy the response instead of failing the request.
		const headers = new Headers(response.headers);
		headers.set('cache-control', options.serverCacheControl);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}
}

/**
 * Let Astro answer. With `routeData` it renders that route; without it, the
 * site's 404, which reaches back into Storage for a prerendered 404 page.
 */
export async function render(request: Request, routeData?: RouteData): Promise<Response> {
	return withCacheControl(
		await app.render(request, {
			addCookieHeader: true,
			clientAddress: clientAddress(request),
			locals: { runtime: runtimeContext(request) },
			prerenderedErrorPageFetch,
			waitUntil,
			routeData,
		}),
	);
}

/** Handle one request as a standalone script. */
export async function handle(request: Request): Promise<Response> {
	// 1. Astro owns this route. Render it now.
	//
	// A page that answers 404 with no body reaches back through
	// `prerenderedErrorPageFetch` on its own, so the site's own 404 page comes
	// out of Storage without the adapter doing anything here.
	const routeData = app.match(request);
	if (routeData) return render(request, routeData);

	const { pathname } = new URL(request.url);

	// 2. A redirect the build turned into a page. It answers with its status.
	const redirect = fromRedirects(pathname, request.method);
	if (redirect) return redirect;

	// 3. Not an Astro route. Look for an asset or a prerendered page.
	const stored = await fromStorage(pathname, request.method, refiningHeaders(request));
	if (stored) return stored;

	// 4. Nothing matched. Let Astro answer, which reaches back into Storage for
	//    a prerendered 404 when the project has one.
	return render(request);
}

/**
 * Where to listen away from the bunny.net network, where the SDK ignores the
 * listener and uses the platform's own. This is what lets `astro preview` and
 * the test suite choose a free port instead of fighting over 8080.
 */
export function listener(): { hostname: string; port: number } {
	// An empty variable is not nullish, so `??` would keep it and `Number("")`
	// would give port 0. Fall back on anything that is not a real port number.
	const requestedPort = Number(env('PORT') || env('BUNNY_PORT'));
	const port =
		Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535
			? requestedPort
			: 8080;

	// The SDK wants a dotted IPv4, and it throws on anything else. A name such
	// as "localhost" is what a preview server usually passes, so map it back.
	const requested = env('BUNNY_HOSTNAME') ?? '127.0.0.1';
	const hostname = /^\d{1,3}(\.\d{1,3}){3}$/.test(requested) ? requested : '127.0.0.1';
	return { hostname, port };
}
