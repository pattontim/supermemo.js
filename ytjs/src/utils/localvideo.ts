/*
 * This file uses code licensed under the license of the parent
 * 
 * URL: https://github.com/FreeTubeApp/FreeTube
 * 
 * Modifications: globalThis
 * 
 * This code is licensed under the parent. You can obtain a copy of the license here:
 * https://github.com/FreeTubeApp/FreeTube#license
 */
import Innertube, { ClientType, Player, UniversalCache } from "youtubei.js";
import { readFileSync } from "node:fs";
import { Response } from "node-fetch";
import { getPlayerPoToken, getMintedVisitor } from "./poToken";
import { getRuntimeUserAgent } from "./camoufoxRuntime";
import { censusLog } from "./bgCensus";
import { cacheDir } from "./constants";
import { Format } from "./yt-types";
import { defaultLocalUrl } from "../server";
import { Utils, Constants } from "youtubei.js";
import { SabrInputFormat } from "../sabr/sabr-stream";

export type FormatWithURL = Format & { freeTubeUrl: string; };

/**
 * Announce the sandbox's visitor identity as the one PO tokens are bound to.
 * The SABR URL is fetched separately, but the token's own mint/refresh
 * consistency is what the server checks (see getWatchPageSabrInputs).
 */
export async function getMintVisitor(): Promise<string | undefined> {
	return await getMintedVisitor();
}

/**
 * Mint a real PO token for a video via the shared Camoufox minter (see
 * poToken.ts / LocalDomPoTokenProvider). Binding is decided by YouTube's
 * homepage experiment flags: SESSION reuses one token, CONTENT mints per video.
 * Returns undefined if minting fails (caller then falls back to an empty or
 * cold-start token).
 *
 * Also returns the visitorData the token was bound to: the SABR StreamerContext
 * must agree with it, otherwise the server rejects the token (status 3).
 */
export async function mintContentPoToken(
	videoId: string,
): Promise<{ poToken: Buffer; visitorData?: string } | undefined> {
	try {
		const { poToken, visitorData } = await getPlayerPoToken(videoId);
		if (process.env.BG_CENSUS === "1") {
			censusLog({ poTokenMint: { videoId, visitorData, tokenBytes: poToken.length } });
		}
		return { poToken: base64ToBuffer(poToken), visitorData };
	} catch (e) {
		console.error("[sabr] PO token mint failed", e);
		return undefined;
	}
}

/**
 * Everything the SABR session needs, captured while we already have the player
 * response in hand (avoids a second getInfo round-trip). Keyed by videoId so
 * the SABR route can build a session without re-running getLocalVideoInfo.
 */
export interface SabrInputs {
	sabrUrl: string;
	ustreamerConfig: Buffer;
	formats: SabrInputFormat[];
	poToken: Buffer;
	clientName: number;
	clientVersion: string;
	osName: string;
	osVersion: string;
	acceptLanguage?: string;
	acceptRegion?: string;
	/** Extra HTTP headers captured from a real browser (cookies, UA, client hints). */
	headers?: Record<string, string>;
	/** The cpn the real player used (for byte-level replay experiments). */
	cpn?: string;
	/** Visitor identity the token was minted under. */
	visitorData?: string;
}

const sabrInputs = new Map<string, SabrInputs>();

/** Injection hook for browser-captured bundles (POST /sabr-inject/:id). */
export function setSabrInputs(videoId: string, inputs: SabrInputs): void {
	sabrInputs.set(videoId, inputs);
}

/**
 * Load a browser-captured bundle from disk (YTJS_SABR_INJECT_FILE=/path/bundle.json).
 * Shape matches the POST /sabr-inject/:id body. Returns undefined if unset/unreadable.
 */
export function loadInjectedSabrInputs(videoId: string): SabrInputs | undefined {
	const file = process.env.YTJS_SABR_INJECT_FILE;
	if (!file) return undefined;
	try {
		const raw = JSON.parse(readFileSync(file, "utf-8"));
		if (raw.videoId && raw.videoId !== videoId) return undefined;
		return sabrInputsFromJson(raw);
	} catch (e) {
		console.error(`[sabr] inject file ${file} unreadable`, e);
		return undefined;
	}
}

