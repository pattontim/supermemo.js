import { spawn } from "child_process";
import { app, archive, cache, clientName, defaultLocalUrl, fullUrlForClient, getCacheWait, getYouTube, yti_version } from "../server";
import { commandExists, getCommandOutput } from "../utils/lib";
import { Format } from "youtubei.js/dist/src/parser/misc";
import { FormatOptions } from "youtubei.js/dist/src/types";
import { VideoInfo } from "youtubei.js/dist/src/parser/youtube";
import { PlayerCaptionsTracklist } from "youtubei.js/dist/src/parser/nodes";
import { Router } from "express";

const router = Router();

export async function getSupportedFormats2(
    videoInfoFull: VideoInfo,
    skipDuplicates = false
) {
    const types = ["video+audio", "video", "audio"] as FormatOptions["type"][];
    const qualities = [
        "144p",
        "240p",
        "360p",
        "480p",
        "720p",
        "best",
        "bestefficiency",
    ];

    const avFormats = {} as { [quality: string]: Format };
    const aFormats = {} as { [quality: string]: Format };
    const vFormats = {} as { [quality: string]: Format };

    for (const type of types) {
        for (const quality of qualities) {
            const formatOpt = { type, quality, format: "mp4" } as FormatOptions;
            try {
                if (skipDuplicates && type == "video" && avFormats[quality]) continue;

                const format = await videoInfoFull.chooseFormat(formatOpt);
                if (format.has_audio && format.has_video) {
                    avFormats[quality] = format;
                } else if (format.has_audio && !format.has_video) {
                    aFormats[quality] = format;
                } else if (format.has_video && !format.has_audio) {
                    vFormats[quality] = format;
                }
            } catch (error) {
                console.log("failed to get format: " + error);
                continue;
            }
        }
    }
    return { avFormats, aFormats, vFormats };
}

router.get("/status/", async (req, res) => {
	if (globalThis.ffmpeg_version === undefined ||
		globalThis.yt_dlp_version === undefined) {
		const [ffmpeg_version, yt_dlp_version] = await Promise.all([
			getCommandOutput("ffmpeg", true, "-version"),
			getCommandOutput("yt-dlp", true, "--version"),
		]);
		globalThis.ffmpeg_version = ffmpeg_version as string | null;
		globalThis.yt_dlp_version = yt_dlp_version as string | null;
	}

	res.send({
		youtubeijs_version: yti_version,
		ffmpeg_version,
		yt_dlp_version,
	});
});

router.get("/ffmpeg/:id", async (req, res) => {
	const id = req.params.id;

	// Set headers for HLS streaming
	res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
	res.setHeader("Cache-Control", "no-cache");
	res.setHeader("Connection", "keep-alive");

	// Construct yt-dlp command
	const ytDlpArgs = [
		"https://www.youtube.com/watch?v=" + id,
		"--format",
		"bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
		"-o",
		"-", // Output to stdout
	];

	// Construct ffmpeg command
	const ffmpegArgs = [
		"-i",
		"pipe:0", // Read from stdin
		"-c:v",
		"libx264",
		"-c:a",
		"aac",
		"-f",
		"hls",
		"-hls_time",
		"10",
		"-hls_list_size",
		"0",
		"-hls_segment_type",
		"mpegts",
		"-hls_flags",
		"delete_segments+omit_endlist",
		"pipe:1", // Output to stdout
	];

	if ((await commandExists("ffmpeg")) && (await commandExists("yt-dlp"))) {
		// Spawn yt-dlp process
		const ytDlp = spawn("yt-dlp", ytDlpArgs);
		// Spawn ffmpeg process
		const ffmpeg = spawn("ffmpeg", ffmpegArgs);

		// Pipe yt-dlp output to ffmpeg input
		ytDlp.stdout.pipe(ffmpeg.stdin);

		// Pipe ffmpeg output to response
		ffmpeg.stdout.pipe(res);

		ytDlp.stderr.on("data", (data) => {
			console.error(`yt-dlp error: ${data}`);
		});

		ffmpeg.stderr.on("data", (data) => {
			console.error(`ffmpeg error: ${data}`);
		});

		ytDlp.on("close", (code) => {
			console.log(`yt-dlp process exited with code ${code}`);
			if (code !== 0) {
				console.error("Error during video download");
			}
		});

		ffmpeg.on("close", (code) => {
			console.log(`ffmpeg process exited with code ${code}`);
			if (code === 0) {
				console.log("Transcoding finished successfully");
			} else {
				console.error("Error during transcoding");
			}
			res.end();
		});

		// Handle client disconnect
		req.on("close", () => {
			ytDlp.kill();
			ffmpeg.kill();
			console.log("Client disconnected, killed processes");
		});
	} else {
		res.send("ffmpeg does not exist");
	}
});

