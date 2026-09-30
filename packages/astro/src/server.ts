/**
 * The runtime entrypoint of a standalone script, the pull zone's origin.
 *
 * Astro renders every route it owns. Everything else — hashed assets and
 * prerendered pages — is read from Bunny Storage, because the edge has no build
 * output on disk.
 *
 * Keep this file small. A script has 500 ms to start.
 */
import * as BunnySDK from '@bunny.net/edgescript-sdk';
import { handle, listener } from './runtime/site.js';

export { handle };

export function start(): void {
	BunnySDK.net.http.serve(listener(), handle);
}

start();
