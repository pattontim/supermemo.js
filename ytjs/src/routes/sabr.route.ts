/*
 * SABR -> HLS front-end — port of TubeReplacer's TRSabrHTTPConnection.m /
 * TRSabrHTTPServer.m, but emitting fMP4 HLS instead of the hand-rolled
 * fMP4 -> MPEG-TS transmux TRSabrMedia.m needs for the old iOS player.
 *
 * Endpoints (mounted at /sabr/<videoId>/...):
 *   master.m3u8          -> multivariant playlist (audio + video)
 *   video.m3u8           -> media playlist for the selected video itag
 *   audio.m3u8           -> media playlist for the selected audio itag
 *   init-<kind>.m4s      -> fMP4 init segment (served once the session has it)
 *   seg-<kind>-<n>.m4s   -> fMP4 media fragment n (1-based, matches SABR)
 *
 * A session is created lazily per videoId and pumped in the background; media
 * requests park until the fragment arrives (TRSabrHTTPResponse's registerCallback).
 */

import { Router, Request, Response } from "express";
import { SabrStream, SabrMedia, SabrClientInfo, SabrInputFormat, SABR_SLOW_NETWORK_BPS, SABR_DEFAULT_BANDWIDTH_BPS } from "../sabr/sabr-stream";
import { getOrCreateSabrInputs, createInnertube, mintContentPoToken, setSabrInputs, sabrInputsFromJson, SabrInputs } from "../utils/localvideo";
import { getWatchPageSabrInputs } from "../sabr/watchpage";
import { cache, yti_version } from "../server";
import { latestCacheConstructor } from "../utils/archive";
import { VideoInfo } from "../utils/yt-types";

const router = Router();

/** WEB ClientInfo — the watch page is a WEB-client render. */
const WEB_CLIENT: SabrClientInfo = {
	clientName: 1,
	clientVersion: process.env.YTJS_SABR_CVER ?? "2.20261012.01.00",
	osName: "X11",
	osVersion: "",
};

/**
 * Watch-page sourcing smoke test: builds a SabrStream purely from the watch
 * page's embedded ytInitialPlayerResponse (no /player API, no JSDOM token).
 * This isolates "is the URL/session origin the gate?" from "is our SABR code
 * correct?". An empty poToken is deliberate — token provenance was already
 * refuted, so only the URL origin changes here.
 */
router.get("/sabr-test-wp/:id", async (req, res) => {
	const id = req.params.id;
	try {
		const wp = await getWatchPageSabrInputs(id);
		if (!wp) return res.status(503).json({ source: "watchpage", error: "no watch-page sabr inputs" });

		// The watch-page-embedded URL is not always pre-playable in a non-browser
		// session (verbatim request 403s). Decipher it (the `n` transform) with a
		// real player, exactly as localvideo.ts does for the API response.
		let sabrUrl = wp.sabrUrl;
		let deciphered = false;
		try {
			const innertube = await createInnertube({ withPlayer: true, generateSessionLocally: false });
			const dec = await innertube.session.player!.decipher(wp.sabrUrl);
			if (dec) { sabrUrl = dec; deciphered = dec !== wp.sabrUrl; }
		} catch (e) {
			console.error("[sabr] watchpage decipher failed", e);
		}

		const stream = new SabrStream(
			sabrUrl,
			wp.ustreamerConfig,
			wp.formats,
			// Experiment hook: YTJS_SABR_INJECT_TOKEN_B64 (websafe base64) swaps
			// in a browser-captured token; empty token otherwise (deliberate —
			// token provenance was already refuted, only URL origin changes).
			process.env.YTJS_SABR_INJECT_TOKEN_B64
				? Buffer.from(process.env.YTJS_SABR_INJECT_TOKEN_B64.replace(/-/g, "+").replace(/_/g, "/"), "base64")
				: Buffer.alloc(0),
			id,
			WEB_CLIENT as SabrClientInfo,
		);
		stream.start();
		try {
			await Promise.race([
				Promise.all([stream.video.onSegment(0), stream.audio.onSegment(0)]),
				new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 40000)),
			]);
		} catch {
			/* report whatever state we reached */
		}
		stream.stop();
		res.json({
			source: "watchpage",
			wpDebug: wp.debug,
			deciphered,
			dead: stream.dead,
			requestNumber: stream.requestNumber,
			videoItag: stream.video.itag,
			audioItag: stream.audio.itag,
			videoReady: stream.video.ready,
			audioReady: stream.audio.ready,
			videoBytes: stream.video.initSegment?.length ?? 0,
			audioBytes: stream.audio.initSegment?.length ?? 0,
			videoSegments: stream.video.availableSegments(),
			audioSegments: stream.audio.availableSegments(),
		});
	} catch (e) {
		res.status(500).send(String(e));
	}
});

/** TEMP: dump captured SABR inputs so an external probe script can experiment. */
router.get("/sabr-dump/:id", async (req, res) => {
	try {
		const inputs = await getOrCreateSabrInputs(req.params.id);
		if (!inputs) return res.status(404).send("no inputs");
		res.json({
			sabrUrl: inputs.sabrUrl,
			ustreamerConfig: inputs.ustreamerConfig.toString("base64"),
			poToken: inputs.poToken.toString("base64"),
			formats: inputs.formats,
			clientName: inputs.clientName,
			clientVersion: inputs.clientVersion,
			osName: inputs.osName,
			osVersion: inputs.osVersion,
			acceptLanguage: inputs.acceptLanguage,
			acceptRegion: inputs.acceptRegion,
		});
	} catch (e) {
		res.status(500).send(String(e));
	}
});