router.get("/vidtest/:videoId.mp4", (req, res) => {
	const videoId = req.params.videoId;
	const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

	// Get video info first
	const infoProcess = spawn("yt-dlp", [
		videoUrl,
		"--format",
		"bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
		"--print",
		"filesize",
		"--no-download",
	]);

	let fileSize = "";
	infoProcess.stdout.on("data", (data) => {
		fileSize += data.toString();
	});

	infoProcess.on("close", (code) => {
		if (code !== 0) {
			console.error("Error getting video info");
			return res.sendStatus(500);
		}

		fileSize = parseInt(fileSize.trim()).toString();

		const range = req.headers.range;
		if (range) {
			const parts = range.replace(/bytes=/, "").split("-");
			const start = parseInt(parts[0], 10);
			const end = parts[1] ? parseInt(parts[1], 10) : Number(fileSize) - 1;
			const chunksize = end - start + 1;
			const headers = {
				"Content-Range": `bytes ${start}-${end}/${fileSize}`,
				"Accept-Ranges": "bytes",
				"Content-Length": chunksize,
				"Content-Type": "video/mp4",
			};
			res.writeHead(206, headers);

			const ytDlpProcess = spawn("yt-dlp", [
				videoUrl,
				"--format",
				"bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
				"-o",
				"-",
			]);

			const ffmpegProcess = spawn("ffmpeg", [
				"-i",
				"pipe:0",
				"-ss",
				`${(Number(start) / Number(fileSize)) * 100}%`,
				"-i",
				"pipe:0",
				"-t",
				`${(Number(chunksize) / Number(fileSize)) * 100}%`,
				"-c",
				"copy",
				"-f",
				"mp4",
				"pipe:1",
			]);

			ytDlpProcess.stdout.pipe(ffmpegProcess.stdin);
			ffmpegProcess.stdout.pipe(res);

			ytDlpProcess.stderr.on("data", (data) => {
				console.error(`yt-dlp error: ${data}`);
			});

			ffmpegProcess.stderr.on("data", (data) => {
				console.error(`ffmpeg error: ${data}`);
			});

			ffmpegProcess.on("close", (code) => {
				console.log(`ffmpeg process exited with code ${code}`);
				if (code !== 0) {
					console.error("Error during video streaming");
				}
				res.end();
			});

			req.on("close", () => {
				ytDlpProcess.kill();
				ffmpegProcess.kill();
				console.log("Client disconnected, killed processes");
			});
		} else {
			const headers = {
				"Content-Length": fileSize,
				"Content-Type": "video/mp4",
			};
			res.writeHead(200, headers);

			const ytDlpArgs = [
				videoUrl,
				"--format",
				"bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
				"--output",
				"-",
			];

			const ytDlp = spawn("yt-dlp", ytDlpArgs);
			ytDlp.stdout.pipe(res);

			ytDlp.stderr.on("data", (data) => {
				console.error(`yt-dlp error: ${data}`);
			});

			ytDlp.on("close", (code) => {
				console.log(`yt-dlp process exited with code ${code}`);
				if (code !== 0) {
					console.error("Error during video streaming");
				}
				res.end();
			});

			req.on("close", () => {
				ytDlp.kill();
				console.log("Client disconnected, killed yt-dlp process");
			});
		}
	});
});

