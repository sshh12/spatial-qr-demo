import { homographyDLT } from "./homography.ts";
import {
	expSO3,
	householder,
	type Mat3,
	Matrix,
	mat3Column,
	mat3FromColumns,
	mat3Inverse,
	mat3Mul,
	mat3MulVec,
	mat3Transpose,
	nearestRotation,
	skew,
	solveSpd,
	type Vec3,
	vec3Cross,
	vec3Norm,
	vec3Normalize,
	vec3Scale,
} from "./linalg.ts";
import type {
	ConfidenceTier,
	Correspondence,
	FocalPrior,
	Intrinsics,
	PoseBranch,
	PoseSolution,
	RefusalReason,
} from "./types.ts";

const DEG = 180 / Math.PI;

export interface Gates {
	/** Pixels per module at or above which a solve can be "solid". */
	readonly solidPxPerModule: number;
	/** Below this, refuse outright. */
	readonly softPxPerModule: number;
	/** Branch evidence ratio at or above which a solve can be "solid". */
	readonly solidMargin: number;
	/** Below this, refuse: we cannot tell which side of the room you were on. */
	readonly softMargin: number;
	/** RMS reprojection at or below which a solve can be "solid". */
	readonly solidRmsPx: number;
	/** Above this, refuse. */
	readonly maxRmsPx: number;
	/** Predicted bearing 1-sigma at or below which a solve can be "solid". */
	readonly solidBearingSigmaDeg: number;
	/** Above this predicted bearing 1-sigma, refuse: the answer means nothing. */
	readonly maxBearingSigmaDeg: number;
	/** Predicted relative distance 1-sigma at or below which a solve is "solid". */
	readonly solidDistanceSigmaRel: number;
	readonly maxDistanceSigmaRel: number;
	/** Distance range, in marker edges, outside which the solve is nonsense. */
	readonly minDistanceEdges: number;
	readonly maxDistanceEdges: number;
	/** Branch separations below this are treated as no ambiguity at all. */
	readonly collapseSeparationDeg: number;
}

/**
 * Gate defaults, derived from the L2 sweep rather than chosen.
 *
 * CONCEPT.md section 6.9 proposed thresholds on pixels-per-module (7 solid,
 * 5 refuse). Measurement rejected that framing: with 28 sub-pixel points and the
 * brackets, bearing error stayed under 1.6 degrees p95 all the way down to 3.6
 * px/module, where the old gate had been refusing for a while, and the flip rate
 * was zero throughout because the branch margin -- which is computed from the
 * frame's own residuals, so it self-calibrates -- stayed above 15.
 *
 * What actually degrades at the far end is *distance*, and what actually ends
 * the range is zxing's own decode floor at about 3.2 px/module. So the gates are
 * now:
 *
 *  - pixels per module: a decode-reliability floor only, set just above where
 *    the reader starts dropping frames. Not an accuracy proxy.
 *  - predicted bearing and distance sigma: the real accuracy gate, computed per
 *    frame from the pose covariance. It is the same number the error bar shows,
 *    which means the refusal threshold and the public claim cannot drift apart,
 *    and it responds automatically when `sigmaPx` is updated from the R1
 *    hardware spike.
 *  - branch margin: unchanged, and it is the one that guards the fatal error.
 *
 * See tests/l2/sweep.test.ts and public/generated/sweep.json for the evidence.
 */
export const DEFAULT_GATES: Gates = {
	solidPxPerModule: 6,
	softPxPerModule: 3.5,
	solidMargin: 3,
	softMargin: 2,
	solidRmsPx: 0.6,
	maxRmsPx: 1.5,
	solidBearingSigmaDeg: 1.0,
	maxBearingSigmaDeg: 3.0,
	solidDistanceSigmaRel: 0.12,
	maxDistanceSigmaRel: 0.35,
	minDistanceEdges: 0.3,
	maxDistanceEdges: 200,
	collapseSeparationDeg: 3,
};

/**
 * Corner errors are not independent.
 *
 * The covariance derived from (J^T J)^-1 assumes every correspondence carries an
 * independent Gaussian error. Ours do not: the four corners of a finder pattern
 * come from intersecting four shared line fits, so an error in one line moves
 * two corners together. Treating them as independent counts more evidence than
 * exists and produces error bars that are too narrow.
 *
 * Measured, not guessed: the L2 calibration run put the p95 of
 * |error| / predicted-sigma at 2.71 where an honest bar would put it near 1.96,
 * and only 85% of errors fell inside two sigma instead of 95%. The ratio of
 * those, ~1.4, is this constant. tests/l2/sweep.test.ts re-checks it, so if the
 * refiner changes and the correlation structure changes with it, the calibration
 * test fails rather than the claim quietly becoming false.
 */