/**
 * Inject a browser-captured SABR bundle (see ytjs/scripts/capture-sabr-bundle.mjs).
 * Body shape matches the capture script's output. The bundle is stored in the
 * sabrInputs map, so the next getSession/getOrCreateSabrInputs for this videoId
 * uses it verbatim (no minting, no watch-page fetch).
 */
router.post("/sabr-inject/:id", (req, res) => {
	try {
		// No express.json() middleware is mounted globally, so parse the raw
		// body ourselves (handles both buffered Buffer and string forms).
		let rawBody = "";
		const chunks: Buffer[] = [];
		const parse = () => {
			const bodyText = Buffer.concat(chunks).toString("utf-8");
			const raw = JSON.parse(bodyText);
			if (!raw?.sabrUrl || !raw?.ustreamerConfig) {
				return res.status(400).json({ error: "sabrUrl and ustreamerConfig required" });
			}
			const inputs = sabrInputsFromJson(raw);
			setSabrInputs(req.params.id, inputs);
			console.log(
				`[sabr] injected bundle for ${req.params.id}: url=${inputs.sabrUrl.length}b ` +
				`poToken=${inputs.poToken.length}b formats=${inputs.formats.length} ` +
				`headers=${Object.keys(inputs.headers ?? {}).length} cpn=${inputs.cpn ? "set" : "none"}`
			);
			res.json({ ok: true, videoId: req.params.id, poTokenBytes: inputs.poToken.length });
		};
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			try { parse(); } catch (e) { res.status(400).json({ error: String(e) }); }
		});
		req.on("error", (e) => res.status(400).json({ error: String(e) }));
	} catch (e) {
		res.status(400).json({ error: String(e) });
	}
});

/**
 * Injected-bundle smoke test: builds a SabrStream purely from the injected
 * bundle (real browser token + headers + cpn), pumps until the first segments
 * arrive or timeout, and reports state. No minting, no watch-page fetch.
 * The page-embedded serverAbrStreamingUrl carries an UNDECIPHERED `n` param
 * (the browser deciphers it in JS before its first POST), so decipher it here
 * exactly as the watchpage path does.
 */
router.get("/sabr-test-inject/:id", async (req, res) => {
	const id = req.params.id;
	try {
		const inputs = await getOrCreateSabrInputs(id);
		if (!inputs) return res.status(404).json({ error: "no inputs (inject first)" });
		let sabrUrl = inputs.sabrUrl;
		let deciphered = false;
		try {
			const innertube = await createInnertube({ withPlayer: true, generateSessionLocally: false });
			const dec = await innertube.session.player!.decipher(inputs.sabrUrl);
			if (dec) { sabrUrl = dec; deciphered = dec !== inputs.sabrUrl; }
		} catch (e) {
			console.error("[sabr] inject decipher failed", e);
		}
		const stream = new SabrStream(
			sabrUrl,
			inputs.ustreamerConfig,
			inputs.formats,
			inputs.poToken,
			id,
			{
				clientName: inputs.clientName,
				clientVersion: inputs.clientVersion,
				osName: inputs.osName,
				osVersion: inputs.osVersion,
				acceptLanguage: inputs.acceptLanguage,
				acceptRegion: inputs.acceptRegion,
			},
			undefined,
			inputs.headers,
			inputs.cpn,
		);
		stream.start();
		try {
			await Promise.race([
				Promise.all([stream.video.onSegment(0), stream.audio.onSegment(0)]),
				new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 40000)),
			]);
		} catch { /* report whatever state we reached */ }
		stream.stop();
		res.json({
			source: "injected",
			deciphered,
			dead: stream.dead,
			requestNumber: stream.requestNumber,
			videoItag: stream.video.itag,
			audioItag: stream.audio.itag,
			videoReady: stream.video.ready,
			audioReady: stream.audio.ready,
			videoSegments: stream.video.availableSegments(),
			audioSegments: stream.audio.availableSegments(),
		});
	} catch (e) {
		res.status(500).send(String(e));
	}
});

interface Session {
	stream: SabrStream;
	createdAt: number;
	lastAccess: number;
	/** Format metadata (from watch page) for building the DASH manifest. */
	videoFormat?: SabrInputFormat;
	audioFormat?: SabrInputFormat;
	/**
	 * Built from the watch-page player response (no extra getInfo), so the
	 * serve path can populate cache[v_id] for /archiveInfo.
	 */
	videoInfo?: VideoInfo;
}

const sessions = new Map<string, Session>();
const SESSION_IDLE_MS = 5 * 60 * 1000;

function pruneSessions() {
	const now = Date.now();
	for (const [id, s] of sessions) {
		if (now - s.lastAccess > SESSION_IDLE_MS) {
			s.stream.stop();
			sessions.delete(id);
		}
	}
}

// Active reaper: pruneSessions() used to run only inside getSession(), so a
// closed player (no more requests) never triggered cleanup and its background
// pump kept running. Reap on a timer instead.
const reaper = setInterval(pruneSessions, 30_000);
if (typeof reaper.unref === "function") reaper.unref();

