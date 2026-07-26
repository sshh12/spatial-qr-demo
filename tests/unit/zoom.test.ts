import {
	BASE_FOCAL_SIGMA_LOG,
	lensFactor,
	lensZoomState,
	NO_ZOOM,
	scaledRangeM,
	type ZoomMode,
	zoomSteps,
} from "@client/capture/zoom.ts";
import { describe, expect, it } from "vitest";

/**
 * The prior is the whole feature.
 *
 * Range is linear in focal length, so zoom is the largest single lever there
 * is -- but the solver reaches its answer by MAP against a focal prior, and a
 * prior left at 26mm-equivalent while the lens sits at 3x will quietly drag the
 * reported distance with a healthy-looking residual. These tests pin the two
 * properties that stop that: the centre moves with the factor, and the width
 * widens when the factor was inferred rather than measured.
 */

describe("the focal prior under zoom", () => {
	it("scales the centre by the factor", () => {
		const state = lensZoomState({ deviceId: "d", label: "Back Telephoto Camera", factor: 2.5 });
		expect(state.focalScale).toBe(2.5);
	});

	it("widens the prior when the factor came from a label, not the driver", () => {
		const tele = lensZoomState({ deviceId: "d", label: "Back Telephoto Camera", factor: 2.5 });
		expect(tele.measured).toBe(false);
		// Apple ships 2x, 2.5x, 3x and 5x under labels that do not distinguish
		// them, so this prior has to span a factor of two and a half.
		expect(tele.focalSigmaLog).toBeGreaterThan(BASE_FOCAL_SIGMA_LOG);
	});

	it("leaves the prior alone for a plain main camera", () => {
		const main = lensZoomState({ deviceId: "d", label: "Back Camera", factor: 1 });
		expect(main.focalSigmaLog).toBe(BASE_FOCAL_SIGMA_LOG);
		expect(NO_ZOOM.focalScale).toBe(1);
	});
});

describe("lens labels", () => {
	it("reads the factor Apple's names imply", () => {
		expect(lensFactor("Back Camera")).toBe(1);
		expect(lensFactor("Back Ultra Wide Camera")).toBe(0.5);
		expect(lensFactor("Back Telephoto Camera")).toBe(2.5);
	});

	it("skips the composite devices, which switch modules on their own", () => {
		// Picking one of these buys nothing over the plain back camera, and its
		// effective focal length is unknowable before the capture.
		expect(lensFactor("Back Dual Wide Camera")).toBeNull();
		expect(lensFactor("Back Triple Camera")).toBeNull();
		expect(lensFactor("Some Unfamiliar Camera")).toBeNull();
	});
});

describe("the offered steps", () => {
	it("offers nothing when the camera cannot zoom", () => {
		expect(zoomSteps({ kind: "none" })).toEqual([]);
	});

	it("offers whole stops up to the driver's maximum", () => {
		expect(zoomSteps({ kind: "constraint", min: 1, max: 3 })).toEqual([1, 2, 3]);
		expect(zoomSteps({ kind: "constraint", min: 1, max: 2.4 })).toEqual([1, 2]);
	});

	it("still offers the maximum when it falls well past the last whole stop", () => {
		expect(zoomSteps({ kind: "constraint", min: 1, max: 8 })).toEqual([1, 2, 3, 5, 8]);
	});

	it("offers one button per physical lens", () => {
		const mode: ZoomMode = {
			kind: "lens",
			lenses: [
				{ deviceId: "a", label: "Back Ultra Wide Camera", factor: 0.5 },
				{ deviceId: "b", label: "Back Camera", factor: 1 },
				{ deviceId: "c", label: "Back Telephoto Camera", factor: 2.5 },
			],
		};
		expect(zoomSteps(mode)).toEqual([0.5, 1, 2.5]);
	});
});

describe("the range promise", () => {
	it("moves linearly, which is the reason to offer zoom at all", () => {
		// maxDistance = f / (moduleCount * gate), and zoom multiplies f.
		expect(scaledRangeM(2, { ...NO_ZOOM, factor: 3, focalScale: 3 })).toBe(6);
	});
});
