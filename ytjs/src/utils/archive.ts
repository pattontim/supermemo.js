import { Format } from 'youtubei.js/dist/src/parser/misc';
import { PlayerCaptionsTracklist } from 'youtubei.js/dist/src/parser/nodes';
import { VideoInfo } from 'youtubei.js/dist/src/parser/youtube';

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

  constructor(videoInfo: VideoInfo, yti_version: string) {
    this.version = 1;
    this.captions = videoInfo?.captions;
    this.game_info = videoInfo?.game_info;
    this.title = videoInfo?.primary_info?.title.text || ""
    this.published = videoInfo?.primary_info?.published.text || "";
    this.relative_date = videoInfo?.primary_info?.relative_date.text || "";
    this.author_name = videoInfo?.secondary_info?.owner?.author.name || "";
    this.author_channel_id = videoInfo?.secondary_info?.owner?.author.id || "";
    this.author_channel_url = videoInfo?.secondary_info?.owner?.author.url || "";
    this.description = videoInfo?.secondary_info?.description.text || "";
    this.archived_on = new Date().toISOString();
    this.file_formats = {};
    this.yti_version = yti_version;
  }
}

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
export type CacheInfoLatest = CacheInfoV2

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

export function latestArchiveConstructor(videoInfo: VideoInfo, yti_version: string): ArchiveInfoLatest {
  return new ArchiveInfoV2(videoInfo, yti_version);
}

export function latestCacheConstructor(videoInfo: VideoInfo, mpd_manifest: string, browser_target: string, yti_version: string): CacheInfoLatest {
  return new CacheInfoV2(videoInfo, mpd_manifest, browser_target, yti_version);
}