router.get("/mpd/invalidate/:v_id", async (req, res) => {
	const v_id = req.params.v_id;
	console.log("invalidating mpd cache for " + v_id);
	cache[v_id].mpd_manifest = "";
	res.send("OK");
});

/** SImply waits for archiveInfo to be loaded, expecting another process to cache it
 * eg, the initial request to /mpd
 */
router.get("/archiveInfo/:v_id", async (req, res) => {
	const v_id = req.params.v_id;
	const archiveInfo = await getCacheWait(v_id);
	if (archiveInfo) {
		res.send(archiveInfo);
	} else {
		res.status(404).send({});
	}
});

router.get("/archivei/", async (req, res) => {
	res.send(archive);
});

/** Lightweight archive stats — avoids shipping the full archive payload. */
router.get("/archivei/stats", async (req, res) => {
	const entries = Object.values(archive) as any[];
	res.json({
		archiveCount: entries.length,
		totalFiles: entries.reduce(
			(acc, info) => acc + Object.keys(info.file_formats || {}).length, 0),
	});
});

/** Server-side search + sort + pagination over the archive. */
router.get("/archivei/search", async (req, res) => {
	const q = ((req.query.q as string) || "").toLowerCase();
	const sort = (req.query.sort as string) || "date";
	const page = Math.max(1, parseInt(req.query.page as string) || 1);
	const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 10));

	let entries = Object.entries(archive) as [string, any][];

	if (q) {
		entries = entries.filter(([v_id, info]) =>
			[info.title, info.author_name, info.description, info.published, v_id]
				.join(" ").toLowerCase().includes(q));
	}

	entries.sort(([, a], [, b]) => {
		switch (sort) {
			case "title":  return (a.title || "").localeCompare(b.title || "");
			case "author": return (a.author_name || "").localeCompare(b.author_name || "");
			case "date":
			default: return new Date(b.archived_on).getTime() - new Date(a.archived_on).getTime();
		}
	});

	const total = entries.length;
	const items = entries.slice((page - 1) * limit, page * limit);
	res.json({
		items: Object.fromEntries(items),
		total, page, limit,
		totalPages: Math.max(1, Math.ceil(total / limit)),
	});
});

router.get("/cachei/", async (req, res) => {
	res.send(cache);
});

/** Lightweight cache count — avoids shipping the full cache payload. */
router.get("/cachei/count", async (req, res) => {
	res.json({ count: Object.keys(cache).length });
});

