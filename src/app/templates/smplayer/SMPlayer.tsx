import React, { useMemo } from 'react';
import { useEffect, useState, useRef } from 'react';
// import ReactPlayer from 'react-player/lazy';
import ReactPlayer from 'react-player/lazy';
// import ReactExtension from './react-extension.js';
// import ExtractBoard from './features/clip/ExtractBoard.js'; 
import ClipExtractor from '../../features/extractors/ClipExtractor';
import CaptionsTracks from '../../features/language/CaptionsTracks';
// import Counter from './features/counter/Counter.js';
// import Subtitles from './features/language/Subtitles.js';
import { ArchiveInfo } from '../../../../ytjs/src/utils/archive';

import { convertHHMMSS2Seconds, convertSeconds2HHMMSS, constrainToRange, formatTime, convertHHMMSS2Vector3D } from '../../utils/Duration';
import Archive from '../../features/archive/Archive';
import { StorageKey, useLocalStorage } from '../../utils/storage';
import ClipTool from '../../features/clip/ClipTool';
import { ytjsHost } from '../../utils/client';
import { decodeOptionsFromSearchParam, encodeOptionsToSearchParam, decodeSessionFromSearchParam, encodeSessionToSearchParam, Option, Session } from "../../utils/supermemo";

function App() {
  const queryParameters = new URLSearchParams(window.location.search)

  // Check for session data or fallback to individual params
  const sessionParam = queryParameters.get('session');
  const session = decodeSessionFromSearchParam(sessionParam);

  /**
   * Auto-hover playback flag - Controls auto-play on mouse hover.
   * When true, playback automatically starts when mouse enters the player.
   * @type {boolean}
   */
  const [autoHover, setAutoHover] = useLocalStorage(StorageKey.AUTO_HOVER, true);

  /**
   * Auto-hover for long clips flag - Extends auto-hover behavior to clips longer than 15 seconds.
   * When true, auto-play on hover applies to all clips. When false, only short clips auto-play on hover.
   * @type {boolean}
   */
  const [autoHoverLongClips, setAutoHoverLongClips] = useLocalStorage(StorageKey.AUTO_HOVER_LONG_CLIPS, false);

  /**
   * Auto-play shorts always flag - Forces short clip auto-play regardless of hover state.
   * When true, short clips play automatically without requiring mouse hover.
   * @type {boolean}
   */
  const [autoPlayShortsAlways, setAutoPlayShortsAlways] = useLocalStorage(StorageKey.AUTO_PLAY_SHORTS_ALWAYS, false);

  /**
   * Fake fullscreen on shorts load
   * When true, enables pseudo-fullscreen mode automatically for short clips.
   */
  const [fakeFullscreenShorts, setFakeFullscreenShorts] = useLocalStorage(StorageKey.FAKE_FULLSCREEN_SHORTS, true);

  /**
   * Arrow Frame Mode - Enables frame-by-frame navigation using arrow keys.
   * When true, left/right arrow keys seek backward/forward by one frame (1/30 second).
   */
  const [arrowFrameMode, setArrowFrameMode] = useLocalStorage(StorageKey.ARROW_FRAME_MODE, false);
  
  // ============================================================================
  // STATE: Clip Boundary Management (HH:MM:SS format)
  // ============================================================================

  /**
   * Resume time - The bookmark or restart point for the current clip.
   * Stored in HH:MM:SS format. Used for audio muting schedules and session management.
   * @type {string}
   */
  const [resume, setResume] = useState(session?.resume ?? queryParameters.get('resume'));

  /**
   * Start time - The beginning boundary of the current clip.
   * Stored in HH:MM:SS format. Playback is bounded to this point when `repeat` is enabled.
   * @type {string}
   */
  const [start, setStart] = useState(session?.start ?? queryParameters.get('start'));

  /**
   * Stop time - The ending boundary of the current clip.
   * Stored in HH:MM:SS format. Playback loops back to `start` when this boundary is reached (if `repeat` is enabled).
   * @type {string}
   */
  const [stop, setStop] = useState(session?.stop ?? queryParameters.get('stop'));

  /**
   * Impose boundaries flag - Controls whether playback boundaries are enforced.
   * When 1 (truthy), player automatically seeks to `start` if playback goes out of bounds.
   * When 0, boundaries are temporarily disabled (e.g., during manual seeking outside clip range).
   * @type {number}
   */
  const [imposeBoundaries, setImposeBoundaries] = useState(1);

  // ============================================================================
  // STATE: Extraction & Options Management
  // ============================================================================

  /**
   * Options - Array of extracted clip configurations.
   * Each Option represents a user-created extract with settings for format, timing, and content.
   * Used for batch processing and archive management.
   * @type {Option[]}
   */
  const [options, setOptions] = useState<Option[]>(session?.options ?? decodeOptionsFromSearchParam(queryParameters.get("options")));

  /**
   * Video ID - YouTube or archive video identifier.
   * Extracted from query parameters. Used for fetching stream URLs and archive metadata.
   * @type {string | null}
   */
  const [videoid, setVideoid] = useState(queryParameters.get('videoid')?.trim() ?? null);

  /**
   * Repeat flag - Controls clip boundary enforcement mode.
   * When true, playback loops within start/stop boundaries.
   * When false, playback proceeds linearly through the entire video.
   * @type {boolean}
   */
  const [repeat, setRepeat] = useState(true);

  /**
   * Number of repeats counter - Tracks how many times the current clip has been repeated.
   * Used for learning analytics and session tracking.
   * @type {number}
   */
  const [numRepeats, setNumRepeats] = useState(0);

  // const [url, setUrl] = useState('https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4');
  // const [url, setUrl] = useState("https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_640x360_800k.mpd");
  // const [url, setUrl] = useState("http://youtube.com/watch?v=" + queryParameters.get('videoid')) 

  // ============================================================================
  // STATE: Media Source & Loading
  // ============================================================================

  /**
   * URL - The streaming URL for the media source.
   * Can be a direct MP4 URL, DASH (.mpd) manifest, or HLS (.m3u8) stream.
   * Set to empty string initially; populated by backend stream URL request.
   * @type {string}
   */
  const [url, setUrl] = useState("");

  /**
   * Is MPD loaded flag - Indicates whether DASH manifest has been fetched and parsed.
   * Prevents premature player initialization. Used to coordinate between dummy URL and actual manifest.
   * @type {boolean}
   */
  const [isMpdLoaded, setIsMpdLoaded] = useState(false);

  /**
   * Subtitle URL - The URL endpoint for fetching captions/subtitles.
   * Constructed from backend host and video ID. May contain multiple caption tracks.
   * @type {string}
   */
  const [subtitleUrl, setSubtitleUrl] = useState("http://" + ytjsHost + "/captions/" + queryParameters.get('videoid'));

  // ============================================================================
  // STATE: ReactPlayer Core Properties
  // ============================================================================

  /**
   * Picture-in-Picture mode flag.
   * When true, enables Picture-in-Picture if supported by the browser.
   * Allows video playback to continue in a floating window.
   * @type {boolean}
   */
  const [pip, setPip] = useState(false);

  /**
   * Playing state - Controls playback.
   * When true, media plays automatically. When false, media is paused.
   * Synchronized with ReactPlayer's internal playing state.
   * @type {boolean}
   */
  const [playing, setPlaying] = useState(autoPlayShortsAlways || false); // TODO: always play all

  /**
   * Controls visibility flag.
   * When true, displays native ReactPlayer controls (play, pause, progress bar, volume, etc.).
   * When false, hides all built-in controls for custom UI implementations.
   * @type {boolean}
   */
  const [controls, setControls] = useState(true);

  /**
   * Light mode flag - Enables thumbnail preview loading behavior.
   * When true, displays a thumbnail that loads the full player on first click.
   * Useful for deferred video initialization and reduced initial bandwidth usage.
   * @type {boolean}
   */
  const [light, setLight] = useState(false);

  /**
   * Audio volume level between 0.0 (silent) and 1.0 (maximum).
   * Persisted to browser local storage with key 'vol-{videoid}' for recall across sessions.
   * @type {number}
   */
  const [volume, setVolume] = useLocalStorage('vol-' + videoid, 0.8);

  /**
   * Muted state flag.
   * When true, audio is muted regardless of volume setting.
   * Used for automatic muting during learning interval beep schedules.
   * @type {boolean}
   */
  const [muted, setMuted] = useState(false);

  /**
   * Played progress in seconds.
   * Current playback position in seconds. Used for progress bar, time displays, and boundary checking.
   * Initialized from session data or calculated from start time parameter.
   * @type {number}
   */
  const [played, setPlayed] = useState(session?.played ?? (start ? convertHHMMSS2Seconds(start) : 0));

  /**
   * Loaded/buffered progress as fraction (0.0 to 1.0).
   * Represents the amount of media that has been downloaded/buffered.
   * Used for buffer progress visualization and download status indication.
   * @type {number}
   */
  const [loaded, setLoaded] = useState(0);

  /**
   * Total media duration in seconds.
   * Obtained from ReactPlayer after media loads. Used for time formatting and boundary calculations.
   * @type {number}
   */
  const [duration, setDuration] = useState(0);

  /**
   * Playback rate multiplier.
   * 1.0 = normal speed, 1.5 = 50% faster, 0.5 = 50% slower.
   * Allows users to speed up or slow down video playback.
   * @type {number}
   */
  const [playbackRate, setPlaybackRate] = useState(1.0);

  /**
   * Loop mode flag - Controls automatic restart behavior.
   * When true, media automatically restarts when playback reaches the end.
   * Distinct from `repeat`, which controls clip boundary looping.
   * @type {boolean}
   */
  const [loop, setLoop] = useState(false);

  /**
   * Seeking flag - Indicates user is currently scrubbing/seeking.
   * When true, time updates are suppressed to avoid jitter during scrubbing.
   * Prevents progress callback from firing during manual timeline manipulation.
   * @type {boolean}
   */
  const [seeking, setSeeking] = useState(false);

  // ============================================================================
  // STATE: Archive & Metadata
  // ============================================================================

  /**
   * Archive info object - Contains video metadata from backend.
   * Includes title, description, author, publish date, captions, and channel information.
   * Fetched asynchronously after player is ready.
   * @type {ArchiveInfo | undefined}
   */
  const [archiveInfo, setArchiveInfo] = useState<ArchiveInfo>();

  /**
   * Session restored flag - Indicates whether session data was successfully loaded and applied.
   * Used to coordinate async session restoration with initial player setup.
   * @type {boolean}
   */
  const [sessionRestored, setSessionRestored] = useState(session !== null);

  // ============================================================================
  // STATE: UI/UX & Learning Features
  // ============================================================================

  /**
   * Is short clip computed flag - Memoized boolean indicating if current clip is "short" (< 15 seconds).
   * A clip is considered short if:
   * - Clip duration (stop - start) is less than 15 seconds
   * - AND there's at least 1 second of content after the stop point
   * Used for auto-play behavior and visual distinction (yellow-green background).
   * @type {boolean}
   */
  const isShortClip = useMemo(() => {
    const clipDur = stop ? convertHHMMSS2Seconds(stop) - convertHHMMSS2Seconds(start): null;
    return clipDur && (clipDur < 15) && (duration - convertHHMMSS2Seconds(stop) > 1) ? true : false;
  }, [start, stop, duration]);

  /**
   * Mouse over player flag - Tracks whether user's mouse cursor is currently over the player.
   * Used by auto-hover handlers to determine if playback should activate/deactivate.
   * @type {boolean}
   */
  const [isMouseOverPlayer, setIsMouseOverPlayer] = useState(false);

  /**
   * Pseudo-fullscreen mode flag - Controls whether player takes up all available space.
   * When true, hides archive-info, clip-extractor, and other components to maximize player size.
   * Automatically enabled when: player is loaded AND clip is short AND loading from archive.
   * Automatically disabled on double-click or when conditions no longer match.
   * Unlike true fullscreen, this doesn't trigger browser APIs and plays well with player controls.
   * @type {boolean}
   */
  const [pseudoFullscreen, setPseudoFullscreen] = useState(false);

  // ============================================================================
  // REFS: Player Instance References
  // ============================================================================

  /**
   * Player ref - Reference to the underlying ReactPlayer instance.
   * Used to access player methods like `seekTo()`, `getCurrentTime()`, and `getInternalPlayer()`.
   * The internal player can be a HTMLVideoElement, HLS.js instance, dash.js instance, or other adapter.
   * @type {React.RefObject<ReactPlayer>}
   */
  const ref = useRef<ReactPlayer>(null)

  // // SM browser as remote component
  // useEffect(() => {
  //   setResume(queryParameters.get('resume'));
  //   setStart(queryParameters.get('start'));
  //   setStop(queryParameters.get('stop'));
  //   setVideoid(queryParameters.get('videoid'));
  // }, []);

  // ============================================================================
  // EFFECT: Auto-enable pseudo-fullscreen for short archive clips
  // ============================================================================
  useEffect(() => {
    // Enable pseudo-fullscreen when:
    // 1. Stream URL is loaded (url is not empty)
    // 2. MPD is loaded
    // 3. Clip is short
    // 4. Archive info is available (indicates loading from archive)
    if (url && isMpdLoaded && isShortClip && archiveInfo && fakeFullscreenShorts) {
      setPseudoFullscreen(true);
    } else {
      setPseudoFullscreen(false);
    }
  }, [url, isMpdLoaded, isShortClip, archiveInfo]);

  useEffect(() => {
    const url = new URL("http://" + ytjsHost + "/streamUrl/" + queryParameters.get('videoid'));
    const startSec = convertHHMMSS2Seconds(start);
    const stopSec = convertHHMMSS2Seconds(stop);
    url.searchParams.append('startSec', startSec.toString());
    url.searchParams.append('stopSec', stopSec.toString());
    url.searchParams.append('target', 'IE');

    const req = new XMLHttpRequest();
    req.open('GET', url.toString(), true);
    req.responseType = 'json';
    req.onload = function() {
      if (req.status !== 200) {
        console.log('Error: ' + req.status);
        return;
      }
      const streamUrl = (req.response ?? req.responseURL) as string;
      console.log('Stream URL:', streamUrl);

      // If it's an MPD file, fetch and wait for it to load completely
      if (streamUrl.toLowerCase().indexOf('.mpd') > -1) {
        const dummyUrl = new URL("http://" + ytjsHost + "/dummy-manifest.mpd");
        setUrl(dummyUrl.href);
        setIsMpdLoaded(true);

        const mpdReq = new XMLHttpRequest();
        mpdReq.open('GET', streamUrl, true);
        mpdReq.onload = function() {
          if (mpdReq.status !== 200) {
            console.error('MPD fetch failed');
            return;
          }
          // Only set the URL after MPD is fully loaded
          setUrl(streamUrl);
          setIsMpdLoaded(true);
        };
        mpdReq.onerror = function() {
          console.error('Error loading MPD');
        };
        mpdReq.send();
      } else {
        console.log("non MPD stream found")
        // For non-MPD streams, set URL directly
        setUrl(streamUrl);
        setIsMpdLoaded(true);
      }
    }
    req.send();
  }, []);

  // ============================================================================
  // EVENT HANDLERS: Core Playback Control
  // ============================================================================

  /**
   * Handles play event from ReactPlayer.
   * Enforces auto-hover playback rules for short clips:
   * - For short clips: Only allows playing if mouse is over player
   * - For long clips: Respects auto-hover settings before allowing play
   * @returns {void}
   */
  const handlePlay = () => {
    console.log('onPlay')
    // Only allow playing if mouse is over player
    if (isMouseOverPlayer) {
      if(isShortClip){
        setPlaying(true)
      }
    } else {
      if(isShortClip){
        setPlaying(false)
      }
    }
  }

  /**
   * Handles pause event from ReactPlayer.
   * Sets the playing state to false, stopping video playback.
   * @returns {void}
   */
  const handlePause = () => {
    console.log('onPause')
    setPlaying(false)
  }

  /**
   * Handles seek/scrub event from ReactPlayer.
   * Updates played position and disables boundary enforcement if user seeks outside clip range.
   * @param {number} destSec - Destination seek position in seconds
   * @returns {void}
   */
  const handleSeek = (destSec: number) => {
    if(destSec < convertHHMMSS2Seconds(start) - 3 || destSec > convertHHMMSS2Seconds(stop) + 3) {
      setImposeBoundaries(0);
    }
    console.log('onSeek to ', destSec)
    setPlayed(destSec)
  }

  /**
   * Handles playback rate change event from ReactPlayer.
   * Updates the playback speed multiplier in component state.
   * @param {number} playbackRate - New playback rate multiplier (e.g., 1.5 for 1.5x speed)
   * @returns {void}
   */
  const handleOnPlaybackRateChange = (playbackRate: number) => {
    console.log('onPlaybackRateChange', playbackRate)
    setPlaybackRate(playbackRate)
  }

  /**
   * Handles media end event from ReactPlayer.
   * When media reaches the end, sets playing based on loop state:
   * - If loop is true, continues playing (automatically restarts)
   * - If loop is false, stops playback
   * @returns {void}
   */
  const handleEnded = () => {
    console.log('onEnded')
    setPlaying(loop)
  }

  /**
   * Handles progress/time update event from ReactPlayer during playback.
   * Updates playback position, enforces clip boundaries, schedules audio mutes, and updates UI.
   * Processes the following:
   * - Updates played seconds position
   * - Schedules beep muting for learning intervals (short clips only)
   * - Validates and enforces clip boundaries if imposeBoundaries is enabled
   * - Handles edge cases (zero duration, start > duration)
   * - Updates border styling for start/stop input fields
   *
   * @param {any} state - Progress state from ReactPlayer containing { playedSeconds, loadedSeconds, played, loaded }
   * @returns {void}
   */
  const handleProgress = (state: any) => {
    console.log('onProgress', state.playedSeconds, (state.playedSeconds * 10).toFixed(2) + '%')
    if(isShortClip) {
      scheduleBeep(state.playedSeconds);
    }
    setPlayed(state.playedSeconds)
    if(played == 0 && convertHHMMSS2Seconds(start) == convertHHMMSS2Seconds(stop)) {
      handleResetAt("stop");
    }
    if(played == 0 && convertHHMMSS2Seconds(start) > duration) {
      handleResetAt("stop");
    }
    if (!seeking && imposeBoundaries) {
      checkBoundaries()
    }
      // TODO quality selector
    // const dashjs = ref.current.getInternalPlayer('dash')
    // if (dashjs) {
    //   console.log('dashjs', dashjs)
    //   console.log('dashjs.getBitrateInfoListFor(' + dashjs.getActiveStream().getId() + ')', dashjs.getBitrateInfoListFor(dashjs.getActiveStream().getId()))
    // }
    // if(videoid != videoIdAtStart) {
    //   setVideoid(videoIdAtStart);
    // }
    if (document.activeElement?.id && document.activeElement?.id != "startvideoat") {
      handleStartChange(document.getElementById("startvideoat") as HTMLInputElement)
    }
    if (document.activeElement?.id && document.activeElement?.id != "stopvideoat") {
      handleStopChange(document.getElementById("stopvideoat") as HTMLInputElement)
    }
  }

  /**
   * Handles duration available event from ReactPlayer.
   * Called when media metadata is loaded and duration becomes available.
   * Updates component state with the total media duration.
   * @param {number} duration - Total media duration in seconds
   * @returns {void}
   */
  const handleDuration = (duration: number) => {
    console.log('onDuration', duration)
    setDuration(duration)
  }

  // ============================================================================
  // UTILITY FUNCTIONS: Playback Management
  // ============================================================================

  /**
   * Seeks video to specified time position.
   * Converts HH:MM:SS format to seconds and uses ReactPlayer's seekTo method.
   * @param {string | null} to - Target time in HH:MM:SS format. If null or invalid, operation is skipped.
   * @returns {void}
   */
  function seekVideo(to: string | null) {
    if (ref.current) {
        ref.current.seekTo(convertHHMMSS2Seconds(to));
    }
  }

  /**
   * Enforces clip boundary constraints during playback.
   * Called from handleProgress to ensure playback stays within start/stop boundaries.
   * Only active when `repeat` is true and `imposeBoundaries` is truthy.
   * - If playback goes before start: Seeks to start
   * - If playback goes past stop: Seeks back to start (looping behavior)
   * @returns {void}
   */
  function checkBoundaries() {
    if(!repeat) return;
    if (ref.current) {
        if (ref.current.getCurrentTime() < convertHHMMSS2Seconds(start)) {
            ref.current.seekTo(convertHHMMSS2Seconds(start));
        } else if (ref.current.getCurrentTime() > convertHHMMSS2Seconds(stop)) {
            ref.current.seekTo(convertHHMMSS2Seconds(start));
        }
    }
  }

  /**
   * Schedules automatic audio mute for learning intervals.
   * Implements a sophisticated timing system that mutes audio at specific points during clip playback.
   * The mute timing and duration are calculated from the `resume` parameter (encoded as A:B:C format):
   * - Component A: Offset action applied to timing offsets (1-8: ±25ms or ±50ms adjustments)
   * - Component B: Start mute point as percentage of clip duration (0-59, where 59 = 100%)
   * - Component C: Stop mute point as percentage of clip duration (0-59, where 59 = 100%)
   *
   * The function calculates when muting should occur with ±300ms tolerance per progress tick.
   * Used for SuperMemo learning intervals where audio should be muted at specific recall points.
   *
   * @param {number} playedSeconds - Current playback position in seconds
   * @returns {void}
   */
  function scheduleBeep(playedSeconds: number) {
    const resumeVector = convertHHMMSS2Vector3D(resume);
    const startSec = convertHHMMSS2Seconds(start);
    const stopSec = convertHHMMSS2Seconds(stop);

    // Check if B or C is 0, return if true
    if (resumeVector.y === 0 || resumeVector.z === 0) {
      return;
    }

    const msOffset = {
      start: 0,
      stop: 0
    }
    function applyOffset(a: Number) {
      switch (a) {
        case 1: 
          msOffset.start += 25;
          break;
        case 2: 
          msOffset.start -= 25;
          break;
        case 3: 
          msOffset.stop += 25;
          break;
        case 4: 
          msOffset.stop -= 25;
          break;
        case 5: 
          msOffset.start += 50;
          break;
        case 6: 
          msOffset.start -= 50;
          break;
        case 7: 
          msOffset.stop += 50;
          break;
        case 8: 
          msOffset.stop -= 50;
          break;
        case 9: // -
          // Custom logic for action 9
          break;
        case 10: // -
          // Custom logic for action 10
          break;
        default:
          // Invalid action
      }
    }
    applyOffset(resumeVector.x);

    const percentModifier = {
      start: resumeVector.y / 59,
      stop: resumeVector.z / 59
    }

    // Calculate duration and beep times
    const duration = stopSec - startSec;
    const beepStartSec = startSec + (duration * percentModifier.start) //+ msOffset.start;
    const beepStopSec = startSec + (duration * percentModifier.stop) //+ msOffset.stop;

    if(playedSeconds > beepStartSec){
      console.log("Not running after possible start");
      return
    }

    const offsetToStart = beepStartSec - playedSeconds;
    const offsetToStop = beepStopSec - playedSeconds;
    console.log('offsetToStart', offsetToStart);

    // This progress's timeslice start can vary by up to 300ms
    if (offsetToStart >= 0 && offsetToStart <= 1) {
      const muteDuration = (offsetToStop * 1000) - (offsetToStart * 1000)
      if(isNaN(muteDuration) || muteDuration < 0) return;
      setTimeout(() => {
        setMuted(true);
        setTimeout(() => {
          setMuted(false);
        }, muteDuration);
      }, offsetToStart * 1000);
      console.log('MUTING FOR', muteDuration, 'ms');
    }
  }

  // ============================================================================
  // EVENT HANDLERS: Settings & Navigation
  // ============================================================================

  /**
   * Navigates to hidden page while preserving current session state.
   * Encodes all current state (resume, start, stop, played, options) into URL params.
   * When user returns from hidden, this state is restored via session restoration logic.
   * @param {string} url - The base URL of the hidden page
   * @returns {void}
   */
  function handleOpenHidden(url: string) {
    const updatedSession: Session = {
      resume,
      start,
      stop,
      played,
      options
    };

    const hiddenURL = new URL(document.location.href.replace("smplayer.html", url));
    hiddenURL.searchParams.set("session", encodeSessionToSearchParam(updatedSession));
    window.location.href = hiddenURL.toString();
  }

  /**
   * Toggles clip boundary repeat mode.
   * When enabled (true): Playback loops within start/stop boundaries
   * When disabled (false): Playback proceeds linearly through entire video
   * @returns {void}
   */
  function handleToggleRepeat() {
    setRepeat(!repeat);
  }

  // ============================================================================
  // EVENT HANDLERS: Player Initialization & Lifecycle
  // ============================================================================

  /**
   * Called when ReactPlayer is fully initialized and ready to play.
   * Performs critical setup tasks:
   * - Fetches video metadata (title, author, description, captions)
   * - Initializes volume change listener on video element
   * - Seeks to start position
   * - Begins playback
   * - Restores session position if returning from settings
   *
   * @param {ReactPlayer} player - The initialized ReactPlayer instance
   * @returns {void}
   */
  function handlePlayerReady( player: ReactPlayer ) {
    fetchArchiveInfo(queryParameters.get('videoid') as string);

    const videoElement = document.getElementsByTagName('video')[0];
    if(videoElement) {
      videoElement.addEventListener('volumechange', volume => {
        setVolume(videoElement.volume);
      }); 
    }

    seekVideo(start);
    setPlaying(true);
    console.log('player ready');
    customDebugger();    

    // Restore player position from session when returning from settings
    if (sessionRestored && session && ref.current) {
      console.log('Restoring session - seeking to', session.played);
      ref.current.seekTo(session.played);
      setPlayed(session.played);
    }
  }

  /**
   * Called when ReactPlayer starts initialization.
   * Used for debugging and logging player startup events.
   * @returns {void}
   */
  function handlePlayerStart() {
    console.log('player start');
  }

  // ============================================================================
  // UTILITY FUNCTIONS: Time Control & Clip Management
  // ============================================================================

  /**
   * Resets a time value (resume/start/stop) to default.
   * - "resume" → "0:00"
   * - "start" → Beginning of video (0:00)
   * - "stop" → End of video
   *
   * @param {string} type - Which time to reset: "resume", "start", or "stop"
   * @returns {void}
   */
  function handleResetAt(type: string) {
    if (type === "resume") {
        setResume("0:00");
    } else if (type === "start") {
        setStart(formatTime(0, 0));
    } else if (type === "stop") {
        setStop(formatTime(duration, duration));
    }
  }

  /**
   * Sets a time value (resume/start/stop) to an absolute position.
   * Formats the absolute position according to video duration.
   * @param {string} type - Which time to set: "resume", "start", or "stop"
   * @param {number} abs - Absolute position in seconds
   * @returns {void}
   */
  function handleSetAbs(type: string, abs: number) {
    let new_val = formatTime(abs, duration);
    if (type === "resume") {
        setResume(new_val);
    } else if (type === "start") {
        setStart(new_val);
    } else if (type === "stop") {
        setStop(new_val);
    }
  }

  /**
   * Sets a time value directly in HH:MM:SS format.
   * Bypasses duration-based formatting for explicit time strings.
   * @param {string} type - Which time to set: "resume", "start", or "stop"
   * @param {string} hhmmss - Time in HH:MM:SS format
   * @returns {void}
   */
  function setHHMMSS(type: string, hhmmss: string) {
    if (type === "resume") {
        setResume(hhmmss);
    } else if (type === "start") {
        setStart(hhmmss);
    } else if (type === "stop") {
        setStop(hhmmss);
    }
  }

  /**
   * Sets a time value relative to current playback position with optional offsets.
   * Calculates new time as: current_played_seconds + offsetSec + (offsetMin * 60) + (offsetHour * 3600)
   * Automatically triggers UI updates for start/stop input field styling.
   *
   * @param {string} type - Which time to set: "resume", "start", or "stop"
   * @param {number} [offsetSec=0] - Seconds offset to add
   * @param {number} [offsetMin=0] - Minutes offset to add
   * @param {number} [offsetHour=0] - Hours offset to add
   * @returns {void}
   */
  function handleSetAt(type: string, offsetSec = 0, offsetMin = 0, offsetHour = 0) {
    console.log('handleSetAt', type, offsetSec, played, duration, played + offsetSec)
    let new_val = formatTime(played + offsetSec + offsetMin * 60 + offsetHour * 3600, duration);
    if (type === "resume") {
        setResume(new_val);
    } else if (type === "start") {
      setStart(new_val);
      handleStartChange(document.getElementById("startvideoat") as HTMLInputElement)
    } else if (type === "stop") {
      setStop(new_val);
      handleStopChange(document.getElementById("stopvideoat") as HTMLInputElement)
    } 
  }

  /**
   * Seeks to a specific clip boundary (start/stop/resume) and updates boundary enforcement.
   * - "start" → Seeks to start, enables boundary enforcement
   * - "stop" → Seeks to stop, disables boundary enforcement (allows seeking past)
   * - "resume" → Seeks to resume point, disables boundary enforcement
   *
   * @param {string} type - Which boundary to seek to: "start", "stop", or "resume"
   * @returns {void}
   */
  function handleGoTo(type: string) {
    let type_val;
    if(type === 'start') {
      type_val = start;
      setImposeBoundaries(1);
    } else if (type === 'stop') {
      type_val = stop;
      setImposeBoundaries(0);
    } else if (type === 'resume') {
      type_val = resume;
      setImposeBoundaries(0);
    } else {
      return;
    }

    setPlayed(convertHHMMSS2Seconds(type_val));
    seekVideo(type_val);
  }

  /**
   * Applies a time offset to resume/start/stop value.
   * Adds offset seconds and ensures result stays within video bounds.
   * @param {string} type - Which time to offset: "resume", "start", or "stop"
   * @param {number} offset - Seconds to add (can be negative for subtraction)
   * @returns {void}
   */
  function handleOffset(type: string, offset: number) {
    if (type === "resume") {
        setResume(formatTime(convertHHMMSS2Seconds(resume) + offset, duration));
    } else if (type === "start") {
        setStart(formatTime(convertHHMMSS2Seconds(start) + offset, duration));
    } else if (type === "stop") {
        setStop(formatTime(convertHHMMSS2Seconds(stop) + offset, duration));
    }
  }

  // ============================================================================
  // UTILITY FUNCTIONS: Archive & Metadata
  // ============================================================================

  /**
   * Fetches video archive information from backend.
   * Makes async XMLHttpRequest to backend's archiveInfo endpoint.
   * Retrieved metadata includes:
   * - Title, description, publish date
   * - Author/channel information
   * - Caption track availability
   * - Video statistics
   * Used for UI display and clipboard export functionality.
   *
   * @param {string} v_id - YouTube or archive video ID
   * @returns {void}
   */
  function fetchArchiveInfo(v_id: string) {
    const archiveReq = new XMLHttpRequest();
    archiveReq.open('GET', "http://" + ytjsHost + "/archiveInfo/" + v_id);
    archiveReq.responseType = 'json';
    archiveReq.onload = function () {
      if (archiveReq.status !== 200) {
        console.log('Error: ' + archiveReq.status);
        return;
      }
      console.log("Metadata:" + archiveReq.response);
      setArchiveInfo(JSON.parse(archiveReq.response) as ArchiveInfo);
    }
    archiveReq.send();
  }

  /**
   * Copies complete video metadata to clipboard.
   * Exported format includes:
   * - Title
   * - Publication date
   * - Author name
   * - Channel URL
   * - Full description
   * Shows confirmation alert upon successful copy.
   * @returns {void}
   */
  function handleCopyVideoDetails() {
    if(!archiveInfo) return;
    const detailsToCopy = `Title: ${archiveInfo.title}
====================
Published: ${archiveInfo.published}
====================
Author: ${archiveInfo.author_name}
====================
Channel URL: ${archiveInfo.author_channel_url}
====================
Description:\n${archiveInfo.description}
====================`;

    const textarea = document.createElement('textarea');
    textarea.value = detailsToCopy;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);

      alert('Video details copied to clipboard!');
  }

  /**
   * Updates styling of stop time input field based on player state.
   * Applied border styling:
   * - Blue border (2px solid blue) when: playing AND stop < duration (active playback region)
   * - Default border (2px inset) otherwise
   * Provides visual feedback for current clip boundary status.
   *
   * @param {HTMLInputElement} elem - The stop time input element
   * @returns {void}
   */
  function handleStopChange(elem: HTMLInputElement) {          
      if(playing && convertHHMMSS2Seconds(stop) < duration){
          elem.style.border = "2px solid blue";
      } else {
          elem.style.border = "2px inset";
      }
  }

  /**
   * Updates styling of start time input field based on player state.
   * Applied border styling:
   * - Blue border (2px solid blue) when: start > 0 (clip doesn't start at beginning)
   * - Default border (2px inset) otherwise
   * Provides visual feedback for current clip boundary status.
   *
   * @param {HTMLInputElement} elem - The start time input element
   * @returns {void}
   */
  function handleStartChange(elem: HTMLInputElement){
      if(convertHHMMSS2Seconds(start) > 0){
          elem.style.border = "2px solid blue";
      } else {
          elem.style.border = "2px inset";
      }
  }

  /**
   * Debugger utility for DASH.js player introspection.
   * Logs information about the underlying dash.js player instance if available.
   * Used for development and troubleshooting streaming issues.
   * @returns {void}
   */
  function customDebugger() {
    const player = ref.current?.getInternalPlayer('dash');
    if (!player) {
      console.log('No player');
      return;
    }
    console.log('Player', player);
  }

  /**
   * Sets video quality/resolution for DASH streams.
   * Retrieves available quality levels from dash.js player and sets the specified resolution.
   * Only works with DASH streams; shows alert for archive-only players.
   *
   * @param {string} res - Resolution height to set (e.g., "720" for 720p)
   * @returns {void}
   */
  function setResolution(res: string){
    const player = ref.current?.getInternalPlayer('dash');
    if (!player) {
      window.alert("dash player not found (archive?)")
      return;
    }

    const qualityLevels = player.getBitrateInfoListFor('video').map((info: { height: any; }) => info.height);
    const level = qualityLevels.indexOf(res)
    if(!level) {
      window.alert("quality not found")
      return;
    }
    player.setQualityFor('video', level);
  }

  window.addEventListener('beforeunload', function(e) {
    // Your custom logic here (e.g., send analytics, save state, etc.)
    // e.returnValue = 'You have unsaved extracts?';
    // return e.returnValue;

    if(options.length > 5){
      e.returnValue = `You have many extracts which may be lost if you navigate away. ` +
      `Proceed to navigate?`;
    }

    const updatedSession: Session = {
      resume,
      start,
      stop,
      played,
      options
    };

    const newParams = new URLSearchParams(window.location.search);
    newParams.set("session", encodeSessionToSearchParam(updatedSession));
    const newUrl = `${window.location.pathname}?${newParams.toString()}`;
    window.history.replaceState(null, '', newUrl); // No reload
  });

  /**
   * Copies video title to clipboard and shows confirmation alert.
   * Extracted from archiveInfo metadata.
   * @returns {void}
   */
  function handleTitleClicked() {
    if(!archiveInfo) return;

    const textarea = document.createElement('textarea');
    textarea.value = archiveInfo.title;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);

      alert('Title copied to clipboard!');
  }

  // ============================================================================
  // EVENT HANDLERS: Mouse & Keyboard Input
  // ============================================================================

  /**
   * Handles mouse entering the player area.
   * If `autoHover` is enabled:
   * - Sets isMouseOverPlayer to true
   * - For short clips: Starts automatic playback
   * - For long clips: Starts playback only if `autoHoverLongClips` is enabled
   * @returns {void}
   */
  function handleMouseEnter(){
    if(autoHover){
      setIsMouseOverPlayer(true);
      if(isShortClip || autoHoverLongClips){
        setPlaying(true);
      }
    }
  }

  /**
   * Handles mouse leaving the player area.
   * If `autoHover` is enabled:
   * - Sets isMouseOverPlayer to false
   * - For short clips: Stops automatic playback
   * - For long clips: Stops playback only if `autoHoverLongClips` is enabled
   * @returns {void}
   */
  function handleMouseLeave() {
    if(autoHover){
      setIsMouseOverPlayer(false);
      if(isShortClip || autoHoverLongClips){
        setPlaying(false);
      }
    }
  }

  /**
   * Handles keyboard input for player control and clip navigation.
   * Supported key bindings:
   * - Arrow Right / 'right' → Seek forward 1 second
   * - Arrow Left / 'left' → Seek backward 1 second
   * - Space → Toggle play/pause (prevented from bubbling)
   * - '>' → Seek forward 1 frame (assuming 30fps = 1/30s)
   * - '<' → Seek backward 1 frame (assuming 30fps = 1/30s)
   *
   * All key events are prevented from bubbling and default behavior is suppressed.
   *
   * @param {React.KeyboardEvent<HTMLDivElement>} e - Keyboard event from player container
   * @returns {void}
   */
  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // TODO: IDEA - flash a border on key down programtically to indicate input
    // document.getElementsByTagName("body")[0]?.classList.add("key-pressed");
    // setTimeout(() => {
    //   document.getElementById("player-container")?.classList.remove("key-pressed");
    // }, 100);
    if (e.key === 'right' || e.key === 'ArrowRight') {
      if(arrowFrameMode){
        ref?.current?.seekTo(played + (1 / 30), 'seconds');
      } else {
        seekVideo(formatTime(played + 1, duration));
      }
    } else if (e.key === 'left' || e.key === 'ArrowLeft') {
      if(arrowFrameMode){
        ref?.current?.seekTo(played - (1 / 30), 'seconds');
      } else {
        seekVideo(formatTime(played - 1, duration));
      }
    } else if (e.key === ' ' || e.key === 'Spacebar') {
      // e.preventDefault();
      // e.stopPropagation();
      // setPlaying(!playing);
      return;
    } else if (e.key === '>') {
      // seek forward one frame assuming 30fps
      ref?.current?.seekTo(played + (1 / 30), 'seconds');
    } else if (e.key === '<') {
      // seek backward one frame assuming 30fps
      ref?.current?.seekTo(played - (1 / 30), 'seconds');
    }
    e.preventDefault();
    e.stopPropagation();
  }

  /**
   * Handles double-click on player container.
   * Exits pseudo-fullscreen mode when user double-clicks the player.
   * Prevents the double-click from interfering with native player controls.
   *
   * @param {React.MouseEvent<HTMLDivElement>} e - Mouse event from player container
   * @returns {void}
   */
  function handlePlayerDoubleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (pseudoFullscreen) {
      setPseudoFullscreen(false);
      e.preventDefault();
      e.stopPropagation();
    }
  }
    
  return (
    <div className="app" style={{
      ...(pseudoFullscreen && {
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
        margin: 0,
        padding: 0,
        position: 'fixed',
        top: 0,
        left: 0
      })
    }}>

    {/* EXPERIMENT: this conclusively proved that iframes are ignored by supermemo's input parser
    {
      !document.location.href.includes("recursed") &&
    <iframe src='http://10.0.2.2:3000/templates/smplayer.html?videoid=clobbered2s&resume=1:00&start=1:00&stop=1:31&ts=2025117153639465&recursed=1'>
    </iframe>
    } */}

    { !pseudoFullscreen && archiveInfo ?
      <div className="archive-info col" style={{
        paddingLeft: "0px",
        paddingBottom: "0px",
        paddingTop: "0px",
        ...(isShortClip && {backgroundColor: "yellowgreen"})
      }}>
        <div className='row' style={{ border: "1px solid black", borderBottom: "0px", borderRight: "0px", borderTop: "0px"} }>
          <div onClick={() => handleOpenHidden("hidden_settings.html")} style={{borderRight: "1px solid black"}}>⚙</div>
          <div onClick={() => handleOpenHidden("hidden_archive.html")} style={{borderRight: "1px solid black"}}>🔍︎</div>
          <div className="archive-info-title" title={archiveInfo.title} onClick={() => handleTitleClicked()}>
            {archiveInfo.title.substring(0, 44) + (archiveInfo.title.length > 46 ? ".." : "")}
          </div>
        </div>
      </div>
      :
      !pseudoFullscreen &&
    <div className='row' 
      style={{height: '35px'}}
      ><div className='col' style={{marginTop: '5px'}}>Loading metadata...</div></div>
    }
    { (url != "" && isMpdLoaded) ? 
      <div 
        tabIndex={0} 
        onMouseEnter={() => handleMouseEnter()} 
        onMouseLeave={() => handleMouseLeave()}
        onKeyDown={(e) => handleKeyDown(e)}
        onDoubleClick={(e) => handlePlayerDoubleClick(e)}
        style={{
          flex: pseudoFullscreen ? 1 : 'initial',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: pseudoFullscreen ? '100%' : 'auto'
        }}
      >
        <div>
          { (() => { console.log( "----- element re-rendered"); return null; })() }
        </div>
        <ReactPlayer 
          ref={ref}
          className='react-player'
          config={{
              file: {
                dashVersion: '4.5.2', //last version supporting IE
                // https://github.com/video-dev/hls.js/releases/tag/v1.2.0
                hlsVersion: '1.2.0', //last version theoretically supporting IE11: https://github.com/video-dev/hls.js/pull/4802
                attributes: {
                  crossOrigin: "true",
                  autoPlay: false,
                  poster: "/iv/images/sm.gif",
                  streaming: {
                    manifestRequestTimeout: 20000,
                    abandonLoadTimeout: 20000,
                    timeoutIntervals: {
                      MPD: 20000,
                      XHRMPDTimeout: 20000,
                    }
                  }
                },
                // @ts-expect-error test
                streaming: {
                    manifestRequestTimeout: 20000,
                    abandonLoadTimeout: 20000,
                    timeoutIntervals: {
                      MPD: 20000,
                      XHRMPDTimeout: 20000,
                    }
                }
              }
          }}
          width={pseudoFullscreen ? '100vw' : '100%'}
          height={pseudoFullscreen ? '100vh' : 'auto'}
          minWidth={pseudoFullscreen ? 0 : 754}
          // minHeight={424}
          url={url}
          pip={pip}
          playing={playing}
          controls={controls}
          light={light}
          loop={loop}
          playbackRate={playbackRate}
          volume={volume}
          muted={muted}
          onReady={handlePlayerReady}
          onStart={handlePlayerStart}
          onPlay={handlePlay}
          onPause={handlePause}
          onBuffer={() => console.log('onBuffer')}
          onPlaybackRateChange={handleOnPlaybackRateChange}
          onSeek={handleSeek}
          onEnded={handleEnded}
          onError={e => console.log('onError', e)}
          onProgress={handleProgress}
          onDuration={handleDuration}>
        </ReactPlayer>
      </div>
      :
      <div style={{width: '100%', minWidth: 754, minHeight: 424, display: 'flex', justifyContent: 'center', alignItems: 'center'}}>
        <div>Loading stream...</div>
      </div>
      }
      <div style={{ display: pseudoFullscreen ? 'none' : 'block' }}>
        <ClipExtractor 
        resume={resume} 
        start={start} 
        stop={stop}
        boundaries={imposeBoundaries}
        videoid = {videoid}
        played={played}
        duration={duration}
        setAt={handleSetAt}
        setAtAbs={handleSetAbs}
        resetAt={handleResetAt}
        goTo={handleGoTo}
        offset={handleOffset}
        setPlaying={setPlaying}
        playing
        repeat
        handleToggleRepeat={handleToggleRepeat}
        handleCopyVideoDetails={handleCopyVideoDetails}
        isShortClip={isShortClip}
        setHHMMSS={setHHMMSS}
        options={options}
        setOptions={setOptions}
        />
        {/* <ExtractBoard/> */}
        {/* <Counter /> */}
        {/* <Subtitles /> */}
        {/* <ReactExtension /> */}
        <ClipTool v_id={queryParameters.get("videoid")?.trim() ?? ""} info={archiveInfo} handleCopyVideoDetails={handleCopyVideoDetails} setResolution={setResolution} 
        start={start} stop={stop}/>
        { archiveInfo && <Archive v_id={queryParameters.get("videoid")?.trim() ?? ""} info={archiveInfo} setInfo={setArchiveInfo}/> }
        { archiveInfo?.captions?.caption_tracks &&
        archiveInfo.captions.caption_tracks.length > 0 ?
          <CaptionsTracks
            url={subtitleUrl}
            tracks={archiveInfo.captions.caption_tracks}
            seek={seekVideo}
          />
          : null
        }
      </div>
    </div>
  );
}

export default App;
