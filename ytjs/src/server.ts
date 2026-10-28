import express, { NextFunction } from "express";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	readFileSync,
	createReadStream,
	unlinkSync,
} from "fs";
import path from "path";
// import fetch, { Response } from 'node-fetch';
import { Response } from "node-fetch";
import dotenv from "dotenv";
import { Response as EResponse } from "express";

import {
	Archive,
	ArchiveInfo,
	ArchiveInfoV1,
	ArchiveInfoV2,
	Cache,
	CacheInfoLatest,
	latestCacheConstructor,
	newArchiveFromJSON,
} from "./utils/archive";
import { Format } from "./utils/yt-types";
import { FormatOptions } from "./utils/yt-types";
import { VideoInfo } from "./utils/yt-types";
import util from "util";
import Innertube, {
	ClientType,
	Platform,
	Player,
	UniversalCache,
} from "youtubei.js";
import { Utils } from "youtubei.js";
import { InnerTubeClient } from "./utils/yt-types";
import { Types } from "youtubei.js/web";
import { warmUpPoTokenMinter } from "./utils/poToken";
import { cacheDir } from "./utils/constants";

import archiveRoutes  from "./routes/archive.route";
import rpcRoutes from "./routes/rpc.route";
import streamRoutes from "./routes/stream.route";
import templateRoutes from "./routes/template.route";
import testRoutes from "./routes/test.route";
import sabrRoutes from "./routes/sabr.route";
import nndRoutes from "./routes/nnd.route";
import { FFmpegService } from "./services/ffmpeg.service";
import { YtdlpService } from "./services/ytdlp.service";

// Set up Platform shim for deciphering streaming URLs
Platform.shim.eval = async (
	data: Types.BuildScriptResult,
	env: Record<string, Types.VMPrimative>
) => {
	const properties = [];

	if (env.n) {
		properties.push(`n: exportedVars.nFunction("${env.n}")`);
	}

	if (env.sig) {
		properties.push(`sig: exportedVars.sigFunction("${env.sig}")`);
	}

	const code = `${data.output}\nreturn { ${properties.join(", ")} }`;
	return new Function(code)();
};

process.env.UV_THREADPOOL_SIZE = "64";

dotenv.config();
const args = process.argv.slice(2);
export const useOnline =
	!args.includes("--offline") && process.env.USE_ONLINE !== "false";

export const app = express();

//let fullUrl = SERVER_CONFIG.development.url + ":" + SERVER_CONFIG.development.port;
let port = 3000;
export let fullUrl = "localhost" + ":" + port;
export const fullUrlForClient = "10.0.2.2" + ":" + port;
export const defaultLocalUrl = "localhost:3000";
// let port = SERVER_CONFIG.development.port;
// Archive lives outside dist so a build/clean of dist can never delete it.
// Override with YTJS_ARCHIVE_DIR in .env (relative to the ytjs folder or absolute).
export let archiveDir = process.env.YTJS_ARCHIVE_DIR || "./archive";
export let yti_version = "0.0.0";
export let archive = {} as Archive;
export let cache = {} as Cache;
export let archiveContainer = "mp4";
let onlineTimeoutMs = 10000;
export let clientName: InnerTubeClient = "MWEB";
let clientTypeName: ClientType = ClientType.MWEB;


declare global {
	var youtube: Innertube | undefined;
	var online: boolean;
	//   var JSDOM: JSDOMType | null;
	//   var BG: BGType | null;
	var ffmpeg_version: string | null | undefined;
	var yt_dlp_version: string | null | undefined;
}

globalThis.youtube = undefined;
globalThis.online = false;
globalThis.ffmpeg_version = undefined;
globalThis.yt_dlp_version = undefined;


function setYoutube(itube: Innertube) {
	globalThis.youtube = itube;
}

export function getYouTube(): Innertube | undefined {
	return globalThis.youtube;
}

function setOnline(online: boolean) {
	globalThis.online = online;
}

function isOnline(): boolean {
	return globalThis.online;
}

const getBrowserName = (userAgent: string) => {
	if (userAgent.includes("Edge")) {
		return "Edge";
	} else if (userAgent.includes("Firefox")) {
		return "Firefox";
	} else if (userAgent.includes("Chrome")) {
		return "Chrome";
	} else if (userAgent.includes("Trident")) {
		return "IE";
	} else {
		return "Unknown";
	}
};

