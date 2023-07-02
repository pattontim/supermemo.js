// import PlayerCaptionsTracklist from '../../../ytjs/node_modules/youtubei.js/dist/src/parser/classes/PlayerCaptionsTracklist.js';
// import { PlayerCaptionsTracklist } from 'YouTubeReactExtension\ytjs\node_modules\youtubei.js\dist\src\parser\classes\'
// caption_track and Text object
// youtubei-js 5.2.1 

export interface Text {
    text?: string;
}

export interface CaptionTrack {
  base_url: string;
  name: Text;
  vss_id: string;
  language_code: string;
  kind: string;
  is_translatable: boolean;
}