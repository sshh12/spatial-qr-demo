import { moduleCountForVersion } from "@core/marker.ts";
import { beforeAll, describe, expect, it } from "vitest";
import { defaultCamera } from "../support/correspondences.ts";
import { runCase } from "../support/pipeline.ts";
import { makeDisplay } from "../support/render.ts";
import { prepareZXing } from "../support/zxing-node.ts";

const PAYLOAD = "HTTPS://EXAMPLE.COM/S/K7F2QX";

describe("L2: end to end on synthetic frames", () => {
	beforeAll(() => {
		prepareZXing();
	});

	it("decodes, refines and solves a clean full-bleed capture", async () => {
		const camera = defaultCamera(1280, 960);
		const display = makeDisplay({ text: PAYLOAD }, { mode: "fullbleed", withBrackets: true });
		const outcome = await runCase({
			view: { azimuthDeg: 24, elevationDeg: 11, distanceEdges: 4 },
			camera,
			display,
			useBrackets: true,
			degradations: { blurPx: 0.5, noiseLevels: 1.5, seed: 1 },
			priorSigmaLog: 0.15,
		});

		expect(outcome.error).toBeNull();
		expect(outcome.decoded).toBe(true);
		expect(outcome.solution?.tier).not.toBe("refused");
		expect(outcome.extraction?.correspondences.length).toBeGreaterThanOrEqual(20);
		expect(outcome.bracketCount).toBe(4);
		expect(Math.abs(outcome.azimuthErrorDeg)).toBeLessThan(2);
		expect(Math.abs(outcome.elevationErrorDeg)).toBeLessThan(2);
		expect(Math.abs(outcome.distanceRelError)).toBeLessThan(0.2);
		expect(outcome.flipped).toBe(false);
	});

	it("uses the symbol edge, not the quiet-zone box", async () => {
		// CONCEPT.md section 4. The renderer sizes the quiet-zone-inclusive box to
		// 88% of the viewport and derives the symbol edge from it. If the two were
		// confused anywhere in the chain, the recovered distance would be wrong by
		// (N+8)/N -- 32% at version 2 -- while every angle stayed perfect. That is
		// exactly the signature this test looks for.
		const camera = defaultCamera(1280, 960);
		const display = makeDisplay({ text: PAYLOAD }, { mode: "fullbleed" });
		const n = moduleCountForVersion(2);
		expect(display.modules.size).toBe(n);

		const boxCss = display.heightCss * 0.88;
		expect(display.symbolEdgeCss).toBeCloseTo((boxCss * n) / (n + 8), 6);
		// The trap, stated numerically: 32% at version 2.
		expect((n + 8) / n).toBeCloseTo(1.32, 2);

		const outcome = await runCase({
			view: { azimuthDeg: 18, elevationDeg: 8, distanceEdges: 5 },
			camera,
			display,
			degradations: { blurPx: 0.5, noiseLevels: 1.5, seed: 2 },
		});
		expect(outcome.error).toBeNull();
		expect(Math.abs(outcome.distanceRelError)).toBeLessThan(0.2);
	});

	it("refines corners well below the detector's integer quantisation", async () => {
		const camera = defaultCamera(1280, 960);
		const display = makeDisplay({ text: PAYLOAD }, { mode: "fullbleed" });
		const outcome = await runCase({
			view: { azimuthDeg: 30, elevationDeg: 10, distanceEdges: 4 },
			camera,
			display,
			degradations: { blurPx: 0.6, noiseLevels: 1.0, seed: 3 },
		});
		expect(outcome.solution).not.toBeNull();
		// Residual RMS well under a pixel is the observable consequence of the
		// refinement; the raw detector corners are integers and could not achieve it.
		expect(outcome.solution!.primary.rmsPx).toBeLessThan(0.8);
	});
});
