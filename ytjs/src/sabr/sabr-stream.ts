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
import { parseInitSegment } from "./mp4";
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
	/** sequence number (1-based, matching TubeReplacer) -> segment */
	segments = new Map<number, SabrSegment>();
	/** total number of segments, from FormatInitializationMetadata */
	endSegmentNumber?: number;
	/** end time in ms, from FormatInitializationMetadata */
	endTimeMs?: number;

	private pending = new Map<number, Array<() => void>>();

	/** Resolves once `seq` (or the init segment for seq 0) has arrived. */
	onSegment(seq: number): Promise<void> {
		if (seq === 0 && this.ready) return Promise.resolve();
		if (seq !== 0 && this.segments.has(seq)) return Promise.resolve();
		return new Promise((resolve) => {
			const arr = this.pending.get(seq) ?? [];
			arr.push(resolve);
			this.pending.set(seq, arr);
		});
	}

	private notify(seq: number) {
		const arr = this.pending.get(seq);
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
		this.initSegment = data;
		this.ready = true;
		this.notify(0);
	}

	addSegment(seq: number, segment: SabrSegment) {
		if (!this.segments.has(seq)) this.segments.set(seq, segment);
		this.notify(seq);
	}

	/** Contiguous, sorted list of available sequence numbers. */
	availableSegments(): number[] {
		return [...this.segments.keys()].sort((a, b) => a - b);
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
}

export class SabrStream {
	requestNumber = 0;
	private playbackCookie?: Buffer;
	private backoffUntil = 0;
	dead = false;
	bandwidthEstimate = 5_000_000;
	private playbackStartAt = Date.now();
	/** Server-issued SABR contexts (part 57), echoed per the sending policy (59). */
	private sabrContexts = new Map<number, { raw: Buffer; type: number; sendByDefault: boolean }>();
	private activeSabrContextTypes = new Set<number>();

	video = new SabrMedia();
	audio = new SabrMedia();
	/** Increments whenever new media arrived — used by wait loops. */
	progressCounter = 0;
	/** Last player time we told the server about, for readahead. */
	lastPlayerTimeMs = 0;
	/** When stop() was called (for post-mortem backoff in the session map). */
	deadAt?: number;

