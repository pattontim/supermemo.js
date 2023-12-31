import React, { useEffect, useRef, useState } from 'react'
import Transcript from './Transcript' 
import { CaptionTrack } from './../../utils/types';

interface CaptionPlayerProps<T> {
    url: string;
    tracks: CaptionTrack[];
    seek: (time: string) => void;
}

export default function CaptionsTracks<T extends unknown>({ 
    url, tracks, seek }: CaptionPlayerProps<T>) {
    const [activeTrack, setActiveTrack] = useState<TextTrack>();

    // ReactPlayer does not support nested elements AND
    // tracks can't be set dynamically in config
    useEffect(() => {
        for (let i = 0; i < tracks.length; i++) {
            const trackElement = document.createElement('track');

            trackElement.src = tracks[i].base_url;
            trackElement.kind = 'captions';
            trackElement.label = tracks[i].name.text ?? '';
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


            const video = document.getElementsByTagName('video')[0]
            if(video) {
                video.appendChild(trackElement);
            } else {
                console.log("video element not found while adding track");
            }
        }

        return () => {
            // Clean up the dynamically added tracks when the component is unmounted
            // TODO state update cascade?
            const videoElement = document.getElementsByTagName('video')[0];
            tracks?.forEach((_, index) => {
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
