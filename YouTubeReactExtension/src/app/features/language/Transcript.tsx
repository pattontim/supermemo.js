import React, { useEffect, useState } from 'react'
import TranscriptLine from './TranscriptLine.js'
// import './Track.css'

export default function Transcript<T extends unknown>({ track, url, 
    seek, query } : TranscriptProps<T>) {
    const [isActive, setIsActive] = useState(false);

    return (
        <>
            <div className="accordion">
                <div className="accordion-item">
                    <div className="accordion-title" onClick={ () => setIsActive(!isActive) }>
                        <div>Transcript</div>
                        <div>{isActive ? '-' : '+'}</div>
                    </div>
                    { isActive &&
                    <div className="accordion-content">
                        <div className="track">
                            {track && track.cues && track.cues.length > 0 ?
                                Array.from(track.cues).map((cue, index) =>
                                    (cue as VTTCue).text.includes("<c>") ? null :
                                        <TranscriptLine
                                            key={`line-${index}`}
                                            cue={cue}
                                            seek={seek}
                                            query={query} />
                                ) : <div></div>
                            }
                        </div>
                    </div>
                    }
                </div>
            </div>
        </>
    )
}