export const DEFAULT_COVARIANCE_INFLATION = 1.4;

export interface SolveOptions {
	readonly imageWidth: number;
	readonly imageHeight: number;
	readonly prior: FocalPrior;
	/** Per-corner pixel noise, 1 sigma. Sets how much the focal prior matters. */
	readonly sigmaPx: number;
	/** 1-sigma principal-point offset, in pixels. Defaults to 1.5% of width. */
	readonly principalPointSigmaPx?: number;
	/**
	 * Multiplier on the predicted position 1-sigma, defaulting to
	 * DEFAULT_COVARIANCE_INFLATION.
	 */
	readonly covarianceInflation?: number;
	/** Modules along one symbol edge; only used to report pixels per module. */
	readonly moduleCount: number;
	readonly gates?: Gates;
	/** Overrides the principal point; defaults to the frame centre. */
	readonly principalPoint?: { readonly cx: number; readonly cy: number };
}

export function intrinsicsMatrix(k: Intrinsics): Mat3 {
	return [k.f, 0, k.cx, 0, k.f, k.cy, 0, 0, 1];
}

// ---------------------------------------------------------------------------
// Closed-form plane pose
// ---------------------------------------------------------------------------

export interface RigidPose {
	readonly R: Mat3;
	readonly t: Vec3;
}

/**
 * Closed-form pose of a plane from its homography. The two columns of K^-1 H
 * are the first two rotation columns up to a common scale; the third is the
 * translation. Orthonormality is then restored by polar decomposition.
 */
export function poseFromHomography(H: Mat3, K: Mat3): RigidPose {
	const M = mat3Mul(mat3Inverse(K), H);
	const m1 = mat3Column(M, 0);
	const m2 = mat3Column(M, 1);
	const m3 = mat3Column(M, 2);

	const n1 = vec3Norm(m1);
	const n2 = vec3Norm(m2);
	if (!(n1 > 0) || !(n2 > 0)) throw new Error("poseFromHomography: degenerate homography");

	let lambda = 2 / (n1 + n2);
	// The marker must be in front of the camera.
	if (m3[2] * lambda < 0) lambda = -lambda;

	const r1 = vec3Scale(m1, lambda);
	const r2 = vec3Scale(m2, lambda);
	const r3 = vec3Cross(r1, r2);
	const R = nearestRotation(mat3FromColumns(r1, r2, r3));
	const t = vec3Scale(m3, lambda);
	return { R, t };
}

/**
 * The other pose that fits the same image of the same plane.
 *
 * Derivation: the two solutions have plane normals that are mirror images about
 * the viewing ray, which is realised by R' = (I - 2vv^T) R diag(1,1,-1) with the
 * translation unchanged. In the marker frame this puts the camera at (-x, -y, z)
 * -- azimuth and elevation both flip sign, distance is untouched. That is
 * exactly the left/right flip, and it is why it is the error that matters.
 */
export function mirrorBranch(pose: RigidPose): RigidPose {
	const norm = vec3Norm(pose.t);
	if (!(norm > 0)) return pose;
	const v = vec3Scale(pose.t, 1 / norm);
	const flipZ: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, -1];
	return { R: mat3Mul(householder(v), mat3Mul(pose.R, flipZ)), t: pose.t };
}

/** Camera centre in the marker frame. */
export function cameraCentre(pose: RigidPose): Vec3 {
	return vec3Scale(mat3MulVec(mat3Transpose(pose.R), pose.t), -1);
}

// ---------------------------------------------------------------------------
// Levenberg-Marquardt
// ---------------------------------------------------------------------------

interface LmResult {
	readonly R: Mat3;
	readonly t: Vec3;
	/** Weighted sum of squared pixel residuals. */
	readonly sse: number;
	readonly iterations: number;
	/** J^T J at the optimum, for the covariance. */
	readonly jtj: Matrix;
	readonly ok: boolean;
}