/** JSON -> SabrInputs (base64 fields decoded, formats normalized). */
export function sabrInputsFromJson(raw: any): SabrInputs {
	return {
		sabrUrl: String(raw.sabrUrl),
		ustreamerConfig: base64ToBuffer(raw.ustreamerConfig),
		poToken: raw.poToken ? base64ToBuffer(raw.poToken) : Buffer.alloc(0),
		formats: (raw.formats ?? []).map((f: any) => ({
			itag: Number(f.itag),
			xtags: f.xtags,
			mimeType: String(f.mimeType),
			lastModified: f.lastModified ? String(f.lastModified) : undefined,
			isAudio: !!f.isAudio,
			codecs: f.codecs,
			width: f.width,
			height: f.height,
			bandwidth: f.bandwidth,
			audioSampleRate: f.audioSampleRate,
			approxDurationMs: f.approxDurationMs,
		})),
		clientName: Number(raw.clientName ?? 1),
		clientVersion: String(raw.clientVersion ?? ""),
		osName: String(raw.osName ?? ""),
		osVersion: String(raw.osVersion ?? ""),
		acceptLanguage: raw.acceptLanguage,
		acceptRegion: raw.acceptRegion,
		headers: raw.headers,
		cpn: raw.cpn,
		visitorData: raw.visitorData,
	};
}

