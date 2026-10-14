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
import { getOrCreateSabrInputs, createInnertube } from "../utils/localvideo";
import { getWatchPageSabrInputs } from "../sabr/watchpage";

const router = Router();

/** WEB ClientInfo — the watch page is a WEB-client render. */
const WEB_CLIENT = {
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
			Buffer.alloc(0), // empty token: isolate the URL/session variable
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
	const pickVideo = wp.formats.find((f) => !f.isAudio && /avc1/.test(f.mimeType));
	const pickAudio = wp.formats.find((f) => f.isAudio && /mp4a/.test(f.mimeType));
	const videoFormat = pickVideo ?? wp.formats.find((f) => !f.isAudio);
	const audioFormat = pickAudio ?? wp.formats.find((f) => f.isAudio);
	const ordered = [videoFormat, audioFormat].filter(Boolean) as SabrInputFormat[];

	// Empty token: StreamProtectionStatus 2 accepts it for the initial window and
	// the watch-page session is otherwise self-sufficient.
	const stream = new SabrStream(
		decipheredUrl,
		wp.ustreamerConfig,
		ordered,
		Buffer.alloc(0),
		videoId,
		WEB_CLIENT as SabrClientInfo,
	);
	console.log(
		`[sabr] session via watchpage for ${videoId}: video=${videoFormat?.itag} ` +
		`(${videoFormat?.codecs}) audio=${audioFormat?.itag} (${audioFormat?.codecs})`
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
	if (seq > 0) stream.nudge();
	await Promise.race([
		media.onSegment(seq),
		new Promise((_, rej) => setTimeout(() => rej(new Error("segment timeout")), timeoutMs)),
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
	const segs = media.availableSegments();
	const body = segs
		.map((s) => `<SegmentURL media="seg-${kind}-${s}.m4s"/>`)
		.join("");
	// SegmentList without a SegmentTimeline gives dash.js no duration
	// information, so it won't build a timeline or request media segments.
	// Emit a SegmentTimeline (timescale=1000, ms) built from the SABR
	// MediaHeader durations.
	const timeline =
		`<SegmentTimeline>` +
		segs
			.map((s) => `<S d="${Math.round(segmentDurationMs(media, s))}"/>`)
			.join("") +
		`</SegmentTimeline>`;
	return (
		`<Representation ${attrs.join(" ")}>` +
		`<SegmentList timescale="1000">` +
		`<Initialization sourceURL="init-${kind}.m4s"/>` +
		timeline +
		body +
		`</SegmentList>` +
		`</Representation>`
	);
}

router.get("/sabr/:id/master.mpd", async (req, res) => {
	try {
		const stream = await getSession(req.params.id);
		const session = sessions.get(req.params.id);
		// Wait for both init segments so the manifest is valid on first fetch.
		await Promise.race([
			Promise.all([stream.video.onSegment(0), stream.audio.onSegment(0)]),
			new Promise((_, rej) => setTimeout(() => rej(new Error("playback not ready")), 45000)),
		]);

		const durMs = Math.max(
			stream.video.availableSegments().reduce((s, n) => s + segmentDurationMs(stream.video, n), 0),
			stream.audio.availableSegments().reduce((s, n) => s + segmentDurationMs(stream.audio, n), 0)
		);

		const mpd =
			`<?xml version="1.0" encoding="utf-8"?>` +
			`<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" ` +
			`mediaPresentationDuration="PT${(durMs / 1000).toFixed(3)}S" minBufferTime="PT2S" ` +
			`profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">` +
			`<Period>` +
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
	try {
		const kind = req.params.kind === "audio" ? "audio" : "video";
		const seq = Number(req.params.n);
		const stream = await getSession(req.params.id);
		const media = kind === "video" ? stream.video : stream.audio;
		if (!media.ready) await waitForInit(stream, media);
		await waitForSegment(stream, media, seq);
		const seg = media.segments.get(seq);
		if (!seg) return res.status(404).send("segment not found");
		res.type("video/mp4").send(seg.data);
	} catch (e) {
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
