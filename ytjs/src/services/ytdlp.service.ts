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
import { Format } from "../utils/yt-types";

/**
 * IE11 compatible itag mappings for video and audio
 * These combinations ensure compatibility with older browsers while providing good quality
 */
export const IE11_ITAG_PRESETS = {
  "360p": { video: 134, audio: 140, label: "360p (H.264 + AAC)" },
  "480p": { video: 135, audio: 140, label: "480p (H.264 + AAC)" },
  "720p": { video: 136, audio: 140, label: "720p (H.264 + AAC)" },
  "1080p": { video: 137, audio: 140, label: "1080p (H.264 + AAC)" },
} as const;

export type IE11Quality = keyof typeof IE11_ITAG_PRESETS;

/**
 * yt-dlp based video download service
 * Provides reliable video downloading with IE11 compatibility presets
 * Uses ffmpeg for merging video and audio streams
 */
export class YtdlpService extends VideoDownloadService {
  private ytdlpPath: string;

  constructor(ytdlpPath: string = "yt-dlp") {
    super("yt-dlp");
    this.ytdlpPath = ytdlpPath;
  }

  /**
   * Get yt-dlp version
   */
  static async getVersion(ytdlpPath: string = "yt-dlp"): Promise<string | null> {
    return new Promise((resolve) => {
      const ytdlp = spawn(ytdlpPath, ["--version"]);
      let output = "";

      ytdlp.stdout.on("data", (data) => {
        output += data.toString();
      });

      ytdlp.on("close", (code) => {
        if (code === 0) {
          resolve(output.trim());
        } else {
          resolve(null);
        }
      });

      ytdlp.on("error", () => {
        resolve(null);
      });
    });
  }

  /**
   * Check if yt-dlp is available on the system
   */
  static async isAvailable(ytdlpPath: string = "yt-dlp"): Promise<boolean> {
    const version = await this.getVersion(ytdlpPath);
    return version !== null;
  }

  /**
   * Download video using yt-dlp
   * @param videoUrl - URL to the video
   * @param options - Download options
   * @returns A readable stream of the video data
   */
  async downloadVideo(
    videoUrl: string,
    options: VideoDownloadOptions = {}
  ): Promise<VideoDownloadResult> {
    const stream = this.streamVideo(videoUrl, options);

    return {
      stream,
      format: {
        itag: options.quality || "best",
        mime_type: "video/mp4",
        quality_label: options.quality || "best",
        has_video: true,
        has_audio: true,
      } as unknown as Format,
      filename: `video-${Date.now()}.mp4`,
      mimeType: "video/mp4",
    };
  }

