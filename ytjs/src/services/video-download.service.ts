import { Readable } from "stream";
import { Format } from "../utils/yt-types";

/**
 * Represents a downloadable video stream from various sources
 */
export interface VideoStream {
  type: "video" | "audio" | "combined";
  quality?: string;
  codec?: string;
  bitrate?: number;
  width?: number;
  height?: number;
}

/**
 * Represents a downloadable caption track
 */
export interface CaptionStream {
  language: string;
  languageCode: string;
  name?: string;
  url: string;
}

/**
 * Options for downloading video content
 */
export interface VideoDownloadOptions {
  quality?: "best" | "worst" | string;
  format?: string;
  includeAudio?: boolean;
  includeVideo?: boolean;
  preferredQuality?: string;
  outputFormat?: string;
}

/**
 * Result of a video download operation
 */
export interface VideoDownloadResult {
  stream: Readable;
  format: Format | VideoStream;
  filename: string;
  mimeType: string;
}

/**
 * Base abstract class for video download services
 * Supports multiple platforms (YouTube, NicoNicoDouga, etc.)
 */
export abstract class VideoDownloadService {
  protected source: string;

  constructor(source: string) {
    this.source = source;
  }

  /**
   * Get the service source name
   */
  getSource(): string {
    return this.source;
  }

  /**
   * Download a video from the service
   * @param videoId - The video identifier
   * @param options - Download options
   * @returns A readable stream of the video data
   */
  abstract downloadVideo(
    videoId: string,
    options: VideoDownloadOptions
  ): Promise<VideoDownloadResult>;

  /**
   * Stream a video to an output file
   * @param videoId - The video identifier
   * @param outputPath - Path to save the output file
   * @param options - Download options
   */
  abstract streamToFile(
    videoId: string,
    outputPath: string,
    options: VideoDownloadOptions
  ): Promise<void>;

  /**
   * Get available streams for a video
   * @param videoId - The video identifier
   * @returns Array of available video streams
   */
  abstract getAvailableStreams(videoId: string): Promise<VideoStream[]>;

  /**
   * Get available captions for a video
   * @param videoId - The video identifier
   * @returns Array of available caption tracks
   */
  abstract getAvailableCaptions(videoId: string): Promise<CaptionStream[]>;

  /**
   * Download captions for a video
   * @param videoId - The video identifier
   * @param languageCode - The language code for captions (optional)
   * @returns A readable stream of the caption data
   */
  abstract downloadCaptions(
    videoId: string,
    languageCode?: string
  ): Promise<Readable | null>;
}
