/*
 * Niconico Douga (NND) streaming port.
 *
 * clean implementation from PipePipeExtractor:
 *   - NiconicoWatchDataCache.refreshAndGetWatchData  -> fetchWatchData()
 *   - NiconicoService.getStreamSourceHeaders/getStreamHeaders -> header builders
 *   - NiconicoStreamExtractor.onFetchPage (access-rights POST) -> requestHlsStream()
 *   - NiconicoStreamLinkHandlerFactory (id extraction) -> extractNndId()
 *
 * Only the VOD "domand" path is ported. The legacy DMC path
 * (NiconicoDMCPayloadBuilder), the websocket client, comments/danmaku,
 * search/user/playlist extractors are all intentionally dropped.
 *
 * Uses the global (undici) fetch that ships with Node >= 18; `response.body`
 * is a WHATWG ReadableStream, so callers must buffer or Readable.fromWeb().
 */

import { JSDOM } from "jsdom";

// ---------------------------------------------------------------------------
// ID handling
// ---------------------------------------------------------------------------

/**
 * NND ids are `sm|nm|so|ca` + digits (the prefix is meaningful: sm = general
 * upload, nm = Niconico Movie Maker, so = channel/official, ca = community).
 * Older videos use bare numeric ids.
 */
const NND_PREFIXED_ID_RE = /^(sm|nm|so|ca)\d+$/;
const NND_NUMERIC_ID_RE = /^\d+$/;

export const isNndId = (id: string): boolean =>
	NND_PREFIXED_ID_RE.test(id) || NND_NUMERIC_ID_RE.test(id);

/**
 * Port of NiconicoStreamLinkHandlerFactory.getId: accepts a bare id or a
 * nicovideo.jp/nico.ms URL and returns the id, or null. Live URLs
 * (live.nicovideo.jp/watch/lvNNN) are not supported by the VOD path.
 */
