/*
 * SABR media session — port of TubeReplacer's TRSabrStream.m +
 * TRSabrStream+PartHandler.m + the transport bits of TRSabrRequest.m.
 *
 * This is the piece that actually beats the ~59s throttle: instead of handing
 * the player plain googlevideo URLs (which YouTube now throttles / SABRs),
 * the server holds a live SABR session against server_abr_streaming_url and
 * pulls real media parts, which the HLS front-end then serves.
 *
 * Streaming protocol shape (all learned from TubeReplacer, verified current):
 *  - POST protobuf VideoPlaybackAbrRequest to `<sabrUrl>&rn=<n>`
 *  - headers: content-type application/x-protobuf, accept application/vnd.yt-ump,
 *    accept-encoding identity
 *  - PO token rides *inside* StreamerContext.po_token as raw bytes (not base64)
 *  - response is UMP: sequence of [partType][size][data]
 *  - NexTRequestPolicy hands back a playbackCookie that must be echoed on the
 *    following requests, and the video/audio itags the server selected
 *  - StreamProtectionStatus 3 = dead stream, SabrError = dead stream
 */

import { parseUmp, UMP_PART_ID, UmpPart } from "./ump";
import {
	decodeFields, getBytes, getString, getVarint, getPackedVarints,
	int32Field, int64Field, boolField, fixed32Field,
	bytesField, stringField,
} from "./proto";
import { parseInitSegment, getFragmentTiming } from "./mp4";
import { censusLog } from "../utils/bgCensus";

export interface SabrInputFormat {
	itag: number;
	xtags?: string;
	mimeType: string;
	lastModified?: string;
	isAudio: boolean;
	/** Optional DASH metadata (watch-page formats) */
	codecs?: string;
	width?: number;
	height?: number;
	/** Frame rate, used to declare accurate MediaCapabilities to the server. */
	fps?: number;
	bandwidth?: number;
	audioSampleRate?: number;
	/** Full media duration in ms (from the watch-page adaptive format) */
	approxDurationMs?: number;
}

export interface SabrClientInfo {
	clientName: number;
	clientVersion: string;
	osName: string;
	osVersion: string;
	acceptLanguage?: string;
	acceptRegion?: string;
}

export interface SabrSegment {
	data: Buffer;
	/** segment duration in ms, from the SABR MediaHeader */
	durationMs?: number;
	/** segment start time in ms, from the SABR MediaHeader (field 11) */
	startMs?: number;
	/** decode time in media timescale ticks (from moof/tfdt, if present) */
	baseDecodeTimeTicks?: number;
	/** total sample duration in media timescale ticks (from moof/trun) */
	durationTicks?: number;
}

export class SabrMedia {
	itag = 0;
	initSegment?: Buffer;
	ready = false;
	timescale = 1000;
	/** per-segment duration in ms, derived from sidx if available */
	segmentDurationMs?: number;
	/** per-segment presentation timeline from sidx (authoritative for $Number$) */
	segmentTimeline?: { startMs: number; durationMs: number }[];
	/** sequence number (1-based, matching TubeReplacer) -> segment */
	segments = new Map<number, SabrSegment>();
	/** total number of segments, from FormatInitializationMetadata */
	endSegmentNumber?: number;
	/** end time in ms, from FormatInitializationMetadata */
	endTimeMs?: number;
	/** Cached merged coverage intervals; invalidated when a segment arrives. */
	private intervalsCache?: Array<[number, number]>;

	private pending = new Map<number, Array<() => void>>();
	/** Registration time (ms) per pending waiter, so stale ones can be dropped. */
	private pendingAt = new Map<number, number>();
	/**
	 * Called when a new waiter registers for a segment we do not have yet.
	 * The owning stream uses it to wake a parked pump loop (the route nudges
	 * BEFORE awaiting onSegment, so without this the loop could re-park in the
	 * window between the nudge and the waiter registration).
	 */
	onDemand?: () => void;
	/** Waiters older than this are considered abandoned (the route's race timed
	 * out) and no longer count as demand. Kept in sync with the route's
	 * segment-request give-up (Math.min(timeoutMs, 15000)) so the relay stops
	 * hitting the server at the same moment the player gives up. */
	private static readonly PENDING_TTL_MS = 15_000;

	/** Resolves once `seq` (or the init segment for seq 0) has arrived. */
	onSegment(seq: number): Promise<void> {
		if (seq === 0 && this.ready) return Promise.resolve();
		if (seq !== 0 && this.segments.has(seq)) return Promise.resolve();
		return new Promise((resolve) => {
			const arr = this.pending.get(seq) ?? [];
			arr.push(resolve);
			this.pending.set(seq, arr);
			this.pendingAt.set(seq, Date.now());
			// Wake the pump only after the waiter is registered, so the loop
			// observes the pending demand when it re-evaluates needsData().
			this.onDemand?.();
		});
	}

	private notify(seq: number) {
		const arr = this.pending.get(seq);
		this.pendingAt.delete(seq);
		if (arr) {
			this.pending.delete(seq);
			for (const cb of arr) cb();
		}
	}

	setInitSegment(data: Buffer) {
		if (this.ready) return;
		const parsed = parseInitSegment(data);
		if (parsed.timescale) this.timescale = parsed.timescale;
		if (parsed.segmentDurationMs) this.segmentDurationMs = parsed.segmentDurationMs;
		if (parsed.segmentTimeline?.length) this.segmentTimeline = parsed.segmentTimeline;
		this.initSegment = data;
		this.ready = true;
		// The nominal duration may have just changed -> coverage cache is stale.
		this.intervalsCache = undefined;
		this.notify(0);
	}

	addSegment(seq: number, segment: SabrSegment) {
		if (!this.segments.has(seq)) {
			this.segments.set(seq, segment);
			// Coverage changed -> the merged-interval cache is stale.
			this.intervalsCache = undefined;
		}
		this.notify(seq);
	}

	/** Contiguous, sorted list of available sequence numbers. */
	availableSegments(): number[] {
		return [...this.segments.keys()].sort((a, b) => a - b);
	}

	/**
	 * Compact description of the sidx-derived timeline, used by the diagnostics
	 * endpoints. Comparing two renditions' timelines establishes whether SABR
	 * segments are aligned across itags — if seq N covers the same presentation
	 * time in every rendition, a multi-Representation MPD can clone one timeline
	 * onto all of them instead of prefetching every init segment.
	 */
	describeTimeline(): {
		entries: number;
		totalMs: number;
		first5: number[];
		last5: number[];
		first5Starts: number[];
	} | null {
		if (!this.segmentTimeline?.length) return null;
		const durs = this.segmentTimeline.map((e) => Math.round(e.durationMs));
		return {
			entries: durs.length,
			totalMs: durs.reduce((a, b) => a + b, 0),
			first5: durs.slice(0, 5),
			last5: durs.slice(-5),
			first5Starts: this.segmentTimeline.slice(0, 5).map((e) => Math.round(e.startMs)),
		};
	}

	/**
	 * End (ms) of the contiguous buffered range starting at seq 1, mirroring
	 * googlevideo's TrackCollection.buffered. Returns undefined if the first
	 * segment is missing or untimed. This is the value a real player reports as
	 * player_time_ms (the server doles out segments relative to it).
	 */
	bufferedEndMs(): number | undefined {
		const seqs = this.availableSegments();
		if (!seqs.length || seqs[0] !== 1) return undefined;
		let end: number | undefined;
		for (const s of seqs) {
			const seg = this.segments.get(s)!;
			if (seg.startMs === undefined || seg.durationMs === undefined) return end;
			const segEnd = seg.startMs + seg.durationMs;
			if (end === undefined) end = segEnd;
			else if (seg.startMs <= end + 1) end = Math.max(end, segEnd);
			else break; // gap — the contiguous range ends here
		}
		return end;
	}

	/**
	 * Contiguous buffered end in ms, tolerant of segments that carry no timing.
	 *
	 * `bufferedEndMs()` returns undefined the moment a segment lacks startMs
	 * (some SABR media headers omit both field 11/12 and the time_range
	 * fallback), which would pin a download driver's player_time_ms at 0 forever
	 * — the server then re-serves the same first window indefinitely. Here an
	 * untimed segment is assumed to follow the previous one, using the sidx
	 * timeline or the nominal duration, so the reported position keeps advancing.
	 */
	contiguousEndMs(): number {
		const seqs = this.availableSegments();
		if (!seqs.length || seqs[0] !== 1) return 0;
		const nominal = this.segmentDurationMs && this.segmentDurationMs > 0 ? this.segmentDurationMs : 5000;
		let end = 0;
		for (const s of seqs) {
			const seg = this.segments.get(s)!;
			const tl = this.segmentTimeline?.[s - 1];
			const start = seg.startMs ?? tl?.startMs ?? end;
			const dur = seg.durationMs ?? tl?.durationMs ?? nominal;
			if (start > end + 1) break; // real gap
			end = Math.max(end, start + dur);
		}
		return end;
	}

	/**
	 * True when the buffer already covers [fromMs, fromMs + aheadMs] of
	 * presentation time.
	 *
	 * Coverage-based (not sequence-count-based) on purpose: the seq math used
	 * the nominal segment duration, and any mismatch with the real sidx timings
	 * produced a "toSeq" that never existed, so the window could never be
	 * considered full and the pump ran forever. This walks the ACTUAL segment
	 * intervals instead, so a fully buffered track parks the pump.
	 *
	 * `endOfStreamReached` short-circuits: once the final segment is buffered
	 * there is nothing more to fetch, regardless of the window bounds.
	 */
	hasWindow(fromMs: number, aheadMs: number): boolean {
		if (!this.ready) return false;
		if (this.endOfStreamReached) return true;
		return this.coversRange(fromMs, fromMs + aheadMs);
	}

