/*
 * Just enough ISO-BMFF (MP4) parsing for SABR fMP4 segments.
 *
 * TubeReplacer parses the same boxes in TRSabrMedia.m, but it goes on to
 * transmux fMP4 -> MPEG-TS by hand (~500 lines of bit packing) because the
 * old iOS player only eats HLS/TS. Our client is a modern webview, so we keep
 * the fMP4 and only need box metadata: the media timescale, segment timing
 * (for the HLS playlist) and the number of segments.
 */

interface Box {
	type: string;
	/** offset of the box payload (after the 8-byte header) */
	start: number;
	/** payload length */
	size: number;
}

function readBoxAt(buf: Buffer, offset: number): Box | null {
	if (offset + 8 > buf.length) return null;
	let size = buf.readUInt32BE(offset);
	const type = buf.toString("latin1", offset + 4, offset + 8);
	let headerSize = 8;
	if (size === 1) {
		if (offset + 16 > buf.length) return null;
		// 64-bit largesize
		const hi = buf.readUInt32BE(offset + 8);
		const lo = buf.readUInt32BE(offset + 12);
		size = hi * 0x100000000 + lo;
		headerSize = 16;
	} else if (size === 0) {
		size = buf.length - offset;
	}
	if (size < headerSize) return null;
	return { type, start: offset + headerSize, size: size - headerSize };
}

function findTopLevelBox(buf: Buffer, type: string, from = 0): Box | null {
	let offset = from;
	while (offset < buf.length) {
		const box = readBoxAt(buf, offset);
		if (!box) return null;
		if (box.type === type) return box;
		offset = box.start + box.size;
	}
	return null;
}

function findChildBox(buf: Buffer, parent: Box, type: string): Box | null {
	return findTopLevelBox(buf.subarray(parent.start, parent.start + parent.size), type);
}

/**
 * Descend a path of box types, e.g. ["moov", "mvhd"].
 *
 * Returns offsets RELATIVE TO THE ORIGINAL BUFFER. findTopLevelBox reports
 * offsets relative to the scope it was handed, so descending without
 * accumulating the shift produced offsets that only looked valid — callers
 * reading `buf.readUInt32BE(box.start + n)` then read the wrong bytes (this is
 * why getTimescale returned garbage even after its +12/+20 fix).
 */
function findNestedBox(buf: Buffer, path: string[]): Box | null {
	let scope = buf;
	let scopeBase = 0;
	let box: Box | null = null;
	for (const type of path) {
		const found = findTopLevelBox(scope, type);
		if (!found) return null;
		box = { type: found.type, start: scopeBase + found.start, size: found.size };
		// re-slice so the next search starts inside this box
		scope = scope.subarray(found.start, found.start + found.size);
		scopeBase += found.start;
	}
	return box;
}

/** Media timescale from moov/mvhd (tick => seconds = ticks / timescale). */
export function getTimescale(initSegment: Buffer): number | undefined {
	const mvhd = findNestedBox(initSegment, ["moov", "mvhd"]);
	if (!mvhd) return undefined;
	// fullbox: version(1)+flags(3), then creation+modification times
	// (4 bytes each for v0, 8 each for v1), then the 4-byte timescale.
	// Reading +8 lands on modification_time, which is why the old code
	// produced garbage like 1769172790.
	const version = initSegment.readUInt8(mvhd.start);
	const tsOffset = mvhd.start + (version === 1 ? 20 : 12);
	return tsOffset + 4 <= mvhd.start + mvhd.size
		? initSegment.readUInt32BE(tsOffset)
		: undefined;
}

export interface SidxEntry {
	durationTicks: number;
}

export interface SidxInfo {
	timescale: number;
	entries: SidxEntry[];
}

/**
 * Parse the top-level sidx box, returning its OWN timescale plus the per-ref
 * durations. The sidx timescale is not necessarily the mvhd timescale, and
 * converting sidx ticks through mvhd yields garbage — so it must be returned
 * rather than assumed.
 */
export function getSidxInfo(initSegment: Buffer): SidxInfo | undefined {
	const sidx = findTopLevelBox(initSegment, "sidx");
	if (!sidx) return undefined;
	const base = sidx.start;
	const version = initSegment.readUInt8(base);
	const timescaleOffset = base + 8; // version(1)+flags(3)+reference_id(4)
	if (timescaleOffset + 4 > base + sidx.size) return undefined;
	const timescale = initSegment.readUInt32BE(timescaleOffset);
	// timescale sits at +8 for both v0/v1
	const earliestOffset = timescaleOffset + 4;
	const cursor = version === 0 ? earliestOffset + 8 : earliestOffset + 16;
	const countOffset = cursor + 2;
	if (countOffset + 2 > base + sidx.size) return undefined;
	const count = initSegment.readUInt16BE(countOffset);
	const entries: SidxEntry[] = [];
	let off = countOffset + 2;
	for (let i = 0; i < count; i++) {
		if (off + 12 > base + sidx.size) break;
		const durationTicks = initSegment.readUInt32BE(off + 4);
		entries.push({ durationTicks });
		off += 12;
	}
	return { timescale, entries };
}

