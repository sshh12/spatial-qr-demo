import { type Mat3, Matrix, mat3Inverse, mat3Mul, nullVector } from "./linalg.ts";
import type { Correspondence, ImagePoint, ModelPoint } from "./types.ts";

interface Normalisation {
	readonly T: Mat3;
	readonly scale: number;
	readonly cx: number;
	readonly cy: number;
}

/**
 * Hartley normalisation: translate the centroid to the origin and scale so the
 * mean distance from it is sqrt(2). Skipping this step is the single most common
 * way to get a homography that looks fine on synthetic data and falls apart on
 * real pixel coordinates in the thousands.
 */
function normalise(points: readonly { x: number; y: number }[]): Normalisation {
	let cx = 0;
	let cy = 0;
	for (const p of points) {
		cx += p.x;
		cy += p.y;
	}
	cx /= points.length;
	cy /= points.length;

	let meanDist = 0;
	for (const p of points) meanDist += Math.hypot(p.x - cx, p.y - cy);
	meanDist /= points.length;

	const scale = meanDist > 1e-12 ? Math.SQRT2 / meanDist : 1;
	const T: Mat3 = [scale, 0, -scale * cx, 0, scale, -scale * cy, 0, 0, 1];
	return { T, scale, cx, cy };
}

/**
 * Normalised DLT homography mapping model-plane points to image points.
 *
 * Needs at least 4 correspondences; more are used in a least-squares sense.
 */
export function homographyDLT(corr: readonly Correspondence[]): Mat3 {
	if (corr.length < 4) {
		throw new Error(`homographyDLT: need >= 4 correspondences, got ${corr.length}`);
	}

	const model = corr.map((c) => c.model);
	const image = corr.map((c) => c.image);
	const nm = normalise(model);
	const ni = normalise(image);

	const A = new Matrix(2 * corr.length, 9);
	for (let k = 0; k < corr.length; k++) {
		const c = corr[k]!;
		const X = (c.model.x - nm.cx) * nm.scale;
		const Y = (c.model.y - nm.cy) * nm.scale;
		const u = (c.image.x - ni.cx) * ni.scale;
		const v = (c.image.y - ni.cy) * ni.scale;
		const w = Math.sqrt(Math.max(c.weight, 0));

		const r0 = 2 * k;
		const r1 = r0 + 1;
		A.set(r0, 0, -X * w);
		A.set(r0, 1, -Y * w);
		A.set(r0, 2, -1 * w);
		A.set(r0, 6, u * X * w);
		A.set(r0, 7, u * Y * w);
		A.set(r0, 8, u * w);

		A.set(r1, 3, -X * w);
		A.set(r1, 4, -Y * w);
		A.set(r1, 5, -1 * w);
		A.set(r1, 6, v * X * w);
		A.set(r1, 7, v * Y * w);
		A.set(r1, 8, v * w);
	}

	const h = nullVector(A);
	const Hn: Mat3 = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, h[8]!];

	// Undo the normalisation: H = Ti^-1 * Hn * Tm
	const H = mat3Mul(mat3Inverse(ni.T), mat3Mul(Hn, nm.T));

	// Fix the arbitrary scale so that H[8] is 1 where possible; keeps the numbers
	// interpretable when they are printed in the debug readout.
	const denom = H[8];
	if (Math.abs(denom) > 1e-12) {
		return H.map((v) => v / denom) as unknown as Mat3;
	}
	return H;
}

/** Applies a homography to a model point, returning image coordinates. */
export function applyHomography(H: Mat3, p: ModelPoint): ImagePoint {
	const w = H[6] * p.x + H[7] * p.y + H[8];
	if (Math.abs(w) < 1e-12) return { x: Number.NaN, y: Number.NaN };
	return {
		x: (H[0] * p.x + H[1] * p.y + H[2]) / w,
		y: (H[3] * p.x + H[4] * p.y + H[5]) / w,
	};
}

/** RMS reprojection error of a homography over its correspondences, in pixels. */
export function homographyRms(H: Mat3, corr: readonly Correspondence[]): number {
	let sse = 0;
	for (const c of corr) {
		const p = applyHomography(H, c.model);
		sse += (p.x - c.image.x) ** 2 + (p.y - c.image.y) ** 2;
	}
	return Math.sqrt(sse / corr.length);
}
