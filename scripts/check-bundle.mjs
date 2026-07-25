import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

/**
 * The first-load budget.
 *
 * Bundle control is the single biggest risk on a Three.js plus WASM app, and the
 * failure is silent: nothing breaks, the cold-open screen just quietly starts
 * taking six seconds on a phone. So the budget is a gate rather than a habit.
 *
 * Three separate budgets, because they are paid at three different moments:
 *
 *  - `entry` is what a visitor downloads before anything is on screen.
 *  - `detector` is the QR reader wasm, prefetched during the cold-open screen.
 *    It is large and that is fine -- it is paid for by the seconds somebody
 *    spends reading "one photograph, decoded on this phone".
 *  - `scene` is three.js, which must stay out of the first two. It is loaded
 *    lazily at the result screen, long after the camera is already running.
 */

const BUDGETS = {
	entry: 140 * 1024,
	detector: 520 * 1024,
	scene: 320 * 1024,
};

const dir = resolve(process.cwd(), "dist/client/assets");
const files = readdirSync(dir).filter((f) => !f.endsWith(".map"));

const gzipped = (name) => gzipSync(readFileSync(join(dir, name))).byteLength;
const raw = (name) => statSync(join(dir, name)).size;

const groups = { entry: [], detector: [], scene: [], other: [] };
for (const file of files) {
	if (/^(three|Scene)-/.test(file)) groups.scene.push(file);
	else if (/^(zxing|detect\.worker)|zxing_reader.*\.wasm$/.test(file)) groups.detector.push(file);
	else if (/\.(js|css)$/.test(file)) groups.entry.push(file);
	else groups.other.push(file);
}

let failed = false;
console.log("first-load budget (gzipped):\n");
for (const [name, budget] of Object.entries(BUDGETS)) {
	const members = groups[name];
	const total = members.reduce((sum, f) => sum + gzipped(f), 0);
	const ok = total <= budget;
	if (!ok) failed = true;
	console.log(
		`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(9)} ${(total / 1024).toFixed(1).padStart(7)} KB / ${(budget / 1024).toFixed(0)} KB`,
	);
	for (const f of members.sort((a, b) => gzipped(b) - gzipped(a))) {
		console.log(
			`         ${f.padEnd(34)} ${(gzipped(f) / 1024).toFixed(1).padStart(7)} KB gz  ${(raw(f) / 1024).toFixed(0).padStart(6)} KB raw`,
		);
	}
}

// three.js must not have leaked into the entry chunk. If it has, every visitor
// pays a quarter of a megabyte before the page renders, which is exactly the
// regression a total-size budget would hide.
const leaked = groups.entry.filter((f) => gzipped(f) > 120 * 1024);
if (leaked.length > 0) {
	console.error(`\nFAIL: unexpectedly large entry chunk(s): ${leaked.join(", ")}`);
	failed = true;
}

if (failed) {
	console.error("\nBundle budget exceeded.");
	process.exit(1);
}
console.log("\nWithin budget.");
