/**
 * `astro preview` for Edge Scripting.
 *
 * It runs the file you are about to deploy, not a second server that behaves
 * almost like it. A local storage zone stands in for Bunny Storage, so assets,
 * prerendered pages and sessions all work with no account and no network.
 *
 * It needs Deno, because Deno is the Edge Scripting runtime. Running the bundle
 * on Node would need a second build with different resolution rules, and the
 * result would not be the thing that gets deployed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { CreatePreviewServer } from 'astro';
import { AstroError } from 'astro/errors';
import { startLocalZone } from './build/local-zone.js';

/** Written by the adapter at the end of a build. */
interface BuildInfo {
	outfile: string;
	client: string;
	/** Absent in a build from before middleware scripts. */
	script?: 'standalone' | 'middleware';
}

const INFO_FILE = '.bunny-adapter.json';

/** Where preview keeps its sessions. Inside `outDir`, outside the client build. */
const SESSION_DIR = '.preview-sessions/';

async function readBuildInfo(outDir: URL): Promise<BuildInfo | null> {
	try {
		return JSON.parse(await readFile(new URL(INFO_FILE, outDir), 'utf8')) as BuildInfo;
	} catch {
		return null;
	}
}

/** True when Deno starts and reports a version. */
function haveDeno(): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = spawn('deno', ['--version'], { stdio: 'ignore' });
		probe.once('error', () => resolve(false));
		probe.once('exit', (code) => resolve(code === 0));
	});
}

/** Wait until the child answers, so preview does not print a URL that fails. */
async function waitForServer(url: string, child: ChildProcess): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (child.exitCode !== null) {
			throw new AstroError(
				'The preview server stopped while starting.',
				'Deno printed the reason above. Run the bundle yourself with `deno run -A <outfile>` to see it again.',
			);
		}
		try {
			await fetch(url, { method: 'HEAD' });
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	throw new AstroError(
		`No answer from ${url} after 10 seconds.`,
		'Something else may hold the port. Pass `--port` another number, or run the bundle with ' +
			'`deno run -A <outfile>` to see what the server says.',
	);
}

const createPreviewServer: CreatePreviewServer = async ({
	outDir,
	client,
	root,
	host,
	port,
	logger,
}) => {
	const info = await readBuildInfo(outDir);
	if (!info) {
		throw new AstroError(
			'No build to preview.',
			'Run `astro build` first. If you set `bundle: false`, run your own server instead.',
		);
	}

	if (!(await haveDeno())) {
		throw new AstroError(
			'astro preview needs Deno, because Edge Scripting runs on Deno.',
			'Install it with `curl -fsSL https://deno.land/install.sh | sh`, ' +
				'or use `astro dev`, which needs only Node.',
		);
	}

	const rootDir = fileURLToPath(root);
	const bundlePath = path.resolve(rootDir, info.outfile);

	// The asset zone stands in for Bunny Storage over the real client build.
	const zone = await startLocalZone({ dir: fileURLToPath(client), zone: 'preview' });

	// Sessions get a zone of their own, over a folder outside the client build.
	//
	// Sharing one zone would write every session into `dist/client`, which is the
	// folder a deploy uploads. A developer who previewed and then deployed without
	// rebuilding would put their local sessions in the public asset zone, where the
	// script serves them like any other object.
	const sessions = await startLocalZone({
		dir: fileURLToPath(new URL(SESSION_DIR, outDir)),
		zone: 'preview-sessions',
	});

	// A middleware script reads the files through the pull zone, whose origin is
	// the storage zone, so it needs that origin next to the Storage API.
	const origin =
		info.script === 'middleware'
			? await startLocalZone({ dir: fileURLToPath(client), origin: true })
			: undefined;

	// Astro passes a name or nothing. The runtime listens on an address.
	const hostname = !host || host === 'localhost' ? '127.0.0.1' : host;

	const child = spawn('deno', ['run', '-A', bundlePath], {
		stdio: 'inherit',
		env: {
			...process.env,
			PORT: String(port),
			BUNNY_HOSTNAME: hostname,
			BUNNY_STORAGE_ZONE: zone.zone,
			BUNNY_STORAGE_HOST: zone.host,
			BUNNY_STORAGE_KEY: 'preview',
			BUNNY_SESSION_ZONE: sessions.zone,
			BUNNY_SESSION_HOST: sessions.host,
			BUNNY_SESSION_KEY: 'preview',
			...(origin ? { BUNNY_ORIGIN_URL: origin.host } : {}),
		},
	});

	const closed = new Promise<void>((resolve, reject) => {
		child.once('error', reject);
		child.once('exit', () => resolve());
	});

	const url = `http://${hostname === '0.0.0.0' ? '127.0.0.1' : hostname}:${port}`;
	try {
		await waitForServer(url, child);
	} catch (error) {
		await Promise.all([zone.close(), sessions.close(), origin?.close()]);
		throw error;
	}
	logger.info(`Serving ${path.relative(rootDir, bundlePath)} on Deno, with a local storage zone.`);

	return {
		host: hostname,
		port,
		closed: () => closed,
		async stop() {
			child.kill();
			await Promise.all([zone.close(), sessions.close(), origin?.close()]);
			await closed.catch(() => {});
		},
	};
};

export default createPreviewServer;
