/**
 * The runtime entrypoint of a middleware script, attached to a pull zone whose
 * origin is the storage zone.
 *
 * Keep this file small. A script has 500 ms to start.
 */
import * as BunnySDK from '@bunny.net/edgescript-sdk';
import { onOriginRequest, onOriginResponse } from './runtime/origin.js';
import { env, listener } from './runtime/site.js';

declare const Bunny: unknown;

/**
 * A pull zone in front of the origin, away from the bunny.net network.
 *
 * The SDK has one, and it answers every origin response with 200 (0.12.1), so
 * a 404, a 304 or a 206 would not survive `astro preview` or the tests.
 */
async function throughLocalOrigin(visitor: Request): Promise<Response> {
	// Like bunny.net, the hooks see the origin's URL, and the visitor's host and
	// scheme only in headers.
	const url = new URL(visitor.url);
	const origin = new URL(env('BUNNY_ORIGIN_URL') || 'http://127.0.0.1:8081');
	const request = new Request(new URL(url.pathname + url.search, origin), visitor);
	request.headers.set('host', url.host);
	request.headers.set('x-forwarded-proto', url.protocol.slice(0, -1));

	const forward = await onOriginRequest(request);
	if (forward instanceof Response) return forward;
	const response = await fetch(forward);
	return onOriginResponse({ request: forward, response });
}

export function start(): void {
	if (typeof Bunny === 'undefined') {
		BunnySDK.net.http.serve(listener(), throughLocalOrigin);
		return;
	}
	BunnySDK.net.http
		.servePullZone()
		// The SDK types a promise of either, where this is a promise of one or the other.
		.onOriginRequest(
			({ request }) => onOriginRequest(request) as Promise<Request> | Promise<Response>,
		)
		.onOriginResponse(onOriginResponse);
}

start();
