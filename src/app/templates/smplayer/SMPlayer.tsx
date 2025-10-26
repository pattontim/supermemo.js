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
import { useLocalStorage } from '../../utils/storage';
import ClipTool from '../../features/clip/ClipTool';
import { ytjsHost } from '../../utils/client';

function App() {
  const queryParameters = new URLSearchParams(window.location.search)

  // TODO component passed as prop?
  const [resume, setResume] = useState(queryParameters.get('resume'));
  // const [resumeStyle, setResumeStyle] = React.useState({ border: `2px solid ${borderCl}` });
  const [start, setStart] = useState(queryParameters.get('start'));
  // const [startStyle, setStartStyle] = React.useState({ border: `2px solid ${borderCl}` });
  const [stop, setStop] = useState(queryParameters.get('stop'));
  // const [stopStyle, setStopStyle] = React.useState({ border: `2px solid ${borderCl}` });
  const [imposeBoundaries, setImposeBoundaries] = useState(1);
  const [videoid, setVideoid] = useState(queryParameters.get('videoid')?.trim() ?? null);
  const [repeat, setRepeat] = useState(true);
  const [numRepeats, setNumRepeats] = useState(0);

  // const [url, setUrl] = useState('https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4');
  // const [url, setUrl] = useState("https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_640x360_800k.mpd");
  // const [url, setUrl] = useState("http://youtube.com/watch?v=" + queryParameters.get('videoid')) 
  const [url, setUrl] = useState("");
  const [isMpdLoaded, setIsMpdLoaded] = useState(false);
  const [subtitleUrl, setSubtitleUrl] = useState("http://" + ytjsHost + "/captions/" + queryParameters.get('videoid'));
  
  const [pip, setPip] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [controls, setControls] = useState(true);
  const [light, setLight] = useState(false);
  const [volume, setVolume] = useLocalStorage('vol-' + videoid, 0.8);
  const [muted, setMuted] = useState(false);
  const [played, setPlayed] = useState(start ? convertHHMMSS2Seconds(start) : 0);
  const [loaded, setLoaded] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [loop, setLoop] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const [archiveInfo, setArchiveInfo] = useState<ArchiveInfo>();
  const isShortClip = useMemo(() => {
    // console.log('isShortClip', stop, start, convertHHMMSS2Seconds(stop) - convertHHMMSS2Seconds(start));
    // console.log("duration", duration, convertHHMMSS2Seconds(stop), convertHHMMSS2Seconds(start));
    const clipDur = stop ? convertHHMMSS2Seconds(stop) - convertHHMMSS2Seconds(start): null;
    return clipDur && (clipDur < 15) && (duration - convertHHMMSS2Seconds(stop) > 1) ? true : false;
  }, [start, stop, duration]);
  
  const [isMouseOverPlayer, setIsMouseOverPlayer] = useState(false);

  const ref = useRef<ReactPlayer>(null)

  // // SM browser as remote component
  // useEffect(() => {
  //   setResume(queryParameters.get('resume'));
  //   setStart(queryParameters.get('start'));
  //   setStop(queryParameters.get('stop'));
  //   setVideoid(queryParameters.get('videoid'));
  // }, []);

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
      const streamUrl = req.response as string;
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
        // For non-MPD streams, set URL directly
        setUrl(streamUrl);
        setIsMpdLoaded(true);
      }
    }
    req.send();
  }, []);

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

  const handlePause = () => {
    console.log('onPause')
    setPlaying(false)
  }

  const handleSeek = (destSec: number) => {
    if(destSec < convertHHMMSS2Seconds(start) - 3 || destSec > convertHHMMSS2Seconds(stop) + 3) {
      setImposeBoundaries(0);
    }
    console.log('onSeek to ', destSec)
    setPlayed(destSec)
  }

  const handleOnPlaybackRateChange = (playbackRate: number) => {
    console.log('onPlaybackRateChange', playbackRate)
    setPlaybackRate(playbackRate)
  }

  const handleEnded = () => {
    console.log('onEnded')
    setPlaying(loop)
  }

  // TODO state 
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

  const handleDuration = (duration: number) => {
    console.log('onDuration', duration)
    setDuration(duration)
  }

  function seekVideo(to: string | null) {
    if (ref.current) {
        //console.log('seeking from ' + ref.current.getCurrentTime() + ' to ' + to + ' (' + convertHHMMSS2Seconds(to) + ')')
        ref.current.seekTo(convertHHMMSS2Seconds(to));
    }
  }

  function checkBoundaries() {
    if(!repeat) return;
    if (ref.current) {
        //console.log('checking boundaries')
        if (ref.current.getCurrentTime() < convertHHMMSS2Seconds(start)) {
            //console.log('before start')
            ref.current.seekTo(convertHHMMSS2Seconds(start));
        } else if (ref.current.getCurrentTime() > convertHHMMSS2Seconds(stop)) {
            //console.log('after stop')
            ref.current.seekTo(convertHHMMSS2Seconds(start));
        }
    }
  }

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
          // console.error('Invalid action');
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

    //this progress's timeslice start can vary by up to 300ms
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

  function handleToggleRepeat() {
    setRepeat(!repeat);
  }

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
  }

  function handlePlayerStart() {
    console.log('player start');
  }

  function handleResetAt(type: string) {
    if (type === "resume") {
        setResume("0:00");
    } else if (type === "start") {
        setStart(formatTime(0, 0));
    } else if (type === "stop") {
        setStop(formatTime(duration, duration));
    }
  }

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

  function setHHMMSS(type: string, hhmmss: string) {
    if (type === "resume") {
        setResume(hhmmss);
    } else if (type === "start") {
        setStart(hhmmss);
    } else if (type === "stop") {
        setStop(hhmmss);
    }
  }

  /*
   * Set the resume/start/stop time to the current time plus the offset
    * @param {string} type - the type of time to set
    * @param {number} offsetSec - the number of seconds to add to the current time
    * @param {number} offsetMin - the number of minutes to add to the current time
    * @param {number} offsetHour - the number of hours to add to the current time
    * @returns {void}
    * 
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

  function handleOffset(type: string, offset: number) {
    if (type === "resume") {
        setResume(formatTime(convertHHMMSS2Seconds(resume) + offset, duration));
    } else if (type === "start") {
        setStart(formatTime(convertHHMMSS2Seconds(start) + offset, duration));
    } else if (type === "stop") {
        setStop(formatTime(convertHHMMSS2Seconds(stop) + offset, duration));
    }
  }

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

    function handleStopChange(elem: HTMLInputElement) {          
        if(playing && convertHHMMSS2Seconds(stop) < duration){
            elem.style.border = "2px solid blue";
        } else {
            elem.style.border = "2px inset";
        }
    }
    function handleStartChange(elem: HTMLInputElement){
        if(convertHHMMSS2Seconds(start) > 0){
            elem.style.border = "2px solid blue";
        } else {
            elem.style.border = "2px inset";
        }
    }

    function customDebugger() {
      // getInternalPlayer('dash') to get the dash.js player
      const player = ref.current?.getInternalPlayer('dash');
      if (!player) {
        console.log('No player');
        return;
      }
      console.log('Player', player);
      

    }

    function setResolution(res: string){
      // Assuming you have already initialized the dash.js player
      const player = ref.current?.getInternalPlayer('dash');
      if (!player) {
        window.alert("dash player not found (archive?)")
        return;
      }

      // Get the available quality levels
      // player.setAutoSwitchQualityFor('video', false);
      const qualityLevels = player.getBitrateInfoListFor('video').map((info: { height: any; }) => info.height);

      // Set the quality to 720p
      const level = qualityLevels.indexOf(res)
      if(!level) {
        window.alert("quality not found")
        return;
      }
      player.setQualityFor('video', level);
    }

    
  return (
    <div className="app">

    { archiveInfo &&
      <div className="archive-info" style={isShortClip ? {backgroundColor: "yellowgreen"} : {}}>
        <div className="archive-info-title">
          {archiveInfo.title}
        </div>
      </div>
    }
    { url != "" && isMpdLoaded && 
      <div 
        tabIndex={0} 
        onMouseEnter={() => {
          setIsMouseOverPlayer(true);
          if(isShortClip){
            setPlaying(true);
          }
        }}
        onMouseLeave={() => {
          setIsMouseOverPlayer(false);
          if(isShortClip){
            setPlaying(false);
          }
        }}
        onKeyDown={(e) => {
        if (e.key === 'right' || e.key === 'ArrowRight') {
          seekVideo(formatTime(played + 1, duration));
        } else if (e.key === 'left' || e.key === 'ArrowLeft') {
          seekVideo(formatTime(played - 1, duration));
        } else if (e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          setPlaying(!playing);
        } else if (e.key === '>') {
          // seek forward one frame assuming 30fps
          ref?.current?.seekTo(played + (1 / 30), 'seconds');
        } else if (e.key === '<') {
          // seek backward one frame assuming 30fps
          ref?.current?.seekTo(played - (1 / 30), 'seconds');
        }
        e.preventDefault();
        e.stopPropagation();
      }} >
      <div>
        { (() => { console.log( "----- element re-rendered"); return null; })() }
        </div>
      <ReactPlayer 
              ref={ref}
              className='react-player'
              config={{
                  file: {
                    dashVersion: '4.5.2', //last version supporting IE
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
              width='100%'
              height='100%'
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
              onDuration={handleDuration}
            >
            </ReactPlayer>
      </div>
      }
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
  );
}

export default App;
