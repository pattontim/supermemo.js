import React from 'react';
// import ReactPlayer from 'react-player/lazy';
import ReactPlayer from 'react-player/lazy'
// import ReactExtension from './react-extension.js';
// import ExtractBoard from './features/clip/ExtractBoard.js'; 
import ClipExtractor from './features/clip/ClipExtractor.js';
// import Counter from './features/counter/Counter.js';
// import Subtitles from './features/language/Subtitles.js';

import { convertHHMMSS2Duration, convertDuration2HHMMSS, constrainToRange } from './utils/Duration.js';


import { useState, useRef } from 'react';

function App() {
  const queryParameters = new URLSearchParams(window.location.search)
  // const [url, setUrl] = useState("http://youtube.com/watch?v=" + queryParameters.get('videoid')) 

  const [resume, setResume] = React.useState(queryParameters.get('resume'));
  const [start, setStart] = React.useState(queryParameters.get('start'));
  const [stop, setStop] = React.useState(queryParameters.get('stop'));
  const [imposeBoundries, setImposeBoundries] = React.useState(0);

  // const [url, setUrl] = useState('https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4');
  // const [url, setUrl] = useState("https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_640x360_800k.mpd");
  const [url, setUrl] = useState("http://localhost:3000/mpd/" + queryParameters.get('videoid') + ".mpd");
  
  const [pip, setPip] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [controls, setControls] = useState(true);
  const [light, setLight] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [muted, setMuted] = useState(false);
  const [played, setPlayed] = useState(0);
  const [loaded, setLoaded] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [loop, setLoop] = useState(false);
  const [seeking, setSeeking] = useState(false);

  const ref = useRef(null);

  const handlePlay = () => {
    console.log('onPlay')
    setPlaying(true)
  }

  const handlePause = () => {
    console.log('onPause')
    setPlaying(false)
  }

  const handleOnPlaybackRateChange = (playbackRate) => {
    console.log('onPlaybackRateChange', playbackRate)
    setPlaybackRate(playbackRate)
  }

  const handleEnded = () => {
    console.log('onEnded')
    setPlaying(loop)
  }

  const handleProgress = (state) => {
    console.log('onProgress', state)
    // We only want to update time slider if we are not currently seeking
    if (!seeking) {
      setPlayed(state.playedSeconds)
      checkBoundaries()
    }
  }

  const handleDuration = (duration) => {
    console.log('onDuration', duration)
    setDuration(duration)
  }

  function seekVideo(to) {
    if (ref.current) {
        //console.log('seeking from ' + ytplayer.getCurrentTime() + ' to ' + convertHHMMSS2Duration(document.getElementById(to + "videoat").value))
        ref.current.seekTo(convertHHMMSS2Duration(document.getElementById(to + "videoat").value), 'seconds');
    }
  }

  function checkBoundaries() {
    if (ref.current) {
        //console.log('checking boundaries')
        if (ref.current.getCurrentTime() < convertHHMMSS2Duration(start)) {
            //console.log('before start')
            ref.current.seekTo(convertHHMMSS2Duration(start), 'seconds');
        } else if (ref.current.getCurrentTime() > convertHHMMSS2Duration(stop)) {
            //console.log('after stop')
            ref.current.seekTo(convertHHMMSS2Duration(start), 'seconds');
        }
    }
  }

  function handlePlayerReady( player ) {
    console.log('player ready');
  }
  function handlePlayerStart(player) {
    console.log('player start');

    seekVideo("start");
    checkBoundaries();
  }

  // function setStart() {
  //   setStart(convertDuration2HHMMSS(ref.current.getCurrentTime()));
  // }

  // TODO HHMMSS, call with -999999999 and 999999999
  // TODO not needed, use set directly
  function setAt(type, offset) {
    // TODO conform to duration whenever it is set using react
    let new_val = constrainToRange(played + offset, 0, duration);
    if (type === "resume") {
        setResume(new_val);
    } else if (type === "start") {
        setStart(new_val);
    } else if (type === "stop") {
        setStop(new_val);
    } 
  }

  function goTo(type) {
    if (type === "resume") {
        setPlayed(resume);
    } else if (type === "start") {
        setPlayed(start);
    } else if (type === "stop") {
        setPlayed(stop);
    }
  }

  return (
    <div className="app">

      <ReactPlayer 
              ref={ref}
              className='react-player'
              config={{
                  file: {
                    dashVersion: '4.5.2', //last version supporting IE
                    attributes: {
                      crossOrigin: true,
                      autoplay: true,
                      poster: "/iv/images/sm.png",
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
              onSeek={e => console.log('onSeek', e)}
              onEnded={handleEnded}
              onError={e => console.log('onError', e)}
              onProgress={handleProgress}
              onDuration={handleDuration}
            />
      <ClipExtractor 
      resume={resume} 
      start={start} 
      stop={stop}
      played={played}
      duration={duration}
      />
      {/* <ExtractBoard/> */}
      {/* <Counter /> */}
      {/* <Subtitles /> */}
      {/* <ReactExtension /> */}
    </div>
  );
}

export default App;
