import { Format } from 'youtubei.js/dist/src/parser/misc';
import { PlayerCaptionsTracklist } from 'youtubei.js/dist/src/parser/nodes';
import { VideoInfo } from 'youtubei.js/dist/src/parser/youtube';
import { deepCopy } from './lib';

export class ArchiveInfoV1 {
  version: number;
  captions?: PlayerCaptionsTracklist;  
  game_info?: any;
  // primary_info
  title: string;
  published: string;
  relative_date: string;
  // secondary_info
  author_name: string; // owner.author.name
  author_channel_id: string; // owner.author.id
  author_channel_url: string; // owner.author.url
  description: string; // description

  yti_version: string;
  archived_on: string; //set to indicate it was archived
  file_formats: { [filename: string]: Format };

// FIXME: primaryInfo is only available implictely if getInfo and not getBasicInfo is used
// getBasicInfo is sufficient to perform actions with but not get very specific info 
  // primary_info: {
  // //       title: { text: videoInfo.basic_info.title },
  // //       published: { text: videoInfo.basic_info?. },
  // //       relative_date: { text: "1 year ago" }, // Mocked since not available in basic_info
  // //     },
  // //     secondary_info: {
  // //       owner: {
  // //         author: {
  // //           name: videoInfo.basic_info.channel?.name,
  // //           id: videoInfo.basic_info.channel?.id,
  // //           url: videoInfo.basic_info.channel?.url,
  // //         },
  // //       },
  // //       description: { text: mockVideoInfo.basic_info.description },
  // //     },
  constructor(videoInfo: VideoInfo, yti_version: string) {
    this.version = 1;
    this.captions = deepCopy(videoInfo?.captions);
    this.game_info = deepCopy(videoInfo?.game_info);
    this.title = deepCopy(videoInfo?.primary_info?.title.text || videoInfo.basic_info?.title || "")
    this.published = deepCopy(videoInfo?.primary_info?.published.text || "")
    this.relative_date = deepCopy(videoInfo?.primary_info?.relative_date.text || "")
    this.author_name = deepCopy(videoInfo?.secondary_info?.owner?.author.name || videoInfo.basic_info?.channel?.name || "")
    this.author_channel_id = deepCopy(videoInfo?.secondary_info?.owner?.author.id || videoInfo.basic_info?.channel?.id || "")
    this.author_channel_url = deepCopy(videoInfo?.secondary_info?.owner?.author.url || videoInfo.basic_info?.channel?.url || "")
    this.description = deepCopy(videoInfo?.secondary_info?.description.text || videoInfo.basic_info?.short_description || "")
    this.archived_on = new Date().toISOString();
    this.file_formats = {};
    this.yti_version = yti_version;
  }
}

export type BasicVideoInfo = Omit<VideoInfo,  "game_info" | "primary_info" | "secondary_info" | "playlist" | "merchandise" | "related_chip_cloud" | "watch_next_feed" 
| "player_overlays" | "comments_entry_point_header" | "livechat" | "autoplay" | "heat_map">;

export class CacheInfoV1 extends ArchiveInfoV1 {
  version: number;
  mpd_manifest: string;
  cached_on_ms: number;
  browser_target: string;

  constructor(videoInfo: VideoInfo, mpd_manifest: string, browser_target: string, yti_version: string) {
    super(videoInfo, yti_version);
    this.version = 1;
    this.mpd_manifest = mpd_manifest;
    this.cached_on_ms = Date.now();
    this.browser_target = browser_target;
    this.archived_on = "";
  }
}

export class CacheInfoV2 extends CacheInfoV1 {
  version: number;
  constructor(videoInfo: VideoInfo, mpd_manifest: string, browser_target: string, yti_version: string) {
    super(videoInfo, mpd_manifest, browser_target, yti_version);
    this.version = 2;
  }
}

export class CacheInfoV3 extends CacheInfoV2 {
  version: number;
  ytiVidInfo: VideoInfo;
  constructor(videoInfo: VideoInfo, mpd_manifest: string, browser_target: string, yti_version: string) {
    super(videoInfo, mpd_manifest, browser_target, yti_version);
    this.version = 3;
    this.ytiVidInfo = videoInfo;
  }
}

export class ArchiveInfoV2 extends ArchiveInfoV1 {
  version: number;
  constructor(videoInfo: VideoInfo, yti_version: string) {
    super(videoInfo, yti_version)
    this.version = 2;
  }
}

/* Always use version tag to infer type **/
export type ArchiveInfo = ArchiveInfoV1 | ArchiveInfoV2
export type CacheInfo = CacheInfoV1 | CacheInfoV2 // versioning isnt really needed but for uniformity
export type ArchiveInfoLatest = ArchiveInfoV2
export type CacheInfoLatest = CacheInfoV3

export interface Archive {
  [key: string]: ArchiveInfo;
}

export interface Cache {
  [key: string]: CacheInfo;
}

export function newArchiveFromJSON(json: string): ArchiveInfoV1 | ArchiveInfoV2 | undefined {
  try {
    const jsonData = JSON.parse(json) as ArchiveInfo
    if(jsonData.version == 1){
      return jsonData as ArchiveInfoV1;
    } else if (jsonData.version == 2){
      return jsonData as ArchiveInfoV2;
    }
  } catch (error) {
    console.log()
    return undefined;
  }
} 

export function latestArchiveConstructor(
  videoInfo: VideoInfo,
  // | BasicVideoInfo,
  yti_version: string
): ArchiveInfoLatest {
  // if ((videoInfo as VideoInfo).primary_info === undefined) {
  //   const mockVideoInfo = {
  //     // basic_info: {
  //     //   title: "Mock Video Title",
  //     //   channel: {
  //     //     name: "Mock Author Name",
  //     //     id: "UC123456789",
  //     //     url: "https://www.youtube.com/channel/UC123456789",
  //     //   },
  //     //   description: "Mock Video Description",
  //     //   published: "2023-01-01",
  //     //   // Assuming relative_date is not directly available in basic_info, we'll mock it
  //     //   // relative_date: "1 year ago", // Not directly available, will be mocked separately
  //     // },
  //     // Derive primary_info and secondary_info from basic_info
  //     primary_info: {
  //       title: { text: videoInfo.basic_info.title },
  //       published: { text: videoInfo.basic_info?. },
  //       relative_date: { text: "1 year ago" }, // Mocked since not available in basic_info
  //     },
  //     secondary_info: {
  //       owner: {
  //         author: {
  //           name: videoInfo.basic_info.channel?.name,
  //           id: videoInfo.basic_info.channel?.id,
  //           url: videoInfo.basic_info.channel?.url,
  //         },
  //       },
  //       description: { text: mockVideoInfo.basic_info.description },
  //     },
  //     captions: {}, // Placeholder, not available in basic_info
  //     game_info: {}, // Placeholder, not available in basic_info
  //   } as VideoInfo;
  // }

  return new ArchiveInfoV2(videoInfo, yti_version);
}

export function latestCacheConstructor(videoInfo: VideoInfo, mpd_manifest: string, browser_target: string, yti_version: string): CacheInfoLatest {
  return new CacheInfoV3(videoInfo, mpd_manifest, browser_target, yti_version);
}