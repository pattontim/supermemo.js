import React from "react";
import { useState } from "react";

interface Option {
  label: string;
  value: string;
}

/** 
 * Props which will be linked to the extractboard. 
 * [resume + start + stop + video].length must be less than 62
 */
interface ExtractorProps<T> {
    /** An encoded timestamp vector string, usu. the resume time for the set mark.
     *  vector "x:y:z" where x is [0-10], y is [0-59] and z is [0-59]. */
    resume?: string | null;
    /** An encoded timestamp vector string, usu. the start time of the clip.
     *  vector "x:y:z" where x is [0-10], y is [0-59] and z is [0-59]. */
    start?: string | null;
    /** An encoded timestamp vector string, usu. the stop time of the clip.
     *  vector "x:y:z" where x is [0-10], y is [0-59] and z is [0-59]. */
    stop?: string | null;
    /** A number only supporting boolean values, usu. whether or not to limit the clip to the time. */
    boundaries?: number;
    /** A supermemo ID string. Values up to 31 chars are allowed. usu. the YouTube ID */
    videoid?: string | null;
    /** A number only supporting boolean values, usu. whether or not the clip should repeat. */
    repeat?: boolean;
    /** A string only supporting boolean values, usu. to indicate to SM the custom prompt is visible and
     * block inputs. Not saved by SM but MUST be present for Learn button to work. */
    customPromptVisible?: string;
    /* Option list which will create clip extracts in SuperMemo. 
     * Option value must be in form "HHMMSS - HHMMSS" which are start and stop points of the extractee
     * Option labels become the title of the extract. */
    options?: Option[];
}

const getQueryParam = (paramName: string) => {
  return new URLSearchParams(window.location.search).get(paramName);
};

/** 
 * An empty extract board. Changes to the extract board will be saved if supermemo can see it.
 */
export default function HiddenExtractor<T extends unknown>({ 
    resume: firstVector = getQueryParam('resume'),
    start: secondVector = getQueryParam('start'),
    stop: thirdVector = getQueryParam('stop'),
    boundaries = 1,
    videoid: smjsID = getQueryParam('videoid')?.trim() ?? null,
    repeat = true,
    customPromptVisible = "0",
    options = []
}: ExtractorProps<T>) {

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
            <fieldset hidden>
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
