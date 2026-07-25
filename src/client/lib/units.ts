import type { WirePose } from "@core/api.ts";
import type { SerialBranch } from "../capture/protocol.ts";

/**
 * Turning marker edges into things a person can read.
 *
 * The solver works in marker-edge units, which is what makes the whole pipeline
 * scale-free. Two conversions come out of that, and they are not equally good:
 *
 *  - display heights is a ratio of two lengths measured in the same CSS pixels,
 *    so nothing anyone guessed enters into it. It is exact.
 *  - metres needs the physical size of the display and the camera's focal
 *    length, and both are estimates. So metres carries a visible bar, and it is
 *    never the number the page leads with.
 *
 * That ordering is the single decision that makes the screenshot case, the
 * unknown-display-size case, TV overscan and the wrong-lens case all degrade
 * gracefully instead of embarrassingly.
 */

export interface DisplayContext {
	/**
	 * Symbol edge divided by display height. Dimensionless, so it carries no
	 * uncertainty at all: it is a ratio of two lengths measured in the same
	 * pixels. Zero when the marker is not on a display, in which case distance is
	 * reported in marker widths.
	 */
	readonly edgeToScreenHeight: number;
	/** Symbol edge in millimetres. */
	readonly symbolEdgeMm: number;
	/** Relative 1-sigma on the physical size. Near zero when card-ruler measured. */
	readonly sizeSigmaRel: number;
}

export interface Readout {
	readonly azimuthDeg: number;
	readonly azimuthSigmaDeg: number;
	readonly elevationDeg: number;
	readonly elevationSigmaDeg: number;
	/** Exact: a ratio of two lengths in the same units. */
	readonly screenHeights: number;
	readonly screenHeightsSigma: number;
	/** What that figure counts, so the label never lies. */
	readonly dimensionlessUnit: "display heights" | "marker widths";
	/** Derived, and only as good as two guesses. */
	readonly metres: number;
	readonly metresSigma: number;
	/** Where the person probably was, as opposed to where their phone was. */
	readonly eyes: { readonly metres: number; readonly screenHeights: number };
	readonly side: "left" | "right" | "centre";
}

/**
 * Arm extension, the largest real-world error in the system.
 *
 * We measure a camera. At arm's length that camera is roughly 40 cm in front of
 * the person holding it and 25 cm below their eyes, and at 1.5 m that is a
 * 27-40% distance error -- larger than the entire focal-length budget the rest
 * of the pipeline works so hard on. It is shown as a toggle rather than buried
 * in a footnote, because a demo that quietly reports the phone's position as the
 * viewer's position is wrong in a way the viewer can feel.
 */
export const ARM_LENGTH_M = 0.4;
export const EYE_RISE_M = 0.25;

export function readout(branch: SerialBranch, display: DisplayContext): Readout {
	const onDisplay = display.edgeToScreenHeight > 0;
	const ratio = onDisplay ? display.edgeToScreenHeight : 1;
	const screenHeights = branch.distanceEdges * ratio;
	const metresPerEdge = display.symbolEdgeMm / 1000;
	const metres = branch.distanceEdges * metresPerEdge;

	// The dimensionless distance is limited only by pixel noise; the metric one
	// additionally inherits the physical-size uncertainty.
	const relPixel = branch.distanceSigmaRel;
	const relMetric = Math.hypot(relPixel, display.sizeSigmaRel);

	const eyesMetres = Math.max(0.05, metres - ARM_LENGTH_M);

	return {
		azimuthDeg: branch.azimuthDeg,
		azimuthSigmaDeg: branch.bearingSigmaDeg,
		elevationDeg: branch.elevationDeg,
		elevationSigmaDeg: branch.bearingSigmaDeg,
		screenHeights,
		screenHeightsSigma: screenHeights * relPixel,
		dimensionlessUnit: onDisplay ? "display heights" : "marker widths",
		metres,
		metresSigma: metres * relMetric,
		eyes: {
			metres: eyesMetres,
			// The same ratio, applied to the dimensionless figure.
			screenHeights: metres > 1e-6 ? screenHeights * (eyesMetres / metres) : screenHeights,
		},
		side: branch.azimuthDeg > 2 ? "right" : branch.azimuthDeg < -2 ? "left" : "centre",
	};
}

/** The four numbers that go on the wire, and nothing else. */
export function toWirePose(branch: SerialBranch, display: DisplayContext): WirePose {
	const ratio = display.edgeToScreenHeight > 0 ? display.edgeToScreenHeight : 1;
	const dh = branch.distanceEdges * ratio;
	// A single positional sigma, taken as the larger of the two principal
	// directions so the shared room never draws someone more confidently than
	// their own screen did.
	const cov = branch.floorCovariance;
	const trace = cov[0] + cov[3];
	const det = cov[0] * cov[3] - cov[1] * cov[2];
	const major = Math.sqrt(Math.max(0, trace / 2 + Math.sqrt(Math.max(0, (trace / 2) ** 2 - det))));
	return {
		az: round(branch.azimuthDeg, 2),
		el: round(branch.elevationDeg, 2),
		dh: round(dh, 3),
		sd: round(Math.max(major * ratio, 1e-3), 4),
	};
}

function round(v: number, places: number): number {
	const k = 10 ** places;
	return Math.round(v * k) / k;
}

export function formatSigned(value: number, digits = 0): string {
	const sign = value > 0 ? "+" : value < 0 ? "−" : "";
	return `${sign}${Math.abs(value).toFixed(digits)}`;
}

export function formatDistance(value: number, sigma: number, unit: string): string {
	const digits = value < 10 ? 2 : 1;
	return `${value.toFixed(digits)} ± ${sigma.toFixed(digits)} ${unit}`;
}

/** Plain-language description of where somebody stood, as they would say it. */
export function describe(readout: Readout): string {
	const side =
		readout.side === "centre"
			? "straight in front of"
			: `${Math.abs(readout.azimuthDeg).toFixed(0)}° to the ${readout.side} of`;
	const metric = approximateMetres(readout.metres);
	return `${readout.screenHeights.toFixed(1)} ${readout.dimensionlessUnit} back${
		metric ? ` (about ${metric})` : ""
	}, ${side} the screen`;
}

/**
 * The distance a person actually came for, in brackets, hedged.
 *
 * The exact figure still leads the sentence: it is a ratio of two lengths in
 * the same pixels, so nothing anyone guessed enters into it. But nobody can
 * picture "2.4 display heights", and the number they could check with a tape
 * measure is the one that makes the result feel true -- so it belongs in the
 * headline rather than only in the stats. "About" is doing real work: this
 * figure inherits the display's physical size and the camera's focal length,
 * both estimated. The ± bar stays a few lines below, where there is room to
 * state it properly.
 */
export function approximateMetres(metres: number): string | null {
	if (!Number.isFinite(metres) || metres <= 0) return null;
	// Centimetres below a metre, because "0.4 m" is a figure nobody says aloud.
	if (metres < 1) return `${Math.round(metres * 100)} cm`;
	return `${metres.toFixed(1)} m`;
}

/** The default assumption when nobody has run the card ruler. */
export const DEFAULT_MM_PER_CSS_PX = 25.4 / 96;
export const DEFAULT_SIZE_SIGMA_REL = 0.15;
export const MEASURED_SIZE_SIGMA_REL = 0.012;

/** ISO/IEC 7810 ID-1: every bank card in the world, to within 0.3%. */
export const CARD_WIDTH_MM = 85.6;
export const CARD_HEIGHT_MM = 53.98;
