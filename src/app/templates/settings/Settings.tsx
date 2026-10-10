import { StorageKey, useLocalStorage } from "../../../app/utils/storage";
import React, { useState } from "react";
import { SMCheckbox } from "../../features/sm/SMElements";

/**
 * Settings that require a page reload to take effect (e.g., startup-only
 * behaviors, flags consumed by SM at page open). Any future setting added
 * here renders with a "(reload)" marker and contributes to the reload
 * notice shown after it changes.
 */
const REQUIRES_RELOAD = new Set<StorageKey>([
  StorageKey.AUTO_PLAY_SHORTS_ALWAYS,   // startup autoplay already executed
  StorageKey.FAKE_FULLSCREEN_SHORTS,    // affects startup layout
]);

// same dispatcher as storage.ts — kept local so the Flags accordion's
// raw localStorage.setItem also propagates to live hook instances
export const notifyStorageKey = (key: string) => {
  const evt = document.createEvent('Event');
  evt.initEvent('smstorage:' + key, true, true);
  window.dispatchEvent(evt);
};


function App() {

    const [autoplayShortsAlways, setAutoplayShortsAlways] = useLocalStorage(StorageKey.AUTO_PLAY_SHORTS_ALWAYS, false);

    // Short clips (< some threshold)
    const [playShortOnHover, setPlayShortOnHover] = useLocalStorage(StorageKey.AUTO_HOVER, true);
    const [pauseShortOnHover, setPauseShortOnHover] = useLocalStorage(StorageKey.AUTO_HOVER, false);
    
    // Long clips (>= some threshold)
    const [playLongOnHover, setPlayLongOnHover] = useLocalStorage(StorageKey.AUTO_HOVER_LONG_CLIPS, false);
    const [pauseLongOnHover, setPauseLongOnHover] = useLocalStorage(StorageKey.AUTO_HOVER_LONG_CLIPS, false);
    
    // Outside clip bounds
    const [playOutsideBounds, setPlayOutsideBounds] = useLocalStorage(StorageKey.AUTO_HOVER_OUTSIDE_CLIP_BOUNDS, true);
    const [pauseOutsideBounds, setPauseOutsideBounds] = useLocalStorage(StorageKey.AUTO_HOVER_OUTSIDE_CLIP_BOUNDS, false);
    
    // Start shorts in fullscreen
    const [startShortsInFullscreen, setStartShortsInFullscreen] = useLocalStorage(StorageKey.FAKE_FULLSCREEN_SHORTS, true); 

    // Arrow Frame mode
    const [arrowFrameMode, setArrowFrameMode] = useLocalStorage(StorageKey.ARROW_FRAME_MODE, false);

    // Click-to-zoom mode
    const [clickZoom, setClickZoom] = useLocalStorage(StorageKey.CLICK_ZOOM, false);

    // Mouse-follow zoom mode
    const [followZoom, setFollowZoom] = useLocalStorage(StorageKey.FOLLOW_ZOOM, false);

    // Archive/Download settings
    const [cleanupCaptionsOnArchive, setCleanupCaptionsOnArchive] = useLocalStorage(StorageKey.CLEANUP_CAPTIONS_ON_ARCHIVE, false);

    const [playerIsActive, setPlayerIsActive] = useState(false);
    const [clipIsActive, setClipIsActive] = useState(false);
    const [keysIsActive, setKeysIsActive] = useState(true);
    const [reloadNeeded, setReloadNeeded] = useState(false);

    const trackReload = (key: StorageKey) => {
      if (REQUIRES_RELOAD.has(key)) setReloadNeeded(true);
    };


  return (
    <div className="app">
      {reloadNeeded && (
        <div className="row" style={{ padding: '6px 10px', backgroundColor: '#fff3cd', border: '1px solid #d6b656', marginBottom: '8px' }}>
          Reload the element for changes to take effect.
        </div>
      )}
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
                  <SMCheckbox
                    checked={playShortOnHover}
                    onChange={setPlayShortOnHover}
                    label="Play on hover"
                  />
                </div>
                <div className="row">
                  <SMCheckbox
                    checked={pauseShortOnHover}
                    onChange={setPauseShortOnHover}
                    label="Pause on hover away"
                  />
                </div>
                <div className="row">
                  <SMCheckbox
                    checked={autoplayShortsAlways}
                    onChange={(v) => { setAutoplayShortsAlways(v); trackReload(StorageKey.AUTO_PLAY_SHORTS_ALWAYS); }}
                    label="Always autoplay shorts on start"
                    requiresReload={REQUIRES_RELOAD.has(StorageKey.AUTO_PLAY_SHORTS_ALWAYS)}
                  />
                </div>
              </div>

              {/* LONG CLIPS */}
              <div style={{ marginBottom: '20px', paddingBottom: '16px', borderBottom: '2px solid #ddd' }}>
                <div style={{ fontWeight: 'bold', marginBottom: '10px', fontSize: '14px', color: '#333' }}>Long Clips</div>
                <div className="row">
                  <SMCheckbox
                    checked={playLongOnHover}
                    onChange={setPlayLongOnHover}
                    label="Play on hover"
                  />
                </div>
                <div className="row">
                  <SMCheckbox
                    checked={pauseLongOnHover}
                    onChange={setPauseLongOnHover}
                    label="Pause on hover away"
                  />
                </div>
              </div>

              {/* OUTSIDE CLIP BOUNDS */}
              <div>
                <div style={{ fontWeight: 'bold', marginBottom: '10px', fontSize: '14px', color: '#333' }}>Outside Clip Bounds</div>
                <div className="row">
                  <SMCheckbox
                    checked={playOutsideBounds}
                    onChange={setPlayOutsideBounds}
                    label="Play any clip"
                  />
                </div>
                <div className="row">
                  <SMCheckbox
                    checked={pauseOutsideBounds}
                    onChange={setPauseOutsideBounds}
                    label="Pause any clip"
                  />
                </div>
                <div className="row">
                  <SMCheckbox
                    checked={startShortsInFullscreen}
                    onChange={(v) => { setStartShortsInFullscreen(v); trackReload(StorageKey.FAKE_FULLSCREEN_SHORTS); }}
                    label="Start shorts in fullscreen"
                    requiresReload={REQUIRES_RELOAD.has(StorageKey.FAKE_FULLSCREEN_SHORTS)}
                  />
                </div>
              </div>

              {/* CONTROLS */}
              <div>
                <div style={{ fontWeight: 'bold', marginBottom: '10px', fontSize: '14px', color: '#333' }}>Controls</div>
                <div className="row">
                  <SMCheckbox
                    checked={arrowFrameMode}
                    onChange={setArrowFrameMode}
                    label="Use arrow keys to move back/forth frames"
                  />
                </div>
                <div className="row">
                  <SMCheckbox
                    checked={clickZoom}
                    onChange={setClickZoom}
                    label="Click to zoom video (1.5x, centered on click)"
                  />
                </div>
                <div className="row">
                  <SMCheckbox
                    checked={followZoom}
                    onChange={setFollowZoom}
                    label="Zoom video follows mouse (1.5x)"
                  />
                </div>
              </div>
            </div>
          }
        </div>
        <div className="divider"></div>
        <div className="accordion-item">
          <div className="accordion-title" onClick={() => setClipIsActive(!clipIsActive)}>
            <div>Archive/Download [{clipIsActive ? '−' : '+'}]</div>
          </div>
          {clipIsActive &&
            <div className="accordion-content">
              <div style={{ marginBottom: '20px', paddingBottom: '16px', borderBottom: '2px solid #ddd' }}>
                <div style={{ fontWeight: 'bold', marginBottom: '10px', fontSize: '14px', color: '#333' }}>Caption Settings</div>
                <div className="row">
                  <SMCheckbox
                    checked={cleanupCaptionsOnArchive}
                    onChange={setCleanupCaptionsOnArchive}
                    label="Cleanup captions on archive"
                  />
                </div>
                <div style={{ fontSize: '12px', color: '#666', marginTop: '8px', marginLeft: '24px' }}>
                  Removes formatting issues, multiline spam, and IE11 incompatibilities. Normalizes HTML entities like &amp;nbsp; and invisible characters.
                </div>
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
                        notifyStorageKey(key);
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

