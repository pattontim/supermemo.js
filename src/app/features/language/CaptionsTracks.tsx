import React, { useEffect, useRef, useState } from 'react'
import Transcript from './Transcript' 
import { CaptionTrack } from './../../utils/types';
import { ytjsHost, defaultYtjsHost } from '../../utils/client';

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
        const tracksCopy = JSON.parse(JSON.stringify(tracks)) as CaptionTrack[];

        for (let i = 0; i < tracksCopy.length; i++) {
            const trackElement = document.createElement('track');

            // do the replacement here to avoid archiving different hosts
            // const replaceRegex = /^(?:([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+\.[a-zA-Z]{2,})|(?:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/g;
            // const rawReplace = "localhost:3000";
            const rawReplace = defaultYtjsHost;
            trackElement.src = tracksCopy[i].base_url.replace(rawReplace, ytjsHost);
            console.log("Adding track element: " + trackElement.src);
            trackElement.kind = 'captions';
            trackElement.label = tracksCopy[i].name.text ?? '';
            trackElement.srclang = tracksCopy[i].language_code;
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
            tracksCopy?.forEach((_, index) => {
                const trackElement = videoElement.querySelector(`[src="${tracksCopy[index].base_url}"]`);
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
