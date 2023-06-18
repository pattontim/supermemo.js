// caption_track and Text object
// youtubei-js 5.2.1 
interface YTText {
    text?: string;
    runs?: any;
    endpoint?: any;
    /**
     * Converts the text to HTML.
     * @returns The HTML.
     */
    toHTML(): string | undefined;
    /**
     * Checks if the text is empty.
     * @returns Whether the text is empty.
     */
    isEmpty(): boolean;
    /**
     * Converts the text to a string.
     * @returns The text.
     */
    toString(): string;
}

interface CaptionTrack {
  base_url: string;
  name: YTText;
  vss_id: string;
  language_code: string;
  kind: string;
  is_translatable: boolean;
}

interface CaptionPlayerProps<T> {
    url: string;
    tracks: CaptionTrack[];
    seek: (time: string) => void;
}

interface TranscriptProps<T> {
    track: TextTrack | undefined;
    url: string;
    seek: (time: string) => void;
    query: null;
}

interface TranscriptLineProps<T> {
    cue: TextTrackCue;
    seek: (time: string) => void;
    query: null;
}
