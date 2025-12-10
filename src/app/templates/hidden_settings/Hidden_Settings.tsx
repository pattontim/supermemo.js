import React, { useMemo } from "react";
import { useEffect, useState, useRef } from "react";

import ClipExtractor from "../../features/extractors/ClipExtractor";
import { convertHHMMSS2Seconds } from "../../utils/Duration";
import HiddenExtractor from "../../features/extractors/HiddenExtractor";
import { decodeOptionsFromSearchParam, encodeOptionsToSearchParam } from "../../../app/utils/supermemo";

// import * from App as Hidden from '../hidden/Hidden';
// import * as Hidden from '../hidden/Hidden';

function App() {
  const queryParameters = new URLSearchParams(window.location.search);

  const [resume, setResume] = useState(queryParameters.get("resume"));
  // TODO component passed as prop?
  // const [resumeStyle, setResumeStyle] = React.useState({ border: `2px solid ${borderCl}` });
  const [start, setStart] = useState(queryParameters.get("start"));
  // const [startStyle, setStartStyle] = React.useState({ border: `2px solid ${borderCl}` });
  const [stop, setStop] = useState(queryParameters.get("stop"));
  // const [stopStyle, setStopStyle] = React.useState({ border: `2px solid ${borderCl}` });
  const [imposeBoundaries, setImposeBoundaries] = useState(1);
  const [videoid, setVideoid] = useState(
    queryParameters.get("videoid")?.trim() ?? null
  );

  const [playing, setPlaying] = useState(false);
  const [controls, setControls] = useState(true);
  const [played, setPlayed] = useState(
    start ? convertHHMMSS2Seconds(start) : 0
  );
  const [loaded, setLoaded] = useState(0);
  const [options, setOptions] = useState(decodeOptionsFromSearchParam(queryParameters.get("options")));

  function handleGoBack(){
        const settingsURL = new URL(document.location.href.replace("hidden_settings.html", "smplayer.html"));
        settingsURL.searchParams.set("options", encodeOptionsToSearchParam(options));
        window.location.href = settingsURL.toString();
  }

  return (
    <div className="app">
      <div className="col">
        <div className="row">
          <div onClick={() => handleGoBack()} style={{border: "1px solid black", marginRight: "5px"}}>←</div>
          <b> Settings</b>
        </div>
      </div>
      <HiddenExtractor
        options={options}
      />
      <iframe src="settings.html" width="100%" height="450px" frameBorder="0"/>
      {/* <div hidden>
        <ClipExtractor
          resume={resume}
          start={start}
          stop={stop}
          boundaries={imposeBoundaries}
          videoid={videoid}
          played={played}
          duration={0}
          setAt={() => {}}
          setAtAbs={() => {}}
          resetAt={() => {}}
          goTo={() => {}}
          offset={() => {}}
          setPlaying={setPlaying}
          playing={false}
          repeat={true}
          handleToggleRepeat={() => {}}
          handleCopyVideoDetails={() => {}}
          isShortClip={false}
          setHHMMSS={() => {}}
        />
      </div> */}
      {/* <Hidden.default>
      </Hidden.default> */}
      
    </div>
  );
}

export default App;

