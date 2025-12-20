import { spawn } from "child_process";
import { Readable, PassThrough } from "stream";
import { createWriteStream } from "fs";
import path from "path";
import {
  VideoDownloadService,
  VideoDownloadOptions,
  VideoDownloadResult,
  VideoStream,
  CaptionStream,
} from "./video-download.service";
import { Format } from "youtubei.js/dist/src/parser/misc";

/**
 * FFmpeg-based video download service
 * Handles streaming DASH manifests and converting them to MP4
 * Abstracts FFmpeg CLI operations for cross-platform video processing
 */
export class FFmpegService extends VideoDownloadService {
  private ffmpegPath: string;

  constructor(ffmpegPath: string = "ffmpeg") {
    super("ffmpeg");
    this.ffmpegPath = ffmpegPath;
  }

  /**
   * Get FFmpeg version
   */
  static async getVersion(ffmpegPath: string = "ffmpeg"): Promise<string | null> {
    return new Promise((resolve) => {
      const ffmpeg = spawn(ffmpegPath, ["-version"]);
      let output = "";

      ffmpeg.stdout.on("data", (data) => {
        output += data.toString();
      });

      ffmpeg.on("close", (code) => {
        if (code === 0) {
          const versionMatch = output.match(/ffmpeg version ([\d.]+)/);
          resolve(versionMatch ? versionMatch[1] : output.split("\n")[0]);
        } else {
          resolve(null);
        }
      });

      ffmpeg.on("error", () => {
        resolve(null);
      });
    });
  }

  /**
   * Check if FFmpeg is available on the system
   */
  static async isAvailable(ffmpegPath: string = "ffmpeg"): Promise<boolean> {
    const version = await this.getVersion(ffmpegPath);
    return version !== null;
  }

  /**
   * Download video by converting DASH manifest to MP4
   * @param manifestUrl - URL to the DASH manifest (MPD file)
   * @param options - Download options
   * @returns A readable stream of the video data
   */
  async downloadVideo(
    manifestUrl: string,
    options: VideoDownloadOptions = {}
  ): Promise<VideoDownloadResult> {
    const stream = this.streamDASHToMP4(manifestUrl, options);

    return {
      stream,
      format: {
        itag: "ffmpeg-dash",
        mime_type: "video/mp4",
        quality_label: options.quality || "best",
        has_video: true,
        has_audio: true,
      } as unknown as Format,
      filename: `video-${Date.now()}.mp4`,
      mimeType: "video/mp4",
    };
  }

  async mergeAV(inAudioPath: string,  inVideoPath: string, outPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        "-i",
        inVideoPath,
        "-i",
        inAudioPath,
        "-c",
        "copy",
        outPath,
      ];

      console.log(
        `[FFmpeg] Merging audio and video to: ${path.basename(outPath)}`
      );
      console.log(`[FFmpeg] Command: ${this.ffmpegPath} ${args.join(" ")}`);

      const ffmpeg = spawn(this.ffmpegPath, args);
      let errorOutput = "";

      ffmpeg.stderr.on("data", (data) => {
        const message = data.toString();
        errorOutput += message;
        // Log progress information
        if (message.includes("frame=")) {
          console.log(`[FFmpeg] ${message.trim()}`);
        }
      });

      ffmpeg.on("close", (code) => {
        if (code === 0) {
          console.log(`[FFmpeg] Merging completed successfully`);
          resolve();
        } else {
          console.error(`[FFmpeg] Process exited with code ${code}`);
          reject(
            new Error(
              `FFmpeg merging failed with exit code ${code}: ${errorOutput}`
            )
          );
        }
      });