/** Parse the top-level sidx box (if present) of an init segment. */
export function getSidxEntries(initSegment: Buffer): SidxEntry[] {
	return getSidxInfo(initSegment)?.entries ?? [];
}

export interface FragmentTiming {
	/** decode time in media timescale ticks */
	baseDecodeTimeTicks?: number;
	/** total sample duration in media timescale ticks */
	durationTicks?: number;
}

/** Read moof/traf/tfdt + trun timing for one media fragment. */
export function getFragmentTiming(fragment: Buffer): FragmentTiming {
	const moof = findTopLevelBox(fragment, "moof");
	if (!moof) return {};
	const traf = findChildBox(fragment, moof, "traf");
	if (!traf) return {};
	const result: FragmentTiming = {};

	const moofScope = fragment.subarray(moof.start, moof.start + moof.size);
	// traf.start is relative to the moof payload (findChildBox slices the
	// parent), so tfdt/trun must be looked up inside the traf payload, not in
	// the moof. They are grandchildren (moof->traf->tfdt), never direct children.
	const trafScope = moofScope.subarray(traf.start, traf.start + traf.size);

	const tfdt = findTopLevelBox(trafScope, "tfdt");
	if (tfdt) {
		const version = trafScope.readUInt8(tfdt.start);
		const valueOffset = tfdt.start + 4;
		if (version === 1) {
			result.baseDecodeTimeTicks =
				trafScope.readUInt32BE(valueOffset) * 0x100000000 +
				trafScope.readUInt32BE(valueOffset + 4);
		} else {
			result.baseDecodeTimeTicks = trafScope.readUInt32BE(valueOffset);
		}
	}

	const trun = findTopLevelBox(trafScope, "trun");
	if (trun) {
		const flags = trafScope.readUInt16BE(trun.start + 1);
		const sampleCount = trafScope.readUInt32BE(trun.start + 4);
		const sampleDurationPresent = (flags & 0x000100) !== 0;
		const sampleSizePresent = (flags & 0x000200) !== 0;
		const sampleFlagsPresent = (flags & 0x000400) !== 0;
		const sampleCtsPresent = (flags & 0x000800) !== 0;
		const perSample = 4 * (Number(sampleDurationPresent) + Number(sampleSizePresent) + Number(sampleFlagsPresent) + Number(sampleCtsPresent));
		// data_offset is present when flag 0x1 is set; it precedes the sample array.
		let off = trun.start + 8 + ((flags & 0x000001) ? 4 : 0);
		if (sampleDurationPresent && perSample > 0) {
			let total = 0;
			for (let i = 0; i < sampleCount; i++) {
				if (off + 4 > trafScope.length) break;
				total += trafScope.readUInt32BE(off);
				off += perSample;
			}
			result.durationTicks = total;
		}
	}

	return result;
}

export interface TimelineEntry {
	startMs: number;
	durationMs: number;
}

export interface ParsedInit {
	timescale?: number;
	/** per-segment duration in ms, derived from sidx (averaged) if available */
	segmentDurationMs?: number;
	/** per-segment presentation timeline derived from sidx (authoritative) */
	segmentTimeline?: TimelineEntry[];
}

export function parseInitSegment(init: Buffer): ParsedInit {
	const timescale = getTimescale(init);
	const sidx = getSidxInfo(init);
	let segmentDurationMs: number | undefined;
	let segmentTimeline: TimelineEntry[] | undefined;
	if (sidx && sidx.timescale && sidx.entries.length) {
		// Convert through the sidx's OWN timescale. The mvhd timescale is a
		// different clock and must not be used here.
		const ts = sidx.timescale;
		let cumTicks = 0;
		segmentTimeline = sidx.entries.map((e) => {
			const startMs = (cumTicks / ts) * 1000;
			const durationMs = (e.durationTicks / ts) * 1000;
			cumTicks += e.durationTicks;
			return { startMs, durationMs };
		});
		const totalTicks = sidx.entries.reduce((a, e) => a + e.durationTicks, 0);
		segmentDurationMs = (totalTicks / sidx.entries.length / ts) * 1000;
	}
	return { timescale, segmentDurationMs, segmentTimeline };
}