function evaluate(
	corr: readonly Correspondence[],
	f: number,
	cx: number,
	cy: number,
	R: Mat3,
	t: Vec3,
	J: Matrix | null,
	residual: Float64Array | null,
): number {
	let sse = 0;
	for (let i = 0; i < corr.length; i++) {
		const c = corr[i]!;
		const px = c.model.x;
		const py = c.model.y;
		// P = R p (p lies on z = 0)
		const P: Vec3 = [R[0] * px + R[1] * py, R[3] * px + R[4] * py, R[6] * px + R[7] * py];
		const x = P[0] + t[0];
		const y = P[1] + t[1];
		const z = P[2] + t[2];
		if (!(z > 1e-9)) return Number.POSITIVE_INFINITY;

		const w = Math.sqrt(c.weight);
		const du = (f * x) / z + cx - c.image.x;
		const dv = (f * y) / z + cy - c.image.y;
		sse += c.weight * (du * du + dv * dv);

		if (residual) {
			residual[2 * i] = du * w;
			residual[2 * i + 1] = dv * w;
		}
		if (J) {
			const invZ = 1 / z;
			const fz = f * invZ;
			// d(u,v)/dX
			const a00 = fz;
			const a02 = -fz * x * invZ;
			const a11 = fz;
			const a12 = -fz * y * invZ;
			// dX/dw = -skew(P)
			const S = skew(P);
			for (let k = 0; k < 3; k++) {
				const s0 = -S[k]!;
				const s1 = -S[3 + k]!;
				const s2 = -S[6 + k]!;
				J.set(2 * i, k, (a00 * s0 + a02 * s2) * w);
				J.set(2 * i + 1, k, (a11 * s1 + a12 * s2) * w);
			}
			J.set(2 * i, 3, a00 * w);
			J.set(2 * i, 4, 0);
			J.set(2 * i, 5, a02 * w);
			J.set(2 * i + 1, 3, 0);
			J.set(2 * i + 1, 4, a11 * w);
			J.set(2 * i + 1, 5, a12 * w);
		}
	}
	return sse;
}

/**
 * Keeps a branch on its own side of the display.
 *
 * Without this, Levenberg-Marquardt started from the mirror seed can slide back
 * across the axis and land on the primary minimum. The two branches then agree,
 * the evidence ratio reads 1.0, and the solver reports maximum ambiguity for
 * what is actually a well-determined pose -- or worse, reports confidence
 * because they "agree". Constraining the sign of the camera's lateral offset
 * answers the question we actually want answered: what is the best explanation
 * of this photograph with the viewer on the *other* side?
 */
function sideOf(R: Mat3, t: Vec3): number {
	// x component of -R^T t, without allocating.
	return -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]);
}

/** Refines a pose at a fixed focal length. Six parameters, analytic Jacobian. */
export function refinePoseLM(
	corr: readonly Correspondence[],
	f: number,
	cx: number,
	cy: number,
	R0: Mat3,
	t0: Vec3,
	maxIterations = 40,
	constrainSide: number | null = null,
): LmResult {
	const n = corr.length;
	const J = new Matrix(2 * n, 6);
	const residual = new Float64Array(2 * n);
	const H = new Matrix(6, 6);
	const g: number[] = new Array(6).fill(0);

	let R = R0;
	let t = t0;
	let sse = evaluate(corr, f, cx, cy, R, t, J, residual);
	if (!Number.isFinite(sse)) {
		return { R, t, sse: Number.POSITIVE_INFINITY, iterations: 0, jtj: H, ok: false };
	}

	let lambda = 1e-4;
	let iterations = 0;

	for (let iter = 0; iter < maxIterations; iter++) {
		iterations = iter + 1;
		H.data.fill(0);
		g.fill(0);
		for (let r = 0; r < 2 * n; r++) {
			for (let a = 0; a < 6; a++) {
				const ja = J.get(r, a);
				if (ja === 0) continue;
				g[a]! += ja * residual[r]!;
				for (let b = a; b < 6; b++) H.add(a, b, ja * J.get(r, b));
			}
		}
		for (let a = 0; a < 6; a++) for (let b = 0; b < a; b++) H.set(a, b, H.get(b, a));

		let accepted = false;
		for (let attempt = 0; attempt < 12; attempt++) {
			const damped = new Matrix(6, 6, Float64Array.from(H.data));
			for (let a = 0; a < 6; a++) {
				damped.set(a, a, H.get(a, a) * (1 + lambda) + 1e-14);
			}
			const delta = solveSpd(
				damped,
				g.map((v) => -v),
			);
			if (!delta) {
				lambda *= 10;
				continue;
			}
			const omega: Vec3 = [delta[0]!, delta[1]!, delta[2]!];
			const Rn = mat3Mul(expSO3(omega), R);
			const tn: Vec3 = [t[0] + delta[3]!, t[1] + delta[4]!, t[2] + delta[5]!];
			if (constrainSide !== null && sideOf(Rn, tn) * constrainSide < 0) {
				lambda *= 6;
				if (lambda > 1e12) break;
				continue;
			}
			const trial = evaluate(corr, f, cx, cy, Rn, tn, null, null);
			if (Number.isFinite(trial) && trial < sse) {
				const improvement = (sse - trial) / Math.max(sse, 1e-300);
				R = Rn;
				t = tn;
				sse = trial;
				evaluate(corr, f, cx, cy, R, t, J, residual);
				lambda = Math.max(lambda / 3, 1e-12);
				accepted = true;
				if (improvement < 1e-12) iter = maxIterations;
				break;
			}
			lambda *= 6;
			if (lambda > 1e12) break;
		}
		if (!accepted) break;
	}

	// Recompute J^T J cleanly at the optimum for the covariance.
	H.data.fill(0);
	for (let r = 0; r < 2 * n; r++) {
		for (let a = 0; a < 6; a++) {
			const ja = J.get(r, a);
			if (ja === 0) continue;
			for (let b = a; b < 6; b++) H.add(a, b, ja * J.get(r, b));
		}
	}
	for (let a = 0; a < 6; a++) for (let b = 0; b < a; b++) H.set(a, b, H.get(b, a));

	return { R, t, sse, iterations, jtj: H, ok: Number.isFinite(sse) };
}

