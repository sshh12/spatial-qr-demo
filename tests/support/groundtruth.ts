/**
 * Ground truth for the test suite.
 *
 * THIS FILE MUST NOT IMPORT ANYTHING FROM src/core.
 *
 * Everything here -- the vector algebra, the camera construction, the
 * projection, the module-grid geometry -- is written out a second time, by
 * hand, from the definitions rather than from the solver's code. If the
 * generator and the solver shared a projection path the whole suite would be a
 * tautology: it would pass just as happily with the sign of y flipped in both.
 *
 * `tests/l1/model-agreement.test.ts` pins this file's independent module
 * geometry against src/core/marker.ts so that a disagreement is a loud failure
 * rather than a silent cancellation.
 */

export type V3 = [number, number, number];
/** Row-major 3x3 as an array of rows. */
export type M3 = [V3, V3, V3];

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

export function sub(a: V3, b: V3): V3 {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: V3, k: number): V3 {
	return [a[0] * k, a[1] * k, a[2] * k];
}

export function dot(a: V3, b: V3): number {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: V3, b: V3): V3 {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function norm(a: V3): number {
	return Math.sqrt(dot(a, a));
}

export function unit(a: V3): V3 {
	const n = norm(a);
	if (n === 0) throw new Error("unit: zero vector");
	return [a[0] / n, a[1] / n, a[2] / n];
}

export function matVec(m: M3, v: V3): V3 {
	return [dot(m[0], v), dot(m[1], v), dot(m[2], v)];
}

export function matT(m: M3): M3 {
	return [
		[m[0][0], m[1][0], m[2][0]],
		[m[0][1], m[1][1], m[2][1]],
		[m[0][2], m[1][2], m[2][2]],
	];
}

export function matMul(a: M3, b: M3): M3 {
	const bt = matT(b);
	return [
		[dot(a[0], bt[0]), dot(a[0], bt[1]), dot(a[0], bt[2])],
		[dot(a[1], bt[0]), dot(a[1], bt[1]), dot(a[1], bt[2])],
		[dot(a[2], bt[0]), dot(a[2], bt[1]), dot(a[2], bt[2])],
	];
}

/** Rotation about a unit axis by an angle, written out from Rodrigues. */
export function axisAngle(axis: V3, angle: number): M3 {
	const [x, y, z] = unit(axis);
	const c = Math.cos(angle);
	const s = Math.sin(angle);
	const t = 1 - c;
	return [
		[t * x * x + c, t * x * y - s * z, t * x * z + s * y],
		[t * x * y + s * z, t * y * y + c, t * y * z - s * x],
		[t * x * z - s * y, t * y * z + s * x, t * z * z + c],
	];
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export interface Viewpoint {
	/** Signed degrees; positive is the viewer's own right. */
	readonly azimuthDeg: number;
	/** Signed degrees; positive is above the marker centre. */
	readonly elevationDeg: number;
	/** Distance from the marker centre, in marker-edge units. */
	readonly distanceEdges: number;
	/** Camera roll about its optical axis, in degrees. */
	readonly rollDeg?: number;
	/**
	 * Where the camera actually points, as an offset in degrees from the marker
	 * centre. Zero means perfectly aimed, which no handheld photograph ever is.
	 */
	readonly aimOffsetDeg?: { readonly yaw: number; readonly pitch: number };
}

export interface GroundTruth {
	/** Marker frame -> camera frame. */
	readonly R: M3;
	/** Marker origin in the camera frame. */
	readonly t: V3;
	/** Camera centre in the marker frame. */
	readonly C: V3;
}

/**
 * Places a camera at the given spherical position in the marker frame and aims
 * it at the marker centre.
 *
 * Marker frame: +x is the viewer's right, +y is up, +z points out of the screen
 * toward the viewer. Camera frame is the usual computer-vision one: +x right,
 * +y down, +z forward along the optical axis.
 */
export function viewpointToPose(v: Viewpoint): GroundTruth {
	const az = v.azimuthDeg * D2R;
	const el = v.elevationDeg * D2R;
	const d = v.distanceEdges;

	const C: V3 = [
		d * Math.cos(el) * Math.sin(az),
		d * Math.sin(el),
		d * Math.cos(el) * Math.cos(az),
	];

	let zc = unit(scale(C, -1));
	// A camera that is not aimed exactly at the marker centre.
	if (v.aimOffsetDeg && (v.aimOffsetDeg.yaw !== 0 || v.aimOffsetDeg.pitch !== 0)) {
		const worldUp: V3 = [0, 1, 0];
		const yawAxis = worldUp;
		const pitchAxis = unit(cross(zc, worldUp));
		zc = unit(matVec(axisAngle(yawAxis, v.aimOffsetDeg.yaw * D2R), zc));
		zc = unit(matVec(axisAngle(pitchAxis, v.aimOffsetDeg.pitch * D2R), zc));
	}

	const upHint: V3 = Math.abs(dot(zc, [0, 1, 0])) > 0.999 ? [1, 0, 0] : [0, 1, 0];
	let xc = unit(cross(zc, upHint));
	let yc = cross(zc, xc);

	if (v.rollDeg) {
		const roll = axisAngle(zc, v.rollDeg * D2R);
		xc = unit(matVec(roll, xc));
		yc = matVec(roll, yc);
	}

	// Rows of R are the camera axes written in marker coordinates.
	const R: M3 = [xc, yc, zc];
	const t = scale(matVec(R, C), -1);
	return { R, t, C };
}

export interface Camera {
	readonly f: number;
	readonly cx: number;
	readonly cy: number;
	readonly width: number;
	readonly height: number;
}

export interface Projected {
	readonly x: number;
	readonly y: number;
	/** Depth in the camera frame; non-positive means behind the camera. */
	readonly z: number;
}

/** Projects a point on the marker plane (z = 0) into the image. */
export function project(gt: GroundTruth, cam: Camera, p: { x: number; y: number }): Projected {
	const world: V3 = [p.x, p.y, 0];
	const c = matVec(gt.R, world);
	const x = c[0] + gt.t[0];
	const y = c[1] + gt.t[1];
	const z = c[2] + gt.t[2];
	return { x: (cam.f * x) / z + cam.cx, y: (cam.f * y) / z + cam.cy, z };
}

// ---------------------------------------------------------------------------
// Independent module geometry
// ---------------------------------------------------------------------------

export interface GtModelPoint {
	readonly x: number;
	readonly y: number;
	readonly label: string;
}

/**
 * The 24 guaranteed corners of a QR symbol's three finder patterns, plus the
 * four symbol corners, derived here straight from the QR grid definition:
 * a version-V symbol is (17 + 4V) modules square, each finder pattern is a 7x7
 * dark square whose 3x3 core sits at an inset of 2 modules, and finders occupy
 * the top-left, top-right and bottom-left corners.
 */
export function gtModelPoints(moduleCount: number): GtModelPoint[] {
	const n = moduleCount;
	const at = (col: number, row: number, label: string): GtModelPoint => ({
		x: col / n - 0.5,
		y: 0.5 - row / n,
		label,
	});

	const out: GtModelPoint[] = [
		at(0, 0, "symbol-tl"),
		at(n, 0, "symbol-tr"),
		at(n, n, "symbol-br"),
		at(0, n, "symbol-bl"),
	];

	const boxes: [string, number, number, number][] = [
		["finder-tl-outer", 0, 0, 7],
		["finder-tr-outer", n - 7, 0, 7],
		["finder-bl-outer", 0, n - 7, 7],
		["finder-tl-inner", 2, 2, 3],
		["finder-tr-inner", n - 5, 2, 3],
		["finder-bl-inner", 2, n - 5, 3],
	];
	for (const [label, c0, r0, side] of boxes) {
		out.push(at(c0, r0, `${label}-tl`));
		out.push(at(c0 + side, r0, `${label}-tr`));
		out.push(at(c0 + side, r0 + side, `${label}-br`));
		out.push(at(c0, r0 + side, `${label}-bl`));
	}
	return out;
}

// ---------------------------------------------------------------------------
// Deterministic noise
// ---------------------------------------------------------------------------

/** mulberry32; deterministic so that a failing sweep case can be replayed. */
export function makeRng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Box-Muller, from a uniform source. */
export function gaussian(rng: () => number): number {
	let u = 0;
	while (u === 0) u = rng();
	const v = rng();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