async function buildWatchPageStream(videoId: string, maxHeightOverride?: number): Promise<{
	stream: SabrStream;
	videoFormat?: SabrInputFormat;
	audioFormat?: SabrInputFormat;
	videoInfo?: VideoInfo;
} | null> {
	const wp = await getWatchPageSabrInputs(videoId);
	if (!wp) return null;
	const innertube = await createInnertube({ withPlayer: true, generateSessionLocally: false });
	const decipheredUrl = (await innertube.session.player!.decipher(wp.sabrUrl)) || wp.sabrUrl;
	console.log(`[sabr] decipher: changed=${decipheredUrl !== wp.sabrUrl} hasN=${/&n=/.test(decipheredUrl)}`);
	// Build a VideoInfo from the already-parsed player response, reusing the
	// Innertube actions we just created — mirrors youtubei.js's own
	// getTrailerInfo() pattern (new VideoInfo([{ data }], actions, cpn)) and makes
	// no HTTP call. MediaInfo parses data[0].data.playerResponse ?? data[0].data,
	// so the raw player response is sufficient. cpn is irrelevant to metadata.
	let videoInfo: VideoInfo | undefined;
	try {
		videoInfo = new VideoInfo(
			[{ data: wp.playerResponse } as any],
			innertube.session.actions,
			"",
		);
	} catch (e) {
		console.error(`[sabr] failed to build VideoInfo from watch page for ${videoId}`, e);
	}
	// IE11 MSE only accepts H.264/AVC video + AAC/MP4A audio; the watch-page
	// formats include VP9/Opus which must be filtered out before we build the
	// single-format request and the DASH manifest.
	//
	// The watch-page list is ordered highest-quality-first, so "first avc1" lands
	// on the top rung — for some videos that is 1080p60 High@L4.2 (itag 299,
	// avc1.64002A), which desktop Chrome decodes but IE11's MSE pipeline does
	// not. Since the SABR manifest emits a SINGLE video Representation there is
	// no lower rung for dash.js to adapt down to, so the pick itself must be
	// IE11-decodable.
	//
	// Match what dash.js actually tests on IE11: CapabilitiesFilter calls
	// MediaSource.isTypeSupported('video/mp4;codecs="<codecs>";width="W";height="H"')
	// — note it appends width/height but NOT framerate. So profile/level and
	// resolution are the real discriminators; fps is only a preference here.
	const IE11_MAX_LEVEL = Number(process.env.YTJS_SABR_MAX_LEVEL ?? 0x28); // H.264 level 4.0
	const IE11_MAX_HEIGHT = maxHeightOverride ?? Number(process.env.YTJS_SABR_MAX_HEIGHT ?? 1080);
	const IE11_PREFERRED_MAX_FPS = 30;

	// avc1.PPCCLL — the last hex byte is level_idc (e.g. "2A" = level 4.2).
	const avcLevel = (codecs?: string): number => {
		const m = /avc1\.[0-9a-fA-F]{4}([0-9a-fA-F]{2})/.exec(codecs ?? "");
		return m ? parseInt(m[1], 16) : Number.POSITIVE_INFINITY;
	};
	const ie11SafeVideo = (f: SabrInputFormat): boolean =>
		!f.isAudio &&
		/avc1/.test(f.mimeType) &&
		avcLevel(f.codecs) <= IE11_MAX_LEVEL &&
		(f.height ?? 0) <= IE11_MAX_HEIGHT;

	// Highest IE11-safe rung, preferring <=30fps when one exists (60fps rungs
	// cost bitrate for no benefit on IE11 and are the likeliest to be refused).
	const safeVideos = wp.formats.filter(ie11SafeVideo);
	const pickVideo =
		safeVideos.find((f) => (f.fps ?? 30) <= IE11_PREFERRED_MAX_FPS) ??
		safeVideos[0] ??
		// Nothing strictly safe: fall back to the lowest AVC rung.
		[...wp.formats].reverse().find((f) => !f.isAudio && /avc1/.test(f.mimeType));
	const pickAudio = wp.formats.find((f) => f.isAudio && /mp4a/.test(f.mimeType));
	const videoFormat = pickVideo ?? wp.formats.find((f) => !f.isAudio);
	const audioFormat = pickAudio ?? wp.formats.find((f) => f.isAudio);
	const ordered = [videoFormat, audioFormat].filter(Boolean) as SabrInputFormat[];
	console.log(
		`[sabr] IE11 video pick: itag=${videoFormat?.itag} codecs=${videoFormat?.codecs} ` +
		`fps=${videoFormat?.fps} ${videoFormat?.width}x${videoFormat?.height} ` +
		`(maxLevel=${IE11_MAX_LEVEL.toString(16)} maxHeight=${IE11_MAX_HEIGHT})`
	);

	// Real content-bound PO token so the session survives past the empty-token
	// window (StreamProtectionStatus 3). Falls back to an empty token (which
	// covers the first ~7MB) if minting fails.
	// Experiment hook: YTJS_SABR_INJECT_TOKEN_B64 (websafe base64) overrides
	// minting with a browser-captured token — isolates token provenance from
	// the URL/config pair.
	let poToken: Buffer;
	if (process.env.YTJS_SABR_INJECT_TOKEN_B64) {
		poToken = Buffer.from(
			process.env.YTJS_SABR_INJECT_TOKEN_B64.replace(/-/g, "+").replace(/_/g, "/"),
			"base64",
		);
		console.log(`[sabr] using INJECTED browser token (${poToken.length}b) for watchpage session`);
	} else {
		const minted = await mintContentPoToken(videoId);
		poToken = minted?.poToken ?? Buffer.alloc(0);
	}

	// The token is bound to the minting session's visitor identity. The SABR
	// request carries that identity via the poToken itself; StreamerContext
	// ClientInfo.accept_region (field 22) is a *region*, not a visitor id, so it
	// is deliberately left unset here (a real client leaves it unset too).
	const clientInfo: SabrClientInfo = {
		...WEB_CLIENT,
	};

	const stream = new SabrStream(
		decipheredUrl,
		wp.ustreamerConfig,
		ordered,
		poToken,
		videoId,
		clientInfo,
		// Re-mint on the ~45s timer so the session survives past the ~60s token
		// lifetime (StreamProtectionStatus 3).
		async () => {
			return await mintContentPoToken(videoId);
		},
	);
	console.log(
		`[sabr] session via watchpage for ${videoId}: video=${videoFormat?.itag} ` +
		`(${videoFormat?.codecs}) audio=${audioFormat?.itag} (${audioFormat?.codecs}) ` +
		`poToken=${poToken.length}b`
	);
	return { stream, videoFormat, audioFormat, videoInfo };
}

