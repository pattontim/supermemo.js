/*
 * This file uses code licensed under the license of the parent
 * 
 * URL: https://github.com/FreeTubeApp/FreeTube
 * 
 * Modifications: globalThis
 * 
 * This code is licensed under the parent. You can obtain a copy of the license here:
 * https://github.com/FreeTubeApp/FreeTube#license
 */

import { BotGuardClient } from "bgutils-js/botguard";
import { WebPoMinter } from "bgutils-js/webpo";
import { buildURL, getHeaders, parseLooseJSON } from "bgutils-js/utils";
import { Session } from "youtubei.js";

import { JSDOM } from "jsdom";
import { createCanvas, loadImage, ImageData } from "@napi-rs/canvas";

import { Response } from "node-fetch";

import {
	censusLog,
	fingerprintProbe,
	forceWindowRealm,
	installCensus,
	logChallenge,
	logFnStrings,
	logRealmCheck,
	logSnapshot,
	writeProbeSource,
} from "./bgCensus";

const CENSUS = process.env.BG_CENSUS === "1";
// Diagnostic: neutralize the suspect stubs (cookies, plugins, chrome timings,
// performance entries) to minimal returns in one run, to see whether the
// oversized botGuardResponse shrinks toward the browser's ~1385 bytes.
const MINIMAL_STUBS = process.env.BG_MINIMAL_STUBS === "1";
// Diagnostic: disable the native toString spoofer (default on) to measure its
// effect on the snapshot payload size.
const NO_SPOOF = process.env.BG_NO_SPOOF === "1";

// The JSDOM instance created by setupBotGuardGlobals, kept so the page URL can
// be reconfigured per-video (BotGuard may check that location matches the video
// being attested).
let botGuardDom: JSDOM | undefined;

/**
 * Every function we hand to the BotGuard VM (stubs, delegations, shims) is a
 * JS closure, so Function.prototype.toString on it returns real source — in a
 * real Chrome these all read "function X() { [native code] }". BotGuard
 * canonically detects instrumentation this way, and a detected-override flag
 * can switch the VM onto a different encoding path. Replace toString so any
 * marked function reports the native form.
 */
const nativeFns = new WeakSet<Function>();
export function markNative<T extends Function>(fn: T): T {
	if (typeof fn === "function") nativeFns.add(fn);
	return fn;
}

export function spoofNativeFunctions(dom?: any): void {
	if (NO_SPOOF) return;
	const origToString = Function.prototype.toString;
	const spoofed = function (this: unknown) {
		if (typeof this === "function" && nativeFns.has(this as Function)) {
			const name = (this as Function).name || "";
			return `function ${name}() { [native code] }`;
		}
		return origToString.call(this);
	};
	const g = globalThis as any;

	// Sweep the stubs we installed BEFORE the interpreter is eval'd (the
	// interpreter's own functions are created later and keep real source, as
	// they would in a real Chrome where the interpreter is a real script).
	const mark = (obj: any, depth = 0) => {
		if (!obj || depth > 3) return;
		let names: string[];
		try {
			names = Object.getOwnPropertyNames(obj);
		} catch {
			return;
		}
		for (const k of names) {
			let v: any;
			try {
				v = obj[k];
			} catch {
				continue;
			}
			if (typeof v === "function") {
				nativeFns.add(v);
			} else if (v && typeof v === "object" && depth < 2) {
				// Recurse into namespaces like navigator.mediaDevices.
				mark(v, depth + 1);
			}
		}
	};
	// GlobalThis own props + the fake globals we attached.
	for (const key of [
		"navigator", "screen", "performance", "location", "chrome",
		"matchMedia", "getComputedStyle", "AudioContext", "OfflineAudioContext",
		"RTCPeerConnection", "Notification", "IntersectionObserver",
		"ResizeObserver", "PerformanceObserver", "ReportingObserver",
		"MediaSource", "WebTransport", "Worker", "SharedWorker", "ServiceWorker",
		"trustedTypes", "caches", "indexedDB", "speechSynthesis", "fetch",
		"requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback",
		"cancelIdleCallback",
	]) {
		const v = g[key];
		if (typeof v === "function") nativeFns.add(v);
		else if (v && typeof v === "object") mark(v);
	}
	// jsdom realm functions we patched (canvas delegation).
	if (dom?.window?.HTMLCanvasElement?.prototype) {
		const p = dom.window.HTMLCanvasElement.prototype;
		for (const m of ["getContext", "toDataURL", "toBlob"]) {
			if (typeof p[m] === "function") nativeFns.add(p[m]);
		}
	}
	if (dom?.window?.OffscreenCanvas?.prototype?.getContext) {
		nativeFns.add(dom.window.OffscreenCanvas.prototype.getContext);
	}
	// Also cover jsdom's own constructors/methods the VM might introspect, since
	// jsdom functions return real source too.
	if (dom?.window) mark(dom.window, 0);

	try {
		nativeFns.add(spoofed);
		nativeFns.add(origToString as unknown as Function);
		Object.defineProperty(Function.prototype, "toString", {
			value: spoofed,
			writable: true,
			configurable: true,
		});
	} catch {
		/* ignore */
	}

	// Error.stack under our mint leaks Node frames and absolute paths
	// (node_modules/jsdom, file:///home/deck/...). A real page shows
	// Chrome-style frames (`at https://www.youtube.com/...:1:2`). Sanitize any
	// stack string to a plausible browser form before the VM can read it.
	const origPrepare = (Error as any).prepareStackTrace;
	try {
		Object.defineProperty(Error, "prepareStackTrace", {
			configurable: true,
			writable: true,
			value: (_err: any, frames: any[]) => {
				const lines = ["Error"];
				for (const f of frames.slice(0, 12)) {
					const fn = f.getFunctionName?.() ?? f.getMethodName?.() ?? "";
					const file = String(f.getFileName?.() ?? "");
					const line = f.getLineNumber?.() ?? 1;
					const col = f.getColumnNumber?.() ?? 1;
					let where: string;
					if (/youtube\.com|googlevideo|google\.com|gstatic/.test(file)) {
						where = file + ":" + line + ":" + col;
					} else if (fn) {
						where = "https://www.youtube.com/s/player/player_ias.vflset/en_US/base.js:" + line + ":" + col;
					} else {
						continue;
					}
					lines.push(`    at ${fn ? fn + " (" + where + ")" : where}`);
				}
				return lines.join("\n");
			},
		});
	} catch {
		/* ignore */
		void origPrepare;
	}
}

