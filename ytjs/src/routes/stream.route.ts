import { VideoInfo } from "../utils/yt-types";
import { app, archive, archiveContainer, cache, fetchTransformedVTT, fullUrlForClient, useOnline, yti_version } from "../server";
import { YT_VTT_MAX_TIMESTAMP } from "../utils/constants";
import { JSDOM } from "jsdom";
import { getLocalVideoInfo } from "../utils/localvideo";
import { Format } from "../utils/yt-types";
import { FormatOptions } from "../utils/yt-types";
import { latestCacheConstructor } from "../utils/archive";
import { Router } from "express";

const router = Router();

const formatsToUse = [
    // 599 m4a audio only | mp4a.40.5 22050Hz ultralow, m4a_dash
    "mp4a.40.5",
    // 133 mp4 426x240 30 | avc1.4d4015 240p, mp4_dash
    // 'avc1.4d4015',
    // 134 mp4 640x360 30 | avc1.4d401e 360p, mp4_dash
    "avc1.4d401e",
    // 140 m4a audio only | mp4a.40.2 44100Hz medium, m4a_dash
    "mp4a.40.2",
    // 135 mp4 854x480 30 | avc1.4d401f 480p, mp4_dash
    "avc1.4d401f",
    // 298 mp4 1280x720 60 | avc1.4d4020 720p60, mp4_dash
    "avc1.4d4020",
    // 299 mp4 1920x1080 60 | avc1.64002a 1080p60, mp4_dash
    "avc1.64002a",
    // 720p > H.264 - High Profile - Level 3.1
    "avc1.64001f",
    // 1080p > H.264 - High Profile - Level 4.0
    "avc1.640028",
];

async function getSupportedFormats(videoInfoFull: VideoInfo) {
	const supported = [
		{
			type: "video+audio", // audio, video or video+audio
			quality: "1080p", // best, bestefficiency, 144p, 240p, 480p, 720p and so on.
			format: "mp4", // media container format
		},
		{
			type: "video+audio", // audio, video or video+audio
			quality: "720p", // best, bestefficiency, 144p, 240p, 480p, 720p and so on.
			format: "mp4", // media container format
		},
		{
			type: "video+audio", // audio, video or video+audio
			quality: "480p", // best, bestefficiency, 144p, 240p, 480p, 720p and so on.
			format: "mp4", // media container format
		},
		{
			type: "video+audio", // audio, video or video+audio
			quality: "360p", // best, bestefficiency, 144p, 240p, 480p, 720p and so on.
			format: "mp4", // media container format
		},
		{
			type: "video+audio", // audio, video or video+audio
			quality: "240p", // best, bestefficiency, 144p, 240p, 480p, 720p and so on.
			format: "mp4", // media container format
		},
		//{
		//	type: 'video+audio', // audio, video or video+audio
		//	quality: '144p', // best, bestefficiency, 144p, 240p, 480p, 720p and so on.
		//	format: 'mp4' // media container format
		//},
	] as FormatOptions[];

	const fileFormats: { [key: string]: Format; } = {};

	for (const formatOpt of supported) {
		// assume chooseFormat is used internally deterministically
		try {
			const format = await videoInfoFull.chooseFormat(formatOpt);
			// console.log("deciphered: ", JSON.stringify(format.decipher(getYouTube()!.session.player)));
			fileFormats[format.itag + "." + archiveContainer] = format;
		} catch (error) {
			console.log("failed to get format: " + error);
			continue;
		}
	}

	return fileFormats;
}

router.get('/dummy-vtt.vtt', (req, res) => {
	const lang = req.query.lang || 'en';
	res.type('text/vtt; charset=utf-8');
	res.send(`WEBVTT
Kind: captions
Language: ${lang}

00:00:00.000 --> ${YT_VTT_MAX_TIMESTAMP}
CAP_429.

`);
});

router.get('/dummy-manifest.mpd', (req, res) => {
	res.type('application/dash+xml');
	res.send(`<?xml version="1.0" encoding="UTF-8"?>
<MPD
  xmlns="urn:mpeg:dash:schema:mpd:2011"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="urn:mpeg:dash:schema:mpd:2011 DASH-MPD.xsd"
  mediaPresentationDuration="PT0H0M30.0S"
  minBufferTime="PT1.5S"
  profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"
  type="static">

  <Period id="1" start="PT0S">
    <AdaptationSet id="1" contentType="video" mimeType="video/mp4" segmentAlignment="true">
      <Representation id="1" bandwidth="1000000" width="640" height="360" frameRate="30">
        <BaseURL>dummy-segment-</BaseURL>
        <SegmentTemplate timescale="1000" media="$Number$.m4s" initialization="$Number$-init.m4s" startNumber="1"/>
      </Representation>
    </AdaptationSet>
    <AdaptationSet id="2" contentType="audio" mimeType="audio/mp4" segmentAlignment="true">
      <Representation id="2" bandwidth="128000" audioSamplingRate="44100">
        <BaseURL>dummy-audio-</BaseURL>
        <SegmentTemplate timescale="1000" media="$Number$.m4s" initialization="$Number$-init.m4s" startNumber="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`);
});