/** Build a watch-page session and confirm the first SABR round-trip succeeds. */
async function probeWatchPageStream(videoId: string): Promise<{
	stream: SabrStream;
	videoFormat?: SabrInputFormat;
	audioFormat?: SabrInputFormat;
	videoInfo?: VideoInfo;
} | null> {
	const built = await buildWatchPageStream(videoId);
	if (!built) return null;
	await built.stream.pumpOnce(0);
	if (built.stream.dead) {
		console.log(`[sabr] watchpage probe failed for ${videoId} (dead), will retry`);
		return null;
	}
	return built;
}

async function getSession(videoId: string): Promise<SabrStream> {
	pruneSessions();
	const existing = sessions.get(videoId);
	if (existing && !existing.stream.dead) {
		existing.lastAccess = Date.now();
		return existing.stream;
	}
	// A dead session is sticky and has no internal recovery; drop it so a retry
	// (e.g. an SM reload) builds a fresh stream instead of a permanent 503.
	// IMPORTANT: googlevideo allows ONE live SABR session per (visitor, video).
	// A reaped session's server-side slot lingers for a while, so an immediate
	// replacement gets StreamProtectionStatus 3 on its first pumps. Back off
	// briefly before creating the replacement to let the old slot expire.
	if (existing?.stream.dead) {
		const deadAt = existing.stream.deadAt ?? Date.now();
		const sinceDeath = Date.now() - deadAt;
		const BACKOFF_MS = 5000;
		if (sinceDeath < BACKOFF_MS) {
			console.warn(`[sabr] ${videoId}: dead session ${sinceDeath}ms ago, backing off ${BACKOFF_MS - sinceDeath}ms before replacement`);
			await new Promise((r) => setTimeout(r, BACKOFF_MS - sinceDeath));
		}
		console.warn(`[sabr] ${videoId}: dead session, reaping for a fresh one`);
		sessions.delete(videoId);
	}

	// Preferred path: watch-page session. A freshly fetched watch-page URL is
	// usually accepted, but a small fraction 403 (stale/rejected) — so probe it
	// and refetch up to a few times before falling back to the API session.
	let stream: SabrStream | undefined;
	let videoFormat: SabrInputFormat | undefined;
	let audioFormat: SabrInputFormat | undefined;
	let videoInfo: VideoInfo | undefined;
	for (let attempt = 0; attempt < 3 && !stream; attempt++) {
		try {
			const built = await probeWatchPageStream(videoId);
			if (built) {
				stream = built.stream;
				videoFormat = built.videoFormat;
				audioFormat = built.audioFormat;
				videoInfo = built.videoInfo;
			}
		} catch (e) {
			console.error(`[sabr] watchpage attempt ${attempt + 1} failed`, e);
		}
	}

	if (!stream) {
		const inputs = await getOrCreateSabrInputs(videoId);
		if (!inputs) throw new Error("No SABR data available for this video");

		const clientInfo: SabrClientInfo = {
			clientName: inputs.clientName,
			clientVersion: inputs.clientVersion,
			osName: inputs.osName,
			osVersion: inputs.osVersion,
			acceptLanguage: inputs.acceptLanguage,
			acceptRegion: inputs.acceptRegion,
		};

		// Temporary experiment hook: override the ClientInfo client name/version so
		// we can find a client_context the SABR server accepts.
		if (process.env.YTJS_SABR_CLIENT) {
			clientInfo.clientName = Number(process.env.YTJS_SABR_CLIENT);
		}
		if (process.env.YTJS_SABR_CLIENT_VERSION) {
			clientInfo.clientVersion = process.env.YTJS_SABR_CLIENT_VERSION;
		}

		stream = new SabrStream(
			inputs.sabrUrl,
			inputs.ustreamerConfig,
			inputs.formats,
			inputs.poToken,
			videoId,
			clientInfo,
			undefined,
			inputs.headers,
			inputs.cpn,
		);
	}

	sessions.set(videoId, {
		stream,
		createdAt: Date.now(),
		lastAccess: Date.now(),
		videoFormat,
		audioFormat,
		videoInfo,
	});
	stream.start();
	return stream;
}

/**
 * Build or attach to a SABR session for the archive download path.
 *
 * Attach-first: if the player already has a live session for this video whose
 * served video rendition matches the requested height, reuse it. Its segment
 * cache is then free bytes (a span already watched costs zero network) and we
 * avoid the second-session StreamProtectionStatus-3 collision documented in
 * getSession (googlevideo allows ONE live session per visitor+video).
 *
 * A non-matching height gets a DEDICATED stream pinned to that height, because
 * a session requests exactly one video itag — its cached segments are the wrong
 * rendition and cannot be reused.
 *
 * `owned` tells the caller whether it may stop() the stream: never stop a
 * session the player is still using.
 */