/**
 * Point the BotGuard realm's location at the watch page for `videoId`. Called
 * per-mint because setupBotGuardGlobals runs once at server start, before any
 * video id is known.
 */
export function setBotGuardPageUrl(videoId: string): void {
	if (!botGuardDom) return;
	try {
		botGuardDom.reconfigure({ url: `https://www.youtube.com/watch?v=${videoId}` });
	} catch {
		return;
	}
	// reconfigure swaps dom.window.location for a new Location object, so the
	// globalThis.location set at setup time and the ancestorOrigins shim must
	// be re-pointed.
	try {
		(globalThis as any).location = botGuardDom.window.location;
		Object.defineProperty(botGuardDom.window.location, "ancestorOrigins", {
			value: { length: 0, item: () => null, contains: () => false, [Symbol.iterator]: function* () {} },
			configurable: true,
		});
	} catch {
		/* ignore */
	}
}

// Patch globals before any BotGuard operations
export async function setupBotGuardGlobals() {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
		url: "https://www.youtube.com",
		referrer: "https://www.youtube.com/",
		contentType: "text/html",
		includeNodeLocations: true,
		storageQuota: 10000000,
		// NOTE: jsdom >=28 moved `userAgent` out of ConstructorOptions into
		// ResourceLoader (resources: new ResourceLoader({ userAgent })). It is
		// omitted here because navigator is fully replaced by fakeNavigator
		// below and this instance loads no subresources.
		// Electron equivalent: contextIsolation: true + sandbox: true
	});

	// Add Content-Security-Policy equivalent for context isolation (after DOM is ready)
	const cspMeta = dom.window.document.createElement('meta');
	cspMeta.httpEquiv = 'Content-Security-Policy';
	cspMeta.content = "default-src 'self' https://www.youtube.com; connect-src 'self' https: wss:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.youtube.com; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data: https:;";
	if (dom.window.document.head) {
		dom.window.document.head.appendChild(cspMeta);
	}

	// Add CORS headers simulation for onHeadersReceived equivalent
	const corsHeaders = dom.window.document.createElement('meta');
	corsHeaders.name = 'cors-headers';
	corsHeaders.content = JSON.stringify({
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, CONNECT, OPTIONS, TRACE, PATCH'
	});
	if (dom.window.document.head) {
		dom.window.document.head.appendChild(corsHeaders);
	}

	Object.assign(globalThis, {
		window: dom.window,
		document: dom.window.document,
		// Use jsdom's real Location rather than a plain object: BotGuard does
		// `location instanceof Location`, reads ancestorOrigins, and relies on
		// the Location prototype. A bare object fails all of those checks.
		location: dom.window.location,
		screen: {
			width: 1536,
			height: 864,
			availWidth: 1536,
			availHeight: 864,
			colorDepth: 24,
			pixelDepth: 24,
			orientation: { type: "landscape-primary", angle: 0 },
		},
		devicePixelRatio: 0.9375,
		innerWidth: 2048,
		innerHeight: 912,
		outerWidth: 1536,
		outerHeight: 864,
		// Electron equivalent: backgroundThrottling: false + v8CacheOptions: 'none'
		// NOTE: performance.now() must return milliseconds since timeOrigin, NOT
		// epoch ms — a real browser's now() is a small monotonic number. Returning
		// Date.now() here made now() ≈ timeOrigin, which is a headless tell.
		performance: (() => {
			const timeOrigin = Date.now();
			// Chrome's performance.now() has ~5µs resolution (not integer ms), and
			// BotGuard runs a timing loop — with an integer-ms clock the loop
			// iterates far more (4800+ calls observed) and the collected timing
			// signal is anomalous. Use a high-resolution monotonic clock so the
			// VM behaves like it does on a real page.
			const hrNow = () => {
				const [s, ns] = process.hrtime();
				return s * 1000 + ns / 1e6;
			};
			const hrStart = hrNow();
			const navEntry = {
				name: "https://www.youtube.com/",
				entryType: "navigation",
				startTime: 0,
				duration: 0,
				initiatorType: "navigation",
				nextHopProtocol: "h2",
				workerStart: 0,
				redirectStart: 0,
				redirectEnd: 0,
				fetchStart: 0,
				domainLookupStart: 0,
				domainLookupEnd: 0,
				connectStart: 0,
				connectEnd: 0,
				secureConnectionStart: 0,
				requestStart: 0,
				responseStart: 0,
				responseEnd: 0,
				transferSize: 0,
				encodedBodySize: 0,
				decodedBodySize: 0,
				serverTiming: [],
				unloadEventStart: 0,
				unloadEventEnd: 0,
				domInteractive: 0,
				domContentLoadedEventStart: 0,
				domContentLoadedEventEnd: 0,
				domComplete: 0,
				loadEventStart: 0,
				loadEventEnd: 0,
				type: "navigate",
				redirectCount: 0,
				activationStart: 0,
				criticalCHRestart: 0,
				toJSON() { return { ...this }; },
			};
			// A real watch page has loaded a few subresources by the time
			// BotGuard runs; an empty resource list is a tell.
			const resourceEntries = MINIMAL_STUBS
				? []
				: [
					{ name: "https://www.youtube.com/", entryType: "resource", initiatorType: "script", startTime: 0, duration: 0, transferSize: 0, encodedBodySize: 0, decodedBodySize: 0, nextHopProtocol: "h3", toJSON() { return { ...this }; } },
					{ name: "https://www.youtube.com/s/player/base.js", entryType: "resource", initiatorType: "script", startTime: 0, duration: 0, transferSize: 0, encodedBodySize: 0, decodedBodySize: 0, nextHopProtocol: "h3", toJSON() { return { ...this }; } },
					{ name: "https://i.ytimg.com/generate_204", entryType: "resource", initiatorType: "img", startTime: 0, duration: 0, transferSize: 0, encodedBodySize: 0, decodedBodySize: 0, nextHopProtocol: "h3", toJSON() { return { ...this }; } },
				];
			const perf: any = {
				timeOrigin,
				now: () => hrNow() - hrStart,
				mark: (name: string) => {},
				measure: (name: string, startMark?: string, endMark?: string) => {},
				clearMarks: (name?: string) => {},
				clearMeasures: (name?: string) => {},
				getEntriesByType: (type: string) =>
					type === "navigation" ? [navEntry] : type === "resource" ? resourceEntries : [],
				getEntriesByName: (name: string) =>
					name === navEntry.name ? [navEntry] : resourceEntries.filter((r) => r.name === name),
				getEntries: () => [navEntry, ...resourceEntries],
				toJSON: () => ({ timeOrigin, navigation: navEntry }),
				memory: { jsHeapSizeLimit: 4294705152, totalJSHeapSize: 1e7, usedJSHeapSize: 1e7 },
			};
			// Real Chrome's performance object stringifies as [object Performance].
			Object.defineProperty(perf, Symbol.toStringTag, { value: "Performance", configurable: true });
			return perf;
		})(),
		// crypto: {
		// 	// @ts-expect-error lol
		// 	getRandomValues: (array: any) => crypto.randomBytes(array.length),
		// 	randomUUID: () => crypto.randomUUID(),
		// },
	});

	// Real Chrome exposes the built-in PDF viewers as Plugin objects carrying
	// MimeTypes. Returning null from item()/namedItem() is a headless tell, so
	// build the same shape the reference browser reports: 5 PDF-viewer plugins,
	// each with application/pdf + text/pdf.
	const pdfMime: any = {
		type: "application/pdf",
		suffixes: "pdf",
		description: "Portable Document Format",
		enabledPlugin: null,
	};
	const textPdfMime: any = {
		type: "text/pdf",
		suffixes: "pdf",
		description: "Portable Document Format",
		enabledPlugin: null,
	};
	const makePdfPlugin = (name: string) => {
		const mimes = [pdfMime, textPdfMime];
		return {
			name,
			filename: "internal-pdf-viewer",
			description: "Portable Document Format",
			length: mimes.length,
			item: (i: number) => mimes[i] ?? null,
			namedItem: (t: string) => mimes.find((m) => m.type === t) ?? null,
			0: mimes[0],
			1: mimes[1],
		} as any;
	};
	const pluginList: any[] = MINIMAL_STUBS
		? []
		: [
			makePdfPlugin("PDF Viewer"),
			makePdfPlugin("Chrome PDF Viewer"),
			makePdfPlugin("Chromium PDF Viewer"),
			makePdfPlugin("Microsoft Edge PDF Viewer"),
			makePdfPlugin("WebKit built-in PDF"),
		];
	pdfMime.enabledPlugin = pluginList[0] ?? null;
	textPdfMime.enabledPlugin = pluginList[0] ?? null;
	const mimeList: any[] = MINIMAL_STUBS ? [] : [pdfMime, textPdfMime];
	const fakePlugins: any = {
		length: pluginList.length,
		item: (i: number) => pluginList[i] ?? null,
		namedItem: (n: string) => pluginList.find((p) => p.name === n) ?? null,
		refresh: () => {},
	};
	pluginList.forEach((p, i) => (fakePlugins[i] = p));
	fakePlugins[Symbol.iterator] = function* () { yield* pluginList; };
	const fakeMimeTypes: any = {
		length: mimeList.length,
		item: (i: number) => mimeList[i] ?? null,
		namedItem: (t: string) => mimeList.find((m) => m.type === t) ?? null,
	};
	mimeList.forEach((m, i) => (fakeMimeTypes[i] = m));
	fakeMimeTypes[Symbol.iterator] = function* () { yield* mimeList; };

	// A coherent desktop-Chrome fingerprint matching the reference browser
	// (Linux x86_64, Chrome 155). navigator is getter-only on globalThis, so it
	// must be (re)defined rather than assigned.
	const navValues: any = {
		appCodeName: "Mozilla",
		appName: "Netscape",
		appVersion:
			"5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
		userAgent:
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
		product: "Gecko",
		productSub: "20030107",
		vendor: "Google Inc.",
		vendorSub: "",
		platform: "Linux x86_64",
		language: "en-US",
		languages: ["en-US", "en"],
		hardwareConcurrency: 8,
		deviceMemory: 16,
		maxTouchPoints: 10,
		cookieEnabled: true,
		onLine: true,
		doNotTrack: null,
		pdfViewerEnabled: true,
		webdriver: false,
		plugins: fakePlugins,
		mimeTypes: fakeMimeTypes,
		userAgentData: {
			brands: [
				{ brand: "Chromium", version: "155" },
				{ brand: "Not(A:Brand", version: "24" },
			],
			mobile: false,
			platform: "Linux",
			getHighEntropyValues: async () => ({
				architecture: "x86",
				bitness: "64",
				model: "",
				platformVersion: "6.5.0",
				uaFullVersion: "155.0.0.0",
				fullVersionList: [
					{ brand: "Chromium", version: "155.0.0.0" },
					{ brand: "Not(A:Brand", version: "24.0.0.0" },
				],
			}),
		},
		connection: { effectiveType: "4g", rtt: 50, downlink: 9.4, saveData: false },
		permissions: { query: async () => ({ state: "prompt" }) },
		mediaCapabilities: { decodingInfo: async () => ({ supported: true, smooth: true, powerEfficient: true }) },
		mediaDevices: { enumerateDevices: async () => [] },
		storage: { estimate: async () => ({ quota: 1e10, usage: 0 }) },
		serviceWorker: {},
		credentials: {},
		clipboard: {},
		wakeLock: {},
		scheduling: {},
		userActivation: { isActive: true, hasBeenActive: true },
		keyboard: {},
		locks: { request: async (_n: string, fn: any) => fn({}) },
		usb: {},
		hid: {},
		serial: {},
		xr: {},
		gpu: {},
		geolocation: {},
		mediaSession: {},
		presentation: {},
		getBattery: async () => ({ charging: true, level: 1, chargingTime: 0, dischargingTime: Infinity }),
		sendBeacon: () => true,
		vibrate: () => true,
		getGamepads: () => [],
		requestMediaKeySystemAccess: async () => ({}),
	};
	// Real Chrome's navigator has NO own enumerable keys — every property is a
	// getter on Navigator.prototype. A plain object with own props is a tell, so
	// expose an empty instance whose prototype carries the getters.
	class Navigator {}
	const navProto = Navigator.prototype as any;
	for (const key of Object.keys(navValues)) {
		const value = navValues[key];
		Object.defineProperty(navProto, key, { get: () => value, configurable: true });
	}
	Object.defineProperty(navProto, Symbol.toStringTag, { value: "Navigator", configurable: true });
	const fakeNavigator: any = {};
	Object.setPrototypeOf(fakeNavigator, navProto);
	(globalThis as any).Navigator = Navigator;
	try {
		Object.defineProperty(globalThis, "navigator", { value: fakeNavigator, configurable: true, writable: true });
	} catch {
		Object.assign(globalThis, { navigator: fakeNavigator });
	}

	class Screen {}
	Object.defineProperty(Screen.prototype, Symbol.toStringTag, { value: "Screen", configurable: true });
	Object.setPrototypeOf((globalThis as any).screen, Screen.prototype);
	(globalThis as any).Screen = Screen;

	// @ts-expect-error r
	globalThis.HTMLCanvasElement = createCanvas;
	// @ts-expect-error r
	globalThis.Image = loadImage;
	// createCanvas's function name is "createCanvas"; a real browser's
	// HTMLCanvasElement.name is "HTMLCanvasElement". Fix the name so a
	// constructor-name probe doesn't flag it.
	try {
		Object.defineProperty(globalThis.HTMLCanvasElement, "name", { value: "HTMLCanvasElement", configurable: true });
	} catch {
		/* ignore */
	}
	// @napi-rs/canvas has no OffscreenCanvas export, so build a shim that adds
	// the OffscreenCanvas-only transferToImageBitmap(). NOTE: extending the
	// typed `Canvas` class does not work — its constructor returns a
	// CanvasElement instance, so subclass methods are dropped. A factory-style
	// class that returns a real canvas with the extra method attached does.
	class OffscreenCanvasShim {
		constructor(width: number, height: number) {
			const canvas: any = createCanvas(width, height);
			canvas.transferToImageBitmap = () => {
				const ctx = canvas.getContext("2d");
				const img = new ImageData(canvas.width, canvas.height);
				img.data.set(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
				return img;
			};
			// @napi-rs/canvas throws for webgl/webgl2; a real browser returns null.
			const origGetContext = canvas.getContext.bind(canvas);
			canvas.getContext = (type: string, ...a: any[]) =>
				type === "2d" || type === "bitmaprenderer" ? origGetContext(type, ...a) : null;
			return canvas;
		}
	}
	// @ts-expect-error r
	globalThis.OffscreenCanvas = OffscreenCanvasShim;

	// NOTE: the previous "patch canvas prototype methods" block copied
	// `createCanvas.constructor.prototype` (which is Function.prototype) onto
	// the canvas prototypes — a no-op that only added apply/bind/call. Copying
	// the real canvas prototype is not possible either: its napi getters throw
	// "Failed to unwrap exclusive reference of CanvasElement" under
	// Object.assign. The canvas instances already carry the full API, so no
	// prototype patching is needed here.

	// jsdom's own HTMLCanvasElement.getContext() is an unimplemented stub that
	// logs "Not implemented: HTMLCanvasElement's getContext() method" and
	// returns null. Since `document` points at dom.window.document, any
	// document.createElement('canvas') yields a jsdom element — the globalThis
	// swap above never reaches it. Delegate the jsdom realm's canvas methods to
	// @napi-rs/canvas so BotGuard's canvas fingerprinting gets a real context.
	// (jsdom can only auto-detect the `canvas` npm package, not @napi-rs/canvas,
	// so prototype delegation is the pragmatic route.)
	const ensureNapiCanvas = (el: any) => {
		const w = el.width || 300;
		const h = el.height || 150;
		if (!el.__napi) {
			el.__napi = createCanvas(w, h);
		} else if (el.__napi.width !== w || el.__napi.height !== h) {
			el.__napi.width = w;
			el.__napi.height = h;
		}
		return el.__napi;
	};

	dom.window.HTMLCanvasElement.prototype.getContext = function (
		this: any,
		type: string,
		...args: any[]
	) {
		// @napi-rs/canvas only implements 2d; asking it for webgl throws
		// "webgl is not supported". A real browser returns null when WebGL is
		// unavailable, so return null for those types rather than throwing —
		// a throw is a stronger "broken environment" signal than null.
		if (type !== "2d" && type !== "bitmaprenderer") {
			return null;
		}
		return ensureNapiCanvas(this).getContext(type, ...args);
	} as any;

	// @napi-rs/canvas toDataURL expects a MIME type ("image/png"), not the
	// short form ("png"), so pass the type through unchanged.
	dom.window.HTMLCanvasElement.prototype.toDataURL = function (
		this: any,
		type = "image/png",
		quality?: number
	) {
		return ensureNapiCanvas(this).toDataURL(type, quality);
	} as any;

	// jsdom does not define OffscreenCanvas on the window realm; patch it only
	// if a future jsdom version adds one.
	if ((dom.window as any).OffscreenCanvas) {
		(dom.window as any).OffscreenCanvas.prototype.getContext = function (
			this: any,
			type: string,
			...args: any[]
		) {
			if (type !== "2d" && type !== "bitmaprenderer") {
				return null;
			}
			return ensureNapiCanvas(this).getContext(type, ...args);
		};
	}

	// Electron equivalent: disableBlinkFeatures + v8CacheOptions: 'none'
	globalThis.WebAssembly = WebAssembly;
	globalThis.TextEncoder = TextEncoder;
	globalThis.TextDecoder = TextDecoder;
	globalThis.atob = (str) => Buffer.from(str, "base64").toString("binary");
	globalThis.btoa = (str) => Buffer.from(str, "binary").toString("base64");

	// Electron equivalent: onBeforeRequest blocking cspReport and ping types
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async function(input: any, init?: any) {
		// Block CSP report requests (type: cspReport)
		if (typeof input === 'string' && input.includes('__csp')) {
			throw new Error('CSP report blocked');
		}
		// Block ping requests
		if (init?.method === 'GET' && init?.mode === 'no-cors' && init?.keepalive === true) {
			throw new Error('Ping request blocked');
		}
		return originalFetch(input, init);
	} as any;

	globalThis.HTMLElement = dom.window.HTMLElement;
	globalThis.HTMLBodyElement = dom.window.HTMLBodyElement;
	globalThis.HTMLDivElement = dom.window.HTMLDivElement;
	globalThis.HTMLIFrameElement = dom.window.HTMLIFrameElement;
	// Expose the Location constructor so `location instanceof Location` works.
	globalThis.Location = dom.window.Location;
	// jsdom's Location has no ancestorOrigins; real Chrome returns an empty
	// DOMStringList (length 0). Add it so the probe matches.
	try {
		Object.defineProperty(dom.window.location, "ancestorOrigins", {
			value: { length: 0, item: () => null, contains: () => false, [Symbol.iterator]: function* () {} },
			configurable: true,
		});
	} catch {
		/* ignore */
	}

	// A freshly-constructed JSDOM reports readyState "loading" and
	// visibilityState "prerender" — a real watch page is fully loaded and
	// visible. Force the loaded/visible state the VM expects.
	try {
		Object.defineProperty(dom.window.document, "readyState", { get: () => "complete", configurable: true });
		Object.defineProperty(dom.window.document, "visibilityState", { get: () => "visible", configurable: true });
		Object.defineProperty(dom.window.document, "hidden", { get: () => false, configurable: true });
		Object.defineProperty(dom.window.document, "hasFocus", { value: () => true, configurable: true });
		// Real Chrome's document stringifies as [object HTMLDocument].
		Object.defineProperty(dom.window.document, Symbol.toStringTag, { value: "HTMLDocument", configurable: true });
		// A real watch page always carries cookies; an empty document.cookie is
		// a tell. Seed the unauthenticated YouTube cookie set.
		if (!MINIMAL_STUBS) {
			dom.window.document.cookie = "VISITOR_INFO1_LIVE=abc123XYZ; path=/; domain=.youtube.com";
			dom.window.document.cookie = "YSC=def456UVW; path=/; domain=.youtube.com";
			dom.window.document.cookie = "PREF=f6=400; path=/; domain=.youtube.com";
		}
	} catch {
		/* ignore */
	}

	// window.self/top/parent/frames must be the window itself, and the window
	// APIs (storage, matchMedia, getComputedStyle) must exist on globalThis —
	// jsdom defines them on its window, but the VM reads globalThis.
	Object.assign(globalThis, {
		self: dom.window,
		top: dom.window,
		parent: dom.window,
		frames: dom.window,
		name: "",
		origin: "https://www.youtube.com",
		isSecureContext: true,
		crossOriginIsolated: false,
		screenX: 0,
		screenY: 0,
		localStorage: dom.window.localStorage,
		sessionStorage: dom.window.sessionStorage,
		Worker: dom.window.Worker,
		SharedWorker: (dom.window as any).SharedWorker,
		ServiceWorker: (dom.window as any).ServiceWorker,
	});
	// jsdom's window has no frame count; a real watch page has iframes.
	try {
		Object.defineProperty(dom.window, "length", { value: 2, configurable: true });
	} catch {
		/* ignore */
	}
	// jsdom implements none of the worker constructors; provide stubs so
	// `typeof Worker` is "function" like a real browser.
	if (typeof (globalThis as any).Worker !== "function") {
		(globalThis as any).Worker = function Worker() {
			return { postMessage() {}, terminate() {}, addEventListener() {}, removeEventListener() {} };
		};
	}
	if (typeof (globalThis as any).SharedWorker !== "function") {
		(globalThis as any).SharedWorker = function SharedWorker() {
			return { port: { postMessage() {}, start() {}, addEventListener() {} } };
		};
	}
	if (typeof (globalThis as any).ServiceWorker !== "function") {
		(globalThis as any).ServiceWorker = function ServiceWorker() {};
	}
	// jsdom does not implement matchMedia/getComputedStyle; provide plausible
	// stubs so the VM's feature detection sees them.
	(globalThis as any).matchMedia = (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false,
	});
	(globalThis as any).getComputedStyle = (el: any) => ({
		getPropertyValue: () => "",
		length: 0,
		item: () => "",
		[Symbol.iterator]: function* () {},
	});

	// Browser APIs BotGuard's environment probe expects to exist. Stubs are
	// deliberately plausible (not copied from a specific host) so the collected
	// signal set looks like a real desktop Chrome rather than bare JSDOM.
	const g = globalThis as any;
	// chrome.csi()/loadTimes() returning {} is a classic headless tell; real
	// Chrome returns populated timing objects. Values are derived from the
	// current clock so they stay internally consistent.
	g.chrome = MINIMAL_STUBS
		? { loadTimes: () => ({}), csi: () => ({}), app: { isInstalled: false }, cast: {} }
		: {
		loadTimes: () => {
			const now = Date.now() / 1000;
			const start = now - performance.now() / 1000;
			return {
				commitLoadTime: start + 0.05,
				connectionInfo: "h3",
				finishDocumentLoadTime: start + 0.4,
				finishLoadTime: start + 0.5,
				firstPaintTime: start + 0.45,
				firstPaintAfterLoadTime: 0,
				navigationType: "Other",
				npnNegotiatedProtocol: "h3",
				requestTime: start,
				startLoadTime: start,
				wasAlternateProtocolAvailable: false,
				wasFetchedViaSpdy: true,
				wasNpnNegotiated: false,
			};
		},
		csi: () => {
			const now = Date.now();
			const start = now - performance.now();
			return { startE: start, onloadT: now, pageT: performance.now(), tran: 15 };
		},
		app: { isInstalled: false, InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" }, RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" } },
		cast: { isAvailable: false, receiverVersion: "0.0.0.0" },
	};
	g.WebGLRenderingContext = function WebGLRenderingContext() {};
	g.WebGL2RenderingContext = function WebGL2RenderingContext() {};
	// A real AudioContext starts in "running" once the page has user activation;
	// "suspended" is a headless tell. Provide the analyser/compressor surface a
	// fingerprint would touch.
	g.AudioContext = function AudioContext() {
		return {
			state: "running",
			sampleRate: 48000,
			currentTime: 0,
			baseLatency: 0.005333333333333333,
			outputLatency: 0.01,
			destination: { maxChannelCount: 2, numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2 },
			listener: { positionX: { value: 0 }, positionY: { value: 0 }, positionZ: { value: 0 } },
			resume: async () => {},
			suspend: async () => {},
			close: async () => {},
			createOscillator: () => ({ connect() {}, disconnect() {}, start() {}, stop() {}, frequency: { value: 440, setValueAtTime() {} }, detune: { value: 0 }, type: "sine" }),
			createGain: () => ({ connect() {}, disconnect() {}, gain: { value: 1, setValueAtTime() {} } }),
			createAnalyser: () => ({ connect() {}, disconnect() {}, fftSize: 2048, frequencyBinCount: 1024, minDecibels: -100, maxDecibels: -30, smoothingTimeConstant: 0.8, getByteFrequencyData() {}, getFloatFrequencyData() {}, getByteTimeDomainData() {}, getFloatTimeDomainData() {} }),
			createDynamicsCompressor: () => ({ connect() {}, disconnect() {}, threshold: { value: -24 }, knee: { value: 30 }, ratio: { value: 12 }, attack: { value: 0.003 }, release: { value: 0.25 }, reduction: 0 }),
			createBuffer: (channels: number, length: number, rate: number) => ({ length, sampleRate: rate, numberOfChannels: channels, duration: length / rate, getChannelData: () => new Float32Array(length) }),
			decodeAudioData: async () => { throw new Error("decodeAudioData not implemented"); },
		};
	};
	g.OfflineAudioContext = g.AudioContext;
	g.RTCPeerConnection = function RTCPeerConnection() { return { createDataChannel: () => ({}), createOffer: async () => ({}), close() {} }; };
	g.RTCSessionDescription = function RTCSessionDescription() {};
	g.RTCIceCandidate = function RTCIceCandidate() {};
	g.Notification = function Notification() {};
	g.Notification.permission = "denied";
	g.Notification.requestPermission = async () => "denied";
	g.requestIdleCallback = (cb: any) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 1);
	g.cancelIdleCallback = (id: any) => clearTimeout(id);
	g.IntersectionObserver = function IntersectionObserver() { return { observe() {}, unobserve() {}, disconnect() {}, takeRecords: () => [] }; };
	g.ResizeObserver = function ResizeObserver() { return { observe() {}, unobserve() {}, disconnect() {} }; };
	g.MutationObserver = dom.window.MutationObserver;
	g.PerformanceObserver = function PerformanceObserver() { return { observe() {}, disconnect() {}, takeRecords: () => [] }; };
	g.ReportingObserver = function ReportingObserver() { return { observe() {}, disconnect() {}, takeRecords: () => [] }; };
	g.MediaSource = function MediaSource() {};
	g.SourceBuffer = function SourceBuffer() {};
	g.MediaRecorder = function MediaRecorder() {};
	g.VideoPlaybackQuality = function VideoPlaybackQuality() {};
	g.VideoDecoder = function VideoDecoder() {};
	g.AudioDecoder = function AudioDecoder() {};
	g.ImageDecoder = function ImageDecoder() {};
	g.WebTransport = function WebTransport() {};
	g.CompressionStream = function CompressionStream() {};
	g.PaymentRequest = function PaymentRequest() {};
	g.PublicKeyCredential = function PublicKeyCredential() {};
	g.trustedTypes = { createPolicy: () => ({ createHTML: (s: string) => s, createScript: (s: string) => s, createScriptURL: (s: string) => s }) };
	g.caches = { open: async () => ({}), match: async () => undefined, keys: async () => [] };
	g.indexedDB = { open: () => ({ onsuccess: null, onerror: null, result: { createObjectStore: () => ({}), transaction: () => ({ objectStore: () => ({ get: () => ({}), put: () => ({}) }) }) } }) };
	g.speechSynthesis = { getVoices: () => [], speak() {}, cancel() {} };
	g.visualViewport = { width: 2027.7332763671875, height: 912, scale: 1, offsetLeft: 0, offsetTop: 0 };
	g.cookieStore = { get: async () => null, getAll: async () => [] };
	g.navigation = { currentEntry: { url: "https://www.youtube.com" }, entries: () => [] };
	g.scheduler = { postTask: (cb: any) => Promise.resolve().then(cb), yield: async () => {} };
	g.EyeDropper = function EyeDropper() {};
	g.IdleDetector = function IdleDetector() {};
	g.PressureObserver = function PressureObserver() { return { observe() {}, disconnect() {} }; };
	g.launchQueue = { setConsumer() {} };
	g.documentPictureInPicture = {};
	g.fence = {};
	g.sharedStorage = {};
	g.getDigitalGoodsService = async () => ({});
	g.getInterestGroupAd = () => null;
	g.showOpenFilePicker = async () => [];
	g.openDatabase = undefined;
	g.ManagedMediaSource = undefined;
	g.WebSocketStream = function WebSocketStream() {};
	g.WebAssembly = WebAssembly;
	g.TextEncoder = TextEncoder;
	g.TextDecoder = TextDecoder;
	g.atob = (str: string) => Buffer.from(str, "base64").toString("binary");
	g.btoa = (str: string) => Buffer.from(str, "binary").toString("base64");

	let lastTime = 0;
	globalThis.requestAnimationFrame = (callback) => {
		const currTime = Date.now();
		const timeToCall = Math.max(0, 16 - (currTime - lastTime));
		const id = setTimeout(() => callback(currTime + timeToCall), timeToCall);
		lastTime = currTime + timeToCall;
		return id as unknown as number;
	};
	globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

	if (!globalThis.fetch) {
		const { default: fetch } = await import("node-fetch");
	// @ts-expect-error r
		globalThis.fetch = fetch;
	// @ts-expect-error r
		globalThis.Headers = fetch.Headers;
	// @ts-expect-error r
		globalThis.Request = fetch.Request;
	// @ts-expect-error r
		globalThis.Response = fetch.Response;
	}

	// jsdom's window realm is separate from globalThis: `window.navigator` and
	// `window.screen` are jsdom defaults (UA "jsdom/29.1.1", screen.width 0)
	// while the fake Chrome fingerprint lives on globalThis. The BotGuard VM is
	// handed `globalObject: globalThis` but its code reads `window.*`, so
	// without this the VM sees bare jsdom defaults. Point jsdom's window at the
	// fake globals so both realms agree.
	forceWindowRealm(dom);

	// Measure the PRE-spoof toString state (diagnostic), then hide the fact that
	// our stubs are JS closures. BotGuard canonically detects instrumentation via
	// Function.prototype.toString, and a detected-override flag can switch the VM
	// onto a different encoding path — which would explain why the payload
	// diverges even though every read value matches.
	if (CENSUS) logFnStrings(dom);
	spoofNativeFunctions(dom);

	// Keep the JSDOM handle so setBotGuardPageUrl() can retarget location.
	botGuardDom = dom;

	// --- diagnostic census (inert unless BG_CENSUS=1) ---
	if (CENSUS) {
		logRealmCheck(dom);
		installCensus(dom);
		writeProbeSource();
		censusLog({ probe: fingerprintProbe() });
	}
}

