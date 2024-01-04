import React, { useEffect, useState } from 'react';
import { ArchiveInfoV1 } from '../../../../ytjs/src/utils/archive';

interface ArchiveProps<T> {
    // TODO
    v_id: string;
    info: ArchiveInfoV1 | undefined
    setInfo: React.Dispatch<React.SetStateAction<ArchiveInfoV1 | undefined>>
}

function isValidSMId(id: string, expectedLen = 11) {
    if(id.length != expectedLen) return false;
    const matching = id.match(/^[a-zA-Z0-9_\-]+$/);
    if(!matching || matching.length != 1) return false;
    return matching[0].length == expectedLen;
}

function isValidSMJSId(id: string) {
    return isValidSMId(id, 5);
}

export default function Archive<T extends unknown> ({ v_id, info, setInfo: setArchiveInfo } : ArchiveProps<T>) {
    const [isActive, setIsActive] = useState(false);
    const [archiveId, setArchiveId] = useState(v_id);
    // const [availableFormats, setAvailableFormats] = useState< ArchiveInfoV1["file_formats"] >({});
    const [selectedFormat, setSelectedFormat] = useState<keyof ArchiveInfoV1["file_formats"] | undefined>(undefined);

    function handleClick() {
       setIsActive(!isActive)
    }

    function handleArchiveBtnClick(quality?: string) {
        if(!isValidSMId(archiveId)) {
            alert("Invalid YouTube Video ID: " + archiveId);
            return;
        }

        // TODO plug in to request
        const archiveReq = new XMLHttpRequest();
        archiveReq.open('GET', "http://localhost:3000/archive/" + archiveId + "?quality=" + (quality ?? "best"));
        archiveReq.responseType = 'json';
        archiveReq.onload = function () {
            if (archiveReq.status !== 200) {
                console.log('Error: ' + archiveReq.status);
                alert("Failed to archive video!");
                return;
            }
            console.log("Metadata:" + archiveReq.response);
            //incomplete data
            //if(archiveId == v_id) setArchiveInfo(JSON.parse(archiveReq.response) as ArchiveInfoV1);
            alert("Successfully Archived!");
        }
        archiveReq.send();
    }

    return (
        <>
            <div className="accordion">
                <div className="accordion-item">
                    <div className="accordion-title" onClick={handleClick}>
                        <div>Archive</div>
                        <div>{isActive ? '-' : '+'}</div>
                    </div>
                    { isActive &&
                    <div className="accordion-content">
                        <pre>
                            {/* {info && 
                            <textarea id="archiveInfn" style={{width: "100%"}} value={JSON.stringify(info, null, 2)}/>
                            } */}
                                <fieldset>
                                    <div className="ctrlGrp firstCtrlGrp">
                                        <div className="ctrlSubgrp firstCtrlSubgrp">
                                            <div> Archived? </div>
                                            {/* <div> {info?.archived_on ? "🈯" : "🈵"} </div> */}
                                            <div> {Object.keys(info?.archived_on ?? []).length != 0 ? "Yes" : "No"} </div>
                                        </div>
                                        <div className="ctrlSubgrp secondCtrlSubgrp">
                                            {/* <input placeholder='yt vid id e.g. dQw4w9WgXcQ' type="text" id="archive_id" value={archiveId} onChange={e => setArchiveId(e.target.value)} /> */}
                                            <label>DL & Archive</label>
                                            {info && info.file_formats && Object.keys(info.file_formats).length != 0 &&
                                            // {/* TODO this violates OPTION restriction and will need a workaround  */}
                                            // <select disabled id="archive_formats" onChange={e => setSelectedFormat(e.target.value as keyof ArchiveInfoV1["file_formats"])} value={selectedFormat}>
                                            //     <option value={undefined} disabled hidden>Select Format</option>
                                            //     {/* {Object.keys(info.file_formats).map(format => <option value={format}>{format}</option>)} */}
                                            //     { Object.entries(info.file_formats).map(([itagMime, format]) => <option value={itagMime}>{format.quality ?? itagMime}</option>) }
                                                // </select>

                                                <div style={{ display: 'flex' }}>
                                                    <button 
                                                        onClick={() => {handleArchiveBtnClick()}}
                                                        style={{ marginRight: '10px' }}
                                                        >
                                                            Best
                                                            </button>
                                                    {Object.entries(info.file_formats).map(([itagMime, format]) => (
                                                        <button
                                                            key={itagMime}
                                                            onClick={() => handleArchiveBtnClick(format.quality_label)}
                                                            style={{ marginRight: '10px' }}
                                                        >
                                                            {(format.quality_label ?? "???") + " [" + format.itag + "]"}
                                                        </button>
                                                    ))}
                                                </div>
                                            }
                                        </div>
                                        <div className="ctrlSubgrp secondCtrlSubgrp">
                                        </div>
                                    </div>
                                </fieldset>
                            </pre>
                        </div>
                    }
                </div>
            </div>
        </>
    )
}