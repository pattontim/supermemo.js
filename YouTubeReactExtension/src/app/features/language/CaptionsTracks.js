import React, { useEffect, useRef, useState } from 'react'
import Transcript from './Transcript.js' 

export default function CaptionsTracks({ url, tracks, seek, videoRef }) {
    const [activeTrack, setActiveTrack] = useState();

    // ReactPlayer does not support nested elements AND
    // tracks can't be set dynamically in config
    useEffect(() => {
        for (let i = 0; i < tracks.length; i++) {
            const trackElement = document.createElement('track');

            trackElement.src = tracks[i].base_url;
            trackElement.kind = 'captions';
            trackElement.label = tracks[i].name.text;
            trackElement.srclang = tracks[i].language_code;
            trackElement.onload = () => {
                console.log("track loaded (handler), setting active track, trackElement = " + trackElement);
                setTimeout(() => {
                    const textTracks = document.getElementsByTagName("video")[0].textTracks
                    for (let i = 0; i < textTracks.length; i++) {
                        if (textTracks[i].language === trackElement.srclang) {
                            setActiveTrack(textTracks[i]);
                            break;
                        }
                    }
                }, 1000);
            };


            document.getElementsByTagName('video')[0].appendChild(trackElement);
        }

        return () => {
            // Clean up the dynamically added tracks when the component is unmounted
            tracks.forEach((_, index) => {
                const trackElement = videoElement.querySelector(`[src="${tracks[index].base_url}"]`);
                if (trackElement) {
                    document.getElementsByTagName('video')[0].removeChild(trackElement);
                }
            });
        };
        
    }, [tracks]);

    return (
        <>
            {/* {activeTrack && activeTrack.cues && activeTrack.cues.length > 0 ? */}
                <Transcript
                    track={activeTrack}
                    url={url}
                    seek={seek}
                    query={null}
                />
                 {/* : null
            } */}
        </>
    )
}
