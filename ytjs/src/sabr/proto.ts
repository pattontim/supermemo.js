/*
 * Minimal proto2 wire-format encoder/decoder for the SABR messages we need.
 *
 * Field numbers come straight from TubeReplacer's
 * common/SABR/proto/video_streaming/*.proto (and misc/common.proto). We only
 * encode/decode the handful of fields SABR actually needs, so a hand-rolled
 * wire coder is smaller and more predictable than pulling in protobufjs +
 * compiling the .proto tree (and it avoids the youtubei.js deep-import trap).
 */

export function varint(value: number | bigint): Buffer {
	// Truncate non-integers: proto varints are integers, but callers sometimes
	// pass computed values (e.g. ms from a tick/timescale division) that come
	// out fractional — BigInt() would throw right there and abort the request.
	let v: bigint;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return Buffer.from([0]);
		v = BigInt(Math.trunc(value));
	} else {
		v = value;
	}
	if (v < 0n) v += 1n << 64n; // two's complement for sint64-ish inputs
	const out: number[] = [];
	do {
		let b = Number(v & 0x7fn);
		v >>= 7n;
		if (v > 0n) b |= 0x80;
		out.push(b);
	} while (v > 0n);
	return Buffer.from(out);
}

export function tag(field: number, wireType: number): Buffer {
	return varint((field << 3) | wireType);
}

export function int32Field(field: number, value: number): Buffer {
	return Buffer.concat([tag(field, 0), varint(value)]);
}

export function int64Field(field: number, value: number | bigint): Buffer {
	return Buffer.concat([tag(field, 0), varint(value)]);
}

export function uint64Field(field: number, value: number | bigint): Buffer {
	return Buffer.concat([tag(field, 0), varint(value)]);
}

export function boolField(field: number, value: boolean): Buffer {
	return Buffer.concat([tag(field, 0), varint(value ? 1 : 0)]);
}

export function fixed32Field(field: number, value: number): Buffer {
	const b = Buffer.alloc(4);
	b.writeFloatLE(value, 0);
	return Buffer.concat([tag(field, 5), b]);
}

export function bytesField(field: number, value: Buffer): Buffer {
	return Buffer.concat([tag(field, 2), varint(value.length), value]);
}

export function stringField(field: number, value: string): Buffer {
	return bytesField(field, Buffer.from(value, "utf-8"));
}

export interface ProtoField {
	field: number;
	wireType: number;
	/** varint value (wireType 0) */
	varint?: bigint;
	/** raw bytes (wireType 2/5/1) or sub-message buffer */
	bytes?: Buffer;
}

/** Flat decode of one message level into a list of fields. */
export function decodeFields(buf: Buffer): ProtoField[] {
	const fields: ProtoField[] = [];
	let off = 0;
	while (off < buf.length) {
		let key: bigint;
		let next: number;
		try {
			({ value: key, next } = readVarint(buf, off));
		} catch {
			break;
		}
		off = next;
		const field = Number(key >> 3n);
		const wireType = Number(key & 7n);
		if (wireType === 0) {
			const { value, next: n2 } = readVarint(buf, off);
			off = n2;
			fields.push({ field, wireType, varint: value });
		} else if (wireType === 2) {
			const { value: len, next: n2 } = readVarint(buf, off);
			off = n2;
			fields.push({ field, wireType, bytes: buf.subarray(off, off + Number(len)) });
			off += Number(len);
		} else if (wireType === 5) {
			fields.push({ field, wireType, bytes: buf.subarray(off, off + 4) });
			off += 4;
		} else if (wireType === 1) {
			fields.push({ field, wireType, bytes: buf.subarray(off, off + 8) });
			off += 8;
		} else {
			break; // groups etc — not used here
		}
	}
	return fields;
}

export function getVarint(fields: ProtoField[], n: number): bigint | undefined {
	return fields.find((f) => f.field === n && f.wireType === 0)?.varint;
}

/** Decode a packed repeated int32/varint field (wireType 2), or unpacked (0). */
export function getPackedVarints(fields: ProtoField[], n: number): number[] {
	const out: number[] = [];
	for (const f of fields.filter((x) => x.field === n && x.wireType === 2 && x.bytes)) {
		const buf = f.bytes!;
		let off = 0;
		while (off < buf.length) {
			const { value, next } = readVarint(buf, off);
			out.push(Number(value));
			off = next;
		}
	}
	for (const f of fields.filter((x) => x.field === n && x.wireType === 0)) {
		out.push(Number(f.varint));
	}
	return out;
}

export function getBytes(fields: ProtoField[], n: number): Buffer | undefined {
	return fields.find((f) => f.field === n && f.wireType === 2)?.bytes;
}

export function getString(fields: ProtoField[], n: number): string | undefined {
	return getBytes(fields, n)?.toString("utf-8");
}

export function readVarint(buf: Buffer, off: number): { value: bigint; next: number } {
	let result = 0n;
	let shift = 0n;
	let i = off;
	for (;;) {
		if (i >= buf.length) throw new Error("varint ran off the end of the buffer");
		const b = buf[i++];
		result |= BigInt(b & 0x7f) << shift;
		if (!(b & 0x80)) break;
		shift += 7n;
	}
	return { value: result, next: i };
}