// ---------------------------------------------------------------------------
// Focal length by MAP
// ---------------------------------------------------------------------------

const GOLDEN_INV = (Math.sqrt(5) - 1) / 2;

interface BranchFit {
	readonly lm: LmResult;
	readonly f: number;
	readonly cost: number;
	readonly focalSigmaLog: number;
}

function priorPenalty(f: number, prior: FocalPrior): number {
	const d = Math.log(f) - Math.log(prior.f0);
	return (d * d) / (2 * prior.sigmaLog * prior.sigmaLog);
}

/**
 * Golden-section search over log f, minimising
 *   SSE(f) / (2 sigma_px^2)  +  (log f - log f0)^2 / (2 sigma_log^2)
 * which is the negative log posterior under Gaussian pixel noise and a
 * log-normal focal prior. The curvature at the optimum gives the posterior
 * width of log f, which becomes the distance error bar -- distance is exactly
 * linear in f, so sigma_logf *is* the relative distance error from this term.
 */
function fitBranch(
	corr: readonly Correspondence[],
	H: Mat3,
	cx: number,
	cy: number,
	prior: FocalPrior,
	sigmaPx: number,
	mirror: boolean,
): BranchFit | null {
	const twoSigmaSq = 2 * sigmaPx * sigmaPx;

	const seed = (f: number): RigidPose | null => {
		try {
			const base = poseFromHomography(H, intrinsicsMatrix({ f, cx, cy }));
			return mirror ? mirrorBranch(base) : base;
		} catch {
			return null;
		}
	};

	const evalAt = (logF: number): { cost: number; lm: LmResult | null } => {
		const f = Math.exp(logF);
		const s = seed(f);
		if (!s) return { cost: Number.POSITIVE_INFINITY, lm: null };
		// The mirror branch is pinned to its own side of the display; see sideOf.
		let side: number | null = null;
		if (mirror) {
			const x = sideOf(s.R, s.t);
			const depth = vec3Norm(s.t);
			if (depth > 0 && Math.abs(x) / depth > 0.02) side = Math.sign(x);
		}
		const lm = refinePoseLM(corr, f, cx, cy, s.R, s.t, 40, side);
		if (!lm.ok) return { cost: Number.POSITIVE_INFINITY, lm: null };
		return { cost: lm.sse / twoSigmaSq + priorPenalty(f, prior), lm };
	};

	const halfWidth = Math.max(0.35, 6 * prior.sigmaLog);
	let lo = Math.log(prior.f0) - halfWidth;
	let hi = Math.log(prior.f0) + halfWidth;

	let c = hi - GOLDEN_INV * (hi - lo);
	let d = lo + GOLDEN_INV * (hi - lo);
	let fc = evalAt(c).cost;
	let fd = evalAt(d).cost;

	for (let i = 0; i < 48 && hi - lo > 1e-6; i++) {
		if (fc < fd) {
			hi = d;
			d = c;
			fd = fc;
			c = hi - GOLDEN_INV * (hi - lo);
			fc = evalAt(c).cost;
		} else {
			lo = c;
			c = d;
			fc = fd;
			d = lo + GOLDEN_INV * (hi - lo);
			fd = evalAt(d).cost;
		}
	}

	const logStar = (lo + hi) / 2;
	const best = evalAt(logStar);
	if (!best.lm) return null;

	// Curvature of the cost in log f, by central difference.
	const h = 0.02;
	const cMinus = evalAt(logStar - h).cost;
	const cPlus = evalAt(logStar + h).cost;
	let curvature = (cPlus - 2 * best.cost + cMinus) / (h * h);
	if (!(curvature > 0)) curvature = 1 / (prior.sigmaLog * prior.sigmaLog);
	const focalSigmaLog = Math.min(prior.sigmaLog, 1 / Math.sqrt(curvature));

	return { lm: best.lm, f: Math.exp(logStar), cost: best.cost, focalSigmaLog };
}