export async function acquireSabrDownloadStream(
	videoId: string,
	maxHeight: number,
): Promise<{ stream: SabrStream; owned: boolean } | null> {
	pruneSessions();
	const live = sessions.get(videoId);
	if (live && !live.stream.dead) {
		// Prefer the itag the SERVER actually picked (stream.videoHeight), since
		// the NEXT_REQUEST_POLICY cookie can substitute a different rendition.
		const servedHeight = live.stream.videoHeight() ?? live.videoFormat?.height;
		const exact = servedHeight !== undefined && Math.abs(servedHeight - maxHeight) <= 1;
		if (exact) {
			// Keep the session alive for the duration of the download.
			live.stream.onProgress = () => { live.lastAccess = Date.now(); };
			live.lastAccess = Date.now();
			console.log(
				`[sabr] archive reusing live ${videoId} session at ${servedHeight}p ` +
				`(${live.stream.video.segments.size}v/${live.stream.audio.segments.size}a cached)`
			);
			return { stream: live.stream, owned: false };
		}
		console.log(
			`[sabr] archive wants ${maxHeight}p but live session serves ${servedHeight}p — ` +
			`building a dedicated download stream (no cache reuse)`
		);
	}

	const stream = await buildSabrDownloadStream(videoId, maxHeight);
	if (!stream) return null;
	return { stream, owned: true };
}

/**
 * Build a dedicated SABR session pinned to a target height, for the archive
 * download path. Reuses the same watch-page sourcing + IE11 (H.264/AAC) format
 * pick the playback relay uses, but keys off the requested height instead of
 * the global YTJS_SABR_MAX_HEIGHT cap.
 *
 * The caller owns the returned stream (call stop() when done).
 */
export async function buildSabrDownloadStream(
	videoId: string,
	maxHeight: number,
): Promise<SabrStream | null> {
	const built = await buildWatchPageStream(videoId, maxHeight);
	if (!built) return null;
	// Probe the first round-trip the same way getSession does, so a rejected
	// URL fails here instead of mid-download.
	await built.stream.pumpOnce(0);
	if (built.stream.dead) {
		console.warn(`[sabr] download probe failed for ${videoId} at ${maxHeight}p`);
		return null;
	}
	return built.stream;
}

async function waitForInit(stream: SabrStream, media: SabrMedia, timeoutMs = 45000) {	stream.nudge();
	await Promise.race([
		media.onSegment(0),
		new Promise((_, rej) => setTimeout(() => rej(new Error("init segment timeout")), timeoutMs)),
	]);
}

async function waitForSegment(stream: SabrStream, media: SabrMedia, seq: number, timeoutMs = 45000) {
	// Cache hit — serve straight from media.segments, like PipePipe's
	// awaitSegment returning a cachedSegment before issuing any request.
	// Crucially, do NOT nudge: nudge() rewinds lastPlayerTimeMs to the
	// seek-back position and fires pumpOnce, which makes the SABR server
	// re-send a read-ahead window of bytes we already hold. Returning here
	// means a backward seek into buffered territory costs zero server traffic.
	if (seq > 0 && media.segments.has(seq)) return;

	if (seq > 0) {
		// player_time_ms (field 28). We report the NOMINAL START TIME OF THE
		// REQUESTED SEGMENT, not the end of the contiguous buffered range.
		//
		// googlevideo's player-driven SabrStreamingAdapter does exactly this and
		// documents it as deliberate: "we are cheating a bit by abusing the player
		// time field (in clientAbrState), setting it to the exact start time value
		// of the segment we want, while YouTube simply uses the actual player
		// time." The SABR server only serves a bounded read-ahead window per
		// player time, so reporting the wanted segment's start makes it serve
		// that region directly.
		//
		// The old `bufferedEndMs()`-first behaviour was copied from the BULK
		// downloader (SabrStream.ts seeks to trackCollection.buffered and walks
		// forward sequentially). For a player-driven relay that is wrong: on a
		// cold session the contiguous buffer ends ~20-40s in, so a seek to 1:04
		// only told the server "playhead is 40s" and it crawled forward one
		// throttled cycle at a time until dash.js's segment XHR timed out ->
		// native media error -> black screen.
		//
		// Uses the SAME nominalDurationMs the manifest advertises, so this stays
		// consistent with the $Number$ dash.js computed to ask for this segment.
		const kind = media === stream.video ? "video" : "audio";
		const nominal = nominalDurationMs(media, kind);
		// Prefer the sidx-derived real start: the manifest now advertises a
		// SegmentTimeline, so the $Number$ dash.js asks for corresponds to real
		// presentation time, and the pump must be nudged to that same time.
		const segStart = media.segmentTimeline?.[seq - 1]?.startMs ?? (seq - 1) * nominal;
		if (process.env.BG_CENSUS === "1") {
			const prev = media.segments.get(seq - 1);
			// Drift diagnostic: nominalPrevStart is where the SegmentTemplate's
			// $Number$ mapping places the segment dash.js just asked for; realMs is
			// the fragment's actual moof/tfdt decode time (baseDecodeTimeTicks /
			// timescale). If these diverge by seconds, the static-timeline rewrite
			// is justified; if they agree, the canplay failure is elsewhere.
			const realMs =
				prev?.baseDecodeTimeTicks !== undefined && media.timescale
					? (prev.baseDecodeTimeTicks / media.timescale) * 1000
					: undefined;
			console.log(
				`[sabr] seg-${seq} nudge t=${Math.round(segStart)} ` +
				`nominalPrevStart=${(seq - 2) * nominal} ` +
				`realPrevDecodeMs=${realMs !== undefined ? Math.round(realMs) : "n/a"} ` +
				`prevStart=${prev?.startMs} prevDur=${prev?.durationMs} ` +
				`tfdtTicks=${prev?.baseDecodeTimeTicks} timescale=${media.timescale} ` +
				`bufferedEnd=${media.bufferedEndMs()} nominal=${nominal}`
			);
		}
		stream.nudge(segStart);
	}
	await Promise.race([
		media.onSegment(seq),
		// Fail fast so dash.js sees an HTTP error within its ~20s XHR timeout
		// rather than hanging past it into a permanent stall.
		new Promise((_, rej) => setTimeout(() => rej(new Error("segment timeout")), Math.min(timeoutMs, 15000))),
	]);
}

