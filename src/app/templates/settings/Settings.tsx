import React, { useMemo } from "react";
import { useEffect, useState, useRef } from "react";

import ClipExtractor from "../../features/extractors/ClipExtractor";
import { convertHHMMSS2Seconds } from "../../utils/Duration";

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

  const [playerIsActive, setPlayerIsActive] = useState(false);
  const [clipIsActive, setClipIsActive] = useState(false);

  function handleGoBack(){
    window.history.back();
  }

  function handlePlayerClick() {
    setPlayerIsActive(!playerIsActive);
  }

  function handleClipClick() {
    setClipIsActive(!clipIsActive);
  }

  return (
    <div className="app">
      <div hidden>
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
      </div>
      <div className="col">
        <div className="row">
          <div onClick={() => handleGoBack()} style={{border: "1px solid black", marginRight: "5px"}}>←</div>
          <b> Settings</b>
        </div>
      </div>
      <div className="accordion">
                <div className="accordion-item">
                    <div className="accordion-title" onClick={handlePlayerClick}>
                        <div>Player [{playerIsActive ? '−' : '+'}]</div>
                    </div>
                    {playerIsActive &&
                        <div className="accordion-content">
                            <div className="row">
                                <div>Player settings coming soon...</div>
                            </div>
                        </div>
                    }
                </div>
                <div className="divider"></div>
                <div className="accordion-item">
                    <div className="accordion-title" onClick={handleClipClick}>
                        <div>Clip [{clipIsActive ? '−' : '+'}]</div>
                    </div>
                    {clipIsActive &&
                        <div className="accordion-content">
                            <div className="row">
                                <div>Clip settings coming soon...</div>
                            </div>
                        </div>
                    }
                </div>
            </div>    
    </div>
  );
}

export default App;

