import React from "react";
import { useState } from "react";
import { convertHHMMSS2Seconds, formatTime } from "../../utils/Duration";

export default function ClipExtractor({resume, start, stop, boundaries, videoid, played, duration, 
    setAt, setAtAbs, resetAt, goTo, offset, setPlaying }) {
    
    const [options, setOptions] = useState([]);

    const addOption = (offsetSec) => {
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

    const handleSelectChange = (event) => {
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

        const activeCue = Array.from(activeTextTrack.cues)
            .find(cue => cue.startTime <= videoElement.currentTime && cue.endTime >= videoElement.currentTime);

        const activeCueText = activeCue.text;

        const textArea = document.createElement('textarea');
        textArea.value = activeCueText;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
    };


    return (
        <div>
            <div id="customPrompt" hidden>
                <div class="hd">Save As</div>
                <div class="bd">
                    <form name="promptForm" id="promptForm">
                        <label for="extractName">Extract name: </label>
                        <input type="text" name="extractName" id="extractName" onFocus="this.select();" />
                    </form>
                </div>
            </div>
            <div id="feedbackOuter">
                <div class="img-yellow-message-top-cap"></div>
                <div class="left-right-border-yellow">
                    <div id="feedbackInner"></div>
                </div>
                <div class="img-yellow-message-bottom-cap"></div>
            </div>
            <div class="videoWrapper">
                <div id="bideo"></div>
            </div>
            <input type="hidden" value={videoid} id="videoid" />
            <input type="hidden" value={boundaries} id="imposeboundries" />
            <fieldset>
                <div class="ctrlGrp firstCtrlGrp">
                    <div class="ctrlSubgrp firstCtrlSubgrp">
                        <p>
                            <button type="button" id="mark" onClick={() => setAt('resume', 0)}> [ Mark ]</button>
                            <img src="iv/images/transparent.png" alt="" id="rewindResume" onClick={() => offset('resume', -1)} class="imgBtn rewind"/>
                            <img src="iv/images/transparent.png" alt="Go to" title="Go to" id="resume" onClick={() => goTo('resume')} class="imgBtn goTo"/>
                            <img src="iv/images/transparent.png" alt="" id="forwardResume" class="imgBtn forward" onClick={() => offset('resume', 1)}/>
                            <input type="text" value={resume} id="resumevideoat" onClick={() => setAt('resume', 0)}/>
                            <img src="iv/images/transparent.png" alt="Restore default" id="restoreResumeAt" onClick={() => resetAt('resume')} class="imgBtn restoreStartAt"/> 
                        </p>
                    </div>
                    <div class="ctrlSubgrp secondCtrlSubgrp">
                        <button type="button" id="start" onClick={() => setAt('start', 0)} title="Set clip start">[</button>
                        <img src="iv/images/transparent.png" alt="" id="rewindStart" onClick={() => offset('start', -1)} class="imgBtn rewind"/>
                        <img src="iv/images/transparent.png" alt="Go to" title="Go to" id="goToStart" onClick={() => goTo('start')} class="imgBtn goTo"/>
                        <img src="iv/images/transparent.png" alt="" id="forwardStart" onClick={() => offset('start', 1)} class="imgBtn forward"/>
                        <input type="text" value={start} id="startvideoat" onClick={() => setAt('start', 0)}/>
                        <img src="iv/images/transparent.png" alt="Restore default" title="Restore default" id="restoreStartAt" onClick={() => resetAt('start')} class="imgBtn restoreStartAt"/>
                        ~
                        <img src="iv/images/transparent.png" alt="Restore default" title="Restore default" id="restoreStopAt" onClick={() => resetAt('stop')} class="imgBtn restoreStopAt"/>
                        <input type="text" value={stop} id="stopvideoat" onClick={() => setAt('stop', 0)}/>
                        <img src="iv/images/transparent.png" alt="" id="rewindStop" onClick={() => offset('stop', -1)} class="imgBtn rewind"/>
                        <img src="iv/images/transparent.png" alt="Go to" title="Go to" id="goToStop" onClick={() => goTo('stop')} class="imgBtn goTo"/>
                        <img src="iv/images/transparent.png" alt="" id="forwardStop" onClick={() => offset('stop', 1)} class="imgBtn forward"/>
                        <button type="button" id="stop" onClick={() => setAt('stop', 0)} title="Set clip end">]</button>
                    </div>
                </div>
                <div class="ctrlGrp secondCtrlGrp">
                    <div class="ctrlSubgrp firstCtrlSubgrp">
                        <p>
                            <input type="checkbox" checked="checked" id="repeat" class="checkbox" />
                            <label for="repeat" id="repeat" title="Repeat (R)">&nbsp;</label>
                        </p>
                    </div>
                    <div class="ctrlSubgrp secondCtrlSubgrp">
                        <p>
                            <button type="button" id="test" onClick={() => goTo('start')}>Test</button>
                            <button type="button" id="reset">Reset</button>
                            <button type="button" id="extract" onClick={addOption}>Extract</button>
                            <select id="extracts" multiple="true" value={options} onChange={handleSelectChange}>
                                {options.map((option, index) => (
                                    <option value={option.value}>
                                        {option.label}
                                    </option>
                                ))}
                            </select>
                            <img src="iv/images/transparent.png" alt="Remove the currently selected extract" id="removeCurrentExtract" class="imgBtn removeCurrentExtract"/>
                            <input type="hidden" value="0" id="customPromptVisible" />
                        </p>
                    </div>
                </div>
                <div class="ctrlGrp">
                <div class="ctrlSubgrp">
                    <p>
                        <button type="button" class="" id="extractm5" onClick={() => addOption(-5)}>Extr. &lt;-5</button>
                        <button type="button" class="" id="extract5"  onClick={() => addOption(5)}>Extr. 5+&gt;</button>
                    </p>
                </div>
                <div class="ctrlSubgrp">
                    <p>
                        <button type="button" id="copyBtn" onClick="copyVideoDetails();">YT Copy Details</button>
                        <button type="button" id="screenshotBtn" onClick="screenshotVideo();">YT Screenshot</button> 
                        <button type="button" id="copyCaptionBtn" onClick={handleCaptionCopyBtnClick}>Copy Cap</button> 
                    </p>
                </div>
            </div>  
                <div class="ctrlGrp">
                    <textarea id="log" style={{width: "100%"}}></textarea>
                </div>
                <div class="ctrlGrp">
                    <div class="ctrlSubgrp firstCtrlSubgrp debug">Date: May 24, 2023</div>
                </div>
            </fieldset>
        </div>
    )
}
