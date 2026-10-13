import { readFileSync, existsSync, renameSync, createWriteStream, writeFileSync, mkdirSync, unlinkSync } from "fs";
import path from "path";
import { Readable } from "stream";
import { ReadableStream as WebReadableStream } from "stream/web";
import { PlayerCaptionsTracklist } from "../utils/yt-types";
import { archive, archiveContainer, archiveDir, defaultLocalUrl, fetchWait, fullUrl, fullUrlForClient, getCacheWait, yti_version } from "../server";
import { ArchiveInfo, ArchiveInfoLatest, CacheInfoV3, latestArchiveConstructor, newArchiveFromJSON } from "../utils/archive";
import { CaptionTrack } from "../../../src/app/utils/types";
import { Format } from "../utils/yt-types";
import { FormatOptions } from "../utils/yt-types";
import { getLocalVideoInfo } from "../utils/localvideo";
import { Utils } from "youtubei.js";
import { Router } from "express";
import { Response } from "node-fetch";
import { IE11_ITAG_PRESETS, IE11Quality, YtdlpService } from "../services/ytdlp.service";
import { deepCopy } from "../utils/lib";
import { FFmpegService } from "../services/ffmpeg.service";
import { normalizeCaptions } from "../utils/caption-cleanup";

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
 * @param cleanupCaptions Whether to normalize caption content (remove formatting issues, IE11 incompatibilities)
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
	renameExisting: boolean,
	cleanupCaptions: boolean = false
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

			if (cleanupCaptions) {
				// Read stream content, apply normalization, then write
				const chunks: Uint8Array[] = [];
				const reader = captionStream.getReader();

				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						chunks.push(value);
					}
				} finally {
					reader.releaseLock();
				}

				const buffers = chunks.map(chunk => Buffer.from(chunk));
				const buffer = Buffer.concat(buffers as any);
				const vttContent = buffer.toString('utf-8');
				const normalizedContent = normalizeCaptions(vttContent);

				writeFileSync(captionFilePath, normalizedContent, 'utf-8');
			} else {
				// Original behavior: pipe stream directly to file
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
			}

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
	const cleanupCaptions = req.query.cleanup === 'true';
	const shouldArchive = shouldArchiveVideo || shouldArchiveCaptions;
	const downloadStrategy = (req.query.strategy as string) || "standard"; // 'standard' or 'ytdlp'

	console.log(`archive request for ${v_id} (video: ${shouldArchiveVideo}, captions: ${shouldArchiveCaptions}, overwrite: ${shouldOverwrite}, cleanup: ${cleanupCaptions})`);

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
		const quality = (req.query.quality as IE11Quality) || "360p";
		let videoDownloadSuccess = false;

		try {
			if (downloadStrategy === "ytdlp") {
				// Use yt-dlp service for download
				console.log(`[Video] Using yt-dlp strategy for download with quality ${quality}`);
				
				const ytdlpService = new YtdlpService();
				const videoUrl = `https://www.youtube.com/watch?v=${v_id}`;
				
				const options = {
					quality: quality,
					includeAudio: true,
					includeVideo: true,
				};

				const formatSpec = ytdlpService.buildFormatSpec(options);

				const fileNameItag = formatSpec + "." + archiveContainer;
				const outputPath = path.join(archiveEntryDir, fileNameItag);
		
				console.log(`[Video] Downloading to: ${outputPath}`);
				await ytdlpService.streamToFile(videoUrl, outputPath, options);
				
				const fileFormats: { [key: string]: Format; } = {};
				fileFormats[fileNameItag] = {
					itag: formatSpec,
					mime_type: "video/mp4",
					quality_label: quality,
					has_video: true,
					has_audio: true,
				} as unknown as Format;
				newInfo.file_formats = fileFormats;
				videoDownloadSuccess = true;
				console.log(`[Video] yt-dlp download completed successfully`);
			} else if (downloadStrategy === "standard") {
				// Use standard YouTubei method for download
				console.log(`[Video] Using standard strategy for download with quality ${quality}`);
				
				const best_format = {
					type: req.query.type ? req.query.type : "video+audio",
					quality: req.query.quality ? req.query.quality : "best",
					format: req.query.format ? req.query.format : "mp4",
				} as FormatOptions;

				console.log("[Video] choosing format: " + JSON.stringify(best_format));
				let format = await videoInfoFull.chooseFormat(best_format);

				if (!(format.has_video && format.has_audio)) {
					console.log("[Video] Format missing video/audio, upgrading to best quality");
					format = await videoInfoFull.chooseFormat({
						type: "video+audio",
						quality: "best",
						format: "mp4",
					} as FormatOptions);
				}

				const fileNameItag = format.itag + "." + archiveContainer;
				let stream;
				try {
					console.log(`[Video] downloading video format ${format.quality_label} ${format.itag}`);
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
					console.log(`[Video] standard download completed successfully`);
				} catch(e) {
					console.log(`[Video] standard download failed`, e);

					const fFmpegService = new FFmpegService();
					console.log(`[Video] standard download failed, attempting ffmpeg fallback`);
					const tempAudioPath = path.join(archiveEntryDir, `temp-audio-${Date.now()}.mp4`);
					const tempVideoPath = path.join(archiveEntryDir, `temp-video-${Date.now()}.mp4`);
					const outputPath = path.join(archiveEntryDir, fileNameItag);

					// TODO: select based on browser
					const preset = IE11_ITAG_PRESETS[quality as IE11Quality];
					const audioStream = await videoInfoFull.download({
						itag: preset.audio
					});
					const videoStream = await videoInfoFull.download({
						itag: preset.video
					});

					// use promise.all to write chunks same time
					await Promise.all([
					new Promise<void>(async (resolve, reject) => {
						try {
						const file = createWriteStream(tempAudioPath);
						file.on('error', reject);

						for await (const chunk of Utils.streamToIterable(audioStream)) {
							if (!file.write(chunk)) {
								console.log("waiting for drain...");
							await new Promise(res => file.once('drain', res));
							}
						}

						file.end(() => {
							file.removeAllListeners();
							resolve();
						});
						} catch (err) {
						reject(err);
						}
					}),

					new Promise<void>(async (resolve, reject) => {
						try {
						const file = createWriteStream(tempVideoPath);
						file.on('error', reject);

						for await (const chunk of Utils.streamToIterable(videoStream)) {
							if (!file.write(chunk)) {
							await new Promise(res => file.once('drain', res));
							}
						}

						file.end(() => {
							file.removeAllListeners();
							resolve();
						});
						} catch (err) {
						reject(err);
						}
					})
					]);

					await fFmpegService.mergeAV(
						tempAudioPath,
						tempVideoPath,
						outputPath
					);

					// Clean up temp files
					try {
						if (existsSync(tempAudioPath)) {
							unlinkSync(tempAudioPath);
						}
						if (existsSync(tempVideoPath)) {
							unlinkSync(tempVideoPath);
						}
					} catch (error) {
						console.warn(`[FFmpeg] Temporary file cleanup error: ${error}`);
					}

					const combinedItag = preset.video + "+" + preset.audio;
					const combinedItagFileName = combinedItag + "." + archiveContainer;

					const fileFormats: { [key: string]: Format; } = {};
					fileFormats[combinedItagFileName] = {
						itag: combinedItag,
						mime_type: "video/mp4",
						quality_label: quality,
						has_video: true,
						has_audio: true,
						last_modified: new Date(),
						last_modified_ms: Date.now(),
						bitrate: -1,
						approx_duration_ms: -1, 
						// videoInfoFull.basic_info.duration,
						is_type_otf: -1,
						has_text: false,
						decipher: -1
					} as unknown as Format;
					newInfo.file_formats = fileFormats;
					videoDownloadSuccess = true;
					console.log(`[Video] ffmpeg fallback download completed successfully`);
				} finally {
					if (stream) stream.cancel();
				}
			} else {
				res.status(400).send(`Error: Unknown download strategy '${downloadStrategy}'. Use 'standard' or 'ytdlp'`);
				return;
			}
		} catch (error) {
			console.error(`[Video] Download error: ${error}`);
			res.status(503).send(`Error: Video download failed - ${error}`);
			return;
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
						shouldOverwrite,
						cleanupCaptions
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

