import React, { useState, useRef, useEffect, useImperativeHandle, forwardRef } from "react";
import { convertHHMMSS2Seconds, formatTime } from "../../utils/Duration";
import { Option } from "../../utils/supermemo";
import { StorageKey, notifyStorageKey } from "../../utils/storage";
import { ArchiveInfo } from "../../../../ytjs/src/utils/archive";
import { stripPublishedLabel } from "../../utils/published";

/**
 * SMControls
 * ----------
 * A custom, Hitchhiker-inspired control overlay for the SuperMemo player.
 *
 * This component does NOT extend or fork react-player. react-player remains the
 * playback engine (it renders the <video> element and drives mp4/dash.js), while
 * SMControls is a purely presentational sibling rendered on top of it inside the
 * same position:relative wrapper. All playback intent is delegated back to
 * SMPlayer through props which update the ReactPlayer props it already receives.
 *
 * IE11 constraints (this build targets ['web','es5']):
 *  - No CSS custom properties (all colors are constants below).
 *  - No CSS grid / `gap` / `aspect-ratio` / `:focus-within`.
 *  - Layout uses display:table / table-cell / inline-block only (no flexbox,
 *    since React does not emit -ms- vendor prefixes for inline styles).
 *  - No Array.prototype.at / optional chaining at runtime (babel handles syntax,
 *    but we avoid host-object methods missing on IE11).
 */

// Hitchhiker reconstruction tokens. These are replaceable defaults, not verified
// historical values (see the reconstruction notes); keep them in one place.
//
// Two palettes now: the Hitchhiker default, and a PipePipe-derived dark one used
// when the player is showing a Niconico Douga video (see isNndId below). Only
// the values differ — every layout in this file is palette-agnostic.
var HK_STRIP_BG = "#555";
var HK_STRIP_BUFFER = "#888";
var HK_STRIP_PLAYED = "#cc181e";
var HK_EXTRACT_TICK = "#f80";
var HK_SELECTION = "#167ac6";
var HK_BAR_BG = "rgba(20,20,20,0.65)";
var HK_FG = "#eeeeee";
var HK_HOVER_TICK = "#ffffff";

// PipePipe dark palette (PipePipeClient/app/src/main/res/values/colors.xml:
// dark_background_color #222222, dark_card_item_background_color #313131,
// dark_settings_accent_color #ff5252, dark_border_color #33FFFFFF). Secondaries
// keep the strip from reading as plain grey: orange extract ticks (#FF9900),
// blue clip selection (#008FD6).
var NND_STRIP_BG = "#313131";
var NND_STRIP_BUFFER = "#555555";
var NND_STRIP_PLAYED = "#ff5252";
var NND_EXTRACT_TICK = "#ff9900";
var NND_SELECTION = "#008fd6";
var NND_BAR_BG = "rgba(34,34,34,0.85)";
var NND_FG = "#ffffff";
var NND_HOVER_TICK = "#ffffff";

var ON_COLOR = "#4CAF50";
var OFF_COLOR = "#f44336";

/** Niconico Douga ids: sm|nm|so|ca + digits, or a legacy bare numeric id.
 * Duplicated from SMPlayer.isNndSMId / ytjs isNndId so this component stays
 * self-contained (it only receives v_id). */
function isNndId(id: string | undefined | null): boolean {
    if (!id) return false;
    var s = id.replace(/^\s+|\s+$/g, "");
    return /^(sm|nm|so|ca)\d+$/i.test(s) || /^\d+$/.test(s);
}

/** Player-behaviour settings surfaced as on/off toggles in the Settings menu.
 * Keys map 1:1 to StorageKey enum values (the same localStorage contract the
 * old Settings accordion used, so live useLocalStorage hooks stay in sync).
 * Rows are grouped exactly as the old accordion grouped them; as before, the
 * "play" and "pause" rows of a hover group share one underlying key. */
var SETTINGS_PLAYER: { group: string; rows: { key: string; label: string }[] }[] = [
    {
        group: "Short Clips",
        rows: [
            { key: StorageKey.AUTO_HOVER, label: "Play/pause on hover" },
            { key: StorageKey.AUTO_PLAY_SHORTS_ALWAYS, label: "Always autoplay shorts on start" }
        ]
    },
    {
        group: "Long Clips",
        rows: [
            { key: StorageKey.AUTO_HOVER_LONG_CLIPS, label: "Apply hover to long clips" }
        ]
    },
    {
        group: "Outside Clip Bounds",
        rows: [
            { key: StorageKey.AUTO_HOVER_OUTSIDE_CLIP_BOUNDS, label: "Play/pause outside clip bounds" },
            { key: StorageKey.FAKE_FULLSCREEN_SHORTS, label: "Start shorts in fullscreen" }
        ]
    },
    {
        group: "Controls",
        rows: [
            { key: StorageKey.ARROW_FRAME_MODE, label: "Arrow keys move back/forth frames" },
            { key: StorageKey.CLICK_ZOOM, label: "Click to zoom" },
            { key: StorageKey.FOLLOW_ZOOM, label: "Follow-mouse zoom" }
        ]
    }
];

/** Archive/download settings (also surfaced in a settings submenu). */
var SETTINGS_ARCHIVE: { key: string; label: string }[] = [
    { key: StorageKey.CLEANUP_CAPTIONS_ON_ARCHIVE, label: "Cleanup captions on archive" }
];

/** Niconico-only settings. Rendered only when the current id is an NND id. */
var SETTINGS_NND: { key: string; label: string }[] = [
    { key: StorageKey.NND_COMMENTS, label: "Bullet comments" }
];

/**
 * Best-guess quality label of an archive, taken from the first available
 * download format (same approximation the old Archive accordion used). Written
 * without Array.prototype.at for IE11 safety.
 */
function getQualityLabel(info?: { file_formats?: Record<string, { quality_label?: string }> }): string {
    var formats = (info && info.file_formats) ? info.file_formats : {};
    var keys = Object.keys(formats);
    if (keys.length === 0) return "???";
    var first = formats[keys[0]];
    return (first && first.quality_label) ? first.quality_label : "???";
}

/** Imperative handle exposed to the parent so it can drive show/hide from the
 * player-wide mouse handlers (instant hide on leaving the player, re-arm the
 * idle timer on movement anywhere over the player). */
export interface SMControlsHandle {
    /** Re-arm the 2s idle-hide timer (called on any pointer activity). */
    notifyActivity: () => void;
    /** Hide the bar immediately (called when the pointer leaves the player). */
    hideNow: () => void;
}