	/**
	 * True when every millisecond of [fromMs, toMs] falls inside some buffered
	 * segment. Uses real startMs/durationMs where available and falls back to
	 * the nominal duration otherwise.
	 */
	coversRange(fromMs: number, toMs: number): boolean {
		if (toMs <= fromMs) return true;
		const merged = this.mergedIntervals();
		// Walk the merged intervals and check the range is fully covered.
		let cursor = fromMs;
		for (const [s, e] of merged) {
			if (e <= cursor) continue;
			if (s > cursor) break; // gap
			cursor = e;
			if (cursor >= toMs) return true;
		}
		return cursor >= toMs;
	}

	/**
	 * Merged, sorted coverage intervals of the buffered segments.
	 * Cached and invalidated when a new segment arrives, so the pump loop
	 * does not re-sort every segment on every tick.
	 */
	private mergedIntervals(): Array<[number, number]> {
		if (this.intervalsCache) return this.intervalsCache;
		const nominal = this.segmentDurationMs && this.segmentDurationMs > 0 ? this.segmentDurationMs : 5000;
		const intervals: Array<[number, number]> = [];
		for (const [seq, seg] of this.segments) {
			const start = seg.startMs ?? (seq - 1) * nominal;
			const dur = seg.durationMs ?? nominal;
			if (!Number.isFinite(start) || !Number.isFinite(dur) || dur <= 0) continue;
			intervals.push([start, start + dur]);
		}
		intervals.sort((a, b) => a[0] - b[0]);
		const merged: Array<[number, number]> = [];
		for (const [s, e] of intervals) {
			const last = merged[merged.length - 1];
			if (last && s <= last[1]) last[1] = Math.max(last[1], e);
			else merged.push([s, e]);
		}
		this.intervalsCache = merged;
		return merged;
	}

	/**
	 * Sequence number (1-based) containing `ms` on the presentation timeline.
	 * Prefers the sidx-derived timeline (authoritative for $Number$) and falls
	 * back to the flat segmentDurationMs divisor.
	 */
	sequenceAt(ms: number): number | undefined {
		if (this.segmentTimeline?.length) {
			let seq: number | undefined;
			for (let i = 0; i < this.segmentTimeline.length; i++) {
				const e = this.segmentTimeline[i];
				if (e.startMs <= ms) seq = i + 1;
				else break;
			}
			// Before the first segment -> first segment.
			return seq ?? 1;
		}
		const dur = this.segmentDurationMs ?? 5000;
		if (!Number.isFinite(dur) || dur <= 0) return undefined;
		return Math.max(1, Math.floor(ms / dur) + 1);
	}

	/**
	 * True when someone is waiting for a segment we don't have yet.
	 * Pending waiters are an explicit demand signal (PipePipe's awaitSegment
	 * only fetches until the requested segment arrives).
	 */
	hasPendingDemand(): boolean {
		const now = Date.now();
		for (const [seq, arr] of this.pending) {
			if (!arr.length) continue;
			const started = this.pendingAt.get(seq) ?? 0;
			if (now - started > SabrMedia.PENDING_TTL_MS) {
				// The waiter abandoned the request (the route's race timed out);
				// it must not keep the pump alive forever.
				this.pending.delete(seq);
				this.pendingAt.delete(seq);
				continue;
			}
			if (seq === 0 ? !this.ready : !this.segments.has(seq)) return true;
		}
		return false;
	}

	/**
	 * googlevideo's Track.endOfStreamReached — the final segment is present.
	 */
	get endOfStreamReached(): boolean {
		return (
			this.endSegmentNumber !== undefined &&
			this.endSegmentNumber > 0 &&
			this.segments.has(this.endSegmentNumber)
		);
	}
}

/** Default bandwidth estimate reported to the SABR server (bits/second). */
export const SABR_DEFAULT_BANDWIDTH_BPS = 5_000_000;

/**
 * Bandwidth estimate reported in slow-network mode (bits/second). Deliberately
 * low so the server prioritizes fast delivery over quality.
 */
export const SABR_SLOW_NETWORK_BPS = 1_000_000;

export class SabrStream {
	requestNumber = 0;
	private playbackCookie?: Buffer;
	private backoffUntil = 0;
	dead = false;
	bandwidthEstimate = SABR_DEFAULT_BANDWIDTH_BPS;
	private playbackStartAt = Date.now();
	/** Server-issued SABR contexts (part 57), echoed per the sending policy (59). */
	private sabrContexts = new Map<number, { raw: Buffer; type: number; sendByDefault: boolean }>();
	private activeSabrContextTypes = new Set<number>();

	video = new SabrMedia();
	audio = new SabrMedia();
	/**
	 * One SabrMedia per video rendition (itag). The server serves exactly one
	 * video itag at a time, but each rendition needs its own init segment and
	 * its own seq -> segment map: sequence numbers collide across itags, and a
	 * switch back to a previously served rendition replays from cache for free.
	 *
	 * `audio` stays a single track — audio switching is out of scope.
	 */
	readonly videoTracks = new Map<number, SabrMedia>();
	/** Itag the server is actually serving (from the playback cookie / part 42). */
	servedVideoItag = 0;
	/** Itag we have asked for (field 17). Equals `servedVideoItag` once the
	 * server confirms; the two diverge transiently during a switch. */
	private requestedVideoItag?: number;
	/** When the last user-driven format selection happened, for field 13. */
	private lastFormatSwitchAt = 0;
	/**
	 * Observation state for `probeFormatSwitch`. Deliberately separate from
	 * `video`/`audio`: the live tracks keep their identity so an in-flight switch
	 * cannot disturb what the player is reading. Media for the probe target is
	 * captured here instead of the real track.
	 */
	private probe: {
		active: boolean;
		targetItag: number;
		init?: Buffer;
		segments: Map<number, Buffer>;
		/** Per-sequence header timing (part 20 fields 11/12/15). */
		segmentTiming: Map<number, { startMs?: number; durationMs?: number }>;
		timeline?: { startMs: number; durationMs: number }[];
		endSeg?: number;
		endTime?: number;
		sawSeek: boolean;
		armedAt: number;
		expiresAt: number;
	} = {
		active: false,
		targetItag: 0,
		segments: new Map(),
		segmentTiming: new Map(),
		sawSeek: false,
		armedAt: 0,
		expiresAt: 0,
	};
	private probeFormat?: SabrInputFormat;
	/** Probe requests issued so far (bounded so a refusal cannot spin forever). */
	private probeRounds = 0;
	private static readonly PROBE_MAX_ROUNDS = 15;
	/** Increments whenever new media arrived — used by wait loops. */
	progressCounter = 0;
	/** Last player time we told the server about, for readahead. */
	lastPlayerTimeMs = 0;
	/** When stop() was called (for post-mortem backoff in the session map). */
	deadAt?: number;
	/**
	 * Invoked after every successful round-trip. The SABR session map uses it to
	 * refresh its idle timer, so a long run-to-completion download keeping the
	 * stream busy cannot be reaped out from under the caller.
	 */
	onProgress?: () => void;

	private requesting = false;
	private pumping = false;
	private tokenMintedAt = Date.now();
	/** Reactive SP=3 re-mint in flight (guards against a mint storm). */
	private isReMinting = false;
	/** Last reactive re-mint attempt (cooldown gate). */
	private lastReMintAt = 0;
	// The integrity token TTL is 12h (GenerateIT returns ttl=43200), so a
	// content-bound PO token does NOT expire in ~60s. Swapping the token
	// mid-stream makes the server reject the new one (StreamProtectionStatus 3),
	// so refresh is disabled by default; set YTJS_SABR_TOKEN_REFRESH_MS to
	// re-enable it for experiments.
	private static readonly TOKEN_REFRESH_MS = Number(process.env.YTJS_SABR_TOKEN_REFRESH_MS ?? 0);
	/**
	 * How far ahead of the current player time the relay keeps its buffer
	 * topped up. Mirrors dash.js's buffer target (stableBufferTime 12s,
	 * bufferTimeAtTopQuality 30s) so the relay's own readahead stays in
	 * lockstep with the player's scheduler instead of racing to the end.
	 */
	private static readonly READAHEAD_MS = Number(process.env.YTJS_SABR_READAHEAD_MS ?? 30000);
	/** Resolver for the parked (idle) pump loop, if it is parked. */
	private wake?: () => void;
	/** progressCounter snapshot from the last pump round (stall detection). */
	private lastProgressCounter = 0;
	/** Number of buffered segments at the last pump round (stall detection). */
	private lastSegmentCount = 0;
	/** Consecutive pump rounds without any new segment. */
	private stallRounds = 0;
	/**
	 * Consecutive no-progress rounds required before the pump parks. SABR can
	 * answer across multiple round-trips, so a single duplicate-only round is
	 * not proof that the read-ahead window is exhausted.
	 */
	private static readonly STALL_ROUNDS_BEFORE_PARK = 2;

	constructor(
		public sabrUrl: string,
		public ustreamerConfig: Buffer,
		public formats: SabrInputFormat[],
		private poToken: Buffer,
		public videoId: string,
		private clientInfo: SabrClientInfo,
		/** Re-mint a content-bound PO token; the server cuts the stream (status
		 * 3) once the ~60s token lifetime lapses. */
		private tokenMinter?: () => Promise<{ poToken: Buffer; visitorData?: string } | undefined>,
		/** Extra HTTP headers captured from a real browser (merged over the
		 * hardcoded set; use "" to delete a default). */
		public headerOverrides?: Record<string, string>,
		/** Force a specific cpn (browser-captured replay experiments). */
		public forcedCpn?: string,
	) {
		// A newly registered waiter is explicit demand: wake the parked pump so
		// it re-evaluates needsData() and keeps fetching until that segment
		// arrives (PipePipe's awaitSegment semantics).
		const onDemand = () => this.releaseWake();
		this.video.onDemand = onDemand;
		this.audio.onDemand = onDemand;
	}

