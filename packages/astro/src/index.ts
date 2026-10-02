/**
 * The Astro integration. Everything here runs while the site builds, and none
 * of it reaches the deployed script.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AstroIntegration, RouteToHeaders } from 'astro';
import { AstroError } from 'astro/errors';
import {
	SIZE_LIMIT,
	START_RISK_SIZE,
	bundleServer,
	formatSize,
	relativeTo,
	sizeLimitFailure,
	NODE_BUILTINS,
} from './build/bundle.js';
import { MANIFEST_VERSION, writeBuildManifest } from './build/deploy-manifest.js';
import { buildManifest, listFiles } from './build/manifest.js';
import { writeStaticFiles } from './build/static-files.js';
import { normalizeBase } from './runtime/paths.js';
import type { RuntimeOptions } from './runtime/types.js';
import type { BunnyAdapterOptions } from './types.js';

export type {
	BunnyAdapterOptions,
	BunnyImageServiceConfig,
	BunnyRuntime,
	ImageServiceMode,
	ScriptType,
} from './types.js';
export type { BunnyCacheConfig } from './cache.js';
export type { BunnySessionConfig } from './session.js';

const PACKAGE = '@bunny.net/astro-adapter';

/**
 * Above this many client files, the manifest costs more than it saves.
 *
 * Every path is bytes in a script that has a real budget: 8824 of them cost
 * 410 kB, and a script near 8 MB does not start. So the default is the number
 * whose cost stays small next to that budget, and a site with more files probes
 * Storage for a miss instead.
 */
const DEFAULT_MANIFEST_LIMIT = 5_000;

const require = createRequire(import.meta.url);

/** A package's version, or undefined when it cannot be read. Never throws: this is only for a label. */
function versionOf(specifier: string, from?: string): string | undefined {
	try {
		const resolver = from ? createRequire(from) : require;
		return (resolver(specifier) as { version?: string }).version;
	} catch {
		return undefined;
	}
}

/** Images Astro copied without transforming them, when it had a chance to. */
const IMAGE_FILE = /\.(?:png|jpe?g|webp|avif|gif|tiff?)$/i;