interface SMControlsProps {
    playing: boolean;
    setPlaying: (b: boolean) => void;
    played: number;
    duration: number;
    loaded: number; // fraction 0..1
    volume: number;
    setVolume: (v: number) => void;
    muted: boolean;
    setMuted: (b: boolean) => void;
    playbackRate: number;
    setPlaybackRate: (r: number) => void;
    seekToSec: (sec: number) => void;
    setSeeking: (b: boolean) => void;
    resume: string | null;
    start: string | null;
    stop: string | null;
    options: Option[];
    onSelectExtract: (opt: Option) => void;
    onMoveExtractBound: (index: number, which: "start" | "stop", sec: number) => void;
    onMoveClipBound: (which: "start" | "stop", sec: number) => void;
    onRemoveExtract: (opt: Option) => void;
    onExtractClick: () => void;
    onExtractHold: (fromSec: number, toSec: number) => void;
    extractOffsetSec: number;
    settingsOpen: boolean;
    setSettingsOpen: (b: boolean) => void;
    onFullscreen: () => void;
    qualities: string[];
    /** Height (string) of the rung dash.js is currently rendering, for the mark. */
    activeQuality: string | null;
    setResolution: (h: string) => void;
    tracks: { label: string; srclang: string }[];
    activeTrack: string | null;
    onSelectTrack: (srclang: string | null) => void;
    onRequestTracks: () => void;
    // page actions (lifted from ClipTool / Archive)
    v_id: string;
    info?: ArchiveInfo;
    onScreenshot: () => void;
    onCopyCue: (ctx?: number) => void;
    onTranslateCue: (ctx?: number) => void;
    onSummarize: () => void;
    onOpenYT: () => void;
    onArchive: (quality?: string, overwrite?: boolean, captions?: boolean, video?: boolean) => void;
    /** Deletes the current archive (caller confirms with the user first). */
    onDeleteArchive: () => void;
    /** Key of the archive action currently in flight ("best" | "captions" | a
     *  quality_label), used to render a spinner next to exactly that button. */
    archivingId?: string | null;
    onToggleArchivePane: () => void;
}

var IDLE_MS = 2000;
var HOLD_MIN_SECONDS = 0.4;

