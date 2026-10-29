/*
 * Niconico Douga streaming routes.
 *
 *   GET /nnd/:id/watch                  metadata for the in-app NND tool
 *   GET /nnd/:id/:quality.m3u8          media playlist, URIs rewritten to /nnd/proxy/
 *   GET /nnd/proxy/?id=<id>&url=<url>   segment / AES key / init map proxy
 *
 * The proxy exists because asset.domand.nicovideo.jp and
 * delivery.domand.nicovideo.jp send no CORS headers, so a page (and IE11's
 * MSE in particular) cannot fetch them directly. Everything else about NND is
 * plain server-side HTTP — no bot protection, no browser, no PO token.
 */

import { Router } from "express";
import { Readable } from "stream";
import {
	fetchWatchData,
	requestHlsStream,
	streamHeaders,
	resolveVideoQuality,
	isNndId,
	NndError,
	NndWatchData,
} from "../utils/niconico";
import { isMasterPlaylist, parseMasterPlaylist, rewritePlaylist } from "../utils/m3u8";
import { fullUrlForClient, useOnline } from "../server";

const router = Router();

export interface NndSession {
	watch: NndWatchData;
	domandBid: string;
	fetchedAt: number;
	/** Last contentUrl per quality, so the proxy can be reached without state races. */
	contentUrls: { [quality: string]: string };
}

const sessions = new Map<string, NndSession>();

/** Watch data goes stale when the access-right key rotates; refetch after 30 min. */
const SESSION_TTL_MS = 30 * 60 * 1000;

/** Exported so /archiveInfo (test.route.ts) reuses the same 30-min watch cache. */
export async function getSession(id: string, forceRefresh = false): Promise<NndSession> {
	const cached = sessions.get(id);
	if (!forceRefresh && cached && Date.now() - cached.fetchedAt < SESSION_TTL_MS) {
		return cached;
	}
	const watch = await fetchWatchData(id);
	const session: NndSession = {
		watch,
		domandBid: cached ? cached.domandBid : "",
		fetchedAt: Date.now(),
		contentUrls: {},
	};
	sessions.set(id, session);
	return session;
}

function statusFor(e: unknown): number {
	if (e instanceof NndError) {
		if (e.kind === "http") return e.status >= 400 && e.status < 500 ? e.status : 503;
		// login / paid / geo / gone: the video will not play until the
		// underlying condition changes, so 4xx rather than a retryable 5xx.
		return 403;
	}
	return 503;
}

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Metadata (used by the in-player NND tool to preview before converting)
// ---------------------------------------------------------------------------

router.get("/nnd/:id/watch", async (req, res) => {
	const id = req.params.id;
	if (!isNndId(id)) return res.status(400).send("not an NND id");
	try {
		const session = await getSession(id);
		const w = session.watch;
		res.json({
			id,
			title: w.video.title,
			duration: w.video.duration,
			thumbnail: w.video.thumbnail ? w.video.thumbnail.ogp : undefined,
			viewCount: w.video.count ? w.video.count.view : undefined,
			qualities: (w.media.domand.videos || [])
				.filter((v) => v.isAvailable)
				.map((v) => v.id),
		});
	} catch (e) {
		res.status(statusFor(e)).send(errorText(e));
	}
});

// ---------------------------------------------------------------------------
// Playlist: /nnd/sm45831835/video-h264-720p.m3u8
// ---------------------------------------------------------------------------

