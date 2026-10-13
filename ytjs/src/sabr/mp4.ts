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

/** Descend a path of box types, e.g. ["moov", "mvhd"]. */
function findNestedBox(buf: Buffer, path: string[]): Box | null {
	let scope = buf;
	let box: Box | null = null;
	for (const type of path) {
		box = findTopLevelBox(scope.subarray(0, scope.length), type);
		if (!box) return null;
		// re-slice so child offsets are relative to the found box
		scope = scope.subarray(box.start, box.start + box.size);
	}
	return box;
}

/** Media timescale from moov/mvhd (tick => seconds = ticks / timescale). */
export function getTimescale(initSegment: Buffer): number | undefined {
	const mvhd = findNestedBox(initSegment, ["moov", "mvhd"]);
	if (!mvhd) return undefined;
	// fullbox: version(1) flags(3) then creation/modification times
	return mvhd.size >= 12 ? initSegment.readUInt32BE(mvhd.start + 8) : undefined;
}

export interface SidxEntry {
	durationTicks: number;
}

/** Parse the top-level sidx box (if present) of an init segment. */
export function getSidxEntries(initSegment: Buffer): SidxEntry[] {
	const sidx = findTopLevelBox(initSegment, "sidx");
	if (!sidx) return [];
	const base = sidx.start;
	const version = initSegment.readUInt8(base);
	const timescaleOffset = base + 8; // version(1)+flags(3)+reference_id(4)
	if (timescaleOffset + 4 > base + sidx.size) return [];
	// timescale sits at +8 for both v0/v1
	const earliestOffset = timescaleOffset + 4;
	const cursor = version === 0 ? earliestOffset + 8 : earliestOffset + 16;
	const countOffset = cursor + 2;
	if (countOffset + 2 > base + sidx.size) return [];
	const count = initSegment.readUInt16BE(countOffset);
	const entries: SidxEntry[] = [];
	let off = countOffset + 2;
	for (let i = 0; i < count; i++) {
		if (off + 12 > base + sidx.size) break;
		const durationTicks = initSegment.readUInt32BE(off + 4);
		entries.push({ durationTicks });
		off += 12;
	}
	return entries;
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
	const tfdt = findTopLevelBox(moofScope, "tfdt");
	if (tfdt) {
		const version = moofScope.readUInt8(tfdt.start);
		const valueOffset = tfdt.start + 4;
		if (version === 1) {
			result.baseDecodeTimeTicks =
				moofScope.readUInt32BE(valueOffset) * 0x100000000 +
				moofScope.readUInt32BE(valueOffset + 4);
		} else {
			result.baseDecodeTimeTicks = moofScope.readUInt32BE(valueOffset);
		}
	}

	const trun = findTopLevelBox(moofScope, "trun");
	if (trun) {
		const flags = moofScope.readUInt16BE(trun.start + 1);
		const sampleCount = moofScope.readUInt32BE(trun.start + 4);
		const sampleDurationPresent = (flags & 0x000100) !== 0;
		const sampleSizePresent = (flags & 0x000200) !== 0;
		const sampleFlagsPresent = (flags & 0x000400) !== 0;
		const sampleCtsPresent = (flags & 0x000800) !== 0;
		const perSample = 4 * (Number(sampleDurationPresent) + Number(sampleSizePresent) + Number(sampleFlagsPresent) + Number(sampleCtsPresent));
		let total = 0;
		let off = trun.start + 8;
		if (sampleDurationPresent && perSample > 0) {
			for (let i = 0; i < sampleCount; i++) {
				if (off + 4 > moofScope.length) break;
				total += moofScope.readUInt32BE(off);
				off += perSample;
			}
			result.durationTicks = total;
		}
	}

	return result;
}

export interface ParsedInit {
	timescale?: number;
	/** per-segment duration in ms, derived from sidx (averaged) if available */
	segmentDurationMs?: number;
}

export function parseInitSegment(init: Buffer): ParsedInit {
	const timescale = getTimescale(init);
	const entries = getSidxEntries(init);
	let segmentDurationMs: number | undefined;
	if (timescale && entries.length) {
		const total = entries.reduce((acc, e) => acc + e.durationTicks, 0);
		segmentDurationMs = (total / entries.length / timescale) * 1000;
	}
	return { timescale, segmentDurationMs };
}
