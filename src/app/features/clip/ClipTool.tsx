import { useState } from "react";
import { ArchiveInfo } from "../../../../ytjs/src/utils/archive";
import React from "react";

interface ClipToolProps<T> {
    v_id: string;
    info: ArchiveInfo | undefined
    handleCopyVideoDetails: () => void;
    setResolution: (resolution: string) => void;
    start: string | null 
    stop: string | null
}

export default function ClipTool<T extends unknown>({ v_id, info, handleCopyVideoDetails, setResolution, start, stop }: ClipToolProps<T>) {
    const [isActive, setIsActive] = useState(true);

    function handleClick() {
        setIsActive(!isActive)
    }

    function handleScreenshotClick(): void {
        // Get the first video element on the page
        var video = document.querySelector('video');

        if (video) {
            // Create a canvas element
            var canvas = document.createElement('canvas');
            var ctx = canvas.getContext('2d');

            if(!ctx) return;

            // Set canvas dimensions to match the video
            canvas.width = video.width || video.videoWidth;
            canvas.height = video.height || video.videoHeight;

            // Draw the current frame of the video onto the canvas
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            // Convert the canvas content to a data URL with JPEG format
            var imageDataURL = canvas.toDataURL('image/jpeg'); // specify 'image/jpeg' for JPEG format

            var newWinFeatures = 'width=' + canvas.width + ',height=' + canvas.height + ',resizable=yes,scrollbars=no,status=yes,toolbar=no,menubar=no,location=no';

            // Open a new window
            var newWindow = window.open('', '_blank', newWinFeatures);

            if (newWindow) {
                // Generate HTML content with the image
                var htmlContent = '<html><head><title>Image Viewer</title></head><body style="margin: 0; display: flex; align-items: center; justify-content: center; height: 100vh;"><img src="' + imageDataURL + '" alt="Image"></body></html>';

                // Set the HTML content of the new window
                newWindow.document.write(htmlContent);

                newWindow.focus();

                // Display a message
                console.log('Image opened in a new window. Right-click the image and select "Copy" from the context menu.');
            } else {
                console.error('Failed to open a new window.');
            }
        } else {
            console.error('No video element found on the page.');
        }

    }

    function getActiveCueText(linesContext = 0) {
        const videoElement = document.getElementsByTagName('video')[0];

        const activeTextTrack = Array.from(videoElement.textTracks)
            .find(track => track.mode === 'showing');

        if(videoElement.textTracks.length === 0 || !activeTextTrack || !activeTextTrack.cues) {
            return;
        }

        const activeCue = Array.from(activeTextTrack.cues)
            .find(cue => cue.startTime <= videoElement.currentTime && cue.endTime >= videoElement.currentTime) as VTTCue;

        if(!activeCue) {
            return;
        }

        const activeCueIndex = Array.from(activeTextTrack.cues).indexOf(activeCue);
        const cues = Array.from(activeTextTrack.cues);

        const start = Math.max(0, activeCueIndex - linesContext);
        const end = Math.min(cues.length - 1, activeCueIndex + linesContext);

        let activeCueText = '';
        for(let i = start; i <= end; i++) {
            const cue = cues[i] as VTTCue;
            activeCueText += cue.text.replace(/<\/?[^>]+(>|$)/g, '').replace(/\n/g, '').trim();
        }

        return activeCueText;
    }

    const handleCaptionCopyBtnClick = (linesContext = 0) => {
        const activeCueText = getActiveCueText(linesContext);
        if(!activeCueText) {
            return;
        }

        const textArea = document.createElement('textarea');
        textArea.value = activeCueText;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
    };

    const handleTranslateCaptionBtnClick = (linesContext = 0) => {
      const activeCueText = getActiveCueText(linesContext);
      if (!activeCueText) {
        return;
      }

      // Encode the text for URL
      const encodedText = encodeURIComponent(activeCueText);

      // TODO: use prefs  
      const sourceLang = "ja"; // Replace with dynamic source language detection if needed
      const targetLang = "en-gb"; // Replace with desired target language
      const deeplUrl = `microsoft-edge:https://www.deepl.com/translator#${sourceLang}/${targetLang}/${encodedText}`;

      // Open in new window
      window.open(deeplUrl, "_blank");
    };

    const handleOpenSummarizer = () => {
        const youtubeUrl = encodeURIComponent(`https://www.youtube.com/watch?v=${v_id}`);
        window.open(`microsoft-edge:https://kagi.com/summarizer/index.html?target_language=&summary=takeaway&url=${youtubeUrl}`);
    }

    const handleOpenMagnifier = () => {
        //send get to localhost:5000/magnify
        //open magnifier
        const url = `http://localhost:3000/magnify`;
        //xmlhttprequest
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.send();
    }

    const handleOpenYT = () => {
        window.open(`microsoft-edge:https://www.youtube.com/watch?v=${v_id}&t=${start}`);
    }

    return (
        <>
            <div className="accordion">
                <div className="accordion-item">
                    <div className="accordion-title" onClick={handleClick}>
                        <div>Clip Tools [{isActive ? '−' : '+'}]</div>
                    </div>
                    {isActive &&
                        <div className="accordion-content">
                            <div className="row">
                                <button type="button" id="copyBtn" onClick={handleCopyVideoDetails} title="Copy details">📋 Details</button>
                                <button type="button" id="copyCaptionBtn" onClick={() => handleCaptionCopyBtnClick()} title="Copy captions">📋 Cap</button>
                                <button type="button" id="copyCaptionContextBtn" onClick={() => handleCaptionCopyBtnClick(1)} title="Copy captions context">💫</button>
                                |
                                <button type="button" id="translateCapBtn" onClick={() => handleTranslateCaptionBtnClick()} title="Open translation">🌎 TL</button>
                                <button type="button" id="translateCapContextBtn" onClick={() => handleTranslateCaptionBtnClick(1)} title="Open translation with context">💫</button>
                                |
                                <button type="button" id="summarizeBtn" onClick={handleOpenSummarizer} title="Open a summary on summarize.tech">Summarize</button>
                                |
                                {Object.keys(info?.archived_on ?? []).length === 0 &&
                                    <>
                                        {/* <button onClick={() => setResolution("360")}>360p</button> */}
                                        <button onClick={() => setResolution("480")} title="set 480p resolution">480p</button>
                                        <button onClick={() => setResolution("720")} title="set 720p resolution">720p</button>
                                        <button onClick={() => setResolution("1080")} title="set 1080p resolution">1080p</button>
                                        <button type="button" id="ytBtn" onClick={handleOpenYT} title="Open in youtube">🌎 YT</button>
                                    </>
                                }
                                |
                                <button type="button" id="screenshotBtn" onClick={handleScreenshotClick} title="Screenshot">🖼️</button>
                                <button type="button" id="magnifyBtn" onClick={handleOpenMagnifier} title="Open windows magnifier">🔎</button>
                            </div>
                        </div>
                    }
                </div>
            </div>
        </>
    )
}