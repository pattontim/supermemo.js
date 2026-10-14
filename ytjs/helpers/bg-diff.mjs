/*
 * Diff the JSDOM-side census against the browser-side census.
 *
 * Usage (from ytjs/):
 *   node helpers/bg-diff.mjs [--jsdom /tmp/bg-census.jsonl] [--browser /tmp/bg-browser.json]
 *
 * Prints:
 *   - every probe field where the two realms disagree (the bridge targets)
 *   - the challenge/snapshot/visitor rows from the JSDOM side
 *   - the browser's GenerateIT payload size for comparison
 */

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const get = (flag, def) => {
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : def;
};
const JSDOM_LOG = get("--jsdom", "/tmp/bg-census.jsonl");
const BROWSER_JSON = get("--browser", "/tmp/bg-browser.json");

function readJsonl(path) {
	const rows = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const s = line.trim();
		if (!s) continue;
		try { rows.push(JSON.parse(s)); } catch { /* skip */ }
	}
	return rows;
}

const jsdomRows = readJsonl(JSDOM_LOG);
const browser = JSON.parse(readFileSync(BROWSER_JSON, "utf8"));

const jsdomProbe = jsdomRows.find((r) => r.probe)?.probe ?? {};
const browserProbe = browser.probe ?? {};

const keys = [...new Set([...Object.keys(jsdomProbe), ...Object.keys(browserProbe)])].sort();
const norm = (v) => JSON.stringify(v);

console.log("=== PROBE DIFF (jsdom vs browser) ===");
let diffs = 0;
for (const k of keys) {
	const a = jsdomProbe[k];
	const b = browserProbe[k];
	if (norm(a) !== norm(b)) {
		diffs++;
		console.log(`\n  ${k}`);
		console.log(`    jsdom  : ${norm(a)}`);
		console.log(`    browser: ${norm(b)}`);
	}
}
console.log(`\n${diffs} differing field(s) of ${keys.length}.`);

console.log("\n=== JSDOM CHALLENGE / SNAPSHOT / VISITOR ===");
for (const row of jsdomRows) {
	if (row.challenge) console.log("challenge:", JSON.stringify(row.challenge, null, 2));
	if (row.snapshot) console.log("snapshot:", JSON.stringify(row.snapshot, null, 2));
	if (row.visitor) console.log("visitor:", JSON.stringify(row.visitor, null, 2));
	if (row.realm) console.log("realm:", JSON.stringify(row.realm, null, 2));
}

console.log("\n=== BROWSER GENERATEIT / INTERPRETER ===");
console.log("ytcfg:", JSON.stringify(browser.ytcfg, null, 2));
console.log("interpreter:", JSON.stringify(browser.interpreter, null, 2));
for (const g of browser.generateIT ?? []) {
	if (g.kind === "request") console.log(`GenerateIT request bytes: ${g.body?.length ?? 0}`);
	if (g.kind === "response") console.log(`GenerateIT response: ${String(g.body).slice(0, 120)}`);
}

console.log("\n=== READ CENSUS (jsdom, first 200 unique reads) ===");
const reads = jsdomRows.filter((r) => r.read);
for (const r of reads.slice(0, 200)) console.log(`  ${r.read} = ${norm(r.value)}`);
console.log(`  (${reads.length} total reads)`);
