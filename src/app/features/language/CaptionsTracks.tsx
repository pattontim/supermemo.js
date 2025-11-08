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

    // Ensure video element has proper CORS settings
    videoElement.crossOrigin = "anonymous";

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
      
      // Parse and reconstruct the URL
      const originalUrl = tracksCopy[i].base_url;
      let transformedUrl = originalUrl;
      
      try {
        // Handle cases where the URL might already contain fixvtt
        const urlParts = originalUrl.split('/fixvtt/');
        const basePath = urlParts[urlParts.length - 1];
        
        // Ensure the ytjsHost and defaultYtjsHost have proper protocols
        const normalizedYtjsHost = ytjsHost.startsWith('http') ? ytjsHost : `http://${ytjsHost}`;
        const normalizedDefaultYtjsHost = defaultYtjsHost.startsWith('http') ? defaultYtjsHost : `http://${defaultYtjsHost}`;
        
        // Check if it's a full URL or just a path
        if (basePath.startsWith('http')) {
          // It's already in the format we want, just ensure correct hosts
          transformedUrl = `${normalizedYtjsHost}/fixvtt/${basePath}`;
        } else {
          // It's a direct path, construct the full URL
          transformedUrl = `${normalizedYtjsHost}/fixvtt/${normalizedDefaultYtjsHost}/${basePath}`;
        }
        
        console.log('Track URL created:', transformedUrl);
      } catch (error) {
        console.error('Error transforming URL:', originalUrl, error);
        transformedUrl = originalUrl; // Fallback to original if parsing fails
      }
      
      trackElement.src = transformedUrl;
      console.log("Adding track element with transformed URL:", trackElement.src);
      trackElement.kind = "captions";
      trackElement.label = tracksCopy[i].name.text ?? "";
      trackElement.srclang = tracksCopy[i].language_code;
      
      // Set up event handlers for the track element
      trackElement.onload = () => {
        console.log("Track loaded successfully:", trackElement.label);
        handleTracksChange();
      };

      trackElement.onerror = (e) => {
        console.error("Track failed to load:", trackElement.label, e);
      };
      
      // Log track details before appending
      console.log("Adding track:", {
        src: trackElement.src,
        label: trackElement.label,
        kind: trackElement.kind,
        srclang: trackElement.srclang
      });

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