function loadJsonFilesIntoArchive(archiveDir: string, archive: Archive) {
	const files = readdirSync(archiveDir);

	files.forEach((file) => {
		const filePath = path.join(archiveDir, file);
		const stats = statSync(filePath);

		if (stats.isDirectory()) {
			loadJsonFilesIntoArchive(filePath, archive);
		} else if (file === "info.json") {
			const key = path.basename(archiveDir);
			const jsonContent = readFileSync(filePath, "utf-8");

			const jsonData = newArchiveFromJSON(jsonContent);
			if (jsonData) {
				archive[key] = jsonData;
			} else {
				console.error(`Failed to parse JSON file: ${filePath}`);
			}
		}
	});
}

const longRunningRequestMiddleware = (threshold: number = 5000) => {
	return (req: Request, res: EResponse, next: NextFunction) => {
		const start = Date.now();
		let requestEnded = false;

		// Function to log long-running request
		const logLongRunningRequest = () => {
			if (!requestEnded) {
				const duration = Date.now() - start;
				console.warn(
					`Long-running request detected: ${req.method} ${req.url} - Duration: ${duration}ms`
				);
			}
		};

		// Set a timeout to check if the request is still running after the threshold
		const timeoutId = setTimeout(logLongRunningRequest, threshold);

		// Capture when the response finishes
		res.on("finish", () => {
			requestEnded = true;
			clearTimeout(timeoutId);
		});

		next();
	};
};

function transformWebVTT(vtt: string, target?: string) {
	// For IE11, strip all styling and metadata that causes parsing issues
	if (target === 'IE') {
		console.log('[VTT] Applying IE11-compatible transformations (strip styling)');
		const kindRegex = /Kind: (.*)\n/;
		const langKindRegex = /Language: (.*)\n/;
		const styleRegex = /Style:\n(::cue\(.*?\)\s*{\s*.*?\s*}\n?)*\n?##\n?/gs;
		return vtt
			.replace(kindRegex, "")
			.replace(langKindRegex, "")
			.replace(styleRegex, "");
	}
	
	// For WebView2 and modern browsers, preserve the original formatting
	if (target === 'webview2' || target === 'default') {
		console.log('[VTT] Serving original VTT with all styling preserved');
		return vtt;
	}
	
	// Fallback to IE11 transformations
	console.log('[VTT] Target not specified, applying IE11-compatible transformations');
	const kindRegex = /Kind: (.*)\n/;
	const langKindRegex = /Language: (.*)\n/;
	const styleRegex = /Style:\n(::cue\(.*?\)\s*{\s*.*?\s*}\n?)*\n?##\n?/gs;
	return vtt
		.replace(kindRegex, "")
		.replace(langKindRegex, "")
		.replace(styleRegex, "");
}

export async function getCacheWait(
	v_id: string,
	retry: boolean = true,
	interval: number = 100,
	timeout = 10000
): Promise<ArchiveInfo | CacheInfoLatest | null | undefined> {
	if (!isOnline() || archive[v_id]) {
		return archive[v_id] as ArchiveInfo;
	} else if (cache[v_id]) {
		return cache[v_id] as CacheInfoLatest;
	} else if (retry) {
		console.log(
			`Waiting for cache: ${v_id}, retry: ${retry}, interval: ${interval}, timeout: ${timeout}`
		);
		let start = Date.now();
		while (!cache[v_id] && Date.now() - start < timeout) {
			await new Promise((r) => setTimeout(r, interval));
		}
		if (Date.now() - start >= timeout) {
			console.log(
				`Timeout waiting for cache: ${v_id} after reaching max for call ${timeout}ms`
			);
		}
		return cache[v_id] ? cache[v_id] : null;
	}
}

export async function fetchWait(
	url: URL,
	retry: boolean = true,
	timeout = -1,
	interval: number = 1000
) {
	const baseUrl = new URL(url.href);
	try {
		const res = await fetch(baseUrl.href);
		return res;
	} catch (error) {
		// TODO stepback algorithm
		let tries = 0;
		let start = Date.now();
		while (
			tries < 6 &&
			retry &&
			(timeout == -1 || Date.now() - start < timeout)
		) {
			try {
				const res = await fetch(baseUrl.href);
				return res;
			} catch (fetchError) {
				error = fetchError;
				tries++;
				await new Promise((r) => setTimeout(r, interval));
				interval *= 2;
			}
		}
		throw error;
	}
}

export async function fetchTransformedVTT(url: URL, target?: string) {
	const baseUrl = new URL(url.href);
	baseUrl.searchParams.set("fmt", "vtt");

	try {
		// it is assumed that dashjs/HTML will retry on failure
		const res = await fetchWait(baseUrl, false);

		if (res == null) {
			return null;
		}

		if(res.status < 200 || res.status > 299){
			throw new Error("error fetching non 200 code")
		}

		const text = await res.text();
		return transformWebVTT(text, target);
	} catch (error: any) {
		console.error(`Error fetching VTT file: ${error.message}`);
		// return null;
		throw error;
	}
}

