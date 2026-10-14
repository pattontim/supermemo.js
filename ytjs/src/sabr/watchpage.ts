/*
 * Watch-page session sourcing.
 *
 * The SABR rejection we hit with the API `/player` path is session-bound (a real
 * Chromium on the same machine/IP streams fine with a byte-matched request).
 * This module bypasses `/player` entirely and sources the SABR inputs from the
 * watch page's embedded `ytInitialPlayerResponse`, which is minted server-side
 * as part of a real page render — FreeTube's preferred path.
 *
 * Node-only (fetch); no browser required to *test* whether URL origin was the
 * gate. If the page-embedded URL still refuses, the next step is a Chromium
 * sidecar (page-minted token), but that is a separate, decisive experiment.
 */

import { SabrInputFormat } from "./sabr-stream";

export interface WatchPageSabrInputs {
	sabrUrl: string;
	ustreamerConfig: Buffer;
	formats: SabrInputFormat[];
	videoId: string;
	debug: {
		hasPlayerResponse: boolean;
		hasSabrUrl: boolean;
		hasUstreamerConfig: boolean;
		formatCount: number;
		htmlLength: number;
		consentRedirect: boolean;
		finalUrl: string;
	};
}

const UA =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

/** Balanced-brace JSON extractor for when the lazy regex truncates on nested `};`. */
function parseBalancedJson(html: string, startIdx: number): any | null {
	const open = html.indexOf("{", startIdx);
	if (open < 0) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = open; i < html.length; i++) {
		const c = html[i];
		if (esc) { esc = false; continue; }
		if (c === "\\") { esc = true; continue; }
		if (c === '"') { inStr = !inStr; continue; }
		if (inStr) continue;
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) {
				try { return JSON.parse(html.slice(open, i + 1)); } catch { return null; }
			}
		}
	}
	return null;
}

export async function getWatchPageSabrInputs(
	videoId: string
): Promise<WatchPageSabrInputs | null> {
	const url = `https://www.youtube.com/watch?v=${videoId}&bpctr=9999999999&has_verified=1`;
	// NOTE: sending the session visitor (as X-Goog-Visitor-Id or a
	// VISITOR_INFO1_LIVE cookie) makes YouTube return a SABR URL the server
	// rejects with sabr.malformed_config (X-Goog-Visitor-Id) or has no effect on
	// the status-3 stall (cookie). The anonymous watch-page fetch yields a URL
	// that streams fine, and the SABR URL's visitor does NOT need to match the
	// PO token's visitor — only the token's own mint/refresh consistency matters
	// (see mintContentPoToken's shared session).
	const resp = await fetch(url, {
		headers: {
			"User-Agent": UA,
			"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.9",
			"Sec-Fetch-Dest": "document",
			"Sec-Fetch-Mode": "navigate",
			"Sec-Fetch-Site": "none",
			"Sec-Fetch-User": "?1",
			"Upgrade-Insecure-Requests": "1",
		},
		redirect: "follow",
	});
	const html = await resp.text();
	const finalUrl = (resp as any).url ?? url;
	const consentRedirect = /consent\.(youtube|google)\.com/.test(finalUrl);

	const debug: WatchPageSabrInputs["debug"] = {
		hasPlayerResponse: false,
		hasSabrUrl: false,
		hasUstreamerConfig: false,
		formatCount: 0,
		htmlLength: html.length,
		consentRedirect,
		finalUrl,
	};

	let pr: any = null;
	const idx = html.indexOf("ytInitialPlayerResponse");
	if (idx >= 0) {
		// Try the lazy regex first (matches FreeTube), then a balanced scan.
		const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/);
		if (m) {
			try { pr = JSON.parse(m[1]); } catch { /* fall through */ }
		}
		if (!pr) pr = parseBalancedJson(html, idx);
	}
	debug.hasPlayerResponse = !!pr;
	if (!pr) {
		console.log(
			`[sabr] watchpage: no ytInitialPlayerResponse (html=${html.length} consent=${consentRedirect} final=${finalUrl})`
		);
		return null;
	}

	const sd = pr.streamingData ?? pr.streaming_data;
	const sabrUrl: string | undefined = sd?.serverAbrStreamingUrl ?? sd?.server_abr_streaming_url;
	const ustreamerB64: string | undefined =
		pr?.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig ??
		pr?.player_config?.media_common_config?.media_ustreamer_request_config
			?.video_playback_ustreamer_config;
	const rawFormats: any[] = sd?.adaptiveFormats ?? sd?.adaptive_formats ?? [];

	debug.hasSabrUrl = !!sabrUrl;
	debug.hasUstreamerConfig = !!ustreamerB64;
	debug.formatCount = rawFormats.length;

	if (!sabrUrl || !ustreamerB64) {
		console.log("[sabr] watchpage: extracted response lacks SABR fields", debug);
		return null;
	}

	const formats: SabrInputFormat[] = rawFormats
		.filter((f) => {
			const mt: string = f.mimeType ?? f.mime_type ?? "";
			// match TubeReplacer's filter: skip VP9 / AV1 / Opus
			return !mt.includes("vp9") && !mt.includes("av01") && !mt.includes("opus");
		})
		.map((f) => {
			const mt: string = f.mimeType ?? f.mime_type ?? "";
			return {
				itag: f.itag,
				xtags: f.xtags,
				mimeType: mt,
				// watch-page JSON lastModified is already epoch-seconds as a string
				lastModified: String(f.lastModified ?? f.last_modified ?? "0"),
				isAudio: mt.startsWith("audio"),
				codecs: (mt.match(/codecs="([^"]+)"/) ?? [])[1],
				width: f.width,
				height: f.height,
				bandwidth: f.bitrate ?? f.averageBitrate,
				audioSampleRate: f.audioSampleRate ? Number(f.audioSampleRate) : undefined,
				approxDurationMs: f.approxDurationMs ? Number(f.approxDurationMs) : undefined,
			};
		});

	console.log(
		`[sabr] watchpage OK for ${videoId}: sabrUrl=${sabrUrl.length}b ` +
		`ustreamerConfig=${ustreamerB64.length}b formats=${formats.length}/${rawFormats.length}`
	);

	return {
		sabrUrl, // verbatim — embedded responses are pre-signed
		ustreamerConfig: Buffer.from(
			ustreamerB64.replace(/-/g, "+").replace(/_/g, "/"),
			"base64"
		),
		formats,
		videoId,
		debug,
	};
}