// ---------------------------------------------------------------------------
// Covariance
// ---------------------------------------------------------------------------

function invertSpd(A: Matrix): Matrix | null {
	const n = A.rows;
	const out = new Matrix(n, n);
	for (let j = 0; j < n; j++) {
		const e: number[] = new Array(n).fill(0);
		e[j] = 1;
		const col = solveSpd(A, e);
		if (!col) return null;
		for (let i = 0; i < n; i++) out.set(i, j, col[i]!);
	}
	return out;
}

/**
 * 2x2 covariance of the camera's floor position (x, z) in squared marker edges.
 *
 * Three independent contributions, all of them real:
 *  - pixel noise, propagated through the pose Jacobian;
 *  - focal-length posterior width, which scales the position radially;
 *  - principal-point uncertainty, which rotates it tangentially. No web API
 *    reports the principal point, and assuming the frame centre is wrong by a
 *    percent or two on most phones.
 */
function floorCovariance(
	lm: LmResult,
	camera: Vec3,
	sigmaPx: number,
	focalSigmaLog: number,
	principalPointSigmaPx: number,
	f: number,
): readonly [number, number, number, number] {
	let xx = 0;
	let xz = 0;
	let zz = 0;

	const cov = invertSpd(lm.jtj);
	if (cov) {
		const Rt = mat3Transpose(lm.R);
		const St = skew(lm.t);
		// dC/d(omega, dt) = [ -R^T skew(t) | -R^T ]
		const A = mat3Mul(Rt, St); // -(that) below
		const JC = new Matrix(3, 6);
		for (let r = 0; r < 3; r++) {
			for (let c = 0; c < 3; c++) {
				JC.set(r, c, -A[r * 3 + c]!);
				JC.set(r, c + 3, -Rt[r * 3 + c]!);
			}
		}
		// Cov(C) = sigma^2 * JC * (J^T J)^-1 * JC^T ; we need rows 0 and 2.
		const rows = [0, 2] as const;
		const tmp = new Matrix(2, 6);
		for (let a = 0; a < 2; a++) {
			for (let j = 0; j < 6; j++) {
				let acc = 0;
				for (let k = 0; k < 6; k++) acc += JC.get(rows[a]!, k) * cov.get(k, j);
				tmp.set(a, j, acc);
			}
		}
		const m: number[][] = [
			[0, 0],
			[0, 0],
		];
		for (let a = 0; a < 2; a++) {
			for (let b = 0; b < 2; b++) {
				let acc = 0;
				for (let k = 0; k < 6; k++) acc += tmp.get(a, k) * JC.get(rows[b]!, k);
				m[a]![b] = acc * sigmaPx * sigmaPx;
			}
		}
		xx = m[0]![0]!;
		xz = m[0]![1]!;
		zz = m[1]![1]!;
	}

	// Radial: a relative error in f scales the whole position vector.
	const radial = focalSigmaLog * focalSigmaLog;
	xx += radial * camera[0] * camera[0];
	xz += radial * camera[0] * camera[2];
	zz += radial * camera[2] * camera[2];

	// Tangential: a principal-point offset of d px rotates the bearing by d/f.
	const horizontal = Math.hypot(camera[0], camera[2]);
	if (horizontal > 1e-9 && f > 0) {
		const sigmaAng = principalPointSigmaPx / f;
		const tx = -camera[2] / horizontal;
		const tz = camera[0] / horizontal;
		const s = sigmaAng * sigmaAng * horizontal * horizontal;
		xx += s * tx * tx;
		xz += s * tx * tz;
		zz += s * tz * tz;
	}

	return [xx, xz, xz, zz];
}

