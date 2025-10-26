import { CaptionTrack } from "./../../src/app/utils/types";
import express, { NextFunction } from "express";
// @ts-ignore
import corsAnywhere from "cors-anywhere";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	readFileSync,
	createWriteStream,
	writeFileSync,
	renameSync,
	createReadStream,
	unlinkSync,
} from "fs";
import { spawn } from "child_process";
import path from "path";
// import fetch, { Response } from 'node-fetch';
import { Response } from "node-fetch";
import dotenv from "dotenv";
import { Response as EResponse } from "express";

import {
	Archive,
	ArchiveInfo,
	ArchiveInfoLatest,
	ArchiveInfoV1,
	ArchiveInfoV2,
	Cache,
	CacheInfoLatest,
	latestArchiveConstructor,
	latestCacheConstructor,
	newArchiveFromJSON,
} from "./utils/archive";
import { Format } from "youtubei.js/dist/src/parser/misc";
import { FormatOptions } from "youtubei.js/dist/src/types/FormatUtils";
import { VideoInfo } from "youtubei.js/dist/src/parser/youtube";
import { PlayerCaptionsTracklist } from "youtubei.js/dist/src/parser/nodes";
import { ElementInfo } from "./utils/element";
import { commandExists, getCommandOutput } from "./utils/lib";
import util from "util";
import Innertube, {
	ClientType,
	Platform,
	Player,
	UniversalCache,
} from "youtubei.js";
import { Utils } from "youtubei.js";
import { InnerTubeClient } from "youtubei.js/dist/src/types";
import { Types } from "youtubei.js/web";
import { setupBotGuardGlobals } from "./utils/poToken";
import { JSDOM } from "jsdom";
import { getLocalVideoInfo } from "./utils/localvideo";
import { cacheDir } from "./utils/constants";
import { createCanvas, loadImage } from "@napi-rs/canvas";

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
const useOnline =
	!args.includes("--offline") && process.env.USE_ONLINE !== "false";

const app = express();

//let fullUrl = SERVER_CONFIG.development.url + ":" + SERVER_CONFIG.development.port;
let port = 3000;
let fullUrl = "localhost" + ":" + port;
const fullUrlForClient = "10.0.2.2" + ":" + port;
const defaultLocalUrl = "localhost:3000";
// let port = SERVER_CONFIG.development.port;
let archiveDir = "./dist/archive";
let elementsDir = "./dist/elements";
let yti_version = "0.0.0";
let archive = {} as Archive;
let cache = {} as Cache;
let archiveContainer = "mp4";
let onlineTimeoutMs = 10000;
let clientName: InnerTubeClient = "MWEB";
let clientTypeName: ClientType = ClientType.MWEB;

// const outputDir = 'output_test';
// // Ensure output directory exists
// if (!existsSync(outputDir)) {
//   mkdirSync(outputDir);
// }

const proxy = corsAnywhere.createServer({
	originWhitelist: [], // Allow all origins
	requireHeaders: [], // Do not require any headers.
	removeHeaders: [], // Do not remove any headers.
});

// TODO better match the format to the browser
const formatMap = {
	IE: ["avc1.4d401f", "mp4a.40.2"],
	Chrome: ["avc1.4d401f", "mp4a.40.2"],
	Firefox: ["avc1.4d401f", "opus"],
	Edge: ["avc1.4d401f", "mp4a.40.2"],
};

const formatsToUse = [
	// 599 m4a audio only | mp4a.40.5 22050Hz ultralow, m4a_dash
	"mp4a.40.5",
	// 133 mp4 426x240 30 | avc1.4d4015 240p, mp4_dash
	// 'avc1.4d4015',
	// 134 mp4 640x360 30 | avc1.4d401e 360p, mp4_dash
	"avc1.4d401e",
	// 140 m4a audio only | mp4a.40.2 44100Hz medium, m4a_dash
	"mp4a.40.2",
	// 135 mp4 854x480 30 | avc1.4d401f 480p, mp4_dash
	"avc1.4d401f",
	// 298 mp4 1280x720 60 | avc1.4d4020 720p60, mp4_dash
	"avc1.4d4020",
	// 299 mp4 1920x1080 60 | avc1.64002a 1080p60, mp4_dash
	"avc1.64002a",
	// 720p > H.264 - High Profile - Level 3.1
	"avc1.64001f",
	// 1080p > H.264 - High Profile - Level 4.0
	"avc1.640028",
];

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
// globalThis.JSDOM = null;
// globalThis.BG = null;
globalThis.ffmpeg_version = undefined;
globalThis.yt_dlp_version = undefined;

// async function loadJSDOM(): Promise<JSDOMType | null> {
// 	if (globalThis.JSDOM) {
// 		return globalThis.JSDOM;
// 	} else {
// 		try {
// 			const jsdom = await import('jsdom');
// 			globalThis.JSDOM = jsdom.JSDOM;
// 			return jsdom.JSDOM;
// 		} catch (error) {
// 			console.warn('JSDOM could not be loaded');
// 			return null;
// 		}
// 	}
// }

// async function loadBG(): Promise<BGType | null> {
//   try {
// 	// @ts-ignore
// 	const bg = await import('bgutils-js');
// 	return bg.BG;
//   } catch (error) {
// 	console.warn('BotGuard utils could not be loaded:');
// 	return null;
//   }
// }

function setYoutube(itube: Innertube) {
	globalThis.youtube = itube;
}

