import { extractCorrespondences } from "@core/detect.ts";
import { rgbaToGray, toLinear } from "@core/image.ts";
import { estimateRange, moduleCountForVersion } from "@core/marker.ts";
import { DEFAULT_GATES } from "@core/pose.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultCamera } from "../support/correspondences.ts";
import { gtModelPoints, project } from "../support/groundtruth.ts";
import { type L2Outcome, layoutFromDisplay, runCase } from "../support/pipeline.ts";
import { type Degradations, makeDisplay, render } from "../support/render.ts";
import {
	type ChartSeries,
	mean,
	percentile,
	renderChart,
	writeArtifact,
} from "../support/report.ts";
import { decodeFrame, prepareZXing } from "../support/zxing-node.ts";

/**
 * The measurement pass.
 *
 * CONCEPT.md section 10, day 2: "real detector on synthetic frames over the pose
 * x degradation grid... re-derive the range table from measured numbers." This
 * file is where the project's quantitative claims come from. Nothing here
 * asserts a number that was decided in advance except the loose sanity bounds --
 * the artefacts it writes are the actual answer.
 *
 * The honest caveat, stated once and repeated in the README: this is a
 * ray-traced screen with a modelled panel structure, optical blur, ISP
 * sharpening, rolling shutter and sensor noise. It has no colour-filter array,
 * no lens distortion and no autofocus breathing. The real per-corner sigma is
 * measured on hardware in the R1 spike; these numbers are the floor, not the
 * expectation.
 */

const PAYLOAD_SHORT = "HTTPS://EXAMPLE.COM/S/K7F2QX";
const N = moduleCountForVersion(2);
const SUPERSAMPLE = 3;

/** A plausible handheld capture: mild optical blur, some noise, ISP sharpening. */
const NOMINAL: Degradations = {
	blurPx: 0.55,
	noiseLevels: 2.0,
	sharpen: 0.35,
	gamma: 2.2,
	seed: 17,
};

interface SweepRow {
	readonly label: string;
	readonly distanceEdges: number;
	readonly azimuthDeg: number;
	readonly pxPerModule: number;
	readonly bearingP50: number;
	readonly bearingP95: number;
	readonly azimuthP95: number;
	readonly distanceRelP50: number;
	readonly distanceRelP95: number;
	readonly flipRate: number;
	readonly refusedRate: number;
	readonly solidRate: number;
	readonly decodeRate: number;
	readonly n: number;
}

const collected: Record<string, unknown> = {};

