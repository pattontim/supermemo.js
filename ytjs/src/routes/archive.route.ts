import { readFileSync, existsSync, renameSync, createWriteStream, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { Readable } from "stream";
import { ReadableStream as WebReadableStream } from "stream/web";
import { PlayerCaptionsTracklist } from "youtubei.js/dist/src/parser/nodes";
import { archive, archiveContainer, archiveDir, defaultLocalUrl, fetchWait, fullUrl, fullUrlForClient, getCacheWait, yti_version } from "../server";
import { ArchiveInfo, ArchiveInfoLatest, CacheInfoV3, latestArchiveConstructor, newArchiveFromJSON } from "../utils/archive";
import { CaptionTrack } from "../../../src/app/utils/types";
import { Format } from "youtubei.js/dist/src/parser/misc";
import { FormatOptions } from "youtubei.js/dist/src/types";
import { getLocalVideoInfo } from "../utils/localvideo";
import { Utils } from "youtubei.js";
import { Router } from "express";
import { Response } from "node-fetch";
import { FFmpegService } from "../services/ffmpeg.service";
import { deepCopy } from "../utils/lib";

const router = Router();

/**
 * Patch fs archive captions with the correct URL and save to disk. Updates both the captionTracks base url and rets updated.
 * Patches info.json if it exists
 * @param captionTracks
 * @param captionStreams
 * @param captionsDir
 * @param fullUrl
 * @param v_id
 * @param renameExisting
 * @returns the caption tracks that were updated
 */

export async function patchCaptions(
	captionTracks: PlayerCaptionsTracklist["caption_tracks"],
	captionStreams: (WebReadableStream<Uint8Array> | null)[],
	captionsDir: string,
	clientUrl: string,
	serverUrl: string,
	v_id: string,
	infoJsonPath: string | undefined,
	renameExisting: boolean
) {
	if (!captionTracks || !captionStreams) {
		console.warn("no caption tracks or streams found in patchCaptions");
		return [];
	}

	let info: ArchiveInfo | undefined;
	if (infoJsonPath) {
		info = newArchiveFromJSON(readFileSync(infoJsonPath, "utf-8"));
	}
	const updatedCaptionTracks = [];

	for (const captionTrack of captionTracks) {
		const captionStream = captionStreams.shift();
		if (captionStream && captionStream != null) {
			const captionFileName = formatCaptionFileName(captionTrack);
			const captionFilePath = path.join(captionsDir, captionFileName);

			if (renameExisting && existsSync(captionFilePath)) {
				const captionFileDir = path.dirname(captionFilePath);
				const captionFileBase = path.basename(
					captionFilePath,
					path.extname(captionFilePath)
				);
				// TODO don't hardcode the version number
				const newCaptionFilePath = path.join(
					captionFileDir,
					`${captionFileBase}_v2${path.extname(captionFilePath)}`
				);
				renameSync(captionFilePath, newCaptionFilePath);
			}

			const captionFile = createWriteStream(captionFilePath);
			const nodeStream = Readable.fromWeb(captionStream);

			await new Promise<void>((resolve, reject) => {
				nodeStream.pipe(captionFile);
				nodeStream.on("end", () => {
					resolve();
				});
				nodeStream.on("error", (err: Error) => {
					reject(err);
				});
			});

			captionFile.close();

			const preFix = "http://" + serverUrl + "/fixvtt/";
			const fsUrl = `http://${serverUrl}/archive/${v_id}/captions/${captionFileName}`;
			captionTrack.base_url = preFix + fsUrl;
			updatedCaptionTracks.push(captionTrack);
		}
	}

	if (updatedCaptionTracks.length != 0 && infoJsonPath) {
		if (!info || !info.captions || !info.captions.caption_tracks) {
			console.warn("info.json or its captions not found at path");
			return [];
		}
		// info.captions.caption_tracks = updatedCaptionTracks;
		if (existsSync(infoJsonPath)) {
			const infoFileDir = path.dirname(infoJsonPath);
			const infoFileBase = path.basename(
				infoJsonPath,
				path.extname(infoJsonPath)
			);
			let i = 0;
			let newInfoFilePath;
			do {
				newInfoFilePath = path.join(
					infoFileDir,
					`${infoFileBase}_old${i}${path.extname(infoJsonPath)}`
				);
				i++;
			} while (existsSync(newInfoFilePath));
			renameSync(infoJsonPath, newInfoFilePath);
		}
		// else if(updatedCaptionTracks.length != captionTracks.length){
		// 	throw new Error("captionsTrack didn't match expected length")
		// }
		for (const updatedCaptionTrack of updatedCaptionTracks) {
			const captionIndex = info.captions.caption_tracks.findIndex(
				(track) => track.vss_id == updatedCaptionTrack.vss_id
			);
			if (captionIndex != -1) {
				info.captions.caption_tracks[captionIndex] = updatedCaptionTrack;
			}
		}

		writeFileSync(infoJsonPath, JSON.stringify(info, null, 2));
	}

	return updatedCaptionTracks;
}/**
 * Get the caption streams from the caption tracks
 * @requires captionTracks to be from videoInfo.captions.caption_tracks
 */

export async function getCaptionStreams(
	captionTracks: PlayerCaptionsTracklist["caption_tracks"]
): Promise<WebReadableStream<Uint8Array>[]> {
	const captionStreams: WebReadableStream<Uint8Array>[] = [];
	for (const captionTrack of captionTracks ?? []) {
		// URL request
		const captionUrl = new URL(
			captionTrack.base_url
		);
		console.log("fetching caption url: " + captionUrl.href);
		console.time("fetch caption time");
		let captionResp = await fetchWait(captionUrl, true, 500, 50);
		console.timeEnd("fetch caption time");
		if (captionResp.status != 200) {
			console.warn("failed to fetch caption url: " + captionUrl.href + " status: " + captionResp.status);
			continue;
		}
		console.log("fetch successful for caption url");
		let captionBody = captionResp.body;
		if (!captionBody) {
			console.warn("caption body null for caption url: " + captionUrl.href);
			continue;
		}
		// @ts-expect-error node express types
		captionStreams.push(captionBody);
	}
	return captionStreams;
}

// FIXME: the impl is not broken but it won't work w/ YT since proxying data is not possible 
/**
 * Download video using MPD fallback method
 * Retrieves the DASH manifest from cache and uses FFmpeg to convert it to MP4
 * @param v_id - Video ID
 * @param archiveEntryDir - Directory to save the video
 * @param quality - Preferred quality (best, 1080p, 720p, etc.)
 * @returns Object with filename, format info, or null if failed
 */
async function downloadVideoViaMPDFallback(
	v_id: string,
	archiveEntryDir: string,
	quality: string = "best"
): Promise<{ filename: string; format: Format } | null> {
	if (!globalThis.ffmpeg_version) {
		console.warn("FFmpeg not available, cannot use MPD fallback");
		return null;
	}

	console.log(`[MPD Fallback] Attempting to download video ${v_id} using FFmpeg`);

	try {
		// Get cache info which contains the MPD manifest
		const cacheInfo = (await getCacheWait(v_id)) as CacheInfoV3 | undefined;
		if (!cacheInfo || !cacheInfo.mpd_manifest) {
			console.log("[MPD Fallback] No cached manifest found, attempting to generate one");
			// If no cache, we need to fetch the manifest first
			// This would require access to the video info and toDash() call
			// For now, return null as this requires more context
			return null;
		}

		console.log("[MPD Fallback] Found cached MPD manifest");

		// Save the manifest temporarily
		const tempManifestPath = path.join(archiveEntryDir, `manifest_temp_${Date.now()}.mpd`);
		const patchedTempManifest = deepCopy(cacheInfo.mpd_manifest).replaceAll("http://10.0.2.2", "http://localhost")
		writeFileSync(tempManifestPath, patchedTempManifest);

		// Use FFmpeg to convert the manifest to MP4
		const ffmpegService = new FFmpegService();
		const outputFilename = `video_${v_id}_${quality}.${archiveContainer}`;
		const outputPath = path.join(archiveEntryDir, outputFilename);

		console.log(`[MPD Fallback] Converting manifest to MP4: ${outputFilename}`);
		await ffmpegService.streamToFile(tempManifestPath, outputPath, {
			quality,
			format: archiveContainer,
			includeAudio: true,
			includeVideo: true,
		});

		// Clean up temp manifest
		try {
			if (existsSync(tempManifestPath)) {
				const fs = require("fs");
				fs.unlinkSync(tempManifestPath);
			}
		} catch (err) {
			console.warn(`[MPD Fallback] Failed to clean up temp manifest: ${err}`);
		}

		console.log("[MPD Fallback] Video download completed successfully");

		// Return format info
		const format = {
			itag: "ffmpeg-mpd-fallback",
			mime_type: "video/mp4",
			quality_label: quality,
			has_video: true,
			has_audio: true,
		} as unknown as Format;

		return {
			filename: outputFilename,
			format,
		};
	} catch (error) {
		console.error(`[MPD Fallback] Error: ${error}`);
		return null;
	}
}

export function formatCaptionFileName(captionTrack: CaptionTrack) {
	let capFilename = captionTrack.vss_id + ".vtt";
	if (capFilename.startsWith(".")) {
		//remove leading dot to allow reading from static file server
		capFilename = capFilename.substring(1);
	}
	return capFilename;
}
export const captionsCodeWhitelist = ["en", "fr", "ja"];

router.get("/archive/:v_id", async (req, res) => {
	const v_id = req.params.v_id;
	const shouldArchiveVideo = req.query.video === 'true';
	const shouldArchiveCaptions = req.query.captions === 'true';
	const shouldOverwrite = req.query.overwrite === 'true';
	const shouldArchive = shouldArchiveVideo || shouldArchiveCaptions;
	const shouldUseMPDFallback = req.query.mpd_fallback === 'true';

	console.log(`archive request for ${v_id} (video: ${shouldArchiveVideo}, captions: ${shouldArchiveCaptions}, overwrite: ${shouldOverwrite})`);

	// Return existing format if just querying and video exists
	if (shouldArchive === false && archive[v_id]?.file_formats) {
		const vid_files = Object.keys(archive[v_id].file_formats);
		const vid_formats = vid_files.map((file) => ({
			itag: file,
			url: `http://${fullUrlForClient}/archive/${v_id}/${file}`,
		}));
		res.status(200).send(vid_formats[0]);
		return;
	}

	if (!shouldArchive) {
		console.log("nothing to archive, exiting");
		res.status(400).send("Nothing to archive, specify video=true or captions=true");
		return;
	}


	let videoInfoFull = ((await getCacheWait(v_id)) as CacheInfoV3 | undefined)?.ytiVidInfo;
	if (!videoInfoFull) {
		videoInfoFull = await getLocalVideoInfo(v_id);
	}

	let newInfo: ArchiveInfoLatest;
	try {
		newInfo = latestArchiveConstructor(videoInfoFull, yti_version);
	} catch (error) {
		console.log("archive constructor error: " + error);
		res.status(503).send("Error: " + error);
		return;
	}

	const archiveEntryDir = path.join(archiveDir, v_id);
	if (!existsSync(archiveEntryDir)) {
		try {
			mkdirSync(archiveEntryDir);
		} catch (error) {
			console.log("archive dir creation error: " + error);
			res.status(507).send("Error: " + error);
			return;
		}
	}

	// Backup existing info.json if it exists
	const infoPath = path.join(archiveEntryDir, "info.json");
	let existingInfo: ArchiveInfo | undefined;
	if (existsSync(infoPath)) {
		if (!shouldOverwrite) {
			console.log("archive info exists and overwrite not set, exiting");
			res.status(400).send("Archive info exists, skipping as overwrite not set");
			return;
		}

		existingInfo = newArchiveFromJSON(readFileSync(infoPath, "utf-8"));

		if (!existingInfo) {
			console.log("existing archive info invalid, skipping backup and exiting");
			existingInfo = undefined;
			res.status(503).send("Error: existing archive info invalid or nonexistent");
			return;
		} else {
			console.log("existing archive info found, backing up");
		}

		// Merge existing info to preserve non-updated parts
		if (!shouldArchiveVideo && existingInfo.file_formats) {
			newInfo.file_formats = existingInfo.file_formats;
		}
		if (!shouldArchiveCaptions && existingInfo.captions) {
			newInfo.captions = existingInfo.captions;
		}

		// Create backup
		const infoFileDir = path.dirname(infoPath);
		const infoFileBase = path.basename(infoPath, path.extname(infoPath));
		let i = 0;
		let backupPath;
		do {
			backupPath = path.join(
				infoFileDir,
				`${infoFileBase}_old${i}${path.extname(infoPath)}`
			);
			i++;
		} while (existsSync(backupPath));
		renameSync(infoPath, backupPath);
	}

	// Handle video archiving
	if (shouldArchiveVideo) {
		const quality = (req.query.quality as string) || "best";
		let videoDownloadSuccess = false;

		if (!shouldUseMPDFallback) {
			const best_format = {
				type: req.query.type ? req.query.type : "video+audio",
				quality: req.query.quality ? req.query.quality : "best",
				format: req.query.format ? req.query.format : "mp4",
			} as FormatOptions;

			console.log("choosing format: " + JSON.stringify(best_format));
			let format = await videoInfoFull.chooseFormat(best_format);

			if (!(format.has_video && format.has_audio)) {
				console.log("Format missing video/audio, upgrading to best quality");
				format = await videoInfoFull.chooseFormat({
					type: "video+audio",
					quality: "best",
					format: "mp4",
				} as FormatOptions);
			}

			const fileNameItag = format.itag + "." + archiveContainer;
			let stream;
			try {
				console.log(`downloading video format ${format.quality_label} ${format.itag}`);
				stream = await videoInfoFull.download(best_format);

				const file = createWriteStream(path.join(archiveEntryDir, fileNameItag));
				for await (const chunk of Utils.streamToIterable(stream)) {
					file.write(chunk);
				}
				file.close();

				const fileFormats: { [key: string]: Format; } = {};
				fileFormats[format.itag + "." + archiveContainer] = format;
				newInfo.file_formats = fileFormats;
				videoDownloadSuccess = true;
			} catch (error) {
				console.log("error during video download: " + error);
				console.log("attempting MPD fallback download...");
				
				// Try MPD fallback if standard download fails
				const fallbackResult = await downloadVideoViaMPDFallback(v_id, archiveEntryDir, quality);
				if (fallbackResult) {
					const fileFormats: { [key: string]: Format; } = {};
					fileFormats[fallbackResult.filename] = fallbackResult.format;
					newInfo.file_formats = fileFormats;
					videoDownloadSuccess = true;
				} else {
					res.status(503).send("Error: Video download failed and MPD fallback unavailable");
					return;
				}
			} finally {
				if (stream) stream.cancel();
			}
		} else {
			// Use MPD fallback explicitly
			console.log("using mpd fallback for video download");
			const fallbackResult = await downloadVideoViaMPDFallback(v_id, archiveEntryDir, quality);
			if (fallbackResult) {
				const fileFormats: { [key: string]: Format; } = {};
				fileFormats[fallbackResult.filename] = fallbackResult.format;
				newInfo.file_formats = fileFormats;
				videoDownloadSuccess = true;
			} else {
				res.status(503).send("Error: MPD fallback download failed or FFmpeg not available");
				return;
			}
		}

		if (!videoDownloadSuccess) {
			res.status(503).send("Error: Video download failed");
			return;
		}
	}

	// Handle captions archiving
	let captionsFailed = false;
	if (shouldArchiveCaptions && newInfo.captions) {
		const captionsDir = path.join(archiveEntryDir, "captions");
		if (!existsSync(captionsDir)) {
			try {
				mkdirSync(captionsDir);
			} catch (error) {
				console.log("captions dir creation error: " + error);
				res.status(507).send("Error: " + error);
				return;
			}
		}

		// Filter and prepare caption tracks
		let captionTracks = newInfo.captions.caption_tracks?.filter(
			ct => captionsCodeWhitelist.indexOf(ct.language_code) != -1
		);
		newInfo.captions.caption_tracks = captionTracks;

		if (captionTracks?.length) {
			for (const ct of captionTracks) {
				for (let i = 0; i < 5; i++) {
					ct.base_url = ct.base_url.replace(fullUrlForClient, defaultLocalUrl);
				}
			}

			console.log("whitelisted caption tracks: " + JSON.stringify(captionTracks));

			let captionStreams = [] as WebReadableStream<Uint8Array>[];
			try {
				captionStreams = await getCaptionStreams(captionTracks);

				if (captionStreams.length === 0) {
					console.log("error: empty caption streams");
					captionsFailed = true;
					newInfo.captions.caption_tracks = newInfo.captions.caption_tracks?.map(ct => ({
						...ct,
						base_url: "http://" + fullUrl + "/fixvtt/" + `http://${fullUrl}/dummy-vtt.vtt`
					}));
				} else {
					const updatedCaptionTracks = await patchCaptions(
						captionTracks,
						captionStreams,
						captionsDir,
						fullUrlForClient,
						fullUrl,
						v_id,
						undefined,
						shouldOverwrite
					);

					if (updatedCaptionTracks.length > 0) {
						for (let i = 0; i < updatedCaptionTracks.length; i++) {
							newInfo.captions.caption_tracks![i] = updatedCaptionTracks[i];
						}
					}
				}
			} catch (error) {
				console.log("caption processing error: " + error);
				res.status(503).send("Error: Caption processing failed");
				return;
			}
		}
	}

	try {
		writeFileSync(infoPath, JSON.stringify(newInfo, null, 2));
		archive[v_id] = newInfo;
		console.log(`archiving completed - video: ${shouldArchiveVideo}, captions: ${shouldArchiveCaptions}, captionsFailed: ${captionsFailed}`);
		res.status(200).send("OK");
	} catch (error) {
		console.log("error writing info.json: " + error);
		res.status(507).send("Error: Failed to write info.json");
		return;
	}
});

export default router;