	private requesting = false;
	private pumping = false;
	private tokenMintedAt = Date.now();
	// The integrity token TTL is 12h (GenerateIT returns ttl=43200), so a
	// content-bound PO token does NOT expire in ~60s. Swapping the token
	// mid-stream makes the server reject the new one (StreamProtectionStatus 3),
	// so refresh is disabled by default; set YTJS_SABR_TOKEN_REFRESH_MS to
	// re-enable it for experiments.
	private static readonly TOKEN_REFRESH_MS = Number(process.env.YTJS_SABR_TOKEN_REFRESH_MS ?? 0);

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
	) {}

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
	}

	/** Ask the pump to fetch now (e.g. a segment request found nothing buffered). */
	nudge(playerTimeMs = this.lastPlayerTimeMs) {
		this.lastPlayerTimeMs = playerTimeMs;
		console.log(`[sabr] nudge playerTimeMs=${Math.round(playerTimeMs)} wall=${Date.now() - this.playbackStartAt}ms`);
		if (!this.requesting && !this.dead) void this.pumpOnce(playerTimeMs);
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
		// Steady state: top up periodically. Segment requests also call nudge().
		while (!this.dead) {
			const wait = Math.max(0, this.backoffUntil - Date.now(), 750);
			await new Promise((r) => setTimeout(r, wait));
			if (this.dead) return;
			await this.pumpOnce(this.lastPlayerTimeMs);
		}
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
			console.log(`[sabr] response ${res.status}, ${body.length} bytes, parts=[${parts.map((p) => `${p.type}:${p.data.length}`).join(",")}]`);
			for (const part of parts) {
				const hexTypes: number[] = [UMP_PART_ID.PLAYBACK_START_POLICY, UMP_PART_ID.RELOAD_PLAYER_RESPONSE, UMP_PART_ID.NEXT_REQUEST_POLICY, UMP_PART_ID.SABR_ERROR, UMP_PART_ID.SABR_CONTEXT_UPDATE, UMP_PART_ID.SABR_CONTEXT_SENDING_POLICY];
				if (hexTypes.includes(part.type)) {
					console.log(`[sabr]   part ${part.type} hex=${part.data.toString("hex")}`);
				}
				this.handlePart(part);
			}
		} catch (e) {
			console.error("[sabr] pump error", e);
		} finally {
			this.requesting = false;
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
		const videoCaps = [
			{ codec: 8, maxBitrate: 3250113 },
			{ codec: 4, maxBitrate: 3038632 },
			{ codec: 2, maxBitrate: 4349126 },
		].map((c) =>
			Buffer.concat([
				int32Field(1, c.codec),
				int32Field(2, 1),
				int32Field(3, 1080),
				int32Field(4, 1920),
				int32Field(11, 24),
				int32Field(12, c.maxBitrate),
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

	/** The single video format we're currently requesting. */
	private currentVideoFormat(): SabrInputFormat | undefined {
		return (
			this.formats.find((f) => !f.isAudio && f.itag === this.video.itag) ??
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
		const parts: Buffer[] = [
			// field 13: time_since_last_manual_format_selection_ms (int64).
			// The live WEB capture showed 173636903198703 — epoch-µs magnitude,
			// i.e. the "never manually selected" sentinel. Replay at the same
			// magnitude, recomputed per request (it tracked wall time).
			int64Field(13, BigInt(Date.now()) * 1000n),
			// field 14: last_manual_direction (sint32, zigzag-encoded). The
			// capture showed raw varint 2 = direction 1. Passing the raw
			// captured varint is wire-identical to a proper sint32 encode.
			int32Field(14, 2),
			int32Field(18, 1280), // client_viewport_width
			int32Field(19, 720), // client_viewport_height
			int32Field(21, 0), // sticky_resolution
			boolField(22, false), // client_viewport_is_flexible
			int64Field(23, this.bandwidthEstimate), // bandwidth_estimate
			int64Field(28, currentStreamTimeMs), // player_time_ms
			int64Field(29, elapsed), // time_since_last_seek
			int32Field(34, 1), // visibility
			fixed32Field(35, 1.0), // playback_rate
			int64Field(36, elapsed), // elapsed_wall_time_ms
			bytesField(38, this.buildMediaCapabilities()), // media_capabilities
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

		const parts: Buffer[] = [bytesField(1, this.buildClientAbrState(currentStreamTimeMs))];
		// selected_format_ids (field 2): sent on non-init requests, empty on init.
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
			const vr = this.encodeBufferedRange(videoFormat, this.video);
			const ar = this.encodeBufferedRange(audioFormat, this.audio);
			if (vr) parts.push(bytesField(3, vr));
			if (ar) parts.push(bytesField(3, ar));
		}
		if (videoId) parts.push(bytesField(17, videoId)); // preferred_video_format_ids
		if (audioId) parts.push(bytesField(16, audioId)); // preferred_audio_format_ids
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
				if (status === 3) this.stop();
				break;
			}
			case UMP_PART_ID.NEXT_REQUEST_POLICY: {
				const f = decodeFields(part.data);
				const cookie = getBytes(f, 7);
				const backoff = getVarint(f, 4);
				if (cookie) {
					this.playbackCookie = Buffer.from(cookie);
					if (this.video.itag === 0) {
						const cf = decodeFields(cookie);
						const vfmt = getBytes(cf, 7);
						const afmt = getBytes(cf, 8);
						if (vfmt) this.video.itag = Number(getVarint(decodeFields(vfmt), 1) ?? 0);
						if (afmt) this.audio.itag = Number(getVarint(decodeFields(afmt), 1) ?? 0);
						console.log(`[sabr] server picked itags: video=${this.video.itag} audio=${this.audio.itag}`);
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
					if (h.itag === this.video.itag && this.video.ready) break;
					if (h.itag === this.audio.itag && this.audio.ready) break;
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
				const media =
					header.itag === this.video.itag ? this.video :
					header.itag === this.audio.itag ? this.audio : undefined;
				if (!media) break;
				if (header.isInitSeg) {
					media.setInitSegment(data);
				} else {
					media.addSegment(header.sequenceNumber, {
						data,
						durationMs: header.durationMs,
						startMs: header.startMs,
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
				const media =
					itag === this.video.itag ? this.video :
					itag === this.audio.itag ? this.audio : undefined;
				if (media) {
					if (endSeg !== undefined) media.endSegmentNumber = Number(endSeg);
					if (endTime !== undefined) media.endTimeMs = Number(endTime);
				}
				break;
			}
			default:
				// SABR_CONTEXT_UPDATE / SABR_CONTEXT_SENDING_POLICY etc. are
				// ignored — TubeReplacer ignores them and streams fine.
				break;
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
