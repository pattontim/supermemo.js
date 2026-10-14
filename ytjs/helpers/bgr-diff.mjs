/*
 * Structural diff of two botGuardResponse blobs (jsdom vs real browser).
 * Throwaway diagnostic. Reports length, common prefix/suffix, and the
 * longest-common-substring run, which localizes where they diverge.
 *
 * Usage: node helpers/bgr-diff.mjs /tmp/bg-jsdom-bgr.txt /tmp/bg-browser-bgr.txt
 */
import { readFileSync } from "node:fs";

const [aPath, bPath] = process.argv.slice(2);
const A = readFileSync(aPath, "utf8").trim();
const B = readFileSync(bPath, "utf8").trim();

console.log(`jsdom   len=${A.length}  prefix=${A.slice(0, 24)}`);
console.log(`browser len=${B.length}  prefix=${B.slice(0, 24)}`);

let p = 0;
while (p < A.length && p < B.length && A[p] === B[p]) p++;
console.log(`\ncommon prefix: ${p} chars`);
console.log(`  jsdom  [${p}] ${JSON.stringify(A.slice(Math.max(0, p - 8), p + 24))}`);
console.log(`  browser[${p}] ${JSON.stringify(B.slice(Math.max(0, p - 8), p + 24))}`);

let s = 0;
while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
console.log(`common suffix: ${s} chars`);

// Longest common substring (O(n*m), fine for ~5KB).
let bestLen = 0, bestA = 0, bestB = 0;
const dp = new Uint16Array(B.length + 1);
for (let i = 1; i <= A.length; i++) {
	let prev = 0;
	for (let j = 1; j <= B.length; j++) {
		const tmp = dp[j];
		if (A[i - 1] === B[j - 1]) {
			dp[j] = prev + 1;
			if (dp[j] > bestLen) { bestLen = dp[j]; bestA = i - dp[j]; bestB = j - dp[j]; }
		} else dp[j] = 0;
		prev = tmp;
	}
}
console.log(`\nlongest common substring: ${bestLen} chars`);
console.log(`  jsdom  @${bestA}: ${JSON.stringify(A.slice(bestA, bestA + Math.min(bestLen, 80)))}`);
console.log(`  browser@${bestB}: ${JSON.stringify(B.slice(bestB, bestB + Math.min(bestLen, 80)))}`);

// Charset analysis: which chars appear on each side.
const setA = new Set(A.split(""));
const setB = new Set(B.split(""));
const onlyA = [...setA].filter((c) => !setB.has(c));
const onlyB = [...setB].filter((c) => !setA.has(c));
console.log(`\ncharset size: jsdom=${setA.size} browser=${setB.size}`);
console.log(`only in jsdom:  ${JSON.stringify(onlyA.join(""))}`);
console.log(`only in browser: ${JSON.stringify(onlyB.join(""))}`);