describe("L2: measured accuracy", () => {
	beforeAll(() => {
		prepareZXing();
	});

	afterAll(() => {
		collected.generatedAt = "deterministic";
		writeArtifact("sweep.json", JSON.stringify(collected, null, "\t"));
	});

	/**
	 * The synthetic analogue of the R1 spike: how well does the refiner actually
	 * locate a corner? Everything else in the project is conditioned on this
	 * number, so it is measured against the generator's own analytic projection
	 * rather than inferred from downstream error.
	 */
	it("measures per-corner sigma directly against analytic ground truth", async () => {
		const camera = defaultCamera(1280, 960);
		const conditions: { name: string; deg: Degradations }[] = [
			{ name: "pristine", deg: { blurPx: 0.35, noiseLevels: 0.5, seed: 5 } },
			{ name: "nominal", deg: NOMINAL },
			{ name: "sharpened", deg: { ...NOMINAL, sharpen: 1.1 } },
			{ name: "noisy", deg: { ...NOMINAL, noiseLevels: 6 } },
			{ name: "soft", deg: { ...NOMINAL, blurPx: 1.4 } },
			{
				name: "panel-moire",
				deg: { ...NOMINAL },
			},
		];

		const summary: Record<string, { p50: number; p95: number; n: number }> = {};

		for (const condition of conditions) {
			const display = makeDisplay(
				{ text: PAYLOAD_SHORT },
				{
					mode: "fullbleed",
					...(condition.name === "panel-moire" ? { panelPitchCss: 3.2, panelDepth: 0.5 } : {}),
				},
			);
			const errors: number[] = [];

			for (const view of [
				{ azimuthDeg: 0, elevationDeg: 6, distanceEdges: 3 },
				{ azimuthDeg: 22, elevationDeg: 10, distanceEdges: 4 },
				{ azimuthDeg: -35, elevationDeg: -8, distanceEdges: 5, rollDeg: 12 },
				{ azimuthDeg: 45, elevationDeg: 14, distanceEdges: 6 },
			]) {
				const frame = render({
					camera,
					view,
					display,
					supersample: SUPERSAMPLE,
					degradations: condition.deg,
				});
				const { symbol } = await decodeFrame(frame.rgba, frame.width, frame.height);
				if (!symbol) continue;
				const linear = toLinear(rgbaToGray(frame.rgba, frame.width, frame.height));
				const extraction = extractCorrespondences(linear, symbol, {
					layout: layoutFromDisplay(display, display.symbolEdgeCss, false),
				});

				// Analytic truth for every model point the refiner reported.
				const truthByKey = new Map<string, { x: number; y: number }>();
				for (const p of gtModelPoints(symbol.moduleCount)) {
					const img = project(frame.truth, camera, p);
					truthByKey.set(`${p.x.toFixed(9)},${p.y.toFixed(9)}`, img);
				}
				for (const c of extraction.correspondences) {
					const key = `${c.model.x.toFixed(9)},${c.model.y.toFixed(9)}`;
					const truth = truthByKey.get(key);
					if (!truth) continue;
					errors.push(Math.hypot(c.image.x - truth.x, c.image.y - truth.y));
				}
			}

			summary[condition.name] = {
				p50: percentile(errors, 50),
				p95: percentile(errors, 95),
				n: errors.length,
			};
		}

		collected.cornerSigma = summary;
		// eslint-disable-next-line no-console
		console.log("\n  per-corner error (px), synthetic:");
		for (const [name, s] of Object.entries(summary)) {
			console.log(
				`    ${name.padEnd(12)} p50 ${s.p50.toFixed(3)}  p95 ${s.p95.toFixed(3)}  (n=${s.n})`,
			);
		}

		expect(summary.nominal!.n).toBeGreaterThan(50);
		// The refiner must at minimum beat the integer quantisation it replaces.
		expect(summary.nominal!.p50).toBeLessThan(0.5);
		expect(summary.pristine!.p50).toBeLessThan(0.25);
	});

	/**
	 * The main grid. Distance is swept in marker edges, which is the only
	 * dimensionless way to say it; every physical range claim is derived from
	 * this by multiplying by the display's size.
	 */
	it("sweeps distance x azimuth and writes the range table", async () => {
		const camera = defaultCamera(1280, 960);
		const distances = [2, 3, 4, 6, 8, 11, 15, 20];
		const azimuths = [8, 22, 38];
		const rows: SweepRow[] = [];

		for (const withBrackets of [false, true]) {
			const display = makeDisplay({ text: PAYLOAD_SHORT }, { mode: "fullbleed", withBrackets });
			for (const distanceEdges of distances) {
				for (const azimuthDeg of azimuths) {
					const outcomes: L2Outcome[] = [];
					for (let seed = 0; seed < 5; seed++) {
						outcomes.push(
							await runCase({
								view: {
									azimuthDeg,
									elevationDeg: 9,
									distanceEdges,
									rollDeg: seed * 3 - 6,
								},
								camera,
								display,
								useBrackets: withBrackets,
								supersample: SUPERSAMPLE,
								degradations: { ...NOMINAL, seed: 100 + seed * 37 },
								sigmaPx: 0.35,
							}),
						);
					}
					const decoded = outcomes.filter((o) => o.decoded);
					const solved = outcomes.filter((o) => o.solution !== null);
					const usable = solved.filter((o) => o.solution!.tier !== "refused");
					rows.push({
						label: withBrackets ? "full-bleed + brackets" : "symbol only",
						distanceEdges,
						azimuthDeg,
						pxPerModule: mean(solved.map((o) => o.pxPerModule)),
						bearingP50: percentile(
							usable.map((o) => o.bearingErrorDeg),
							50,
						),
						bearingP95: percentile(
							usable.map((o) => o.bearingErrorDeg),
							95,
						),
						azimuthP95: percentile(
							usable.map((o) => Math.abs(o.azimuthErrorDeg)),
							95,
						),
						distanceRelP50: percentile(
							usable.map((o) => Math.abs(o.distanceRelError)),
							50,
						),
						distanceRelP95: percentile(
							usable.map((o) => Math.abs(o.distanceRelError)),
							95,
						),
						flipRate: usable.length ? usable.filter((o) => o.flipped).length / usable.length : 0,
						refusedRate: solved.length ? 1 - usable.length / solved.length : 1,
						solidRate: solved.length
							? solved.filter((o) => o.solution!.tier === "solid").length / solved.length
							: 0,
						decodeRate: decoded.length / outcomes.length,
						n: outcomes.length,
					});
				}
			}
		}

		collected.grid = rows;

		console.log("\n  distance sweep (elevation 9 deg, nominal degradation):");
		console.log(
			"    config                 Z(ed)  az   px/mod  bear50  bear95  dist95  flip  refuse  solid",
		);
		for (const r of rows) {
			console.log(
				`    ${r.label.padEnd(22)} ${r.distanceEdges.toString().padStart(4)} ${r.azimuthDeg
					.toString()
					.padStart(4)} ${r.pxPerModule.toFixed(1).padStart(7)} ${fmt(r.bearingP50)} ${fmt(
					r.bearingP95,
				)} ${pct(r.distanceRelP95)} ${pct(r.flipRate)} ${pct(r.refusedRate)} ${pct(r.solidRate)}`,
			);
		}

		// The product's core promise: when it answers, it is not on the wrong side.
		const answered = rows.filter((r) => r.refusedRate < 1);
		const weightedFlips = answered.reduce((a, r) => a + r.flipRate * (1 - r.refusedRate), 0);
		expect(weightedFlips / answered.length).toBeLessThan(0.05);

		// Close in, at a readable angle, it should be confident and correct.
		const close = rows.filter(
			(r) => r.distanceEdges <= 4 && r.azimuthDeg >= 22 && r.label.includes("brackets"),
		);
		expect(close.length).toBeGreaterThan(0);
		for (const r of close) {
			expect(r.decodeRate).toBe(1);
			expect(r.bearingP95).toBeLessThan(3);
			expect(r.flipRate).toBe(0);
		}
	});

	/** Degradation grid: what actually breaks the pipeline, in order. */
	it("sweeps degradations and records what breaks first", async () => {
		const camera = defaultCamera(1280, 960);
		const cases: { name: string; deg: Degradations; panel?: number }[] = [
			{ name: "pristine", deg: { blurPx: 0.3, noiseLevels: 0.5, seed: 3 } },
			{ name: "nominal", deg: NOMINAL },
			{ name: "heavy-blur", deg: { ...NOMINAL, blurPx: 2.2 } },
			{ name: "heavy-noise", deg: { ...NOMINAL, noiseLevels: 14 } },
			{ name: "over-sharpened", deg: { ...NOMINAL, sharpen: 1.6 } },
			{ name: "underexposed", deg: { ...NOMINAL, exposure: 0.28 } },
			{
				name: "glare-corner",
				deg: { ...NOMINAL, glare: { x: 0.36, y: 0.36, r: 0.13, strength: 1.4 } },
			},
			{ name: "rolling-shutter", deg: { ...NOMINAL, rollingShutterEdges: 0.09 } },
			{ name: "panel-moire-fine", deg: NOMINAL, panel: 2.1 },
			{ name: "panel-moire-coarse", deg: NOMINAL, panel: 4.7 },
		];

		const results: Record<string, unknown> = {};
		console.log("\n  degradation grid (Z = 5 edges, az 25 deg):");
		console.log("    condition             decode  points  bear50  bear95  dist95  refuse");

		for (const c of cases) {
			const display = makeDisplay(
				{ text: PAYLOAD_SHORT },
				{
					mode: "fullbleed",
					withBrackets: true,
					...(c.panel ? { panelPitchCss: c.panel, panelDepth: 0.5 } : {}),
				},
			);
			const outcomes: L2Outcome[] = [];
			for (let seed = 0; seed < 6; seed++) {
				outcomes.push(
					await runCase({
						view: { azimuthDeg: 25, elevationDeg: 9, distanceEdges: 5, rollDeg: seed * 4 - 10 },
						camera,
						display,
						useBrackets: true,
						supersample: SUPERSAMPLE,
						degradations: { ...c.deg, seed: 900 + seed * 13 },
					}),
				);
			}
			const decoded = outcomes.filter((o) => o.decoded);
			const usable = outcomes.filter((o) => o.solution && o.solution.tier !== "refused");
			const entry = {
				decodeRate: decoded.length / outcomes.length,
				meanPoints: mean(outcomes.map((o) => o.pointCount)),
				bearingP50: percentile(
					usable.map((o) => o.bearingErrorDeg),
					50,
				),
				bearingP95: percentile(
					usable.map((o) => o.bearingErrorDeg),
					95,
				),
				distanceRelP95: percentile(
					usable.map((o) => Math.abs(o.distanceRelError)),
					95,
				),
				refusedRate: 1 - usable.length / outcomes.length,
			};
			results[c.name] = entry;
			console.log(
				`    ${c.name.padEnd(21)} ${pct(entry.decodeRate)} ${entry.meanPoints
					.toFixed(0)
					.padStart(7)} ${fmt(entry.bearingP50)} ${fmt(entry.bearingP95)} ${pct(
					entry.distanceRelP95,
				)} ${pct(entry.refusedRate)}`,
			);
		}

		collected.degradations = results;

		// Moire is one of CONCEPT.md's explicitly unresolved questions. Model the
		// mechanism -- a panel black matrix integrated over the sensor footprint --
		// and record the answer instead of guessing at it.
		const fine = results["panel-moire-fine"] as { decodeRate: number };
		const coarse = results["panel-moire-coarse"] as { decodeRate: number };
		expect(fine.decodeRate).toBeGreaterThan(0);
		expect(coarse.decodeRate).toBeGreaterThan(0);

		const nominal = results.nominal as { decodeRate: number };
		expect(nominal.decodeRate).toBe(1);
	});

	/**
	 * Gate calibration.
	 *
	 * CONCEPT.md section 9, R1: "Then re-derive every gate and tolerance in this
	 * document from the measured value." The px/module thresholds in
	 * DEFAULT_GATES started as transcribed guesses, and the first grid run showed
	 * them refusing captures whose measured bearing error was a tenth of a degree.
	 * This test runs the low end with the gates wide open so the thresholds can be
	 * set from evidence, and then checks that the shipped defaults agree with what
	 * it found.
	 */
	it("calibrates the apparent-size gate against measured accuracy", async () => {
		const camera = defaultCamera(1280, 960);
		const display = makeDisplay({ text: PAYLOAD_SHORT }, { mode: "fullbleed", withBrackets: true });
		const open = {
			...DEFAULT_GATES,
			solidPxPerModule: 0,
			softPxPerModule: 0,
			softMargin: 0,
			solidMargin: 0,
			maxRmsPx: 1e9,
			solidRmsPx: 1e9,
			maxBearingSigmaDeg: 1e9,
			maxDistanceSigmaRel: 1e9,
			maxDistanceEdges: 1e6,
		};

		const rows: Record<string, number>[] = [];
		console.log("\n  gate calibration (azimuth 12 deg, gates disabled):");
		console.log("    Z(ed)  px/mod  decode  bear50  bear95  dist95  flip  margin50");

		for (const distanceEdges of [4, 6, 8, 10, 12, 14, 16]) {
			const outcomes: L2Outcome[] = [];
			for (let seed = 0; seed < 8; seed++) {
				outcomes.push(
					await runCase({
						view: { azimuthDeg: 12, elevationDeg: 9, distanceEdges, rollDeg: seed * 3 - 10 },
						camera,
						display,
						useBrackets: true,
						supersample: SUPERSAMPLE,
						degradations: { ...NOMINAL, seed: 2200 + seed * 29 },
						gates: open,
					}),
				);
			}
			const solved = outcomes.filter((o) => o.solution !== null);
			if (solved.length === 0) {
				rows.push({ distanceEdges, pxPerModule: Number.NaN, decodeRate: 0 });
				console.log(`    ${distanceEdges.toString().padStart(5)}       -      0%`);
				continue;
			}
			const row = {
				distanceEdges,
				pxPerModule: mean(solved.map((o) => o.pxPerModule)),
				decodeRate: outcomes.filter((o) => o.decoded).length / outcomes.length,
				bearingP50: percentile(
					solved.map((o) => o.bearingErrorDeg),
					50,
				),
				bearingP95: percentile(
					solved.map((o) => o.bearingErrorDeg),
					95,
				),
				distanceRelP95: percentile(
					solved.map((o) => Math.abs(o.distanceRelError)),
					95,
				),
				flipRate: solved.filter((o) => o.flipped).length / solved.length,
				marginP50: percentile(
					solved.map((o) => o.solution!.branchMargin).filter((m) => Number.isFinite(m)),
					50,
				),
			};
			rows.push(row);
			console.log(
				`    ${distanceEdges.toString().padStart(5)} ${row.pxPerModule.toFixed(1).padStart(7)} ${pct(
					row.decodeRate,
				)} ${fmt(row.bearingP50)} ${fmt(row.bearingP95)} ${pct(row.distanceRelP95)} ${pct(
					row.flipRate,
				)} ${row.marginP50.toFixed(2).padStart(9)}`,
			);
		}
		collected.gateCalibration = rows;

		// Evidence for the shipped defaults: every configuration at or above the
		// soft gate must still decode reliably and hold bearing inside the claim.
		const aboveSoftGate = rows.filter(
			(r) => Number.isFinite(r.pxPerModule!) && r.pxPerModule! >= DEFAULT_GATES.softPxPerModule,
		);
		expect(aboveSoftGate.length).toBeGreaterThan(1);
		for (const r of aboveSoftGate) {
			expect(r.decodeRate).toBe(1);
			expect(r.bearingP95!).toBeLessThan(3);
		}

		// And the soft gate must not be leaving obviously good captures on the
		// table: the band just below it should be visibly worse or undecodable.
		const belowGate = rows.filter(
			(r) => !Number.isFinite(r.pxPerModule!) || r.pxPerModule! < DEFAULT_GATES.softPxPerModule,
		);
		if (belowGate.length > 0) {
			const worst = Math.max(
				...belowGate.map((r) => (Number.isFinite(r.bearingP95!) ? r.bearingP95! : 999)),
				...belowGate.map((r) => (r.decodeRate! < 1 ? 999 : 0)),
			);
			expect(worst).toBeGreaterThan(1);
		}
	});

	/**
	 * Is the error bar honest?
	 *
	 * The solver predicts a per-frame bearing and distance sigma from the pose
	 * covariance, and that same number is what the gate uses and what the screen
	 * shows. A predicted error bar nobody checks is decoration, so this checks it:
	 * across many poses, the ratio of actual error to predicted sigma should look
	 * like a standard normal. Roughly 68% inside 1 sigma, roughly 95% inside 2.
	 *
	 * Being *too wide* is a failure too, in the other direction -- it would mean
	 * refusing captures that were fine.
	 */
	it("produces calibrated error bars, not decorative ones", async () => {
		const camera = defaultCamera(1280, 960);
		const display = makeDisplay({ text: PAYLOAD_SHORT }, { mode: "fullbleed", withBrackets: true });

		const bearingZ: number[] = [];
		const distanceZ: number[] = [];

		for (const distanceEdges of [3, 5, 8]) {
			for (const azimuthDeg of [10, 25, 40]) {
				for (let seed = 0; seed < 7; seed++) {
					const outcome = await runCase({
						view: { azimuthDeg, elevationDeg: 9, distanceEdges, rollDeg: seed * 5 - 15 },
						camera,
						display,
						useBrackets: true,
						supersample: SUPERSAMPLE,
						degradations: { ...NOMINAL, seed: 7700 + seed * 41 },
						sigmaPx: 0.3,
						// Pin the focal prior so the check isolates the geometric part of
						// the covariance from the focal-prior part, which is a stated
						// assumption rather than something the frame can be wrong about.
						priorSigmaLog: 0.02,
					});
					if (!outcome.solution || outcome.solution.tier === "refused") continue;
					const b = outcome.solution.primary;
					if (b.bearingSigmaDeg > 0) bearingZ.push(outcome.azimuthErrorDeg / b.bearingSigmaDeg);
					if (b.distanceSigmaRel > 0) {
						distanceZ.push(outcome.distanceRelError / b.distanceSigmaRel);
					}
				}
			}
		}

		const within = (values: number[], k: number) =>
			values.filter((v) => Math.abs(v) <= k).length / values.length;

		const summary = {
			n: bearingZ.length,
			bearingWithin1: within(bearingZ, 1),
			bearingWithin2: within(bearingZ, 2),
			distanceWithin1: within(distanceZ, 1),
			distanceWithin2: within(distanceZ, 2),
			bearingZp95: percentile(bearingZ.map(Math.abs), 95),
			distanceZp95: percentile(distanceZ.map(Math.abs), 95),
		};
		collected.calibration = summary;
		console.log("\n  error-bar calibration (|error| / predicted sigma):");
		console.log(
			`    bearing  within 1s ${(summary.bearingWithin1 * 100).toFixed(0)}%  within 2s ${(summary.bearingWithin2 * 100).toFixed(0)}%  p95 z ${summary.bearingZp95.toFixed(2)}`,
		);
		console.log(
			`    distance within 1s ${(summary.distanceWithin1 * 100).toFixed(0)}%  within 2s ${(summary.distanceWithin2 * 100).toFixed(0)}%  p95 z ${summary.distanceZp95.toFixed(2)}`,
		);

		expect(summary.n).toBeGreaterThan(40);
		// A two-sigma bar has to contain about 95% of the errors. This is the
		// assertion that keeps DEFAULT_COVARIANCE_INFLATION honest: if the refiner
		// changes and its errors become more (or less) correlated, this fails.
		expect(summary.bearingWithin2).toBeGreaterThan(0.9);
		expect(summary.distanceWithin2).toBeGreaterThan(0.9);
		expect(summary.bearingWithin1).toBeGreaterThan(0.55);
		// Not wildly pessimistic either, or the gate refuses good captures and the
		// error bar on screen is so wide it says nothing.
		expect(summary.bearingZp95).toBeGreaterThan(0.3);
		expect(summary.bearingZp95).toBeLessThan(2.6);
	});

	/** The chart that ships to /how-it-works. */
	it("emits the error-vs-apparent-size chart", () => {
		const rows = collected.grid as SweepRow[] | undefined;
		expect(rows, "grid must run before the chart").toBeTruthy();

		// Both x and y must be finite. Filtering only on y let refused rows through
		// with a NaN pixels-per-module, one NaN reached Math.min, every coordinate
		// became NaN, and the chart shipped as an empty frame with plausible axis
		// labels -- which is worse than an error, because it looks finished.
		const byConfig = (label: string, az: number, pick: (r: SweepRow) => number) =>
			rows!
				.filter(
					(r) =>
						r.label === label &&
						r.azimuthDeg === az &&
						Number.isFinite(r.pxPerModule) &&
						Number.isFinite(pick(r)),
				)
				.sort((a, b) => a.pxPerModule - b.pxPerModule)
				.map((r) => ({ x: r.pxPerModule, y: pick(r) }));

		/**
		 * The interesting curves come from the gates-open sweep, not the gated grid.
		 * With the gates on, everything past the refusal threshold is absent by
		 * construction, so the gated data can only ever show the half of the story
		 * where nothing goes wrong. The whole point of the chart is the other half.
		 */
		const open = (collected.gateCalibration ?? []) as Record<string, number>[];
		const fromOpen = (key: string) =>
			open
				.filter((r) => Number.isFinite(r.pxPerModule) && Number.isFinite(r[key]))
				.sort((a, b) => a.pxPerModule! - b.pxPerModule!)
				.map((r) => ({ x: r.pxPerModule!, y: r[key]! }));

		const series: ChartSeries[] = [
			{
				label: "bearing p95, symbol only",
				colour: "#f2b134",
				points: byConfig("symbol only", 22, (r) => r.bearingP95),
			},
			{
				label: "bearing p95, + brackets",
				colour: "#4cc9f0",
				points: byConfig("full-bleed + brackets", 22, (r) => r.bearingP95),
			},
			{
				label: "bearing p95, gates off",
				colour: "#57d99a",
				points: fromOpen("bearingP95"),
				dashed: true,
			},
			{
				label: "distance error p95",
				colour: "#ef476f",
				points: fromOpen("distanceRelP95"),
				rightAxis: true,
			},
			{
				label: "decode rate",
				colour: "#8d99ae",
				points: fromOpen("decodeRate"),
				rightAxis: true,
				dashed: true,
			},
		];

		const svg = renderChart({
			title: "What degrades first as the marker gets smaller in frame",
			footnote:
				"synthetic 1280x960, v2 symbol, nominal degradation. Solid: gated sweep at azimuth 22 deg. Dashed green and the right axis: gates disabled, azimuth 12 deg.",
			xLabel: "pixels per module in the captured frame",
			yLabel: "bearing error, degrees (p95)",
			rightLabel: "rate",
			series,
			logX: true,
			logY: true,
			rightMax: 1,
		});
		const path = writeArtifact("error-chart.svg", svg);

		// An empty chart is a silent failure, so make it a loud one.
		expect(svg.length).toBeGreaterThan(2000);
		expect(svg, "no coordinate may be NaN").not.toContain("NaN");
		const plotted = [...svg.matchAll(/<circle cx="([\d.]+)"/g)].map((m) => Number(m[1]));
		expect(plotted.length, "the chart must actually plot points").toBeGreaterThan(12);
		// Points collapsed onto one x position means a broken axis, not a flat curve.
		expect(new Set(plotted.map((x) => Math.round(x))).size).toBeGreaterThan(3);
		console.log(`\n  wrote ${path} (${plotted.length} points)`);
	});

	/**
	 * The range table, computed from the measured gate rather than remembered.
	 * CONCEPT.md section 3 quotes "Z_max is about 8 x the display's height"; this
	 * recomputes it and writes the real number.
	 */
	it("derives the range table from the measured gate", () => {
		const displays = [
			{ name: '16" laptop', heightMm: 199 },
			{ name: '27" monitor', heightMm: 336 },
			{ name: '55" TV', heightMm: 685 },
			{ name: '100" projector', heightMm: 1245 },
		];
		const captures = [
			{ name: "1280x960", width: 1280 },
			{ name: "1920x1440", width: 1920 },
			{ name: "3840x2160", width: 3840 },
		];

		const table: Record<string, unknown>[] = [];
		console.log("\n  range table, computed from the solid-tier gate:");
		for (const capture of captures) {
			const focalPx = (capture.width * 26) / 36;
			// The full-bleed box is 88% of the display height, and the symbol is
			// N/(N+8) of that box. Both matter; the quiet zone is not the symbol.
			const symbolFractionOfHeight = 0.88 * (N / (N + 8));
			const range = estimateRange({
				focalPx,
				moduleCount: N,
				pxPerModuleGate: DEFAULT_GATES.solidPxPerModule,
				symbolEdgeMm: 1,
				symbolEdgeCssPx: symbolFractionOfHeight,
				displayHeightCssPx: 1,
			});
			for (const d of displays) {
				const symbolEdgeMm = d.heightMm * symbolFractionOfHeight;
				table.push({
					capture: capture.name,
					display: d.name,
					screenHeights: range.maxDistanceScreenHeights,
					metres: (range.maxDistanceEdges * symbolEdgeMm) / 1000,
				});
			}
			console.log(
				`    ${capture.name.padEnd(10)} ${range.maxDistanceScreenHeights.toFixed(1)} screen-heights   ` +
					displays
						.map(
							(d) =>
								`${d.name}: ${((range.maxDistanceEdges * d.heightMm * symbolFractionOfHeight) / 1000).toFixed(1)} m`,
						)
						.join("  "),
			);
		}
		collected.rangeTable = table;

		const at1920 = table.filter((r) => r.capture === "1920x1440");
		expect(at1920.length).toBe(displays.length);
		// Sanity band around CONCEPT.md's quotable "six to eight screen-heights".
		expect(at1920[0]!.screenHeights as number).toBeGreaterThan(4);
		expect(at1920[0]!.screenHeights as number).toBeLessThan(12);
	});
});

function fmt(v: number): string {
	return Number.isFinite(v) ? v.toFixed(2).padStart(7) : "      -";
}

function pct(v: number): string {
	return Number.isFinite(v) ? `${(v * 100).toFixed(0).padStart(5)}%` : "      -";
}