function segmentDurationMs(media: SabrMedia, seq: number): number {
	const seg = media.segments.get(seq);
	if (seg?.durationMs) return seg.durationMs;
	if (seg?.durationTicks && media.timescale) {
		return (seg.durationTicks / media.timescale) * 1000;
	}
	return media.segmentDurationMs ?? 5000;
}

function mediaPlaylist(media: SabrMedia, kind: "video" | "audio"): string {
	const seqs = media.availableSegments();
	const durations = seqs.map((s) => segmentDurationMs(media, s));
	const target = Math.max(1, Math.ceil(Math.max(...durations, 1) / 1000));

	let out =
		`#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:0\n` +
		`#EXT-X-TARGETDURATION:${target}\n` +
		`#EXT-X-MAP:URI="init-${kind}.m4s"\n`;
	for (const s of seqs) {
		out += `#EXTINF:${(segmentDurationMs(media, s) / 1000).toFixed(3)},\nseg-${kind}-${s}.m4s\n`;
	}
	// Only close the playlist once the server told us how many segments exist
	// and we have them all buffered; otherwise leave it open so the player polls.
	if (media.endSegmentNumber !== undefined) {
		let complete = true;
		for (let i = 1; i <= media.endSegmentNumber; i++) {
			if (!media.segments.has(i)) { complete = false; break; }
		}
		if (complete) out += "#EXT-X-ENDLIST\n";
	}
	return out;
}

async function servePlaylist(req: Request, res: Response, kind: "video" | "audio", id: string) {
	try {
		const stream = await getSession(id);
		const media = kind === "video" ? stream.video : stream.audio;
		if (!media.ready) await waitForInit(stream, media);
		res.type("application/vnd.apple.mpegurl").send(mediaPlaylist(media, kind));
	} catch (e) {
		res.status(503).send(String(e));
	}
}

router.get("/sabr/:id/master.m3u8", async (req, res) => {
	try {
		const stream = await getSession(req.params.id);
		await Promise.race([
			stream.video.onSegment(0),
			stream.audio.onSegment(0),
			new Promise((_, rej) => setTimeout(() => rej(new Error("playback not ready")), 45000)),
		]);
		res.type("application/vnd.apple.mpegurl").send(
			`#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n` +
			`#EXT-X-MEDIA:GROUP-ID="audio",NAME="Audio Track",TYPE=AUDIO,DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"\n` +
			`#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="audio"\nvideo.m3u8\n`
		);
	} catch (e) {
		res.status(503).send(String(e));
	}
});

router.get("/sabr/:id/video.m3u8", (req, res) => servePlaylist(req, res, "video", req.params.id));
router.get("/sabr/:id/audio.m3u8", (req, res) => servePlaylist(req, res, "audio", req.params.id));

/**
 * DASH manifest for the same SABR session. IE11 dash.js 4.5.2 consumes
 * SegmentList + fMP4, and the existing init-*.m4s / seg-*.m4s endpoints are
 * already fMP4 — so no transmuxing is needed. We block until the stream has
 * received its init segments (and, for short clips, the full segment list) so
 * the static manifest is complete before dash.js sees it.
 */
/**
 * Nominal per-segment duration, used only as a fallback when the init segment
 * carries no sidx. SABR `duration_ms` values are NOT uniform (measured: 31
 * distinct values, 3.0-7.0s on one video), so a single constant accumulates
 * huge drift (+8995ms by segment 17). media.segmentTimeline is authoritative and
 * is preferred everywhere it exists.
 */
function nominalDurationMs(media: SabrMedia, kind: "video" | "audio"): number {
	const seqs = media.availableSegments();
	const durs = seqs.map((s) => segmentDurationMs(media, s)).filter((d) => d > 0);
	if (durs.length === 0) return kind === "audio" ? 10000 : 5000;
	// Median, not mean: early segments skew low, and the template should track
	// the dominant keyframe bucket (~5s), not average the outliers in.
	const sorted = [...durs].sort((a, b) => a - b);
	const med = sorted[Math.floor(sorted.length / 2)];
	return Math.max(1000, Math.min(15000, Math.round(med)));
}

/**
 * DASH Representation for one SABR track.
 *
 * Emits a type="static" SegmentTimeline built from the init segment's sidx when
 * available, otherwise falls back to a nominal-duration SegmentTemplate.
 *
 * The timeline is the correct shape: dash.js maps $Number$=N to the Nth <S> and
 * derives its presentation time from the accumulated <S> durations, which match
 * the fragments' real moof/tfdt decode times. The old single-`duration`
 * SegmentTemplate assumed uniform segments; real SABR durations vary 3.0-7.0s,
 * so by segment 17 the template position was ~9s ahead of reality and a seek to
 * 64s requested a segment that actually started at 71.7s — leaving currentTime
 * in an unbuffered hole so canplay never fired.
 *
 * Note: the earlier comment claiming a SegmentTimeline "was tested and didn't
 * play" conflated it with type="dynamic" (wall-clock anchored, which finds
 * nothing in a media-ordered VOD window). A type="static" timeline is fine.
 *  - startNumber="1": $Number$=1 -> seg-<kind>-1.m4s (SABR seq is 1-based).
 */
