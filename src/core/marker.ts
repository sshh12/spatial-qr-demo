import type { Correspondence, FeatureKind, ImagePoint, ModelPoint } from "./types.ts";

/** QR mandates a 4-module quiet zone. It is NOT part of the symbol edge. */
export const QUIET_ZONE_MODULES = 4;

/** Modules along one edge of a QR symbol of the given version. */
export function moduleCountForVersion(version: number): number {
	return 17 + 4 * version;
}

export function versionForModuleCount(moduleCount: number): number {
	return (moduleCount - 17) / 4;
}

/**
 * A description of exactly what is on the display right now, in CSS pixels.
 * The phone never guesses this -- it is handed over the session channel, which
 * is also what makes the idle/full-bleed swap safe.
 */
export interface MarkerLayout {
	readonly id: "idle" | "fullbleed";
	readonly moduleCount: number;
	/** Symbol edge, finder-outer to finder-outer, excluding the quiet zone. */
	readonly symbolEdgeCssPx: number;
	/** The same edge in millimetres. The single most error-prone number here. */
	readonly symbolEdgeMm: number;
	readonly viewportCssPx: { readonly w: number; readonly h: number };
	/** Symbol centre, in CSS pixels from the viewport's top-left. */
	readonly symbolCentreCssPx: { readonly x: number; readonly y: number };
	/** The four L-brackets, ordered TL, TR, BR, BL. Null when none are drawn. */
	readonly brackets: readonly BracketSpec[] | null;
	/** Rotating value baked into the payload; a screenshot carries a stale one. */
	readonly nonce: string;
}

/**
 * One L-bracket, in CSS pixels from the viewport's top-left. Only the outer
 * corner is used as a correspondence -- it is the point pinned to the true
 * display corner. The arm ends describe the two outer edges that are fitted to
 * find it.
 */
export interface BracketSpec {
	readonly corner: { readonly x: number; readonly y: number };
	readonly armA: { readonly x: number; readonly y: number };
	readonly armB: { readonly x: number; readonly y: number };
	readonly thicknessCssPx: number;
}

// ---------------------------------------------------------------------------
// Model geometry
// ---------------------------------------------------------------------------

/**
 * Module grid coordinate -> model coordinate in marker-edge units.
 * Columns run left to right, rows run top to bottom, and the model frame has
 * +y up, so the row term is negated.
 */
export function moduleToModel(col: number, row: number, moduleCount: number): ModelPoint {
	return { x: col / moduleCount - 0.5, y: 0.5 - row / moduleCount };
}

/** The four symbol corners: top-left, top-right, bottom-right, bottom-left. */
export function symbolModelCorners(): ModelPoint[] {
	return [
		{ x: -0.5, y: 0.5 },
		{ x: 0.5, y: 0.5 },
		{ x: 0.5, y: -0.5 },
		{ x: -0.5, y: -0.5 },
	];
}

export interface ModelSquare {
	readonly kind: FeatureKind;
	readonly name: string;
	/** TL, TR, BR, BL in model coordinates. */
	readonly corners: readonly [ModelPoint, ModelPoint, ModelPoint, ModelPoint];
	/** Side length in modules; the refiner uses it to size its search window. */
	readonly sideModules: number;
	/** True when the square is black on white (all of ours are). */
	readonly dark: boolean;
}

function square(
	kind: FeatureKind,
	name: string,
	c0: number,
	r0: number,
	side: number,
	moduleCount: number,
): ModelSquare {
	return {
		kind,
		name,
		corners: [
			moduleToModel(c0, r0, moduleCount),
			moduleToModel(c0 + side, r0, moduleCount),
			moduleToModel(c0 + side, r0 + side, moduleCount),
			moduleToModel(c0, r0 + side, moduleCount),
		],
		sideModules: side,
		dark: true,
	};
}

/**
 * The six squares that a QR symbol is *guaranteed* to contain regardless of
 * payload: each finder pattern's 7x7 outer ring and its 3x3 core. Both are
 * surrounded by white on all four sides (quiet zone outside, separator inside),
 * so every one of their 24 corners has real gradient evidence to lock onto.
 *
 * The symbol's own outer boundary is deliberately not used for refinement: away
 * from the finders it borders arbitrary data modules, so most of that edge has
 * no contrast at all and "refining" it invents corners.
 */
