

// Bridge
function sendToSuperMemo(type, payload) {
    // ...
    const msg = JSON.stringify({ type, payload });
    // WebView2 bridge
    if (window.chrome?.webview?.postMessage) {
        window.chrome.webview.postMessage(msg);
        return;
    }
    // Fallback: custom URL scheme (older WebView / WebBrowser)
    // window.location.href = 'supermemo://' + encodeURIComponent(msg);
    // ...
}

// Youtube
window.chrome.webview.postMessage({ 
                    type: 'youtubeData',
                    videoId: document.getElementById('videoid').value,
                    resume: document.getElementById('resumevideoat').value,
                    start: document.getElementById('startvideoat').value,
                    stop: document.getElementById('stopvideoat').value,
                    extracts: extractsList
                });
window.chrome.webview.postMessage({ type: 'focusInfo', isInput: isInput });
window.chrome.webview.postMessage({ type: 'command', command: 'ESCAPE' });
window.chrome.webview.postMessage({ type: 'command', command: 'FOCUS_SUPERMEMO' });

// PDF state object
// {
//     bookmark: {page: number, x: number, y: number, zoom: number}
//     extracts: [{page: number, text: string, ...}, ...]
//     annotations: { [pageNum: number]: [{xr, yr, wr, hr, type}, ...], ...}
// }
function applyLoadedState(payload) {
    if (payload.bookmark) {
    lastBookmark = payload.bookmark;
    restoreBookmark();
    }
    if (payload.extracts) {
    extracts = payload.extracts;
    extracts.forEach(addExtractToSidebar);
    }
    if (payload.annotations) {
    // Migrate old absolute-pixel format {x,y,w,h} to ratio format {xr,yr,wr,hr}
    Object.keys(payload.annotations).forEach(pageNum => {
        const pageData = renderedPages[pageNum];
        if (!pageData) return;
        const cW = pageData.annoCanvas.width;
        const cH = pageData.annoCanvas.height;
        payload.annotations[pageNum] = payload.annotations[pageNum].map(a => {
        if ('xr' in a) return a; // already new format
        return { xr: a.x / cW, yr: a.y / cH, wr: a.w / cW, hr: a.h / cH, type: a.type };
        });
    });
    annotations = payload.annotations;
    redrawAllAnnotations();
    }
}

/* PDF COMMANDS
*/
sendToSuperMemo('EXTRACT', {
    id,
    page: selectionPage,
    text,
    totalPages,
    pdfPath: PDF_PATH,
    extractIndex: extracts.length
    });
sendToSuperMemo('PICTURE_EXTRACT', {
    page,
    totalPages,
    pdfPath: PDF_PATH
 });
sendToSuperMemo('PICTURE_SNIP_EXTRACT', {
    page,
    totalPages,
    pdfPath: PDF_PATH
 });
sendToSuperMemo('NO_SELECTION', {});
// Send HTML to SuperMemo to create new element
sendToSuperMemo('HTML_CONVERT', {
    html,
    pdfPath: PDF_PATH,
    pageCount: totalPages
});
sendToSuperMemo('DONE', {
    pdfPath: PDF_PATH,
    extractCount: extracts.length,
    totalPages
});
sendToSuperMemo('REQUEST_STATE', { pdfPath: PDF_PATH });
sendToSuperMemo('SAVE_STATE', {
    state: state
});

// PDF localStorage
// ═══════════════════════════════════════════════
//  STATE PERSISTENCE (localStorage as fallback)
// ═══════════════════════════════════════════════
const STATE_KEY = 'smpdf_' + btoa(PDF_PATH).slice(0, 20);

function saveState() {
    try {
    const state = {
        bookmark: lastBookmark,
        extracts: extracts.map(e => ({ id: e.id, page: e.page, text: e.text.slice(0, 200) })),
        annotations,
        scale
    };
    localStorage.setItem(STATE_KEY, JSON.stringify(state));

    // Use WebView2 bridge to save state persistently in SuperMemo
    // pdfPath omitted to avoid 'path not supported' errors if it contains complex chars
    sendToSuperMemo('SAVE_STATE', {
        state: state
    });
    } catch (e) { }
}

/* PDF EVENTS (events sent frnm supermemo)
*/
function handleSMMessage(msg) {
    switch (msg.type) {
        case 'LOAD_STATE':
            // If pages aren't rendered yet, buffer the state for later
            if (!pdfDoc || Object.keys(renderedPages).length === 0) {
            pendingState = msg.payload;
            } else {
            applyLoadedState(msg.payload);
            }
            break;
        case 'GO_TO_PAGE':
            goToPage(msg.payload.page);
            break;
        case 'REQUEST_EXTRACT':
            if (selectionRange && !selectionRange.collapsed) {
            extractSelection();
            } else {
            sendToSuperMemo('NO_SELECTION', {});
            }
            break;
    }
}
