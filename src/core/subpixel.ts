import { type LinearImage, sampleLinear } from "./image.ts";
import type { ImagePoint } from "./types.ts";

/**
 * Sub-pixel corner refinement.
 *
 * zxing-cpp computes sub-pixel corners internally and then rounds them to
 * integers at the API boundary (`Position` is a `QuadrilateralI`). Raw detector
 * corners therefore carry up to several pixels of error, and since every
 * downstream number in this project is conditioned on per-corner noise sigma,
 * that rounding alone would cap the whole system. This module recovers the
 * sub-pixel positions from the image directly.
 *
 * The method is deliberately boring: sample the intensity profile across each
 * edge, take the centroid of the gradient to locate the edge to a fraction of a
 * pixel, fit a line through those points robustly, and intersect adjacent lines.
 * Corners come from lines rather than from a corner detector because a line is
 * over-determined by a dozen samples while a corner is a single point, and
 * because a line fit degrades gracefully when part of an edge is occluded.
 */

export interface Line {
	/** Normalised so that a*a + b*b === 1; distance of (x,y) is |ax + by + c|. */
	readonly a: number;
	readonly b: number;
	readonly c: number;
	readonly inliers: number;
	readonly samples: number;
	/** Mean gradient magnitude of the accepted samples; the evidence measure. */
	readonly contrast: number;
	readonly rms: number;
}

export interface RefineOptions {
	/**
	 * How far to search along the edge normal, in pixels. Must stay below the
	 * distance to the next feature, or the profile picks up a neighbouring edge.
	 */
	readonly searchRadiusPx: number;
	/** Sample spacing along the normal, in pixels. */
	readonly stepPx?: number;
	/** Number of profiles per edge; clamped by edge length. */
	readonly samplesPerEdge?: number;
	/** Minimum linear-light contrast across the profile for a sample to count. */
	readonly minContrast?: number;
	/** Inlier distance for the line fit, in pixels. */
	readonly inlierPx?: number;
	/** Fraction of each edge to skip at both ends, away from the corners. */
	readonly endTrim?: number;
}

export interface RefinedQuad {
	/** TL, TR, BR, BL, in the same order as the input. */
	readonly corners: readonly [ImagePoint, ImagePoint, ImagePoint, ImagePoint];
	readonly edges: readonly [Line, Line, Line, Line];
	/**
	 * Per-corner evidence, in [0, 1]. A corner whose two edges had few inliers or
	 * weak contrast is *fabricated*: error correction happily decodes a symbol
	 * with a finger over one corner, and the detector will still report four
	 * corners, one of which is an extrapolation with no support in the image and
	 * no error signal attached. See CONCEPT.md 6.3.
	 */
	readonly cornerEvidence: readonly [number, number, number, number];
	readonly ok: boolean;
}

const DEFAULTS = {
	stepPx: 0.25,
	samplesPerEdge: 16,
	minContrast: 0.06,
	inlierPx: 0.6,
	endTrim: 0.18,
} as const;

interface EdgeSample {
	readonly x: number;
	readonly y: number;
	readonly contrast: number;
}

/**
 * Locates one edge crossing along a normal, to sub-pixel precision, by taking
 * the centroid of the gradient magnitude in a window around its peak.
 */
function locateEdge(
	img: LinearImage,
	px: number,
	py: number,
	nx: number,
	ny: number,
	radius: number,
	step: number,
	minContrast: number,
): { offset: number; contrast: number } | null {
	const count = Math.max(5, Math.ceil((2 * radius) / step) | 1);
	const profile = new Float64Array(count);
	for (let i = 0; i < count; i++) {
		const s = -radius + (i * (2 * radius)) / (count - 1);
		profile[i] = sampleLinear(img, px + nx * s, py + ny * s);
	}

	// Central-difference gradient magnitude.
	const grad = new Float64Array(count);
	for (let i = 1; i < count - 1; i++) {
		grad[i] = Math.abs(profile[i + 1]! - profile[i - 1]!);
	}

	let peak = 1;
	for (let i = 2; i < count - 1; i++) if (grad[i]! > grad[peak]!) peak = i;

	const span = Math.max(...profile) - Math.min(...profile);
	if (span < minContrast) return null;
	// A peak pinned to the window edge means the real edge is outside the search
	// radius; accepting it would drag the line fit toward whatever is out there.
	if (peak <= 1 || peak >= count - 2) return null;

	// Centroid over a window around the peak, roughly +-1.5 px.
	const halfWindow = Math.max(2, Math.round(1.5 / step));
	const lo = Math.max(1, peak - halfWindow);
	const hi = Math.min(count - 2, peak + halfWindow);
	let num = 0;
	let den = 0;
	for (let i = lo; i <= hi; i++) {
		const g = grad[i]!;
		num += g * i;
		den += g;
	}
	if (den <= 0) return null;

	const centre = num / den;
	const offset = -radius + (centre * (2 * radius)) / (count - 1);
	return { offset, contrast: span };
}