// I have a hunch this disables some slow SM caching mechanisms
const setNoCacheHeaders = (
	req: express.Request,
	res: express.Response,
	next: express.NextFunction
) => {
	// Set Cache-Control header to prevent caching
	res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

	// Set Pragma header to prevent caching in old HTTP/1.0 clients
	res.setHeader("Pragma", "no-cache");

	// Set Expires header to a past date to ensure no caching
	res.setHeader("Expires", "0");

	// Continue to the next middleware
	next();
};

app.use(express.static("./dist"), setNoCacheHeaders);
app.use(express.static("../dist"), setNoCacheHeaders);
// The archive now lives outside dist, so it needs an explicit mount.
// URLs of the form /archive/<v_id>/<file> are emitted by archive.route.ts and
// stream.route.ts independently of where archiveDir points.
// Resolved per-request because startServer() may reassign archiveDir to the
// legacy ./dist/archive location after this module has been loaded.
// The static handler is cached per resolved path to avoid rebuilding it.
let archiveStaticHandler: {
	dir: string;
	handler: express.RequestHandler;
} | null = null;
app.use("/archive", setNoCacheHeaders, (req, res, next) => {
	if (!archiveStaticHandler || archiveStaticHandler.dir !== archiveDir) {
		archiveStaticHandler = {
			dir: archiveDir,
			handler: express.static(archiveDir),
		};
	}
	archiveStaticHandler.handler(req, res, next);
});

// Custom middleware to log all requests
app.use(async (req, res, next) => {
	const timestamp = new Date().toISOString();
	const method = req.method;
	let url = req.url;
	const ip = req.ip;

	if (url.startsWith("/proxy/")) {
		url = url.substring(0, 20) + "..." + url.substring(url.length - 20);
	}
	console.log(`[${timestamp}] ${method} ${url}`);

	next(); // Call next() to pass control to the next middleware
});

// Define endpoints to monitor
const monitoredEndpoints = ['/mpd/', 
	// '/archive/', '/captions/', '/formats/', '/youtubeformats/'
];

// Detailed request logging middleware
app.use((req, res, next) => {
	// Check if the request URL starts with any monitored endpoint
	const shouldLog = monitoredEndpoints.some(endpoint => req.url.startsWith(endpoint));
	
	if (!shouldLog) {
		return next();
	}

	const logData = {
		timestamp: new Date().toISOString(),
		method: req.method,
		url: req.url,
		protocol: req.protocol,
		ip: req.ip,
		userAgent: req.headers['user-agent'],
		referer: req.headers.referer || 'none', 
		host: req.headers.host,
		accept: req.headers.accept,
		acceptLanguage: req.headers['accept-language'],
		acceptEncoding: req.headers['accept-encoding'],
		connection: req.headers.connection,
		cookies: req.headers.cookie,
		xForwardedFor: req.headers['x-forwarded-for'],
	};

	console.log('Request Details:', JSON.stringify(logData, null, 2));
	next();
});

// @ts-ignore
app.use(longRunningRequestMiddleware(5000));

app.use(archiveRoutes);
app.use(rpcRoutes);
app.use(streamRoutes);
app.use(templateRoutes);
app.use(testRoutes);
app.use(sabrRoutes);
app.use(nndRoutes);

async function callRejectAfter(call: Promise<unknown>, timeMs: number) {
	return Promise.race([
		await call,
		new Promise((resolve, reject) =>
			setTimeout(() => {
				reject();
			}, timeMs)
		),
	]);
}


async function connectInnertube(videoId?: string) {
	// Camoufox launch overlaps Innertube creation; minting awaits the same
	// shared runtime, so a slow first launch does not block server startup.
	warmUpPoTokenMinter();

	if (!videoId) {
		return await Innertube.create({
			retrieve_player: false,
			client_type: clientTypeName,
			// player_id: "9f4cc5e4",
			// player_id: "4c5cf06a",
		});
	}
}

