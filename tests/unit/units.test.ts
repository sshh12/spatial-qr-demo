import type { SerialBranch } from "@client/capture/protocol.ts";
import { approximateMetres, readout, describe as say } from "@client/lib/units.ts";
import { describe, expect, it } from "vitest";

/**
 * The headline sentence, which is the only line most people read.
 *
 * Display heights are exact and metres are not, and the copy has to carry that
 * difference without a footnote -- so the exact figure leads and the metric one
 * follows in brackets, hedged. These tests pin the shape of that sentence,
 * because it is the one place in the product where an unhedged estimate would
 * read as a measurement.
 */

function branch(overrides: Partial<SerialBranch> = {}): SerialBranch {
	return {
		azimuthDeg: -31.4,
		elevationDeg: 8.2,
		distanceEdges: 7.2,
		camera: [0, 0, 0],
		bearingSigmaDeg: 1.4,
		distanceSigmaRel: 0.04,
		focalPx: 1400,
		focalSigmaLog: 0.15,
		rmsPx: 0.3,
		floorCovariance: [0.01, 0, 0, 0.01],
		...overrides,
	};
}

/** A 27" monitor: 336 mm tall, showing a 112 mm symbol. */
const MONITOR = { edgeToScreenHeight: 1 / 3, symbolEdgeMm: 112, sizeSigmaRel: 0.012 };

describe("the headline sentence", () => {
	it("leads with display heights and follows with metres", () => {
		// 7.2 edges x 1/3 = 2.4 display heights; 7.2 x 112 mm = 0.81 m. Arm's
		// length from a 27" monitor really is sub-metre, which is the case the
		// centimetre branch exists for.
		expect(say(readout(branch(), MONITOR))).toBe(
			"2.4 display heights back (about 81 cm), 31° to the left of the screen",
		);

		// The same geometry in front of a 55" TV: 685 mm tall, so 1.64 m back.
		const tv = { edgeToScreenHeight: 1 / 3, symbolEdgeMm: 685 / 3, sizeSigmaRel: 0.012 };
		expect(say(readout(branch(), tv))).toBe(
			"2.4 display heights back (about 1.6 m), 31° to the left of the screen",
		);
	});

	it("says centre without an angle when the camera was straight on", () => {
		const r = readout(branch({ azimuthDeg: 0.4 }), MONITOR);
		expect(say(r)).toContain("straight in front of the screen");
	});

	it("counts marker widths, not display heights, off a display", () => {
		// A printed code carries no screen height, so the dimensionless figure
		// changes what it counts -- but the physical size is still known, and the
		// metric distance is the more useful of the two in that case.
		const r = readout(branch(), { edgeToScreenHeight: 0, symbolEdgeMm: 112, sizeSigmaRel: 0.15 });
		expect(say(r)).toContain("marker widths back (about 81 cm)");
	});
});

describe("the metric figure", () => {
	it("switches to centimetres below a metre, because nobody says 0.4 m", () => {
		expect(approximateMetres(0.42)).toBe("42 cm");
		expect(approximateMetres(0.999)).toBe("100 cm");
		expect(approximateMetres(1)).toBe("1.0 m");
		expect(approximateMetres(12.34)).toBe("12.3 m");
	});

	it("is omitted rather than invented when there is no physical size", () => {
		// Better a sentence with one number in it than a confident "about 0.0 m".
		expect(approximateMetres(0)).toBeNull();
		expect(approximateMetres(Number.NaN)).toBeNull();
		expect(approximateMetres(Number.POSITIVE_INFINITY)).toBeNull();

		const r = readout(branch(), { edgeToScreenHeight: 1 / 3, symbolEdgeMm: 0, sizeSigmaRel: 0.15 });
		expect(say(r)).toBe("2.4 display heights back, 31° to the left of the screen");
	});
});
