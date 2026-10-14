/*
 * Split two decoded botGuardResponse binaries into records and tabulate
 * per-record length, to localize which signal family is oversized.
 * Throwaway diagnostic.
 *
 * Usage: node helpers/bgr-segments.mjs /tmp/bg-jsdom-bgr.txt /tmp/bg-browser-bgr.txt
 */
import { readFileSync } from "node:fs";

const dec = (s) =>
	Buffer.from(s.replace(/^\$/, "").replace(/-/g, "+").replace(/_/g, "/"), "base64");

const A = dec(readFileSync(process.argv[2], "utf8").trim());
const B = dec(readFileSync(process.argv[3], "utf8").trim());

console.log(`jsdom=${A.length}B browser=${B.length}B ratio=${(A.length / B.length).toFixed(2)}`);

// Walk the buffer as a sequence of [tag(2 bytes)][len?] framed records.
// First, find the most common 2-byte alignment patterns and see if they recur.
function scan(buf, label) {
	// Count 2-byte tokens at even offsets.
	const m = new Map();
	for (let i = 0; i + 2 <= buf.length; i++) {
		const k = buf.readUInt16BE(i).toString(16).padStart(4, "0");
		m.set(k, (m.get(k) || 0) + 1);
	}
	const top = [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12);
	console.log(`\n${label} top 2-byte tokens:`, top.map(([k, c]) => `${k}:${c}`).join(" "));
	return m;
}
const ma = scan(A, "jsdom");
const mb = scan(B, "browser");

// Tokens only frequent in jsdom
console.log("\ntokens with jsdom count >> browser count:");
const keys = new Set([...ma.keys(), ...mb.keys()]);
const deltas = [];
for (const k of keys) {
	const ca = ma.get(k) || 0;
	const cb = mb.get(k) || 0;
	deltas.push([k, ca, cb, ca - cb]);
}
deltas.sort((x, y) => y[3] - x[3]);
for (const [k, ca, cb, d] of deltas.slice(0, 15)) console.log(`  ${k}: jsdom=${ca} browser=${cb} delta=${d}`);

// Look for a large repeated run in jsdom that isn't in browser.
function longestRun(buf, n = 32) {
	const seen = new Map();
	for (let i = 0; i + n <= buf.length; i += 1) {
		const key = buf.subarray(i, i + n).toString("hex");
		const rec = seen.get(key);
		if (rec) { rec.count++; rec.last = i; } else seen.set(key, { count: 1, first: i, last: i });
	}
	return [...seen.entries()].filter(([, v]) => v.count > 1).sort((x, y) => y[1].count - x[1].count);
}
const runsA = longestRun(A);
console.log(`\njsdom repeated ${32}-byte windows: ${runsA.length}`);
for (const [k, v] of runsA.slice(0, 5)) console.log(`  x${v.count} @${v.first}..${v.last}: ${k.slice(0, 64)}`);
const runsB = longestRun(B);
console.log(`browser repeated 32-byte windows: ${runsB.length}`);
for (const [k, v] of runsB.slice(0, 5)) console.log(`  x${v.count} @${v.first}..${v.last}: ${k.slice(0, 64)}`);
