import React from "react";
import { useState } from "react";
import { convertHHMMSS2Seconds, formatTime } from "../../utils/Duration";
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
    setAt: (type: string, offsetSec: number) => void;
    setAtAbs: (type: string, abs: number) => void;
    resetAt: (type: string) => void;
    goTo: (type: string) => void;
    offset: (type: string, offset: number) => void;
    setPlaying: (playing: boolean) => void;
}

export default function ClipExtractor<T extends unknown>({resume, start, stop, boundaries, videoid, played, duration, 
    setAt, setAtAbs, resetAt, goTo, offset, setPlaying } : PlayerProps<T>)
    {
    
    const [options, setOptions] = useState<Option[]>([]);

    const addOption = (offsetSec: number) => {
        setPlaying(false);
        const defaultName = "Extract #" + (options.length + 1);
        const newOption = prompt('Enter an extract name:', defaultName);
        if (newOption) {
            let selStart = formatTime(convertHHMMSS2Seconds(start), duration)
            let selStop = formatTime(convertHHMMSS2Seconds(stop), duration)
            if (offsetSec < 0) {
                selStart = formatTime(played + offsetSec, duration)
                selStop = formatTime(played, duration);
            } else if (offsetSec > 0) {
                selStart = formatTime(offsetSec, duration);
                selStop = formatTime(played + offsetSec, duration)
            }

            const formattedOption = selStart + ' - ' + selStop;
            setOptions([...options, { value: formattedOption, label: newOption }]);
            // setAtAbs('start', convertHHMMSS2Seconds(stop));
            resetAt('stop');
            setPlaying(true);
        }
    };

    const handleSelectChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
        const selectedOption = event.target.value;
        if(selectedOption){
            const [selStart, selStop] = selectedOption.split(' - ');
            setAtAbs('start', convertHHMMSS2Seconds(selStart));
            setAtAbs('stop', convertHHMMSS2Seconds(selStop));
            goTo('start');
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


    function handleDetailsClick(): void {
        throw new Error("Function not implemented.");
    }

    function handleScreenshotClick(): void {
        throw new Error("Function not implemented.");
    }

    return (
        <div>
            <div id="customPrompt" hidden>
                <div className="hd">Save As</div>
                <div className="bd">
                    <form name="promptForm" id="promptForm">
                        <label htmlFor="extractName">Extract name: </label>
                        <input type="text" name="extractName" id="extractName"/>
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
                <div className="ctrlGrp firstCtrlGrp">
                    <div className="ctrlSubgrp firstCtrlSubgrp">
                        <p>
                            <button type="button" id="mark" onClick={() => setAt('resume', 0)}> [ Mark ]</button>
                            <img src="iv/images/transparent.png" alt="" id="rewindResume" onClick={() => offset('resume', -1)} className="imgBtn rewind"/>
                            <img src="iv/images/transparent.png" alt="Go to" title="Go to" id="resume" onClick={() => goTo('resume')} className="imgBtn goTo"/>
                            <img src="iv/images/transparent.png" alt="" id="forwardResume" className="imgBtn forward" onClick={() => offset('resume', 1)}/>
                            <input type="text" value={resume ?? ''} id="resumevideoat" onClick={() => setAt('resume', 0)} onChange={() => {}} />
                            <img src="iv/images/transparent.png" alt="Restore default" id="restoreResumeAt" onClick={() => resetAt('resume')} className="imgBtn restoreStartAt"/> 
                        </p>
                    </div>
                    <div className="ctrlSubgrp secondCtrlSubgrp">
                        <button type="button" id="start" onClick={() => setAt('start', 0)} title="Set clip start">[</button>
                        <img src="iv/images/transparent.png" alt="" id="rewindStart" onClick={() => offset('start', -1)} className="imgBtn rewind"/>
                        <img src="iv/images/transparent.png" alt="Go to" title="Go to" id="goToStart" onClick={() => goTo('start')} className="imgBtn goTo"/>
                        <img src="iv/images/transparent.png" alt="" id="forwardStart" onClick={() => offset('start', 1)} className="imgBtn forward"/>
                        <input type="text" value={start ?? ''} id="startvideoat" onClick={() => setAt('start', 0)} onChange={() => {}}/>
                        <img src="iv/images/transparent.png" alt="Restore default" title="Restore default" id="restoreStartAt" onClick={() => resetAt('start')} className="imgBtn restoreStartAt"/>
                        ~
                        <img src="iv/images/transparent.png" alt="Restore default" title="Restore default" id="restoreStopAt" onClick={() => resetAt('stop')} className="imgBtn restoreStopAt"/>
                        <input type="text" value={stop ?? ''} id="stopvideoat" onClick={() => setAt('stop', 0)} onChange={() => {}}/>
                        <img src="iv/images/transparent.png" alt="" id="rewindStop" onClick={() => offset('stop', -1)} className="imgBtn rewind"/>
                        <img src="iv/images/transparent.png" alt="Go to" title="Go to" id="goToStop" onClick={() => goTo('stop')} className="imgBtn goTo"/>
                        <img src="iv/images/transparent.png" alt="" id="forwardStop" onClick={() => offset('stop', 1)} className="imgBtn forward"/>
                        <button type="button" id="stop" onClick={() => setAt('stop', 0)} title="Set clip end">]</button>
                    </div>
                </div>
                <div className="ctrlGrp secondCtrlGrp">
                    <div className="ctrlSubgrp firstCtrlSubgrp">
                        <p>
                            <input type="checkbox" checked={true} id="repeat" className="checkbox" onChange={() => {}}/>
                            <label htmlFor="repeat" id="repeat" title="Repeat (R)">&nbsp;</label>
                        </p>
                    </div>
                    <div className="ctrlSubgrp secondCtrlSubgrp">
                        <p>
                            <button type="button" id="test" onClick={() => goTo('start')}>Test</button>
                            <button type="button" id="reset">Reset</button>
                            <button type="button" id="extract" onClick={() => addOption(0)}>Extract</button>
                            <select id="extracts" multiple={true} onChange={handleSelectChange}>
                                {options.map((option, index) => (
                                    <option value={option.value}>
                                        {option.label}
                                    </option>
                                ))}
                            </select>
                            <img src="iv/images/transparent.png" alt="Remove the currently selected extract" id="removeCurrentExtract" className="imgBtn removeCurrentExtract"/>
                            <input type="hidden" value="0" id="customPromptVisible" />
                        </p>
                    </div>
                </div>
                <div className="ctrlGrp">
                <div className="ctrlSubgrp">
                    <p>
                        <button type="button" className="" id="extractm5" onClick={() => addOption(-5)}>Extr. &lt;-5</button>
                        <button type="button" className="" id="extract5"  onClick={() => addOption(5)}>Extr. 5+&gt;</button>
                    </p>
                </div>
                <div className="ctrlSubgrp">
                    <p>
                        <button type="button" id="copyBtn" onClick={handleDetailsClick} >YT Copy Details</button>
                        <button type="button" id="screenshotBtn" onClick={handleScreenshotClick}>YT Screenshot</button> 
                        <button type="button" id="copyCaptionBtn" onClick={handleCaptionCopyBtnClick}>Copy Cap</button> 
                    </p>
                </div>
            </div>  
                <div className="ctrlGrp">
                    <textarea id="log" style={{width: "100%"}}></textarea>
                </div>
                <div className="ctrlGrp">
                    <div className="ctrlSubgrp firstCtrlSubgrp debug">Date: May 24, 2023</div>
                </div>
            </fieldset>
        </div>
    )
}
