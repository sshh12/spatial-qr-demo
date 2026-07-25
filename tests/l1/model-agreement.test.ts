import { finderModelSquares, moduleCountForVersion, symbolModelCorners } from "@core/marker.ts";
import { describe, expect, it } from "vitest";
import { gtModelPoints } from "../support/groundtruth.ts";

/**
 * The generator writes out the QR module geometry independently of the solver.
 * That independence is only worth anything if a disagreement is caught, so this
 * test pins the two against each other explicitly. Everything downstream is
 * then free to assume they describe the same physical square.
 */
describe("model geometry agreement", () => {
	for (const version of [2, 3, 4, 5]) {
		const n = moduleCountForVersion(version);

		it(`v${version} (${n} modules) matches the independent derivation`, () => {
			const theirs = new Map(gtModelPoints(n).map((p) => [p.label, p]));

			const corners = symbolModelCorners();
			const cornerLabels = ["symbol-tl", "symbol-tr", "symbol-br", "symbol-bl"];
			corners.forEach((c, i) => {
				const t = theirs.get(cornerLabels[i]!)!;
				expect(c.x).toBeCloseTo(t.x, 12);
				expect(c.y).toBeCloseTo(t.y, 12);
			});

			const suffixes = ["tl", "tr", "br", "bl"];
			for (const sq of finderModelSquares(n)) {
				sq.corners.forEach((c, i) => {
					const t = theirs.get(`${sq.name}-${suffixes[i]}`);
					expect(t, `${sq.name}-${suffixes[i]} missing`).toBeDefined();
					expect(c.x).toBeCloseTo(t!.x, 12);
					expect(c.y).toBeCloseTo(t!.y, 12);
				});
			}
		});
	}

	it("counts modules per the QR version formula", () => {
		expect(moduleCountForVersion(1)).toBe(21);
		expect(moduleCountForVersion(2)).toBe(25);
		expect(moduleCountForVersion(4)).toBe(33);
		expect(moduleCountForVersion(40)).toBe(177);
	});

	it("puts the symbol corners at +-0.5 so the edge is exactly one unit", () => {
		const c = symbolModelCorners();
		expect(Math.hypot(c[1]!.x - c[0]!.x, c[1]!.y - c[0]!.y)).toBeCloseTo(1, 12);
		expect(Math.hypot(c[2]!.x - c[1]!.x, c[2]!.y - c[1]!.y)).toBeCloseTo(1, 12);
	});
});