	private async maybeRefreshToken() {
		if (!this.tokenMinter) return;
		if (SabrStream.TOKEN_REFRESH_MS <= 0) return;
		if (Date.now() - this.tokenMintedAt < SabrStream.TOKEN_REFRESH_MS) return;
		const minted = await this.tokenMinter();
		if (minted?.poToken?.length) {
			this.poToken = minted.poToken;
			this.tokenMintedAt = Date.now();
			console.log(`[sabr] refreshed poToken (${this.poToken.length}b)`);
		}
	}

	/** Start the background request pump. Safe to call more than once. */
	start() {
		if (this.pumping) return;
		this.pumping = true;
		void this.pumpLoop();
	}

	stop() {
		this.dead = true;
		this.deadAt = Date.now();
		this.releaseWake();
	}

	/**
	 * Drive the session to completion and return concatenated init + all
	 * segments for both tracks.
	 *
	 * The SABR server doles out a bounded read-ahead window anchored to
	 * `player_time_ms` (client_abr_state field 28). A download has no player
	 * clock feeding it, so the driver must advance that field itself: after each
	 * round it reports the contiguous buffered END as the player time, which is
	 * exactly what a real client does as its buffer fills. Pinning the value at 0
	 * makes the server re-send the same first window forever (identical byte
	 * counts, no new segments).
	 *
	 * Advance by the MIN of both tracks so neither outruns the other and leaves a
	 * gap — `bufferedEndMs()` stops at the first hole, so a gap would freeze the
	 * reported position permanently.
	 *
	 * Completion is judged by `endOfStreamReached` when the server sends
	 * FORMAT_INITIALIZATION_METADATA (part 42), and otherwise by contiguous
	 * coverage reaching the format's advertised duration — some SABR responses
	 * never carry part 42, so `endSegmentNumber` stays undefined.
	 *
	 * Does NOT call stop(): the caller owns the session lifecycle.
	 *
	 * `sharedWithPlayer` only softens the polling cadence; the min-buffered-end
	 * target keeps the window adjacent to what the player is about to need, so
	 * advancing is safe for a session the player also reads from.
	 */
	async downloadToCompletion(
		timeoutMs = Number(process.env.YTJS_SABR_DOWNLOAD_TIMEOUT_MS ?? 900_000),
		sharedWithPlayer = false,
	): Promise<{
		video: Buffer;
		audio: Buffer;
		videoItag: number;
		audioItag: number;
	}> {
		if (!this.pumping) this.start();
		const deadline = Date.now() + timeoutMs;

		// 1) Init segments. Deliberately NOT waiting for endSegmentNumber here:
		//    it comes from FORMAT_INITIALIZATION_METADATA, which some sessions
		//    never send — waiting on it deadlocks the download.
		this.nudge(0);
		while ((!this.video.ready || !this.audio.ready) && !this.dead) {
			if (Date.now() > deadline) throw new Error("sabr download: init timeout");
			this.nudge(this.lastPlayerTimeMs);
			await new Promise((r) => setTimeout(r, 200));
		}
		if (this.dead) throw new Error("sabr download: stream died before init");

		// 2) Full duration, for the fallback completion test. The sidx-derived
		//    timeline (from the init segment) is authoritative when present;
		//    format approxDurationMs and part-42 endTimeMs are the fallbacks.
		const timelineMs = (m: SabrMedia) =>
			m.segmentTimeline?.reduce((sum, e) => sum + e.durationMs, 0) ?? 0;
		const totalMs = Math.max(
			this.currentVideoFormat()?.approxDurationMs ?? 0,
			this.currentAudioFormat()?.approxDurationMs ?? 0,
			this.video.endTimeMs ?? 0,
			this.audio.endTimeMs ?? 0,
			timelineMs(this.video),
			timelineMs(this.audio),
		);
		const covered = (m: SabrMedia) => m.contiguousEndMs();
		const complete = (): boolean => {
			if (this.video.endOfStreamReached && this.audio.endOfStreamReached) return true;
			if (totalMs <= 0) return false;
			return covered(this.video) >= totalMs - 2000 && covered(this.audio) >= totalMs - 2000;
		};

		// 3) Advance player_time_ms to the contiguous buffered end until both
		//    tracks are done.
		const sleepMs = sharedWithPlayer ? 750 : 250;
		let lastCount = -1;
		let idleRounds = 0;
		let lastLogAt = 0;
		while (!this.dead) {
			if (complete()) break;
			if (Date.now() > deadline) {
				throw new Error(
					`sabr download: timeout at v=${Math.round(covered(this.video))}ms ` +
					`a=${Math.round(covered(this.audio))}ms of ${Math.round(totalMs)}ms`
				);
			}
			const next = Math.min(covered(this.video), covered(this.audio));
			// Never go backwards: the server treats a lower player_time_ms as a
			// seek and re-serves an earlier window.
			this.nudge(Math.max(next, this.lastPlayerTimeMs));

			const count = this.video.segments.size + this.audio.segments.size;
			if (count > lastCount) {
				lastCount = count;
				idleRounds = 0;
				if (Date.now() - lastLogAt >= 10_000) {
					lastLogAt = Date.now();
					const pct = totalMs > 0 ? Math.round((next / totalMs) * 100) : -1;
					console.log(
						`[sabr] download ${pct >= 0 ? pct + "% " : ""}` +
						`t=${Math.round(next)}ms/${Math.round(totalMs)}ms ` +
						`${this.video.segments.size}v/${this.audio.segments.size}a segments`
					);
				}
			} else if (++idleRounds >= 10) {
				// Ten consecutive rounds with no new segment: the server has
				// nothing else to give (or the remaining region is unavailable).
				console.warn(
					`[sabr] download stalled at ${Math.round(next)}ms ` +
					`(${this.video.segments.size}v/${this.audio.segments.size}a segments)`
				);
				break;
			}
			await new Promise((r) => setTimeout(r, sleepMs));
		}
		if (this.dead) throw new Error("sabr download: stream died before completion");

		// 4) Refuse a truncated result so the caller can fall back instead of
		//    saving a short file that still passes the codec check.
		const vCov = covered(this.video);
		const aCov = covered(this.audio);
		if (totalMs > 0 && !complete()) {
			throw new Error(
				`sabr download incomplete: v=${Math.round(vCov)}ms a=${Math.round(aCov)}ms ` +
				`of ${Math.round(totalMs)}ms`
			);
		}

		// 5) Concatenate init + segments in sequence order.
		const concat = (media: SabrMedia): Buffer => {
			const parts: Buffer[] = [];
			if (media.initSegment) parts.push(media.initSegment);
			for (const seq of media.availableSegments()) {
				const seg = media.segments.get(seq);
				if (seg) parts.push(seg.data);
			}
			return Buffer.concat(parts);
		};
		const result = {
			video: concat(this.video),
			audio: concat(this.audio),
			videoItag: this.video.itag,
			audioItag: this.audio.itag,
		};
		if (!result.video.length || !result.audio.length) {
			throw new Error("sabr download: empty track data");
		}
		return result;
	}

	/** Ask the pump to fetch now (e.g. a segment request found nothing buffered). */
	nudge(playerTimeMs = this.lastPlayerTimeMs) {
		this.lastPlayerTimeMs = playerTimeMs;
		// A new position is a fresh chance to make progress: don't let the
		// stall counter from the previous position trigger an immediate park.
		this.stallRounds = 0;
		console.log(`[sabr] nudge playerTimeMs=${Math.round(playerTimeMs)} wall=${Date.now() - this.playbackStartAt}ms`);
		this.releaseWake();
		if (!this.requesting && !this.dead) void this.pumpOnce(playerTimeMs);
	}

	/** Wake a parked pump loop (used by nudge/stop). */
	private releaseWake() {
		const w = this.wake;
		if (!w) return;
		this.wake = undefined;
		w();
	}

	/**
	 * Demand gate: true when there is outstanding demand we have not satisfied.
	 *
	 * Two signals, both required to be quiet:
	 *  - coverage: the buffer already covers the readahead window around the
	 *    current player time (or the track is fully buffered / at EOS);
	 *  - pending: nobody is waiting on a segment that has not arrived.
	 *
	 * The coverage check is time-based (real segment intervals), not sequence
	 * based: a nominal-duration mismatch used to make the window permanently
	 * "incomplete", so the pump kept running forever while paused.
	 */
	private needsData(): boolean {
		const ahead = SabrStream.READAHEAD_MS;
		const t = this.lastPlayerTimeMs;
		// An armed probe is explicit demand: the server can answer across several
		// rn round-trips, so a single fruitless response must not park the pump
		// and produce a false negative. Bounded by PROBE_MAX_ROUNDS.
		if (this.probeActive() && this.probeRounds < SabrStream.PROBE_MAX_ROUNDS) return true;
		if (this.hasPendingDemand()) return true;
		const videoDone = this.video.hasWindow(t, ahead);
		const audioDone = this.audio.hasWindow(t, ahead);
		return !(videoDone && audioDone);
	}

