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
import Innertube, { Player, UniversalCache } from "youtubei.js";
import { Response } from "node-fetch";
import { generateContentBoundPoToken } from "./poToken";
import { cacheDir } from "./constants";
import { Format } from "youtubei.js/dist/src/parser/misc";

export type FormatWithURL = Format & { freeTubeUrl: string; };

/**
 * @param {Misc.Format[]} formats
 * @param {import('youtubei.js').Player} player
 */
export async function decipherFormats(
	formats: FormatWithURL[],
	player: Player | undefined) {
	for (const format of formats) {
		// toDash deciphers the format again, so if we overwrite the original URL,
		// it breaks because the n param would get deciphered twice and then be incorrect
		format.freeTubeUrl = await format.decipher(player);
	}
}
/**
 * Creates a lightweight Innertube instance, which is faster to create or
 * an instance that can decode the streaming URLs, which is slower to create
 * the lightweight one only needs a single web request to create the new session
 * the full one needs 3 (or 2 if the player is cached) web requests to create:
 * 1. the request for the session
 * 2. fetch a page that contains a link to the player
 * 3. if the player isn't cached, it is downloaded and transformed
 * @param {object} options
 * @param {boolean} options.withPlayer set to true to get an Innertube instance that can decode the streaming URLs
 * @param {string|undefined} options.location the geolocation to pass to YouTube get different content
 * @param {boolean} options.safetyMode whether to hide mature content
 * @param {import('youtubei.js').ClientType} options.clientType use an alterate client
 * @param {boolean} options.generateSessionLocally generate the session locally or let YouTube generate it (local is faster, remote is more accurate)
 * @returns the Innertube instance
 */

