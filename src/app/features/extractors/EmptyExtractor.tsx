import React from "react";
import { useState } from "react";

interface Option {
  label: string;
  value: string;
}

interface ExtractorProps<T> {
    resume?: string | null;
    start?: string | null;
    stop?: string | null;
    boundaries?: number;
    videoid?: string | null;
    repeat?: boolean;
    customPromptVisible?: string;
}

const getQueryParam = (paramName: string) => {
  return new URLSearchParams(window.location.search).get(paramName);
};

export default function EmptyExtractor<T extends unknown>({ 
    resume: firstVector = getQueryParam('resume'),
    start: secondVector = getQueryParam('start'),
    stop: thirdVector = getQueryParam('stop'),
    boundaries = 1,
    videoid: smjsID = getQueryParam('videoid')?.trim() ?? null,
    repeat = true,
    customPromptVisible = "0"
}: ExtractorProps<T>) {
    
    const [options, setOptions] = useState<Option[]>([]);

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
                    <input type="text" id="resumevideoat" value={firstVector ?? ''}/> 
                    <input type="text" id="startvideoat" value={secondVector ?? ''}/>
                    <input type="text" id="stopvideoat" value={thirdVector ?? ''}/>
                    <input type="checkbox" checked={repeat} id="repeat"/>
                    <select id="extracts" multiple></select>   
                    <input type="hidden" value={customPromptVisible} id="customPromptVisible" />   
                    <select id="extracts">
                            {options.map((option, index) => (
                                <option value={option.value}>
                                    {option.label}
                                </option>
                            ))}
                    </select>           
            </fieldset>
        </div>
    )
}
