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
import { SabrStream, SabrMedia, SabrClientInfo, SabrInputFormat } from "../sabr/sabr-stream";
import { getOrCreateSabrInputs, createInnertube, mintContentPoToken, setSabrInputs, sabrInputsFromJson, SabrInputs } from "../utils/localvideo";
import { getWatchPageSabrInputs } from "../sabr/watchpage";

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

async function buildWatchPageStream(videoId: string): Promise<{
	stream: SabrStream;
	videoFormat?: SabrInputFormat;
	audioFormat?: SabrInputFormat;
} | null> {
	const wp = await getWatchPageSabrInputs(videoId);
	if (!wp) return null;
	const innertube = await createInnertube({ withPlayer: true, generateSessionLocally: false });
	const decipheredUrl = (await innertube.session.player!.decipher(wp.sabrUrl)) || wp.sabrUrl;
	console.log(`[sabr] decipher: changed=${decipheredUrl !== wp.sabrUrl} hasN=${/&n=/.test(decipheredUrl)}`);
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
	const IE11_MAX_HEIGHT = Number(process.env.YTJS_SABR_MAX_HEIGHT ?? 1080);
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
	return { stream, videoFormat, audioFormat };
}

/** Build a watch-page session and confirm the first SABR round-trip succeeds. */
async function probeWatchPageStream(videoId: string): Promise<{
	stream: SabrStream;
	videoFormat?: SabrInputFormat;
	audioFormat?: SabrInputFormat;
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
	for (let attempt = 0; attempt < 3 && !stream; attempt++) {
		try {
			const built = await probeWatchPageStream(videoId);
			if (built) {
				stream = built.stream;
				videoFormat = built.videoFormat;
				audioFormat = built.audioFormat;
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
	});
	stream.start();
	return stream;
}

async function waitForInit(stream: SabrStream, media: SabrMedia, timeoutMs = 45000) {
	stream.nudge();
	await Promise.race([
		media.onSegment(0),
		new Promise((_, rej) => setTimeout(() => rej(new Error("init segment timeout")), timeoutMs)),
	]);
}

async function waitForSegment(stream: SabrStream, media: SabrMedia, seq: number, timeoutMs = 45000) {
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
		const segStart = (seq - 1) * nominalDurationMs(media, kind);
		if (process.env.BG_CENSUS === "1") {
			const prev = media.segments.get(seq - 1);
			console.log(
				`[sabr] seg-${seq} nudge t=${Math.round(segStart)} bufferedEnd=${media.bufferedEndMs()} ` +
				`prevStart=${prev?.startMs} prevDur=${prev?.durationMs} nominal=${nominalDurationMs(media, kind)}`
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
 * Nominal per-segment duration used in the SegmentTemplate. SABR `duration_ms`
 * values are not always uniform (the first few segments can differ), so we use
 * the mean of what we've seen and clamp it to a sane range. This only drives
 * the $Number$ -> presentation-time mapping for seeking; dash.js places decoded
 * fragments by their own moof timestamps, so mild drift doesn't break playback.
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
 * Uses a STATIC SegmentTemplate with a nominal `duration` (no SegmentTimeline).
 * dash.js computes every $Number$ segment URL from `duration` up to the
 * declared mediaPresentationDuration, so it fetches segments on demand as the
 * player advances — which is what SABR needs. A static SegmentList only
 * declares the segments we already hold, so dash.js stops after that window;
 * and a dynamic SegmentTimeline anchors playback to wall-clock "now", which
 * finds no segments in the media-ordered SABR window. Both were tested; only
 * this shape plays.
 *  - startNumber="1": $Number$=1 -> seg-<kind>-1.m4s (SABR seq is 1-based).
 *  - availabilityTimeOffset="0": dash.js copies ATO verbatim (no defaulting).
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

		// Full media duration (from the watch-page format) so the seekbar spans
		// the whole video immediately, not just the buffered window.
		const fullDurationMs =
			session?.videoFormat?.approxDurationMs ?? session?.audioFormat?.approxDurationMs;
		const bufferedMs = Math.max(
			stream.video.availableSegments().reduce((s, n) => s + segmentDurationMs(stream.video, n), 0),
			stream.audio.availableSegments().reduce((s, n) => s + segmentDurationMs(stream.audio, n), 0)
		);
		const durMs = fullDurationMs ?? bufferedMs;

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