function representationXml(fmt: SabrInputFormat | undefined, media: SabrMedia, kind: "video" | "audio"): string {
	const codecs = fmt?.codecs ?? (kind === "video" ? "avc1.4d401f" : "mp4a.40.2");
	const bandwidth = fmt?.bandwidth ?? (kind === "video" ? 1000000 : 128000);
	const attrs: string[] = [
		`id="${media.itag}"`,
		`bandwidth="${bandwidth}"`,
		`codecs="${codecs}"`,
	];
	if (kind === "video" && fmt?.width && fmt?.height) {
		attrs.push(`width="${fmt.width}"`, `height="${fmt.height}"`);
	}
	if (kind === "audio" && fmt?.audioSampleRate) {
		attrs.push(`audioSamplingRate="${fmt.audioSampleRate}"`);
	}

	// Authoritative path: a real SegmentTimeline built from the init segment's
	// sidx, so $Number$=N maps to the Nth <S> and its presentation time equals
	// the fragment's real moof/tfdt decode time. This eliminates the nominal-vs-
	// real drift that left currentTime in an unbuffered hole after a seek.
	// The sidx covers 0 -> end regardless of which segments are buffered, so
	// no full pump from segment 1 is required.
	const timeline = media.segmentTimeline;
	if (timeline && timeline.length) {
		// Collapse runs of equal durations into d/r to keep the MPD small.
		let s = "";
		for (let i = 0; i < timeline.length; ) {
			const d = Math.round(timeline[i].durationMs);
			let r = 0;
			while (i + r + 1 < timeline.length && Math.round(timeline[i + r + 1].durationMs) === d) r++;
			s += i === 0
				? `<S t="0" d="${d}"${r ? ` r="${r}"` : ""}/>`
				: `<S d="${d}"${r ? ` r="${r}"` : ""}/>`;
			i += r + 1;
		}
		return (
			`<Representation ${attrs.join(" ")}>` +
			`<SegmentTemplate timescale="1000" startNumber="1" ` +
			`initialization="init-${kind}.m4s" media="seg-${kind}-$Number$.m4s">` +
			`<SegmentTimeline>${s}</SegmentTimeline>` +
			`</SegmentTemplate>` +
			`</Representation>`
		);
	}

	// Fallback (no sidx): legacy nominal SegmentTemplate.
	const duration = nominalDurationMs(media, kind);
	return (
		`<Representation ${attrs.join(" ")}>` +
		`<SegmentTemplate timescale="1000" duration="${duration}" startNumber="1" ` +
		`initialization="init-${kind}.m4s" media="seg-${kind}-$Number$.m4s" ` +
		`availabilityTimeOffset="0"/>` +
		`</Representation>`
	);
}

router.get("/sabr/:id/master.mpd", async (req, res) => {
	try {
		const stream = await getSession(req.params.id);
		const session = sessions.get(req.params.id);

		// Slow-network mode: report a low bandwidth_estimate so the server
		// prioritizes fast delivery. The value is re-encoded into
		// client_abr_state on every round-trip, so this takes effect on the
		// next pump without rebuilding the session.
		if (req.query.slow === "1") {
			stream.bandwidthEstimate = SABR_SLOW_NETWORK_BPS;
			console.log(`[sabr] slow network mode for ${req.params.id}: bandwidthEstimate=${SABR_SLOW_NETWORK_BPS}`);
		}

		// Only block on the very first fetch until init segments exist.
		if (!stream.video.ready || !stream.audio.ready) {
			await Promise.race([
				Promise.all([stream.video.onSegment(0), stream.audio.onSegment(0)]),
				new Promise((_, rej) => setTimeout(() => rej(new Error("playback not ready")), 45000)),
			]);
		}

		// Seed the pump at the clip start. SuperMemo clips always open at a known
		// startSec, so making that region the FIRST thing the session fetches
		// means dash.js finds it already buffered when it seeks there. Mirrors
		// googlevideo's `seekTo(options.startTimeMs ?? 0)`. The session instance
		// is keyed by videoId and reused for the later seg-*.m4s fetches, so this
		// nudge persists into the segment-serving phase.
		const startMs = Number(req.query.start ?? 0) * 1000;
		if (Number.isFinite(startMs) && startMs > 0) {
			console.log(`[sabr] seeding pump at clip start: ${Math.round(startMs)}ms`);
			stream.nudge(startMs);
		}

		// Full media duration so the seekbar spans the whole video immediately, not
		// just the buffered window. Prefer the sidx sum so the declared duration
		// agrees with the last <S> in the timeline; fall back to the watch-page
		// format duration, then to whatever we have buffered.
		const timelineTotalMs = Math.max(
			stream.video.segmentTimeline?.reduce((s, e) => s + e.durationMs, 0) ?? 0,
			stream.audio.segmentTimeline?.reduce((s, e) => s + e.durationMs, 0) ?? 0
		);
		const fullDurationMs =
			session?.videoFormat?.approxDurationMs ?? session?.audioFormat?.approxDurationMs;
		const bufferedMs = Math.max(
			stream.video.availableSegments().reduce((s, n) => s + segmentDurationMs(stream.video, n), 0),
			stream.audio.availableSegments().reduce((s, n) => s + segmentDurationMs(stream.audio, n), 0)
		);
		const durMs = timelineTotalMs || fullDurationMs || bufferedMs;

		const mpd =
			`<?xml version="1.0" encoding="utf-8"?>` +
			`<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" ` +
			`profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" minBufferTime="PT2S" ` +
			`mediaPresentationDuration="PT${(durMs / 1000).toFixed(3)}S">` +
			`<Period id="1">` +
			`<AdaptationSet mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">` +
			representationXml(session?.videoFormat, stream.video, "video") +
			`</AdaptationSet>` +
			`<AdaptationSet mimeType="audio/mp4" segmentAlignment="true">` +
			representationXml(session?.audioFormat, stream.audio, "audio") +
			`</AdaptationSet>` +
			`</Period></MPD>`;

		// Populate cache[v_id] so /archiveInfo/:v_id (which only polls cache and
		// does not build anything itself) resolves in SABR mode too — the DASH
		// path does this in its /mpd handler; the SABR path bypasses that route
		// entirely, so without this the poll times out and 404s. videoInfo was
		// built from the watch-page player response with no extra getInfo.
		if (!cache[req.params.id] && session?.videoInfo) {
			try {
				cache[req.params.id] = latestCacheConstructor(
					session.videoInfo,
					mpd, // SABR manifest string as mpd_manifest (unused by /archiveInfo)
					"IE", // browser_target; /archiveInfo reads ytiVidInfo, not this
					yti_version,
				);
				console.log(`[sabr] cached video info for ${req.params.id}`);
			} catch (e) {
				console.error(`[sabr] failed to populate cache for ${req.params.id}`, e);
			}
		}

		res.type("application/dash+xml").send(mpd);
	} catch (e) {
		res.status(503).send(String(e));
	}
});