router.get("/v1fix/", async (req, res) => {
	return;
	// const fixVerPairs = [
	// 	1,
	// 	2,
	// 	"archived captions saved the auto transcription\
	//  instead of manual subs. This will query every youtube video and dl the right\
	// versions. It will also rename all of the asr captions to a.[LANG] and manual\
	// to .[LANG]",
	// 	"This will query youtube for several tens or hundreds of videos in your collection, do you wish to continue? (y/n)",
	// ];
	// // 0. check the info.version is 1
	// // 1. find all the ASR pairs in archive, that is - if the same language code appears twice and one of them have "kind": "asr" set. Use
	// // 2. for each pair, call patchCaptions
	// // 3. update the info.json file and increment the version number to 2
	// for (const v_id of Object.keys(archive)) {
	// 	// for( const v_id of ["5y3sSEvT4cE"]) {
	// 	const info = archive[v_id];
	// 	if (info.version != 1) {
	// 		console.log("skipping, " + v_id + " due to version != 1.");
	// 		continue;
	// 	}
	// 	if (!info?.captions) {
	// 		console.log("skipping, " + v_id + " due to no captions.");
	// 		continue;
	// 	}
	// 	// const langCodes = info.captions.translation_languages?.map(lang => lang.language_code);
	// 	const captionTracks = info.captions.caption_tracks;
	// 	const archiveEntryDir = path.join(archiveDir, v_id);
	// 	const captionsDir = path.join(archiveEntryDir, "captions");
	// 	const infoPath = path.join(archiveEntryDir, "info.json");
	// 	// if(!langCodes || !captionTracks) {
	// 	// 	return res.status(400).send("No translation languages found in archive for " + v_id);
	// 	// }
	// 	if (!captionTracks) {
	// 		console.log("skipping, " + v_id + " due to no caption tracks.");
	// 		continue;
	// 	}
	// 	// const asrManualPair = langCodes.find(code => captionTracks.find
	// 	const asrPair = captionTracks.filter(
	// 		(track) =>
	// 			captionTracks.filter((t) => t.language_code == track.language_code)
	// 				.length > 1 &&
	// 			captionTracks.find(
	// 				(t) => t.language_code == track.language_code && t.kind == "asr"
	// 			) != null
	// 	);
	// 	if (asrPair.length == 0) {
	// 		const asrOnlyCap = captionTracks.find((track) => track.kind == "asr");
	// 		if (asrOnlyCap) {
	// 			const indexedStreams = new Array(captionTracks.length).fill(
	// 				null
	// 			) as (NodeJS.ReadableStream | null)[];
	// 			const asrStream = createReadStream(
	// 				path.join(captionsDir, asrOnlyCap.language_code + ".vtt")
	// 			);
	// 			indexedStreams[captionTracks.indexOf(asrOnlyCap)] = asrStream;
	// 			console.log("updating captions for " + v_id + " with single ASR");
	// 			const patched = await patchCaptions(
	// 				captionTracks,
	// 				// @ts-expect-error ldl
	// 				indexedStreams,
	// 				captionsDir,
	// 				fullUrlForClient,
	//				fullUrl,
	// 				v_id,
	// 				infoPath,
	// 				true
	// 			);
	// 			if (patched.length == 1) {
	// 				// remove old (bad) ASR caption
	// 				const oldCapPath = path.join(
	// 					captionsDir,
	// 					asrOnlyCap.language_code + ".vtt"
	// 				);
	// 				if (existsSync(oldCapPath)) {
	// 					unlinkSync(oldCapPath);
	// 				}
	// 			}
	// 		} else {
	// 			console.log(
	// 				"skipping, " + v_id + " due to no ASR pair and no single ASR"
	// 			);
	// 		}
	// 		continue;
	// 	}
	// 	if (asrPair.length != 2) {
	// 		console.log("skipping, " + v_id + " due to non-2len-ASR pair.");
	// 		continue;
	// 	}
	// 	let videoInfo: VideoInfo;
	// 	try {
	// 		videoInfo = await getYouTube()!.getInfo(v_id, { client: clientName });
	// 	} catch (error) {
	// 		console.log("skipping, " + v_id + " due to getVideoInfo error.");
	// 		await new Promise((r) => setTimeout(r, 21000));
	// 		continue;
	// 	}
	// 	const newCaptionTracks = videoInfo.captions?.caption_tracks;
	// 	const newCaptionStreams = await getCaptionStreams(newCaptionTracks);
	// 	if (newCaptionStreams.length == 0) {
	// 		console.log("skipping, " + v_id + " due to no new caption streams.");
	// 		continue;
	// 	}
	// 	console.log("updating complete captions for " + v_id);
	// 	const updatedCaptionTracks = await patchCaptions(
	// 		newCaptionTracks,
	// 		newCaptionStreams,
	// 		captionsDir,
	// 		fullUrlForClient,
	// 		v_id,
	// 		infoPath,
	// 		true
	// 	);
	// 	// if (updatedCaptionTracks.length == newCaptionStreams.length) {
	// 	// 	console.log("successfully updated captions for " + v_id);
	// 	// }
	// 	await new Promise((r) => setTimeout(r, 15000));
	// }
	// // update all the info.json files to be version 2
	// for (const v_id of Object.keys(archive)) {
	// 	const archiveEntryDir = path.join(archiveDir, v_id);
	// 	const infoPath = path.join(archiveEntryDir, "info.json");
	// 	const info = newArchiveFromJSON(
	// 		readFileSync(infoPath, "utf-8")
	// 	) as ArchiveInfoV1;
	// 	if (info.version == 1) {
	// 		info.version = 2;
	// 		writeFileSync(infoPath, JSON.stringify(info, null, 2));
	// 	}
	// }
	// console.log("done updating archive to version 2");
	// res.send("done");
});