export default function bunny(options: BunnyAdapterOptions = {}): AstroIntegration {
	const {
		storageZone = '',
		storageHost = '',
		outfile = 'dist/index.js',
		bundle = true,
		imageService = 'noop',
		assetCacheControl = 'public, max-age=31536000, immutable',
		pageCacheControl = 'public, max-age=60',
		serverCacheControl = 'private, no-store',
		sessions = true,
		cache = true,
		assetManifest = true,
		deploy = 'auto',
		script = 'standalone',
	} = options;

	if (script !== 'standalone' && script !== 'middleware') {
		throw new AstroError(
			`The adapter option \`script\` is "${String(script)}", but it takes "standalone" or "middleware".`,
			'Leave it out for a standalone script, the pull zone origin.',
		);
	}

	const runtime: RuntimeOptions = {
		storageZone,
		storageHost,
		// Filled in from the resolved config, below.
		base: '',
		assetCacheControl,
		pageCacheControl,
		serverCacheControl,
	};

	const manifestLimit =
		assetManifest === false
			? 0
			: typeof assetManifest === 'number'
				? assetManifest
				: DEFAULT_MANIFEST_LIMIT;

	let root: URL;
	let clientDir: URL;
	let serverDir: URL;
	let serverEntry = 'entry.mjs';
	let outDir: URL;
	let routeToHeaders: RouteToHeaders | null = null;
	let astroVersion: string | undefined;
	let assetsDir = '_astro';
	/**
	 * What Astro is building: `"server"` when any route renders per request.
	 *
	 * Astro works this out while it resolves the routes, and it is the only
	 * answer worth having. `config.output` cannot say: since Astro 5,
	 * `output: "static"` is the default and a page leaves it with
	 * `export const prerender = false`, so a static-output project can still hold
	 * routes that need a server. Reading `output` deployed those projects as
	 * files, and every dynamic route went missing without a word.
	 */
	let buildOutput: 'static' | 'server' = 'server';

	return {
		name: PACKAGE,
		hooks: {
			'astro:config:setup': ({ config, updateConfig, logger }) => {
				// The client build has no `base` prefix on disk, and every request
				// carries one. The script needs to know the prefix to remove it.
				runtime.base = normalizeBase(config.base);

				if (imageService === 'bunny') {
					updateConfig({
						image: {
							service: {
								entrypoint: `${PACKAGE}/image-service`,
								config: options.image ?? {},
							},
						},
					});
					logger.warn(
						'Images go through Bunny Optimizer, and Optimizer cannot read from an ' +
							'Edge Script yet. With Optimizer on, an image that misses the CDN cache ' +
							'answers 523. Leave imageService at its default until that is fixed.',
					);
				} else if (imageService === 'noop') {
					// sharp needs native binaries, which cannot run on the edge.
					updateConfig({
						image: { service: { entrypoint: 'astro/assets/services/noop' } },
					});
					logger.info('Images are not transformed. Pass imageService: "bunny" to use Optimizer.');
				}

				// Only fill a gap. A project that picked its own driver keeps it.
				if (sessions && config.session !== false && !config.session?.driver) {
					updateConfig({
						session: { driver: { entrypoint: `${PACKAGE}/session` } },
					} as Parameters<typeof updateConfig>[0]);
				}

				if (cache && !config.cache?.provider) {
					updateConfig({
						cache: { provider: { name: 'bunny', entrypoint: `${PACKAGE}/cache` } },
					} as Parameters<typeof updateConfig>[0]);
				}

				updateConfig({
					vite: {
						define: {
							__BUNNY_ADAPTER_OPTIONS__: JSON.stringify(runtime),
						},
					},
				});
			},

			'astro:config:done': ({ setAdapter, config, buildOutput: astroOutput }) => {
				// Read this first. `setAdapter` sets it to "server" unless the adapter
				// declares "static" back, so anything after the call reads a value the
				// call itself wrote.
				buildOutput = deploy === 'server' ? 'server' : astroOutput;

				root = config.root;
				outDir = config.outDir;
				astroVersion = versionOf('astro/package.json', fileURLToPath(new URL('./', config.root)));
				clientDir = config.build.client;
				serverDir = config.build.server;
				serverEntry = config.build.serverEntry ?? 'entry.mjs';
				assetsDir = config.build.assets;

				setAdapter({
					name: PACKAGE,
					entrypointResolution: 'auto',
					serverEntrypoint: `${PACKAGE}/${script === 'middleware' ? 'middleware' : 'server'}`,
					// A static build deploys no script, so there is nothing of ours to
					// preview. Leaving this out hands `astro preview` to Astro's own
					// static server, which serves the files the deploy will serve.
					...(buildOutput === 'server' ? { previewEntrypoint: `${PACKAGE}/preview` } : {}),
					adapterFeatures: {
						// Bunny Storage cannot hold a headers file. A server build applies
						// them in the script, and a static build writes `_headers`.
						staticHeaders: true,
						// Astro decided this, and this hands the decision back. Without it
						// Astro builds a server for a site that has no route to render.
						buildOutput,
						// A static build would otherwise put the pages in `dist` and the
						// assets beside them. The deploy uploads one directory, and every
						// build has to name the same one.
						preserveBuildClientDir: true,
						preserveBuildServerDir: true,
					},
					supportedAstroFeatures: {
						staticOutput: 'stable',
						hybridOutput: 'stable',
						serverOutput: 'stable',
						sharpImageService: 'unsupported',
						envGetSecret: 'stable',
					},
				});
			},

			'astro:build:setup': ({ vite, target }) => {
				if (target !== 'server') return;
				vite.resolve ??= {};
				const aliases = NODE_BUILTINS.map((name) => ({
					find: new RegExp(`^${name}$`),
					replacement: `node:${name}`,
				}));
				if (Array.isArray(vite.resolve.alias)) {
					vite.resolve.alias = [...vite.resolve.alias, ...aliases];
				} else {
					const existing = (vite.resolve.alias ?? {}) as Record<string, string>;
					for (const name of NODE_BUILTINS) existing[name] = `node:${name}`;
					vite.resolve.alias = existing;
				}
			},

			'astro:build:generated': ({ routeToHeaders: headers }) => {
				// Held until the bundle step, which is where they can be inlined.
				routeToHeaders = headers;
			},

			'astro:build:done': async ({ logger }) => {
				const rootDir = fileURLToPath(root);
				const clientPath = relativeTo(rootDir, fileURLToPath(clientDir));

				// A build with no route to render on demand needs nothing of ours at
				// run time. `bunny sites deploy` uploads the files, and the `bunny sites`
				// router serves them (`bunny lab deploy astro` is for a build with a
				// server, and it refuses this one): it answers a miss with `404.html`, and it reads
				// `_redirects` and `_headers`. Every static framework gets the same,
				// and a site with no server should not carry a megabyte of one.
				if (buildOutput === 'static') {
					const written = await writeStaticFiles(clientDir, routeToHeaders, runtime.base, {
						assetsDir,
						assetCacheControl,
					});

					logger.info(
						`Every route is prerendered, so this build deploys no script: \`bunny sites deploy\` uploads ${clientPath}, and the site is served as files.`,
					);
					logger.info(
						'Nothing here needs the adapter. Keep it for the day a route renders per request, and ' +
							'pass deploy: "server" if a prerendered page holds a `server:defer` island, because ' +
							'Astro gives such a project the same route list as one with no island at all.',
					);
					if (written.length > 0) {
						logger.info(
							`Wrote ${written.join(' and ')} into ${clientPath}. They are what carries your redirects and headers, and the file names are the ones a static host reads.`,
						);
					}

					// `noop` is the default because a transform on demand needs `sharp`,
					// and `sharp` needs native binaries the edge does not have. Nothing
					// here renders on demand, so nothing here asks for one. Measured on
					// astro.build: 1.3 GB of images went up untouched.
					if (imageService === 'noop') {
						const images = (await listFiles(fileURLToPath(clientDir))).filter((file) =>
							IMAGE_FILE.test(file),
						).length;
						if (images > 0) {
							logger.info(
								`${images} image(s) went into the build untransformed. Every route here is prerendered, ` +
									'so `imageService: false` lets sharp resize them while the site builds, and the deploy carries less.',
							);
						}
					}

					// What `bunny sites deploy` reads. A static build asks for no script, no
					// variable, and no pull zone setting: the files are the whole deploy.
					const staticManifest = await writeBuildManifest(rootDir, {
						manifestVersion: MANIFEST_VERSION,
						adapter: { package: PACKAGE, version: versionOf('../package.json') },
						framework: { name: 'astro', version: astroVersion },
						kind: 'static',
						assets: { dir: clientPath },
						dev: { command: 'astro dev', preview: 'astro preview' },
					});
					logger.info(`Wrote ${staticManifest}. Deploy it with: bunny sites deploy`);
					return;
				}

				if (!bundle) {
					logger.info(`Skipped bundling. The server entry is ${serverEntry}.`);
					return;
				}

				const outPath = path.resolve(rootDir, outfile);
				const manifest = await buildManifest(
					clientDir,
					routeToHeaders,
					manifestLimit,
					runtime.base,
				);

				const { bytes, largest } = await bundleServer({
					entryPoint: fileURLToPath(new URL(serverEntry, serverDir)),
					rootDir,
					outPath,
					manifest,
					options,
				});

				// The bundle now holds every server chunk, so the folder is dead weight.
				// Unless the bundle was written into it: removing the folder would then
				// delete the file this step just reported, and the build would still
				// succeed. Keep the folder and say why.
				// `resolve` drops the trailing slash a directory URL carries, so the
				// comparison below has a separator on exactly one side.
				const serverPath = path.resolve(fileURLToPath(serverDir));
				if (outPath.startsWith(serverPath + path.sep)) {
					logger.warn(
						`outfile is inside ${relativeTo(rootDir, serverPath)}, so the server output was kept. ` +
							'Point outfile somewhere else to have it cleared away.',
					);
				} else {
					await rm(serverPath, { recursive: true, force: true });
				}

				// What `astro preview` needs to find the bundle again.
				await writeFile(
					fileURLToPath(new URL('.bunny-adapter.json', outDir)),
					JSON.stringify(
						{
							outfile: relativeTo(rootDir, outPath),
							client: relativeTo(rootDir, fileURLToPath(clientDir)),
							script,
						},
						null,
						2,
					),
				);

				const relative = relativeTo(rootDir, outPath);
				if (bytes > SIZE_LIMIT) {
					// A build whose script cannot be deployed has not succeeded. Failing
					// here costs a developer one build; finding out at the deploy costs
					// them the deploy, and the site it half-created.
					//
					// `AstroError` carries the hint apart from the message, so Astro
					// prints both in its own error box. A plain Error arrives as a stack
					// trace, and the advice is what the developer needs first.
					const failure = sizeLimitFailure(relative, bytes, largest);
					throw new AstroError(failure.message, failure.hint);
				} else {
					logger.info(
						`Bundled to ${relative} (${formatSize(bytes)}, limit ${formatSize(SIZE_LIMIT)}).`,
					);
				}

				// The documented limit is 10 MB, and a script well under it can still
				// fail to start. Saying nothing here leaves a green build and a site that
				// answers 400 with no body.
				if (bytes > START_RISK_SIZE) {
					logger.warn(
						`${relative} is ${formatSize(bytes)}, and a script has 500 ms to start. Every byte of it is ` +
							'parsed first, so the edge may answer 400 with an empty body. Measured in August 2026: the same code ' +
							'served every request at 7.4 MB, and none at 7.8 MB. Prerender a route, or drop a ' +
							'dependency the server does not need.',
					);
				}

				if (manifest.assets) {
					logger.info(
						`Inlined ${manifest.assets.length} client file(s), so misses cost no lookup.`,
					);
				}

				if (manifest.redirects) {
					const count = new Set(Object.values(manifest.redirects)).size;
					logger.info(`Answering ${count} prerendered redirect(s) in the script.`);
				}

				// What `bunny lab deploy astro` reads. The CLI knows no framework, so
				// everything it needs about this build has to be in here.
				const manifestFile = await writeBuildManifest(rootDir, {
					manifestVersion: MANIFEST_VERSION,
					adapter: { package: PACKAGE, version: versionOf('../package.json') },
					framework: { name: 'astro', version: astroVersion },
					kind: 'ssr',
					script: { entry: relative, type: script, bytes },
					assets: { dir: clientPath },
					requires: {
						// No `cliVersion` floor yet. `manifestVersion` already stops a CLI
						// that cannot read this shape, and a CLI without
						// `bunny lab deploy astro` has no command to run. Set a floor here once
						// a released CLI version needs to be ruled out.
						pullZone: {
							// `Astro.cookies.set()` reaches nobody while the pull zone strips
							// Set-Cookie, and nothing in the zone says why.
							disableCookies: false,
							// Smart Cache caches known static extensions only, so it never
							// caches a page, and a `routeRules` entry does nothing while it is
							// on. The adapter protects a private page another way: a server
							// response that sets no Cache-Control gets `private, no-store`.
							enableSmartCache: false,
							// With cache slicing on, the pull zone drops storage's ETag, so a
							// stored file is downloaded again instead of revalidated.
							...(script === 'middleware' ? { enableCacheSlice: false } : {}),
						},
						...(sessions ? { storage: { write: true, reason: 'Astro.session' } } : {}),
						env: [
							{ name: 'BUNNY_STORAGE_ZONE', reason: 'the zone holding the client build' },
							{ name: 'BUNNY_STORAGE_HOST', reason: "that zone's regional endpoint" },
							{
								name: 'BUNNY_STORAGE_KEY',
								reason: "that zone's read-only password",
								secret: true,
							},
							...(sessions
								? [
										{ name: 'BUNNY_SESSION_ZONE', reason: 'Astro.session', optional: true },
										{
											name: 'BUNNY_SESSION_KEY',
											reason: 'Astro.session, a password that can write',
											secret: true,
											optional: true,
										},
									]
								: []),
							...(cache
								? [
										{
											name: 'BUNNY_PULLZONE_ID',
											reason: 'Astro.cache.invalidate()',
											optional: true,
										},
										{
											name: 'BUNNY_API_KEY',
											reason: 'Astro.cache.invalidate()',
											secret: true,
											optional: true,
										},
									]
								: []),
						],
					},
					dev: { command: 'astro dev', preview: 'astro preview' },
				});
				logger.info(`Wrote ${manifestFile}. Deploy it with: bunny lab deploy astro`);
			},
		},
	};
}
