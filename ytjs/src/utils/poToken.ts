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

import { BG, buildURL, GOOG_API_KEY } from "bgutils-js";
import { Session } from "youtubei.js";

import { JSDOM } from "jsdom";
import { createCanvas, loadImage } from "@napi-rs/canvas";

// Patch globals before any BotGuard operations
export async function setupBotGuardGlobals() {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
		url: "https://www.youtube.com",
		referrer: "https://www.youtube.com/",
		contentType: "text/html",
		includeNodeLocations: true,
		storageQuota: 10000000,
		userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	});

	Object.assign(globalThis, {
		window: dom.window,
		document: dom.window.document,
		// navigator: {
		// 	userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
		// 		,
		// 	appVersion:
		// 		"5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		// 	platform: "Win32",
		// 	hardwareConcurrency: 4,
		// 	deviceMemory: 8,
		// 	languages: ["en-US", "en"],
		// 	onLine: true,
		// 	cookieEnabled: true,
		// },
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
			availHeight: 1050,
			colorDepth: 24,
			pixelDepth: 24,
		},
		performance: {
			now: () => Date.now(),
			timeOrigin: Date.now(),
		},
		// crypto: {
		// 	// @ts-expect-error lol
		// 	getRandomValues: (array: any) => crypto.randomBytes(array.length),
		// 	randomUUID: () => crypto.randomUUID(),
		// },
	});

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

	globalThis.WebAssembly = WebAssembly;
	globalThis.TextEncoder = TextEncoder;
	globalThis.TextDecoder = TextDecoder;
	globalThis.atob = (str) => Buffer.from(str, "base64").toString("binary");
	globalThis.btoa = (str) => Buffer.from(str, "binary").toString("base64");

	globalThis.HTMLElement = dom.window.HTMLElement;
	globalThis.HTMLBodyElement = dom.window.HTMLBodyElement;
	globalThis.HTMLDivElement = dom.window.HTMLDivElement;
	globalThis.HTMLIFrameElement = dom.window.HTMLIFrameElement;

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

export async function generateContentBoundPoToken(
  videoId: string,
  context: Session["context"]
) {
  const requestKey = "O43z0dpjhgX20SCx4KAo";
//   const visitorData = context.client.visitorData;

//   if (!visitorData) {
//     throw new Error("Failed to get visitor data");
//   }

  // Get BotGuard challenge
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
        context,
      }),
    }
  );

  if (!challengeResponse.ok) {
    throw new Error(`Request failed with status ${challengeResponse.status}`);
  }

  const challengeData = await challengeResponse.json();

  console.log("BG req status: ", JSON.stringify(challengeData, null, '\t'))

  if (!challengeData.bgChallenge) {
    throw new Error("Failed to get BotGuard challenge");
  }

  let interpreterUrl =
    challengeData.bgChallenge.interpreterUrl
      .privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;

  if (interpreterUrl.startsWith("//")) {
    interpreterUrl = `https:${interpreterUrl}`;
  }

  const bgScriptResponse = await fetch(interpreterUrl);
  const interpreterJavascript = await bgScriptResponse.text();

  if (interpreterJavascript) {
    // eslint-disable-next-line no-new-func
    new Function(interpreterJavascript)();
  } else {
    throw new Error("Could not load VM.");
  }

  const botGuard = await BG.BotGuardClient.create({
    program: challengeData.bgChallenge.program,
    globalName: challengeData.bgChallenge.globalName,
    globalObj: globalThis,
  });

  const webPoSignalOutput: any[] = [];
  const botGuardResponse = await botGuard.snapshot(
    { webPoSignalOutput },
    10_000
  );

  const integrityTokenResponse = await fetch(buildURL("GenerateIT", true), {
    method: "POST",
    headers: {
      "content-type": "application/json+protobuf",
      "x-goog-api-key": GOOG_API_KEY,
      "x-user-agent": "grpc-web-javascript/0.1",
    },
    body: JSON.stringify([requestKey, botGuardResponse]),
  });

  const response = await integrityTokenResponse.json();

  console.log("IT response: ", JSON.stringify(response, null, '\t'))

  if (typeof response[0] !== "string") {
    throw new Error("Could not get integrity token");
  }

  const integrityTokenBasedMinter = await BG.WebPoMinter.create(
    { integrityToken: response[0] },
    webPoSignalOutput
  );

  return await integrityTokenBasedMinter.mintAsWebsafeString(videoId);
}
