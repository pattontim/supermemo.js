/*
 * Capture a real browser SABR bundle from a live YouTube watch page, then
 * destroy the page immediately (deterministic teardown).
 *
 * Usage:
 *   node capture-sabr-bundle.mjs <videoId> [outFile] [--cdp http://localhost:9222]
 *
 * Output bundle (JSON) matches POST /sabr-inject/:id on the ytjs server:
 *   { videoId, sabrUrl, ustreamerConfig, poToken, formats, clientName,
 *     clientVersion, osName, osVersion, acceptLanguage, acceptRegion,
 *     headers, cpn, visitorData, cookies, ytcfg, ytAtN, playerResponse,
 *     generateIT: { request, response }, capturedAt }
 *
 * What it grabs (all from ONE page load — identity-bound together):
 *   1. cookies for .youtube.com/.google.com
 *   2. ytcfg.get() dump (INNERTUBE_CONTEXT, EVENT_ID, visitorData, clientVersion)
 *   3. window.ytAtN initial attestation data (bgChallenge program/globalName)
 *   4. ytInitialPlayerResponse (serverAbrStreamingUrl, ustreamerConfig, adaptiveFormats)
 *   5. the browser-minted poToken — from the /player POST body
 *      (serviceIntegrityDimensions.poToken) or the SABR POST StreamerContext
 *   6. the actual SABR POST: full URL (already n-deciphered), headers, raw body
 *   7. the GenerateIT exchange (jnn-pa.googleapis.com) for offline diffing
 *
 * After capture the page is closed and (if we launched the browser) the browser
 * is killed. Nothing stays alive.
 */

import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const videoId = args.find((a) => !a.startsWith("--"));
const outIdx = args.findIndex((a) => a === "-o");
const outFile = outIdx >= 0 ? args[outIdx + 1] : `/tmp/sabr-bundle-${videoId}.json`;
const cdpIdx = args.findIndex((a) => a === "--cdp");
const cdpUrl = cdpIdx >= 0 ? args[cdpIdx + 1] : process.env.YTJS_CDP_URL;

if (!videoId) {
	console.error("usage: node capture-sabr-bundle.mjs <videoId> [-o out.json] [--cdp http://localhost:9222]");
	process.exit(1);
}

const WATCH_URL = `https://www.youtube.com/watch?v=${videoId}&bpctr=9999999999&has_verified=1`;

const captured = {
	videoId,
	capturedAt: new Date().toISOString(),
	cookies: null,
	ytcfg: null,
	ytAtN: null,
	playerResponse: null,
	sabrRequest: null,      // { url, headers, bodyB64 }
	playerRequest: null,    // { url, bodyJson } — /player POST with poToken
	generateIT: null,       // { url, requestB64, responseText }
	ua: null,
};

// --- network interception -------------------------------------------------

function recordSabrRequest(url, headers, body) {
	if (captured.sabrRequest) return; // first SABR POST is the interesting one
	captured.sabrRequest = {
		url,
		headers,
		bodyB64: body ? Buffer.from(body).toString("base64") : null,
	};
	console.log(`[capture] SABR POST recorded: ${url.slice(0, 120)}... body=${body?.length ?? 0}b`);
}

function recordPlayerRequest(url, body) {
	try {
		const json = JSON.parse(body);
		const poToken = json?.serviceIntegrityDimensions?.poToken;
		if (poToken) {
			captured.playerRequest = { url, bodyJson: json };
			console.log(`[capture] /player POST with poToken (${poToken.length} chars) recorded`);
		}
	} catch { /* not JSON or no token */ }
}

function recordGenerateIT(url, body) {
	captured.generateIT = { url, requestB64: Buffer.from(body).toString("base64") };
	console.log("[capture] GenerateIT request recorded");
}

// --- main ------------------------------------------------------------------

let browser, context, page;
let browserWasLaunched = false;

