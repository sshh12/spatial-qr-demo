import { applyHomography, homographyDLT } from "./homography.ts";
import type { LinearImage } from "./image.ts";
import type { Mat3 } from "./linalg.ts";
import {
	bracketModels,
	finderModelSquares,
	type MarkerLayout,
	type ModelSquare,
	makeCorrespondence,
	symbolModelCorners,
} from "./marker.ts";
import { refineCornerFromArms, refineQuad } from "./subpixel.ts";
import type { Correspondence, ImagePoint, ModelPoint } from "./types.ts";

/** What the barcode reader gives us, normalised across implementations. */
export interface DetectedSymbol {
	/** TL, TR, BR, BL of the symbol, in the symbol's own orientation. */
	readonly corners: readonly [ImagePoint, ImagePoint, ImagePoint, ImagePoint];
	readonly moduleCount: number;
	readonly text: string;
	readonly isMirrored: boolean;
}

export interface ExtractOptions {
	/** What the display says it is currently showing. Brackets come from here. */
	readonly layout?: MarkerLayout | null;
	/** Corners below this evidence score are discarded as unsupported. */
	readonly minCornerEvidence?: number;
	/** Reject quads whose corners come within this many pixels of the frame edge. */
	readonly borderMarginPx?: number;
}

export interface Extraction {
	readonly correspondences: Correspondence[];
	/** Apparent module size in pixels, from the refined fit. */
	readonly modulePx: number;
	readonly bracketCount: number;
	readonly finderCount: number;
	/** Features that could not be refined, by name; useful in the debug readout. */
	readonly dropped: string[];
	readonly touchesBorder: boolean;
	readonly isMirrored: boolean;
}

const DEFAULT_MIN_EVIDENCE = 0.12;

function projectSquare(H: Mat3, square: ModelSquare) {
	return square.corners.map((c) => applyHomography(H, c)) as unknown as readonly [
		ImagePoint,
		ImagePoint,
		ImagePoint,
		ImagePoint,
	];
}

function meanEdgeLength(pts: readonly ImagePoint[]): number {
	let total = 0;
	for (let i = 0; i < pts.length; i++) {
		const a = pts[i]!;
		const b = pts[(i + 1) % pts.length]!;
		total += Math.hypot(b.x - a.x, b.y - a.y);
	}
	return total / pts.length;
}

const SUFFIX = ["tl", "tr", "br", "bl"] as const;

/**
 * Turns a decoded symbol plus the raw frame into the correspondence set the
 * solver consumes.
 *
 * Two passes. The first refines the finder patterns using a homography built
 * from the detector's integer corners, which is good to a pixel or two. The
 * second rebuilds the homography from those sub-pixel points and re-runs
 * everything, which both tightens the finders and makes it possible to
 * extrapolate accurately out to the L-brackets at the display's true corners --
 * a long way outside the symbol, where a first-pass homography is not good
 * enough to land inside the refiner's search window.
 *
 * The detector's own corners are deliberately never used as correspondences.
 * They are integers, and feeding them to the solver alongside sub-pixel points
 * would pull the fit toward the rounding.
 */
export function extractCorrespondences(
	img: LinearImage,
	symbol: DetectedSymbol,
	options: ExtractOptions = {},
): Extraction {
	const minEvidence = options.minCornerEvidence ?? DEFAULT_MIN_EVIDENCE;
	const borderMargin = options.borderMarginPx ?? 2;
	const dropped: string[] = [];

	const touchesBorder = symbol.corners.some(
		(c) =>
			c.x < borderMargin ||
			c.y < borderMargin ||
			c.x > img.width - borderMargin ||
			c.y > img.height - borderMargin,
	);

	// Seed homography from the detector's four integer corners.
	const seedCorr = symbolModelCorners().map((m, i) =>
		makeCorrespondence(m, symbol.corners[i]!, "symbol-corner", 1),
	);
	let H = homographyDLT(seedCorr);
	let modulePx = meanEdgeLength(symbol.corners) / symbol.moduleCount;

	const squares = finderModelSquares(symbol.moduleCount);
	let refined: Correspondence[] = [];

	for (let pass = 0; pass < 2; pass++) {
		refined = [];
		dropped.length = 0;
		// The finder patterns have exactly one module of white clearance on their
		// inner side, so the search must stay well inside that.
		const radius = Math.max(1.2, 0.6 * modulePx);

		for (const square of squares) {
			const approx = projectSquare(H, square);
			const quad = refineQuad(img, approx, {
				searchRadiusPx: radius,
				samplesPerEdge: square.sideModules >= 7 ? 14 : 8,
			});
			if (!quad) {
				dropped.push(square.name);
				continue;
			}
			quad.corners.forEach((pt, i) => {
				const evidence = quad.cornerEvidence[i]!;
				if (evidence < minEvidence) {
					dropped.push(`${square.name}-${SUFFIX[i]}`);
					return;
				}
				refined.push(
					makeCorrespondence(square.corners[i]!, pt, square.kind, Math.min(1, evidence * 2)),
				);
			});
		}

		if (refined.length < 8) break;
		H = homographyDLT(refined);
		modulePx = estimateModulePx(H, symbol.moduleCount);
	}

	// L-brackets, at the display's true corners, far outside the symbol.
	let bracketCount = 0;
	if (options.layout?.brackets && refined.length >= 8) {
		for (const [index, model] of bracketModels(options.layout).entries()) {
			const corner = applyHomography(H, model.corner);
			const armA = applyHomography(H, model.armA);
			const armB = applyHomography(H, model.armB);
			if (!Number.isFinite(corner.x) || !Number.isFinite(corner.y)) {
				dropped.push(`bracket-${index}`);
				continue;
			}
			if (
				corner.x < -img.width ||
				corner.x > 2 * img.width ||
				corner.y < -img.height ||
				corner.y > 2 * img.height
			) {
				dropped.push(`bracket-${index}`);
				continue;
			}
			const thicknessPx = model.thicknessEdges * estimateEdgePx(H);
			const hit = refineCornerFromArms(img, corner, armA, armB, {
				searchRadiusPx: Math.max(1.2, Math.min(6, 0.4 * thicknessPx)),
				samplesPerEdge: 18,
			});
			if (!hit || hit.evidence < minEvidence) {
				dropped.push(`bracket-${index}`);
				continue;
			}
			bracketCount++;
			refined.push(
				makeCorrespondence(model.corner, hit.point, "bracket", Math.min(1, hit.evidence * 2)),
			);
		}
	}

	return {
		correspondences: refined,
		modulePx,
		bracketCount,
		finderCount: refined.filter((c) => c.kind.startsWith("finder")).length,
		dropped: [...dropped],
		touchesBorder,
		isMirrored: symbol.isMirrored,
	};
}

/** Apparent length of one symbol edge in pixels, from a homography. */
function estimateEdgePx(H: Mat3): number {
	const pts = symbolModelCorners().map((c) => applyHomography(H, c));
	return meanEdgeLength(pts);
}

function estimateModulePx(H: Mat3, moduleCount: number): number {
	return estimateEdgePx(H) / moduleCount;
}

/**
 * Recovers the four symbol corners from the refined correspondences, for the
 * "the maths agrees with the photograph" overlay on the freeze frame. This is
 * presentation only; the solver never sees it.
 */
export function refinedSymbolQuad(correspondences: readonly Correspondence[]): ImagePoint[] | null {
	if (correspondences.length < 4) return null;
	try {
		const H = homographyDLT(correspondences);
		return symbolModelCorners().map((c: ModelPoint) => applyHomography(H, c));
	} catch {
		return null;
	}
}