export function finderModelSquares(moduleCount: number): ModelSquare[] {
	const n = moduleCount;
	return [
		square("finder-outer", "finder-tl-outer", 0, 0, 7, n),
		square("finder-outer", "finder-tr-outer", n - 7, 0, 7, n),
		square("finder-outer", "finder-bl-outer", 0, n - 7, 7, n),
		square("finder-inner", "finder-tl-inner", 2, 2, 3, n),
		square("finder-inner", "finder-tr-inner", n - 5, 2, 3, n),
		square("finder-inner", "finder-bl-inner", 2, n - 5, 3, n),
	];
}

/** CSS pixel position on the display -> model coordinate in marker edges. */
export function cssToModel(
	layout: MarkerLayout,
	css: { readonly x: number; readonly y: number },
): ModelPoint {
	return {
		x: (css.x - layout.symbolCentreCssPx.x) / layout.symbolEdgeCssPx,
		y: -(css.y - layout.symbolCentreCssPx.y) / layout.symbolEdgeCssPx,
	};
}

/**
 * Bracket outer corners in model coordinates.
 *
 * On 16:9 a full-bleed square symbol spans the full height but only 56% of the
 * width. Brackets pinned to the true viewport corners stretch the horizontal
 * baseline by 1.78x, and azimuth -- the headline number, and the one whose sign
 * people can actually check -- is exactly what a wider horizontal baseline buys.
 */
export function bracketModelPoints(layout: MarkerLayout): ModelPoint[] {
	if (!layout.brackets) return [];
	return layout.brackets.map((b) => cssToModel(layout, b.corner));
}

export interface BracketModel {
	readonly corner: ModelPoint;
	readonly armA: ModelPoint;
	readonly armB: ModelPoint;
	/** Arm thickness in marker-edge units; bounds the refiner's search radius. */
	readonly thicknessEdges: number;
}

export function bracketModels(layout: MarkerLayout): BracketModel[] {
	if (!layout.brackets) return [];
	return layout.brackets.map((b) => ({
		corner: cssToModel(layout, b.corner),
		armA: cssToModel(layout, b.armA),
		armB: cssToModel(layout, b.armB),
		thicknessEdges: b.thicknessCssPx / layout.symbolEdgeCssPx,
	}));
}

// ---------------------------------------------------------------------------
// Correspondence assembly
// ---------------------------------------------------------------------------

export function makeCorrespondence(
	model: ModelPoint,
	image: ImagePoint,
	kind: FeatureKind,
	weight = 1,
): Correspondence {
	return { model, image, kind, weight };
}

// ---------------------------------------------------------------------------
// Range
// ---------------------------------------------------------------------------

export interface RangeEstimate {
	/** Furthest usable distance, in marker edges. */
	readonly maxDistanceEdges: number;
	/** The same distance in metres, using the declared physical size. */
	readonly maxDistanceM: number;
	/** The same distance in display heights -- dimensionless, hence exact. */
	readonly maxDistanceScreenHeights: number;
}

/**
 * The range table, computed rather than remembered.
 *
 * Apparent symbol edge in pixels is f / Z_edges, so pixels per module is
 * f / (Z_edges * N). Setting that equal to the gate and solving gives the
 * furthest distance at which a solve can still reach the requested tier. This
 * moves when the payload gets longer (more modules) or the capture resolution
 * changes, which is exactly why it must never be a constant in the source.
 */
export function estimateRange(params: {
	readonly focalPx: number;
	readonly moduleCount: number;
	readonly pxPerModuleGate: number;
	readonly symbolEdgeMm: number;
	readonly symbolEdgeCssPx: number;
	readonly displayHeightCssPx: number;
}): RangeEstimate {
	const maxDistanceEdges = params.focalPx / (params.moduleCount * params.pxPerModuleGate);
	return {
		maxDistanceEdges,
		maxDistanceM: (maxDistanceEdges * params.symbolEdgeMm) / 1000,
		maxDistanceScreenHeights:
			(maxDistanceEdges * params.symbolEdgeCssPx) / params.displayHeightCssPx,
	};
}

/**
 * Focal length in pixels implied by a 35mm-equivalent focal length at a given
 * capture width. 26mm-equivalent is the modern phone main-camera default.
 */
export function focalPxFromEquiv(captureWidthPx: number, equivMm = 26): number {
	// 35mm frame is 36mm wide; f_px / width_px = f_equiv / 36.
	return (captureWidthPx * equivMm) / 36;
}
