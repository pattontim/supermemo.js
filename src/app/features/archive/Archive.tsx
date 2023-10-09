import React, { useState } from 'react';
import { ArchiveInfoV1 } from '../../../../ytjs/src/utils/archive';

interface ArchiveProps<T> {
    // TODO
    v_id: string;
    info: ArchiveInfoV1 | undefined
    setInfo: React.Dispatch<React.SetStateAction<ArchiveInfoV1 | undefined>>
}

function isValidYTId(id: string) {
    return id.length == 11 && id.match(/^[a-zA-Z0-9_-]+$/);
}

export default function Archive<T extends unknown> ({ v_id, info, setInfo: setArchiveInfo } : ArchiveProps<T>) {
    const [isActive, setIsActive] = useState(false);
    const [archiveId, setArchiveId] = useState(v_id);
    
    function handleClick() {
       setIsActive(!isActive)
    }

    function archiveVideo() {
        if(!isValidYTId(archiveId)) {
            alert("Invalid YouTube Video ID!");
            return;
        }

        const archiveReq = new XMLHttpRequest();
        archiveReq.open('GET', "http://localhost:3000/archive/" + archiveId + "/");
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
                                            <div> {Object.keys(info?.file_formats ?? []).length != 0 ? "Yes" : "No"} </div>
                                        </div>
                                        <div className="ctrlSubgrp secondCtrlSubgrp">
                                            <input placeholder='yt vid id e.g. dQw4w9WgXcQ' type="text" id="archive_id" value={archiveId} onChange={e => setArchiveId(e.target.value)} />
                                            <button onClick={archiveVideo}>Archive</button>
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