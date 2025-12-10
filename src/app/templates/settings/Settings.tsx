import React, { useMemo } from "react";
import { useEffect, useState, useRef } from "react";


function App() {
  const [playerIsActive, setPlayerIsActive] = useState(false);
  const [clipIsActive, setClipIsActive] = useState(false);

  function handlePlayerClick() {
    setPlayerIsActive(!playerIsActive);
  }

  function handleClipClick() {
    setClipIsActive(!clipIsActive);
  }

  return (
    <div className="app">
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

