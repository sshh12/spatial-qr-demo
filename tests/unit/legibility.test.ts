import {
	COMFORTABLE_ARCMIN,
	LEGIBLE_ARCMIN,
	legibleDistanceHeights,
	subtendedArcMin,
	TEXT_SIZES,
} from "@core/legibility.ts";
import { describe, expect, it } from "vitest";

describe("legible distance", () => {
	it("round-trips against the angle it was derived from", () => {
		for (const size of TEXT_SIZES) {
			const distance = legibleDistanceHeights(size.fraction);
			expect(subtendedArcMin(size.fraction, distance)).toBeCloseTo(LEGIBLE_ARCMIN, 6);
		}
	});

	it("puts slide body text at a plausible distance", () => {
		// 2.6% of display height at the 16-arcmin floor. On a 1080p 24-inch
		// monitor that is a 28px caption readable to about 1.9 m -- close enough
		// to the everyday experience of one that the constant is not nonsense.
		const heights = legibleDistanceHeights(0.026);
		expect(heights).toBeGreaterThan(5);
		expect(heights).toBeLessThan(6.5);
	});

	it("shortens the range when asked for comfortable rather than merely possible", () => {
		expect(legibleDistanceHeights(0.026, COMFORTABLE_ARCMIN)).toBeLessThan(
			legibleDistanceHeights(0.026, LEGIBLE_ARCMIN),
		);
	});

	it("scales linearly with text size, because it is pure trigonometry", () => {
		expect(legibleDistanceHeights(0.05)).toBeCloseTo(2 * legibleDistanceHeights(0.025), 10);
	});

	it("returns zero rather than infinity for nonsense inputs", () => {
		// This feeds a radius in the 3D scene; an infinity there is a blank canvas.
		expect(legibleDistanceHeights(0)).toBe(0);
		expect(legibleDistanceHeights(-1)).toBe(0);
		expect(legibleDistanceHeights(0.02, 0)).toBe(0);
		expect(subtendedArcMin(0.02, 0)).toBe(0);
	});
});