router.get("/captions/:v_id", async (req, res) => {
	const v_id = req.params.v_id;
	let captionTracks: PlayerCaptionsTracklist | undefined = JSON.parse(
		JSON.stringify((await getCacheWait(v_id))?.captions)
	);

	if (captionTracks) {
		for (const ct of captionTracks?.caption_tracks || []) {
			for (let i = 0; i < 5; i++) {
				ct.base_url = ct.base_url.replace(defaultLocalUrl, fullUrlForClient);
			}
			console.log("serving caption with url as " + ct.base_url);
		}

		console.log("serving caption from cache or archive");
		res.json(captionTracks.caption_tracks);
		return;
	}
	res.json({});
});

router.get("/formats/:v_id", async (req, res) => {
	const v_id = req.params.v_id;
	const formats = (await getCacheWait(v_id))?.file_formats;
	if (formats) {
		res.json(formats);
	} else {
		res.json({});
	}
});

router.get("/youtubeformats/:v_id", async (req, res) => {
	const v_id = req.params.v_id;

	// call chooseFormat with a try for all possible permutations on // audio, video or video+audio, quality: 'best',
	// best, bestefficiency, 144p, 240p, 480p, 720p and so on.
	//format: 'mp4' // media container format
	let videoInfoFull: VideoInfo;
	try {
		// FIXME: do not load info multiple times
		videoInfoFull = await getYouTube()!.getInfo(v_id, { client: clientName });
	} catch (error) {
		console.log("error: " + error);
		res.status(503).send("Error: " + error);
		return;
	}

	const streamingData = videoInfoFull.getStreamingInfo();

	// const types = ['audio', 'video', 'video+audio'] as FormatOptions['type'][]
	// const qualities = [/* 'best', 'bestefficiency', */ '144p', '240p', '360', '480p', '720p'];
	// const formats = ['mp4'];
	// const formatOptions = [] as FormatOptions[];
	// for (const type of types) {
	// 	for (const quality of qualities) {
	// 		for (const format of formats) {
	// 			formatOptions.push({ type, quality, format });
	// 		}
	// 	}
	// }
	// const fileFormats = {} as { [key: string]: {
	// 	fmt: Format, type: FormatOptions['type'], quality: FormatOptions['quality'], has_av: boolean}
	// };
	// let i = 0;
	// for (const formatOpt of formatOptions) {
	// 	try {
	// 		const format = await videoInfoFull.chooseFormat(formatOpt);
	// 		fileFormats[format.itag + '.' + archiveContainer + "-" + (++i)] = { fmt: format, type: formatOpt.type, quality: formatOpt.quality, has_av: format.has_audio && format.has_video};
	// 	} catch (error) {
	// 		console.log('failed to get format: ' + error);
	// 		continue;
	// 	}
	// }
	// const sorted = Object.keys(fileFormats).sort((a, b) => fileFormats[a].fmt.bitrate - fileFormats[b].fmt.bitrate);
	// const sortedFormats = {} as { [key: string]:
	// 	{fmt: Format, type: FormatOptions['type'], quality: FormatOptions['quality'], has_av: boolean}
	// };
	// for (const key of sorted) {
	// 	sortedFormats[key] = fileFormats[key];
	// }
	// res.json({ formats: sortedFormats, streamingData: streams });
	const { avFormats, aFormats, vFormats } = await getSupportedFormats2(
		videoInfoFull
	);

	// const sortedAvFormatList = Object.entries(avFormats).sort((a, b) => a[1].bitrate - b[1].bitrate);
	// const sortedAFormatList = Object.entries(aFormats).sort((a, b) => a[1].bitrate - b[1].bitrate);
	// const sortedVFormatList = Object.entries(vFormats).sort((a, b) => a[1].bitrate - b[1].bitrate);
	return res.json({ avFormats, aFormats, vFormats, streamingData });
});

export default router;