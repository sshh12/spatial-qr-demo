import type { Mat3, Vec3 } from "./linalg.ts";

/** A point in image space, in pixels, origin at the top-left of the frame. */
export interface ImagePoint {
	readonly x: number;
	readonly y: number;
}

/**
 * A point on the marker plane in *marker-edge units*: the symbol spans exactly
 * 1.0 in x and y, the origin is the symbol centre, +x is the viewer's right and
 * +y is up. Working in edge units rather than millimetres is what makes the
 * whole pipeline scale-free — physical size is applied once, at presentation.
 */
export interface ModelPoint {
	readonly x: number;
	readonly y: number;
}

export type FeatureKind = "symbol-corner" | "finder-outer" | "finder-inner" | "bracket";

export interface Correspondence {
	readonly model: ModelPoint;
	readonly image: ImagePoint;
	/** Relative weight; 1 is nominal. Lower means a less trustworthy corner. */
	readonly weight: number;
	readonly kind: FeatureKind;
}

/** Pinhole intrinsics with square pixels and no skew. */
export interface Intrinsics {
	readonly f: number;
	readonly cx: number;
	readonly cy: number;
}

export interface FocalPrior {
	/** Prior mean of the focal length in pixels for this frame's resolution. */
	readonly f0: number;
	/** Prior standard deviation of log(f). 0.15 is the generic 26mm-equivalent. */
	readonly sigmaLog: number;
	/** Provenance, for the readout. */
	readonly source: "generic" | "commons" | "measured" | "supplied";
}

/**
 * One of the two poses that a planar marker admits. Both are always computed;
 * the UI is allowed to see both.
 */
export interface PoseBranch {
	/** Marker frame -> camera frame. */
	readonly R: Mat3;
	/** Marker origin in camera frame, in marker-edge units. */
	readonly t: Vec3;
	/** Camera centre in marker frame, in marker-edge units. */
	readonly camera: Vec3;
	/** Signed degrees; positive means the viewer stood to their own right. */
	readonly azimuthDeg: number;
	/** Signed degrees; positive means the viewer stood above marker centre. */
	readonly elevationDeg: number;
	/** Straight-line distance from camera to marker centre, in marker edges. */
	readonly distanceEdges: number;
	/** Focal length in pixels that this branch settled on. */
	readonly focalPx: number;
	/** RMS reprojection error in pixels. */
	readonly rmsPx: number;
	/** Negative log posterior at the optimum (pixel term + focal prior term). */
	readonly cost: number;
	/** 1-sigma of log(f) from the curvature of the cost in log f. */
	readonly focalSigmaLog: number;
	/**
	 * 2x2 covariance of the camera's floor position (x, z) in squared marker-edge
	 * units. Row-major [xx, xz, zx, zz].
	 */
	readonly floorCovariance: readonly [number, number, number, number];
	/**
	 * Predicted 1-sigma bearing uncertainty for *this* frame, in degrees: the
	 * tangential part of the floor covariance divided by the horizontal distance.
	 * This is the number the error bar shows and the number the gate uses -- one
	 * computation, so the refusal threshold and the claim can never drift apart.
	 */
	readonly bearingSigmaDeg: number;
	/** Predicted 1-sigma relative distance uncertainty, dimensionless. */
	readonly distanceSigmaRel: number;
}

export type ConfidenceTier = "solid" | "soft" | "refused";

export interface RefusalReason {
	readonly code:
		| "too-few-points"
		| "degenerate"
		| "implausible-pose"
		| "high-residual"
		| "ambiguous"
		| "marker-too-small"
		| "touches-border"
		| "mirrored";
	readonly detail: string;
}

export interface PoseSolution {
	readonly primary: PoseBranch;
	readonly alternate: PoseBranch;
	/**
	 * Evidence ratio for the primary branch: SSE(alternate) / SSE(primary), both
	 * at their own optimal focal length. Infinity when the two branches are the
	 * same pose (a head-on view, where the flip is geometrically meaningless).
	 */
	readonly branchMargin: number;
	/** Angle between the two branches' camera directions, in degrees. */
	readonly branchSeparationDeg: number;
	readonly tier: ConfidenceTier;
	readonly refusal: RefusalReason | null;
	readonly pointCount: number;
	/** Apparent size of the marker in the frame, in pixels per module. */
	readonly pxPerModule: number;
	readonly intrinsics: Intrinsics;
	readonly prior: FocalPrior;
	/** Milliseconds spent inside the solver. */
	readonly solveMs: number;
}

/** Everything the presentation layer needs to turn edge units into the world. */
export interface DisplaySpec {
	/**
	 * The symbol edge in millimetres: finder-outer-corner to finder-outer-corner,
	 * EXCLUDING the 4-module quiet zone. Getting this wrong by including the
	 * quiet zone overstates distance by 32% at version 2.
	 */
	readonly markerEdgeMm: number;
	/** The same edge expressed in CSS pixels on the display that rendered it. */
	readonly markerEdgeCssPx: number;
	/** The display's viewport height in CSS pixels. */
	readonly displayHeightCssPx: number;
	/** Relative 1-sigma on markerEdgeMm. 0.0 when card-ruler measured. */
	readonly sizeSigmaRel: number;
	readonly aspectNum: number;
	readonly aspectDen: number;
	readonly surface: Surface;
}

export type Surface = "monitor" | "laptop" | "tv" | "projector" | "print" | "phone";

export const SURFACES: readonly Surface[] = [
	"monitor",
	"laptop",
	"tv",
	"projector",
	"print",
	"phone",
];
