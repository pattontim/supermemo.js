import React from "react";
import { useState } from "react";
import { convertHHMMSS2Seconds, formatTime } from "../../utils/Duration";
// import { PlayerProps } from "../../utils/types";

interface Option {
  label: string;
  value: string;
}

interface ExtractorProps<T> {
    resume: string | null;
    start: string | null;
    stop: string | null;
    boundaries: number;
    smjsID: string | null;
    repeat: boolean;
}

export default function ImageClozeExtractor<T extends unknown>({ resume, start, stop, boundaries, smjsID, repeat }: ExtractorProps<T>)
    {
    
    const [options, setOptions] = useState<Option[]>([]);
    const [emulatedCustomPromptVisible, setEmulatedCustomPromptVisible] = useState("0");

    // const addOption = (offsetSec: number) => {
    //     const defaultName = "Extract #" + (options.length + 1);
    //     const newOption = prompt('Enter an extract name:', defaultName);
    //     if (newOption) {
    //         const formattedOption = selStart + ' - ' + selStop;
    //         setOptions([...options, { value: formattedOption, label: newOption }]);
    //         // setAtAbs('start', convertHHMMSS2Seconds(stop));
    //     }
    // };

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
            <input type="hidden" value={smjsID ?? ''} id="videoid" />
            <input type="hidden" value={boundaries} id="imposeboundries" />
            <fieldset> 
                    <input type="text" id="resumevideoat" value={resume ?? ''}/> 
                    <input type="text" id="startvideoat" value={start ?? ''}/>
                    <input type="text" id="stopvideoat" value={stop ?? ''}/>
                    <input type="checkbox" checked={repeat} id="repeat"/>
                    <select id="extracts" multiple></select>   
                    <input type="hidden" value={emulatedCustomPromptVisible} id="customPromptVisible" />              
            </fieldset>

        </div>
    )
}
