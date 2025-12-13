import { StorageKey, useLocalStorage } from "../../../app/utils/storage";
import React, { useMemo } from "react";
import { useEffect, useState, useRef } from "react";


function App() {
    const [autoHover, setAutoHover] = useLocalStorage(StorageKey.AUTO_HOVER, true);
    const [autoHoverLongClips, setAutoHoverLongClips] = useLocalStorage(StorageKey.AUTO_HOVER_LONG_CLIPS, false);
    
    const [playerIsActive, setPlayerIsActive] = useState(false);
  function handlePlayerClick() {
      setPlayerIsActive(!playerIsActive);
  }
  const [clipIsActive, setClipIsActive] = useState(false);
  function handleClipClick() {
    setClipIsActive(!clipIsActive);
  }
  const [keysIsActive, setKeysIsActive] = useState(true);
  function handleKeysClick() {
    setKeysIsActive(!keysIsActive);
  }

      // Function to toggle boolean flags
    const toggleFlag = (key: StorageKey) => {
        const currentValue = localStorage.getItem(key);
        if (currentValue === "true") {
            localStorage.setItem(key, "false");
        } else if (currentValue === "false") {
            localStorage.setItem(key, "true");
        }
        // Force re-render by updating state
        setKeysIsActive(!keysIsActive);
        setTimeout(() => setKeysIsActive(!keysIsActive), 0);
    };


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
                                {/* <div>Player settings coming soon...</div> */}
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={autoHover}
                                        onChange={(e) => setAutoHover(e.target.checked)}
                                    />
                                    Pause/Play video short clips on hover
                                </label>
                            </div>
                            {/* toggle to apply autohover to long clips too */}
                            <div className="row">
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={autoHoverLongClips}
                                        onChange={(e) => setAutoHoverLongClips(e.target.checked)}
                                    />
                                    Pause/Play video long clips on hover too
                                </label>
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
                <div className="divider"></div>
                <div className="accordion-item">
                    <div className="accordion-title" onClick={handleKeysClick}>
                    <div>Flags [{keysIsActive ? '−' : '+'}]</div>
                </div>
                {keysIsActive &&
                    <div className="accordion-content">
                        {Object.values(StorageKey)
                            .filter(key => {
                                const value = localStorage.getItem(key);
                                return value === "true" || value === "false";
                            })
                            .map((key) => {
                                const isActive = localStorage.getItem(key) === "true";
                                return (
                                    <div
                                        key={key}
                                        onClick={() => toggleFlag(key as StorageKey)}
                                        style={{
                                            padding: '8px 12px',
                                            cursor: 'pointer',
                                            borderBottom: '1px solid #eee',
                                            display: 'flex',
                                            justifyContent: 'space-between'
                                        }}
                                        className="row"
                                    >
                                        <span>{key}</span>
                                        <span
                                            style={{
                                                color: isActive ? '#4CAF50' : '#f44336',
                                                fontWeight: 'bold'
                                            }}
                                        >
                                            {isActive ? 'ON' : 'OFF'}
                                        </span>
                                    </div>
                                );
                            })}
                    </div>
                }
                </div>
            </div>    
    </div>
  );
}

export default App;