/** Total-least-squares line through points, weighted equally. */
function fitLineTls(points: readonly EdgeSample[]): { a: number; b: number; c: number } | null {
	const n = points.length;
	if (n < 2) return null;
	let mx = 0;
	let my = 0;
	for (const p of points) {
		mx += p.x;
		my += p.y;
	}
	mx /= n;
	my /= n;

	let sxx = 0;
	let sxy = 0;
	let syy = 0;
	for (const p of points) {
		const dx = p.x - mx;
		const dy = p.y - my;
		sxx += dx * dx;
		sxy += dx * dy;
		syy += dy * dy;
	}

	// Smallest eigenvector of [[sxx, sxy], [sxy, syy]] is the line normal.
	const trace = sxx + syy;
	const det = sxx * syy - sxy * sxy;
	const disc = Math.max(0, (trace / 2) ** 2 - det);
	const lambda = trace / 2 - Math.sqrt(disc);
	let a = sxy;
	let b = lambda - sxx;
	if (Math.hypot(a, b) < 1e-12) {
		a = lambda - syy;
		b = sxy;
	}
	const norm = Math.hypot(a, b);
	if (norm < 1e-12) return null;
	a /= norm;
	b /= norm;
	return { a, b, c: -(a * mx + b * my) };
}

/**
 * Exhaustive two-point RANSAC followed by a total-least-squares refit on the
 * consensus set. With at most a couple of dozen samples per edge, trying every
 * pair is both cheaper than random sampling and completely deterministic, which
 * matters more than it sounds: a randomised fit makes a failing sweep case
 * impossible to reproduce.
 */
function fitLineRobust(points: readonly EdgeSample[], inlierPx: number): Line | null {
	const n = points.length;
	if (n < 3) return null;

	let bestCount = -1;
	let bestModel: { a: number; b: number; c: number } | null = null;
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			const p = points[i]!;
			const q = points[j]!;
			const dx = q.x - p.x;
			const dy = q.y - p.y;
			const len = Math.hypot(dx, dy);
			if (len < 1e-6) continue;
			const a = -dy / len;
			const b = dx / len;
			const c = -(a * p.x + b * p.y);
			let count = 0;
			for (const s of points) if (Math.abs(a * s.x + b * s.y + c) <= inlierPx) count++;
			if (count > bestCount) {
				bestCount = count;
				bestModel = { a, b, c };
			}
		}
	}
	if (!bestModel) return null;

	const inliers = points.filter(
		(s) => Math.abs(bestModel.a * s.x + bestModel.b * s.y + bestModel.c) <= inlierPx,
	);
	const refined = fitLineTls(inliers.length >= 2 ? inliers : points) ?? bestModel;

	let sse = 0;
	let contrast = 0;
	for (const s of inliers) {
		const d = refined.a * s.x + refined.b * s.y + refined.c;
		sse += d * d;
		contrast += s.contrast;
	}
	return {
		...refined,
		inliers: inliers.length,
		samples: n,
		contrast: inliers.length > 0 ? contrast / inliers.length : 0,
		rms: inliers.length > 0 ? Math.sqrt(sse / inliers.length) : Number.POSITIVE_INFINITY,
	};
}

function intersect(p: Line, q: Line): ImagePoint | null {
	const det = p.a * q.b - q.a * p.b;
	// |det| is |sin| of the angle between the lines; near-parallel edges make the
	// intersection wander far outside the image.
	if (Math.abs(det) < 0.15) return null;
	return {
		x: (p.b * q.c - q.b * p.c) / det,
		y: (q.a * p.c - p.a * q.c) / det,
	};
}

/**
 * Refines the four corners of an approximately-known quadrilateral.
 * Returns null when fewer than four edges could be fitted at all.
 */