router.get(/^\/fixvtt\/(.*\..*$)/, async (req, res) => {
	// console.log("req.headers: " + JSON.stringify(req.headers));
	// console.log("req.baseUrl: " + req.baseUrl);
	// console.log("req: " + JSON.stringify(req.body));
	// console.log("fixvtt called with " + req.url);
	const url = new URL(req.url.replace("/fixvtt/", ""));
	console.log("fixvtt request for " + url.href);
	try {
		const vtt = await fetchTransformedVTT(url);
		if (vtt == null || vtt == "" || vtt.indexOf("protect our users") != -1
			|| vtt.indexOf("We're sorry...") != -1 || vtt.indexOf("sending automated queries") != -1
			|| vtt.indexOf("can't process your") != -1) {
			res
				.status(503)
				.send("Error: the VTT could not be found on the service by URL.");
			return;
		}
		res.set("Content-Type", "text/vtt");
		res.send(vtt);
	} catch (error) {
		console.log("error: " + error);
		res.status(503).send("Error: " + error);
		return;
	}
});

router.get(/^\/mpd\/([\w-]+)\.mpd$/, async (req, res) => {
    const v_id = req.params[0];
    const target = req.query.target as string;
    console.log("mpd request for " + v_id);

    // TODO heuristic, for now it seems to generally be 6 hours
    if (
        cache[v_id] &&
        cache[v_id].mpd_manifest &&
        Date.now() - cache[v_id].cached_on_ms < 1000 * 60 * 60 * 6 &&
        cache[v_id].browser_target == target
    ) {
        console.log("serving from cache");
        res.status(200).send(cache[v_id].mpd_manifest);
        return;
    }

    if (!useOnline) {
        res.status(503).send("Error: offline only mode");
        return;
    }


    let videoInfo: VideoInfo;
    try {
        // videoInfo = await getYouTube()!.getBasicInfo(v_id, { client: clientName });
        console.time("Total getLocalVideoInfo time");
        videoInfo = await getLocalVideoInfo(v_id);
        console.timeEnd("Total getLocalVideoInfo time");
    } catch (error) {
        console.log("error: " + error);
        console.log("failed to get basic info");
        res.status(503).send("Error: " + error);
        return;
    }
    let manifest: string;

    // TODO better match the format to the browser
    const preferredLang = "ja";

    function filterAudioAdaptationSets(manifest: string): string {
        let dom = new JSDOM();
        global.DOMParser = dom.window.DOMParser;
        global.XMLSerializer = dom.window.XMLSerializer;
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(manifest, "text/xml");
        const audioSets = xmlDoc.querySelectorAll(
            'AdaptationSet[contentType="audio"]'
        );

        // First try to find preferred language track
        let preferredAudio = Array.from(audioSets).find((set) => {
            const lang = set.getAttribute("lang");
            return lang === preferredLang;
        });

        console.log(`Available audio tracks:`);
        audioSets.forEach((set) => {
            const lang = set.getAttribute("lang");
            const label = set.querySelector("Label")?.textContent;
            console.log(`- lang=${lang}, label=${label}`);
        });
        console.log(
            `Preferred audio track: lang=${preferredAudio?.getAttribute(
                "lang"
            )}, label=${preferredAudio?.querySelector("Label")?.textContent}`
        );

        // If preferred language not found, fallback to original/master audio track
        if (!preferredAudio) {
            preferredAudio = Array.from(audioSets).find((set) => {
                const label = set.querySelector("Label")?.textContent;
                const isMaster =
                    label?.includes("original") ||
                    label?.includes("Original") ||
                    audioSets.length === 1;
                if (isMaster) {
                    console.log(
                        `Using master audio track: lang=${set.getAttribute(
                            "lang"
                        )}, label=${label}`
                    );
                }
                return isMaster;
            });
        }

        // Keep only the selected audio track
        audioSets.forEach((set) => {
            if (set !== preferredAudio) {
                const lang = set.getAttribute("lang");
                const label = set.querySelector("Label")?.textContent;
                console.log(`Filtering out audio track: lang=${lang}, label=${label}`);
                set.parentNode?.removeChild(set);
            }
        });

        return new XMLSerializer().serializeToString(xmlDoc);
    }

    try {
        if (target == "IE") {
            console.log("playable: " + JSON.stringify(videoInfo.playability_status));
            console.log("vid data: " + JSON.stringify(videoInfo.basic_info));
            console.log("[Manifest] Generating IE11-compatible DASH manifest (H.264 + AAC only)");

            const manifestOptions = {
                url_transformer: (url: URL) =>
                    new URL(`http://${fullUrlForClient}/proxy/${url}`),
                format_filter: (format: Format) => {
                    const isAudioOnly = format.has_audio && !format.has_video;
                    console.log(
                        "format: " +
                            format.itag +
                            " audio: " +
                            format.has_audio +
                            " video: " +
                            format.has_video +
                            " mime: " +
                            format.mime_type,
                        " isAudioOnly: " + isAudioOnly + " lang: " + format.language
                    );

                    return !formatsToUse.find((fmt) => format.mime_type.includes(fmt));
                },
            };

            console.time("toDash");
            manifest = await videoInfo.toDash(manifestOptions);
            console.timeEnd("toDash");

            console.time("filterAudioAdaptationSets");
            manifest = filterAudioAdaptationSets(manifest);
            console.timeEnd("filterAudioAdaptationSets");
        } else if (target == "webview2") {
            console.log("playable: " + JSON.stringify(videoInfo.playability_status));
            console.log("vid data: " + JSON.stringify(videoInfo.basic_info));
            console.log("[Manifest] Generating WebView2-compatible DASH manifest (all modern codecs)");

            // WebView2 supports all modern codecs, so no format filtering needed
            const manifestOptions = {
                url_transformer: (url: URL) =>
                    new URL(`http://${fullUrlForClient}/proxy/${url}`),
            };

            console.time("toDash");
            manifest = await videoInfo.toDash(manifestOptions);
            console.timeEnd("toDash");

            // Still filter audio tracks for WebView2
            console.time("filterAudioAdaptationSets");
            manifest = filterAudioAdaptationSets(manifest);
            console.timeEnd("filterAudioAdaptationSets");
        } else {
            console.log("[Manifest] Generating default DASH manifest (no codec restrictions)");
            const manifestOptions = {
                url_transformer: (url: URL) =>
                    new URL(`http://${fullUrlForClient}/proxy/${url}`),
            };
            manifest = await videoInfo.toDash(manifestOptions);
        }

        try {
            for (const caption of videoInfo?.captions?.caption_tracks ?? []) {
                const captionUrl = new URL(caption.base_url, "https://www.youtube.com");
                caption.base_url = `http://${fullUrlForClient}/fixvtt/${captionUrl}`;
            }
        } catch (error) {
            console.log("failed to get captions");
            if (error instanceof TypeError) {
                console.log("TypeError, very likely captions disabled.");
            } else {
                console.log("error: " + error);
            }
        }

        if (!cache[v_id]) {
            try {
                videoInfo.captions = videoInfo.captions;
                cache[v_id] = latestCacheConstructor(videoInfo, manifest, target, yti_version);
                console.log("constructor ran");
                // TODO update to use video_sets instead of file_formats
                cache[v_id].file_formats = await getSupportedFormats(videoInfo);
            } catch (error) {
                console.log('Error: ' + error);
                console.log('failed to cache full video info');
            }
        }

        res.send(manifest);
    } catch (error) {
        console.log("error: " + error);
        console.log("failed to get manifest");
        res.status(503).send("Error: " + error);
        if (videoInfo.basic_info.is_private) {
            console.log("Private video! Please remove!");
            return;
        } else if (
            videoInfo.playability_status &&
            videoInfo.playability_status.status == "UNPLAYABLE"
        ) {
            console.log("Unplayable video likely due to banning embeds");
            return;
        }
        return;
    }

});
router.get("/streamUrl/:v_id", async (req, res) => {
	const v_id = req.params.v_id;
	console.log(`[1/8] Request received for v_id: ${v_id}`);

	const start = req.query.startSec;
	const stop = req.query.stopSec;
	const target = req.query.target;
	console.log(`[2/8] Query params - start: ${start}, stop: ${stop}, target: ${target}`);

	if (!start || !stop || !target) {
		console.log(`[3/8] Missing required parameters`);
		return res.status(400).send("Missing start, stop, or target");
	}

	console.log(`[4/8] Checking archive for v_id: ${v_id}`);
	const archiveFormats = archive[v_id]?.file_formats;
	console.log(`[5/8] Archive formats found: ${!!archiveFormats}`);
	console.log(`[5/8] Archive entry: ${JSON.stringify(archive[v_id])}`);
	console.log(`[5/8] Full URL client: ${fullUrlForClient}`);

	if (archiveFormats) {
		console.log(`[6/8] Sorting formats by bitrate...`);
		try {
			const bestKey = Object.keys(archive[v_id].file_formats).sort(
				(a, b) => archiveFormats[a].bitrate - archiveFormats[b].bitrate
			)[0];
			console.log(`[6/8] Best format key: ${bestKey}`);

			const bestFormat = archiveFormats[bestKey];
			if (bestFormat) {
				console.log(`[7/8] Creating URL for best format`);
				const url = new URL(`http://${fullUrlForClient}/archive/${v_id}/${bestKey}`);
				console.log(`[8/8] Sending response: ${url.href}`);
				return res.send(url.href);
			} else {
				console.log(`[7/8] Best format not found in archive formats`);
				return res.status(500).send("Best format not found");
			}
		} catch (err) {
			console.error(`[ERROR] Failed to sort formats:`, err);
			return res.status(500).send("Internal Server Error");
		}
	} else {
		console.log(`[7/8] No archive formats, falling back to MPD`);
		const url = new URL(`http://${fullUrlForClient}/mpd/${v_id}.mpd`);
		url.searchParams.set("target", target as string);
		const responseUrl = url.href + "#" + start + "," + stop;
		console.log(`[8/8] Sending MPD response: ${responseUrl}`);
		return res.send(responseUrl);
	}
});

export default router;