/**
 * Scrapes the watch page for the data BotGuard needs: the ytcfg (which holds
 * the EVENT_ID the interpreter reads) and the initial attestation challenge
 * (`window.ytAtN(...)`). This mirrors FreeTube's getHTMLPage and produces a
 * properly attested token, unlike a bare att/get call.
 */
export async function getWatchHTMLPage(videoId: string, visitorData?: string): Promise<{
	ytConfig: any;
	initialAttestationData: any;
}> {
	// Carry the session's visitor identity into the watch-page scrape. Without
	// it YouTube assigns a fresh visitorData to the anonymous fetch, so the
	// challenge scraped from the page is bound to a DIFFERENT visitor than the
	// one the token is minted under (context.client.visitorData) and declared in
	// the SABR StreamerContext — a visitor-identity mismatch that makes the
	// server reject the token (StreamProtectionStatus 3). FreeTube uses one
	// session for both, so its visitors always agree.
	const headers: Record<string, string> = { "Accept-Language": "en-US" };
	if (visitorData) {
		headers["X-Goog-Visitor-Id"] = visitorData;
		headers["Cookie"] = `VISITOR_INFO1_LIVE=${encodeURIComponent(visitorData)}`;
	}
	const htmlResponse = await fetch(
		`https://www.youtube.com/watch?v=${videoId}&bpctr=9999999999&has_verified=1`,
		{ headers }
	);
	const htmlPage = await htmlResponse.text();

	const ytConfigStr = htmlPage.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
	if (!ytConfigStr) {
		throw new Error("Could not find ytcfg in the watch HTML page");
	}
	const ytConfig = JSON.parse(ytConfigStr);

	const initialAttestationDataMatch = htmlPage.match(
		/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/
	);
	if (!initialAttestationDataMatch) {
		throw new Error("Could not find challenge in the watch HTML page");
	}

	let initialAttestationData;
	try {
		initialAttestationData = parseLooseJSON(initialAttestationDataMatch[1]);
	} catch (e) {
		console.error(
			"Failed to parse watch page initial attestation data",
			initialAttestationDataMatch[1]
		);
		throw e;
	}

	return { ytConfig, initialAttestationData };
}

