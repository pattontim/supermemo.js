/*
 * Browser-side BotGuard census (diagnostic only).
 *
 * Loads a real YouTube watch page in Chromium, lets YouTube's own BotGuard run,
 * and captures the same fingerprint probe + GenerateIT payload that the JSDOM
 * side logs — so the two can be diffed field by field.
 *
 * Usage (from ytjs/):
 *   node helpers/bg-browser-census.mjs <videoId> [--headful] [--out /tmp/bg-browser.json]
 *
 * Requires Playwright. If it isn't installed:
 *   pnpm add -D playwright && pnpm exec playwright install chromium
 * Or point at an existing Chromium:
 *   CHROME_PATH=/home/deck/.nix-profile/bin/chromium node helpers/bg-browser-census.mjs <id>
 *
 * Output: JSON at --out (default /tmp/bg-browser.json) with:
 *   { probe, generateIT: { request, response }, interpreter: {...}, ytcfg: {...} }
 */

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const videoId = args.find((a) => !a.startsWith("--"));
const headful = args.includes("--headful");
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? args[outIdx + 1] : "/tmp/bg-browser.json";

if (!videoId) {
	console.error("usage: node helpers/bg-browser-census.mjs <videoId> [--headful] [--out path]");
	process.exit(1);
}

const sha16 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// The probe is duplicated here (not imported) so this file stays runnable
// without a build step. Keep it in sync with src/utils/bgCensus.ts.
const probe = () => {
	const g = globalThis;
	const out = {};
	const t = (k, fn) => { try { out[k] = fn(); } catch (e) { out[k] = "<throw: " + String(e).slice(0, 80) + ">"; } };
	const nav = g.navigator ?? {};
	t("nav_ua", () => nav.userAgent);
	t("nav_appVersion", () => nav.appVersion);
	t("nav_platform", () => nav.platform);
	t("nav_vendor", () => nav.vendor);
	t("nav_language", () => nav.language);
	t("nav_languages", () => nav.languages);
	t("nav_hardwareConcurrency", () => nav.hardwareConcurrency);
	t("nav_deviceMemory", () => nav.deviceMemory);
	t("nav_maxTouchPoints", () => nav.maxTouchPoints);
	t("nav_webdriver", () => nav.webdriver);
	t("nav_cookieEnabled", () => nav.cookieEnabled);
	t("nav_onLine", () => nav.onLine);
	t("nav_doNotTrack", () => nav.doNotTrack);
	t("nav_pdfViewerEnabled", () => nav.pdfViewerEnabled);
	t("nav_plugins_len", () => nav.plugins?.length);
	t("nav_plugins_item0", () => nav.plugins?.item?.(0)?.name ?? null);
	t("nav_plugins_namedItem_pdf", () => nav.plugins?.namedItem?.("PDF Viewer")?.name ?? null);
	t("nav_mimeTypes_len", () => nav.mimeTypes?.length);
	t("nav_mimeTypes_item0", () => nav.mimeTypes?.item?.(0)?.type ?? null);
	t("nav_uadata_brands", () => nav.userAgentData?.brands);
	t("nav_uadata_mobile", () => nav.userAgentData?.mobile);
	t("nav_uadata_platform", () => nav.userAgentData?.platform);
	t("nav_uadata_has_hev", () => typeof nav.userAgentData?.getHighEntropyValues);
	t("nav_connection", () => nav.connection ? { effectiveType: nav.connection.effectiveType, rtt: nav.connection.rtt, downlink: nav.connection.downlink, saveData: nav.connection.saveData } : null);
	t("nav_tostring", () => Object.prototype.toString.call(nav));
	t("nav_proto_ctor", () => Object.getPrototypeOf(nav)?.constructor?.name ?? null);
	t("nav_ownKeys_len", () => Object.keys(nav).length);
	t("nav_ua_is_prototype_getter", () => !!Object.getOwnPropertyDescriptor(Object.getPrototypeOf(nav) ?? {}, "userAgent")?.get);
	const scr = g.screen ?? {};
	t("screen_dims", () => [scr.width, scr.height, scr.availWidth, scr.availHeight, scr.colorDepth, scr.pixelDepth]);
	t("screen_orientation", () => scr.orientation ? { type: scr.orientation.type, angle: scr.orientation.angle } : null);
	t("screen_tostring", () => Object.prototype.toString.call(scr));
	t("dpr", () => g.devicePixelRatio);
	t("inner", () => [g.innerWidth, g.innerHeight]);
	t("outer", () => [g.outerWidth, g.outerHeight]);
	t("visualViewport", () => g.visualViewport ? { width: g.visualViewport.width, height: g.visualViewport.height, scale: g.visualViewport.scale } : null);
	const perf = g.performance ?? {};
	t("perf_timeOrigin", () => perf.timeOrigin);
	t("perf_now", () => perf.now());
	t("perf_now_minus_timeOrigin", () => perf.now() - perf.timeOrigin);
	t("perf_memory", () => perf.memory ? { jsHeapSizeLimit: perf.memory.jsHeapSizeLimit, totalJSHeapSize: perf.memory.totalJSHeapSize, usedJSHeapSize: perf.memory.usedJSHeapSize } : null);
	t("perf_nav_entries", () => perf.getEntriesByType?.("navigation")?.length);
	t("perf_resource_entries", () => perf.getEntriesByType?.("resource")?.length);
	t("perf_tostring", () => Object.prototype.toString.call(perf));
	const loc = g.location ?? {};
	t("loc_href", () => loc.href);
	t("loc_origin", () => loc.origin);
	t("loc_search", () => loc.search);
	t("loc_tostring", () => Object.prototype.toString.call(loc));
	t("loc_instanceof_Location", () => g.Location ? loc instanceof g.Location : "<no Location>");
	t("loc_ancestorOrigins", () => loc.ancestorOrigins?.length ?? null);
	t("chrome_typeof", () => typeof g.chrome);
	t("chrome_keys", () => g.chrome ? Object.keys(g.chrome) : null);
	t("chrome_csi", () => { try { return g.chrome?.csi?.() ?? null; } catch { return "<throw>"; } });
	t("chrome_loadTimes", () => { try { return g.chrome?.loadTimes?.() ?? null; } catch { return "<throw>"; } });
	t("chrome_runtime_keys", () => g.chrome?.runtime ? Object.keys(g.chrome.runtime) : null);
	t("canvas2d", () => !!g.document.createElement("canvas").getContext("2d"));
	t("canvas_webgl", () => !!g.document.createElement("canvas").getContext("webgl"));
	t("canvas_webgl2", () => !!g.document.createElement("canvas").getContext("webgl2"));
	t("canvas_todataurl_prefix", () => g.document.createElement("canvas").toDataURL().slice(0, 32));
	t("canvas_ctor", () => g.document.createElement("canvas").constructor?.name);
	t("canvas_global_name", () => g.HTMLCanvasElement?.name ?? null);
	t("offscreen_typeof", () => typeof g.OffscreenCanvas);
	t("offscreen_2d", () => { try { return !!new g.OffscreenCanvas(1, 1).getContext("2d"); } catch { return "<throw>"; } });
	t("audioctx_state", () => { try { return new g.AudioContext().state; } catch { return "<throw>"; } });
	t("audioctx_samplerate", () => { try { return new g.AudioContext().sampleRate; } catch { return "<throw>"; } });
	t("rtc_typeof", () => typeof g.RTCPeerConnection);
	t("indexeddb_typeof", () => typeof g.indexedDB);
	t("caches_typeof", () => typeof g.caches);
	t("trustedtypes_typeof", () => typeof g.trustedTypes);
	t("notification_permission", () => g.Notification?.permission ?? null);
	t("mediasource_typeof", () => typeof g.MediaSource);
	t("websocket_typeof", () => typeof g.WebSocket);
	t("worker_typeof", () => typeof g.Worker);
	t("sharedworker_typeof", () => typeof g.SharedWorker);
	t("serviceworker_typeof", () => typeof g.ServiceWorker);
	t("crypto_subtle", () => typeof g.crypto?.subtle);
	t("crypto_getrandomvalues", () => { const a = new Uint8Array(8); g.crypto.getRandomValues(a); return Array.from(a); });
	t("raf_typeof", () => typeof g.requestAnimationFrame);
	t("idle_typeof", () => typeof g.requestIdleCallback);
	t("fetch_typeof", () => typeof g.fetch);
	t("webassembly_typeof", () => typeof g.WebAssembly);
	t("wasm_validate", () => g.WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])));
	t("document_tostring", () => Object.prototype.toString.call(g.document));
	t("document_readyState", () => g.document.readyState);
	t("document_cookie", () => g.document.cookie);
	t("document_visibilityState", () => g.document.visibilityState);
	t("document_hidden", () => g.document.hidden);
	t("document_hasFocus", () => g.document.hasFocus());
	t("window_tostring", () => Object.prototype.toString.call(g.window));
	t("window_self_eq_window", () => g.self === g.window);
	t("window_top_eq_window", () => g.top === g.window);
	t("window_frames_len", () => g.frames?.length ?? null);
	t("window_name", () => g.name);
	t("window_origin", () => g.origin);
	t("window_isSecureContext", () => g.isSecureContext);
	t("window_crossOriginIsolated", () => g.crossOriginIsolated);
	t("window_screenX", () => g.screenX);
	t("window_screenY", () => g.screenY);
	t("window_localStorage", () => { try { return typeof g.localStorage; } catch { return "<throw>"; } });
	t("window_sessionStorage", () => { try { return typeof g.sessionStorage; } catch { return "<throw>"; } });
	t("window_matchMedia", () => { try { return typeof g.matchMedia; } catch { return "<throw>"; } });
	t("window_getComputedStyle", () => { try { return typeof g.getComputedStyle; } catch { return "<throw>"; } });
	t("intl_timeZone", () => Intl.DateTimeFormat().resolvedOptions().timeZone);
	t("date_tz_offset", () => new Date().getTimezoneOffset());
	return out;
};

