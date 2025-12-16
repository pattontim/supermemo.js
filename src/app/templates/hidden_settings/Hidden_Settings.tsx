import React, { useMemo } from "react";
import { useEffect, useState, useRef } from "react";

import ClipExtractor from "../../features/extractors/ClipExtractor";
import { convertHHMMSS2Seconds } from "../../utils/Duration";
import HiddenExtractor from "../../features/extractors/HiddenExtractor";
import { decodeOptionsFromSearchParam, encodeOptionsToSearchParam, decodeSessionFromSearchParam, encodeSessionToSearchParam, Session } from "../../../app/utils/supermemo";

// import * from App as Hidden from '../hidden/Hidden';
// import * as Hidden from '../hidden/Hidden';

function App() {
  const queryParameters = new URLSearchParams(window.location.search);

  // Check for session data
  const sessionParam = queryParameters.get('session');
  const session = decodeSessionFromSearchParam(sessionParam);
  
  // Extract options from session or fallback to legacy options param
  const [options, setOptions] = useState(session?.options ?? decodeOptionsFromSearchParam(queryParameters.get("options")));

  function handleGoBack(){
        const settingsURL = new URL(document.location.href.replace("hidden_settings.html", "smplayer.html"));
        
        // Create updated session with modified options and restore original player state
        const updatedSession: Session = {
          resume: session?.resume ?? null,
          start: session?.start ?? null,
          stop: session?.stop ?? null,
          played: session?.played ?? 0,
          options
        };
        
        settingsURL.searchParams.set("session", encodeSessionToSearchParam(updatedSession));
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
        start={session?.start ?? null}
        stop={session?.stop ?? null}
        resume={session?.resume ?? null}
      />
      <iframe src="settings.html" width="100%" height="450px" frameBorder="0"/>
      
    </div>
  );
}

export default App;

