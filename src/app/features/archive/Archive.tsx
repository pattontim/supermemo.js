import React, { useEffect, useState } from 'react';
import { ArchiveInfo } from '../../../../ytjs/src/utils/archive';
import { ytjsHost } from '../../utils/client';

interface ArchiveProps<T> {
    // TODO
    v_id: string;
    info: ArchiveInfo | undefined
    setInfo: React.Dispatch<React.SetStateAction<ArchiveInfo | undefined>>
}

function isValidSMId(id: string, expectedLen = 11) {
    if(id.trim().length != expectedLen) return false;
    const matching = id.trim().match(/^[a-zA-Z0-9_\-]+$/);
    if(!matching || matching.length != 1) return false;
    return matching[0].length == expectedLen;
}

function isValidSMJSId(id: string) {
    return isValidSMId(id, 5);
}

export default function Archive<T extends unknown> ({ v_id, info, setInfo: setArchiveInfo } : ArchiveProps<T>) {
    const [isActive, setIsActive] = useState(false);
    const [archiveId, setArchiveId] = useState(v_id);
    // const [availableFormats, setAvailableFormats] = useState< ArchiveInfo["file_formats"] >({});
    const [selectedFormat, setSelectedFormat] = useState<keyof ArchiveInfo["file_formats"] | undefined>(undefined);

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

        
        const archiveUrl = new URL("http://" + ytjsHost + "/archive/" + archiveId);
        archiveUrl.searchParams.append("quality", quality ?? "best");
        archiveUrl.searchParams.append("video", "true");
        archiveUrl.searchParams.append("captions", "true");
        archiveReq.open('GET', archiveUrl.toString());
        // archiveReq.open('GET', "http://" + ytjsHost + "/archive/" + archiveId + "?quality=" + (quality ?? "best"));
        archiveReq.responseType = 'json';
        archiveReq.onload = function () {
            if (archiveReq.status !== 200) {
                console.log('Error: ' + archiveReq.status);
                alert("Failed to archive video!");
                return;
            }
            console.log("Metadata:" + archiveReq.response);
            //incomplete data
            //if(archiveId == v_id) setArchiveInfo(JSON.parse(archiveReq.response) as ArchiveInfo);
            alert("Successfully Archived!");
        }
        archiveReq.send();
    }

    function getQualityLabel(archiveInfo?: ArchiveInfo) {
        return Object.values(archiveInfo?.file_formats ?? []).at(0)?.quality_label ?? "???";
    }
    
    return (
        <>
            <div className="accordion">
                <div className="accordion-item">
                    <div className="accordion-title" onClick={handleClick}>
                        <div style={{ backgroundColor: (Object.keys(info?.archived_on ?? []).length === 0 ? "red" : "green") }}>Archived? [{isActive ? '−' : '+'}]</div>
                    </div>
                    { isActive &&
                        <div className="accordion-content">
                            {/* {info && 
                            <textarea id="archiveInfn" style={{width: "100%"}} value={JSON.stringify(info, null, 2)}/>
                            } */}
                            <div className="ctrlGrp firstCtrlGrp">
                                <div className="ctrlSubgrp firstCtrlSubgrp">
                                    {/* <div> {info?.archived_on ? "🈯" : "🈵"} </div> */}
                                    {Object.keys(info?.archived_on ?? []).length !== 0 ?
                                        <div style={{ backgroundColor: 'green', color: 'black', padding: '10px', borderRadius: '5px', boxShadow: '0 0 10px rgba(0, 0, 0, 0.3)' }}>
                                            <span style={{ textShadow: '0 0 5px white' }}>Yes [{getQualityLabel(info)}] [{new Date(info?.archived_on ?? "").toLocaleDateString()}]</span>
                                        </div>
                                        :
                                        <div style={{ backgroundColor: 'red', color: 'white', fontWeight: 'bold', padding: '10px', borderRadius: '5px', boxShadow: '0 0 10px rgba(0, 0, 0, 0.3)' }}>
                                            No
                                        </div>
                                    }
                                </div>
                                {Object.keys(info?.archived_on ?? []).length === 0 &&
                                    <div className="ctrlSubgrp secondCtrlSubgrp">
                                        {/* <input placeholder='yt vid id e.g. dQw4w9WgXcQ' type="text" id="archive_id" value={archiveId} onChange={e => setArchiveId(e.target.value)} /> */}
                                        <label>DL & Archive</label>
                                        {info && info.file_formats && Object.keys(info.file_formats).length != 0 &&
                                            // {/* TODO this violates OPTION restriction and will need a workaround  */}
                                            // <select disabled id="archive_formats" onChange={e => setSelectedFormat(e.target.value as keyof ArchiveInfo["file_formats"])} value={selectedFormat}>
                                            //     <option value={undefined} disabled hidden>Select Format</option>
                                            //     {/* {Object.keys(info.file_formats).map(format => <option value={format}>{format}</option>)} */}
                                            //     { Object.entries(info.file_formats).map(([itagMime, format]) => <option value={itagMime}>{format.quality ?? itagMime}</option>) }
                                            // </select>


                                            <div style={{ display: 'flex' }}>
                                                <button
                                                    onClick={() => { handleArchiveBtnClick() }}
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
                                }
                                <div className="ctrlSubgrp secondCtrlSubgrp">
                                </div>
                            </div>
                        </div>
                    }
                </div>
            </div>
        </>
    )
}