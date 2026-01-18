import React, { useState } from "react";
import { useEffect } from "react";

import HiddenExtractor from "../../features/extractors/HiddenExtractor";
import { decodeSessionFromSearchParam, encodeSessionToSearchParam, Session } from "../../../app/utils/supermemo";

function App() {
  const queryParameters = new URLSearchParams(window.location.search);

  // Check for session data
  const sessionParam = queryParameters.get('session');
  const session = decodeSessionFromSearchParam(sessionParam);

  function handleGoBack(){
        const archiveURL = new URL(document.location.href.replace("hidden_archive.html", "smplayer.html"));
        
        // Create updated session with original player state
        const updatedSession: Session = {
          resume: session?.resume ?? null,
          start: session?.start ?? null,
          stop: session?.stop ?? null,
          played: session?.played ?? 0,
          options: session?.options ?? []
        };
        
        archiveURL.searchParams.set("session", encodeSessionToSearchParam(updatedSession));
        window.location.href = archiveURL.toString();
  }

  return (
    <div className="app">
      <div className="col">
        <div className="row">
          <div onClick={() => handleGoBack()} style={{border: "1px solid black", marginRight: "5px"}}>←</div>
          <b> Archive</b>
        </div>
      </div>
      <HiddenExtractor
        options={session?.options ?? []}
        start={session?.start ?? null}
        stop={session?.stop ?? null}
        resume={session?.resume ?? null}
      />
      <iframe src="archive.html" width="100%" height="450px" frameBorder="0"/>
    </div>
  );
}

export default App;