async function main() {
	if (cdpUrl) {
		console.log(`[capture] connecting over CDP to ${cdpUrl}`);
		browser = await chromium.connectOverCDP(cdpUrl);
		context = browser.contexts()[0] ?? (await browser.newContext());
	} else {
		console.log("[capture] launching bundled Chromium");
		browser = await chromium.launch({ headless: false });
		browserWasLaunched = true;
		context = await browser.newContext({
			viewport: { width: 1920, height: 1080 },
			userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
			locale: "en-US",
		});
	}

	page = await context.newPage();

	page.on("request", (req) => {
		const url = req.url();
		const method = req.method();
		if (method !== "POST") return;
		const body = req.postDataBuffer();
		if (/googlevideo\.com.*videoplayback/.test(url) || /serverAbrStreamingUrl|sabr=1/.test(url)) {
			recordSabrRequest(url, req.headers(), body);
		} else if (/youtubei\/v1\/player/.test(url)) {
			recordPlayerRequest(url, req.postData() ?? "");
		} else if (/jnn-pa\.googleapis\.com.*GenerateIT/.test(url)) {
			recordGenerateIT(url, body ?? Buffer.alloc(0));
		}
	});
	// GenerateIT response body (request bodies are visible above; responses need a listener)
	page.on("response", async (res) => {
		if (/jnn-pa\.googleapis\.com.*GenerateIT/.test(res.url()) && captured.generateIT) {
			try { captured.generateIT.responseText = await res.text(); } catch { /* ignore */ }
		}
	});

	console.log(`[capture] navigating to ${WATCH_URL}`);
	await page.goto(WATCH_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

	// Dismiss consent if it appears (EU IPs)
	try {
		const consent = page.locator('button[aria-label*="Accept"], button:has-text("Accept all")');
		if (await consent.first().isVisible({ timeout: 3000 })) {
			await consent.first().click();
			console.log("[capture] consent dismissed");
			await page.waitForLoadState("domcontentloaded");
		}
	} catch { /* no consent wall */ }

	// Start playback so the player mints the token and fires the SABR POST.
	try {
		await page.locator("video").first().click({ timeout: 10000 });
	} catch { /* autoplay may kick in on its own */ }

	// Wait for the SABR POST (the decisive artifact), up to 45s.
	const deadline = Date.now() + 45000;
	while (!captured.sabrRequest && Date.now() < deadline) {
		await page.waitForTimeout(500);
	}
	if (!captured.sabrRequest) {
		console.warn("[capture] WARNING: no SABR POST observed within 45s — bundle will be partial");
	}

	// Scrape page state (before teardown).
	captured.ua = await page.evaluate(() => navigator.userAgent);
	try {
		captured.ytcfg = await page.evaluate(() => (window.ytcfg ? window.ytcfg.get() : null));
	} catch (e) { console.warn("[capture] ytcfg scrape failed", e); }
	try {
		captured.ytAtN = await page.evaluate(() => {
			// ytAtN is a function; the attestation data was its first-call argument.
			// Fallback: re-parse from page source like FreeTube does.
			const m = document.documentElement.innerHTML.match(/window\.ytAtN\(\s*(\{[\s\S]*?\})\s*\)/);
			return m ? JSON.parse(m[1].replace(/;\s*$/, "")) : null;
		});
	} catch (e) { console.warn("[capture] ytAtN scrape failed", e); }
	try {
		captured.playerResponse = await page.evaluate(() => window.ytInitialPlayerResponse ?? null);
	} catch (e) { console.warn("[capture] playerResponse scrape failed", e); }
	captured.cookies = await context.cookies("https://www.youtube.com", "https://google.com");

	// --- derive the bundle fields from what we captured ---------------------
	const pr = captured.playerResponse;
	const sd = pr?.streamingData ?? pr?.streaming_data;
	const sabrUrlFromPr = sd?.serverAbrStreamingUrl ?? sd?.server_abr_streaming_url;
	const ustreamerB64 =
		pr?.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig ??
		pr?.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;

	// Prefer the URL the browser actually POSTed to (already n-deciphered).
	const sabrUrl = captured.sabrRequest?.url ?? sabrUrlFromPr;

	// poToken: /player POST body first, else null (SABR body decode is server-side work).
	const poToken =
		captured.playerRequest?.bodyJson?.serviceIntegrityDimensions?.poToken ?? null;

	const client = captured.ytcfg?.INNERTUBE_CONTEXT?.client ?? {};
	const formats = (sd?.adaptiveFormats ?? sd?.adaptive_formats ?? []).map((f) => {
		const mt = f.mimeType ?? f.mime_type ?? "";
		return {
			itag: f.itag,
			xtags: f.xtags,
			mimeType: mt,
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

	// Cookie header string from the captured cookies.
	const cookieHeader = (captured.cookies ?? [])
		.map((c) => `${c.name}=${c.value}`)
		.join("; ");

	const bundle = {
		videoId,
		sabrUrl,
		ustreamerConfig: ustreamerB64 ?? null,
		poToken,
		formats,
		clientName: 1, // WEB
		clientVersion: client.clientVersion ?? captured.ytcfg?.INNERTUBE_CLIENT_VERSION ?? null,
		osName: client.osName ?? "",
		osVersion: client.osVersion ?? "",
		acceptLanguage: client.hl ? "en-US" : "en-US",
		acceptRegion: client.gl ?? "US",
		visitorData: client.visitorData ?? captured.ytcfg?.VISITOR_DATA ?? null,
		cpn: captured.sabrRequest ? new URL(captured.sabrRequest.url).searchParams.get("cpn") : null,
		headers: {
			cookie: cookieHeader,
			"user-agent": captured.ua,
			// Everything else (sec-ch-ua*, sec-fetch-*) comes from the captured
			// SABR request headers verbatim:
			...(captured.sabrRequest
				? Object.fromEntries(
					Object.entries(captured.sabrRequest.headers)
						.filter(([k]) => k.startsWith("sec-") || k === "origin" || k === "referer" || k === "accept-language" || k === "priority")
						.map(([k, v]) => [k, v]),
				)
				: {}),
		},
		// Raw artifacts for offline diffing (not consumed by /sabr-inject).
		cookies: captured.cookies,
		ytcfg: captured.ytcfg,
		ytAtN: captured.ytAtN,
		playerResponse: pr,
		sabrRequest: captured.sabrRequest,
		playerRequest: captured.playerRequest,
		generateIT: captured.generateIT,
		capturedAt: captured.capturedAt,
	};

	writeFileSync(outFile, JSON.stringify(bundle, null, 2));
	console.log(`[capture] bundle written to ${outFile}`);
	console.log(`[capture]   sabrUrl=${sabrUrl ? "yes" : "NO"} ustreamer=${ustreamerB64 ? "yes" : "NO"} poToken=${poToken ? "yes" : "NO"} formats=${formats.length} cookies=${(captured.cookies ?? []).length}`);
}

// --- deterministic teardown -------------------------------------------------

try {
	await main();
} catch (e) {
	console.error("[capture] FAILED", e);
	writeFileSync(outFile, JSON.stringify({ videoId, error: String(e), partial: captured }, null, 2));
	process.exitCode = 1;
} finally {
	// Destroy the page immediately and deterministically — the bundle is
	// visitor/time-bound and the captured session must not linger.
	try { if (page) await page.close({ runBeforeUnload: false }); } catch { /* ignore */ }
	try { if (browserWasLaunched && browser) await browser.close(); } catch { /* ignore */ }
	try { if (!browserWasLaunched && browser) await browser.close(); } catch { /* ignore */ }
	console.log("[capture] page destroyed, browser detached");
}
