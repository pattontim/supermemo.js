import React, { useEffect, useRef, useState } from "react";
import Transcript from "./Transcript";
import { CaptionTrack } from "./../../utils/types";
import { ytjsHost, defaultYtjsHost } from "../../utils/client";
import { useLocalStorage } from "../../utils/storage";

interface CaptionPlayerProps<T> {
  url: string;
  tracks: CaptionTrack[];
  seek: (time: string) => void;
}

export default function CaptionsTracks<T extends unknown>({
  url,
  tracks,
  seek,
}: CaptionPlayerProps<T>) {
  const [activeTrack, setActiveTrack] = useState<TextTrack>();
  const [prefLangCode, setPrefLangCode] = useLocalStorage("prefLangCode", "");
  const [prefLangLabel, setPrefLangLabel] = useLocalStorage(
    "prefLangLabel",
    "Japanese"
  );

  // ReactPlayer does not support nested elements AND
  // tracks can't be set dynamically in config
  useEffect(() => {
    const tracksCopy = JSON.parse(JSON.stringify(tracks)) as CaptionTrack[];
    const videoElement = document.getElementsByTagName("video")[0];
    if (!videoElement) {
      console.log("No video element found");
      return;
    }

    // Function to handle track changes and set the preferred language
    const handleTracksChange = () => {
      console.log("Handling tracks change, looking for preferred language:", prefLangLabel);
      const textTracks = videoElement.textTracks;
      console.log("Available tracks:", Array.from(textTracks).map(t => t.label));
      
      Array.from(textTracks).forEach((track: TextTrack) => {
        if (track.label === prefLangLabel) {
          console.log(`Found preferred track: ${track.label}, setting to showing`);
          track.mode = "showing";
          setActiveTrack(track);
        } else {
          track.mode = "hidden";
        }
      });
    };

    // Create and add track elements
    for (let i = 0; i < tracksCopy.length; i++) {
      const trackElement = document.createElement("track");
      const rawReplace = defaultYtjsHost;
      trackElement.src = tracksCopy[i].base_url.replace(rawReplace, ytjsHost);
      console.log("Adding track element: " + trackElement.src);
      trackElement.kind = "captions";
      trackElement.label = tracksCopy[i].name.text ?? "";
      trackElement.srclang = tracksCopy[i].language_code;
      
      // Set up onload handler for each track
      trackElement.onload = () => {
        console.log("Track loaded:", trackElement.label);
        handleTracksChange();
      };

      videoElement.appendChild(trackElement);
    }

    // Set up track change listener
    const tracksChangeListener = () => {
      console.log("Tracks list changed");
      handleTracksChange();
    };
    videoElement.textTracks.addEventListener('addtrack', tracksChangeListener);

    // Initial check for tracks
    handleTracksChange();

    // Cleanup function
    return () => {
      if (videoElement) {
        videoElement.textTracks.removeEventListener('addtrack', tracksChangeListener);
        tracksCopy?.forEach((track, index) => {
          const trackElement = videoElement.querySelector(
            `[src="${tracksCopy[index].base_url}"]`
          );
          if (trackElement) {
            videoElement.removeChild(trackElement);
          }
        });
      }
    };

    return () => {
      // Clean up the dynamically added tracks when the component is unmounted
      // TODO state update cascade?
      const videoElement = document.getElementsByTagName("video")[0];
      tracksCopy?.forEach((_, index) => {
        const trackElement = videoElement.querySelector(
          `[src="${tracksCopy[index].base_url}"]`
        );
        if (trackElement) {
          document.getElementsByTagName("video")[0].removeChild(trackElement);
        }
      });
    };
  }, [tracks]);

  return (
    <>
      {/* {activeTrack && activeTrack.cues && activeTrack.cues.length > 0 ? */}
      <Transcript track={activeTrack} url={url} seek={seek} query={null} />
      {/* : null
            } */}
    </>
  );
}
