// import '../../server/scripts/container.css'
import React from 'react';
// import './extractboard.css';

import { useEffect, useRef} from 'react';

export default function ExtractBoard() {
    const boardRef = useRef(document);

    const elements = [
    {id: "mark", onclick: function() {setAt('resume', 0, true);}},
    {id: "resume", onclick: function() {goTo('resume');}},
    {id: "resumevideoat", 
        // dblclick: function() {resetAt('resume');}, 
        // onfocus: function() {this.select();}, 
        // onchange: function() {this.value = convertDuration2HHMMSS(convertHHMMSS2Duration(this.value));}, 
        onclick: function() {setAt('resume', 0, true);}, 
        // onscroll: function() {console.log('scroll');}
    },
    {id: "restoreResumeAt", onclick: function() {resetAt('resume');}},
    {id: "start", onclick: function() {setAt('start', 0, true);}},
    {id: "goToStart", onclick: function() {goTo('start');}},
    {id: "startvideoat", 
        // dblclick: function() {resetAt('start');this.select();}, 
        // onfocus: function() {this.select();}, 
        // onchange: function() {this.value = convertDuration2HHMMSS(convertHHMMSS2Duration(this.value));var that = this;imposeBoundaries(0, that);}, 
        onclick: function() {setAt('start', 0, true);this.select();}
    },
    {id: "restoreStartAt", onclick: function() {resetAt('start');}},
    {id: "restoreStopAt", onclick: function() {resetAt('stop');}},
    {id: "stopvideoat", 
        dblclick: function() {resetAt('stop');}, 
        onfocus: function() {this.select();}, 
        onchange: function() {this.value = convertDuration2HHMMSS(convertHHMMSS2Duration(this.value));var that = this;imposeBoundaries(0, that);}, 
        onclick: function() {setAt('stop', 0, true);this.select();}
    },
    {id: "goToStop", onclick: function() {goTo('stop');}},
    {id: "stop", onclick: function() {setAt('stop', 0, true);}},
    {id: "test", onclick: function() {testExtract();}},
    {id: "reset", onclick: function() {resetExtract();}},
    {id: "extract", onclick: function() {addExtract(0);}},
    {id: "extracts", 
        onchange: function(){ feedCurrentExtract(); }, 
        onclick: function(){ feedCurrentExtract(); }
    },
    {id: "removeCurrentExtract", onclick: function(){ removeCurrentExtract(); }},
    {id: "back", onclick: function(){ prevElement(); }},
    {id: "learn", onclick: function(){ beginLearning(); }},
    {id: "rep", onclick: function(){ nextRep(); }},
    {id: "fwd", onclick: function(){ nextElement(); }},
    {id: "dismiss", onclick: function(){ dismissElement(); }},
    {id: "extractm5", onclick: function(){ addExtract(-5); }},
    {id: "extract5", onclick: function(){ addExtract(5); }},
    {id: "copyBtn", onclick: function(){ copyVideoDetails(); }},
    {id: "screenshotBtn", onclick: function(){ screenshotVideo(); }},
    {id: "rewindResume", onclick: function(){ move('resume', 'rewind'); }},
    {id: "rewindStart", onclick: function(){ move('start', 'rewind'); }},
    {id: "rewindStop", onclick: function(){ move('stop', 'rewind'); }},
    {id: "forwardResume", onclick: function(){ move('resume', 'forward'); }},
    {id: "forwardStart", onclick: function(){ move('start', 'forward'); }},
    {id: "forwardStop", onclick: function(){ move('stop', 'forward'); }}
    ];

    function attachHandlers(){
        console.log("attaching handlers to ref " + boardRef.current);
        // prefix = prefix || '';
        for (var i = 0; i < elements.length; i++) {
            var element = elements[i];
            // var el = boardRef.current.getElementById(prefix + element.id);
            var el = boardRef.current.querySelector('#' + element.id);
            if (el) {
                for (var key in element) {
                    if (key !== 'id') {
                        el[key] = element[key];
                    }
                }
            }
        }
    }

    useEffect(() => {
        attachHandlers();
    }, []);

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
                            <input type="text" value="0:00:00" id="resumevideoat"/>
                            <img src="iv/images/transparent.png" alt="Restore default" id="restoreResumeAt" class="imgBtn restoreStartAt"/> 
                        </p>
                    </div>
                    <div class="ctrlSubgrp secondCtrlSubgrp">
                        <button type="button" id="start" title="Set clip start">[</button>
                        <img src="iv/images/transparent.png" alt="" id="rewindStart" class="imgBtn rewind"/>
                        <img src="iv/images/transparent.png" alt="Go to" title="Go to" id="goToStart" class="imgBtn goTo"/>
                        <img src="iv/images/transparent.png" alt="" id="forwardStart" class="imgBtn forward"/>
                        <input type="text" value="0:00:00" id="startvideoat"/>
                        <img src="iv/images/transparent.png" alt="Restore default" title="Restore default" id="restoreStartAt" class="imgBtn restoreStartAt"/>
                        ~
                        <img src="iv/images/transparent.png" alt="Restore default" title="Restore default" id="restoreStopAt" class="imgBtn restoreStopAt"/>
                        <input type="text" value="0:00:00" id="stopvideoat"/>
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
                    <div class="ctrlSubgrp thirdCtrlSubgrp">
                        <p>
                            <button type="button" class="wsenable" id="back" disabled>&lt;--</button>
                            <button type="button" class="wsenable" id="learn" disabled>Learn</button>
                            <button type="button" class="wsenable" id="rep" disabled>Rep</button>
                            <button type="button" class="wsenable" id="fwd" disabled>--&gt;</button>
                        </p>
                    </div>
                </div>
                <div class="ctrlGrp">
                    <div class="ctrlSubgrp">
                        <p>
                            <button type="button" class="wsenable" id="dismiss" disabled>Dismiss</button>
                        </p>
                    </div>
                    <div class="ctrlSubgrp">
                        <p>
                            <button type="button" class="" id="extractm5">Extr. &lt;-5</button>
                            <button type="button" class="" id="extract5">Extr. 5+&gt;</button>
                        </p>
                    </div>
                    <div class="ctrlSubgrp">
                        <p>
                            <button type="button" id="copyBtn" onclick="copyVideoDetails();">YT Copy Details</button>
                            <button type="button" id="screenshotBtn" onclick="screenshotVideo();">YT Screenshot</button> 
                        </p>
                    </div>
                </div>  

                <div class="ctrlGrp">
                    <textarea id="log" style={{width: "100%"}}></textarea>
                </div>
                <div class="ctrlGrp">
                    <div class="ctrlSubgrp firstCtrlSubgrp debug">Date: Nov 29, 2017</div>
                </div>
                <input type="hidden" value="0" id="customPromptVisible" />
            </fieldset>
            <div id="speedSlider" style={{"z-index":2}}>
                <form>
                    <div>
                    <input 
  type="range" 
  min="-10"
  max="10"
  value="0"
  id="fader"
  step="1"
  onchange="outputUpdate(value)"
/>
<span for="fader" id="speed">1</span>

                    </div>
                </form>
            </div>
        </div>
    )
}