      ffmpeg.on("error", (err) => {
        console.error(`[FFmpeg] Process error: ${err.message}`);
        reject(err);
      });
    });
  }

  /**
   * Stream DASH manifest directly to MP4 file using FFmpeg
   * Leverages FFmpeg's built-in HLS/DASH support for manifest processing
   * @param manifestUrl - URL to the DASH manifest
   * @param outputPath - Path to output MP4 file
   * @param options - Download options
   */
  async streamToFile(
    manifestUrl: string,
    outputPath: string,
    options: VideoDownloadOptions = {}
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        "-protocol_whitelist",
        "file,http,https,tcp,tls",
        "-allowed_extensions",
        "ALL",
        "-i",
        manifestUrl,
        "-c",
        "copy",
        "-bsf:a",
        "aac_adtstoasc",
        outputPath,
      ];

      console.log(
        `[FFmpeg] Starting DASH to MP4 conversion: ${path.basename(outputPath)}`
      );
      console.log(`[FFmpeg] Command: ${this.ffmpegPath} ${args.join(" ")}`);

      const ffmpeg = spawn(this.ffmpegPath, args);
      let errorOutput = "";

      ffmpeg.stderr.on("data", (data) => {
        const message = data.toString();
        errorOutput += message;
        // Log progress information
        if (message.includes("frame=")) {
          console.log(`[FFmpeg] ${message.trim()}`);
        }
      });

      ffmpeg.on("close", (code) => {
        if (code === 0) {
          console.log(`[FFmpeg] Conversion completed successfully`);
          resolve();
        } else {
          console.error(`[FFmpeg] Process exited with code ${code}`);
          reject(
            new Error(
              `FFmpeg conversion failed with exit code ${code}: ${errorOutput}`
            )
          );
        }
      });

      ffmpeg.on("error", (err) => {
        console.error(`[FFmpeg] Process error: ${err.message}`);
        reject(err);
      });
    });
  }

  /**
   * Stream DASH manifest to MP4 using FFmpeg, returning a readable stream
   * @param manifestUrl - URL to the DASH manifest
   * @param options - Download options
   * @returns A readable stream of the MP4 data
   */
  private streamDASHToMP4(
    manifestUrl: string,
    options: VideoDownloadOptions = {}
  ): Readable {
    const passThrough = new PassThrough();
    let ffmpegProcess: ReturnType<typeof spawn> | null = null;

    const startConversion = () => {
      const args = [
        "-protocol_whitelist",
        "file,http,https,tcp,tls",
        "-allowed_extensions",
        "ALL",
        "-i",
        manifestUrl,
        "-c",
        "copy",
        "-bsf:a",
        "aac_adtstoasc",
        "-f",
        "mp4",
        "-",
      ];

      console.log(
        `[FFmpeg] Starting DASH stream to MP4 conversion from manifest: ${manifestUrl.substring(0, 50)}...`
      );

      ffmpegProcess = spawn(this.ffmpegPath, args);

      // Pipe FFmpeg stdout to our PassThrough stream
      if (ffmpegProcess.stdout) {
        ffmpegProcess.stdout.pipe(passThrough);
      }

      let stderrData = "";
      if (ffmpegProcess.stderr) {
        ffmpegProcess.stderr.on("data", (data) => {
          const message = data.toString();
          stderrData += message;
          if (message.includes("frame=")) {
            console.log(`[FFmpeg] ${message.trim()}`);
          }
        });
      }

      ffmpegProcess.on("close", (code) => {
        if (code !== 0) {
          console.error(`[FFmpeg] Process exited with code ${code}`);
          passThrough.destroy(
            new Error(
              `FFmpeg process failed with exit code ${code}: ${stderrData}`
            )
          );
        } else {
          console.log(`[FFmpeg] Stream conversion completed`);
        }
      });

      ffmpegProcess.on("error", (err) => {
        console.error(`[FFmpeg] Process error: ${err.message}`);
        passThrough.destroy(err);
      });
    }

    // Start conversion when the stream is first read
    passThrough.on("resume", () => {
      if (!ffmpegProcess) {
        startConversion();
      }
    });

    // Ensure conversion starts if stream is piped
    if (passThrough.isPaused?.()) {
      passThrough.resume();
    } else {
      startConversion();
    }

    return passThrough;
  }

  /**
   * Get available streams from DASH manifest
   * Note: This is a placeholder implementation
   * In practice, you would parse the manifest to extract stream information
   */
  async getAvailableStreams(manifestUrl: string): Promise<VideoStream[]> {
    throw new Error("FFmpegService.getAvailableStreams not implemented. Parsing DASH manifests is required.");
    // console.log(
    //   `[FFmpeg] Querying available streams from: ${manifestUrl.substring(0, 50)}...`
    // );
    // // Would require parsing DASH manifest XML
    // // For now, return a generic stream
    // return [
    //   {
    //     type: "combined",
    //     quality: "best",
    //     codec: "h264",
    //   },
    // ];
  }

  /**
   * Get available captions from manifest URL
   * Note: This requires parsing the manifest XML
   */
  async getAvailableCaptions(manifestUrl: string): Promise<CaptionStream[]> {
    throw new Error("FFmpegService.getAvailableCaptions not implemented. Parsing DASH manifests is required.");
    console.log(
      `[FFmpeg] Querying captions from: ${manifestUrl.substring(0, 50)}...`
    );
    // Manifest typically doesn't include captions
    // Captions should be handled separately from the archive metadata
    return [];
  }

  /**
   * Download captions
   * Note: FFmpeg doesn't handle caption downloading from manifests
   * Use archive metadata for caption URLs
   */
  async downloadCaptions(manifestUrl: string): Promise<Readable | null> {
    throw new Error("FFmpegService.downloadCaptions not implemented. Use archive metadata for captions.");
    console.warn(
      "[FFmpeg] Caption downloading not supported via FFmpeg service. Use archive metadata instead."
    );
    return null;
  }
}
