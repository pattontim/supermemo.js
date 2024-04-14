import React, { useRef } from "react";
import { useState } from "react";
import { convertHHMMSS2Seconds, convertHHMMSS2Vector3D, convertVector3D2HHMMSS, formatTime } from "../../utils/Duration";
// import { PlayerProps } from "../../utils/types";

interface Option {
  label: string;
  value: string;
}

interface PlayerProps<T> {
    resume: string | null;
    start: string | null;
    stop: string | null;
    boundaries: number;
    videoid: string | null;
    played: number;
    duration: number;
    setAt: (type: string,  offsetSec?: number, offsetMin?: number, offsetHour?: number) => void;
    setAtAbs: (type: string, abs: number) => void;
    resetAt: (type: string) => void;
    goTo: (type: string) => void;
    offset: (type: string, offset: number) => void;
    setPlaying: (playing: boolean) => void;
    playing: boolean;
    repeat: boolean;
    handleToggleRepeat: () => void;
    handleCopyVideoDetails: () => void;
    isShortClip: boolean;
    setHHMMSS: (type: string, hhmmss: string) => void;
}

export default function ClipExtractor<T extends unknown>({resume, start, stop, boundaries, videoid, played, duration, 
    setAt, setAtAbs, resetAt, goTo, offset, setPlaying, playing, repeat, handleToggleRepeat, 
    handleCopyVideoDetails, isShortClip, setHHMMSS } : PlayerProps<T>)
    {
    
    const [options, setOptions] = useState<Option[]>([]);
    const [selectedOption, setSelectedOption] = React.useState<Option | null>(null);
    const extractNum = useRef(1);

    // these props are emulated to match the original code behavior
    const [emulatedCustomPromptVisible, setEmulatedCustomPromptVisible] = useState("0");
    const [emulatedExtractName, setEmulatedExtractName] = useState("")

    /* 
     * offset the resume vector for the clip extractor
     * 
     * @param type - the type of offset, either "start" or "stop"
     * @param offsetBin - the offset in bins (bins are 1/59 of clip duration for now)
     * @returns the new resume vector
     * 
     */
    function offsetResumeVector(type: "start" | "stop", offsetBin: number) {
        const startSec = convertHHMMSS2Seconds(start);
        const stopSec = convertHHMMSS2Seconds(stop);

        const resumeVector = convertHHMMSS2Vector3D(resume);

        // TODO calculate bin size
        // const duration = stopSec - startSec;
        // const secBinDistance = 1/59; 

        const newVector = {
            x: resumeVector.x,
            y: type === "start" ? resumeVector.y + offsetBin: resumeVector.y,
            z: type === "stop" ? resumeVector.z + offsetBin : resumeVector.z
        }

        setHHMMSS("resume", convertVector3D2HHMMSS(newVector));
    }

    /* 
     * create a resume vector for the clip extractor with y and z set to the basis
     * 
     * @param basisSeconds - the basis in seconds (usually the current time)
     * @returns the resume vector or, null if the basis is not within the clip boundaries
     * 
     */
    function createResumeVector(basisSeconds: number) {
        const startSec = convertHHMMSS2Seconds(start);
        const stopSec = convertHHMMSS2Seconds(stop);

        if(basisSeconds < startSec || basisSeconds > stopSec) {
            console.warn("Basis is not within clip boundaries");
            return { x: 0, y: 0, z: 0 };
        }
        const clipPlayedSec = basisSeconds - startSec;
        const duration = stopSec - startSec;
        console.log("clipPlayedSec", clipPlayedSec, "duration", duration);

        const percentPlayed = clipPlayedSec / duration;
        console.log("percentPlayed", percentPlayed);
 
        const offsetsToStart  = [null, 25, -25, null, null, 50, -50, null, null, null];
        const offsetsToStop = [null,  null, null, 25, -25, null, null, 50, -50, null, null];
        
        const basis = Math.round(percentPlayed * 59)
        console.log("basis", basis);
        const isWholePercent = percentPlayed % 1 === 0;
        console.log("isWholePercent", isWholePercent);

        if(!isWholePercent) {
            // TODO calacluate closest offset bin to the basis
        }

        return {
            x: 0,
            y: basis,
            z: basis
        };
    }


    const addOption = (offsetSec: number) => {
        setPlaying(false);
        const defaultName = "Extract #" + extractNum.current++;
        // @ts-expect-error
        setEmulatedCustomPromptVisible(1);
        const newOptionText = prompt('Enter an extract name:', defaultName);
        if (newOptionText) {
            setEmulatedExtractName(newOptionText);
            let selStart = formatTime(convertHHMMSS2Seconds(start), duration)
            let selStop = formatTime(convertHHMMSS2Seconds(stop), duration)
            if (offsetSec < 0) {
                selStart = formatTime(played + offsetSec, duration)
                selStop = formatTime(played, duration);
            } else if (offsetSec > 0) {
                selStart = formatTime(played, duration);
                selStop = formatTime(played + offsetSec, duration)
            }

            const formattedOption = selStart + ' - ' + selStop;
            const newOption = { value: formattedOption, label: newOptionText };
            setOptions([...options, newOption]);
            setSelectedOption(newOption);
            // setAtAbs('start', convertHHMMSS2Seconds(stop));
            resetAt('stop');
            setPlaying(true);
        }
        // @ts-expect-error this is how the original code behaves
        setEmulatedCustomPromptVisible(0);
    };

    // TODO set selected so we can mirror start changes to start/stop indnpendently 
    const handleSelectChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
        const selectedOption = event.target.value;
        if(selectedOption){
            setSelectedOption(options.find(option => option.value === selectedOption) || null);
            const [selStart, selStop] = selectedOption.split(' - ');
            setAtAbs('start', convertHHMMSS2Seconds(selStart));
            setAtAbs('stop', convertHHMMSS2Seconds(selStop));
            goTo('start');
        }
    };

    const handleRemoveCurrentExtractBtnClick = () => {
        if(selectedOption){
            const newOptions = options.slice();
            newOptions.splice(options.indexOf(selectedOption), 1);
            setOptions(newOptions);
            setSelectedOption(newOptions.at(-1) ?? null);
        }
    };

    const handleCaptionCopyBtnClick = () => {
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

        const activeCueText = activeCue.text.replace(/<\/?[^>]+(>|$)/g, '');

        const textArea = document.createElement('textarea');
        textArea.value = activeCueText;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
    };


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

    function handleResetBtnClick(): void {
        resetAt('start');
        resetAt('stop');
    }

    return (
        <div>
            <div id="customPrompt" hidden>
                <div className="hd">Save As</div>
                <div className="bd">
                    <form name="promptForm" id="promptForm">
                        <label htmlFor="extractName">Extract name: </label>
                        <input type="text" name="extractName" id="extractName" value={emulatedExtractName}/>
                    </form>
                </div>
            </div>
            <div id="feedbackOuter">
                <div className="img-yellow-message-top-cap"></div>
                <div className="left-right-border-yellow">
                    <div id="feedbackInner"></div>
                </div>
                <div className="img-yellow-message-bottom-cap"></div>
            </div>
            <div className="videoWrapper">
                <div id="bideo"></div>
            </div>
            <input type="hidden" value={videoid ?? ''} id="videoid" />
            <input type="hidden" value={boundaries} id="imposeboundries" />
            <fieldset>
                <div className="row" style={isShortClip ? {backgroundColor: "yellowgreen"} : {}}>
                    <div className="col">
                        {!isShortClip ?
                            <button type="button" id="mark" onClick={() => setAt('resume')}> [ Mark ]</button>
                            : 
                            <>
                            <button type="button" id="beepStartBtn" onClick={() => { offsetResumeVector("start", -1) }}>&lt; </button>
                            <button type="button" id="beepStartBtn" onClick={() => { offsetResumeVector("start", 1) }}>&gt; </button>
                            <button type="button" id="beepStartBtn" onClick={() => { setHHMMSS("resume", convertVector3D2HHMMSS(createResumeVector(played)))}}>[O] </button>
                            <button type="button" id="beepStopBtn" onClick={() => { offsetResumeVector("stop", -1) }}>&lt; </button>
                            <button type="button" id="beepStopBtn" onClick={() => { offsetResumeVector("stop", 1) }}>&gt; </button>
                            </>
                        }
                        <img src="/iv/images/transparent.png" title="Rewind 1 Sec." alt="Rewind 1 Sec." id="rewindResume" onClick={() => offset('resume', -1)} className="imgBtn rewind" />
                        <img src="/iv/images/transparent.png" alt="Go to" title="Go to" id="resume" onClick={() => goTo('resume')} className="imgBtn goTo" />
                        <img src="/iv/images/transparent.png" title="Forward 1 Sec." alt="Forward 1 Sec." id="forwardResume" className="imgBtn forward" onClick={() => offset('resume', 1)} />
                        <input type="text" value={resume ?? ''} id="resumevideoat" onClick={() => setAt('resume')} onChange={() => { }} />
                        <img src="/iv/images/transparent.png" alt="Restore default" id="restoreResumeAt" onClick={() => resetAt('resume')} className="imgBtn restoreStartAt" />
                    </div>
                    <div className="col">
                        <button type="button" id="start" onClick={() => setAt('start')} title="Set clip start" style={{width: "45px"}}>[</button>
                        <img src="/iv/images/transparent.png" title="Rewind 1 Sec." alt="Rewind 1 Sec." id="rewindStart" onClick={() => offset('start', -1)} className="imgBtn rewind"/>
                        <img src="/iv/images/transparent.png" alt="Go to" title="Go to" id="goToStart" onClick={() => goTo('start')} className="imgBtn goTo"/>
                        <img src="/iv/images/transparent.png" title="Forward 1 Sec." alt="Forward 1 Sec." id="forwardStart" onClick={() => offset('start', 1)} className="imgBtn forward"/>
                        <input type="text" value={start ?? ''} id="startvideoat" onClick={() => setAt('start')} onChange={() => {}}/>
                        <img src="/iv/images/transparent.png" alt="Restore default" title="Restore default" id="restoreStartAt" onClick={() => resetAt('start')} className="imgBtn restoreStartAt"/>
                        ~
                        <img src="/iv/images/transparent.png" alt="Restore default" title="Restore default" id="restoreStopAt" onClick={() => resetAt('stop')} className="imgBtn restoreStopAt"/>
                        <input type="text" value={stop ?? ''} id="stopvideoat" onClick={() => setAt('stop')} onChange={() => {}}/>
                        <img src="/iv/images/transparent.png" title="Rewind 1 Sec." alt="Rewind 1 Sec." id="rewindStop" onClick={() => offset('stop', -1)} className="imgBtn rewind"/>
                        <img src="/iv/images/transparent.png" alt="Go to" title="Go to" id="goToStop" onClick={() => goTo('stop')} className="imgBtn goTo"/>
                        <img src="/iv/images/transparent.png" title="Forward 1 Sec." alt="Forward 1 Sec." id="forwardStop" onClick={() => offset('stop', 1)} className="imgBtn forward"/>
                        <button type="button" id="stop" onClick={() => setAt('stop')} title="Set clip end" style={{width: "45px"}}>]</button>
                    </div>
                </div>
                <div className="row">
                    <div className="col">
                        <input type="checkbox" checked={repeat} id="repeat" className="checkbox" onChange={handleToggleRepeat} />
                        {/* <label htmlFor="repeat" id="repeat" title="Repeat (R)">&nbsp;</label> */}
                        <img src="/iv/images/transparent.png" id="repeat" title="Repeat (R)" alt="Repeat (R)" className="imgBtn repeat" onClick={handleToggleRepeat} />
                    </div>
                    <div className="col">
                        <button type="button" id="test" onClick={() => goTo('start')}>Test</button>
                        <button type="button" id="reset" onClick={handleResetBtnClick}>Reset</button>
                        <button type="button" id="extract" onClick={() => addOption(0)}>Extract</button>
                        <button type="button" className="" id="extractm10" onClick={() => addOption(-10)}>-10</button>
                        <button type="button" className="" id="extractm5" onClick={() => addOption(-5)}>-5</button>
                        <button type="button" className="" id="extract" onClick={() => addOption(5)}>+5</button>
                        <button type="button" className="" id="extract10" onClick={() => addOption(10)}>+10</button>
                        <select id="extracts" value={selectedOption?.value} onChange={handleSelectChange}>
                            {options.map((option, index) => (
                                <option value={option.value}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                        { selectedOption == null ? <img src="/iv/images/transparent.png" alt="Remove the currently selected extract" id="removeCurrentExtract" className="imgBtn removeCurrentExtract" />
                        : <img 
                            src="/iv/images/transparent.png" alt="Remove the currently selected extract" id="removeCurrentExtract" className="imgBtn removeCurrentExtract" 
                            style={{background: "transparent url(/iv/images/icons.png) no-repeat -140px 0"}} onClick={handleRemoveCurrentExtractBtnClick}
                            // onMouseOver={(e) => {e.currentTarget.style.backgroundPosition = "-140px -20px"}}
                            />}
                        <input type="hidden" value={emulatedCustomPromptVisible} id="customPromptVisible" />
                    </div>
                </div>
                <div className="row">
                    <div className="col">
                        <button type="button" id="copyBtn" onClick={handleCopyVideoDetails} >YT Copy Details</button>
                        <button type="button" id="screenshotBtn" onClick={handleScreenshotClick}>YT Screenshot</button>
                        <button type="button" id="copyCaptionBtn" onClick={handleCaptionCopyBtnClick}>Copy Cap</button>
                    </div>
                </div>  
                <div className="row" hidden>
                    <textarea id="log" style={{width: "100%"}} hidden></textarea>
                </div>
                <div className="row" hidden>
                    <div className="ctrlSubgrp firstCtrlSubgrp debug" hidden>Date: May 24, 2023</div>
                </div>
            </fieldset>
        </div>
    )
}
