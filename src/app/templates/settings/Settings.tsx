import { StorageKey, useLocalStorage } from "../../../app/utils/storage";
import React, { useState } from "react";


function App() {
    // Short clips (< some threshold)
    const [playShortOnHover, setPlayShortOnHover] = useLocalStorage(StorageKey.AUTO_HOVER, true);
    const [pauseShortOnHover, setPauseShortOnHover] = useLocalStorage(StorageKey.AUTO_HOVER, false);
    
    // Long clips (>= some threshold)
    const [playLongOnHover, setPlayLongOnHover] = useLocalStorage(StorageKey.AUTO_HOVER_LONG_CLIPS, false);
    const [pauseLongOnHover, setPauseLongOnHover] = useLocalStorage(StorageKey.AUTO_HOVER_LONG_CLIPS, false);
    
    // Outside clip bounds
    const [playOutsideBounds, setPlayOutsideBounds] = useLocalStorage(StorageKey.AUTO_HOVER_OUTSIDE_CLIP_BOUNDS, true);
    const [pauseOutsideBounds, setPauseOutsideBounds] = useLocalStorage(StorageKey.AUTO_HOVER_OUTSIDE_CLIP_BOUNDS, false);
    
    const [playerIsActive, setPlayerIsActive] = useState(false);
    const [clipIsActive, setClipIsActive] = useState(false);
    const [keysIsActive, setKeysIsActive] = useState(true);


  return (
    <div className="app">
      <div className="accordion">
        <div className="accordion-item">
          <div className="accordion-title" onClick={() => setPlayerIsActive(!playerIsActive)}>
            <div>Player [{playerIsActive ? '−' : '+'}]</div>
          </div>
          {playerIsActive &&
            <div className="accordion-content">
              {/* SHORT CLIPS */}
              <div style={{ marginBottom: '20px', paddingBottom: '16px', borderBottom: '2px solid #ddd' }}>
                <div style={{ fontWeight: 'bold', marginBottom: '10px', fontSize: '14px', color: '#333' }}>Short Clips</div>
                <div className="row">
                  <label>
                    <input
                      type="checkbox"
                      checked={playShortOnHover}
                      onChange={(e) => setPlayShortOnHover(e.target.checked)}
                    />
                    Play on hover
                  </label>
                </div>
                <div className="row">
                  <label>
                    <input
                      type="checkbox"
                      checked={pauseShortOnHover}
                      onChange={(e) => setPauseShortOnHover(e.target.checked)}
                    />
                    Pause on hover away
                  </label>
                </div>
              </div>

              {/* LONG CLIPS */}
              <div style={{ marginBottom: '20px', paddingBottom: '16px', borderBottom: '2px solid #ddd' }}>
                <div style={{ fontWeight: 'bold', marginBottom: '10px', fontSize: '14px', color: '#333' }}>Long Clips</div>
                <div className="row">
                  <label>
                    <input
                      type="checkbox"
                      checked={playLongOnHover}
                      onChange={(e) => setPlayLongOnHover(e.target.checked)}
                    />
                    Play on hover
                  </label>
                </div>
                <div className="row">
                  <label>
                    <input
                      type="checkbox"
                      checked={pauseLongOnHover}
                      onChange={(e) => setPauseLongOnHover(e.target.checked)}
                    />
                    Pause on hover away
                  </label>
                </div>
              </div>

              {/* OUTSIDE CLIP BOUNDS */}
              <div>
                <div style={{ fontWeight: 'bold', marginBottom: '10px', fontSize: '14px', color: '#333' }}>Outside Clip Bounds</div>
                <div className="row">
                  <label>
                    <input
                      type="checkbox"
                      checked={playOutsideBounds}
                      onChange={(e) => setPlayOutsideBounds(e.target.checked)}
                    />
                    Play any clip
                  </label>
                </div>
                <div className="row">
                  <label>
                    <input
                      type="checkbox"
                      checked={pauseOutsideBounds}
                      onChange={(e) => setPauseOutsideBounds(e.target.checked)}
                    />
                    Pause any clip
                  </label>
                </div>
              </div>
            </div>
          }
        </div>
        <div className="divider"></div>
        <div className="accordion-item">
          <div className="accordion-title" onClick={() => setClipIsActive(!clipIsActive)}>
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
          <div className="accordion-title" onClick={() => setKeysIsActive(!keysIsActive)}>
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
                      onClick={() => {
                        const currentValue = localStorage.getItem(key);
                        if (currentValue === "true") {
                          localStorage.setItem(key, "false");
                        } else if (currentValue === "false") {
                          localStorage.setItem(key, "true");
                        }
                        setKeysIsActive(!keysIsActive);
                        setTimeout(() => setKeysIsActive(!keysIsActive), 0);
                      }}
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