function base64ToBuffer(b64: string): Buffer {
	return Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Port of TubeReplacer's generateColdStartTokenWithContent
 * (challengesolver-potokens.m), itself a port of BgUtils's WebPoMinter cold
 * start. A locally-built, obfuscated packet that can stand in for a real PO
 * token for the first ~1-2 MB (BatsUtils StreamProtectionStatus docs: status 2).
 * Used to discriminate whether a JSDOM-minted BotGuard token is the problem.
 */
function generateColdStartToken(contentBinding: string, clientState = 1): Buffer {
	const content = Buffer.from(contentBinding, "utf-8");
	const timestamp = Math.floor(Date.now() / 1000);
	const keys = [Math.floor(Math.random() * 256), Math.floor(Math.random() * 256)];
	const header = Buffer.from([
		keys[0],
		keys[1],
		0,
		clientState,
		(timestamp >>> 24) & 0xff,
		(timestamp >>> 16) & 0xff,
		(timestamp >>> 8) & 0xff,
		timestamp & 0xff,
	]);
	const packet = Buffer.alloc(2 + header.length + content.length);
	packet[0] = 34;
	packet[1] = header.length + content.length;
	header.copy(packet, 2);
	content.copy(packet, 2 + header.length);
	const keyLength = 2;
	for (let i = keyLength + 2; i < packet.length; i++) {
		packet[i] ^= packet[2 + (i % keyLength)];
	}
	return packet;
}

/** Cached SABR inputs, or undefined if getLocalVideoInfo hasn't seen this video. */
export function getSabrInputs(videoId: string): SabrInputs | undefined {
	return sabrInputs.get(videoId);
}

/**
 * @param {Misc.Format[]} formats
 * @param {import('youtubei.js').Player} player
 */
export async function decipherFormats(
	formats: FormatWithURL[],
	player: Player | undefined) {
	for (const format of formats) {
		// toDash deciphers the format again, so if we overwrite the original URL,
		// it breaks because the n param would get deciphered twice and then be incorrect
		format.freeTubeUrl = await format.decipher(player);
	}
}
/**
 * Creates a lightweight Innertube instance, which is faster to create or
 * an instance that can decode the streaming URLs, which is slower to create
 * the lightweight one only needs a single web request to create the new session
 * the full one needs 3 (or 2 if the player is cached) web requests to create:
 * 1. the request for the session
 * 2. fetch a page that contains a link to the player
 * 3. if the player isn't cached, it is downloaded and transformed
 * @param {object} options
 * @param {boolean} options.withPlayer set to true to get an Innertube instance that can decode the streaming URLs
 * @param {string|undefined} options.location the geolocation to pass to YouTube get different content
 * @param {boolean} options.safetyMode whether to hide mature content
 * @param {import('youtubei.js').ClientType} options.clientType use an alterate client
 * @param {boolean} options.generateSessionLocally generate the session locally or let YouTube generate it (local is faster, remote is more accurate)
 * @returns the Innertube instance
 */

export async function createInnertube({
	withPlayer = false, location = undefined, safetyMode = false, clientType = undefined, generateSessionLocally = true,
} = {}) {
	let cache;
	if (withPlayer) {
		if (process.env.IS_ELECTRON) {
            // TODO implement our PlayerCache.
			//   cache = new PlayerCache()
			cache = new UniversalCache(true, cacheDir);
		} else {
			cache = new UniversalCache(true, cacheDir);
		}
	}

	return await Innertube.create({
		// This setting is enabled by default and results in YouTube.js reusing the same session across different Innertube instances.
		// That behavior is highly undesirable for FreeTube, as we want to create a new session every time to limit tracking.
		enable_session_cache: false,
		retrieve_innertube_config: !generateSessionLocally,
		// The sandbox's real UA, not Node's: a Firefox-internals browser claiming
		// a Chrome UA (or vice versa) is the exact mismatch the BotGuard VM probes
		// for.
		user_agent: getRuntimeUserAgent(),

		retrieve_player: !!withPlayer,
		location: location,
		enable_safety_mode: !!safetyMode,
		client_type: clientType,
		// player_id: "9f4cc5e4",
		// player_id: "4c5cf06a",

		// use browser fetch
		// @ts-expect-error lol
		fetch: !withPlayer
			? (input, init) => Utils.debugFetch(input as any, init as any)
			: async (input: any, init: any) => {
				// limit to 55 char
				console.log("Making request to", typeof input === 'string' ? input.slice(0, 100) : input.url);
				if (input.url?.startsWith("https://www.youtube.com/youtubei/v1/player")
					&& init?.headers?.get("X-Youtube-Client-Name") === "2"
				) {
					const response = await fetch(input, init);

					const responseText = await response.text();

					const json = JSON.parse(responseText);

					// if (Array.isArray(json.adSlots)) {
					// 	let waitSeconds = 0;

					// 	for (const adSlot of json.adSlots) {
					// 		if (adSlot.adSlotRenderer?.adSlotMetadata?.triggerEvent ===
					// 			"SLOT_TRIGGER_EVENT_BEFORE_CONTENT") {
					// 			const playerVars = adSlot.adSlotRenderer.fulfillmentContent?.fulfilledLayout
					// 				?.playerBytesAdLayoutRenderer?.renderingContent
					// 				?.instreamVideoAdRenderer?.playerVars;

					// 			if (playerVars) {
					// 				const match = playerVars.match(/length_seconds=([\d.]+)/);

					// 				if (match) {
					// 					waitSeconds += parseFloat(match[1]);
					// 				}
					// 			}
					// 		}
					// 	}

					// 	if (waitSeconds > 0) {
					// 		await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000)
					// 		);
					// 	}
					// }

					// Need to return a new response object, as you can only read the response body once.
					return new Response(responseText, {
						status: response.status,
						statusText: response.statusText,
						headers: response.headers,
					});
				// typeof input === 'string' ? input : input.url
				} 
				// else if(input.url?.startsWith("https://rr")){
				// 	console.log("Bypassing rr request ", input.url)
				// 	input.url = `http://${defaultLocalUrl}/proxy/${input.url}`
				// } else if(typeof input === 'string' && input.startsWith("https://rr")){
				// 	console.log("Bypassing rr request ", input)
				// 	input = `http://${defaultLocalUrl}/proxy/${input}`
				// }

				return fetch(input, init);
			},
		cache,
		generate_session_locally: !!generateSessionLocally,
	});
}
export async function getLocalVideoInfo(id: string) {
	console.time("createInnertube withPlayer = true locally = false")
	const webInnertube = await createInnertube({
		withPlayer: true,
		generateSessionLocally: false,
	});
	console.timeEnd("createInnertube withPlayer = true locally = false")

	// based on the videoId
	let contentPoToken: string;

	//   if (process.env.IS_ELECTRON) {
	try {
		console.time("content bound poToken")
		const minted = await getPlayerPoToken(id);
		contentPoToken = minted.poToken;
		console.timeEnd("content bound poToken")
		console.log("PoToken is valid ", contentPoToken != undefined);

		webInnertube.session!.player!.po_token = contentPoToken;
	} catch (error) {
		console.error("Local API, poToken generation failed", error);
		throw error;
	}
	//   }
	let clientName = webInnertube.session.context.client.clientName;

	console.time("webInnertube.getInfo")
	const info = await webInnertube.getInfo(id, { po_token: contentPoToken! });
	console.timeEnd("webInnertube.getInfo")
	console.log("Got info for video ", id);

	// #region temporary workaround for SABR-only responses
	// MWEB doesn't have an audio track selector so it picks the audio track on
	// the server based on the request language.
	const originalAudioTrackFormat = info.streaming_data?.adaptive_formats.find(
		(format) => {
			return format.has_audio && format.is_original && format.language;
		}
	);

	// Tracks which player response the current `info.streaming_data` actually
	// came from, so the SABR ustreamer config stays consistent with the
	// server_abr_streaming_url (mismatched config => SABR_ERROR malformed_config).
	let activePlayerConfig = info.player_config;

	if (originalAudioTrackFormat) {
		// @ts-expect-error not an issue
		webInnertube.session!.context!.client!.hl =
			originalAudioTrackFormat.language;
	}

	// EXPERIMENT: YTJS_SABR_WEB=1 keeps the WEB session/streaming_data/config
	// (FreeTube's exact proven arrangement) instead of replacing it with MWEB.
	// The WEB /next parse crash doesn't matter here: getInfo/getBasicInfo go via
	// the watch endpoint, so /next parsing isn't on this path.
	if (process.env.YTJS_SABR_WEB !== "1") {
		console.time("webInnertube.getBasicInfo")
		const mwebInfo = await webInnertube.getBasicInfo(id, {
			client: "MWEB",
			po_token: contentPoToken!,
		});
		console.timeEnd("webInnertube.getBasicInfo")
		console.log("Got MWEB info for video ", id);

		if (mwebInfo.playability_status!.status === "OK" && mwebInfo.streaming_data) {
			console.log("MWEB playability OK, using its streaming data for video ", id);
			info.playability_status = mwebInfo.playability_status;
			info.streaming_data = mwebInfo.streaming_data;
			activePlayerConfig = mwebInfo.player_config ?? activePlayerConfig;
			console.log(
				`[sabr] player_config presence: web=${!!info.player_config} mweb=${!!mwebInfo.player_config}` +
				` active=${activePlayerConfig === mwebInfo.player_config ? "mweb" : "web"}`
			);

			clientName = "MWEB";
		}
	} else {
		console.log("[sabr] YTJS_SABR_WEB=1 — keeping WEB streaming data/config");
	}

	// #endregion temporary workaround for SABR-only responses
	let hasTrailer = info.has_trailer;

	console.time("info.getTrailerInfo")
	let trailerIsAgeRestricted = info.getTrailerInfo() === null;
	console.timeEnd("info.getTrailerInfo")

	if (((info.playability_status!.status === "UNPLAYABLE" ||
		info.playability_status!.status === "LOGIN_REQUIRED") &&
		info.playability_status!.reason === "Sign in to confirm your age") ||
		(hasTrailer && trailerIsAgeRestricted)) {
		console.log("Bypassing age restriction for video ", id);
		const webEmbeddedInnertube = await createInnertube({
			// @ts-expect-error w
			clientType: ClientType.WEB_EMBEDDED,
		});
		webEmbeddedInnertube.session.context.client.visitorData =
			webInnertube.session.context.client.visitorData;

		const videoId = hasTrailer && trailerIsAgeRestricted
			// @ts-expect-error weird
			? info.playability_status!.error_screen!.video_id
			: id;

		// getBasicInfo needs the signature timestamp (sts) from inside the player
		webEmbeddedInnertube.session.player = webInnertube.session.player;

		// console.time("webEmbeddedInnertube.getBasicInfo")
		const bypassedInfo = await webEmbeddedInnertube.getBasicInfo(videoId, {
			client: "WEB_EMBEDDED",
			po_token: contentPoToken!,
		});
		// console.timeEnd("webEmbeddedInnertube.getBasicInfo")


		if (bypassedInfo.playability_status!.status === "OK" &&
			bypassedInfo.streaming_data) {
			info.playability_status = bypassedInfo.playability_status;
			info.streaming_data = bypassedInfo.streaming_data;
			info.basic_info.start_timestamp = bypassedInfo.basic_info.start_timestamp;
			info.basic_info.duration = bypassedInfo.basic_info.duration;
			info.captions = bypassedInfo.captions;
			info.storyboards = bypassedInfo.storyboards;

			hasTrailer = false;
			trailerIsAgeRestricted = false;

			clientName = webEmbeddedInnertube.session.context.client.clientName;
		}
	}

	if ((info.playability_status!.status === "UNPLAYABLE" &&
		(!hasTrailer || trailerIsAgeRestricted)) ||
		info.playability_status!.status === "LOGIN_REQUIRED") {
		console.log("Video is unplayable even after trying all restriction bypass, returning info as-is");
		return info;
	}

	if (hasTrailer && info.playability_status!.status !== "OK") {
		console.log("Getting trailer info for video");
		const trailerInfo = info.getTrailerInfo();

		// don't override the timestamp of when the video will premiere for upcoming videos
		if (info.playability_status!.status !== "LIVE_STREAM_OFFLINE") {
			info.basic_info.start_timestamp = trailerInfo!.basic_info.start_timestamp;
		}

		info.playability_status = trailerInfo!.playability_status;
		info.streaming_data = trailerInfo!.streaming_data;
		info.basic_info.duration = trailerInfo!.basic_info.duration;
		info.captions = trailerInfo!.captions;
		info.storyboards = trailerInfo!.storyboards;
	}

	if (info.streaming_data) {
		console.log("streaming data found, deciphering urls for video");
		console.time("decipherFormats")
		await decipherFormats(
			info.streaming_data.formats as FormatWithURL[],
			webInnertube.session.player
		);
		console.timeEnd("decipherFormats")

		const firstFormat = info.streaming_data.adaptive_formats[0];

		if (firstFormat.url || firstFormat.signature_cipher || firstFormat.cipher) {
			console.time("decipherFormats adaptive_formats")
			await decipherFormats(
				info.streaming_data.adaptive_formats as FormatWithURL[],
				webInnertube.session.player
			);
			console.timeEnd("decipherFormats adaptive_formats")
		}

		if (info.streaming_data.server_abr_streaming_url) {
			info.streaming_data.server_abr_streaming_url =
				await webInnertube.session.player!.decipher(
					info.streaming_data.server_abr_streaming_url
				);

			// Capture the SABR session inputs while the player response is here.
			// Use the config from whichever response supplied streaming_data
			// (MWEB), so the ustreamer config matches server_abr_streaming_url.
			const ustreamerConfig =
				activePlayerConfig?.media_common_config
					?.media_ustreamer_request_config?.video_playback_ustreamer_config;
			const numericClientId = Number(
				Constants.CLIENT_NAME_IDS[
					clientName as keyof typeof Constants.CLIENT_NAME_IDS
				] ?? 0
			);

			if (ustreamerConfig && contentPoToken) {
				const formats: SabrInputFormat[] = info.streaming_data.adaptive_formats
					.filter((f) => {
						const mt: string = f.mime_type ?? "";
						// match TubeReplacer's filter: skip VP9 / AV1 / Opus
						return !mt.includes("vp9") && !mt.includes("av01") && !mt.includes("opus");
					})
					.map((f) => ({
						itag: f.itag,
						xtags: f.xtags,
						mimeType: f.mime_type,
						// FormatId.last_modified is a uint64 of seconds since epoch
						lastModified: f.last_modified
							? String(Math.floor(new Date(f.last_modified).getTime() / 1000))
							: "0",
						isAudio: !!(f.has_audio && !f.has_video),
					}));

				// TubeReplacer's `webMobileClient` tuple is client_name=2 with
				// osName=iOS/osVersion=18 (the Android/11 variant is commented out
				// upstream). The client version is MWEB's exact string.
				const isMweb = numericClientId === 2;
				const poTokenBuffer =
					process.env.YTJS_SABR_COLDSTART === "1"
						? generateColdStartToken(id)
						: base64ToBuffer(contentPoToken);

				sabrInputs.set(id, {
					sabrUrl: info.streaming_data.server_abr_streaming_url,
					ustreamerConfig: base64ToBuffer(ustreamerConfig),
					poToken: poTokenBuffer,
					formats,
					clientName: numericClientId,
					clientVersion: isMweb
						? Constants.CLIENTS.MWEB.VERSION
						: Constants.CLIENTS.WEB.VERSION,
					osName: isMweb ? "iOS" : "",
					osVersion: isMweb ? "18" : "",
					acceptLanguage: webInnertube.session.context.client.hl ?? "en",
					acceptRegion: webInnertube.session.context.client.gl ?? "US",
				});
				console.log(
					`[sabr] captured inputs for ${id}: ${formats.length} formats, client=${numericClientId}` +
					` os=${isMweb ? "iOS/18" : ""} poToken=${poTokenBuffer.length}b` +
					` coldstart=${process.env.YTJS_SABR_COLDSTART === "1"}`
				);
			} else {
				console.log("[sabr] no ustreamer config or poToken in player response");
			}
		}

		if (info.streaming_data.dash_manifest_url) {
			console.log("Dash URL found");
			let url = info.streaming_data.dash_manifest_url;
			console.log("Original DASH URL: ", url);

			if (url.includes("?")) {
				url += `&pot=${encodeURIComponent(contentPoToken!)}&mpd_version=7`;
			} else {
				url += `${url.endsWith("/") ? "" : "/"}pot/${encodeURIComponent(
					contentPoToken!
				)}/mpd_version/7`;
			}
			console.log("Modified DASH URL: ", url);

			info.streaming_data.dash_manifest_url = url;
		}
	}

	if (info.captions?.caption_tracks) {
		for (const captionTrack of info.captions.caption_tracks) {
			const url = new URL(captionTrack.base_url);

			url.searchParams.set("potc", "1");
			url.searchParams.set("pot", contentPoToken!);
			// YouTube's `c` caption param expects a NUMERIC client id, not the name
			url.searchParams.set(
				"c",
				String(
					Constants.CLIENT_NAME_IDS[
						clientName as keyof typeof Constants.CLIENT_NAME_IDS
					] ?? clientName
				)
			);

			// Remove &xosf=1 as it adds `position:63% line:0%` to the subtitle lines
			// placing them in the top right corner
			url.searchParams.delete("xosf");

			// ytjs only supports vtt
			url.searchParams.set("fmt", "vtt");

			captionTrack.base_url = url.toString();
		}
	}

	return info;
}

/**
 * SABR inputs for a video, running getLocalVideoInfo first if they haven't been
 * captured yet. Mirrors the archive/stream routes' "fetch once, cache in memory"
 * pattern.
 */
export async function getOrCreateSabrInputs(videoId: string): Promise<SabrInputs | undefined> {
	const cached = sabrInputs.get(videoId);
	if (cached) return cached;
	// Browser-captured bundle takes precedence over the API path.
	const injected = loadInjectedSabrInputs(videoId);
	if (injected) {
		sabrInputs.set(videoId, injected);
		console.log(`[sabr] using injected bundle for ${videoId} (YTJS_SABR_INJECT_FILE)`);
		return injected;
	}
	await getLocalVideoInfo(videoId);
	return sabrInputs.get(videoId);
}