	/** Any track (video rendition or audio) has an unsatisfied waiter. */
	private hasPendingDemand(): boolean {
		if (this.audio.hasPendingDemand()) return true;
		// A seg-<itag>-N request waits on that rendition's own track, not on the
		// currently-served one, so every live video track counts as demand.
		for (const t of this.videoTracks.values()) {
			if (t.hasPendingDemand()) return true;
		}
		return this.video.hasPendingDemand();
	}

	/**
	 * True when the last pump round brought nothing NEW *twice in a row*.
	 *
	 * The SABR server's read-ahead window is bounded and grows slowly, so a
	 * paused player whose buffer is ahead of the playhead can otherwise keep
	 * the pump alive forever without ever satisfying the coverage gate. When
	 * the pump stops making progress we park and wait for an explicit
	 * nudge/pending demand.
	 *
	 * Counts newly buffered segments rather than raw parts received: the server
	 * happily re-sends the same segments on every request, so counting parts
	 * would never detect the stall.
	 *
	 * Two consecutive rounds are required: SABR legitimately answers across
	 * multiple round-trips, so a single duplicate-only round does not mean the
	 * window is exhausted.
	 */
	private stalled(): boolean {
		// While probing, "no new live segment" is expected (the server is serving
		// the probe rendition instead), so never park on that basis.
		if (this.probeActive() && this.probeRounds < SabrStream.PROBE_MAX_ROUNDS) return false;
		// Count segments across ALL video tracks: a rendition a switch just
		// brought in is progress even though the served track did not grow.
		let count = this.audio.segments.size;
		for (const t of this.videoTracks.values()) count += t.segments.size;
		if (this.videoTracks.size === 0) count += this.video.segments.size;
		const progressed = count > this.lastSegmentCount;
		this.lastSegmentCount = count;
		if (progressed) {
			this.stallRounds = 0;
			return false;
		}
		this.stallRounds++;
		return this.stallRounds >= SabrStream.STALL_ROUNDS_BEFORE_PARK;
	}

	/** Milliseconds since the session started — the value a real player reports
	 *  for elapsed_wall_time_ms / time_since_last_seek / time_since_last_action. */
	elapsedWallMs(): number {
		return Date.now() - this.playbackStartAt;
	}

	private async pumpLoop() {
		// Keep requesting until both streams can play (mirrors TRSabrStream's
		// "not enough data to start stream! requesting again..." retry, with
		// requestNumber > 10 / 15 as the give-up bound).
		while (!this.dead && (!this.video.ready || !this.audio.ready)) {
			await this.pumpOnce(0);
			if (this.dead) return;
			if (!this.video.ready || !this.audio.ready) {
				const wait = Math.max(0, this.backoffUntil - Date.now(), 250);
				await new Promise((r) => setTimeout(r, wait));
			}
			if (this.requestNumber > 15 && (!this.video.ready || !this.audio.ready)) {
				console.error("[sabr] gave up waiting for init segments");
				this.dead = true;
				return;
			}
		}
		// Steady state: only fetch while there is a gap in the readahead window.
		// When the player is caught up (or the stream is fully buffered / at
		// end-of-stream) the loop parks on a wake promise that nudge() resolves,
		// so a seek back into an unbuffered region restarts fetching without
		// hammering YouTube in the background.
		//
		// Note: reaching end-of-stream does NOT call stop() — the session stays
		// alive (with its cached segments) so seek-back replays instantly.
		while (!this.dead) {
			if (this.needsData()) {
				await this.pumpOnce(this.lastPlayerTimeMs);
				// If the round produced nothing new, the server's read-ahead
				// window is exhausted for this position. Park instead of
				// hammering the server in a loop (this is what kept the network
				// busy forever while the player was paused).
				if (this.stalled()) {
					if (this.hasPendingDemand()) {
						// Someone is genuinely waiting for a segment we do not have
						// yet: keep retrying (the server may answer later). The
						// pending waiter expires via PENDING_TTL_MS, so this cannot
						// spin forever.
						console.log(
							`[sabr] retrying: demand pending but no new media (wall=${Date.now() - this.playbackStartAt}ms)`
						);
						const wait = Math.max(0, this.backoffUntil - Date.now(), 1000);
						await new Promise((r) => setTimeout(r, wait));
						continue;
					}
					console.log(
						`[sabr] idle: no new media around t=${Math.round(this.lastPlayerTimeMs)}ms (wall=${Date.now() - this.playbackStartAt}ms)`
					);
					await this.park();
					continue;
				}
				const wait = Math.max(0, this.backoffUntil - Date.now(), 750);
				await new Promise((r) => setTimeout(r, wait));
			} else {
				console.log(
					`[sabr] idle: buffer complete around t=${Math.round(this.lastPlayerTimeMs)}ms (wall=${Date.now() - this.playbackStartAt}ms)`
				);
				await this.park();
			}
		}
	}

	/** Park the pump until nudge()/stop()/onDemand() wakes it. */
	private async park(): Promise<void> {
		await new Promise<void>((resolve) => {
			this.wake = resolve;
			// A stop()/nudge() may have happened between the check and here.
			if (this.dead) {
				this.wake = undefined;
				resolve();
			}
		});
	}

	/** Random per-session client playback nonce, like YouTube's `cpn`. */
	private cpn = Array.from({ length: 16 }, () =>
		"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"[
			Math.floor(Math.random() * 64)
		]
	).join("");

	private cpnForRequest(): string {
		return this.forcedCpn ?? this.cpn;
	}

	/**
	 * SABR endpoint URL for a request number. Verified against a live YouTube
	 * web-player capture: the request carries `sabr=1&rqh=1&...&c=WEB&cver=<v>`
	 * plus `cpn`, `rn` and `alr=yes`. `cver` must be the client's *current*
	 * version (a stale one is a plausible session-rejection cause).
	 */
	private requestUrl(): string {
		const url = new URL(this.sabrUrl);
		url.searchParams.set("alr", "yes");
		url.searchParams.set("rqh", "1");
		url.searchParams.set("cpn", this.cpnForRequest());
		url.searchParams.delete("cver");
		url.searchParams.set("cver", this.clientVersionForUrl());
		url.searchParams.set("rn", String(this.requestNumber));
		return url.toString();
	}

	private clientVersionForUrl(): string {
		return process.env.YTJS_SABR_CVER ?? this.clientInfo.clientVersion;
	}

