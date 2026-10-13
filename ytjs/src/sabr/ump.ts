/*
 * UMP (Universal Media Part) framing — port of TubeReplacer's TRUmpReader.m.
 *
 * Each part is prefixed with [partType:umpVarint][size:umpVarint][data].
 * UMP varints are NOT protobuf varints: they use a 1..4 byte prefix-counted
 * scheme, plus a 0xF0 + 4 little-endian bytes fallback for large values.
 */

export interface UmpPart {
	type: number;
	data: Buffer;
}

function readUmpVarint(data: Buffer, offset: number): { value: number; next: number } {
	const first = data[offset];
	let value: number;
	let length: number;
	if (first === undefined) {
		throw new Error("No data to read UMP varint from");
	} else if ((first & 0x80) === 0x00) {
		value = first;
		length = 1;
	} else if ((first & 0xc0) === 0x80) {
		length = 2;
		value = (first & 0x3f) | (data[offset + 1] << 6);
	} else if ((first & 0xe0) === 0xc0) {
		length = 3;
		value = (first & 0x1f) | (data[offset + 1] << 5) | (data[offset + 2] << 13);
	} else if ((first & 0xf0) === 0xe0) {
		length = 4;
		value =
			(first & 0x0f) |
			(data[offset + 1] << 4) |
			(data[offset + 2] << 12) |
			(data[offset + 3] << 20);
	} else if (first === 0xf0) {
		length = 5;
		value =
			data[offset + 1] |
			(data[offset + 2] << 8) |
			(data[offset + 3] << 16) |
			(data[offset + 4] << 24);
	} else {
		throw new Error(`Invalid UMP varint prefix byte: 0x${first.toString(16)}`);
	}
	return { value, next: offset + length };
}

/**
 * Parse a full UMP response buffer into parts. Stops cleanly at the first
 * incomplete part so it can be used on a growing buffer (TRSabrRequest does
 * the same via TRUmpReader's "successfullyRead" return).
 */
export function parseUmp(data: Buffer): UmpPart[] {
	const parts: UmpPart[] = [];
	let offset = 0;
	while (offset < data.length) {
		try {
			const t = readUmpVarint(data, offset);
			offset = t.next;
			const s = readUmpVarint(data, offset);
			offset = s.next;
			if (offset + s.value > data.length) break;
			parts.push({ type: t.value, data: data.subarray(offset, offset + s.value) });
			offset += s.value;
		} catch {
			break;
		}
	}
	return parts;
}

// From video_streaming/ump_part_id.proto
export const UMP_PART_ID = {
	ONESIE_HEADER: 10,
	ONESIE_DATA: 11,
	ONESIE_ENCRYPTED_MEDIA: 12,
	MEDIA_HEADER: 20,
	MEDIA: 21,
	MEDIA_END: 22,
	CONFIG: 30,
	LIVE_METADATA: 31,
	NEXT_REQUEST_POLICY: 35,
	USTREAMER_VIDEO_AND_FORMAT_METADATA: 36,
	USTREAMER_SELECTED_MEDIA_STREAM: 38,
	FORMAT_INITIALIZATION_METADATA: 42,
	SABR_REDIRECT: 43,
	SABR_ERROR: 44,
	SABR_SEEK: 45,
	RELOAD_PLAYER_RESPONSE: 46,
	PLAYBACK_START_POLICY: 47,
	SABR_CONTEXT_UPDATE: 57,
	STREAM_PROTECTION_STATUS: 58,
	SABR_CONTEXT_SENDING_POLICY: 59,
} as const;
