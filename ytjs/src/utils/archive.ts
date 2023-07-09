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
  archived_on: string;
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
	}
}

type ArchiveInfo = ArchiveInfoV1 // | ArchiveInfoV2
type CacheInfo = CacheInfoV1 // | CacheInfoV2

export interface Archive {
  [key: string]: ArchiveInfo;
}


export interface Cache {
  [key: string]: CacheInfo;
}