	/**
	 * Default WEB-player POST headers (captured from a live Chromium SABR
	 * request), merged with any headerOverrides. An override value of ""
	 * removes the default header.
	 */
	private buildRequestHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			"content-type": "application/x-protobuf",
			// Match the real WEB player's cross-site POST headers exactly.
			// A missing Origin/Referer on a cross-site POST is a strong bot signal.
			"accept": "*/*",
			"accept-encoding": "gzip, deflate, br, zstd",
			"accept-language": "en-US,en;q=0.9",
			"origin": "https://www.youtube.com",
			"referer": "https://www.youtube.com/",
			"priority": "u=1, i",
			"sec-fetch-dest": "empty",
			"sec-fetch-mode": "cors",
			"sec-fetch-site": "cross-site",
			"sec-fetch-storage-access": "none",
			"sec-ch-ua": '"Chromium";v="155", "Not(A:Brand";v="24"',
			"sec-ch-ua-mobile": "?0",
			"sec-ch-ua-platform": '"Linux"',
			"sec-ch-ua-arch": '"x86"',
			"sec-ch-ua-bitness": '"64"',
			"sec-ch-ua-model": '""',
			"sec-ch-ua-platform-version": '""',
			"sec-ch-ua-full-version": '"155.0.8059.39"',
			"sec-ch-ua-full-version-list": '"Chromium";v="155.0.8059.39", "Not(A:Brand";v="24.0.0.0"',
			"sec-ch-ua-form-factors": '"Desktop"',
			"sec-ch-ua-wow64": "?0",
		};
		for (const [k, v] of Object.entries(this.headerOverrides ?? {})) {
			if (v === "") delete headers[k.toLowerCase()];
			else headers[k.toLowerCase()] = v;
		}
		return headers;
	}

	/** One SABR round-trip. */
	async pumpOnce(currentStreamTimeMs: number) {
		if (this.requesting || this.dead) return;
		this.requesting = true;
		try {
			await this.maybeRefreshToken();
			const url = this.requestUrl();
			this.requestNumber++;
			if (this.requestNumber === 1) {
				const params = new URL(this.sabrUrl).searchParams;
				console.log(
					`[sabr] url host=${new URL(this.sabrUrl).host} params=[${[...params.keys()].join(",")}]` +
					` poToken=${this.poToken.length}b ustreamerConfig=${this.ustreamerConfig.length}b` +
					` formats=${this.formats.map((f) => `${f.itag}${f.isAudio ? "a" : "v"}`).join(" ")}`
				);
			}
			const res = await fetch(url, {
				method: "POST",
				headers: this.buildRequestHeaders(),
				body: new Uint8Array(this.buildRequestBody(currentStreamTimeMs)),
			});
			if (!res.ok) {
				let detail = "";
				try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
				console.error(`[sabr] request failed: ${res.status} — ${detail}`);
				this.dead = true;
				return;
			}
			const body = Buffer.from(await res.arrayBuffer());
			const parts = parseUmp(body);
			if (this.probeActive()) this.probeRounds++;
			console.log(`[sabr] response ${res.status}, ${body.length} bytes, parts=[${parts.map((p) => `${p.type}:${p.data.length}`).join(",")}]`);
			for (const part of parts) {
				// Parts that only carry control signals are hex-dumped: on a format
				// flip these are where the server states its intent (see
				// handlePart's SABR_SEEK / USTREAMER_SELECTED_MEDIA_STREAM cases).
				const hexTypes: number[] = [
					UMP_PART_ID.PLAYBACK_START_POLICY,
					UMP_PART_ID.RELOAD_PLAYER_RESPONSE,
					UMP_PART_ID.NEXT_REQUEST_POLICY,
					UMP_PART_ID.SABR_ERROR,
					UMP_PART_ID.SABR_CONTEXT_UPDATE,
					UMP_PART_ID.SABR_CONTEXT_SENDING_POLICY,
					UMP_PART_ID.SABR_SEEK,
					UMP_PART_ID.USTREAMER_SELECTED_MEDIA_STREAM,
				];
				if (hexTypes.includes(part.type)) {
					console.log(`[sabr]   part ${part.type} hex=${part.data.toString("hex")}`);
				}
				this.handlePart(part);
			}
		} catch (e) {
			console.error("[sabr] pump error", e);
		} finally {
			this.requesting = false;
			try { this.onProgress?.(); } catch { /* ignore */ }
			// A nudge that arrived while we were in-flight was persisted to
			// lastPlayerTimeMs; honour it now instead of waiting for the next
			// steady-state tick (up to ~750ms).
			if (!this.dead && this.lastPlayerTimeMs !== currentStreamTimeMs) {
				void this.pumpOnce(this.lastPlayerTimeMs);
			}
		}
	}

	// --- request building (TRSabrStream.buildRequestBody) ---

	/**
	 * MediaCapabilities (client_abr_state field 38). Captured from a live WEB
	 * player: video codec capabilities (codec 8/4/2 with resolution/bitrate) and
	 * audio codecs (1=Opus, 3=AAC), plus an HDR bitmask. Omitting it entirely is
	 * a wire difference from a real client.
	 */
	private buildMediaCapabilities(): Buffer {
		// The server refuses a FormatId that exceeds the capabilities we declare
		// (SABR_ERROR sabr.no_video_selected) even when we explicitly ask for it.
		// The old hardcoded caps topped out at 1920x1080@24 / 4.35 Mbps, so a
		// 1080p60 format (itag 299, 6.4 Mbps) was rejected while 720p (itag 136,
		// 3.1 Mbps) was accepted. Declare the max of what we actually offer.
		const videos = this.formats.filter((f) => !f.isAudio);
		const maxHeight = Math.max(1080, ...videos.map((f) => f.height ?? 0));
		const maxWidth = Math.max(1920, ...videos.map((f) => f.width ?? 0));
		const maxFps = Math.max(24, ...videos.map((f) => f.fps ?? 0));
		const maxBitrate = Math.max(4349126, ...videos.map((f) => f.bandwidth ?? 0));
		const videoCaps = [8, 4, 2].map((codec) =>
			Buffer.concat([
				int32Field(1, codec),
				int32Field(2, 1),
				int32Field(3, maxHeight),
				int32Field(4, maxWidth),
				int32Field(11, maxFps),
				int32Field(12, maxBitrate),
				boolField(15, false),
			])
		);
		const audioCaps = [
			{ codec: 1, channels: 2 },
			{ codec: 3, channels: 2 },
		].map((c) =>
			Buffer.concat([
				int32Field(1, c.codec),
				int32Field(2, c.channels),
				int32Field(6, 0),
			])
		);
		const ladder = Buffer.concat([int32Field(1, 249), int32Field(1, 350)]);
		return Buffer.concat([
			...videoCaps.map((v) => bytesField(1, v)),
			...audioCaps.map((a) => bytesField(2, a)),
			bytesField(4, ladder),
			int32Field(5, 3),
		]);
	}

	private encodeFormatId(f: SabrInputFormat): Buffer {
		const parts: Buffer[] = [int32Field(1, f.itag)];
		const lmt = f.lastModified ? BigInt(f.lastModified) : 0n;
		parts.push(int64Field(2, lmt));
		// Only emit xtags when actually present — a zero-length string field
		// is a wire difference from omitting the field entirely (the real
		// player omits it; sabr.malformed_config candidate).
		if (f.xtags) {
			parts.push(stringField(3, f.xtags));
		}
		return Buffer.concat(parts);
	}

	private buildStreamerContext(): Buffer {
		// Match the real WEB player's ClientInfo wire shape (captured live):
		// field 1 = locale "en_US" (the current player sends it here, though the
		// TubeReplacer/FreeTube proto doesn't declare it), fields 16/17/18 =
		// client name/version/osName, and field 19 (os_version) is OMITTED when
		// empty — we used to send a zero-length field 19, a wire difference.
		const clientInfoParts: Buffer[] = [
			stringField(1, "en_US"),
			int32Field(16, this.clientInfo.clientName),
			stringField(17, this.clientInfo.clientVersion),
			stringField(18, this.clientInfo.osName),
		];
		if (this.clientInfo.osVersion) {
			clientInfoParts.push(stringField(19, this.clientInfo.osVersion));
		}
		if (this.clientInfo.acceptLanguage) {
			clientInfoParts.push(stringField(21, this.clientInfo.acceptLanguage));
		}
		if (this.clientInfo.acceptRegion) {
			clientInfoParts.push(stringField(22, this.clientInfo.acceptRegion));
		}
		const clientInfo = Buffer.concat(clientInfoParts);
		const ctx: Buffer[] = [
			bytesField(1, clientInfo),
			bytesField(2, this.poToken),
		];
		// Only echo the cookie once the server has actually given us one; sending
		// a zero-length field is a wire difference from a known-working client.
		if (this.playbackCookie && this.playbackCookie.length > 0) {
			ctx.push(bytesField(3, this.playbackCookie));
		}
		// StreamerContext.sabr_contexts (field 5) + unsent_sabr_contexts (field 6).
		// Mirrors FreeTube's prepareSabrContexts: active types are echoed
		// verbatim, known-but-inactive types go in unsent_sabr_contexts.
		for (const c of this.sabrContexts.values()) {
			if (this.activeSabrContextTypes.has(c.type)) {
				ctx.push(bytesField(5, c.raw));
			} else {
				ctx.push(int32Field(6, c.type));
			}
		}
		return Buffer.concat(ctx);
	}

	/** Millisecond height (px) of the video rendition this session is serving. */
	videoHeight(): number | undefined {
		return this.currentVideoFormat()?.height;
	}

	/** Itag the client has most recently asked for (undefined until a switch). */
	requestedItag(): number | undefined {
		return this.requestedVideoItag;
	}

	/** True while a switch is in flight (requested != served). */
	private switchPending(): boolean {
		if (this.requestedVideoItag === undefined) return false;
		return this.requestedVideoItag !== (this.servedVideoItag || this.video.itag);
	}

	/**
	 * The SabrMedia for a video itag, created lazily.
	 *
	 * Lazy creation matters for the route: the server sends FORMAT_INIT (part
	 * 42) and the init MEDIA_HEADER before any media for a rendition it is
	 * switching to, so the track must exist to receive those parts. waitForInit
	 * then parks on that track's onSegment(0) and is woken by setInitSegment.
	 */
	videoTrackFor(itag: number): SabrMedia {
		let t = this.videoTracks.get(itag);
		if (!t) {
			t = new SabrMedia();
			t.itag = itag;
			t.onDemand = () => this.releaseWake();
			this.videoTracks.set(itag, t);
		}
		return t;
	}

	/**
	 * Which track an incoming media part belongs to.
	 *
	 * Classification MUST come from the format list, not from comparing against
	 * `audio.itag`/`video.itag`: on the very first response both are still 0 (the
	 * playback cookie has not been decoded yet), so an equality test misfiles the
	 * audio parts as video renditions and pollutes `videoTracks` with the audio
	 * itag. Every itag we can be sent is in `formats` — the watch page supplied
	 * them, and `setVideoFormat` pushes any switch target it is missing.
	 */
	private classifyItag(itag: number): "audio" | "video" | undefined {
		const f = this.formats.find((x) => x.itag === itag);
		if (f) return f.isAudio ? "audio" : "video";
		// Unknown itag: fall back to whatever identity the session already has.
		if (itag === this.audio.itag) return "audio";
		if (itag === this.servedVideoItag || itag === this.requestedVideoItag) return "video";
		return undefined;
	}

	/** The track an itag maps to, or undefined if it is not a known rendition. */
	private mediaForItag(itag: number): SabrMedia | undefined {
		const kind = this.classifyItag(itag);
		if (kind === "audio") return this.audio;
		if (kind === "video") return this.videoTrackFor(itag);
		return undefined;
	}

	/**
	 * Make `itag` the rendition the server serves, and point `video` at its
	 * track. Called from the cookie decode and FORMAT_INITIALIZATION_METADATA —
	 * i.e. only once the SERVER says it is serving this itag, never on request.
	 */
	private confirmServed(itag: number): void {
		if (!itag) return;
		const t = this.videoTrackFor(itag);
		const prev = this.servedVideoItag || this.video.itag;
		this.servedVideoItag = itag;
		if (this.video !== t) {
			this.video.onDemand = undefined;
			this.video = t;
		}
		if (prev !== itag) {
			console.log(
				`[sabr] serving itag ${itag}` +
				(this.requestedVideoItag === itag ? " (switch confirmed)" : "")
			);
		}
	}

	/**
	 * Request a different video rendition mid-session.
	 *
	 * Wire shape: the target goes in preferred_video_format_ids (17) ONLY.
	 * Listing it in initialization_format_ids (2) tells the server its init is
	 * already held, and the init is then withheld. The live itag stays in field 2
	 * and is reported as last_video_itag (22).
	 *
	 * `source` only affects logging: a "user" switch is sticky (no auto-disarm),
	 * a "probe" switch is observed and then cancelled by its caller.
	 *
	 * Returns false when the itag is not in this session's format list — the
	 * server would reject it with sabr.no_video_selected.
	 */
	setVideoFormat(itag: number, source: "user" | "probe" = "user"): boolean {
		const fmt = this.formats.find((f) => !f.isAudio && f.itag === itag);
		if (!fmt) {
			console.warn(`[sabr] setVideoFormat: itag ${itag} not in session formats`);
			return false;
		}
		const served = this.servedVideoItag || this.video.itag;
		if (itag === served && this.requestedVideoItag === undefined) {
			// Already streaming this rendition — nothing to do.
			return true;
		}
		this.requestedVideoItag = itag;
		this.lastFormatSwitchAt = Date.now();
		console.log(
			`[sabr] format switch (${source}): ${served || "?"} -> ${itag} ` +
			`(${fmt.width}x${fmt.height} ${fmt.codecs})`
		);
		// Wake the pump so the next rn carries the new preferred set at once.
		this.releaseWake();
		if (!this.requesting && !this.dead) void this.pumpOnce(this.lastPlayerTimeMs);
		return true;
	}

	/** Read-only view of the probe bucket (diagnostics). */
	get probeState() {
		return this.probe;
	}

	/** The live video track's sidx timeline (diagnostics). */
	get videoTimeline() {
		return this.video.segmentTimeline;
	}

	/**
	 * Arm a switch while capturing what the server serves for the target
	 * rendition into a separate bucket.
	 *
	 * This delegates to the real switch path (`setVideoFormat`) — it is not a
	 * separate wire experiment, just the production path with an observation
	 * bucket attached, so probing exercises exactly what a user switch does.
	 */
	probeFormatSwitch(targetItag: number, formats: SabrInputFormat[], ttlMs = 60_000): void {
		const fmt =
			this.formats.find((f) => !f.isAudio && f.itag === targetItag) ??
			formats.find((f) => !f.isAudio && f.itag === targetItag);
		if (!fmt) throw new Error(`itag ${targetItag} not available`);
		// encodeFormatId needs lastModified/xtags, so the format must be known.
		if (!this.formats.some((f) => f.itag === targetItag)) this.formats.push(fmt);
		this.probe = {
			active: true,
			targetItag,
			segments: new Map(),
			segmentTiming: new Map(),
			sawSeek: false,
			armedAt: Date.now(),
			expiresAt: Date.now() + ttlMs,
		};
		this.probeFormat = fmt;
		this.probeRounds = 0;
		console.log(
			`[sabr:probe] armed switch -> itag ${targetItag} ` +
			`(${fmt.codecs} ${fmt.width}x${fmt.height} fps=${fmt.fps} bw=${fmt.bandwidth}) ` +
			`live=${this.video.itag} ttl=${ttlMs}ms`
		);
		this.setVideoFormat(targetItag, "probe");
	}

	/**
	 * Disarm the probe. User switches are sticky, so this only clears the
	 * observation bucket and reverts the request to the served rendition — it
	 * does not cancel a user-initiated switch.
	 */
	probeCancel(reason = "manual"): void {
		if (!this.probe.active) return;
		console.log(`[sabr:probe] cancelled (${reason}) target=${this.probe.targetItag}`);
		this.probe.active = false;
		this.probeFormat = undefined;
		// Restore the wire to the served rendition only (unless the server has
		// already confirmed the target, in which case there is nothing to undo).
		this.requestedVideoItag = this.servedVideoItag || this.video.itag || undefined;
		this.releaseWake();
	}

	/** True when the probe is armed and has not expired. */
	private probeActive(): boolean {
		if (!this.probe.active) return false;
		if (Date.now() > this.probe.expiresAt) {
			console.log(`[sabr:probe] expired target=${this.probe.targetItag}`);
			this.probe.active = false;
			this.probeFormat = undefined;
			return false;
		}
		return true;
	}

	/**
	 * The format whose FormatId goes into fields 2/17 as the BASE (served)
	 * rendition. Before the first cookie decode `video.itag` is still 0, so fall
	 * back to the requested rendition — otherwise the very first request would
	 * omit the video FormatId entirely and the server answers with an error.
	 */
	private currentVideoFormat(): SabrInputFormat | undefined {
		return (
			this.formats.find((f) => !f.isAudio && f.itag === (this.servedVideoItag || this.video.itag)) ??
			this.formats.find((f) => !f.isAudio && f.itag === this.requestedVideoItag) ??
			this.formats.find((f) => !f.isAudio)
		);
	}

	/** The single audio format we're currently requesting. */
	private currentAudioFormat(): SabrInputFormat | undefined {
		return (
			this.formats.find((f) => f.isAudio && f.itag === this.audio.itag) ??
			this.formats.find((f) => f.isAudio)
		);
	}

	/**
	 * googlevideo-style BufferedRange for one track: the full contiguous range
	 * from seq 1 (real start/duration ms, start+end segment indexes, and a
	 * time_range ticks submessage). The previous version reported
	 * start_time_ms=0 with start==end==lastSeq — a one-segment range at t=0,
	 * which is worse than sending nothing. Default-on; set
	 * YTJS_SABR_BUFFERED_RANGES=0 to disable.
	 */
	private encodeBufferedRange(fmt: SabrInputFormat | undefined, media: SabrMedia): Buffer | undefined {
		if (!fmt) return undefined;
		const seqs = media.availableSegments();
		if (!seqs.length || seqs[0] !== 1) return undefined;
		let startMs: number | undefined;
		let endMs = 0;
		let endSeq = seqs[0];
		for (const s of seqs) {
			const seg = media.segments.get(s)!;
			if (seg.startMs === undefined || seg.durationMs === undefined) break;
			if (startMs === undefined) startMs = seg.startMs;
			if (seg.startMs > endMs + 1) break; // gap
			endMs = Math.max(endMs, seg.startMs + seg.durationMs);
			endSeq = s;
		}
		if (startMs === undefined) return undefined;
		const dur = Math.round(endMs - startMs);
		// time_range (field 6): ticks at timescale 1000 == ms (googlevideo shape)
		const timeRange = Buffer.concat([
			int64Field(1, Math.round(startMs)),
			int64Field(2, dur),
			int32Field(3, 1000),
		]);
		return Buffer.concat([
			bytesField(1, this.encodeFormatId(fmt)),
			int64Field(2, Math.round(startMs)), // start_time_ms
			int64Field(3, dur), // duration_ms
			int32Field(4, seqs[0]), // start_segment_index
			int32Field(5, endSeq), // end_segment_index
			bytesField(6, timeRange),
		]);
	}

	private buildClientAbrState(currentStreamTimeMs: number): Buffer {
		// A real player reports the same elapsed wall time for all three of
		// these; googlevideo does the same, and it's what makes the server's
		// nextRequestPolicy targetReadaheadMs grow so it keeps sending.
		const elapsed = this.elapsedWallMs();
		// A switch in flight is a manual format selection: report a RECENT
		// selection and the target height as sticky, which is how a real client
		// says "the user picked this, stop ABR-ing". Without it the server may
		// substitute its own pick.
		const switched = this.switchPending();
		const switchHeight = switched
			? (this.formats.find((f) => !f.isAudio && f.itag === this.requestedVideoItag)?.height ?? 0)
			: 0;
		const parts: Buffer[] = [
			// field 13: time_since_last_manual_format_selection_ms (int64).
			// The live WEB capture showed 173636903198703 — epoch-µs magnitude,
			// i.e. the "never manually selected" sentinel. A real manual selection
			// sends a small elapsed value instead.
			int64Field(
				13,
				switched
					? BigInt(Math.max(1, Date.now() - this.lastFormatSwitchAt))
					: BigInt(Date.now()) * 1000n
			),
			// field 14: last_manual_direction (sint32, zigzag-encoded). The
			// capture showed raw varint 2 = direction 1. Passing the raw
			// captured varint is wire-identical to a proper sint32 encode.
			// NOTE: verified working for a step DOWN (itag 137 -> 134); the
			// up/down semantics of this field remain unconfirmed.
			int32Field(14, 2),
			int32Field(18, 1280), // client_viewport_width
			int32Field(19, 720), // client_viewport_height
			int32Field(21, switched ? switchHeight : 0), // sticky_resolution
			boolField(22, false), // client_viewport_is_flexible
			int64Field(23, this.bandwidthEstimate), // bandwidth_estimate
			int64Field(28, currentStreamTimeMs), // player_time_ms
			int64Field(29, elapsed), // time_since_last_seek
			int32Field(34, 1), // visibility
			fixed32Field(35, 1.0), // playback_rate
			int64Field(36, elapsed), // elapsed_wall_time_ms
			// bytesField(38, this.buildMediaCapabilities()), // media_capabilities
			int64Field(39, elapsed), // time_since_last_action_ms
			// enabled_track_types_bitfield: a real WEB client sends 3 (video|audio
			// enabled). Sending 0 tells the server no track is enabled, which is a
			// plausible reason it stops doling out media after the initial window.
			int32Field(40, 3), // enabled_track_types_bitfield (video|audio)
			int64Field(44, 0), // player_state
			boolField(46, true), // drc_enabled (stable volume)
			int64Field(57, 73), // field57 (observed)
			boolField(58, false), // prefer_vp9
			int32Field(59, 1080), // av1_quality_threshold
			int64Field(68, 0), // sabr_force_max_network_interruption_duration_ms
			int32Field(71, 1), // field71 (observed)
			boolField(76, false), // enable_voice_boost
			boolField(80, true), // field80 (observed)
			boolField(85, true), // field85 (observed)
		];
		return Buffer.concat(parts);
	}

	buildRequestBody(currentStreamTimeMs: number): Buffer {
		const videoFormat = this.currentVideoFormat();
		const audioFormat = this.currentAudioFormat();
		// One FormatId per list, mirroring FreeTube's per-segment request shape.
		// (FreeTube always supplies a video FormatId even for audio-only requests,
		// otherwise the server returns an error response.)
		const videoId = videoFormat ? this.encodeFormatId(videoFormat) : undefined;
		const audioId = audioFormat ? this.encodeFormatId(audioFormat) : undefined;
		const isInit = currentStreamTimeMs === 0 && !this.video.ready && !this.audio.ready;
		// The rendition we are asking the server to switch TO. It travels in
		// preferred_video_format_ids (17) only — never in field 2.
		const targetFormat = this.switchPending()
			? this.formats.find((f) => !f.isAudio && f.itag === this.requestedVideoItag)
			: undefined;
		const targetId = targetFormat ? this.encodeFormatId(targetFormat) : undefined;

		const parts: Buffer[] = [bytesField(1, this.buildClientAbrState(currentStreamTimeMs))];
		// field 2 = INITIALIZATION_FORMAT_IDS — formats whose init segment we
		// ALREADY hold, i.e. "do not send me this init again". It is NOT
		// selected_format_ids (the wire-equivalent of "selected" is 16/17).
		//
		// Keeping only the live itags here is what makes a rendition switch
		// fetchable: listing the target itag in field 2 told the server it was
		// already initialized, so it (correctly) withheld that rendition's init
		// segment — the switch then delivered media with no init to append it to.
		//
		// Empty on the very first request, which is right for the right reason:
		// nothing is initialized yet, so every needed init must be sent.
		if (!isInit && videoId && audioId) {
			parts.push(bytesField(2, videoId));
			parts.push(bytesField(2, audioId));
		}
		parts.push(bytesField(5, this.ustreamerConfig));
		// buffered_ranges (field 3): report the real contiguous buffered range so
		// the server can advance the window without trusting player_time_ms
		// alone. NOTE: measured to REGRESS (status-3 count 13 vs 7 with it off),
		// so it stays opt-in via YTJS_SABR_BUFFERED_RANGES=1.
		if (process.env.YTJS_SABR_BUFFERED_RANGES === "1") {
			// Per-track ranges: each rendition's buffered range is reported under
			// its own FormatId, so a switched-to rendition does not claim the old
			// one's buffer.
			for (const [itag, media] of this.videoTracks) {
				const fmt = this.formats.find((f) => !f.isAudio && f.itag === itag);
				const vr = this.encodeBufferedRange(fmt, media);
				if (vr) parts.push(bytesField(3, vr));
			}
			const ar = this.encodeBufferedRange(audioFormat, this.audio);
			if (ar) parts.push(bytesField(3, ar));
		}
		// preferred_video_format_ids (17): listing both the live and the target
		// rendition is what drives a mid-session switch — the server substitutes
		// on this field alone.
		if (videoId) parts.push(bytesField(17, videoId));
		if (targetId) parts.push(bytesField(17, targetId)); // preferred_video_format_ids
		if (audioId) parts.push(bytesField(16, audioId)); // preferred_audio_format_ids
		// last_video_itag (22): the honest "I am switching away from this
		// rendition" signal. Only sent while a switch is in flight so steady
		// state keeps its exact previous wire shape.
		if (targetId && this.video.itag) {
			parts.push(int32Field(22, this.video.itag));
		}
		parts.push(bytesField(19, this.buildStreamerContext()));
		const body = Buffer.concat(parts);
		if (process.env.BG_CENSUS === "1") {
			censusLog({ type: "abr-request", rn: this.requestNumber, bytes: body.length, hex: body.toString("hex") });
		}
		return body;
	}

	// --- response part handling (TRSabrStream+PartHandler) ---

	private parsingHeaders = new Map<number, { headerId: number; itag: number; isInitSeg: boolean; sequenceNumber: number; startMs?: number; durationMs?: number }>();
	private parsingDatas = new Map<number, Buffer[]>();

	private handlePart(part: UmpPart) {
		switch (part.type) {
			case UMP_PART_ID.STREAM_PROTECTION_STATUS: {
				const f = decodeFields(part.data);
				const status = Number(getVarint(f, 1) ?? 0);
				const maxRetries = getVarint(f, 2);
				console.log(`[sabr] stream protection status: ${status}${maxRetries !== undefined ? ` maxRetries=${maxRetries}` : ""} (poToken=${this.poToken.length}b, age=${Math.round((Date.now() - this.tokenMintedAt) / 1000)}s)`);
				if (status === 3) {
					// The server rejected the current (empty/aged) token. Re-mint
					// reactively and continue instead of killing the stream — this
					// fixes both the playback relay and the SABR archive download
					// stalling mid-way. Only one mint at a time, with a cooldown so
					// a rejected mint cannot loop.
					if (this.tokenMinter && !this.isReMinting && Date.now() - this.lastReMintAt > 5000) {
						this.isReMinting = true;
						this.lastReMintAt = Date.now();
						void (async () => {
							try {
								const minted = await this.tokenMinter!();
								if (minted?.poToken?.length) {
									this.poToken = minted.poToken;
									this.tokenMintedAt = Date.now();
									console.log(`[sabr] SP=3 re-mint ok (${this.poToken.length}b), continuing`);
									this.releaseWake();
								} else {
									console.error("[sabr] SP=3 re-mint returned empty token, stopping");
									this.stop();
								}
							} catch (e) {
								console.error("[sabr] SP=3 re-mint failed, stopping", e);
								this.stop();
							} finally {
								this.isReMinting = false;
							}
						})();
					} else if (!this.tokenMinter) {
						this.stop(); // no way to recover
					}
				}
				break;
			}
			case UMP_PART_ID.NEXT_REQUEST_POLICY: {
				const f = decodeFields(part.data);
				const cookie = getBytes(f, 7);
				const backoff = getVarint(f, 4);
				if (cookie) {
					this.playbackCookie = Buffer.from(cookie);
					// Decode on EVERY response, not just the first: the server can
					// substitute a different rendition mid-session, and a silent
					// substitution is what makes a format flip look like it failed.
					const cf = decodeFields(cookie);
					const vfmt = getBytes(cf, 7);
					const afmt = getBytes(cf, 8);
					const vItag = vfmt ? Number(getVarint(decodeFields(vfmt), 1) ?? 0) : 0;
					const aItag = afmt ? Number(getVarint(decodeFields(afmt), 1) ?? 0) : 0;
					if (vItag && this.probeActive() && vItag !== this.probe.targetItag) {
						console.log(
							`[sabr:probe] cookie says video=${vItag} but probe asked ` +
							`${this.probe.targetItag} (server substituted)`
						);
					}
					if (aItag && !this.audio.itag) this.audio.itag = aItag;
					if (vItag) {
						// The cookie is authoritative for "what is the server serving".
						// First pick, a confirmed switch, and a silent substitution all
						// land here; `servedVideoItag` lags a request, so a switch's
						// target is only adopted once the server says so.
						const wasServed = this.servedVideoItag || this.video.itag;
						if (vItag !== wasServed) {
							console.log(`[sabr] cookie: served video ${wasServed || "?"} -> ${vItag}`);
						}
						this.confirmServed(vItag);
						if (wasServed === 0) {
							console.log(`[sabr] server picked itags: video=${this.video.itag} audio=${this.audio.itag}`);
						}
					}
				}
				if (backoff !== undefined) this.backoffUntil = Date.now() + Number(backoff);
				break;
			}
			case UMP_PART_ID.SABR_REDIRECT: {
				const url = getString(decodeFields(part.data), 1);
				if (url) {
					console.log("[sabr] redirecting to a new stream URL");
					this.sabrUrl = url;
				}
				break;
			}
			case UMP_PART_ID.SABR_ERROR: {
				const f = decodeFields(part.data);
				const type = getString(f, 1) ?? "?";
				const code = getVarint(f, 2) ?? 0n;
				console.error(`[sabr] SABR_ERROR type=${type} code=${code} — declaring stream bad`);
				this.stop();
				break;
			}
			case UMP_PART_ID.RELOAD_PLAYER_RESPONSE: {
				// FreeTube treats this as a full session reload. Marking dead lets
				// getSession's reap path build a fresh stream on the next request.
				// (If this proves too aggressive, revert just this hunk — the reap
				// path makes it safe either way.)
				console.log("[sabr] RELOAD_PLAYER_RESPONSE — marking stream dead for rebuild");
				this.stop();
				break;
			}
			case UMP_PART_ID.SABR_CONTEXT_UPDATE: {
				// SabrContextUpdate: type=1, scope=2, value=3, send_by_default=4,
				// write_policy=5 (KEEP_EXISTING=2). Store the raw part verbatim so
				// we echo it back byte-for-byte (no re-encode mismatches).
				const f = decodeFields(part.data);
				const type = getVarint(f, 1);
				const value = getBytes(f, 3);
				const sendByDefault = (getVarint(f, 4) ?? 0n) !== 0n;
				const writePolicy = Number(getVarint(f, 5) ?? 0);
				if (type !== undefined && value?.length) {
					const t = Number(type);
					if (writePolicy === 2 && this.sabrContexts.has(t)) break;
					this.sabrContexts.set(t, { raw: Buffer.from(part.data), type: t, sendByDefault });
					if (sendByDefault) this.activeSabrContextTypes.add(t);
					console.log(`[sabr] SABR_CONTEXT_UPDATE type=${t} sendByDefault=${sendByDefault} writePolicy=${writePolicy}`);
				}
				break;
			}
			case UMP_PART_ID.SABR_CONTEXT_SENDING_POLICY: {
				const f = decodeFields(part.data);
				const start = getPackedVarints(f, 1);
				const stop = getPackedVarints(f, 2);
				const discard = getPackedVarints(f, 3);
				for (const t of start) this.activeSabrContextTypes.add(t);
				for (const t of stop) this.activeSabrContextTypes.delete(t);
				for (const t of discard) {
					this.sabrContexts.delete(t);
					this.activeSabrContextTypes.delete(t);
				}
				console.log(`[sabr] SABR_CONTEXT_SENDING_POLICY start=${start} stop=${stop} discard=${discard}`);
				break;
			}
			case UMP_PART_ID.MEDIA_HEADER: {
				const h = this.readMediaHeader(part.data);
				if (h.isInitSeg) {
					// Skip an init we already hold for that rendition — but only for
					// the rendition's OWN track. A switch target has no init yet, so
					// its init header must be collected.
					if (this.mediaForItag(h.itag)?.ready) break;
					if (this.probeActive() && h.itag === this.probe.targetItag) {
						console.log(`[sabr:probe] init arriving for probe itag ${h.itag}`);
					}
				}
				this.parsingHeaders.set(h.headerId, h);
				this.parsingDatas.set(h.headerId, []);
				break;
			}
			case UMP_PART_ID.MEDIA: {
				if (part.data.length < 1) break;
				const headerId = part.data[0];
				const chunks = this.parsingDatas.get(headerId);
				if (chunks) chunks.push(Buffer.from(part.data.subarray(1)));
				break;
			}
			case UMP_PART_ID.MEDIA_END: {
				if (part.data.length < 1) break;
				const headerId = part.data[0];
				const header = this.parsingHeaders.get(headerId);
				const chunks = this.parsingDatas.get(headerId);
				this.parsingHeaders.delete(headerId);
				this.parsingDatas.delete(headerId);
				if (!header || !chunks) break;
				const data = Buffer.concat(chunks);
				// While a probe is armed, capture the target rendition into its own
				// bucket instead of the real track: an observation must not disturb
				// what the player is currently reading.
				if (this.probeActive() && header.itag === this.probe.targetItag) {
					if (header.isInitSeg) {
						this.probe.init = data;
						const parsed = parseInitSegment(data);
						if (parsed.segmentTimeline?.length) {
							this.probe.timeline = parsed.segmentTimeline;
						}
						console.log(
							`[sabr:probe] captured INIT itag=${header.itag} ${data.length}b ` +
							`timescale=${parsed.timescale ?? "?"} timelineEntries=${parsed.segmentTimeline?.length ?? 0}`
						);
					} else {
						this.probe.segments.set(header.sequenceNumber, data);
						this.probe.segmentTiming.set(header.sequenceNumber, {
							startMs: header.startMs,
							durationMs: header.durationMs,
						});
						console.log(
							`[sabr:probe] captured SEG ${header.sequenceNumber} itag=${header.itag} ` +
							`${data.length}b start=${header.startMs ?? "?"} dur=${header.durationMs ?? "?"}`
						);
					}
					this.progressCounter++;
					break;
				}
				const media = this.mediaForItag(header.itag);
				if (!media) {
					console.log(
						`[sabr] unrouted part: itag=${header.itag} seq=${header.sequenceNumber} ` +
						`init=${header.isInitSeg} ${data.length}b`
					);
					break;
				}
				if (header.isInitSeg) {
					media.setInitSegment(data);
				} else {
					// Parse the fragment's own moof/tfdt timing so we can compare the
					// SegmentTemplate's $Number$ position against the real decode time
					// (drift diagnostic; see waitForSegment).
					const timing = getFragmentTiming(data);
					media.addSegment(header.sequenceNumber, {
						data,
						durationMs: header.durationMs,
						startMs: header.startMs,
						baseDecodeTimeTicks: timing.baseDecodeTimeTicks,
						durationTicks: timing.durationTicks,
					});
				}
				this.progressCounter++;
				break;
			}
			case UMP_PART_ID.FORMAT_INITIALIZATION_METADATA: {
				const f = decodeFields(part.data);
				const fmt = getBytes(f, 2);
				const itag = fmt ? Number(getVarint(decodeFields(fmt), 1) ?? 0) : 0;
				const endTime = getVarint(f, 3);
				const endSeg = getVarint(f, 4);
				const media = this.mediaForItag(itag);
				if (media) {
					if (endSeg !== undefined) media.endSegmentNumber = Number(endSeg);
					if (endTime !== undefined) media.endTimeMs = Number(endTime);
					// The server is announcing this rendition: it is (or is about to
					// be) the served one. This is the primary confirmation signal
					// alongside the playback cookie. Adopted only when it is the
					// first pick, already the served rendition, or the target we
					// actually asked for — so a stray announcement for some other
					// rendition cannot flip the live track.
					if (
						this.classifyItag(itag) === "video" &&
						itag &&
						(this.servedVideoItag === 0 || itag === this.video.itag || itag === this.requestedVideoItag)
					) {
						this.confirmServed(itag);
					}
				} else {
					// On a format flip this is the server's rendition announcement, so
					// log it instead of dropping it.
					console.log(
						`[sabr:probe] FORMAT_INIT unknown itag=${itag} ` +
						`endSeg=${endSeg ?? "?"} endTime=${endTime ?? "?"} ` +
						`hex=${part.data.toString("hex").slice(0, 128)}`
					);
					if (this.probeActive() && itag === this.probe.targetItag) {
						if (endSeg !== undefined) this.probe.endSeg = Number(endSeg);
						if (endTime !== undefined) this.probe.endTime = Number(endTime);
					}
				}
				break;
			}
			case UMP_PART_ID.SABR_SEEK: {
				// Part 45. A real player re-anchors its buffer position here; smjs
				// ignores it, and only records that it was seen so a format switch
				// can be checked for provoking one.
				console.log(`[sabr:probe] SABR_SEEK ${part.data.length}b hex=${part.data.toString("hex")}`);
				if (this.probe.active) this.probe.sawSeek = true;
				break;
			}
			case UMP_PART_ID.USTREAMER_SELECTED_MEDIA_STREAM: {
				// Part 38 — most likely the server telling us which rendition it
				// actually selected. Decode the FormatIds (field 1 = video, field 2 =
				// audio) and log the raw bytes either way so the shape can be
				// corrected from a real capture.
				const f = decodeFields(part.data);
				const vfmt = getBytes(f, 1);
				const afmt = getBytes(f, 2);
				const readItag = (b?: Buffer): number => {
					if (!b) return 0;
					const inner = getBytes(decodeFields(b), 1);
					const target = inner ?? b;
					return Number(getVarint(decodeFields(target), 1) ?? 0);
				};
				console.log(
					`[sabr:probe] SELECTED_MEDIA_STREAM videoItag=${readItag(vfmt)} ` +
					`audioItag=${readItag(afmt)} ${part.data.length}b hex=${part.data.toString("hex").slice(0, 128)}`
				);
				break;
			}
			default: {
				// Temporary: log any other unknown part so nothing the server sends
				// during a format flip is invisible. Remove once probing is done.
				if (!(Object.values(UMP_PART_ID) as number[]).includes(part.type)) {
					console.log(
						`[sabr:probe] UNKNOWN part id=${part.type} ${part.data.length}b ` +
						`hex=${part.data.toString("hex").slice(0, 256)}`
					);
				}
				break;
			}
		}
	}

	private readMediaHeader(data: Buffer) {
		const f = decodeFields(data);
		const startMsRaw = getVarint(f, 11);
		const durationMsRaw = getVarint(f, 12);
		// time_range (field 15): TimeRange{start_ticks=1, duration_ticks=2,
		// timescale=3}. Some headers carry timing ONLY here — googlevideo's
		// mediaTimeUtils falls back to ticks->ms (floor for start, ceil for
		// duration). Without this fallback startMs/durationMs are undefined and
		// the playhead collapses to ~0, so the server stops advancing the window.
		const tr = getBytes(f, 15);
		let startTicks: bigint | undefined;
		let durationTicks: bigint | undefined;
		let timescale: bigint | undefined;
		if (tr) {
			const tf = decodeFields(tr);
			startTicks = getVarint(tf, 1);
			durationTicks = getVarint(tf, 2);
			timescale = getVarint(tf, 3);
		}
		const scale = timescale !== undefined && timescale > 0n ? Number(timescale) : 0;
		const startMs =
			startMsRaw !== undefined && startMsRaw > 0n
				? Number(startMsRaw)
				: startTicks !== undefined && scale > 0
					? Math.floor((Number(startTicks) / scale) * 1000)
					: startMsRaw !== undefined
						? 0
						: undefined;
		const durationMs =
			durationMsRaw !== undefined && durationMsRaw > 0n
				? Number(durationMsRaw)
				: durationTicks !== undefined && scale > 0
					? Math.ceil((Number(durationTicks) / scale) * 1000)
					: undefined;
		if (process.env.BG_CENSUS === "1") {
			console.log(
				`[sabr] mediaheader seq=${Number(getVarint(f, 9) ?? 0)} raw11=${startMsRaw} raw12=${durationMsRaw} ` +
				`tr=${tr?.toString("hex") ?? "-"} -> start=${startMs} dur=${durationMs}`
			);
		}
		return {
			headerId: Number(getVarint(f, 1) ?? 0),
			itag: Number(getVarint(f, 3) ?? 0),
			isInitSeg: (getVarint(f, 8) ?? 0n) !== 0n,
			sequenceNumber: Number(getVarint(f, 9) ?? 0),
			startMs,
			durationMs,
		};
	}
}
