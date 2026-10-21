/*
 * BotGuard environment census + challenge/snapshot logging (diagnostic only).
 *
 * The read census, fingerprint probe and realm checks are inert unless
 * BG_CENSUS=1. They are JSDOM-era tools: the mint now runs in a real Camoufox
 * page, so the interesting environment is the browser's own — `fingerprintProbe`
 * can be stringified into `page.evaluate("mw:...")` when a diff is needed.
 *
 * Output: JSONL at $BG_CENSUS_LOG (default /tmp/bg-census.jsonl).
 * The fingerprint probe source is also written to $BG_PROBE_OUT
 * (default /tmp/bg-probe-source.js).
 *
 * Env flags:
 *   BG_CENSUS=1        enable the read census + probe
 *   BG_CENSUS_CALLS=1  also log calls to a curated set of methods
 *   BG_CENSUS_LOG=...  JSONL output path
 *   BG_PROBE_OUT=...   probe-source output path
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const LOG_PATH = process.env.BG_CENSUS_LOG ?? "/tmp/bg-census.jsonl";
const PROBE_OUT = process.env.BG_PROBE_OUT ?? "/tmp/bg-probe-source.js";
const CALLS = process.env.BG_CENSUS_CALLS === "1";

let logInitialized = false;

function log(entry: Record<string, unknown>): void {
	try {
		if (!logInitialized) {
			writeFileSync(LOG_PATH, "");
			logInitialized = true;
		}
		appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
	} catch {
		/* instrumentation must never break minting */
	}
}

/** Public sink so call sites can emit structured census rows. */
export function censusLog(entry: Record<string, unknown>): void {
	log(entry);
}

function summarize(val: unknown): unknown {
	if (val === null) return null;
	const t = typeof val;
	if (t === "function") {
		const f = val as Function;
		return `<function ${f.name || "anon"}>`;
	}
	if (t === "object") {
		try {
			if (Array.isArray(val)) return `<Array(${val.length})>`;
			const ctor = (val as any)?.constructor?.name;
			return `<${ctor ?? "object"}>`;
		} catch {
			return "<object>";
		}
	}
	if (t === "string") {
		const s = val as string;
		return s.length > 120 ? s.slice(0, 120) + "…" : s;
	}
	return val;
}

/** Methods worth logging when BG_CENSUS_CALLS=1 (fingerprint-relevant). */
const CALL_PROPS = new Set([
	"getContext", "getContextAttributes", "toDataURL", "toBlob", "encode",
	"getImageData", "putImageData", "measureText", "fillText", "strokeText",
	"isPointInPath", "getParameter", "getExtension", "getSupportedExtensions",
	"getShaderPrecisionFormat", "getHighEntropyValues", "query", "enumerateDevices",
	"decodingInfo", "getBattery", "getVoices", "createOscillator", "createGain",
	"createAnalyser", "getRandomValues", "randomUUID", "now", "getEntriesByType",
	"getEntriesByName", "getEntries", "mark", "measure", "estimate", "open",
	"match", "keys", "get", "getAll", "createDataChannel", "createOffer",
	"setLocalDescription", "createObjectURL", "revokeObjectURL", "postTask",
	"yield", "requestAnimationFrame", "getGamepads", "requestMediaKeySystemAccess",
	"sendBeacon", "vibrate", "getCurrentPosition", "watchPosition",
]);

const seen = new Set<string>();
const callWrappers = new WeakMap<object, Map<string, Function>>();

function wrapCall(fn: Function, key: string): Function {
	const wrapper = function (this: any, ...args: any[]) {
		let result: unknown;
		try {
			result = new.target
				? Reflect.construct(fn, args, fn)
				: fn.apply(this, args);
		} catch (e) {
			log({ call: key, args: args.map(summarize), threw: String(e).slice(0, 120) });
			throw e;
		}
		log({ call: key, args: args.map(summarize), result: summarize(result) });
		return result;
	};
	return wrapper;
}

/**
 * Wrap an object so every property read is logged once. Uses the target as the
 * getter receiver so native getters (Node's `performance`, a DOM `document`)
 * don't hit "Illegal invocation".
 */