router.get("/sabr/:id/init-:kind.m4s", async (req, res) => {
	try {
		const kind = req.params.kind === "audio" ? "audio" : "video";
		const stream = await getSession(req.params.id);
		const media = kind === "video" ? stream.video : stream.audio;
		if (!media.ready) await waitForInit(stream, media);
		if (!media.initSegment) return res.status(503).send("no init segment");
		res.type("video/mp4").send(media.initSegment);
	} catch (e) {
		res.status(503).send(String(e));
	}
});

router.get("/sabr/:id/seg-:kind-:n.m4s", async (req, res) => {
	let stream: SabrStream | undefined;
	try {
		const kind = req.params.kind === "audio" ? "audio" : "video";
		const seq = Number(req.params.n);
		stream = await getSession(req.params.id);
		const media = kind === "video" ? stream.video : stream.audio;
		if (!media.ready) await waitForInit(stream, media);
		await waitForSegment(stream, media, seq);
		const seg = media.segments.get(seq);
		if (!seg) return res.status(404).send("segment not found");
		res.type("video/mp4").send(seg.data);
	} catch (e) {
		// Always 503 (retryable): a 410 makes dash.js treat the segment as
		// permanently gone and abandon the representation. Log the distinction
		// (dead = server cut us; slow = pump lagging) but let the player retry,
		// which triggers getSession's reap+rebuild path.
		console.warn(`[sabr] seg ${req.params.kind}-${req.params.n} unavailable (${stream?.dead ? "stream dead" : "slow pump"}): ${String(e)}`);
		res.status(503).send(String(e));
	}
});

/**
 * Live-update the reported bandwidth estimate for a session.
 *
 * client_abr_state (including bandwidth_estimate, field 23) is rebuilt and
 * POSTed on every SABR round-trip, so mutating the field on the live session
 * takes effect on the next pump — no reload or session rebuild needed.
 */
router.get("/sabr/:id/network", (req, res) => {
	const session = sessions.get(req.params.id);
	if (!session) return res.status(404).send("no session");
	const bw = Number(req.query.bw);
	if (Number.isFinite(bw) && bw > 0) {
		session.stream.bandwidthEstimate = bw;
		console.log(`[sabr] bandwidth estimate for ${req.params.id} set to ${bw}`);
	} else {
		session.stream.bandwidthEstimate = SABR_DEFAULT_BANDWIDTH_BPS;
	}
	res.sendStatus(204);
});

/** Smoke test: does the SABR transport accept our token/client and return media? */
router.get("/sabr-test/:id", async (req, res) => {
	try {
		const stream = await getSession(req.params.id);
		// Ensure init segments have arrived (the pump keeps retrying internally).
		try {
			await Promise.race([
				Promise.all([stream.video.onSegment(0), stream.audio.onSegment(0)]),
				new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 40000)),
			]);
		} catch {
			/* report whatever state we reached */
		}
		res.json({
			dead: stream.dead,
			requestNumber: stream.requestNumber,
			videoItag: stream.video.itag,
			audioItag: stream.audio.itag,
			videoReady: stream.video.ready,
			audioReady: stream.audio.ready,
			videoBytes: stream.video.initSegment?.length ?? 0,
			audioBytes: stream.audio.initSegment?.length ?? 0,
			videoSegments: stream.video.availableSegments(),
			audioSegments: stream.audio.availableSegments(),
			videoEndSegment: stream.video.endSegmentNumber,
			audioEndSegment: stream.audio.endSegmentNumber,
			videoTimescale: stream.video.timescale,
			audioTimescale: stream.audio.timescale,
		});
	} catch (e) {
		res.status(500).send(String(e));
	}
});

export default router;
