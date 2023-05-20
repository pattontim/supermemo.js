import React from "react";

export default function ClipExtractor({resume, start, stop, setStart}) {
    return (
        <div>
            <div id="customPrompt">
                <div class="hd">Save As</div>
                <div class="bd">
                    <form name="promptForm" id="promptForm">
                        <label for="extractName">Extract name: </label>
                        <input type="text" name="extractName" id="extractName" onfocus="this.select();" onblur="oCustomPrompt.focusFirstButton();" />
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
            <input type="hidden" value="zzzYT-IDzzz" id="videoid" />
            <input type="hidden" value="1" id="imposeboundries" />
            <fieldset>      
                <div class="ctrlGrp firstCtrlGrp">
                    <div class="ctrlSubgrp firstCtrlSubgrp">
                        <p>
                            <button type="button" id="mark" > [ Mark ]</button>
                            <img src="iv/images/transparent.png" alt="" id="rewindResume" class="imgBtn rewind"/>
                            <img src="iv/images/transparent.png" alt="Go to" title="Go to" id="resume" class="imgBtn goTo"/>
                            <img src="iv/images/transparent.png" alt="" id="forwardResume" class="imgBtn forward"/>
                            <input type="text" value={resume} id="resumevideoat"/>
                            <img src="iv/images/transparent.png" alt="Restore default" id="restoreResumeAt" class="imgBtn restoreStartAt"/> 
                        </p>
                    </div>
                    <div class="ctrlSubgrp secondCtrlSubgrp">
                        <button type="button" id="start" title="Set clip start" onClick={setStart}>[</button>
                        <img src="iv/images/transparent.png" alt="" id="rewindStart" class="imgBtn rewind"/>
                        <img src="iv/images/transparent.png" alt="Go to" title="Go to" id="goToStart" class="imgBtn goTo"/>
                        <img src="iv/images/transparent.png" alt="" id="forwardStart" class="imgBtn forward"/>
                        <input type="text" value={start} id="startvideoat"/>
                        <img src="iv/images/transparent.png" alt="Restore default" title="Restore default" id="restoreStartAt" class="imgBtn restoreStartAt"/>
                        ~
                        <img src="iv/images/transparent.png" alt="Restore default" title="Restore default" id="restoreStopAt" class="imgBtn restoreStopAt"/>
                        <input type="text" value={stop} id="stopvideoat"/>
                        <img src="iv/images/transparent.png" alt="" id="rewindStop" class="imgBtn rewind"/>
                        <img src="iv/images/transparent.png" alt="Go to" title="Go to" id="goToStop" class="imgBtn goTo"/>
                        <img src="iv/images/transparent.png" alt="" id="forwardStop" class="imgBtn forward"/>
                        <button type="button" id="stop" title="Set clip end">]</button>
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
                            <button type="button" id="test">Test</button>
                            <button type="button" id="reset">Reset</button>
                            <button type="button" id="extract">Extract</button>
                            <select id="extracts"></select>
                            <img src="iv/images/transparent.png" alt="Remove the currently selected extract" id="removeCurrentExtract" class="imgBtn removeCurrentExtract"/>
                        </p>
                    </div>
                </div>
            </fieldset>
        </div>
    )
}