export async function generateContentBoundPoToken(
  videoId: string,
  context: Session["context"],
  initialAttestationData: any,
  ytConfig: any
) {
  const requestKey = "O43z0dpjhgX20SCx4KAo";
//   const visitorData = context.client.visitorData;

//   if (!visitorData) {
//     throw new Error("Failed to get visitor data");
//   }

  // Point the BotGuard realm's location at the watch page for this video.
  setBotGuardPageUrl(videoId);

  // Prefer the challenge scraped from the watch page; fall back to att/get
  let challengeData = initialAttestationData?.R;

  // Diagnostic: force the att/get challenge path instead of the scraped one,
  // to see whether the two challenge sources encode different snapshot schemas.
  // Set a stub bgChallenge with no interpreterUrl so the att/get fallback runs.
  if (process.env.BG_FORCE_ATT_GET === "1") {
    challengeData = { bgChallenge: { program: "", globalName: "" } };
  }

  if (!challengeData?.bgChallenge) {
    throw new Error("Failed to get BotGuard challenge from watch page");
  }

  let interpreterUrl =
    challengeData.bgChallenge.interpreterUrl
      ?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;

  if (!interpreterUrl) {
    // Get BotGuard challenge via att/get, passing the eacrToken scraped from the page
    const challengeResponse = await fetch(
      "https://www.youtube.com/youtubei/v1/att/get?prettyPrint=false&alt=json",
      {
        method: "POST",
        headers: {
          Accept: "*/*",
          "Content-Type": "application/json",
          "X-Goog-Visitor-Id": context.client.visitorData!,
          "X-Youtube-Client-Version": context.client.clientVersion,
          "X-Youtube-Client-Name": "1",
        },
        body: JSON.stringify({
          engagementType: "ENGAGEMENT_TYPE_UNBOUND",
          eacrToken: initialAttestationData.T,
          context,
        }),
      }
    );

    if (!challengeResponse.ok) {
      throw new Error(`Request to ${challengeResponse.url} failed with status ${challengeResponse.status}\n${await challengeResponse.text()}`)
    }

    challengeData = await challengeResponse.json();

    if (!challengeData.bgChallenge) {
      throw new Error("Failed to get BotGuard challenge");
    }

    interpreterUrl =
      challengeData.bgChallenge.interpreterUrl
        .privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
  }

  if (interpreterUrl.startsWith("//")) {
    interpreterUrl = `https:${interpreterUrl}`;
  }

  const bgScriptResponse = await fetch(interpreterUrl);
  const interpreterJavascript = await bgScriptResponse.text();

  if (CENSUS) {
    logChallenge({
      videoId,
      interpreterUrl,
      program: challengeData.bgChallenge.program,
      globalName: challengeData.bgChallenge.globalName,
      interpreterJavascript,
      ytConfig,
      context,
    });
  }

  if (interpreterJavascript) {
    // BotGuard reads the EVENT_ID field off window.yt.config_
    (globalThis as any).window.yt = { config_: ytConfig };
    // eslint-disable-next-line no-new-func
    new Function(interpreterJavascript)();
  } else {
    throw new Error("Could not load VM.");
  }

  const botGuard = await BotGuardClient.create({
    program: challengeData.bgChallenge.program,
    globalName: challengeData.bgChallenge.globalName,
    globalObject: globalThis,
  });

  const webPoSignalOutput: any[] = [];
  const botGuardResponse = await botGuard.snapshot(
    { webPoSignalOutput },
    10_000
  );

  const integrityTokenResponse = await fetch(buildURL("GenerateIT", true), {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify([requestKey, botGuardResponse]),
  });

  const response = await integrityTokenResponse.json();

  if (typeof response[0] !== "string") {
    throw new Error("Could not get integrity token");
  }

  const integrityTokenBasedMinter = await WebPoMinter.create(
    { integrityToken: response[0] },
    webPoSignalOutput
  );

  const poToken = await integrityTokenBasedMinter.mintAsWebsafeString(videoId);

  if (CENSUS) {
    logSnapshot({
      botGuardResponse,
      webPoSignalOutput,
      requestKey,
      integrityResponse: response,
      poToken,
    });
    // Raw response body for a structural diff against the browser's
    // GenerateIT payload (both are `$`-prefixed encoded snapshots).
    censusLog({ type: "snapshot-raw", bytes: Buffer.byteLength(botGuardResponse), body: botGuardResponse });
  }

  return poToken;
}
