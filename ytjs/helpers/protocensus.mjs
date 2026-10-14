/*
 * Throwaway protobuf field census (diagnostic helper, not shipped).
 *
 * Lists the top-level field numbers + wire types present in a protobuf message,
 * so a raw SABR VideoPlaybackAbrRequest body (browser capture) can be diffed
 * field-by-field against smjs's own buildRequestBody output (the census
 * "abr-request" hex line). Nested length-delimited fields are re-cursed one
 * level with a "path" so field presence inside client_abr_state / streamer_context
 * is visible without a .proto.
 *
 * Usage:
 *   node helpers/protocensus.mjs <hexfile|binfile> [--depth 3]
 *   node helpers/protocensus.mjs --hex <hexstring>
 *
 * For a jsdom abr-request, extract the hex first:
 *   node -e "const r=require('fs').readFileSync(process.argv[1],'utf8').trim().split('\n').map(JSON.parse).filter(x=>x.type==='abr-request').pop(); console.log(r.hex)" /tmp/bg-census-r5b.jsonl > /tmp/abr-jsdom.hex
 *   node helpers/protocensus.mjs /tmp/abr-jsdom.hex
 * Browser: node helpers/protocensus.mjs /tmp/bg-browser-abr.bin
 */

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const depthIdx = args.indexOf("--depth");
const MAX_DEPTH = depthIdx >= 0 ? Number(args[depthIdx + 1]) : 3;

let buf;
const hexIdx = args.indexOf("--hex");
if (hexIdx >= 0) {
	buf = Buffer.from(args[hexIdx + 1], "hex");
} else {
	const file = args.find((a) => !a.startsWith("--") && a !== String(MAX_DEPTH));
	const raw = readFileSync(file);
	// Auto-detect: if it looks like ASCII hex, decode it; else treat as binary.
	const text = raw.toString("utf8").trim();
	buf = /^[0-9a-fA-F\s]+$/.test(text) && text.length > 8
		? Buffer.from(text.replace(/\s+/g, ""), "hex")
		: raw;
}

console.log(`# ${buf.length} bytes, max depth ${MAX_DEPTH}`);

function readVarint(b, p) {
	let result = 0n;
	let shift = 0n;
	while (p < b.length) {
		const byte = b[p++];
		result |= BigInt(byte & 0x7f) << shift;
		if (!(byte & 0x80)) return { value: result, next: p };
		shift += 7n;
	}
	throw new Error("varint overrun");
}

const isPrintable = (b) =>
	b.length > 0 && b.every((c) => c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127));

function walk(b, path, depth) {
	let p = 0;
	const fields = [];
	while (p < b.length) {
		let key;
		try {
			({ value: key, next: p } = readVarint(b, p));
		} catch {
			break;
		}
		const field = Number(key >> 3n);
		const wire = Number(key & 7n);
		if (wire === 0) {
			let v;
			try {
				({ value: v, next: p } = readVarint(b, p));
			} catch {
				break;
			}
			fields.push({ field, wire, value: v.toString() });
			console.log(`${"  ".repeat(depth)}${path}${field} varint = ${v}`);
		} else if (wire === 2) {
			let len;
			try {
				({ value: len, next: p } = readVarint(b, p));
			} catch {
				break;
			}
			const n = Number(len);
			const sub = b.subarray(p, p + n);
			p += n;
			const printable = isPrintable(sub);
			const preview = printable ? JSON.stringify(sub.toString("utf8").slice(0, 60)) : `<bin ${n}b>`;
			console.log(`${"  ".repeat(depth)}${path}${field} bytes(${n}) ${preview}`);
			fields.push({ field, wire, len: n, preview });
			// Recurse only into plausible sub-messages (not obviously strings).
			if (depth + 1 < MAX_DEPTH && !printable && n > 0) {
				try {
					walk(sub, `${path}${field}.`, depth + 1);
				} catch {
					/* not a message */
				}
			}
		} else if (wire === 5) {
			p += 4;
			console.log(`${"  ".repeat(depth)}${path}${field} fixed32`);
			fields.push({ field, wire: 5 });
		} else if (wire === 1) {
			p += 8;
			console.log(`${"  ".repeat(depth)}${path}${field} fixed64`);
			fields.push({ field, wire: 1 });
		} else {
			console.log(`${"  ".repeat(depth)}${path}${field} wire=${wire} (unsupported, stop)`);
			break;
		}
	}
	return fields;
}

walk(buf, "", 0);