// ---------------------------------------------------------------------------
// Top level
// ---------------------------------------------------------------------------

/**
 * Splits the floor covariance into the two components anyone actually cares
 * about: sideways (which becomes the bearing error bar) and along the line of
 * sight (which becomes the distance error bar).
 */
function decomposeCovariance(
	cov: readonly [number, number, number, number],
	camera: Vec3,
): { bearingSigmaDeg: number; distanceSigmaRel: number } {
	const horizontal = Math.hypot(camera[0], camera[2]);
	if (!(horizontal > 1e-9)) {
		return {
			bearingSigmaDeg: Number.POSITIVE_INFINITY,
			distanceSigmaRel: Number.POSITIVE_INFINITY,
		};
	}
	const rx = camera[0] / horizontal;
	const rz = camera[2] / horizontal;
	const tx = -rz;
	const tz = rx;
	const quad = (ax: number, az: number) =>
		Math.sqrt(Math.max(0, ax * ax * cov[0] + 2 * ax * az * cov[1] + az * az * cov[3]));
	return {
		bearingSigmaDeg: (quad(tx, tz) / horizontal) * DEG,
		distanceSigmaRel: quad(rx, rz) / horizontal,
	};
}

function toBranch(
	fit: BranchFit,
	pointCount: number,
	sigmaPx: number,
	ppSigma: number,
	inflation: number,
): PoseBranch {
	const camera = cameraCentre(fit.lm);
	const distanceEdges = vec3Norm(camera);
	const raw = floorCovariance(fit.lm, camera, sigmaPx, fit.focalSigmaLog, ppSigma, fit.f);
	const k = inflation * inflation;
	const cov = [raw[0] * k, raw[1] * k, raw[2] * k, raw[3] * k] as const;
	const spread = decomposeCovariance(cov, camera);
	return {
		...spread,
		R: fit.lm.R,
		t: fit.lm.t,
		camera,
		azimuthDeg: Math.atan2(camera[0], camera[2]) * DEG,
		elevationDeg: Math.atan2(camera[1], Math.hypot(camera[0], camera[2])) * DEG,
		distanceEdges,
		focalPx: fit.f,
		rmsPx: rmsFromSse(fit.lm.sse, pointCount),
		cost: fit.cost,
		focalSigmaLog: fit.focalSigmaLog,
		floorCovariance: cov,
	};
}

/** Per-point Euclidean RMS reprojection error, which is what the gates mean. */
function rmsFromSse(sse: number, n: number): number {
	return Math.sqrt(sse / Math.max(1, n));
}

export class PoseSolveError extends Error {
	readonly refusal: RefusalReason;
	constructor(refusal: RefusalReason) {
		super(`${refusal.code}: ${refusal.detail}`);
		this.name = "PoseSolveError";
		this.refusal = refusal;
	}
}

/**
 * The whole solve: homography, both branches, focal by MAP on each, then the
 * confidence tier. Never throws for ordinary bad input -- it returns a solution
 * carrying `tier: "refused"` and a reason, because "we are not sure which side
 * of the room you were on" is a result the product wants to render.
 */
