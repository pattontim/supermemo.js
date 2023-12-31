import React from 'react';
import { useEffect, useState, useRef } from 'react';
// import ReactPlayer from 'react-player/lazy';
import ReactPlayer from 'react-player/lazy';
// import ReactExtension from './react-extension.js';
// import ExtractBoard from './features/clip/ExtractBoard.js'; 
import ClipExtractor from './features/clip/ClipExtractor';
import CaptionsTracks from './features/language/CaptionsTracks';
// import Counter from './features/counter/Counter.js';
// import Subtitles from './features/language/Subtitles.js';
import { ArchiveInfoV1 } from '../../ytjs/src/utils/archive';
type ArchiveInfo = ArchiveInfoV1 // | ArchiveInfoV2; // totally extensible

import { convertHHMMSS2Seconds, convertSeconds2HHMMSS, constrainToRange, formatTime } from './utils/Duration';
import Archive from './features/archive/Archive';

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
  const [videoid, setVideoid] = useState(queryParameters.get('videoid'));
  const videoIdAtStart = new String(queryParameters.get('videoid')).toString();
  const [repeat, setRepeat] = useState(true);
  const [numRepeats, setNumRepeats] = useState(0);

  // const [url, setUrl] = useState('https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4');
  // const [url, setUrl] = useState("https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_640x360_800k.mpd");
  // const [url, setUrl] = useState("http://youtube.com/watch?v=" + queryParameters.get('videoid')) 
  const [url, setUrl] = useState("");
  const [subtitleUrl, setSubtitleUrl] = useState("http://localhost:3000/captions/" + queryParameters.get('videoid'));
  
  const [pip, setPip] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [controls, setControls] = useState(true);
  const [light, setLight] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [muted, setMuted] = useState(false);
  const [played, setPlayed] = useState(start ? convertHHMMSS2Seconds(start) : 0);
  const [loaded, setLoaded] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [loop, setLoop] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const [archiveInfo, setArchiveInfo] = useState<ArchiveInfo>();

  const ref = useRef<ReactPlayer>(null)

  // // SM browser as remote component
  // useEffect(() => {
  //   setResume(queryParameters.get('resume'));
  //   setStart(queryParameters.get('start'));
  //   setStop(queryParameters.get('stop'));
  //   setVideoid(queryParameters.get('videoid'));
  // }, []);

  useEffect(() => {
    // setUrl("http://localhost:3000/mpd/" + queryParameters.get('videoid') + ".mpd?target=IE#t=" + convertHHMMSS2Seconds(start) + "," + convertHHMMSS2Seconds(stop));

    // TODO
    const url = new URL("http://localhost:3000/streamUrl/" + queryParameters.get('videoid'));
    url.searchParams.append('startSec', convertHHMMSS2Seconds(start).toString());
    url.searchParams.append('stopSec', convertHHMMSS2Seconds(stop).toString());
    url.searchParams.append('target', 'IE');

    const req = new XMLHttpRequest();
    req.open('GET', url.toString(), true);
    req.responseType = 'json';
    req.onload = function() {
      if (req.status !== 200) {
        console.log('Error: ' + req.status);
        return;
      }
      console.log(req.response);
      setUrl(req.response);
    }
    req.send();  

  }, []);

  const handlePlay = () => {
    console.log('onPlay')
    setPlaying(true)
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
    console.log('onProgress', state)
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

  function handleToggleRepeat() {
    setRepeat(!repeat);
  }

  function handlePlayerReady( player: any ) {
    fetchArchiveInfo(queryParameters.get('videoid') as string);

    seekVideo(start);
    setPlaying(true);
    console.log('player ready');
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

  function handleSetAt(type: string, offsetSec: number) {
    console.log('handleSetAt', type, offsetSec, played, duration, played + offsetSec)
    let new_val = formatTime(played + offsetSec, duration);
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
    archiveReq.open('GET', "http://localhost:3000/archiveInfo/" + v_id);
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

    
  return (
    <div className="app">

    { archiveInfo &&
      <div className="archive-info">
        <div className="archive-info-title">
          {archiveInfo.title}
        </div>
      </div>
    }
    { url != "" && 
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
            />
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
      />
      {/* <ExtractBoard/> */}
      {/* <Counter /> */}
      {/* <Subtitles /> */}
      {/* <ReactExtension /> */}
      { archiveInfo?.captions?.caption_tracks &&
      archiveInfo.captions.caption_tracks.length > 0 ?
        <CaptionsTracks
          url={subtitleUrl}
          tracks={archiveInfo.captions.caption_tracks}
          seek={seekVideo}
        />
        : null
      }
      { archiveInfo && <Archive v_id={queryParameters.get("videoid") ?? ""} info={archiveInfo} setInfo={setArchiveInfo}/> }
    </div>
  );
}

export default App;