  /**
   * Stream video directly to MP4 file using yt-dlp
   * Supports both quality presets and custom itag pairs
   * @param videoUrl - URL to the video
   * @param outputPath - Path to output MP4 file
   * @param options - Download options
   */
  async streamToFile(
    videoUrl: string,
    outputPath: string,
    options: VideoDownloadOptions = {}
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const formatSpec = this.buildFormatSpec(options);
      
      const args = [
        "-f",
        formatSpec,
        "--merge-output-format",
        "mp4",
      ];
      if (options.cookies) {
        args.push("--add-headers", `Cookie:${options.cookies}`);
      }
      if (options.socketTimeoutSec) {
        // Slow links: yt-dlp's default 20s read timeout aborts the metadata
        // fetch (nvapi.nicovideo.jp) before a single segment is requested.
        args.push("--socket-timeout", String(options.socketTimeoutSec));
        args.push("--retries", "10", "--fragment-retries", "10");
      }
      if (options.forceOverwrite) {
        // Without this yt-dlp sees the existing output file and exits 0
        // without downloading anything, so a re-archive silently keeps the
        // old bytes.
        args.push("--force-overwrites");
      }
      args.push("-o", outputPath, videoUrl);

      console.log(
        `[yt-dlp] Starting download: ${path.basename(outputPath)}`
      );
      console.log(`[yt-dlp] Format: ${formatSpec}`);
      console.log(`[yt-dlp] Command: ${this.ytdlpPath} ${args.join(" ")}`);

      const ytdlp = spawn(this.ytdlpPath, args);
      let errorOutput = "";

      ytdlp.stderr.on("data", (data) => {
        const message = data.toString();
        errorOutput += message;
        // Log progress information
        if (message.includes("[download]")) {
          console.log(`[yt-dlp] ${message.trim()}`);
        }
      });

      ytdlp.on("close", (code) => {
        if (code === 0) {
          console.log(`[yt-dlp] Download completed successfully`);
          resolve();
        } else {
          console.error(`[yt-dlp] Process exited with code ${code}`);
          reject(
            new Error(
              `yt-dlp download failed with exit code ${code}: ${errorOutput}`
            )
          );
        }
      });

      ytdlp.on("error", (err) => {
        console.error(`[yt-dlp] Process error: ${err.message}`);
        reject(err);
      });
    });
  }

  /**
   * Stream video to MP4 using yt-dlp, returning a readable stream
   * @param videoUrl - URL to the video
   * @param options - Download options
   * @returns A readable stream of the MP4 data
   */
  private streamVideo(
    videoUrl: string,
    options: VideoDownloadOptions = {}
  ): Readable {
    const passThrough = new PassThrough();
    let ytdlpProcess: ReturnType<typeof spawn> | null = null;

    const startDownload = () => {
      const formatSpec = this.buildFormatSpec(options);
      
      const args = [
        "-f",
        formatSpec,
        "--merge-output-format",
        "mp4",
      ];
      if (options.cookies) {
        args.push("--add-headers", `Cookie:${options.cookies}`);
      }
      if (options.socketTimeoutSec) {
        args.push("--socket-timeout", String(options.socketTimeoutSec));
        args.push("--retries", "10", "--fragment-retries", "10");
      }
      args.push("-o", "-", videoUrl);

      console.log(
        `[yt-dlp] Starting video stream download from: ${videoUrl.substring(0, 50)}...`
      );
      console.log(`[yt-dlp] Format: ${formatSpec}`);

      ytdlpProcess = spawn(this.ytdlpPath, args);

      // Pipe yt-dlp stdout to our PassThrough stream
      if (ytdlpProcess.stdout) {
        ytdlpProcess.stdout.pipe(passThrough);
      }

      let stderrData = "";
      if (ytdlpProcess.stderr) {
        ytdlpProcess.stderr.on("data", (data) => {
          const message = data.toString();
          stderrData += message;
          if (message.includes("[download]")) {
            console.log(`[yt-dlp] ${message.trim()}`);
          }
        });
      }

      ytdlpProcess.on("close", (code) => {
        if (code !== 0) {
          console.error(`[yt-dlp] Process exited with code ${code}`);
          passThrough.destroy(
            new Error(
              `yt-dlp process failed with exit code ${code}: ${stderrData}`
            )
          );
        } else {
          console.log(`[yt-dlp] Stream download completed`);
        }
      });

      ytdlpProcess.on("error", (err) => {
        console.error(`[yt-dlp] Process error: ${err.message}`);
        passThrough.destroy(err);
      });
    };

    // Start download when the stream is first read
    passThrough.on("resume", () => {
      if (!ytdlpProcess) {
        startDownload();
      }
    });

    // Ensure download starts if stream is piped
    if (passThrough.isPaused?.()) {
      passThrough.resume();
    } else {
      startDownload();
    }

    return passThrough;
  }

  /**
   * Build format specification string for yt-dlp
   * Supports both IE11 presets and custom itag pairs
   * @param options - Download options with quality or custom itags
   * @returns Format specification string
   */
  public buildFormatSpec(options: VideoDownloadOptions): string {
    // Check if custom itags are provided
    if (
      options.format &&
      options.format.includes("+")
    ) {
      // Custom itag pair provided (e.g., "134+140")
      return options.format;
    }

    // Niconico does not use YouTube itags; select by height instead.
    if (options.platform === "niconico") {
      const q = options.quality || "720p";
      if (q === "best") return "best";
      if (q === "worst") return "worst";
      const heightMap: Record<string, number> = {
        "360p": 360,
        "480p": 480,
        "720p": 720,
        "1080p": 1080,
      };
      const h = heightMap[q] ?? 720;
      return `bv*[height<=${h}]+ba/b[height<=${h}]/best`;
    }

    const quality = (options.quality || "720p") as IE11Quality;

    // Check if it's a valid IE11 preset
    if (quality in IE11_ITAG_PRESETS) {
      const preset = IE11_ITAG_PRESETS[quality];
      return `${preset.video}+${preset.audio}`;
    }

    // Check if quality is in format "XXXp" (e.g., "1080p")
    if (quality.endsWith("p")) {
      // Try to find best matching preset
      const heightMap: { [key: string]: IE11Quality } = {
        "360p": "360p",
        "480p": "480p",
        "720p": "720p",
        "1080p": "1080p",
      };
      const fallbackQuality = heightMap[quality] || "720p";
      const preset = IE11_ITAG_PRESETS[fallbackQuality];
      console.warn(
        `[yt-dlp] Quality ${quality} not in IE11 presets, using ${fallbackQuality}`
      );
      return `${preset.video}+${preset.audio}`;
    }

    // Default to 720p
    const defaultPreset = IE11_ITAG_PRESETS["720p"];
    return `${defaultPreset.video}+${defaultPreset.audio}`;
  }

  /**
   * Filesystem-safe label for a format spec (used in archive filenames).
   * The raw spec contains characters (`/`, `*`, `[`, `]`) that are illegal or
   * ugly in paths, so NND archives are labelled by quality instead.
   */
  public formatSpecToFilenameLabel(options: VideoDownloadOptions): string {
    if (options.platform === "niconico") {
      return (options.quality || "720p").replace(/[^a-zA-Z0-9._-]/g, "");
    }
    return this.buildFormatSpec(options).replace(/[^a-zA-Z0-9._+-]/g, "");
  }

  /**
   * Select itags by quality level
   * @param quality - Quality level (360p, 480p, 720p) or custom itag pair
   * @returns Video and audio itags
   */
  selectItags(quality: string = "720p"): { video: number; audio: number } {
    if (quality in IE11_ITAG_PRESETS) {
      const preset = IE11_ITAG_PRESETS[quality as IE11Quality];
      return { video: preset.video, audio: preset.audio };
    }

    // Parse custom itag format (e.g., "134+140")
    if (quality.includes("+")) {
      const [videoItag, audioItag] = quality.split("+").map(Number);
      if (!isNaN(videoItag) && !isNaN(audioItag)) {
        return { video: videoItag, audio: audioItag };
      }
    }

    // Default to 720p
    const defaultPreset = IE11_ITAG_PRESETS["720p"];
    return { video: defaultPreset.video, audio: defaultPreset.audio };
  }

  /**
   * Get available streams from video URL
   * Note: This would require parsing the yt-dlp output, implementation depends on use case
   */
  async getAvailableStreams(videoUrl: string): Promise<VideoStream[]> {
    return [
      {
        type: "combined",
        quality: "360p",
        codec: "h264",
      },
      {
        type: "combined",
        quality: "480p",
        codec: "h264",
      },
      {
        type: "combined",
        quality: "720p",
        codec: "h264",
      },
    ];
  }

  /**
   * Get available captions from video URL
   * Note: Requires parsing yt-dlp subtitle output
   */
  async getAvailableCaptions(videoUrl: string): Promise<CaptionStream[]> {
    throw new Error(
      "YtdlpService.getAvailableCaptions not fully implemented. Use archive metadata for captions."
    );
  }

  /**
   * Download captions
   * Note: Captions should be handled separately from video download
   */
  async downloadCaptions(videoUrl: string): Promise<Readable | null> {
    throw new Error(
      "YtdlpService.downloadCaptions not implemented. Use archive metadata for captions."
    );
  }
}