function startServer() {
	app.listen(port, async () => {
		console.log(
			`Server started at http://${fullUrl}, client need to see: ${fullUrlForClient}`
		);
		try {
			throw new Utils.InnertubeError(
				"This is thrown to get the version of youtubei.js"
			);
		} catch (error) {
			if (error instanceof Utils.InnertubeError) {
				yti_version = error.version;
			}
		}
		console.log(`Using youtubei.js version ${yti_version}`);

		try {
			const ffmpegVersion = await FFmpegService.getVersion();
			if (ffmpegVersion) {
				globalThis.ffmpeg_version = ffmpegVersion;
				console.log(`Using FFmpeg version ${ffmpegVersion}`);
			} else {
				console.warn("FFmpeg not found on system - MPD fallback downloads will not be available");
				globalThis.ffmpeg_version = null;
			}
		} catch (error) {
			console.warn(`Error checking FFmpeg version: ${error}`);
			globalThis.ffmpeg_version = null;
		}

		try {
			const ytdlpVersion = await YtdlpService.getVersion();
			if (ytdlpVersion) {
				globalThis.ffmpeg_version = ytdlpVersion;
				console.log(`Using ytdlp version ${ytdlpVersion}`);
			} else {
				console.warn("Ytdlp not found on system - ytdlp fallback downloads will not be available");
				globalThis.yt_dlp_version = null;
			}
		} catch (error) {
			console.warn(`Error checking Ytdlp version: ${error}`);
			globalThis.yt_dlp_version = null;
		}


		if (!existsSync(cacheDir)) {
			mkdirSync(cacheDir);
		} else {
			// clear cacheDir if it exists and data is older than 30 minutes
			const files = readdirSync(cacheDir);
			for (const file of files) {
				// safety - only delete names that have a hex pattern  ^(innertube_session_data|[0-9a-f]{8})$
				if (!/^(innertube_session_data|[0-9a-f]{8})$/.test(file)) {
					console.log(`Skipping deletion of .cache/${file} [INVALID CACHE DATA]`);
					continue;
				}
				const filePath = path.join(cacheDir, file);
				const stats = statSync(filePath);
				if (Date.now() - stats.mtimeMs > 30 * 60 * 1000) {
					unlinkSync(filePath);
					console.log(`Deleted ${filePath} [OLD CACHE DATA]`);
				}
			}
		}

		async function createInnertubeWithRetry(
			retryCount: number
		): Promise<Innertube> {
			try {
				return (await callRejectAfter(
					connectInnertube(),
					onlineTimeoutMs
				)) as Innertube;
			} catch (error) {
				console.log(error);
				if (retryCount > 0) {
					console.log(
						"Innertube connection failed, retry attempt: " + (4 - retryCount)
					);
					return createInnertubeWithRetry(retryCount - 1);
				} else {
					throw new Error(
						"Innertube could not be fetched. Running in offline (archive only) mode..."
					);
				}
			}
		}

		if (!useOnline) {
			console.log("Running in offline (archive only) mode...");
		} else {
			setTimeout(async () => {
				console.log("Attempting to create Innertube instance...");
				try {
					const itube = await createInnertubeWithRetry(3);
					setYoutube(itube);
					setOnline(true);
					console.log("Innertube instance created successfully.");
				} catch (error) {
					setOnline(false);
					console.log(
						"Innertube could not be fetched. Running in offline (archive only) mode..."
					);
				}
			});
		}

		// Backwards compatibility: the archive used to live inside dist, where a
		// rebuild can wipe it. If the old location still has content, keep using
		// it (load + serve + write) so migration is non-destructive, and warn.
		const legacyArchiveDir = "./dist/archive";
		const legacyHasContent =
			existsSync(legacyArchiveDir) &&
			readdirSync(legacyArchiveDir).length > 0 &&
			path.resolve(legacyArchiveDir) !== path.resolve(archiveDir);

		if (legacyHasContent) {
			console.warn(
				"\n========================= WARNING =========================\n" +
					`Archive content found in the OLD, UNSAFE location: ${path.join(
						process.cwd(),
						legacyArchiveDir
					)}\n` +
					"A rebuild/clean of 'dist' can DELETE your archived videos.\n" +
					`Please migrate its contents to: ${path.join(
						process.cwd(),
						archiveDir
					)}\n` +
					"Set YTJS_ARCHIVE_DIR in your .env to customize the location.\n" +
					"===========================================================\n"
			);
			// Keep serving/writing from the legacy location until migrated, so
			// archive.route.ts (path.join(archiveDir, v_id)) agrees with what we
			// loaded and what the /archive mount serves.
			archiveDir = legacyArchiveDir;
		}

		// TODO support symlink
		if (!existsSync(archiveDir)) {
			mkdirSync(archiveDir, { recursive: true });
			console.log("created a new archive");
		} else {
			const curDir = process.cwd();
			console.log(
				`loading existing archive using path: ${path.join(curDir, archiveDir)}`
			);
			loadJsonFilesIntoArchive(archiveDir, archive);
			console.log("loaded archive: " + Object.keys(archive).length + " videos");
		}
		console.log(`Video archive loaded.`);
		console.log("Ready to accept requests.");
	});
}

startServer();