export function refineQuad(
	img: LinearImage,
	approx: readonly [ImagePoint, ImagePoint, ImagePoint, ImagePoint],
	options: RefineOptions,
): RefinedQuad | null {
	const stepPx = options.stepPx ?? DEFAULTS.stepPx;
	const perEdge = options.samplesPerEdge ?? DEFAULTS.samplesPerEdge;
	const minContrast = options.minContrast ?? DEFAULTS.minContrast;
	const inlierPx = options.inlierPx ?? DEFAULTS.inlierPx;
	const endTrim = options.endTrim ?? DEFAULTS.endTrim;
	const radius = options.searchRadiusPx;

	const lines: (Line | null)[] = [];
	for (let e = 0; e < 4; e++) {
		const A = approx[e]!;
		const B = approx[(e + 1) % 4]!;
		const dx = B.x - A.x;
		const dy = B.y - A.y;
		const len = Math.hypot(dx, dy);
		if (len < 4) {
			lines.push(null);
			continue;
		}
		const nx = -dy / len;
		const ny = dx / len;

		const count = Math.max(4, Math.min(perEdge, Math.floor(len / 2)));
		const samples: EdgeSample[] = [];
		for (let i = 0; i < count; i++) {
			const t = endTrim + ((1 - 2 * endTrim) * i) / Math.max(1, count - 1);
			const px = A.x + dx * t;
			const py = A.y + dy * t;
			const hit = locateEdge(img, px, py, nx, ny, radius, stepPx, minContrast);
			if (!hit) continue;
			samples.push({
				x: px + nx * hit.offset,
				y: py + ny * hit.offset,
				contrast: hit.contrast,
			});
		}
		lines.push(fitLineRobust(samples, inlierPx));
	}

	if (lines.some((l) => l === null)) return null;
	const solid = lines as Line[];

	const corners: ImagePoint[] = [];
	const evidence: number[] = [];
	for (let i = 0; i < 4; i++) {
		// Corner i is where edge (i-1) meets edge i.
		const prev = solid[(i + 3) % 4]!;
		const next = solid[i]!;
		const p = intersect(prev, next);
		if (!p) return null;
		corners.push(p);
		const support = Math.min(
			prev.inliers / Math.max(1, prev.samples),
			next.inliers / Math.max(1, next.samples),
		);
		const strength = Math.min(1, Math.min(prev.contrast, next.contrast) / 0.25);
		const tightness = 1 / (1 + Math.max(prev.rms, next.rms));
		evidence.push(support * strength * tightness);
	}

	// Reject anything that has wandered implausibly far from where the detector
	// said the quad was; a runaway line intersection is worse than no corner.
	for (let i = 0; i < 4; i++) {
		const d = Math.hypot(corners[i]!.x - approx[i]!.x, corners[i]!.y - approx[i]!.y);
		if (!Number.isFinite(d) || d > Math.max(6, 3 * radius)) return null;
	}

	return {
		corners: corners as unknown as RefinedQuad["corners"],
		edges: solid as unknown as RefinedQuad["edges"],
		cornerEvidence: evidence as unknown as RefinedQuad["cornerEvidence"],
		ok: true,
	};
}

/**
 * Refines a single corner formed by two straight arms, which is what an
 * L-bracket gives us. Only the outer corner is used: it is the point pinned to
 * the true display corner, and it is the one carrying the long baseline.
 */
export function refineCornerFromArms(
	img: LinearImage,
	corner: ImagePoint,
	armA: ImagePoint,
	armB: ImagePoint,
	options: RefineOptions,
): { point: ImagePoint; evidence: number } | null {
	const stepPx = options.stepPx ?? DEFAULTS.stepPx;
	const perEdge = options.samplesPerEdge ?? DEFAULTS.samplesPerEdge;
	const minContrast = options.minContrast ?? DEFAULTS.minContrast;
	const inlierPx = options.inlierPx ?? DEFAULTS.inlierPx;
	const endTrim = options.endTrim ?? DEFAULTS.endTrim;

	const fitArm = (end: ImagePoint): Line | null => {
		const dx = end.x - corner.x;
		const dy = end.y - corner.y;
		const len = Math.hypot(dx, dy);
		if (len < 6) return null;
		const nx = -dy / len;
		const ny = dx / len;
		const count = Math.max(4, Math.min(perEdge, Math.floor(len / 2)));
		const samples: EdgeSample[] = [];
		for (let i = 0; i < count; i++) {
			const t = endTrim + ((1 - 2 * endTrim) * i) / Math.max(1, count - 1);
			const px = corner.x + dx * t;
			const py = corner.y + dy * t;
			const hit = locateEdge(img, px, py, nx, ny, options.searchRadiusPx, stepPx, minContrast);
			if (!hit) continue;
			samples.push({ x: px + nx * hit.offset, y: py + ny * hit.offset, contrast: hit.contrast });
		}
		return fitLineRobust(samples, inlierPx);
	};

	const la = fitArm(armA);
	const lb = fitArm(armB);
	if (!la || !lb) return null;
	const p = intersect(la, lb);
	if (!p) return null;
	if (Math.hypot(p.x - corner.x, p.y - corner.y) > Math.max(8, 4 * options.searchRadiusPx)) {
		return null;
	}

	const support = Math.min(
		la.inliers / Math.max(1, la.samples),
		lb.inliers / Math.max(1, lb.samples),
	);
	const strength = Math.min(1, Math.min(la.contrast, lb.contrast) / 0.25);
	const tightness = 1 / (1 + Math.max(la.rms, lb.rms));
	return { point: p, evidence: support * strength * tightness };
}
