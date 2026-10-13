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
	decodeFields, getBytes, getString, getVarint,
	int32Field, int64Field, boolField, fixed32Field,
	bytesField, stringField,
} from "./proto";
import { parseInitSegment } from "./mp4";

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
}

export class SabrStream {
	requestNumber = 0;
	private playbackCookie?: Buffer;
	private backoffUntil = 0;
	dead = false;
	bandwidthEstimate = 5_000_000;
	private playbackStartAt = Date.now();

	video = new SabrMedia();
	audio = new SabrMedia();
	/** Increments whenever new media arrived — used by wait loops. */
	progressCounter = 0;
	/** Last player time we told the server about, for readahead. */
	lastPlayerTimeMs = 0;

	private requesting = false;
	private pumping = false;

	constructor(
		public sabrUrl: string,
		public ustreamerConfig: Buffer,
		public formats: SabrInputFormat[],
		private poToken: Buffer,
		public videoId: string,
		private clientInfo: SabrClientInfo,
	) {}

	/** Start the background request pump. Safe to call more than once. */
	start() {
		if (this.pumping) return;
		this.pumping = true;
		void this.pumpLoop();
	}

	stop() {
		this.dead = true;
	}

	/** Ask the pump to fetch now (e.g. a segment request found nothing buffered). */
	nudge(playerTimeMs = this.lastPlayerTimeMs) {
		this.lastPlayerTimeMs = playerTimeMs;
		if (!this.requesting && !this.dead) void this.pumpOnce(playerTimeMs);
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
		url.searchParams.set("cpn", this.cpn);
		url.searchParams.delete("cver");
		url.searchParams.set("cver", this.clientVersionForUrl());
		url.searchParams.set("rn", String(this.requestNumber));
		return url.toString();
	}

	private clientVersionForUrl(): string {
		return process.env.YTJS_SABR_CVER ?? this.clientInfo.clientVersion;
	}

	/** One SABR round-trip. */
	async pumpOnce(currentStreamTimeMs: number) {
		if (this.requesting || this.dead) return;
		this.requesting = true;
		try {
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
				headers: {
					"content-type": "application/x-protobuf",
					"accept": "application/vnd.yt-ump",
					"accept-encoding": "identity",
				},
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
				if (part.type === UMP_PART_ID.PLAYBACK_START_POLICY || part.type === UMP_PART_ID.RELOAD_PLAYER_RESPONSE || part.type === UMP_PART_ID.NEXT_REQUEST_POLICY || part.type === UMP_PART_ID.SABR_ERROR) {
					console.log(`[sabr]   part ${part.type} hex=${part.data.toString("hex")}`);
				}
				this.handlePart(part);
			}
		} catch (e) {
			console.error("[sabr] pump error", e);
		} finally {
			this.requesting = false;
		}
	}

	// --- request building (TRSabrStream.buildRequestBody) ---

	private encodeFormatId(f: SabrInputFormat): Buffer {
		const parts: Buffer[] = [int32Field(1, f.itag)];
		const lmt = f.lastModified ? BigInt(f.lastModified) : 0n;
		parts.push(int64Field(2, lmt));
		parts.push(stringField(3, f.xtags ?? ""));
		return Buffer.concat(parts);
	}

	private buildStreamerContext(): Buffer {
		const clientInfoParts: Buffer[] = [
			int32Field(16, this.clientInfo.clientName),
			stringField(17, this.clientInfo.clientVersion),
			stringField(18, this.clientInfo.osName),
			stringField(19, this.clientInfo.osVersion),
		];
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

	private buildClientAbrState(currentStreamTimeMs: number): Buffer {
		const parts: Buffer[] = [
			int32Field(18, 1280), // client_viewport_width
			int32Field(19, 720), // client_viewport_height
			boolField(22, false), // client_viewport_is_flexible
			int64Field(23, this.bandwidthEstimate), // bandwidth_estimate
			int64Field(28, currentStreamTimeMs), // player_time_ms
			int32Field(34, 1), // visibility
			fixed32Field(35, 1.0), // playback_rate
			int64Field(36, Date.now() - this.playbackStartAt), // elapsed_wall_time_ms
			int32Field(40, 0), // enabled_track_types_bitfield
			int64Field(44, 0), // player_state
			boolField(46, true), // drc_enabled (stable volume)
			boolField(58, false), // prefer_vp9
			boolField(76, false), // enable_voice_boost
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
		if (videoId) parts.push(bytesField(17, videoId)); // preferred_video_format_ids
		if (audioId) parts.push(bytesField(16, audioId)); // preferred_audio_format_ids
		parts.push(bytesField(19, this.buildStreamerContext()));
		return Buffer.concat(parts);
	}

	// --- response part handling (TRSabrStream+PartHandler) ---

	private parsingHeaders = new Map<number, { headerId: number; itag: number; isInitSeg: boolean; sequenceNumber: number; startMs?: number; durationMs?: number }>();
	private parsingDatas = new Map<number, Buffer[]>();

	private handlePart(part: UmpPart) {
		switch (part.type) {
			case UMP_PART_ID.STREAM_PROTECTION_STATUS: {
				const status = Number(getVarint(decodeFields(part.data), 1) ?? 0);
				console.log(`[sabr] stream protection status: ${status}`);
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
				// TubeReplacer has no handler for this part, so it's effectively a
				// no-op there; treating it as fatal (as FreeTube does) is too
				// aggressive. Log and carry on.
				console.log("[sabr] RELOAD_PLAYER_RESPONSE part (ignored)");
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
		const startMs = getVarint(f, 11);
		const durationMs = getVarint(f, 12);
		return {
			headerId: Number(getVarint(f, 1) ?? 0),
			itag: Number(getVarint(f, 3) ?? 0),
			isInitSeg: (getVarint(f, 8) ?? 0n) !== 0n,
			sequenceNumber: Number(getVarint(f, 9) ?? 0),
			startMs: startMs !== undefined ? Number(startMs) : undefined,
			durationMs: durationMs !== undefined ? Number(durationMs) : undefined,
		};
	}
}