export function solvePose(corr: readonly Correspondence[], options: SolveOptions): PoseSolution {
	const started = performance.now();
	const gates = options.gates ?? DEFAULT_GATES;
	const cx = options.principalPoint?.cx ?? options.imageWidth / 2;
	const cy = options.principalPoint?.cy ?? options.imageHeight / 2;
	const ppSigma = options.principalPointSigmaPx ?? 0.015 * options.imageWidth;
	const sigmaPx = Math.max(options.sigmaPx, 1e-3);

	if (corr.length < 4) {
		throw new PoseSolveError({
			code: "too-few-points",
			detail: `${corr.length} correspondences; need at least 4`,
		});
	}

	let H: Mat3;
	try {
		H = homographyDLT(corr);
	} catch (err) {
		throw new PoseSolveError({
			code: "degenerate",
			detail: err instanceof Error ? err.message : String(err),
		});
	}

	const fitA = fitBranch(corr, H, cx, cy, options.prior, sigmaPx, false);
	const fitB = fitBranch(corr, H, cx, cy, options.prior, sigmaPx, true);
	if (!fitA) {
		throw new PoseSolveError({
			code: "degenerate",
			detail: "closed-form pose did not converge",
		});
	}

	const inflation = options.covarianceInflation ?? DEFAULT_COVARIANCE_INFLATION;
	const branchA = toBranch(fitA, corr.length, sigmaPx, ppSigma, inflation);
	const branchB = fitB ? toBranch(fitB, corr.length, sigmaPx, ppSigma, inflation) : branchA;

	// The primary branch is the one with the lower posterior cost, which folds in
	// "this branch needs an implausible focal length to fit" as extra evidence.
	const primaryFirst = fitA.cost <= (fitB?.cost ?? Number.POSITIVE_INFINITY);
	const primary = primaryFirst ? branchA : branchB;
	const alternate = primaryFirst ? branchB : branchA;
	const ssePri = primaryFirst ? fitA.lm.sse : fitB!.lm.sse;
	const sseAlt = primaryFirst ? (fitB?.lm.sse ?? fitA.lm.sse) : fitA.lm.sse;

	const dirPri = safeDirection(primary.camera);
	const dirAlt = safeDirection(alternate.camera);
	const dot = Math.min(
		1,
		Math.max(-1, dirPri[0] * dirAlt[0] + dirPri[1] * dirAlt[1] + dirPri[2] * dirAlt[2]),
	);
	const branchSeparationDeg = Math.acos(dot) * DEG;

	const collapsed = branchSeparationDeg < gates.collapseSeparationDeg;
	const floorSse = 2 * corr.length * (0.02 * 0.02);
	const branchMargin = collapsed
		? Number.POSITIVE_INFINITY
		: (sseAlt + floorSse) / (ssePri + floorSse);

	// Pixels per module, straight off the projected unit square.
	const pxPerModule = projectedEdgePx(primary, cx, cy) / options.moduleCount;
	const rmsPx = rmsFromSse(ssePri, corr.length);

	const { tier, refusal } = classify(
		{ rmsPx, pxPerModule, branchMargin, primary, alternate },
		gates,
	);

	return {
		primary: { ...primary, rmsPx },
		alternate: { ...alternate, rmsPx: rmsFromSse(sseAlt, corr.length) },
		branchMargin,
		branchSeparationDeg,
		tier,
		refusal,
		pointCount: corr.length,
		pxPerModule,
		intrinsics: { f: primary.focalPx, cx, cy },
		prior: options.prior,
		solveMs: performance.now() - started,
	};
}

function safeDirection(v: Vec3): Vec3 {
	const n = vec3Norm(v);
	return n > 1e-12 ? vec3Normalize(v) : [0, 0, 1];
}

/** Mean image-space length of the marker's four edges, in pixels. */
function projectedEdgePx(branch: PoseBranch, cx: number, cy: number): number {
	const corners: [number, number][] = [
		[-0.5, 0.5],
		[0.5, 0.5],
		[0.5, -0.5],
		[-0.5, -0.5],
	];
	const projected = corners.map(([x, y]) => {
		const X = branch.R[0] * x + branch.R[1] * y + branch.t[0];
		const Y = branch.R[3] * x + branch.R[4] * y + branch.t[1];
		const Z = branch.R[6] * x + branch.R[7] * y + branch.t[2];
		return { x: (branch.focalPx * X) / Z + cx, y: (branch.focalPx * Y) / Z + cy };
	});
	let total = 0;
	for (let i = 0; i < 4; i++) {
		const a = projected[i]!;
		const b = projected[(i + 1) % 4]!;
		total += Math.hypot(b.x - a.x, b.y - a.y);
	}
	return total / 4;
}

interface ClassifyInput {
	readonly rmsPx: number;
	readonly pxPerModule: number;
	readonly branchMargin: number;
	readonly primary: PoseBranch;
	readonly alternate: PoseBranch;
}

