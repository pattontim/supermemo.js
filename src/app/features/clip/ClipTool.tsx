import { useState } from "react";
import { ArchiveInfoV1 } from "../../../../ytjs/src/utils/archive";
import React from "react";

interface ClipToolProps<T> {
    v_id: string;
    info: ArchiveInfoV1 | undefined
    handleCopyVideoDetails: () => void;
    setResolution: (resolution: string) => void;
}

export default function ClipTool<T extends unknown>({ v_id, info, handleCopyVideoDetails, setResolution }: ClipToolProps<T>) {
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

    function getActiveCueText() {
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

        return activeCue.text.replace(/<\/?[^>]+(>|$)/g, '').replace(/\n/g, '').trim();
    }

    const handleCaptionCopyBtnClick = () => {
        const activeCueText = getActiveCueText();
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

    const handleTranslateCaptionBtnClick = () => {
        const activeCueText = getActiveCueText();
        if(!activeCueText) {
            return;
        }

        // https://translate.google.com/?sl=ja&tl=en&text={}&op=translate
        const encoded = encodeURIComponent(activeCueText);
        const url = `microsoft-edge:https://translate.google.com/?sl=auto&tl=auto&text=${encoded}&op=translate`;
        // open in new window, IE11
        window.open(url, '_blank');
    }

    const handleOpenSummarizer = () => {
        window.open(`microsoft-edge:https://www.summarize.tech/https://www.youtube.com/watch?v=${v_id}`);
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
                                <div className="col">
                                    <button type="button" id="copyBtn" onClick={handleCopyVideoDetails}>Copy Details</button>
                                    <button type="button" id="screenshotBtn" onClick={handleScreenshotClick}>Screenshot</button>
                                    <button type="button" id="copyCaptionBtn" onClick={handleCaptionCopyBtnClick}>Copy Cap</button>
                                    <button type="button" id="translateCapBtn" onClick={handleTranslateCaptionBtnClick}>Open TL</button>
                                    <button type="button" id="summarizeBtn" onClick={handleOpenSummarizer}>Summarize</button>
                                    {Object.keys(info?.archived_on ?? []).length === 0 &&
                                        <>
                                            {/* <button onClick={() => setResolution("360")}>360p</button> */}
                                            <button onClick={() => setResolution("480")}>480p</button>
                                            <button onClick={() => setResolution("720")}>720p</button>
                                            <button onClick={() => setResolution("1080")}>1080p</button>
                                        </>
                                    }
                                </div>
                            </div>
                        </div>
                    }
                </div>
            </div>
        </>
    )
}