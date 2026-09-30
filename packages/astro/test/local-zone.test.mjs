import { strict as assert } from 'node:assert';
import { request } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startLocalZone } from '../dist/build/local-zone.js';

describe('startLocalZone as a pull zone origin', () => {
	/** @type {Awaited<ReturnType<typeof startLocalZone>>} */
	let origin;

	before(async () => {
		const dir = await mkdtemp(path.join(tmpdir(), 'bunny-origin-'));
		await mkdir(path.join(dir, 'deploys/a1/about'), { recursive: true });
		await writeFile(path.join(dir, 'deploys/a1/about/index.html'), '<p>about</p>');
		await writeFile(path.join(dir, 'deploys/a1/robots.txt'), 'User-agent: *');
		origin = await startLocalZone({ dir, origin: true });
	});
	after(() => origin?.close());

	it('answers a path with no zone segment and no access key, as a pull zone asks for it', async () => {
		const response = await fetch(`${origin.host}/deploys/a1/robots.txt`);
		assert.equal(response.status, 200);
		assert.equal(await response.text(), 'User-agent: *');
	});

	// Measured on a storage-origin pull zone on 2026-09-30.
	it('serves a folder index with and without the trailing slash', async () => {
		for (const pathname of ['/deploys/a1/about/', '/deploys/a1/about']) {
			const response = await fetch(`${origin.host}${pathname}`);
			assert.equal(response.status, 200, pathname);
			assert.equal(await response.text(), '<p>about</p>');
		}
	});

	it('answers 404 for a missing object, and refuses to climb out of its folder', async () => {
		assert.equal((await fetch(`${origin.host}/deploys/a1/nothing.txt`)).status, 404);
		// `fetch` resolves `..` before sending, so the path goes out as written here.
		const status = await new Promise((resolve, reject) => {
			request(`${origin.host}/../../etc/passwd`, { path: '/../../etc/passwd' }, (response) => {
				response.resume();
				resolve(response.statusCode);
			})
				.on('error', reject)
				.end();
		});
		// The emulator resolves `..` while it parses the URL, so the path lands
		// inside its folder, where there is no such file.
		assert.equal(status, 404);
	});

	it('refuses to be written to, since a pull zone only reads', async () => {
		const response = await fetch(`${origin.host}/deploys/a1/new.txt`, { method: 'PUT', body: 'x' });
		assert.equal(response.status, 405);
	});

	it('records every path it was asked for', () => {
		assert.ok(origin.requests.includes('/deploys/a1/robots.txt'), origin.requests.join(', '));
	});
});