function classify(
	input: ClassifyInput,
	gates: Gates,
): { tier: ConfidenceTier; refusal: RefusalReason | null } {
	const { rmsPx, pxPerModule, branchMargin, primary, alternate } = input;

	if (!Number.isFinite(primary.distanceEdges)) {
		return {
			tier: "refused",
			refusal: { code: "degenerate", detail: "non-finite pose" },
		};
	}
	if (
		primary.distanceEdges < gates.minDistanceEdges ||
		primary.distanceEdges > gates.maxDistanceEdges
	) {
		return {
			tier: "refused",
			refusal: {
				code: "implausible-pose",
				detail: `${primary.distanceEdges.toFixed(1)} marker edges is outside ${gates.minDistanceEdges}-${gates.maxDistanceEdges}`,
			},
		};
	}
	if (primary.camera[2] <= 0) {
		return {
			tier: "refused",
			refusal: { code: "implausible-pose", detail: "camera behind the marker plane" },
		};
	}
	if (rmsPx > gates.maxRmsPx) {
		return {
			tier: "refused",
			refusal: {
				code: "high-residual",
				detail: `${rmsPx.toFixed(2)} px RMS exceeds ${gates.maxRmsPx}`,
			},
		};
	}
	if (pxPerModule < gates.softPxPerModule) {
		return {
			tier: "refused",
			refusal: {
				code: "marker-too-small",
				detail: `${pxPerModule.toFixed(1)} px/module is below ${gates.softPxPerModule}`,
			},
		};
	}
	if (primary.bearingSigmaDeg > gates.maxBearingSigmaDeg) {
		return {
			tier: "refused",
			refusal: {
				code: "high-residual",
				detail: `bearing would only be good to +-${primary.bearingSigmaDeg.toFixed(1)} degrees`,
			},
		};
	}
	if (primary.distanceSigmaRel > gates.maxDistanceSigmaRel) {
		return {
			tier: "refused",
			refusal: {
				code: "high-residual",
				detail: `distance would only be good to +-${(primary.distanceSigmaRel * 100).toFixed(0)}%`,
			},
		};
	}
	// The one that matters: opposite-signed azimuths with no evidence to choose.
	const opposedSides =
		Math.sign(primary.azimuthDeg) !== Math.sign(alternate.azimuthDeg) &&
		Math.abs(primary.azimuthDeg) > 2;
	if (branchMargin < gates.softMargin && opposedSides) {
		return {
			tier: "refused",
			refusal: {
				code: "ambiguous",
				detail: `two poses fit this photo, one on each side (evidence ratio ${branchMargin.toFixed(2)})`,
			},
		};
	}

	const solid =
		pxPerModule >= gates.solidPxPerModule &&
		branchMargin >= gates.solidMargin &&
		rmsPx < gates.solidRmsPx &&
		primary.bearingSigmaDeg <= gates.solidBearingSigmaDeg &&
		primary.distanceSigmaRel <= gates.solidDistanceSigmaRel;
	return { tier: solid ? "solid" : "soft", refusal: null };
}

/**
 * Resolves the branch ambiguity from a second capture taken after a step in a
 * *named* direction. Stepping "either way" cannot work -- flipping both captures
 * negates the displacement, so the pair is self-consistent under the flip. A
 * known step direction breaks that symmetry outright.
 */
export function resolveByStep(
	first: PoseSolution,
	second: PoseSolution,
	stepped: "right" | "left",
): { first: PoseBranch; second: PoseBranch; confident: boolean; lateralEdges: number } {
	const want = stepped === "right" ? 1 : -1;
	const options: { a: PoseBranch; b: PoseBranch; cost: number }[] = [];
	for (const a of [first.primary, first.alternate]) {
		for (const b of [second.primary, second.alternate]) {
			// A flip is all-or-nothing across the pair: mixed assignments imply the
			// viewer teleported across the room between taps.
			const dx = b.camera[0] - a.camera[0];
			const dz = b.camera[2] - a.camera[2];
			const jumped = Math.abs(dz) > 4 * Math.abs(dx) + 1;
			if (jumped) continue;
			if (Math.sign(dx) !== want) continue;
			options.push({ a, b, cost: a.cost + b.cost });
		}
	}
	if (options.length === 0) {
		return {
			first: first.primary,
			second: second.primary,
			confident: false,
			lateralEdges: second.primary.camera[0] - first.primary.camera[0],
		};
	}
	options.sort((p, q) => p.cost - q.cost);
	const best = options[0]!;
	return {
		first: best.a,
		second: best.b,
		confident: true,
		lateralEdges: best.b.camera[0] - best.a.camera[0],
	};
}
