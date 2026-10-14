/*
 * BotGuard environment census + fingerprint probe (diagnostic only).
 *
 * Everything here is inert unless BG_CENSUS=1. It exists to answer one
 * question: which environment signals does the BotGuard VM read, and how do
 * their values differ between this JSDOM realm and a real Chromium page?
 *
 * Output: JSONL at $BG_CENSUS_LOG (default /tmp/bg-census.jsonl).
 * The fingerprint probe source is also written to $BG_PROBE_OUT
 * (default /tmp/bg-probe-source.js) so it can be pasted into page.evaluate()
 * on the browser side for an apples-to-apples diff.
 *
 * Env flags:
 *   BG_CENSUS=1        enable the read census + probe
 *   BG_CENSUS_CALLS=1  also log calls to a curated set of methods
 *   BG_CENSUS_DOM=1    also proxy document/window (noisier, riskier)
 *   BG_FORCE_REALM=1   make dom.window.navigator/screen return the fake globals
 *   BG_CENSUS_LOG=...  JSONL output path
 *   BG_PROBE_OUT=...   probe-source output path
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const LOG_PATH = process.env.BG_CENSUS_LOG ?? "/tmp/bg-census.jsonl";
const PROBE_OUT = process.env.BG_PROBE_OUT ?? "/tmp/bg-probe-source.js";
const CALLS = process.env.BG_CENSUS_CALLS === "1";
const DOM = process.env.BG_CENSUS_DOM === "1";

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
 * getter receiver so native getters (Node's `performance`, jsdom's `document`)
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

/** Install the read census on the globals the VM is most likely to probe. */
export function installCensus(dom?: any): void {
	const g = globalThis as any;
	const targets: Array<[string, string]> = [
		["navigator", "navigator"],
		["screen", "screen"],
		["performance", "performance"],
		["location", "location"],
		["chrome", "chrome"],
	];
	if (DOM) {
		targets.push(["document", "document"], ["window", "window"]);
	}
	for (const [label, key] of targets) {
		const obj = g[key];
		if (obj && typeof obj === "object") {
			try {
				g[key] = instrumentObject(obj, label);
			} catch {
				/* ignore */
			}
		}
	}

	// Canvas call census on the jsdom realm (where the delegation patch lives).
	if (dom?.window?.HTMLCanvasElement?.prototype) {
		const proto = dom.window.HTMLCanvasElement.prototype;
		for (const m of ["getContext", "toDataURL", "toBlob"]) {
			const orig = proto[m];
			if (typeof orig !== "function") continue;
			proto[m] = function (this: any, ...args: any[]) {
				log({ call: `canvas.${m}`, args: args.map(summarize) });
				return orig.apply(this, args);
			};
		}
	}
	log({ census: "installed", calls: CALLS, dom: DOM, log: LOG_PATH });
}

/**
 * Which realm does the VM actually read? `window` is jsdom's, but `navigator`
 * was patched on globalThis — if these differ, the VM may read jsdom defaults.
 */
export function logRealmCheck(dom: any): void {
	const g = globalThis as any;
	const checks: Record<string, unknown> = {};
	const t = (k: string, fn: () => unknown) => {
		try {
			checks[k] = fn();
		} catch (e) {
			checks[k] = "<throw: " + String(e).slice(0, 80) + ">";
		}
	};
	t("window.navigator === globalThis.navigator", () => dom.window.navigator === g.navigator);
	t("window.navigator.userAgent", () => dom.window.navigator?.userAgent);
	t("globalThis.navigator.userAgent", () => g.navigator?.userAgent);
	t("window.screen === globalThis.screen", () => dom.window.screen === g.screen);
	t("window.screen.width", () => dom.window.screen?.width);
	t("globalThis.screen.width", () => g.screen?.width);
	t("window.performance === globalThis.performance", () => dom.window.performance === g.performance);
	t("window.location.href", () => dom.window.location?.href);
	t("globalThis.location.href", () => g.location?.href);
	t("document.defaultView === window", () => dom.window.document.defaultView === dom.window);
	t("window.HTMLCanvasElement === globalThis.HTMLCanvasElement", () => dom.window.HTMLCanvasElement === g.HTMLCanvasElement);
	t("window.document === globalThis.document", () => dom.window.document === g.document);
	log({ realm: checks });
}

/**
 * Make jsdom's window expose the fake globals. Opt-in: it changes what the VM
 * sees, so only use it to test the "wrong realm" hypothesis.
 */
