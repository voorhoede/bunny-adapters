/**
 * The two hooks of a middleware script, in front of a pull zone whose origin is
 * the storage zone.
 *
 * A cache miss reaches `onOriginRequest` first. Astro's own routes render there
 * and never reach storage. Every other request goes on to the origin, rewritten
 * to this deploy's folder, so the pull zone reads the file from the nearest
 * storage replica. `onOriginResponse` then gives the stored object the same
 * headers a standalone script would.
 */
import { assetPrefix } from './deploy.js';
import { encodeObjectPath, objectCandidates, resolveObject, stripBase } from './paths.js';
import {
	assets,
	fromRedirects,
	fromStorageResponse,
	isRead,
	match,
	methodNotAllowed,
	options,
	render,
} from './site.js';

/** Where the session driver keeps its files, when it shares the asset zone. */
const SESSIONS = '_sessions/';

/**
 * The folder this deploy's files live in, as `/` or `/deploys/a1b2c3d4/`.
 * Read on every request, since the deploy line is set before the bundle runs.
 */
function folder(): string {
	const prefix = assetPrefix();
	return prefix ? `/${prefix}/` : '/';
}

/** The object a request path names, or `null` when it names none this build could hold. */
function objectFor(pathname: string): string | null {
	const local = stripBase(pathname, options.base);
	if (local === null) return null;
	const object = assets ? resolveObject(local, assets) : (objectCandidates(local)[0] ?? null);
	// Without the file list the path is not known to be a build file, and the
	// zone root also holds the sessions when they share the zone.
	if (!object || object.startsWith(SESSIONS)) return null;
	return object;
}

/**
 * The URL the visitor asked for. A hook sees the origin's URL, with the
 * visitor's host and scheme only in headers.
 */
function visitorUrl(request: Request): URL {
	const url = new URL(request.url);
	const host = request.headers.get('host');
	if (!host) return url;
	const scheme = request.headers.get('x-forwarded-proto') === 'http' ? 'http' : 'https';
	return new URL(`${url.pathname}${url.search}`, `${scheme}://${host}`);
}

/** The request as Astro should see it, at the visitor's URL. */
function fromVisitor(request: Request): Request {
	return new Request(visitorUrl(request), request);
}

/** Answer a cache miss, or send it on to the origin at this deploy's object. */
export async function onOriginRequest(request: Request): Promise<Request | Response> {
	const routeData = match(request);
	if (routeData) return render(fromVisitor(request), routeData);

	const url = new URL(request.url);
	const redirect = fromRedirects(url.pathname, request.method);
	if (redirect) return redirect;

	const object = objectFor(url.pathname);
	if (!object) return render(fromVisitor(request));
	if (!isRead(request.method)) return assets ? methodNotAllowed() : render(fromVisitor(request));

	url.pathname = `${folder()}${encodeObjectPath(object)}`;
	return new Request(url, request);
}

/** Give a stored object the headers of this build, or let Astro answer a miss. */
export async function onOriginResponse({
	request,
	response,
}: {
	request: Request;
	response: Response;
}): Promise<Response> {
	const url = new URL(request.url);
	const prefix = folder();
	const object = url.pathname.startsWith(prefix)
		? decodeURIComponent(url.pathname.slice(prefix.length))
		: null;

	if (response.status === 404 || !object) {
		void response.body?.cancel();
		const visitor = visitorUrl(request);
		visitor.pathname = `${options.base}/${object ?? ''}`;
		return render(new Request(visitor, request));
	}
	if (!response.ok && response.status !== 304 && response.status !== 416) return response;
	return fromStorageResponse(object, response, request.method);
}