var SMControls = forwardRef<SMControlsHandle, SMControlsProps>(function SMControls(p, ref) {
    // Palette selection: NND ids get the PipePipe dark tokens, everything else
    // keeps the Hitchhiker light-on-dark reconstruction. These locals shadow the
    // module-level HK_*/NND_* names so every style below stays unchanged.
    var nnd = isNndId(p.v_id);
    var STRIP_BG = nnd ? NND_STRIP_BG : HK_STRIP_BG;
    var STRIP_BUFFER = nnd ? NND_STRIP_BUFFER : HK_STRIP_BUFFER;
    var STRIP_PLAYED = nnd ? NND_STRIP_PLAYED : HK_STRIP_PLAYED;
    var EXTRACT_TICK = nnd ? NND_EXTRACT_TICK : HK_EXTRACT_TICK;
    var SELECTION = nnd ? NND_SELECTION : HK_SELECTION;
    var BAR_BG = nnd ? NND_BAR_BG : HK_BAR_BG;
    var FG = nnd ? NND_FG : HK_FG;
    var HOVER_TICK = nnd ? NND_HOVER_TICK : HK_HOVER_TICK;

    var [visible, setVisible] = useState(true);
    var [hoverSec, setHoverSec] = useState<number | null>(null);
    var [scrubbing, setScrubbing] = useState(false);
    var [volumeOpen, setVolumeOpen] = useState(false);
    var [menu, setMenu] = useState<string>("main"); // main | speed | quality | lang | pending | actions | captions | archiveActions | archive | setPlayer | setArchive | flags
    // Bumped after a raw localStorage write so the open settings/flags menu
    // repaints with the new ON/OFF state (localStorage isn't reactive).
    var [tickN, setTickN] = useState(0);

    // Refs mirroring props/state so the global mouse listeners (registered once)
    // always read current values without re-registering.
    var propsRef = useRef(p);
    propsRef.current = p;
    var scrubbingRef = useRef(false);
    var idleTimer = useRef<any>(null);
    var holdStart = useRef<number | null>(null);
    var held = useRef(false);
    var pointerDown = useRef(false);
    var drag = useRef<{ index: number; which: "start" | "stop"; moved: boolean } | null>(null);
    var clipDrag = useRef<{ which: "start" | "stop"; moved: boolean } | null>(null);
    var lastSnap = useRef<number | null>(null);
    var [markersVisible, setMarkersVisible] = useState(false);
    // Whether the current scrub gesture started on the blue clip band, and
    // whether it moved (so a no-move press = click-in-place to reveal markers).
    var bandPress = useRef(false);
    var scrubMoved = useRef(false);
    var stripRef = useRef<HTMLDivElement>(null);
    var volRef = useRef<HTMLDivElement>(null);
    var volWrapRef = useRef<HTMLSpanElement>(null);
    var volDragging = useRef(false);

    function armIdle() {
        if (idleTimer.current) clearTimeout(idleTimer.current);
        idleTimer.current = setTimeout(function () {
            if (!propsRef.current.settingsOpen && !held.current && !pointerDown.current) setVisible(false);
        }, IDLE_MS);
    }

    useImperativeHandle(ref, function () {
        return {
            notifyActivity: function () {
                setVisible(true);
                armIdle();
            },
            hideNow: function () {
                if (idleTimer.current) clearTimeout(idleTimer.current);
                // Don't hide mid-interaction: keep visible while the settings menu
                // is open, a mouse button is held, or an extract hold is in progress
                // (so the release event still lands on the button).
                if (!propsRef.current.settingsOpen && !held.current && !pointerDown.current) setVisible(false);
            }
        };
    });

    // Keep the bar visible while the settings menu is open + arm timer on mount.
    useEffect(function () {
        armIdle();
        return function () {
            if (idleTimer.current) clearTimeout(idleTimer.current);
        };
    }, []);

    useEffect(function () {
        if (p.settingsOpen) {
            if (idleTimer.current) clearTimeout(idleTimer.current);
            setVisible(true);
        } else {
            armIdle();
        }
    }, [p.settingsOpen]);

    // Global move/up so scrubbing, tick-dragging, and hold-to-extract work even
    // when the pointer leaves the thin strip or the extract button. DOM mouse
    // events only fire on the element under the cursor, so a drag driven purely
    // by the 6px strip's handlers stalls on fast moves; capturing at the document
    // level for the duration of the gesture fixes that.
    useEffect(function () {
        function onMove(e: any) {
            if (!scrubbingRef.current && !drag.current && !clipDrag.current && !volDragging.current) return;
            if (volDragging.current) {
                applyVol(e);
                return;
            }
            if (clipDrag.current) {
                var snappedC = Math.round(secFromClientX(e.clientX));
                setHoverSec(snappedC);
                clipDrag.current.moved = true;
                // Only commit on whole-second changes so a fast drag doesn't spam
                // setStart/setStop + sendClipData on every pixel.
                if (snappedC !== lastSnap.current) {
                    lastSnap.current = snappedC;
                    propsRef.current.onMoveClipBound(clipDrag.current.which, snappedC);
                }
                return;
            }
            if (drag.current) {
                var snapped = Math.round(secFromClientX(e.clientX));
                setHoverSec(snapped);
                drag.current.moved = true;
                // Only commit on whole-second changes so a fast drag doesn't spam
                // setOptions + sendClipData on every pixel.
                if (snapped !== lastSnap.current) {
                    lastSnap.current = snapped;
                    propsRef.current.onMoveExtractBound(drag.current.index, drag.current.which, snapped);
                }
                return;
            }
            if (scrubbingRef.current) {
                scrubMoved.current = true; // any move = a scrub, not a click-in-place
                var s = secFromClientX(e.clientX);
                setHoverSec(s);
                propsRef.current.seekToSec(s);
            }
        }
        function onUp(e: any) {
            pointerDown.current = false;
            if (volDragging.current) {
                volDragging.current = false;
                // If the drag ended outside the volume widget, close the pane
                // (otherwise a mouseleave during drag would leave it stuck open).
                var wrap = volWrapRef.current;
                if (wrap) {
                    var wr = wrap.getBoundingClientRect();
                    var outside = e.clientX < wr.left || e.clientX > wr.right || e.clientY < wr.top || e.clientY > wr.bottom;
                    if (outside) setVolumeOpen(false);
                }
            }
            if (drag.current) {
                var d = drag.current;
                // Look the option up by index at release time so we always act on
                // the current object (each commit replaces it with a new one).
                var opt = propsRef.current.options[d.index];
                var strip = stripRef.current;
                var offStrip = false;
                if (strip) {
                    var r = strip.getBoundingClientRect();
                    // >50px vertical drag off the strip = remove pending extract.
                    offStrip = Math.abs(e.clientY - (r.top + r.height / 2)) > 50;
                }
                if (opt) {
                    if (offStrip) {
                        propsRef.current.onRemoveExtract(opt);
                    } else if (!d.moved) {
                        // A click (no drag) on an extract plays it from its start.
                        propsRef.current.onSelectExtract(opt);
                    }
                }
                drag.current = null;
                lastSnap.current = null;
            }
            if (clipDrag.current) {
                // Hide the blue markers only after an actual drag (per the spec:
                // dragging and releasing inside the extract hides them). A bare
                // mousedown-mouseup on a marker is a click, so keep them visible,
                // mirroring the !d.moved click-vs-drag convention used above.
                if (clipDrag.current.moved) setMarkersVisible(false);
                clipDrag.current = null;
                lastSnap.current = null;
            }
            if (scrubbingRef.current) {
                scrubbingRef.current = false;
                setScrubbing(false);
                propsRef.current.setSeeking(false);
                // A press that began on the blue band and never moved is a
                // click-in-place: reveal the draggable markers. A press on the
                // bare strip (or one that dragged) just scrubs as usual.
                if (bandPress.current && !scrubMoved.current) setMarkersVisible(true);
                bandPress.current = false;
                scrubMoved.current = false;
            }
            if (held.current) finishExtract();
        }
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        return function () {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        };
    }, []);

    /**
     * Completes a hold-to-extract: pauses on release, then creates either a
     * range extract (long hold) or a fixed-offset extract (short click).
     */
    function finishExtract() {
        held.current = false;
        if (holdStart.current == null) return;
        var from = holdStart.current;
        holdStart.current = null;
        propsRef.current.setPlaying(false);
        if (propsRef.current.played - from > HOLD_MIN_SECONDS) {
            propsRef.current.onExtractHold(from, propsRef.current.played);
        } else {
            propsRef.current.onExtractClick();
        }
    }

    function secFromClientX(clientX: number): number {
        var strip = stripRef.current;
        if (!strip || !propsRef.current.duration) return 0;
        var r = strip.getBoundingClientRect();
        var x = clientX - r.left;
        var frac = Math.max(0, Math.min(1, r.width ? x / r.width : 0));
        return frac * propsRef.current.duration;
    }

    function beginScrub(e: any) {
        e.preventDefault();
        scrubbingRef.current = true;
        setScrubbing(true);
        propsRef.current.setSeeking(true);
        propsRef.current.seekToSec(secFromClientX(e.clientX));
        armIdle();
    }

    /**
     * Computes a 0..1 volume from a pointer position over the vertical track.
     * Top of the track = 1 (full), bottom = 0 (muted).
     */
    function volFromEvent(e: any): number {
        var el = volRef.current;
        if (!el) return 0;
        var r = el.getBoundingClientRect();
        var clientY = e.clientY != null ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
        var y = clientY - r.top;
        return Math.max(0, Math.min(1, r.height ? 1 - y / r.height : 0));
    }

    function applyVol(e: any) {
        var v = volFromEvent(e);
        propsRef.current.setVolume(v);
        propsRef.current.setMuted(v === 0);
    }

    function optBounds(opt: Option): number[] {
        var parts = opt.value.split(" - ");
        return [convertHHMMSS2Seconds(parts[0]), convertHHMMSS2Seconds(parts[1])];
    }

    function pct(sec: number): string {
        return (p.duration ? (sec / p.duration) * 100 : 0) + "%";
    }

    /**
     * Converts a pixel width into a %-of-duration string, for sizing the tap
     * zones around extract ticks independent of the strip width.
     */
    function tapWidth(px: number): string {
        var w = stripRef.current ? stripRef.current.getBoundingClientRect().width : 0;
        return w > 0 ? (px / w) * 100 + "%" : px + "px";
    }

    /** Priority caption languages (JP EN DE FR ES EO KR) shown first, per the
     * previous language-selection behavior; the rest fall to the end. */
    var PRIORITY_LANGS = ["ja", "en", "de", "fr", "es", "eo", "ko"];

    function sortedTracks(): { label: string; srclang: string }[] {
        return p.tracks.slice().sort(function (a, b) {
            var ai = PRIORITY_LANGS.indexOf((a.srclang || "").toLowerCase());
            var bi = PRIORITY_LANGS.indexOf((b.srclang || "").toLowerCase());
            return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        });
    }

    var selStart = p.start ? convertHHMMSS2Seconds(p.start) : 0;
    var selStop = p.stop ? convertHHMMSS2Seconds(p.stop) : 0;
    var resumeSec = p.resume ? convertHHMMSS2Seconds(p.resume) : 0;

    var iconBtn: React.CSSProperties = {
        width: 36,
        height: 36,
        padding: 0,
        border: 0,
        borderRadius: 2,
        background: "transparent",
        color: FG,
        cursor: "pointer",
        fontSize: 18,
        lineHeight: "36px",
        textAlign: "center",
        verticalAlign: "middle"
    };

    var menuItem: React.CSSProperties = {
        padding: "6px 8px",
        cursor: "pointer",
        whiteSpace: "nowrap"
    };

    // Text-based progress spinner. A CSS @keyframes animation can't be expressed
    // in an inline style object, and this build targets IE11/es5, so the frame is
    // advanced from a timer while an archive request is in flight.
    var [spinTick, setSpinTick] = useState(0);
    useEffect(function () {
        if (!p.archivingId) return;
        var t = setInterval(function () { setSpinTick(function (n) { return n + 1; }); }, 120);
        return function () { clearInterval(t); };
    }, [p.archivingId]);
    var SPIN_FRAMES = ["|", "/", "-", "\\"];

    /** Renders the spinner inline if this archive action is the one running. */
    function archiveSpinner(key: string) {
        if (!p.archivingId || p.archivingId !== key) return null;
        return (
            <span style={{ display: "inline-block", width: 10, textAlign: "center", color: EXTRACT_TICK, marginLeft: 6 }}>
                {SPIN_FRAMES[spinTick % SPIN_FRAMES.length]}
            </span>
        );
    }

    /** Whether the current video is archived (mirrors the old Archive accordion:
     * archived_on is a string but is tested for keys). */
    var isArchived = Object.keys((p.info && p.info.archived_on) ? p.info.archived_on : []).length !== 0;

    /**
     * Quality selector row for archiving: "current" plus the fixed IE11 rungs.
     * Each button is a best-effort attempt — the backend tries SABR, then
     * yt-dlp, and alerts on failure so the user can pick another quality.
     * NND has no dash.js ladder ("current" is meaningless) and no itag presets,
     * so it gets the plain height rungs plus "best".
     */
    function archiveQualityButtons(): JSX.Element {
        var qualities = nnd
            ? ["best", "360p", "480p", "720p", "1080p"]
            : ["current", "360p", "480p", "720p", "1080p"];
        return (
            <div style={{ display: "flex", flexWrap: "wrap", padding: "2px 8px 4px" }}>
                {qualities.map(function (q) {
                    return (
                        <div
                            key={q}
                            style={{ ...menuItem, padding: "4px 6px", fontSize: 11 }}
                            onClick={function () { p.onArchive(q); }}
                        >
                            {q === "current" ? "Current" : q}
                            {archiveSpinner(q)}
                        </div>
                    );
                })}
            </div>
        );
    }

    /**
     * A boolean-setting row with a sliding on/off toggle. Reads the raw
     * localStorage value (the same contract useLocalStorage writes) and toggles
     * it, then dispatches smstorage:<key> so live hooks update, and bumps tickN
     * to repaint. div/span + absolute positioning only (SM parser + IE11 safe).
     */
    function toggleRow(key: string, label: string, reactKey?: string): JSX.Element {
        void tickN; // dependency so the row re-renders after setTickN
        var raw = typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
        var on = raw === "true";
        return (
            <div
                key={reactKey || key}
                style={{ ...menuItem, display: "table", width: "100%", boxSizing: "border-box" }}
                onClick={function () {
                    window.localStorage.setItem(key, on ? "false" : "true");
                    notifyStorageKey(key);
                    setTickN(tickN + 1);
                }}
            >
                <span style={{ display: "table-cell", verticalAlign: "middle", paddingRight: 12 }}>{label}</span>
                <span style={{ display: "table-cell", verticalAlign: "middle", textAlign: "right", width: 40 }}>
                    {/* track */}
                    <span
                        style={{
                            position: "relative",
                            display: "inline-block",
                            width: 32,
                            height: 16,
                            borderRadius: 2,
                            verticalAlign: "middle",
                            background: on ? SELECTION : STRIP_BG,
                            transition: "background 120ms ease"
                        }}
                    >
                        {/* knob */}
                        <span
                            style={{
                                position: "absolute",
                                top: 2,
                                left: on ? 18 : 2,
                                width: 12,
                                height: 12,
                                borderRadius: 2,
                                background: FG,
                                transition: "left 120ms ease"
                            }}
                        />
                    </span>
                </span>
            </div>
        );
    }

    var tick = function (key: string, left: string, color: string, extra?: React.CSSProperties): JSX.Element {
        return (
            <div
                key={key}
                style={{
                    position: "absolute",
                    top: -3,
                    bottom: -3,
                    width: 3,
                    left: left,
                    background: color,
                    ...(extra || {})
                }}
            />
        );
    };

    return (
        <div
            style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 10,
                opacity: visible ? 1 : 0,
                fontFamily: "Arial, sans-serif",
                pointerEvents: visible ? "auto" : "none",
                userSelect: "none",
                WebkitUserSelect: "none",
                msUserSelect: "none"
            }}
            unselectable="on"
            onMouseDown={function () {
                pointerDown.current = true;
                armIdle();
            }}
            onMouseMove={function () {
                armIdle();
            }}
        >
            {/* Progress strip */}
            <div
                ref={stripRef}
                style={{ position: "relative", height: 6, background: STRIP_BG, cursor: "pointer", marginTop: 0 }}
                onMouseDown={function (e) {
                    if (drag.current) return;
                    beginScrub(e);
                }}
                onMouseMove={function (e) {
                    // The document-level listener owns tick drags; don't hijack.
                    if (drag.current) return;
                    if (!scrubbingRef.current) setHoverSec(secFromClientX(e.clientX));
                }}
                onMouseEnter={function () {
                    armIdle();
                }}
                onMouseLeave={function () {
                    if (!scrubbingRef.current) setHoverSec(null);
                }}
            >
                {/* buffered */}
                <div
                    style={{
                        position: "absolute",
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: pct(p.loaded * p.duration),
                        background: STRIP_BUFFER
                    }}
                />
                {/* played */}
                <div
                    style={{
                        position: "absolute",
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: pct(p.played),
                        background: STRIP_PLAYED
                    }}
                />

                {/* current clip selection (start..stop) highlighted blue — click
                    in place reveals draggable markers; drag+release hides them */}
                {p.duration > 0 && selStop > selStart ? (
                    <React.Fragment>
                        {/* blue selection band: press here starts a scrub (so
                            click-drag navigates like the bare strip); a press
                            that never moves reveals the markers on release */}
                        <div
                            style={{
                                position: "absolute",
                                top: 0,
                                bottom: 0,
                                left: pct(selStart),
                                width: pct(selStop - selStart),
                                background: SELECTION,
                                opacity: 0.5,
                                cursor: "pointer",
                                zIndex: 2
                            }}
                            onMouseDown={function (e) {
                                // A marker-handle drag already owns the gesture.
                                if (drag.current || clipDrag.current) return;
                                e.stopPropagation();
                                pointerDown.current = true;
                                bandPress.current = true;
                                scrubMoved.current = false;
                                beginScrub(e);
                            }}
                        />

                        {/* draggable blue markers at each end (only while revealed) */}
                        {markersVisible
                            ? ([["start", selStart], ["stop", selStop]] as ["start" | "stop", number][]).map(function (pair) {
                                  var which = pair[0];
                                  var at = pair[1];
                                  return (
                                      <div
                                          key={"clip-" + which}
                                          style={{
                                              position: "absolute",
                                              top: -4,
                                              bottom: -4,
                                              width: tapWidth(18),
                                              left: "calc(" + pct(at) + " - " + tapWidth(9) + ")",
                                              cursor: "ew-resize",
                                              background: "transparent",
                                              zIndex: 4
                                          }}
                                          onMouseDown={function (e) {
                                              e.stopPropagation();
                                              e.preventDefault();
                                              bandPress.current = false; // marker drag, not a band press
                                              clipDrag.current = { which: which, moved: false };
                                              // Seed with the current bound so the first
                                              // move registers without a wasted commit.
                                              lastSnap.current = Math.round(at);
                                              armIdle();
                                          }}
                                          onClick={function (e) {
                                              e.stopPropagation();
                                          }}
                                      >
                                          <div
                                              style={{
                                                  position: "absolute",
                                                  left: "50%",
                                                  marginLeft: -3,
                                                  top: 0,
                                                  bottom: 0,
                                                  width: 6,
                                                  background: SELECTION
                                              }}
                                          />
                                      </div>
                                  );
                              })
                            : null}
                    </React.Fragment>
                ) : null}

                {/* resume / "Mark" tick */}
                {resumeSec > 0 ? tick("resume", pct(resumeSec), HOVER_TICK, { top: -4, bottom: -4, width: 2 }) : null}

                {/* pending extract ticks (orange) — wide transparent hit zones
                    around a thin core; click plays, drag moves, drag-off removes */}
                {p.options.map(function (opt, i) {
                    var b = optBounds(opt);
                    var spanLeft = b[0];
                    var spanStop = b[1];
                    return (
                        <React.Fragment key={i}>
                            {/* diagonal cross linking the start<->stop bounds
                                (lt->rb and rt->lb). pointerEvents:none + zIndex:1
                                keep it decorative and behind the interactive
                                layers (center click = z2, tick drag = z3). */}
                            <svg
                                style={{
                                    position: "absolute",
                                    left: pct(spanLeft),
                                    width: pct(Math.max(0, spanStop - spanLeft)),
                                    top: -4,
                                    height: "calc(100% + 8px)",
                                    pointerEvents: "none",
                                    overflow: "visible",
                                    zIndex: 1
                                }}
                                preserveAspectRatio="none"
                            >
                                <line x1="0%" y1="0" x2="100%" y2="100%" stroke={EXTRACT_TICK} strokeWidth="1" />
                                <line x1="100%" y1="0" x2="0%" y2="100%" stroke={EXTRACT_TICK} strokeWidth="1" />
                            </svg>
                            {/* clickable center between the bounds: plays the extract */}
                            <div
                                title={opt.value + " — " + opt.label}
                                style={{
                                    position: "absolute",
                                    top: 0,
                                    bottom: 0,
                                    left: pct(spanLeft),
                                    width: pct(Math.max(0, spanStop - spanLeft)),
                                    cursor: "pointer",
                                    background: "transparent",
                                    zIndex: 2
                                }}
                                onMouseDown={function (e) {
                                    e.stopPropagation();
                                }}
                                onClick={function (e) {
                                    e.stopPropagation();
                                    p.onSelectExtract(opt);
                                }}
                            />
                            {[0, 1].map(function (k) {
                                var which: "start" | "stop" = k === 0 ? "start" : "stop";
                                return (
                                    <div
                                        key={i + "-" + k}
                                        title={opt.value + " — " + opt.label}
                                        style={{
                                            position: "absolute",
                                            top: -4,
                                            bottom: -4,
                                            width: tapWidth(18),
                                            left: "calc(" + pct(b[k]) + " - " + tapWidth(9) + ")",
                                            cursor: "ew-resize",
                                            background: "transparent",
                                            zIndex: 3
                                        }}
                                        onMouseDown={function (e) {
                                            e.stopPropagation();
                                            e.preventDefault();
                                            drag.current = { index: i, which: which, moved: false };
                                            // Seed with the current bound so the first
                                            // move registers without a wasted commit.
                                            lastSnap.current = Math.round(b[k]);
                                            armIdle();
                                        }}
                                        onClick={function (e) {
                                            e.stopPropagation();
                                        }}
                                    >
                                        <div
                                            style={{
                                                position: "absolute",
                                                left: "50%",
                                                marginLeft: -3,
                                                top: 0,
                                                bottom: 0,
                                                width: 6,
                                                background: EXTRACT_TICK
                                            }}
                                        />
                                    </div>
                                );
                            })}
                        </React.Fragment>
                    );
                })}

                {/* hover tick + tooltip */}
                {hoverSec != null ? tick("hover", pct(hoverSec), HOVER_TICK, { top: -4, bottom: -4, width: 2 }) : null}
                {hoverSec != null ? (
                    <div
                        style={{
                            position: "absolute",
                            bottom: 14,
                            left: pct(hoverSec),
                            transform: "translateX(-50%)",
                            WebkitTransform: "translateX(-50%)",
                            msTransform: "translateX(-50%)",
                            background: BAR_BG,
                            color: FG,
                            fontSize: 11,
                            padding: "2px 5px",
                            whiteSpace: "nowrap"
                        }}
                    >
                        {formatTime(hoverSec, p.duration)}
                    </div>
                ) : null}
            </div>

            {/* Control strip */}
            <div style={{ display: "table", width: "100%", minHeight: 38, background: BAR_BG, color: FG }}>
                <div
                    style={{
                        display: "table-cell",
                        verticalAlign: "middle",
                        padding: "2px 10px",
                        whiteSpace: "nowrap"
                    }}
                >
                    <button
                        type="button"
                        style={iconBtn}
                        title={p.playing ? "Pause" : "Play"}
                        aria-label={p.playing ? "Pause" : "Play"}
                        onClick={function () {
                            p.setPlaying(!p.playing);
                        }}
                    >
                        {p.playing ? "\u275A\u275A" : "\u25B6"}
                    </button>

                    {/* volume: click toggles mute, hover reveals the slider */}
                    <span
                        ref={volWrapRef}
                        style={{ display: "inline-block", position: "relative", verticalAlign: "middle" }}
                        onMouseEnter={function () {
                            setVolumeOpen(true);
                            armIdle();
                        }}
                        onMouseLeave={function () {
                            // Don't close while actively dragging the slider.
                            if (!volDragging.current) setVolumeOpen(false);
                        }}
                    >
                        <button
                            type="button"
                            style={iconBtn}
                            title={p.muted || p.volume === 0 ? "Unmute" : "Mute"}
                            aria-label={p.muted || p.volume === 0 ? "Unmute" : "Mute"}
                            onClick={function () {
                                p.setMuted(!p.muted);
                            }}
                        >
                            {p.muted || p.volume === 0 ? "\uD83D\uDD07" : "\uD83D\uDD0A"}
                        </button>
                        {volumeOpen ? (
                            <span
                                style={{
                                    position: "absolute",
                                    bottom: 34,
                                    left: "50%",
                                    marginLeft: -17,
                                    background: BAR_BG,
                                    padding: "8px 6px",
                                    height: 96,
                                    width: 34,
                                    boxSizing: "border-box",
                                    zIndex: 12
                                }}
                            >
                                {/* Custom div slider (no rotated input): bottom = muted. */}
                                <div
                                    ref={volRef}
                                    style={{
                                        position: "relative",
                                        width: 4,
                                        height: 80,
                                        margin: "0 auto",
                                        background: STRIP_BG,
                                        cursor: "pointer"
                                    }}
                                    onMouseDown={function (e) {
                                        e.stopPropagation();
                                        volDragging.current = true;
                                        applyVol(e);
                                    }}
                                >
                                    {/* filled portion grows from the bottom */}
                                    <div
                                        style={{
                                            position: "absolute",
                                            left: 0,
                                            right: 0,
                                            bottom: 0,
                                            height: ((p.muted ? 0 : p.volume) * 100) + "%",
                                            background: FG
                                        }}
                                    />
                                    {/* thumb */}
                                    <div
                                        style={{
                                            position: "absolute",
                                            left: -4,
                                            width: 12,
                                            height: 12,
                                            marginBottom: -6,
                                            bottom: ((p.muted ? 0 : p.volume) * 100) + "%",
                                            background: FG,
                                            borderRadius: 6
                                        }}
                                    />
                                </div>
                            </span>
                        ) : null}
                    </span>

                    <span style={{ fontSize: 13, margin: "0 8px", verticalAlign: "middle" }}>
                        {formatTime(p.played, p.duration)} / {formatTime(p.duration, p.duration)}
                    </span>
                </div>

                <div
                    style={{
                        display: "table-cell",
                        verticalAlign: "middle",
                        padding: "2px 10px",
                        whiteSpace: "nowrap",
                        textAlign: "right",
                        width: 224
                    }}
                >
                    {/* archive floppy: colour/glyph reflects archived state at a glance.
                        Opens a popover with the synopsis + archive actions. */}
                    <button
                        type="button"
                        style={{ ...iconBtn, color: isArchived ? ON_COLOR : OFF_COLOR }}
                        title={isArchived ? "Archived" : "Not archived"}
                        aria-label="Archive"
                        onClick={function () {
                            if (p.settingsOpen && menu === "archive") {
                                p.setSettingsOpen(false);
                            } else {
                                p.setSettingsOpen(true);
                                setMenu("archive");
                            }
                        }}
                    >
                        {"\uD83D\uDCBE"}
                    </button>
                    {/* extract: click = offset extract, hold = range extract.
                        Does NOT pause on press (that would stop the timeline);
                        pause + prompt happen on release via finishExtract(). */}
                    <button
                        type="button"
                        style={iconBtn}
                        title="Extract (hold to capture a range)"
                        aria-label="Extract"
                        onMouseDown={function (e) {
                            e.stopPropagation();
                            held.current = true;
                            holdStart.current = p.played;
                            setVisible(true);
                            armIdle();
                        }}
                        onMouseUp={function (e) {
                            e.stopPropagation();
                            finishExtract();
                        }}
                    >
                        <span style={{ fontSize: 16, position: "relative", display: "inline-block", lineHeight: "20px" }}>
                            {"\u2702"}
                            <span
                                style={{
                                    position: "absolute",
                                    // left: "70%",
                                    top: 6,
                                    transform: "translateX(-15%)",
                                    WebkitTransform: "translateX(-15%)",
                                    msTransform: "translateX(-15%)",
                                    fontSize: 10,
                                    fontWeight: "bold",
                                    color: FG,
                                    pointerEvents: "none"
                                }}
                            >
                                {p.extractOffsetSec}
                            </span>
                        </span>
                    </button>
                    {/* actions menu: screenshot, summarize, captions, archive actions */}
                    <button
                        type="button"
                        style={iconBtn}
                        title="Actions"
                        aria-label="Actions"
                        onClick={function () {
                            if (p.settingsOpen && menu !== "lang") {
                                p.setSettingsOpen(false);
                            } else {
                                p.setSettingsOpen(true);
                                setMenu("actions");
                            }
                        }}
                    >
                        {"\u2630"}
                    </button>
                    <button
                        type="button"
                        style={iconBtn}
                        title="Settings"
                        aria-label="Settings"
                        onClick={function () {
                            if (p.settingsOpen && menu !== "lang") {
                                p.setSettingsOpen(false);
                            } else {
                                p.setSettingsOpen(true);
                                setMenu("main");
                            }
                        }}
                    >
                        {"\u2699"}
                    </button>
                    <button
                        type="button"
                        style={{ ...iconBtn, fontSize: 13, fontWeight: p.activeTrack ? "bold" : "normal", position: "relative", top: 1 }}  
                        title="Captions"
                        aria-label="Captions"
                        onClick={function () {
                            if (p.settingsOpen && menu === "lang") {
                                p.setSettingsOpen(false);
                            } else {
                                p.onRequestTracks();
                                p.setSettingsOpen(true);
                                setMenu("lang");
                            }
                        }}
                    >
                        {"CC"}
                    </button>
                    <button
                        type="button"
                        style={iconBtn}
                        title="Fullscreen"
                        aria-label="Fullscreen"
                        onClick={function () {
                            p.onFullscreen();
                        }}
                    >
                        {"\u26F6"}
                    </button>
                </div>
            </div>

            {/* Settings popover (video.js-style nested menus) */}
            {p.settingsOpen ? (
                <div
                    style={{
                        position: "absolute",
                        right: 8,
                        bottom: 50,
                        minWidth: 190,
                        maxHeight: 340,
                        overflowY: "auto",
                        background: BAR_BG,
                        color: FG,
                        fontSize: 12,
                        padding: 4,
                        zIndex: 11
                    }}
                    onMouseDown={function (e) {
                        e.stopPropagation();
                    }}
                >
                    {menu === "main" ? (
                        <div>
                            <div style={menuItem} onClick={function () { setMenu("speed"); }}>
                                {"Speed \u25B8"}
                            </div>
                            {p.qualities.length > 0 ? (
                                <div style={menuItem} onClick={function () { setMenu("quality"); }}>
                                    {"Quality \u25B8"}
                                </div>
                            ) : null}
                            <div style={menuItem} onClick={function () { setMenu("pending"); }}>
                                {"Pending Extracts (" + p.options.length + ") \u25B8"}
                            </div>
                            <div style={menuItem} onClick={function () { setMenu("setPlayer"); }}>
                                {"Player behaviour \u25B8"}
                            </div>
                            <div style={menuItem} onClick={function () { setMenu("setArchive"); }}>
                                {"Archive behaviour \u25B8"}
                            </div>
                            <div style={menuItem} onClick={function () { setMenu("flags"); }}>
                                {"Debug flags \u25B8"}
                            </div>
                        </div>
                    ) : null}

                    {menu === "actions" ? (
                        <div>
                            <div style={menuItem} onClick={function () { p.onScreenshot(); }}>
                                {"\uD83D\uDDBC Screenshot"}
                            </div>
                            <div style={menuItem} onClick={function () { p.onSummarize(); }}>
                                {"\uD83E\uDD16 Summarize with AI"}
                            </div>
                            <div style={menuItem} onClick={function () { p.onOpenYT(); }}>
                                {nnd ? "\uD83C\uDF0E Open on nicovideo" : "\uD83C\uDF0E Open in YouTube"}
                            </div>
                            {/* test-only: appends the unstyled Archive accordion to the page end */}
                            <div style={menuItem} onClick={function () { p.onToggleArchivePane(); p.setSettingsOpen(false); }}>
                                {"\uD83D\uDCC1 Append accordion"}
                            </div>
                            <div style={menuItem} onClick={function () { setMenu("captions"); }}>
                                {"Captions \u25B8"}
                            </div>
                            <div style={menuItem} onClick={function () { setMenu("archiveActions"); }}>
                                {"Archive actions \u25B8"}
                            </div>
                        </div>
                    ) : null}

                    {menu === "captions" ? (
                        <div>
                            <div style={menuItem} onClick={function () { setMenu("actions"); }}>
                                {"\u25C2 Captions"}
                            </div>
                            <div style={menuItem} onClick={function () { p.onCopyCue(0); }}>
                                {"Copy cue"}
                            </div>
                            <div style={menuItem} onClick={function () { p.onCopyCue(1); }}>
                                {"Copy around cue"}
                            </div>
                            <div style={menuItem} onClick={function () { p.onTranslateCue(0); }}>
                                {"Translate cue"}
                            </div>
                            <div style={menuItem} onClick={function () { p.onTranslateCue(1); }}>
                                {"Translate around cue"}
                            </div>
                        </div>
                    ) : null}

                    {menu === "archiveActions" ? (
                        <div>
                            <div style={menuItem} onClick={function () { setMenu("actions"); }}>
                                {"\u25C2 Archive actions"}
                            </div>
                            {isArchived
                                ? <div>
                                      {nnd ? null : <div style={menuItem} onClick={function () { p.onArchive(undefined, true, true, false); }}>
                                          Re-archive captions{archiveSpinner("captions")}
                                      </div>}
                                      <div style={{ ...menuItem, color: OFF_COLOR }} onClick={function () { p.onDeleteArchive(); }}>
                                          Delete
                                      </div>
                                  </div>
                                : <div style={menuItem} onClick={function () { p.onArchive(); }}>
                                      Archive: {archiveSpinner("best")}
                                  </div>}
                            {!isArchived ? archiveQualityButtons() : null}
                            {!isArchived && p.info && p.info.file_formats && Object.keys(p.info.file_formats).length !== 0
                                ? Object.keys(p.info.file_formats).map(function (itagMime) {
                                      var f = (p.info as ArchiveInfo).file_formats[itagMime];
                                      return (
                                          <div
                                              key={itagMime}
                                              style={menuItem}
                                              onClick={function () { p.onArchive(f.quality_label); }}
                                          >
                                              {(f.quality_label || "???") + " [" + f.itag + "]"}
                                              {archiveSpinner(f.quality_label || "")}
                                          </div>
                                      );
                                  })
                                : null}
                        </div>
                    ) : null}

                    {menu === "archive" ? (
                        <div style={{ maxWidth: 260 }}>
                            <div style={{ ...menuItem, cursor: "default", fontWeight: "bold", color: isArchived ? ON_COLOR : OFF_COLOR }}>
                                {isArchived
                                    ? "Archived [" + getQualityLabel(p.info) + "] [" +
                                      new Date((p.info && p.info.archived_on) ? p.info.archived_on : "").toLocaleDateString() + "]"
                                    : "Not archived"}
                            </div>
                            {p.info ? (
                                <div style={{ padding: "4px 8px", fontSize: 11, whiteSpace: "normal", lineHeight: "15px" }}>
                                    <div>{p.info.title}</div>
                                    <div style={{ color: STRIP_BUFFER }}>{p.info.author_name} · {stripPublishedLabel(p.info.published)}</div>
                                </div>
                            ) : null}
                            {isArchived
                                ? <div>
                                      {nnd ? null : <div style={menuItem} onClick={function () { p.onArchive(undefined, true, true, false); }}>
                                          Re-archive captions{archiveSpinner("captions")}
                                      </div>}
                                      <div style={{ ...menuItem, color: OFF_COLOR }} onClick={function () { p.onDeleteArchive(); }}>
                                          Delete archive
                                      </div>
                                  </div>
                                : <div style={menuItem} onClick={function () { p.onArchive(); }}>
                                      Archive: {archiveSpinner("best")}
                                  </div>}
                            {!isArchived ? archiveQualityButtons() : null}
                        </div>
                    ) : null}

                    {menu === "setPlayer" ? (
                        <div>
                            <div style={menuItem} onClick={function () { setMenu("main"); }}>
                                {"\u25C2 Player behaviour"}
                            </div>
                            {SETTINGS_PLAYER.map(function (sec) {
                                return (
                                    <div key={sec.group}>
                                        <div style={{ padding: "8px 8px 2px", color: STRIP_BUFFER, fontWeight: "bold" }}>
                                            {sec.group}
                                        </div>
                                        {sec.rows.map(function (r) {
                                            return toggleRow(r.key, r.label, sec.group + "/" + r.label);
                                        })}
                                    </div>
                                );
                            })}
                            {nnd ? (
                                <div>
                                    <div style={{ padding: "8px 8px 2px", color: STRIP_BUFFER, fontWeight: "bold" }}>
                                        Niconico
                                    </div>
                                    {SETTINGS_NND.map(function (s) { return toggleRow(s.key, s.label); })}
                                </div>
                            ) : null}
                        </div>
                    ) : null}

                    {menu === "setArchive" ? (
                        <div>
                            <div style={menuItem} onClick={function () { setMenu("main"); }}>
                                {"\u25C2 Archive behaviour"}
                            </div>
                            {SETTINGS_ARCHIVE.map(function (s) { return toggleRow(s.key, s.label); })}
                        </div>
                    ) : null}

                    {menu === "flags" ? (
                        <div>
                            <div style={menuItem} onClick={function () { setMenu("main"); }}>
                                {"\u25C2 Debug flags"}
                            </div>
                            {Object.keys(StorageKey).filter(function (k) {
                                var v = window.localStorage.getItem((StorageKey as any)[k]);
                                return v === "true" || v === "false";
                            }).map(function (k) {
                                return toggleRow((StorageKey as any)[k], k);
                            })}
                        </div>
                    ) : null}

                    {menu === "speed" ? (
                        <div>
                            <div style={menuItem} onClick={function () { setMenu("main"); }}>
                                {"\u25C2 Speed"}
                            </div>
                            {[0.5, 1, 1.5, 2].map(function (r) {
                                return (
                                    <div
                                        key={r}
                                        style={{ ...menuItem, fontWeight: p.playbackRate === r ? "bold" : "normal" }}
                                        onClick={function () {
                                            p.setPlaybackRate(r);
                                        }}
                                    >
                                        {r + "x"}
                                    </div>
                                );
                            })}
                        </div>
                    ) : null}

                    {menu === "quality" ? (
                        <div>
                            <div style={menuItem} onClick={function () { setMenu("main"); }}>
                                {"\u25C2 Quality"}
                            </div>
                            {toggleRow(StorageKey.SLOW_NETWORK, "Slow network")}
                            {p.qualities.map(function (q) {
                                return (
                                    <div
                                        key={q}
                                        style={{ ...menuItem, fontWeight: p.activeQuality === q ? "bold" : "normal" }}
                                        onClick={function () {
                                            p.setResolution(q);
                                        }}
                                    >
                                        {p.activeQuality === q ? "\u2713 " : ""}{q.indexOf("video-") === 0 ? (q.match(/\d+p/) || [q])[0] : q + "p"}
                                    </div>
                                );
                            })}
                        </div>
                    ) : null}

                    {menu === "lang" ? (
                        <div>
                            <div style={menuItem} onClick={function () { setMenu("main"); }}>
                                {"\u25C2 Captions"}
                            </div>
                            <div style={{ maxHeight: 140, overflowY: "auto" }}>
                                <div
                                    style={{ ...menuItem, fontWeight: p.activeTrack == null ? "bold" : "normal" }}
                                    onClick={function () {
                                        p.onSelectTrack(null);
                                    }}
                                >
                                    Off
                                </div>
                                {sortedTracks().map(function (t) {
                                    return (
                                        <div
                                            key={t.srclang + t.label}
                                            style={{ ...menuItem, fontWeight: p.activeTrack === t.srclang ? "bold" : "normal" }}
                                            onClick={function () {
                                                p.onSelectTrack(t.srclang);
                                            }}
                                        >
                                            {t.label}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ) : null}

                    {menu === "pending" ? (
                        <div>
                            <div style={menuItem} onClick={function () { setMenu("main"); }}>
                                {"\u25C2 Pending Extracts"}
                            </div>
                            {p.options.length === 0 ? (
                                <div style={{ ...menuItem, color: STRIP_BUFFER, cursor: "default" }}>
                                    No pending extracts
                                </div>
                            ) : null}
                            {p.options.map(function (opt, i) {
                                return (
                                    <div key={i} style={{ ...menuItem, cursor: "default" }}>
                                        <span
                                            style={{ cursor: "pointer" }}
                                            onClick={function () {
                                                p.onSelectExtract(opt);
                                            }}
                                        >
                                            {opt.value} — {opt.label}
                                        </span>
                                        <span
                                            title="Cancel extract"
                                            style={{ cursor: "pointer", color: EXTRACT_TICK, marginLeft: 8, fontWeight: "bold" }}
                                            onClick={function () {
                                                p.onRemoveExtract(opt);
                                            }}
                                        >
                                            {"\u2715"}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
});

export default SMControls;