export function instrumentObject<T extends object>(obj: T, label: string): T {
	const handler: ProxyHandler<any> = {
		get(target, prop, receiver) {
			const key = `${label}.${String(prop)}`;
			let val: unknown;
			try {
				val = Reflect.get(target, prop, target);
			} catch (e) {
				if (!seen.has(key)) {
					seen.add(key);
					log({ read: key, threw: String(e).slice(0, 120) });
				}
				throw e;
			}
			if (!seen.has(key)) {
				seen.add(key);
				log({ read: key, value: summarize(val) });
			}
			if (CALLS && typeof val === "function" && CALL_PROPS.has(String(prop))) {
				let perObj = callWrappers.get(target);
				if (!perObj) {
					perObj = new Map();
					callWrappers.set(target, perObj);
				}
				let wrapped = perObj.get(String(prop));
				if (!wrapped) {
					wrapped = wrapCall(val as Function, key);
					perObj.set(String(prop), wrapped);
				}
				return wrapped;
			}
			return val;
		},
	};
	try {
		return new Proxy(obj, handler) as T;
	} catch {
		return obj;
	}
}

/**
 * Log an arbitrary census entry (used by call sites that want a structured row
 * in the same JSONL stream).
 */
export function censusEntry(label: string, value: unknown): void {
	log({ [label]: value });
}

/**
 * Self-contained fingerprint probe. Uses only `globalThis`, so it can be
 * stringified into a main-world `page.evaluate` on the Camoufox side.
 */
export function fingerprintProbe(): Record<string, unknown> {
	const g = globalThis as any;
	const out: Record<string, unknown> = {};
	const t = (k: string, fn: () => unknown) => {
		try {
			out[k] = fn();
		} catch (e) {
			out[k] = "<throw: " + String(e).slice(0, 80) + ">";
		}
	};

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
}

/** Write the probe source so it can be pasted into page.evaluate(). */
export function writeProbeSource(): void {
	try {
		writeFileSync(
			PROBE_OUT,
			"// paste into page.evaluate() on the browser side\nconst probe = " +
				fingerprintProbe.toString() +
				";\nreturn probe();\n"
		);
		log({ probeSource: PROBE_OUT });
	} catch {
		/* ignore */
	}
}

const sha16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Log the challenge inputs so they can be compared against the browser's. */
export function logChallenge(info: {
	videoId: string;
	interpreterUrl: string;
	program: string;
	globalName: string;
	interpreterJavascript: string;
	ytConfig: any;
	context: any;
}): void {
	log({
		challenge: {
			videoId: info.videoId,
			interpreterUrl: info.interpreterUrl,
			globalName: info.globalName,
			programBytes: info.program?.length,
			programHash: sha16(info.program ?? ""),
			interpreterBytes: info.interpreterJavascript?.length,
			interpreterHash: sha16(info.interpreterJavascript ?? ""),
			eventId: info.ytConfig?.EVENT_ID ?? null,
			ytConfigVisitor: info.ytConfig?.INNERTUBE_CONTEXT?.client?.visitorData ?? null,
			contextVisitor: info.context?.client?.visitorData ?? null,
			contextClientName: info.context?.client?.clientName ?? null,
			contextClientVersion: info.context?.client?.clientVersion ?? null,
			contextHl: info.context?.client?.hl ?? null,
			contextGl: info.context?.client?.gl ?? null,
		},
	});
}

/** Log the snapshot + GenerateIT round-trip (the payload that encodes signals). */
export function logSnapshot(info: {
	botGuardResponse: string;
	webPoSignalOutput: any[];
	requestKey: string;
	integrityResponse: any;
	poToken: string;
}): void {
	log({
		snapshot: {
			botGuardResponseBytes: info.botGuardResponse?.length,
			botGuardResponsePrefix: info.botGuardResponse?.slice(0, 64),
			botGuardResponseHash: sha16(info.botGuardResponse ?? ""),
			webPoSignalOutputTypes: info.webPoSignalOutput?.map((x) => typeof x),
			requestKey: info.requestKey,
			integrityTokenType: typeof info.integrityResponse?.[0],
			integrityTokenBytes: typeof info.integrityResponse?.[0] === "string" ? info.integrityResponse[0].length : null,
			integrityTtl: info.integrityResponse?.[1] ?? null,
			integrityRefreshThreshold: info.integrityResponse?.[2] ?? null,
			hasFallbackToken: typeof info.integrityResponse?.[3] === "string",
			poTokenBytes: info.poToken?.length,
			poTokenPrefix: info.poToken?.slice(0, 24),
		},
	});
}
