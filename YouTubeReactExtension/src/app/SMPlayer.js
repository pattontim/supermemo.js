import React from 'react';
// import ReactPlayer from 'react-player/lazy';
import ReactPlayer from 'react-player/lazy'
// import ReactExtension from './react-extension.js';
// import ExtractBoard from './features/clip/ExtractBoard.js'; 
import ClipExtractor from './features/clip/ClipExtractor.js';
// import Counter from './features/counter/Counter.js';
// import Subtitles from './features/language/Subtitles.js';


import { useState, useRef } from 'react';

function App() {
  const queryParameters = new URLSearchParams(window.location.search)
  // const [url, setUrl] = useState("http://youtube.com/watch?v=" + queryParameters.get('videoid')) 

  const [resumeSec, setResumeSec] = React.useState("00:00:00");
  const [startSec, setStartSec] = React.useState("00:00:03");
  const [stopSec, setStopSec] = React.useState("00:00:08");
  const [imposeBoundries, setImposeBoundries] = React.useState(0);

  // const [url, setUrl] = useState('https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4');
  // const [url, setUrl] = useState("https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_640x360_800k.mpd");
  const [url, setUrl] = useState("http://localhost:8080/http://localhost:3000/mpd_test.mpd");
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

  function convertHHMMSS2Duration(hhmmss) {
    var a = hhmmss.split(':'); // split it at the colons
    var seconds = (+a[0]) * 60 * 60 + (+a[1]) * 60 + (+a[2]);
    return seconds;
  }

  function convertDuration2HHMMSS(duration) {
    var sec_num = parseInt(duration, 10); // don't forget the second param
    var hours   = Math.floor(sec_num / 3600);
    var minutes = Math.floor((sec_num - (hours * 3600)) / 60);
    var seconds = sec_num - (hours * 3600) - (minutes * 60);

    if (hours   < 10) {hours   = "0"+hours;}
    if (minutes < 10) {minutes = "0"+minutes;}
    if (seconds < 10) {seconds = "0"+seconds;}
    return hours + ':' + minutes + ':' + seconds;
  }

  function checkBoundaries() {
    if (ref.current) {
        //console.log('checking boundaries')
        if (ref.current.getCurrentTime() < convertHHMMSS2Duration(document.getElementById("startvideoat").value)) {
            //console.log('before start')
            ref.current.seekTo(convertHHMMSS2Duration(document.getElementById("startvideoat").value), 'seconds');
        } else if (ref.current.getCurrentTime() > convertHHMMSS2Duration(document.getElementById("stopvideoat").value)) {
            //console.log('after stop')
            ref.current.seekTo(convertHHMMSS2Duration(document.getElementById("startvideoat").value), 'seconds');
        }
    }
  }

  function handlePlayerStart(player) {
    console.log('player ready');

    seekVideo("start");
    checkBoundaries();
  }

  function setStart() {
    setStartSec(convertDuration2HHMMSS(ref.current.getCurrentTime()));
  }

  return (
    <div className="app">

      <ReactPlayer 
              ref={ref}
              className='react-player'
              config={{
                  file: {
                    dashVersion: '3.2.2',
                    attributes: {
                      crossOrigin: 'true',
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
              // onReady={handlePlayerReady}
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
      <ClipExtractor resume={resumeSec} start={startSec} stop={stopSec} setStart={setStart} />
      {/* <ExtractBoard/> */}
      {/* <Counter /> */}
      {/* <Subtitles /> */}
      {/* <ReactExtension /> */}
    </div>
  );
}

export default App;