export function forceWindowRealm(dom: any): void {
	const g = globalThis as any;
	// navigator/screen/performance/HTMLCanvasElement all differ between jsdom's
	// window and the fake globals. Point the window at the fakes so a VM that
	// reads `window.*` sees the same environment as one reading globalThis.
	// (document.createElement('canvas') still returns a jsdom element — that
	// path is handled by the prototype delegation in setupBotGuardGlobals.)
	for (const key of ["navigator", "screen", "performance", "HTMLCanvasElement", "OffscreenCanvas"]) {
		if (g[key] === undefined) continue;
		try {
			Object.defineProperty(dom.window, key, { get: () => g[key], configurable: true });
			log({ forceRealm: key, ok: true });
		} catch (e) {
			log({ forceRealm: key, ok: false, error: String(e).slice(0, 120) });
		}
	}
}

/**
 * Dump Function.prototype.toString for every function we've patched/stubbed.
 * In a real Chrome every one must read `function X() { [native code] }`; any
 * that stringify to real JS source are instrumentation tells (BotGuard
 * canonically detects overrides this way). Diagnostic only (BG_CENSUS=1).
 */
export function logFnStrings(dom: any): void {
	const g = globalThis as any;
	const fns: Array<[string, any]> = [
		["document.createElement", dom?.window?.document?.createElement],
		["HTMLCanvasElement.prototype.getContext", dom?.window?.HTMLCanvasElement?.prototype?.getContext],
		["HTMLCanvasElement.prototype.toDataURL", dom?.window?.HTMLCanvasElement?.prototype?.toDataURL],
		["navigator.sendBeacon", g.navigator?.sendBeacon],
		["navigator.mediaDevices.enumerateDevices", g.navigator?.mediaDevices?.enumerateDevices],
		["navigator.permissions.query", g.navigator?.permissions?.query],
		["navigator.getBattery", g.navigator?.getBattery],
		["navigator.mediaCapabilities.decodingInfo", g.navigator?.mediaCapabilities?.decodingInfo],
		["navigator.storage.estimate", g.navigator?.storage?.estimate],
		["navigator.locks.request", g.navigator?.locks?.request],
		["navigator.userAgentData.getHighEntropyValues", g.navigator?.userAgentData?.getHighEntropyValues],
		["chrome.csi", g.chrome?.csi],
		["chrome.loadTimes", g.chrome?.loadTimes],
		["window.matchMedia", g.matchMedia],
		["window.getComputedStyle", g.getComputedStyle],
		["performance.now", g.performance?.now],
		["performance.getEntriesByType", g.performance?.getEntriesByType],
		["AudioContext", g.AudioContext],
		["Worker", g.Worker],
		["SharedWorker", g.SharedWorker],
		["ServiceWorker", g.ServiceWorker],
		["IntersectionObserver", g.IntersectionObserver],
		["ResizeObserver", g.ResizeObserver],
		["MutationObserver", g.MutationObserver],
		["PerformanceObserver", g.PerformanceObserver],
		["RTCPeerConnection", g.RTCPeerConnection],
		["requestAnimationFrame", g.requestAnimationFrame],
		["cancelAnimationFrame", g.cancelAnimationFrame],
		["requestIdleCallback", g.requestIdleCallback],
		["fetch", g.fetch],
		["atob", g.atob],
		["btoa", g.btoa],
		["trustedTypes.createPolicy", g.trustedTypes?.createPolicy],
		["caches.open", g.caches?.open],
		["indexedDB.open", g.indexedDB?.open],
		["speechSynthesis.getVoices", g.speechSynthesis?.getVoices],
	];
	let nonNative = 0;
	for (const [name, fn] of fns) {
		if (typeof fn !== "function") {
			log({ type: "fnstring", name, missing: true });
			continue;
		}
		let src: string;
		try {
			src = Function.prototype.toString.call(fn);
		} catch (e) {
			src = "<throw: " + String(e).slice(0, 60) + ">";
		}
		const isNative = /\[native code\]/.test(src);
		if (!isNative) nonNative++;
		log({ type: "fnstring", name, isNative, src: src.replace(/\s+/g, " ").slice(0, 100) });
	}
	log({ type: "fnstring-summary", total: fns.length, nonNative });
	log({ type: "stack", stack: String(new Error().stack ?? "").split("\n").slice(0, 6).join(" | ") });
	try {
		log({ type: "window-keys", count: Object.getOwnPropertyNames(dom.window).length });
	} catch { /* ignore */ }
}

/**
 * Self-contained fingerprint probe. Uses only `globalThis`, so the same
 * function can run in this JSDOM realm and be stringified into
 * page.evaluate() on the browser side.
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
