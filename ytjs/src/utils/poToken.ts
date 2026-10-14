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
import { createCanvas, loadImage } from "@napi-rs/canvas";

import { Response } from "node-fetch";

// Patch globals before any BotGuard operations
export async function setupBotGuardGlobals() {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
		url: "https://www.youtube.com",
		referrer: "https://www.youtube.com/",
		contentType: "text/html",
		includeNodeLocations: true,
		storageQuota: 10000000,
		userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
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
		location: {
			href: "https://www.youtube.com",
			origin: "https://www.youtube.com",
			protocol: "https:",
			host: "www.youtube.com",
			hostname: "www.youtube.com",
			pathname: "/",
			search: "",
			hash: "",
		},
		screen: {
			width: 1920,
			height: 1080,
			availWidth: 1920,
			availHeight: 1040,
			colorDepth: 24,
			pixelDepth: 24,
			orientation: { type: "landscape-primary", angle: 0 },
		},
		devicePixelRatio: 1,
		innerWidth: 1920,
		innerHeight: 969,
		outerWidth: 1920,
		outerHeight: 1080,
		// Electron equivalent: backgroundThrottling: false + v8CacheOptions: 'none'
		performance: {
			now: () => Date.now(),
			timeOrigin: Date.now(),
			mark: (name: string) => {},
			measure: (name: string, startMark?: string, endMark?: string) => {},
			clearMarks: (name?: string) => {},
			clearMeasures: (name?: string) => {},
			getEntriesByType: (type: string) => [],
			getEntriesByName: (name: string) => [],
			getEntries: () => [],
			memory: { jsHeapSizeLimit: 4294705152, totalJSHeapSize: 1e7, usedJSHeapSize: 1e7 },
		},
		// crypto: {
		// 	// @ts-expect-error lol
		// 	getRandomValues: (array: any) => crypto.randomBytes(array.length),
		// 	randomUUID: () => crypto.randomUUID(),
		// },
	});

	// A coherent, plausible desktop-Chrome fingerprint. Not copied from any
	// specific host — the point is internal consistency (UA, platform, UA-CH
	// brands, screen, hardware) so BotGuard's environment checks see a real
	// browser rather than bare JSDOM defaults. navigator is getter-only on
	// globalThis, so it must be (re)defined rather than assigned.
	const fakeNavigator = {
		userAgent:
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
		appVersion:
			"5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
		appName: "Netscape",
		appCodeName: "Mozilla",
		product: "Gecko",
		productSub: "20030107",
		vendor: "Google Inc.",
		vendorSub: "",
		platform: "Win32",
		language: "en-US",
		languages: ["en-US", "en"],
		hardwareConcurrency: 8,
		deviceMemory: 8,
		maxTouchPoints: 0,
		cookieEnabled: true,
		onLine: true,
		doNotTrack: null,
		pdfViewerEnabled: true,
		webdriver: false,
		plugins: { length: 5, item: () => null, namedItem: () => null, refresh: () => {} },
		mimeTypes: { length: 2, item: () => null, namedItem: () => null },
		userAgentData: {
			brands: [
				{ brand: "Not_A Brand", version: "24" },
				{ brand: "Chromium", version: "131" },
				{ brand: "Google Chrome", version: "131" },
			],
			mobile: false,
			platform: "Windows",
			getHighEntropyValues: async () => ({
				architecture: "x86",
				bitness: "64",
				model: "",
				platformVersion: "10.0.0",
				uaFullVersion: "131.0.0.0",
				fullVersionList: [
					{ brand: "Not_A Brand", version: "24.0.0.0" },
					{ brand: "Chromium", version: "131.0.0.0" },
					{ brand: "Google Chrome", version: "131.0.0.0" },
				],
			}),
		},
		connection: { effectiveType: "4g", rtt: 50, downlink: 10, saveData: false },
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
	try {
		Object.defineProperty(globalThis, "navigator", { value: fakeNavigator, configurable: true, writable: true });
	} catch {
		Object.assign(globalThis, { navigator: fakeNavigator });
	}

	// @ts-expect-error r
	globalThis.HTMLCanvasElement = createCanvas;
	// @ts-expect-error r
	globalThis.Image = loadImage;
	// @ts-expect-error r
	globalThis.OffscreenCanvas = createCanvas;

	// Patch canvas prototype methods
	const canvasProto = createCanvas.constructor.prototype;
	Object.assign(globalThis.HTMLCanvasElement.prototype, canvasProto);
	Object.assign(globalThis.OffscreenCanvas.prototype, canvasProto);

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

	// Browser APIs BotGuard's environment probe expects to exist. Stubs are
	// deliberately plausible (not copied from a specific host) so the collected
	// signal set looks like a real desktop Chrome rather than bare JSDOM.
	const g = globalThis as any;
	g.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}), app: { isInstalled: false } };
	g.WebGLRenderingContext = function WebGLRenderingContext() {};
	g.WebGL2RenderingContext = function WebGL2RenderingContext() {};
	g.AudioContext = function AudioContext() {
		return { sampleRate: 48000, state: "suspended", destination: {}, createOscillator: () => ({ connect() {}, start() {}, stop() {}, frequency: { value: 0 } }), createGain: () => ({ connect() {}, gain: { value: 0 } }), createAnalyser: () => ({ connect() {}, getFloatFrequencyData() {} }), close: async () => {} };
	};
	g.OfflineAudioContext = g.AudioContext;
	g.RTCPeerConnection = function RTCPeerConnection() { return { createDataChannel: () => ({}), createOffer: async () => ({}), close() {} }; };
	g.RTCSessionDescription = function RTCSessionDescription() {};
	g.RTCIceCandidate = function RTCIceCandidate() {};
	g.Notification = function Notification() {};
	g.Notification.permission = "default";
	g.Notification.requestPermission = async () => "default";
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
	g.visualViewport = { width: 1920, height: 969, scale: 1, offsetLeft: 0, offsetTop: 0 };
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
}

/**
 * Scrapes the watch page for the data BotGuard needs: the ytcfg (which holds
 * the EVENT_ID the interpreter reads) and the initial attestation challenge
 * (`window.ytAtN(...)`). This mirrors FreeTube's getHTMLPage and produces a
 * properly attested token, unlike a bare att/get call.
 */
export async function getWatchHTMLPage(videoId: string): Promise<{
	ytConfig: any;
	initialAttestationData: any;
}> {
	const htmlResponse = await fetch(
		`https://www.youtube.com/watch?v=${videoId}&bpctr=9999999999&has_verified=1`,
		{ headers: { "Accept-Language": "en-US" } }
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

  // Prefer the challenge scraped from the watch page; fall back to att/get
  let challengeData = initialAttestationData?.R;

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

  return await integrityTokenBasedMinter.mintAsWebsafeString(videoId);
}