async function main() {
	let chromium;
	try {
		({ chromium } = await import("playwright"));
	} catch {
		console.error("Playwright not installed. Run: pnpm add -D playwright && pnpm exec playwright install chromium");
		process.exit(2);
	}

	const launchOpts = { headless: !headful };
	if (process.env.CHROME_PATH) launchOpts.executablePath = process.env.CHROME_PATH;
	const browser = await chromium.launch(launchOpts);
	const context = await browser.newContext({
		userAgent:
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
		viewport: { width: 1920, height: 1080 },
		locale: "en-US",
	});
	const page = await context.newPage();

	// Playwright sets navigator.webdriver = true; real sessions have it false.
	await page.addInitScript(() => {
		try {
			Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false, configurable: true });
		} catch { /* ignore */ }
	});

	const generateIT = [];
	page.on("request", (req) => {
		if (req.url().includes("GenerateIT")) {
			generateIT.push({ kind: "request", url: req.url(), body: req.postData() });
			// Raw bytes for the size comparison against the jsdom mint.
			try {
				const buf = req.postDataBuffer();
				if (buf) {
					writeFileSync("/tmp/bg-browser-generateit.bin", buf);
					console.log(`[browser] GenerateIT request bytes: ${buf.length}`);
				}
			} catch { /* ignore */ }
		}
		// The player's own SABR request — the ground-truth wire shape to diff
		// against buildRequestBody.
		if (req.method() === "POST" && req.url().includes("videoplayback")) {
			try {
				const buf = req.postDataBuffer();
				if (buf?.length) {
					writeFileSync("/tmp/bg-browser-abr.bin", buf);
					console.log(`[browser] videoplayback POST bytes: ${buf.length}`);
				}
			} catch { /* ignore */ }
		}
	});
	page.on("response", async (res) => {
		if (res.url().includes("GenerateIT")) {
			let text = null;
			try { text = await res.text(); } catch { /* ignore */ }
			generateIT.push({ kind: "response", url: res.url(), status: res.status(), body: text });
		}
	});

	const interpreter = [];
	page.on("response", async (res) => {
		const u = res.url();
		if (u.includes("/bg/") || u.includes("interpreter") || u.includes("BotGuard")) {
			let text = null;
			try { text = await res.text(); } catch { /* ignore */ }
			interpreter.push({ url: u, bytes: text?.length ?? null, hash: text ? sha16(text) : null });
		}
	});

	console.log(`[browser] loading watch page for ${videoId}…`);
	await page.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: "domcontentloaded", timeout: 60000 });

	// Let YouTube's own BotGuard run and mint.
	await page.waitForTimeout(15000);

	const result = await page.evaluate(probe);
	const ytcfg = await page.evaluate(() => {
		try {
			const c = globalThis.ytcfg?.data_ ?? globalThis.ytcfg?.get?.() ?? null;
			return c ? { EVENT_ID: c.EVENT_ID ?? null, visitorData: c.INNERTUBE_CONTEXT?.client?.visitorData ?? null, clientVersion: c.INNERTUBE_CONTEXT?.client?.clientVersion ?? null, clientName: c.INNERTUBE_CONTEXT?.client?.clientName ?? null } : null;
		} catch { return null; }
	});

	const out = { videoId, probe: result, ytcfg, interpreter, generateIT };
	writeFileSync(OUT, JSON.stringify(out, null, 2));
	console.log(`[browser] wrote ${OUT}`);
	console.log(`[browser] GenerateIT captures: ${generateIT.length}, interpreter captures: ${interpreter.length}`);
	if (generateIT.length) {
		const req = generateIT.find((g) => g.kind === "request");
		if (req?.body) console.log(`[browser] GenerateIT request bytes: ${req.body.length}`);
	}

	await browser.close();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