export function extractNndId(input: string): string | null {
	const s = (input || "").trim();
	if (!s) return null;
	if (isNndId(s)) return s;
	// nicovideo.jp/watch/<id> | nico.ms/<id> | embed./sp. subdomains
	const m = /(?:nicovideo\.jp\/watch\/|nico\.ms\/)((?:sm|nm|so|ca)\d+)/i.exec(s);
	return m ? m[1].toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type NndErrorKind = "login" | "paid" | "geo" | "gone" | "http";

export class NndError extends Error {
	constructor(
		public kind: NndErrorKind,
		message: string,
		public status = 0
	) {
		super(message);
		this.name = "NndError";
	}
}

// ---------------------------------------------------------------------------
// Watch data
// ---------------------------------------------------------------------------

export const NND_WATCH_URL = "https://www.nicovideo.jp/watch/";
const NVAPI_BASE = "https://nvapi.nicovideo.jp/v1/watch/";

const GOOGLEBOT_UA =
	"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const STREAM_UA =
	"Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/119.0";

/**
 * Optional login cookie (user_session_...=...). Read lazily: dotenv.config()
 * runs in server.ts AFTER hoisted module imports, so a module-level read would
 * always see an empty value.
 *
 * Without it, all public videos work fine — PPE only attaches the cookie when
 * ServiceList.NicoNico.hasTokens() is true. Only channel-member-only /
 * login-required / region-locked videos need it.
 */
export function nndCookie(): string {
	return process.env.NND_COOKIE ?? "";
}

export interface NndDomandTrack {
	id: string;
	isAvailable: boolean;
	[k: string]: any;
}

export interface NndWatchData {
	video: {
		id?: string;
		title: string;
		duration: number;
		thumbnail?: { ogp?: string; [k: string]: any };
		count?: { view?: number; [k: string]: any };
		[k: string]: any;
	};
	media: {
		domand: {
			videos: NndDomandTrack[];
			audios: NndDomandTrack[];
			accessRightKey: string;
			[k: string]: any;
		};
		[k: string]: any;
	};
	client: { watchTrackId: string; [k: string]: any };
	[k: string]: any;
}

/**
 * The watch payload has changed shape at least once and PPE's
 * `media.domand` path no longer matches what the site returns:
 *
 *   PPE / older:  response.{ video, media.domand.{videos,audios,accessRightKey}, client }
 *   current:      response.$watchV4.data.{ video, media.{contents.{videos,audios},accessRightKey,hls}, client }
 *
 * `media.hls` is present but NULL for guest sessions, so `contents` is the
 * source of the quality ladders. Normalizing here keeps every consumer
 * (route, quality resolver, access-rights request) on one shape.
 */
function normalizeWatchData(response: any): NndWatchData {
	const root = response && response["$watchV4"] && response["$watchV4"].data
		? response["$watchV4"].data
		: response;
	if (!root) throw new NndError("gone", "empty watch payload");

	const media = root.media || {};
	const legacy = media.domand || {};
	// Current layout: ladders under media.contents (media.hls is null for guests).
	const contents = media.contents || media.hls || {};

	const videos = legacy.videos || contents.videos || [];
	const audios = legacy.audios || contents.audios || [];
	const accessRightKey = legacy.accessRightKey || media.accessRightKey || "";

	if (!videos.length) {
		throw new NndError("gone", "watch payload has no video ladder");
	}
	if (!accessRightKey) {
		throw new NndError("gone", "watch payload has no accessRightKey");
	}

	return {
		...root,
		video: root.video || {},
		client: root.client || {},
		media: {
			...media,
			domand: { ...legacy, videos, audios, accessRightKey },
		},
	} as NndWatchData;
}

/**
 * Port of NiconicoWatchDataCache.refreshAndGetWatchData.
 *
 * The watch page embeds the whole session JSON in
 * <meta name="server-response" content="...">. A Googlebot UA gets it without
 * login. If the tag is missing, the page is one of the three gated states, or
 * the video is simply gone.
 */
export async function fetchWatchData(id: string): Promise<NndWatchData> {
	const headers: Record<string, string> = {
		"User-Agent": GOOGLEBOT_UA,
		"Accept-Language": "ja-JP",
	};
	const cookie = nndCookie();
	if (cookie) headers["Cookie"] = cookie;

	const res = await fetch(NND_WATCH_URL + id, { headers });
	const body = await res.text();

	if (res.status >= 400) {
		throw new NndError("http", `watch page ${res.status}`, res.status);
	}

	const doc = new JSDOM(body).window.document;
	const meta = doc.querySelector('meta[name="server-response"]');

	if (!meta) {
		// Order matters: mirrors NiconicoWatchDataCache's checks.
		if (body.indexOf("チャンネル会員専用動画") !== -1) {
			throw new NndError("paid", "Channel member limited video");
		}
		if (body.indexOf("地域と同じ地域からのみ視聴") !== -1) {
			throw new NndError(
				"geo",
				"Video can only be viewed in the region it was uploaded"
			);
		}
		if (body.indexOf("この動画を視聴するにはログインが必要です") !== -1) {
			throw new NndError("login", "Login required to view this video");
		}
		const failMessage = doc.querySelector("p.fail-message");
		throw new NndError(
			"gone",
			(failMessage && failMessage.textContent) || "Video unavailable"
		);
	}

	const content = meta.getAttribute("content");
	if (!content) throw new NndError("gone", "empty server-response meta");

	let parsed: any;
	try {
		parsed = JSON.parse(content);
	} catch (e) {
		throw new NndError("gone", "failed to parse server-response JSON");
	}

	const response = parsed && parsed.data && parsed.data.response;
	if (!response) throw new NndError("gone", "server-response has no payload");
	return normalizeWatchData(response);
}

// ---------------------------------------------------------------------------
// Headers (verbatim from NiconicoService.java:136-157 / :179-195)
// ---------------------------------------------------------------------------

function streamSourceHeaders(accessRightKey: string): Record<string, string> {
	const h: Record<string, string> = {
		"User-Agent": STREAM_UA,
		Accept: "*/*",
		"Accept-Language": "en-US,en;q=0.5",
		// NOTE: the Java sets "Accept-Encoding: gzip, deflate, br". Omitted on
		// purpose: fetch negotiates and decompresses its own encodings, and a
		// hardcoded "br" would hand compressed bytes back to .text().
		Referer: "https://www.nicovideo.jp/",
		"Content-Type": "application/json",
		"X-Request-With": "https://www.nicovideo.jp",
		"X-Access-Right-Key": accessRightKey,
		"X-Frontend-Id": "6",
		"X-Frontend-Version": "0",
		Origin: "https://www.nicovideo.jp",
		DNT: "1",
		"Sec-Fetch-Dest": "empty",
		"Sec-Fetch-Mode": "cors",
		"Sec-Fetch-Site": "same-site",
		"Sec-GPC": "1",
	};
	const cookie = nndCookie();
	if (cookie) h["Cookie"] = cookie;
	return h;
}

export function streamHeaders(cookie: string): Record<string, string> {
	const h: Record<string, string> = {
		"User-Agent": STREAM_UA,
		Accept: "*/*",
		"Accept-Language": "en-US,en;q=0.5",
		Referer: "https://www.nicovideo.jp/",
		Origin: "https://www.nicovideo.jp",
		DNT: "1",
		"Sec-Fetch-Dest": "empty",
		"Sec-Fetch-Mode": "cors",
		"Sec-Fetch-Site": "same-site",
		"Sec-GPC": "1",
	};
	// Java sends this unconditionally; an empty value is harmless.
	if (cookie) h["Cookie"] = cookie;
	return h;
}

// ---------------------------------------------------------------------------
// Quality selection
// ---------------------------------------------------------------------------

/** Preferred video ladder, best first. */
const VIDEO_QUALITY_ORDER = [
	"video-h264-1080p",
	"video-h264-720p",
	"video-h264-480p",
	"video-h264-360p",
	"video-h264-144p",
];

/** Preferred audio, best first. */
const AUDIO_QUALITY_ORDER = [
	"audio-aac-192kbps",
	"audio-aac-128kbps",
	"audio-aac-64kbps",
];

function pickBest(tracks: NndDomandTrack[], order: string[]): NndDomandTrack | undefined {
	const available = tracks.filter((t) => t && t.isAvailable);
	for (const id of order) {
		const hit = available.find((t) => t.id === id);
		if (hit) return hit;
	}
	return available[0];
}

/**
 * Resolves a requested quality id ("auto" or a concrete domand id) against the
 * tracks the watch page says are available. Falls back to the best available.
 */
export function resolveVideoQuality(
	watch: NndWatchData,
	requested?: string
): NndDomandTrack | undefined {
	const domand = watch.media && watch.media.domand;
	if (!domand) return undefined;
	const tracks = domand.videos || [];
	if (requested && requested !== "auto") {
		const hit = tracks.find((t) => t.id === requested && t.isAvailable);
		if (hit) return hit;
	}
	return pickBest(tracks, VIDEO_QUALITY_ORDER);
}

export function resolveAudioQuality(watch: NndWatchData): NndDomandTrack | undefined {
	const domand = watch.media && watch.media.domand;
	if (!domand) return undefined;
	return pickBest(domand.audios || [], AUDIO_QUALITY_ORDER);
}

// ---------------------------------------------------------------------------
// Access rights -> HLS content URL
// ---------------------------------------------------------------------------

export interface NndHlsSession {
	/** URL of the playlist (master) for the chosen output pair. */
	contentUrl: string;
	/** "domand_bid=..." cookie; required on every playlist/segment fetch. */
	domandBid: string;
}

/**
 * Port of the outputs-builder + access-rights POST in
 * NiconicoStreamExtractor.onFetchPage. PPE sends ONE output pair per request
 * and re-requests per quality; this port does the same.
 */
export async function requestHlsStream(
	id: string,
	watch: NndWatchData,
	videoQualityId: string,
	audioQualityId?: string
): Promise<NndHlsSession> {
	const domand = watch.media && watch.media.domand;
	if (!domand) throw new NndError("gone", "no domand media in watch data");

	const video = resolveVideoQuality(watch, videoQualityId);
	if (!video) throw new NndError("gone", `quality ${videoQualityId} not available`);

	const audio = audioQualityId
		? (domand.audios || []).find((a) => a.isAvailable && a.id === audioQualityId) ||
		  resolveAudioQuality(watch)
		: resolveAudioQuality(watch);
	if (!audio) throw new NndError("gone", "no available audio track");

	const body = JSON.stringify({ outputs: [[video.id, audio.id]] });
	const headers = streamSourceHeaders(domand.accessRightKey);
	const trackId = (watch.client && watch.client.watchTrackId) || "";

	const res = await fetch(
		`${NVAPI_BASE}${id}/access-rights/hls?actionTrackId=${encodeURIComponent(trackId)}`,
		{ method: "POST", headers, body }
	);

	if (res.status >= 400) {
		// PPE invalidates the watch cache here and asks the caller to retry.
		throw new NndError(
			"http",
			`access-rights ${res.status} (token expired?)`,
			res.status
		);
	}

	// node/undici exposes combined Set-Cookie as get("set-cookie").
	const setCookie = res.headers.get("set-cookie") || "";
	const bidMatch = /(domand_bid=[^;]+)/.exec(setCookie);
	const domandBid = bidMatch ? bidMatch[1] : "";

	const text = await res.text();
	let json: any;
	try {
		json = JSON.parse(text);
	} catch (e) {
		throw new NndError("http", "access-rights returned non-JSON", res.status);
	}
	const contentUrl = json && json.data && json.data.contentUrl;
	if (!contentUrl) throw new NndError("http", "access-rights had no contentUrl", 502);

	return { contentUrl, domandBid };
}