export async function createInnertube({
	withPlayer = false, location = undefined, safetyMode = false, clientType = undefined, generateSessionLocally = true,
} = {}) {
	let cache;
	if (withPlayer) {
		if (process.env.IS_ELECTRON) {
            // TODO implement our PlayerCache.
			//   cache = new PlayerCache()
			cache = new UniversalCache(true, cacheDir);
		} else {
			cache = new UniversalCache(true, cacheDir);
		}
	}

	return await Innertube.create({
		// This setting is enabled by default and results in YouTube.js reusing the same session across different Innertube instances.
		// That behavior is highly undesirable for FreeTube, as we want to create a new session every time to limit tracking.
		enable_session_cache: false,
		retrieve_innertube_config: !generateSessionLocally,
		user_agent: navigator.userAgent,

		retrieve_player: !!withPlayer,
		location: location,
		enable_safety_mode: !!safetyMode,
		client_type: clientType,

		// use browser fetch
		// @ts-expect-error lol
		fetch: !withPlayer
			? (input, init) => fetch(input as any, init as any)
			: async (input: any, init: any) => {
				if (input.url?.startsWith(
					"https://www.youtube.com/youtubei/v1/player"
				) &&
					init?.headers?.get("X-Youtube-Client-Name") === "2") {
					const response = await fetch(input, init);

					const responseText = await response.text();

					const json = JSON.parse(responseText);

					if (Array.isArray(json.adSlots)) {
						let waitSeconds = 0;

						for (const adSlot of json.adSlots) {
							if (adSlot.adSlotRenderer?.adSlotMetadata?.triggerEvent ===
								"SLOT_TRIGGER_EVENT_BEFORE_CONTENT") {
								const playerVars = adSlot.adSlotRenderer.fulfillmentContent?.fulfilledLayout
									?.playerBytesAdLayoutRenderer?.renderingContent
									?.instreamVideoAdRenderer?.playerVars;

								if (playerVars) {
									const match = playerVars.match(/length_seconds=([\d.]+)/);

									if (match) {
										waitSeconds += parseFloat(match[1]);
									}
								}
							}
						}

						if (waitSeconds > 0) {
							await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000)
							);
						}
					}

					// Need to return a new response object, as you can only read the response body once.
					return new Response(responseText, {
						status: response.status,
						statusText: response.statusText,
						// @ts-expect-error
						headers: response.headers,
					});
				}

				return fetch(input, init);
			},
		cache,
		generate_session_locally: !!generateSessionLocally,
	});
}
export async function getLocalVideoInfo(id: string) {
	const webInnertube = await createInnertube({
		withPlayer: true,
		generateSessionLocally: false,
	});

	// based on the videoId
	let contentPoToken: string;

	//   if (process.env.IS_ELECTRON) {
	try {
		contentPoToken = await generateContentBoundPoToken(
			id,
			webInnertube.session.context
		);
		console.log("PoToken is valid ", contentPoToken != undefined);

		webInnertube.session!.player!.po_token = contentPoToken;
	} catch (error) {
		console.error("Local API, poToken generation failed", error);
		throw error;
	}
	//   }
	let clientName = webInnertube.session.context.client.clientName;

	const info = await webInnertube.getInfo(id, { po_token: contentPoToken! });
	console.log("Got info for video ", id);

	// #region temporary workaround for SABR-only responses
	// MWEB doesn't have an audio track selector so it picks the audio track on the server based on the request language.
	const originalAudioTrackFormat = info.streaming_data?.adaptive_formats.find(
		(format) => {
			return format.has_audio && format.is_original && format.language;
		}
	);

	if (originalAudioTrackFormat) {
		// @ts-expect-error not an issue
		webInnertube.session!.context!.client!.hl =
			originalAudioTrackFormat.language;
	}

	const mwebInfo = await webInnertube.getBasicInfo(id, {
		client: "MWEB",
		po_token: contentPoToken!,
	});
	console.log("Got MWEB info for video ", id);

	if (mwebInfo.playability_status!.status === "OK" && mwebInfo.streaming_data) {
		info.playability_status = mwebInfo.playability_status;
		info.streaming_data = mwebInfo.streaming_data;

		clientName = "MWEB";
	}

	// #endregion temporary workaround for SABR-only responses
	let hasTrailer = info.has_trailer;
	let trailerIsAgeRestricted = info.getTrailerInfo() === null;

	if (((info.playability_status!.status === "UNPLAYABLE" ||
		info.playability_status!.status === "LOGIN_REQUIRED") &&
		info.playability_status!.reason === "Sign in to confirm your age") ||
		(hasTrailer && trailerIsAgeRestricted)) {
		console.log("Bypassing age restriction for video ", id);
		const webEmbeddedInnertube = await createInnertube({
			// @ts-expect-error weird
			clientType: ClientType.WEB_EMBEDDED,
		});
		webEmbeddedInnertube.session.context.client.visitorData =
			webInnertube.session.context.client.visitorData;

		const videoId = hasTrailer && trailerIsAgeRestricted
			// @ts-expect-error weird
			? info.playability_status!.error_screen!.video_id
			: id;

		// getBasicInfo needs the signature timestamp (sts) from inside the player
		webEmbeddedInnertube.session.player = webInnertube.session.player;

		const bypassedInfo = await webEmbeddedInnertube.getBasicInfo(videoId, {
			client: "WEB_EMBEDDED",
			po_token: contentPoToken!,
		});

		if (bypassedInfo.playability_status!.status === "OK" &&
			bypassedInfo.streaming_data) {
			info.playability_status = bypassedInfo.playability_status;
			info.streaming_data = bypassedInfo.streaming_data;
			info.basic_info.start_timestamp = bypassedInfo.basic_info.start_timestamp;
			info.basic_info.duration = bypassedInfo.basic_info.duration;
			info.captions = bypassedInfo.captions;
			info.storyboards = bypassedInfo.storyboards;

			hasTrailer = false;
			trailerIsAgeRestricted = false;

			clientName = webEmbeddedInnertube.session.context.client.clientName;
		}
	}

	if ((info.playability_status!.status === "UNPLAYABLE" &&
		(!hasTrailer || trailerIsAgeRestricted)) ||
		info.playability_status!.status === "LOGIN_REQUIRED") {
		return info;
	}

	if (hasTrailer && info.playability_status!.status !== "OK") {
		console.log("Getting trailer info for video");
		const trailerInfo = info.getTrailerInfo();

		// don't override the timestamp of when the video will premiere for upcoming videos
		if (info.playability_status!.status !== "LIVE_STREAM_OFFLINE") {
			info.basic_info.start_timestamp = trailerInfo!.basic_info.start_timestamp;
		}

		info.playability_status = trailerInfo!.playability_status;
		info.streaming_data = trailerInfo!.streaming_data;
		info.basic_info.duration = trailerInfo!.basic_info.duration;
		info.captions = trailerInfo!.captions;
		info.storyboards = trailerInfo!.storyboards;
	}

	if (info.streaming_data) {
		console.log("streaming data found, deciphering urls for video");
		await decipherFormats(
			info.streaming_data.formats as FormatWithURL[],
			webInnertube.session.player
		);

		const firstFormat = info.streaming_data.adaptive_formats[0];

		if (firstFormat.url || firstFormat.signature_cipher || firstFormat.cipher) {
			await decipherFormats(
				info.streaming_data.adaptive_formats as FormatWithURL[],
				webInnertube.session.player
			);
		}

		if (info.streaming_data.dash_manifest_url) {
			console.log("Dash URL found");
			let url = info.streaming_data.dash_manifest_url;
			console.log("Original DASH URL: ", url);

			if (url.includes("?")) {
				url += `&pot=${encodeURIComponent(contentPoToken!)}&mpd_version=7`;
			} else {
				url += `${url.endsWith("/") ? "" : "/"}pot/${encodeURIComponent(
					contentPoToken!
				)}/mpd_version/7`;
			}
			console.log("Modified DASH URL: ", url);

			info.streaming_data.dash_manifest_url = url;
		}
	}

	if (info.captions?.caption_tracks) {
		for (const captionTrack of info.captions.caption_tracks) {
			const url = new URL(captionTrack.base_url);

			url.searchParams.set("potc", "1");
			url.searchParams.set("pot", contentPoToken!);
			url.searchParams.set("c", clientName);

			// Remove &xosf=1 as it adds `position:63% line:0%` to the subtitle lines
			// placing them in the top right corner
			url.searchParams.delete("xosf");

			captionTrack.base_url = url.toString();
		}
	}

	return info;
}