function getYouTube(): Innertube | undefined {
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

function transformWebVTT(vtt: string) {
	const kindRegex = /Kind: (.*)\n/;
	const langKindRegex = /Language: (.*)\n/;
	// const styleRegex = /Style:\n(::cue\(.*?\)\s*{\s*.*?\s*}\n?)*/gs;
	const styleRegex = /Style:\n(::cue\(.*?\)\s*{\s*.*?\s*}\n?)*\n?##\n?/gs;
	// const alignRegex = /align:start position:0%\n/;
	return vtt
		.replace(kindRegex, "")
		.replace(langKindRegex, "")
		.replace(styleRegex, "");
	// .replace(alignRegex, 'align:start position:0%\n');
}

async function getCacheWait(
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

async function fetchWait(
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

async function fetchTransformedVTT(url: URL) {
	const baseUrl = new URL(url.href);
	baseUrl.searchParams.set("fmt", "vtt");

	try {
		// it is assumed that dashjs/HTML will retry on failure
		const res = await fetchWait(baseUrl, false);

		if (res == null) {
			return null;
		}

		const text = await res.text();
		return transformWebVTT(text);
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

/* Attach our cors proxy to the existing API on the /proxy endpoint. */
app.get("/proxy/:proxyUrl*", async (req, res) => {
	req.url = req.url.replace("/proxy/", "/"); // Strip '/proxy' from the front of the URL, else the proxy won't work.
	proxy.emit("request", req, res);
});

app.get("/mpd/invalidate/:v_id", async (req, res) => {
	const v_id = req.params.v_id;
	console.log("invalidating mpd cache for " + v_id);
	cache[v_id].mpd_manifest = "";
	res.send("OK");
});

app.get('/dummy-manifest.mpd', (req, res) => {
  res.type('application/dash+xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<MPD
  xmlns="urn:mpeg:dash:schema:mpd:2011"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="urn:mpeg:dash:schema:mpd:2011 DASH-MPD.xsd"
  mediaPresentationDuration="PT0H0M30.0S"
  minBufferTime="PT1.5S"
  profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"
  type="static">

  <Period id="1" start="PT0S">
    <AdaptationSet id="1" contentType="video" mimeType="video/mp4" segmentAlignment="true">
      <Representation id="1" bandwidth="1000000" width="640" height="360" frameRate="30">
        <BaseURL>dummy-segment-</BaseURL>
        <SegmentTemplate timescale="1000" media="$Number$.m4s" initialization="$Number$-init.m4s" startNumber="1"/>
      </Representation>
    </AdaptationSet>
    <AdaptationSet id="2" contentType="audio" mimeType="audio/mp4" segmentAlignment="true">
      <Representation id="2" bandwidth="128000" audioSamplingRate="44100">
        <BaseURL>dummy-audio-</BaseURL>
        <SegmentTemplate timescale="1000" media="$Number$.m4s" initialization="$Number$-init.m4s" startNumber="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`);
});

app.get("/templateUrl/:id", async (req, res) => {
	const id = req.params.id;
	if (id.length == 11) {
		console.log("11 len ID detected, returning the player");
		res.send(`http://${fullUrlForClient}/templates/smplayer.html`);
		return;
	}

	// open FS at elements/id and read info.json, return its HTML
	// patch together and send
	const dir = path.join(elementsDir, id);
	if (!existsSync(dir)) {
		res.status(404).send("Not found: " + dir);
		return;
	}
	const info = JSON.parse(
		readFileSync(path.join(dir, "info.json"), "utf-8")
	) as ElementInfo;

	// open at templates/id.html and ret the template
	// const template = JSON.parse(readFileSync(path.join(archiveDir, 'templates', info.templateId + '.json'), 'utf-8'));

	res.send(`http://${fullUrlForClient}/templates/${info.templateId}.html`);
});

app.get("/status/", async (req, res) => {
	if (
		globalThis.ffmpeg_version === undefined ||
		globalThis.yt_dlp_version === undefined
	) {
		const [ffmpeg_version, yt_dlp_version] = await Promise.all([
			getCommandOutput("ffmpeg", true, "-version"),
			getCommandOutput("yt-dlp", true, "--version"),
		]);
		globalThis.ffmpeg_version = ffmpeg_version as string | null;
		globalThis.yt_dlp_version = yt_dlp_version as string | null;
	}

	res.send({
		youtubeijs_version: yti_version,
		ffmpeg_version,
		yt_dlp_version,
	});
});

app.get("/ffmpeg/:id", async (req, res) => {
	const id = req.params.id;

	// Set headers for HLS streaming
	res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
	res.setHeader("Cache-Control", "no-cache");
	res.setHeader("Connection", "keep-alive");

	// Construct yt-dlp command
	const ytDlpArgs = [
		"https://www.youtube.com/watch?v=" + id,
		"--format",
		"bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
		"-o",
		"-", // Output to stdout
	];

	// Construct ffmpeg command
	const ffmpegArgs = [
		"-i",
		"pipe:0", // Read from stdin
		"-c:v",
		"libx264",
		"-c:a",
		"aac",
		"-f",
		"hls",
		"-hls_time",
		"10",
		"-hls_list_size",
		"0",
		"-hls_segment_type",
		"mpegts",
		"-hls_flags",
		"delete_segments+omit_endlist",
		"pipe:1", // Output to stdout
	];

	if ((await commandExists("ffmpeg")) && (await commandExists("yt-dlp"))) {
		// Spawn yt-dlp process
		const ytDlp = spawn("yt-dlp", ytDlpArgs);
		// Spawn ffmpeg process
		const ffmpeg = spawn("ffmpeg", ffmpegArgs);

		// Pipe yt-dlp output to ffmpeg input
		ytDlp.stdout.pipe(ffmpeg.stdin);

		// Pipe ffmpeg output to response
		ffmpeg.stdout.pipe(res);

		ytDlp.stderr.on("data", (data) => {
			console.error(`yt-dlp error: ${data}`);
		});

		ffmpeg.stderr.on("data", (data) => {
			console.error(`ffmpeg error: ${data}`);
		});

		ytDlp.on("close", (code) => {
			console.log(`yt-dlp process exited with code ${code}`);
			if (code !== 0) {
				console.error("Error during video download");
			}
		});

		ffmpeg.on("close", (code) => {
			console.log(`ffmpeg process exited with code ${code}`);
			if (code === 0) {
				console.log("Transcoding finished successfully");
			} else {
				console.error("Error during transcoding");
			}
			res.end();
		});

		// Handle client disconnect
		req.on("close", () => {
			ytDlp.kill();
			ffmpeg.kill();
			console.log("Client disconnected, killed processes");
		});
	} else {
		res.send("ffmpeg does not exist");
	}
});

app.get("/vidtest/:videoId.mp4", (req, res) => {
	const videoId = req.params.videoId;
	const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

	// Get video info first
	const infoProcess = spawn("yt-dlp", [
		videoUrl,
		"--format",
		"bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
		"--print",
		"filesize",
		"--no-download",
	]);

	let fileSize = "";
	infoProcess.stdout.on("data", (data) => {
		fileSize += data.toString();
	});

	infoProcess.on("close", (code) => {
		if (code !== 0) {
			console.error("Error getting video info");
			return res.sendStatus(500);
		}

		fileSize = parseInt(fileSize.trim()).toString();

		const range = req.headers.range;
		if (range) {
			const parts = range.replace(/bytes=/, "").split("-");
			const start = parseInt(parts[0], 10);
			const end = parts[1] ? parseInt(parts[1], 10) : Number(fileSize) - 1;
			const chunksize = end - start + 1;
			const headers = {
				"Content-Range": `bytes ${start}-${end}/${fileSize}`,
				"Accept-Ranges": "bytes",
				"Content-Length": chunksize,
				"Content-Type": "video/mp4",
			};
			res.writeHead(206, headers);

			const ytDlpProcess = spawn("yt-dlp", [
				videoUrl,
				"--format",
				"bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
				"-o",
				"-",
			]);

			const ffmpegProcess = spawn("ffmpeg", [
				"-i",
				"pipe:0",
				"-ss",
				`${(Number(start) / Number(fileSize)) * 100}%`,
				"-i",
				"pipe:0",
				"-t",
				`${(Number(chunksize) / Number(fileSize)) * 100}%`,
				"-c",
				"copy",
				"-f",
				"mp4",
				"pipe:1",
			]);

			ytDlpProcess.stdout.pipe(ffmpegProcess.stdin);
			ffmpegProcess.stdout.pipe(res);

			ytDlpProcess.stderr.on("data", (data) => {
				console.error(`yt-dlp error: ${data}`);
			});

			ffmpegProcess.stderr.on("data", (data) => {
				console.error(`ffmpeg error: ${data}`);
			});

			ffmpegProcess.on("close", (code) => {
				console.log(`ffmpeg process exited with code ${code}`);
				if (code !== 0) {
					console.error("Error during video streaming");
				}
				res.end();
			});

			req.on("close", () => {
				ytDlpProcess.kill();
				ffmpegProcess.kill();
				console.log("Client disconnected, killed processes");
			});
		} else {
			const headers = {
				"Content-Length": fileSize,
				"Content-Type": "video/mp4",
			};
			res.writeHead(200, headers);

			const ytDlpArgs = [
				videoUrl,
				"--format",
				"bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
				"--output",
				"-",
			];

			const ytDlp = spawn("yt-dlp", ytDlpArgs);
			ytDlp.stdout.pipe(res);

			ytDlp.stderr.on("data", (data) => {
				console.error(`yt-dlp error: ${data}`);
			});

			ytDlp.on("close", (code) => {
				console.log(`yt-dlp process exited with code ${code}`);
				if (code !== 0) {
					console.error("Error during video streaming");
				}
				res.end();
			});

			req.on("close", () => {
				ytDlp.kill();
				console.log("Client disconnected, killed yt-dlp process");
			});
		}
	});
});

// TODO quality selection
app.get("/streamUrl/:v_id", async (req, res) => {
	const v_id = req.params.v_id;
	const start = req.query.startSec;
	const stop = req.query.stopSec;
	const target = req.query.target;
	if (!start || !stop || !target) {
		res.status(400).send("Missing start, stop, or target");
		return;
	}

	const archiveFormats = archive[v_id]?.file_formats;
	if (archiveFormats) {
		// const bestFormat = Array.from(Object.values(archive[v_id].file_formats)).sort((a, b) => b.bitrate - a.bitrate)[0];
		const bestKey = Object.keys(archive[v_id].file_formats).sort(
			(a, b) => archiveFormats[a].bitrate - archiveFormats[b].bitrate
		)[0];
		const bestFormat = archiveFormats[bestKey];

		if (bestFormat) {
			const url = new URL(
				`http://${fullUrlForClient}/archive/${v_id}/${bestKey}`
			);
			res.send(url.href);
			return;
		}
	} else {
		const url = new URL(`http://${fullUrlForClient}/mpd/${v_id}.mpd`);
		url.searchParams.set("target", target as string);
		res.send(url.href + "#" + start + "," + stop);
	}
});

/** SImply waits for archiveInfo to be loaded, expecting another process to cache it
 * eg, the initial request to /mpd
 */
app.get("/archiveInfo/:v_id", async (req, res) => {
	const v_id = req.params.v_id;
	const archiveInfo = await getCacheWait(v_id);
	if (archiveInfo) {
		res.send(archiveInfo);
	} else {
		res.status(404).send({});
	}
});

async function getSupportedFormats(videoInfoFull: VideoInfo) {
	const supported = [
		{
			type: "video+audio", // audio, video or video+audio
			quality: "1080p", // best, bestefficiency, 144p, 240p, 480p, 720p and so on.
			format: "mp4", // media container format
		},
		{
			type: "video+audio", // audio, video or video+audio
			quality: "720p", // best, bestefficiency, 144p, 240p, 480p, 720p and so on.
			format: "mp4", // media container format
		},
		{
			type: "video+audio", // audio, video or video+audio
			quality: "480p", // best, bestefficiency, 144p, 240p, 480p, 720p and so on.
			format: "mp4", // media container format
		},
		{
			type: "video+audio", // audio, video or video+audio
			quality: "360p", // best, bestefficiency, 144p, 240p, 480p, 720p and so on.
			format: "mp4", // media container format
		},
		{
			type: "video+audio", // audio, video or video+audio
			quality: "240p", // best, bestefficiency, 144p, 240p, 480p, 720p and so on.
			format: "mp4", // media container format
		},
		//{
		//	type: 'video+audio', // audio, video or video+audio
		//	quality: '144p', // best, bestefficiency, 144p, 240p, 480p, 720p and so on.
		//	format: 'mp4' // media container format
		//},
	] as FormatOptions[];

	const fileFormats: { [key: string]: Format } = {};

	for (const formatOpt of supported) {
		// assume chooseFormat is used internally deterministically
		try {
			const format = await videoInfoFull.chooseFormat(formatOpt);
			// console.log("deciphered: ", JSON.stringify(format.decipher(getYouTube()!.session.player)));
			fileFormats[format.itag + "." + archiveContainer] = format;
		} catch (error) {
			console.log("failed to get format: " + error);
			continue;
		}
	}

	return fileFormats;
}

async function getSupportedFormats2(
	videoInfoFull: VideoInfo,
	skipDuplicates = false
) {
	const types = ["video+audio", "video", "audio"] as FormatOptions["type"][];
	const qualities = [
		"144p",
		"240p",
		"360p",
		"480p",
		"720p",
		"best",
		"bestefficiency",
	];

	const avFormats = {} as { [quality: string]: Format };
	const aFormats = {} as { [quality: string]: Format };
	const vFormats = {} as { [quality: string]: Format };

	for (const type of types) {
		for (const quality of qualities) {
			const formatOpt = { type, quality, format: "mp4" } as FormatOptions;
			try {
				if (skipDuplicates && type == "video" && avFormats[quality]) continue;

				const format = await videoInfoFull.chooseFormat(formatOpt);
				if (format.has_audio && format.has_video) {
					avFormats[quality] = format;
				} else if (format.has_audio && !format.has_video) {
					aFormats[quality] = format;
				} else if (format.has_video && !format.has_audio) {
					vFormats[quality] = format;
				}
			} catch (error) {
				console.log("failed to get format: " + error);
				continue;
			}
		}
	}
	return { avFormats, aFormats, vFormats };
}

type FormatWithURL = Format & { freeTubeUrl: string };


app.get("/magnify", async (req, res) => {
	res.send("Magnify!");
	const dir = spawn("cmd", ["/c", "magnify"]);

	dir.stdout.on("data", (data) => console.log(`stdout: ${data}`));
	dir.stderr.on("data", (data) => console.log(`stderr: ${data}`));
	dir.on("close", (code) =>
		console.log(`child process exited with code ${code}`)
	);
});

app.get("/archivei/", async (req, res) => {
	res.send(archive);
});

app.get("/cachei/", async (req, res) => {
	res.send(cache);
});

app.get("/v1fix/", async (req, res) => {
	const fixVerPairs = [
		1,
		2,
		"archived captions saved the auto transcription\
	 instead of manual subs. This will query every youtube video and dl the right\
	versions. It will also rename all of the asr captions to a.[LANG] and manual\
	to .[LANG]",
		"This will query youtube for several tens or hundreds of videos in your collection, do you wish to continue? (y/n)",
	];

	// 0. check the info.version is 1
	// 1. find all the ASR pairs in archive, that is - if the same language code appears twice and one of them have "kind": "asr" set. Use
	// 2. for each pair, call patchCaptions
	// 3. update the info.json file and increment the version number to 2
	for (const v_id of Object.keys(archive)) {
		// for( const v_id of ["5y3sSEvT4cE"]) {
		const info = archive[v_id];

		if (info.version != 1) {
			console.log("skipping, " + v_id + " due to version != 1.");
			continue;
		}

		if (!info?.captions) {
			console.log("skipping, " + v_id + " due to no captions.");
			continue;
		}

		// const langCodes = info.captions.translation_languages?.map(lang => lang.language_code);
		const captionTracks = info.captions.caption_tracks;
		const archiveEntryDir = path.join(archiveDir, v_id);
		const captionsDir = path.join(archiveEntryDir, "captions");
		const infoPath = path.join(archiveEntryDir, "info.json");

		// if(!langCodes || !captionTracks) {
		// 	return res.status(400).send("No translation languages found in archive for " + v_id);
		// }
		if (!captionTracks) {
			console.log("skipping, " + v_id + " due to no caption tracks.");
			continue;
		}

		// const asrManualPair = langCodes.find(code => captionTracks.find
		const asrPair = captionTracks.filter(
			(track) =>
				captionTracks.filter((t) => t.language_code == track.language_code)
					.length > 1 &&
				captionTracks.find(
					(t) => t.language_code == track.language_code && t.kind == "asr"
				) != null
		);

		if (asrPair.length == 0) {
			const asrOnlyCap = captionTracks.find((track) => track.kind == "asr");
			if (asrOnlyCap) {
				const indexedStreams = new Array(captionTracks.length).fill(
					null
				) as (NodeJS.ReadableStream | null)[];
				const asrStream = createReadStream(
					path.join(captionsDir, asrOnlyCap.language_code + ".vtt")
				);
				indexedStreams[captionTracks.indexOf(asrOnlyCap)] = asrStream;
				console.log("updating captions for " + v_id + " with single ASR");
				const patched = await patchCaptions(
					captionTracks,
					indexedStreams,
					captionsDir,
					fullUrlForClient,
					v_id,
					infoPath,
					true
				);
				if (patched.length == 1) {
					// remove old (bad) ASR caption
					const oldCapPath = path.join(
						captionsDir,
						asrOnlyCap.language_code + ".vtt"
					);
					if (existsSync(oldCapPath)) {
						unlinkSync(oldCapPath);
					}
				}
			} else {
				console.log(
					"skipping, " + v_id + " due to no ASR pair and no single ASR"
				);
			}
			continue;
		}

		if (asrPair.length != 2) {
			console.log("skipping, " + v_id + " due to non-2len-ASR pair.");
			continue;
		}

		let videoInfo: VideoInfo;
		try {
			videoInfo = await getYouTube()!.getInfo(v_id, { client: clientName });
		} catch (error) {
			console.log("skipping, " + v_id + " due to getVideoInfo error.");
			await new Promise((r) => setTimeout(r, 21000));
			continue;
		}

		const newCaptionTracks = videoInfo.captions?.caption_tracks;
		const newCaptionStreams = await getCaptionStreams(newCaptionTracks);

		if (newCaptionStreams.length == 0) {
			console.log("skipping, " + v_id + " due to no new caption streams.");
			continue;
		}

		console.log("updating complete captions for " + v_id);
		const updatedCaptionTracks = await patchCaptions(
			newCaptionTracks,
			newCaptionStreams,
			captionsDir,
			fullUrlForClient,
			v_id,
			infoPath,
			true
		);

		// if (updatedCaptionTracks.length == newCaptionStreams.length) {
		// 	console.log("successfully updated captions for " + v_id);
		// }

		await new Promise((r) => setTimeout(r, 15000));
	}

	// update all the info.json files to be version 2
	for (const v_id of Object.keys(archive)) {
		const archiveEntryDir = path.join(archiveDir, v_id);
		const infoPath = path.join(archiveEntryDir, "info.json");
		const info = newArchiveFromJSON(
			readFileSync(infoPath, "utf-8")
		) as ArchiveInfoV1;

		if (info.version == 1) {
			info.version = 2;
			writeFileSync(infoPath, JSON.stringify(info, null, 2));
		}
	}

	console.log("done updating archive to version 2");
	res.send("done");
});

app.get(/^\/mpd\/([\w-]+)\.mpd$/, async (req, res) => {
	const v_id = req.params[0];
	const target = req.query.target as string;
	console.log("mpd request for " + v_id);

	// TODO heuristic, for now it seems to generally be 6 hours
	if (
		cache[v_id] &&
		cache[v_id].mpd_manifest &&
		Date.now() - cache[v_id].cached_on_ms < 1000 * 60 * 60 * 6 &&
		cache[v_id].browser_target == target
	) {
		console.log("serving from cache");
		res.status(200).send(cache[v_id].mpd_manifest);
		return;
	}

	if (!useOnline) {
		res.status(503).send("Error: offline only mode");
		return;
	}


	let videoInfo: VideoInfo;
	try {
		// videoInfo = await getYouTube()!.getBasicInfo(v_id, { client: clientName });
		videoInfo = await getLocalVideoInfo(v_id);
	} catch (error) {
		console.log("error: " + error);
		console.log("failed to get basic info");
		res.status(503).send("Error: " + error);
		return;
	}
	let manifest: string;

	// TODO better match the format to the browser
	const preferredLang = "ja";

	function filterAudioAdaptationSets(manifest: string): string {
		let dom = new JSDOM();
		global.DOMParser = dom.window.DOMParser;
		global.XMLSerializer = dom.window.XMLSerializer;
		const parser = new DOMParser();
		const xmlDoc = parser.parseFromString(manifest, "text/xml");
		const audioSets = xmlDoc.querySelectorAll(
			'AdaptationSet[contentType="audio"]'
		);

		// First try to find preferred language track
		let preferredAudio = Array.from(audioSets).find((set) => {
			const lang = set.getAttribute("lang");
			return lang === preferredLang;
		});

		console.log(`Available audio tracks:`);
		audioSets.forEach((set) => {
			const lang = set.getAttribute("lang");
			const label = set.querySelector("Label")?.textContent;
			console.log(`- lang=${lang}, label=${label}`);
		});
		console.log(
			`Preferred audio track: lang=${preferredAudio?.getAttribute(
				"lang"
			)}, label=${preferredAudio?.querySelector("Label")?.textContent}`
		);

		// If preferred language not found, fallback to original/master audio track
		if (!preferredAudio) {
			preferredAudio = Array.from(audioSets).find((set) => {
				const label = set.querySelector("Label")?.textContent;
				const isMaster =
					label?.includes("original") ||
					label?.includes("Original") ||
					audioSets.length === 1;
				if (isMaster) {
					console.log(
						`Using master audio track: lang=${set.getAttribute(
							"lang"
						)}, label=${label}`
					);
				}
				return isMaster;
			});
		}

		// Keep only the selected audio track
		audioSets.forEach((set) => {
			if (set !== preferredAudio) {
				const lang = set.getAttribute("lang");
				const label = set.querySelector("Label")?.textContent;
				console.log(`Filtering out audio track: lang=${lang}, label=${label}`);
				set.parentNode?.removeChild(set);
			}
		});

		return new XMLSerializer().serializeToString(xmlDoc);
	}

	try {
		if (target == "IE") {
			console.log("playable: " + JSON.stringify(videoInfo.playability_status));
			console.log("vid data: " + JSON.stringify(videoInfo.basic_info));

			const manifestOptions = {
				url_transformer: (url: URL) =>
					new URL(`http://${fullUrlForClient}/proxy/${url}`),
				format_filter: (format: Format) => {
					const isAudioOnly = format.has_audio && !format.has_video;
					console.log(
						"format: " +
							format.itag +
							" audio: " +
							format.has_audio +
							" video: " +
							format.has_video +
							" mime: " +
							format.mime_type,
						" isAudioOnly: " + isAudioOnly + " lang: " + format.language
					);

					return !formatsToUse.find((fmt) => format.mime_type.includes(fmt));
				},
			};

			manifest = await videoInfo.toDash(manifestOptions);
			manifest = filterAudioAdaptationSets(manifest);
		} else {
			const manifestOptions = {
				url_transformer: (url: URL) =>
					new URL(`http://${fullUrlForClient}/proxy/${url}`),
			};
			manifest = await videoInfo.toDash(manifestOptions);
		}
		// 		if (target == "IE") {

		// 	console.log("playable: " + JSON.stringify(videoInfo.playability_status))
		// 	console.log("vid data: " + JSON.stringify(videoInfo.basic_info))

		// 	const manifestOptions = {
		// 	url_transformer: (url: URL) => new URL(`http://${fullUrl}/proxy/${url}`),
		// 	format_filter: (format: Format) => {
		// 			const isAudioOnly = format.has_audio && !format.has_video;
		// 			console.log("format: " + format.itag + " audio: " + format.has_audio + " video: " + format.has_video
		// 			+ " mime: " + format.mime_type, " isAudioOnly: " + isAudioOnly + " lang: " + format.language);

		// 			return !formatsToUse.find(fmt => format.mime_type.includes(fmt))
		// 		}
		// 	}

		// 	manifest = await videoInfo.toDash(manifestOptions);
		// 	manifest = filterAudioAdaptationSets(manifest);
		// } else {
		// 	const manifestOptions = {
		// 	url_transformer: (url: URL) => new URL(`http://${fullUrl}/proxy/${url}`),
		// 	}
		// 	manifest = await videoInfo.toDash(manifestOptions);
		// }
		// if (target == "IE") {

		// 	console.log("playable: " + JSON.stringify(videoInfo.playability_status))
		// 	console.log("vid data: " + JSON.stringify(videoInfo.basic_info))

		// 	manifest = await videoInfo.toDash(
		// 		(url: URL) => new URL(`http://${fullUrl}/proxy/${url}`),
		// 		(format: Format) => {
		// 			const isAudioOnly = format.has_audio && !format.has_video;
		// 			console.log("format: " + format.itag + " audio: " + format.has_audio + " video: " + format.has_video
		// 			+ " mime: " + format.mime_type, " isAudioOnly: " + isAudioOnly + " lang: " + format.language);

		// 			return !formatsToUse.find(fmt => format.mime_type.includes(fmt))
		// 		}

		// 	);
		// 	manifest = filterAudioAdaptationSets(manifest);
		// } else {
		// 	manifest = await videoInfo.toDash(
		// 	(url: URL) => new URL(`http://${fullUrl}/proxy/${url}`));

		// 	// const manifestOptions = {
		// 	// url_transformer: (url: URL) => new URL(`http://${fullUrl}/proxy/${url}`),
		// 	// }
		// 	// manifest = await videoInfo.toDash(manifestOptions);
		// }

		try {
			for (const caption of videoInfo?.captions?.caption_tracks ?? []) {
				const captionUrl = new URL(caption.base_url, "https://www.youtube.com");
				caption.base_url = `http://${fullUrlForClient}/fixvtt/${captionUrl}`;
			}
			// TypeError possible
		} catch (error) {
			console.log("failed to get captions");
			if (error instanceof TypeError) {
				console.log("TypeError, very likely captions disabled.");
			} else {
				console.log("error: " + error);
			}
		}

		if (!cache[v_id]) {
			try {
				videoInfo.captions = videoInfo.captions;
				cache[v_id] = latestCacheConstructor(videoInfo, manifest, target, yti_version);
				console.log("constructor ran");
				// TODO update to use video_sets instead of file_formats
				cache[v_id].file_formats = await getSupportedFormats(videoInfo);
			} catch (error) {
				console.log('Error: ' + error);
				console.log('failed to cache full video info');
			}
		}

		res.send(manifest);
	} catch (error) {
		console.log("error: " + error);
		console.log("failed to get manifest");
		res.status(503).send("Error: " + error);
		if (videoInfo.basic_info.is_private) {
			console.log("Private video! Please remove!");
			return;
		} else if (
			videoInfo.playability_status &&
			videoInfo.playability_status.status == "UNPLAYABLE"
		) {
			console.log("Unplayable video likely due to banning embeds");
			return;
		}
		return;
	}

	// // wait 2000ms before caching the full video info
	// if (!cache[v_id]) {
	// 	new Promise(r => setTimeout(r, 2000)).then(async () => {
	// 		// try {
	// 		// 	cache[v_id] = latestCacheConstructor(videoInfo, manifest, target, yti_version);
	// 		// 	// videoInfo.captions = videoInfo.captions;
	// 		// 	cache[v_id].file_formats = await getSupportedFormats(videoInfo);
	// 		// 	console.log("caching video info: " + JSON.stringify(cache[v_id]));
	// 		// } catch (error) {
	// 		// 	console.log('Error: ' + error);
	// 		// 	console.log('failed to cache video info');
	// 		// }
	// 		try {
	// 			const videoInfoFull = await getYouTube()!.getBasicInfo(v_id, { client: clientName });
	// 			console.log("got captions")
	// 			videoInfoFull.captions = videoInfo.captions;

	// 			// const mockVideoInfo: VideoInfo = {
	// 			// 	...videoInfoFull,
	// 			// }

	// 			cache[v_id] = latestCacheConstructor(videoInfoFull, manifest, target, yti_version);
	// 			console.log("constructor ran");
	// 			// TODO update to use video_sets instead of file_formats
	// 			cache[v_id].file_formats = await getSupportedFormats(videoInfoFull);
	// 		} catch (error) {
	// 			console.log('Error: ' + error);
	// 			console.log('failed to cache full video info');
	// 		}
	// 	})
	// }
});

app.get("/captions/:v_id", async (req, res) => {
	const v_id = req.params.v_id;
	let captionTracks: PlayerCaptionsTracklist | undefined = JSON.parse(
		JSON.stringify((await getCacheWait(v_id))?.captions)
	);

	if (captionTracks) {
		for (const ct of captionTracks?.caption_tracks || []) {
			for (let i = 0; i < 5; i++) {
				ct.base_url = ct.base_url.replace(defaultLocalUrl, fullUrlForClient);
			}
			console.log("serving caption with url as " + ct.base_url);
		}

		console.log("serving caption from cache or archive");
		res.json(captionTracks.caption_tracks);
		return;
	}
	res.json({});
});

app.get(/^\/fixvtt\/(.*\..*$)/, async (req, res) => {
	const url = new URL(req.url.replace("/fixvtt/", ""));
	console.log("fixvtt request for " + url.href);
	try {
		const vtt = await fetchTransformedVTT(url);
		if (vtt == null) {
			res
				.status(503)
				.send("Error: the VTT could not be found on the service by URL.");
			return;
		}
		res.set("Content-Type", "text/vtt");
		res.send(vtt);
	} catch (error) {
		console.log("error: " + error);
		res.status(503).send("Error: " + error);
	}
});

app.get("/formats/:v_id", async (req, res) => {
	const v_id = req.params.v_id;
	const formats = (await getCacheWait(v_id))?.file_formats;
	if (formats) {
		res.json(formats);
	} else {
		res.json({});
	}
});

app.get("/youtubeformats/:v_id", async (req, res) => {
	const v_id = req.params.v_id;

	// call chooseFormat with a try for all possible permutations on // audio, video or video+audio, quality: 'best',
	// best, bestefficiency, 144p, 240p, 480p, 720p and so on.
	//format: 'mp4' // media container format

	let videoInfoFull: VideoInfo;
	try {
		// FIXME: do not load info multiple times
		videoInfoFull = await getYouTube()!.getInfo(v_id, { client: clientName });
	} catch (error) {
		console.log("error: " + error);
		res.status(503).send("Error: " + error);
		return;
	}

	const streamingData = videoInfoFull.getStreamingInfo();

	// const types = ['audio', 'video', 'video+audio'] as FormatOptions['type'][]
	// const qualities = [/* 'best', 'bestefficiency', */ '144p', '240p', '360', '480p', '720p'];
	// const formats = ['mp4'];

	// const formatOptions = [] as FormatOptions[];
	// for (const type of types) {
	// 	for (const quality of qualities) {
	// 		for (const format of formats) {
	// 			formatOptions.push({ type, quality, format });
	// 		}
	// 	}
	// }

	// const fileFormats = {} as { [key: string]: {
	// 	fmt: Format, type: FormatOptions['type'], quality: FormatOptions['quality'], has_av: boolean}
	// };

	// let i = 0;
	// for (const formatOpt of formatOptions) {
	// 	try {
	// 		const format = await videoInfoFull.chooseFormat(formatOpt);
	// 		fileFormats[format.itag + '.' + archiveContainer + "-" + (++i)] = { fmt: format, type: formatOpt.type, quality: formatOpt.quality, has_av: format.has_audio && format.has_video};
	// 	} catch (error) {
	// 		console.log('failed to get format: ' + error);
	// 		continue;
	// 	}
	// }

	// const sorted = Object.keys(fileFormats).sort((a, b) => fileFormats[a].fmt.bitrate - fileFormats[b].fmt.bitrate);

	// const sortedFormats = {} as { [key: string]:
	// 	{fmt: Format, type: FormatOptions['type'], quality: FormatOptions['quality'], has_av: boolean}
	// };

	// for (const key of sorted) {
	// 	sortedFormats[key] = fileFormats[key];
	// }

	// res.json({ formats: sortedFormats, streamingData: streams });
	const { avFormats, aFormats, vFormats } = await getSupportedFormats2(
		videoInfoFull
	);

	// const sortedAvFormatList = Object.entries(avFormats).sort((a, b) => a[1].bitrate - b[1].bitrate);
	// const sortedAFormatList = Object.entries(aFormats).sort((a, b) => a[1].bitrate - b[1].bitrate);
	// const sortedVFormatList = Object.entries(vFormats).sort((a, b) => a[1].bitrate - b[1].bitrate);

	return res.json({ avFormats, aFormats, vFormats, streamingData });
});

function formatCaptionFileName(captionTrack: CaptionTrack) {
	let capFilename = captionTrack.vss_id + ".vtt";
	if (capFilename.startsWith(".")) {
		//remove leading dot to allow reading from static file server
		capFilename = capFilename.substring(1);
	}
	return capFilename;
}

/**
 * Get the caption streams from the caption tracks
 * @requires captionTracks to be from videoInfo.captions.caption_tracks
 */
async function getCaptionStreams(
	captionTracks: PlayerCaptionsTracklist["caption_tracks"]
) {
	const captionStreams = [] as Response["body"][];
	for (const captionTrack of captionTracks ?? []) {
		// URL request
		const captionUrl = new URL(
			captionTrack.base_url,
			"https://www.youtube.com"
		);
		// const captionUrl = new URL(captionTrack.base_url, "http://" + fullUrl + "/proxy/https://www.youtube.com");
		captionUrl.searchParams.set("fmt", "vtt");
		captionUrl.searchParams.set(
			"c",
			youtube?.session.context.client.clientName!
		);
		captionUrl.searchParams.set(
			"cver",
			youtube?.session.context.client.clientVersion!
		);
		captionUrl.searchParams.set("potc", "1");
		// captionUrl.searchParams.set("pot", poToken!);

		captionUrl.searchParams.delete("xosf");
		let captionResp = await fetchWait(captionUrl, true, 500, 50);
		if (captionResp.status != 200) {
			return [];
		}
		let captionBody = captionResp.body;
		// @ts-expect-error pf
		captionStreams.push(captionBody);
	}
	return captionStreams;
}

/**
 * Patch fs archive captions with the correct URL and save to disk. Updates both the captionTracks base url and rets updated.
 * Patches info.json if it exists
 * @param captionTracks
 * @param captionStreams
 * @param captionsDir
 * @param fullUrl
 * @param v_id
 * @param renameExisting
 * @returns the caption tracks that were updated
 */
async function patchCaptions(
	captionTracks: PlayerCaptionsTracklist["caption_tracks"],
	captionStreams: (Response["body"] | null)[],
	captionsDir: string,
	fullUrl: string,
	v_id: string,
	infoJsonPath: string | undefined,
	renameExisting: boolean
) {
	if (!captionTracks || !captionStreams) {
		console.warn("no caption tracks or streams found in patchCaptions");
		return [];
	}

	let info: ArchiveInfo | undefined;
	if (infoJsonPath) {
		info = newArchiveFromJSON(readFileSync(infoJsonPath, "utf-8"));
	}
	const updatedCaptionTracks = [];

	for (const captionTrack of captionTracks) {
		const captionStream = captionStreams.shift();
		if (captionStream && captionStream != null) {
			const captionFileName = formatCaptionFileName(captionTrack);
			const captionFilePath = path.join(captionsDir, captionFileName);

			if (renameExisting && existsSync(captionFilePath)) {
				const captionFileDir = path.dirname(captionFilePath);
				const captionFileBase = path.basename(
					captionFilePath,
					path.extname(captionFilePath)
				);
				// TODO don't hardcode the version number
				const newCaptionFilePath = path.join(
					captionFileDir,
					`${captionFileBase}_v1${path.extname(captionFilePath)}`
				);
				renameSync(captionFilePath, newCaptionFilePath);
			}

			const captionFile = createWriteStream(captionFilePath);

			await new Promise<void>((resolve, reject) => {
				captionStream.pipe(captionFile);
				captionStream.on("end", () => {
					resolve();
				});
				captionStream.on("error", (error) => {
					reject(error);
				});
			});

			captionFile.close();

			const preFix = "http://" + fullUrl + "/fixvtt/";
			const fsUrl = `http://${fullUrl}/archive/${v_id}/captions/${captionFileName}`;
			captionTrack.base_url = preFix + fsUrl;
			updatedCaptionTracks.push(captionTrack);
		}
	}

	if (updatedCaptionTracks.length != 0 && infoJsonPath) {
		if (!info || !info.captions || !info.captions.caption_tracks) {
			console.warn("info.json or its captions not found at path");
			return [];
		}
		// info.captions.caption_tracks = updatedCaptionTracks;
		if (existsSync(infoJsonPath)) {
			const infoFileDir = path.dirname(infoJsonPath);
			const infoFileBase = path.basename(
				infoJsonPath,
				path.extname(infoJsonPath)
			);
			let i = 0;
			let newInfoFilePath;
			do {
				newInfoFilePath = path.join(
					infoFileDir,
					`${infoFileBase}_old${i}${path.extname(infoJsonPath)}`
				);
				i++;
			} while (existsSync(newInfoFilePath));
			renameSync(infoJsonPath, newInfoFilePath);
		}
		// else if(updatedCaptionTracks.length != captionTracks.length){
		// 	throw new Error("captionsTrack didn't match expected length")
		// }
		for (const updatedCaptionTrack of updatedCaptionTracks) {
			const captionIndex = info.captions.caption_tracks.findIndex(
				(track) => track.vss_id == updatedCaptionTrack.vss_id
			);
			if (captionIndex != -1) {
				info.captions.caption_tracks[captionIndex] = updatedCaptionTrack;
			}
		}

		writeFileSync(infoJsonPath, JSON.stringify(info, null, 2));
	}

	return updatedCaptionTracks;
}

app.get("/archive/:v_id", async (req, res) => {
	const v_id = req.params.v_id;
	console.log("archive request for " + v_id);

	if (archive[v_id]?.file_formats) {
		const vid_files = Object.keys(archive[v_id].file_formats);
		const vid_formats = vid_files.map((file) => {
			return {
				itag: file,
				url: `http://${fullUrlForClient}/archive/${v_id}/${file}`,
			};
		});
		// vid_formats.sort((a, b) => Number.parseInt(a.itag.split('.')[0]) - b.itag.split('.')[0]);
		res.status(200).send(vid_formats[0]);
	} else {
		let videoInfoFull: VideoInfo;

		await new Promise((resolve) => setTimeout(resolve, 5000));

		try {
			videoInfoFull = await getYouTube()!.getBasicInfo(v_id, {
				client: clientName,
			});
		} catch (error) {
			console.log("error getting vid info before download: " + error);
			res.status(503).send("Error: " + error);
			return;
		}
		const best_format = {
			type: req.query.type ? req.query.type : "video+audio", // audio, video or video+audio
			quality: req.query.quality ? req.query.quality : "best", // best, bestefficiency, 144p, 240p, 480p, 720p and so on.
			format: req.query.format ? req.query.format : "mp4", // media container format
		} as FormatOptions;
		// const best_format = { type: "video+audio", itag: 18 } as FormatOptions;

		// wait 5000 ms
		await new Promise((resolve) => setTimeout(resolve, 5000));

		console.log("choosing format: " + JSON.stringify(best_format));
		// assume chooseFormat is used internally deterministically
		let format = await videoInfoFull.chooseFormat(best_format);

		await new Promise((resolve) => setTimeout(resolve, 5000));

		if (!(format.has_video && format.has_audio)) {
			console.log(
				"Error: format does not have video and audio, up/downgrading to best quality"
			);
			const best_format = {
				type: "video+audio", // audio, video or video+audio
				quality: "best", // best, bestefficiency, 144p, 240p, 480p, 720p and so on.
				format: "mp4", // media container format
			} as FormatOptions;
			format = await videoInfoFull.chooseFormat(best_format);
		}

		const fileNameItag = format.itag + "." + archiveContainer; // for now
		let stream;
		try {
			console.log(
				"downloading video, format " + format.quality_label + " " + format.itag
			);
			stream = await videoInfoFull.download(best_format);
		} catch (error) {
			console.log("error during video download: ");
			console.log(util.inspect(error, { depth: null, colors: true }));
			// throw error;
			// console.log('error: ' + error);
			// res.status(503).send('Error: ' + error);
			return;
		}
		const fileFormats: { [key: string]: Format } = {};
		fileFormats[format.itag + "." + archiveContainer] = format;

		const archiveEntryDir = path.join(archiveDir, v_id);
		if (!existsSync(archiveEntryDir)) {
			try {
				mkdirSync(archiveEntryDir);
			} catch (error) {
				console.log("archive dir write error: " + error);
				res.status(507).send("Error: " + error);
				return;
			}
		}

		try {
			const file = createWriteStream(path.join(archiveEntryDir, fileNameItag));
			for await (const chunk of Utils.streamToIterable(stream)) {
				file.write(chunk);
			}
			file.close();
		} catch (error) {
			console.log("file write stream error: " + error);
			res.status(507).send("Error: " + error);
			return;
		} finally {
			stream.cancel();
		}

		let newInfo: ArchiveInfoLatest;
		try {
			newInfo = latestArchiveConstructor(videoInfoFull, yti_version);
		} catch (error) {
			console.log("archive constr error: " + error);
			res.status(503).send("Error: " + error);
			return;
		}
		newInfo.file_formats = fileFormats;

		if (newInfo.captions) {
			const captionsDir = path.join(archiveEntryDir, "captions");
			if (!existsSync(captionsDir)) {
				try {
					mkdirSync(captionsDir);
				} catch (error) {
					console.log("mkdir error: " + error);
					res.status(507).send("Error: " + error);
					return;
				}
			}

			// fetch via base_url
			let captionTracks = [] as PlayerCaptionsTracklist["caption_tracks"];
			try {
				captionTracks = newInfo.captions?.caption_tracks ?? [];
			} catch (error) {
				console.log("caption tracks access error: " + error);
				res.status(503).send("Error: " + error);
				return;
			}
			console.log("caption tracks: " + JSON.stringify(captionTracks));

			let captionStreams = [] as Response["body"][];
			try {
				captionStreams = await getCaptionStreams(captionTracks);
			} catch (error) {
				console.log("get captions stream error: " + error);
				res.status(503).send("Error: " + error);
				return;
			}
			if (captionStreams.length == 0) {
				console.log("error in caption stream (zero length result)");
				res.status(503).send("Error: " + "could not get all caption streams");
				return;
			}

			let updatedCaptionTracks =
				[] as PlayerCaptionsTracklist["caption_tracks"];
			try {
				updatedCaptionTracks = await patchCaptions(
					captionTracks,
					captionStreams,
					captionsDir,
					fullUrlForClient,
					v_id,
					undefined,
					true
				);
			} catch {
				console.log("error in updating caption tracks (patching)");
				res
					.status(503)
					.send(
						"Error: " +
							"error in patching caption files and updating caption tracks"
					);
				return;
			}
			// if this fails, the captions will not be updated
			if (updatedCaptionTracks.length != captionTracks.length) {
				console.log("error in updating caption tracks (updated NE length)");
				res
					.status(503)
					.send(
						"Error: " +
							"error in patching caption tracks, not all successfully patched"
					);
				return;
			}
		}

		try {
			writeFileSync(
				path.join(archiveEntryDir, "info.json"),
				JSON.stringify(newInfo, null, 2)
			);
		} catch (error) {
			console.log("error: " + error);
			res.status(507).send("Error: " + error);
			return;
		}
		archive[v_id] = newInfo;
		console.log("video archived");
		res.status(200).send("OK");
	}
});

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


let poToken: string | undefined;
async function connectInnertube(videoId?: string) {
	// const JSDOM = await loadJSDOM();

	// const dom = new JSDOM!();
	// Object.assign(globalThis, {
	// 	window: dom.window,
	// 	document: dom.window.document,
	// 	canvas: dom.window.HTMLCanvasElement,
	// });
	setupBotGuardGlobals();

	if (!videoId) {
		return await Innertube.create({
			retrieve_player: false,
			client_type: clientTypeName,
			// cache: new UniversalCache(true, cacheDir),
			// generate_session_locally: true,
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

		if (!existsSync(cacheDir)) {
			mkdirSync(cacheDir);
		} else {
			// clear cacheDir if it exists and data is older than 30 minutes
			const files = readdirSync(cacheDir);
			for (const file of files) {
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

		// TODO support symlink
		if (!existsSync(archiveDir)) {
			mkdirSync(archiveDir);
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
