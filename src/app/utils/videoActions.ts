/**
 * videoActions
 * ------------
 * Self-contained page actions lifted out of the old ClipTool closure so they
 * can be invoked from the SMControls overlay. They only touch the DOM <video>
 * element and/or the video id, so they need no React context.
 *
 * IE11/ES5 note: no Array.prototype.at, no optional chaining.
 */

/**
 * Opens the current <video> frame in a new window as a JPEG so the user can
 * right-click and copy it.
 */
export function screenshotVideo(): void {
    // Get the first video element on the page
    var video = document.querySelector('video');

    if (video) {
        // Create a canvas element
        var canvas = document.createElement('canvas');
        var ctx = canvas.getContext('2d');

        if (!ctx) return;

        // Set canvas dimensions to match the video
        canvas.width = video.width || video.videoWidth;
        canvas.height = video.height || video.videoHeight;

        // Draw the current frame of the video onto the canvas
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Convert the canvas content to a data URL with JPEG format
        var imageDataURL = canvas.toDataURL('image/jpeg');

        var newWinFeatures = 'width=' + canvas.width + ',height=' + canvas.height + ',resizable=yes,scrollbars=no,status=yes,toolbar=no,menubar=no,location=no';

        // Open a new window
        var newWindow = window.open('', '_blank', newWinFeatures);

        if (newWindow) {
            // Generate HTML content with the image
            var htmlContent = '<html><head><title>Image Viewer</title></head><body style="margin: 0; display: flex; align-items: center; justify-content: center; height: 100vh;"><img src="' + imageDataURL + '" alt="Image"></body></html>';

            // Set the HTML content of the new window
            newWindow.document.write(htmlContent);

            newWindow.focus();

            console.log('Image opened in a new window. Right-click the image and select "Copy" from the context menu.');
        } else {
            console.error('Failed to open a new window.');
        }
    } else {
        console.error('No video element found on the page.');
    }
}

/**
 * Returns the concatenated text of the cue currently under the playhead,
 * optionally including `linesContext` neighbouring cues on each side.
 */
export function getActiveCueText(linesContext: number = 0): string | undefined {
    var videoElement = document.getElementsByTagName('video')[0];
    if (!videoElement) return;

    var activeTextTrack = Array.prototype.slice.call(videoElement.textTracks)
        .filter(function (track: TextTrack) { return track.mode === 'showing'; })[0];

    if (videoElement.textTracks.length === 0 || !activeTextTrack || !activeTextTrack.cues) {
        return;
    }

    var cues = Array.prototype.slice.call(activeTextTrack.cues) as VTTCue[];
    var activeCue = cues.filter(function (cue) {
        return cue.startTime <= videoElement.currentTime && cue.endTime >= videoElement.currentTime;
    })[0] as VTTCue;

    if (!activeCue) {
        return;
    }

    var activeCueIndex = cues.indexOf(activeCue);
    var start = Math.max(0, activeCueIndex - linesContext);
    var end = Math.min(cues.length - 1, activeCueIndex + linesContext);

    var activeCueText = '';
    for (var i = start; i <= end; i++) {
        var cue = cues[i] as VTTCue;
        activeCueText += cue.text.replace(/<\/?[^>]+(>|$)/g, '').replace(/\n/g, '').trim();
    }

    return activeCueText;
}

/** Copies the active cue (optionally with context) to the clipboard. */
export function copyCue(linesContext: number = 0): void {
    var activeCueText = getActiveCueText(linesContext);
    if (!activeCueText) {
        return;
    }

    var textArea = document.createElement('textarea');
    textArea.value = activeCueText;
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand('copy');
    document.body.removeChild(textArea);
}

/** Opens the DeepL translator for the active cue (optionally with context). */
export function translateCue(linesContext: number = 0): void {
    var activeCueText = getActiveCueText(linesContext);
    if (!activeCueText) {
        return;
    }

    // Encode the text for URL
    var encodedText = encodeURIComponent(activeCueText);

    // TODO: use prefs
    var sourceLang = "ja"; // Replace with dynamic source language detection if needed
    var targetLang = "en-gb"; // Replace with desired target language
    var deeplUrl = 'microsoft-edge:https://www.deepl.com/translator#' + sourceLang + '/' + targetLang + '/' + encodedText;

    // Open in new window
    window.open(deeplUrl, "_blank");
}

/** Opens the Kagi summarizer for the given video. */
export function summarizeWithAI(v_id: string): void {
    var youtubeUrl = encodeURIComponent('https://www.youtube.com/watch?v=' + v_id);
    window.open('microsoft-edge:https://kagi.com/summarizer/index.html?target_language=&summary=takeaway&url=' + youtubeUrl);
}

/** Opens the video on youtube.com, optionally at the clip start time. */
export function openInYouTube(v_id: string, start: string | null): void {
    window.open('microsoft-edge:https://www.youtube.com/watch?v=' + v_id + '&t=' + start);
}
