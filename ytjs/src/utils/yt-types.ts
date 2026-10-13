/*
 * Central re-export of the youtubei.js types/values this project uses.
 *
 * Historically these were deep-imported from `youtubei.js/dist/src/...`, which
 * only resolves under the legacy "node" moduleResolution. The package's
 * `exports` map does NOT expose the `dist` tree, so those paths break under the
 * modern "node16"/"nodenext" resolution (and are not semver-stable anyway).
 *
 * Everything below is pulled from the public entry point instead.
 */
import { Misc, YT, YTNodes } from "youtubei.js";
import type { Types } from "youtubei.js";

// Misc.Format — video/audio format metadata
export const Format = Misc.Format;
export type Format = Misc.Format;

// YT.VideoInfo — full video info returned by Innertube#getInfo
export const VideoInfo = YT.VideoInfo;
export type VideoInfo = YT.VideoInfo;

// YTNodes.PlayerCaptionsTracklist — caption track list node
export const PlayerCaptionsTracklist = YTNodes.PlayerCaptionsTracklist;
export type PlayerCaptionsTracklist = YTNodes.PlayerCaptionsTracklist;

// Types.FormatOptions / Types.InnerTubeClient — option/union types
export type FormatOptions = Types.FormatOptions;
export type InnerTubeClient = Types.InnerTubeClient;