router.get("/nnd/:id/:quality.m3u8", async (req, res) => {
	if (!useOnline) return res.status(503).send("offline mode");

	const id = req.params.id;
	const quality = req.params.quality;
	if (!isNndId(id)) return res.status(400).send("not an NND id");

	const proxyBase = `http://${fullUrlForClient}/nnd/proxy/`;
	const started = Date.now();

	// One retry with fresh watch data covers the expired access-right key.
	for (let attempt = 0; attempt < 2; attempt++) {
		let session: NndSession | undefined;
		try {
			session = await getSession(id, attempt > 0);

			const resolved = resolveVideoQuality(session.watch, quality);
			if (!resolved) return res.status(404).send(`quality ${quality} not available`);

			const hls = await requestHlsStream(id, session.watch, resolved.id);
			if (hls.domandBid) session.domandBid = hls.domandBid;
			session.contentUrls[resolved.id] = hls.contentUrl;

			const playlistText = await fetchText(hls.contentUrl, session.domandBid);

			console.log(
				`[nnd] ${id} ${resolved.id} playlist ok in ${Date.now() - started}ms` +
					(isMasterPlaylist(playlistText) ? " (master)" : " (media)")
			);

			// The domand master carries audio as a separate EXT-X-MEDIA
			// rendition, so it MUST be served as a master — the variant and
			// rendition URIs are rewritten to /nnd/proxy/, which re-rewrites
			// whatever playlist comes back. Both are handled identically here.
			res.set("Cache-Control", "no-store");
			return res
				.type("application/vnd.apple.mpegurl")
				.send(rewritePlaylist(playlistText, proxyBase, id, hls.contentUrl));
		} catch (e) {
			// A 4xx on the access-rights POST / playlist fetch (observed: 400
			// and 403) means the accessRightKey rotated or expired: drop the
			// session and refetch watch data once. A genuinely unavailable
			// quality never reaches here (resolveVideoQuality 404s early).
			if (
				e instanceof NndError &&
				e.kind === "http" &&
				e.status >= 400 &&
				e.status < 500 &&
				attempt === 0
			) {
				console.warn(`[nnd] ${id} access-rights ${e.status}, refreshing watch data`);
				if (session) sessions.delete(id);
				continue;
			}
			console.warn(`[nnd] ${id} ${quality} failed: ${errorText(e)}`);
			return res.status(statusFor(e)).send(errorText(e));
		}
	}

	return res.status(503).send("nnd playlist unavailable");
});

async function fetchText(url: string, cookie: string): Promise<string> {
	const res = await fetch(url, { headers: streamHeaders(cookie) });
	if (res.status >= 400) {
		throw new NndError("http", `playlist ${res.status}`, res.status);
	}
	return await res.text();
}

// ---------------------------------------------------------------------------
// Segment / key / init-map proxy
// ---------------------------------------------------------------------------

router.get("/nnd/proxy/", async (req, res) => {
	const url = req.query.url as string | undefined;
	const id = req.query.id as string | undefined;

	if (!url || url.indexOf("://") === -1) {
		return res.status(400).send("bad or missing url");
	}

	// Only DOMAND hosts. Signed CloudFront query params travel inside ?url=
	// untouched, so no signature rebuilding is needed.
	let host = "";
	try {
		host = new URL(url).hostname;
	} catch (e) {
		return res.status(400).send("unparseable url");
	}
	if (!/(^|\.)nicovideo\.jp$/.test(host)) {
		return res.status(400).send("host not allowed");
	}

	const session = id ? sessions.get(id) : undefined;
	const headers = streamHeaders(session ? session.domandBid : "");
	if (req.headers.range) headers["Range"] = req.headers.range;

	let upstream: Response;
	try {
		upstream = await fetch(url, { headers });
	} catch (e) {
		return res.status(502).send(errorText(e));
	}

	// Nested playlist (master variant or audio rendition): rewrite its own
	// URIs through this same proxy and return it as a playlist. Detected by
	// the upstream content type as well as the URL, since the signed URL does
	// not always carry a .m3u8 extension.
	const upstreamType = upstream.headers.get("content-type") || "";
	const looksLikePlaylist =
		upstreamType.indexOf("mpegurl") !== -1 ||
		url.split("?")[0].toLowerCase().indexOf(".m3u8") !== -1;

	if (looksLikePlaylist) {
		const text = await upstream.text();
		if (upstream.status >= 400) return res.status(upstream.status).send(text);
		res.set("Cache-Control", "no-store");
		return res
			.type("application/vnd.apple.mpegurl")
			.send(rewritePlaylist(text, `http://${fullUrlForClient}/nnd/proxy/`, id, url));
	}

	res.status(upstream.status);
	const passthrough = [
		"content-type",
		"content-length",
		"content-range",
		"accept-ranges",
		"etag",
		"last-modified",
	];
	for (let i = 0; i < passthrough.length; i++) {
		const v = upstream.headers.get(passthrough[i]);
		if (v) res.set(passthrough[i], v);
	}

	if (!upstream.body) return res.end();

	// undici gives a WHATWG ReadableStream; convert for Express.
	try {
		const nodeStream = Readable.fromWeb(upstream.body as any);
		nodeStream.on("error", function (err) {
			console.warn(`[nnd:proxy] stream error: ${errorText(err)}`);
			res.end();
		});
		nodeStream.pipe(res);
	} catch (e) {
		// Fallback for older runtimes: buffer and send.
		const buf = Buffer.from(await upstream.arrayBuffer());
		res.send(buf);
	}
});

export default router;
