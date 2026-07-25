/**
 * Dependency-free linear algebra for planar pose estimation.
 *
 * Fixed-size quantities are tuples so that literal indexing stays sound under
 * `noUncheckedIndexedAccess`. Variable-size dense matrices go through `Matrix`,
 * which contains the single unavoidable non-null assertion in this file.
 */

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];
/** Row-major 3x3. */
export type Mat3 = readonly [
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
];

export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

// ---------------------------------------------------------------------------
// Dense matrix
// ---------------------------------------------------------------------------

export class Matrix {
	readonly rows: number;
	readonly cols: number;
	readonly data: Float64Array;

	constructor(rows: number, cols: number, data?: Float64Array) {
		this.rows = rows;
		this.cols = cols;
		this.data = data ?? new Float64Array(rows * cols);
	}

	get(i: number, j: number): number {
		return this.data[i * this.cols + j]!;
	}

	set(i: number, j: number, v: number): void {
		this.data[i * this.cols + j] = v;
	}

	add(i: number, j: number, v: number): void {
		const index = i * this.cols + j;
		this.data[index] = this.data[index]! + v;
	}

	column(j: number): number[] {
		const out: number[] = new Array(this.rows);
		for (let i = 0; i < this.rows; i++) out[i] = this.get(i, j);
		return out;
	}

	static identity(n: number): Matrix {
		const m = new Matrix(n, n);
		for (let i = 0; i < n; i++) m.set(i, i, 1);
		return m;
	}
}

// ---------------------------------------------------------------------------
// SVD (one-sided Jacobi)
// ---------------------------------------------------------------------------

export interface Svd {
	/** Singular values, descending. */
	readonly s: number[];
	/** Right singular vectors as columns. */
	readonly V: Matrix;
	/** Left singular vectors as columns (only the first `cols` of them). */
	readonly U: Matrix;
}

/**
 * One-sided Jacobi SVD of an m x n matrix (m may be < n; the matrix is padded
 * with zero rows, which leaves A^T A and therefore the decomposition unchanged).
 *
 * One-sided Jacobi is used rather than an eigendecomposition of A^T A because it
 * keeps full relative accuracy on the *smallest* singular value, which is
 * precisely the quantity the homography solve depends on.
 */
export function svd(input: Matrix, maxSweeps = 60): Svd {
	const n = input.cols;
	const m = Math.max(input.rows, n);

	const A = new Matrix(m, n);
	A.data.set(input.data);
	const V = Matrix.identity(n);

	const eps = 1e-15;
	for (let sweep = 0; sweep < maxSweeps; sweep++) {
		let off = 0;
		for (let p = 0; p < n - 1; p++) {
			for (let q = p + 1; q < n; q++) {
				let alpha = 0;
				let beta = 0;
				let gamma = 0;
				for (let i = 0; i < m; i++) {
					const ap = A.get(i, p);
					const aq = A.get(i, q);
					alpha += ap * ap;
					beta += aq * aq;
					gamma += ap * aq;
				}
				if (gamma === 0) continue;
				const scale = Math.sqrt(alpha * beta);
				if (scale === 0 || Math.abs(gamma) <= eps * scale) continue;
				off += (gamma * gamma) / (alpha * beta);

				const zeta = (beta - alpha) / (2 * gamma);
				const t = Math.sign(zeta || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
				const c = 1 / Math.sqrt(1 + t * t);
				const s = c * t;

				for (let i = 0; i < m; i++) {
					const ap = A.get(i, p);
					const aq = A.get(i, q);
					A.set(i, p, c * ap - s * aq);
					A.set(i, q, s * ap + c * aq);
				}
				for (let i = 0; i < n; i++) {
					const vp = V.get(i, p);
					const vq = V.get(i, q);
					V.set(i, p, c * vp - s * vq);
					V.set(i, q, s * vp + c * vq);
				}
			}
		}
		if (off < 1e-30) break;
	}

	// Column norms are the singular values; normalising the columns gives U.
	const order: { s: number; j: number }[] = [];
	for (let j = 0; j < n; j++) {
		let acc = 0;
		for (let i = 0; i < m; i++) acc += A.get(i, j) ** 2;
		order.push({ s: Math.sqrt(acc), j });
	}
	order.sort((a, b) => b.s - a.s);

	const U = new Matrix(m, n);
	const Vs = new Matrix(n, n);
	const sOut: number[] = new Array(n);
	for (let k = 0; k < n; k++) {
		const { s, j } = order[k]!;
		sOut[k] = s;
		const inv = s > 0 ? 1 / s : 0;
		for (let i = 0; i < m; i++) U.set(i, k, A.get(i, j) * inv);
		for (let i = 0; i < n; i++) Vs.set(i, k, V.get(i, j));
	}
	return { s: sOut, V: Vs, U };
}

/** Right singular vector belonging to the smallest singular value. */
export function nullVector(A: Matrix): number[] {
	const { V } = svd(A);
	return V.column(A.cols - 1);
}

// ---------------------------------------------------------------------------
// 3x3
// ---------------------------------------------------------------------------

export function mat3Mul(a: Mat3, b: Mat3): Mat3 {
	return [
		a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
		a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
		a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
		a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
		a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
		a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
		a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
		a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
		a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
	];
}

export function mat3MulVec(a: Mat3, v: Vec3): Vec3 {
	return [
		a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
		a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
		a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
	];
}

export function mat3Transpose(a: Mat3): Mat3 {
	return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
}

export function mat3Det(a: Mat3): number {
	return (
		a[0] * (a[4] * a[8] - a[5] * a[7]) -
		a[1] * (a[3] * a[8] - a[5] * a[6]) +
		a[2] * (a[3] * a[7] - a[4] * a[6])
	);
}

export function mat3Inverse(a: Mat3): Mat3 {
	const det = mat3Det(a);
	if (!Number.isFinite(det) || Math.abs(det) < 1e-300) {
		throw new Error("mat3Inverse: singular matrix");
	}
	const d = 1 / det;
	return [
		(a[4] * a[8] - a[5] * a[7]) * d,
		(a[2] * a[7] - a[1] * a[8]) * d,
		(a[1] * a[5] - a[2] * a[4]) * d,
		(a[5] * a[6] - a[3] * a[8]) * d,
		(a[0] * a[8] - a[2] * a[6]) * d,
		(a[2] * a[3] - a[0] * a[5]) * d,
		(a[3] * a[7] - a[4] * a[6]) * d,
		(a[1] * a[6] - a[0] * a[7]) * d,
		(a[0] * a[4] - a[1] * a[3]) * d,
	];
}

export function mat3Scale(a: Mat3, k: number): Mat3 {
	return [a[0] * k, a[1] * k, a[2] * k, a[3] * k, a[4] * k, a[5] * k, a[6] * k, a[7] * k, a[8] * k];
}

/** Builds a 3x3 from three column vectors. */
export function mat3FromColumns(c0: Vec3, c1: Vec3, c2: Vec3): Mat3 {
	return [c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]];
}

/** Literal indices, so the tuple stays soundly typed under strict indexing. */
export function mat3Column(a: Mat3, j: 0 | 1 | 2): Vec3 {
	switch (j) {
		case 0:
			return [a[0], a[3], a[6]];
		case 1:
			return [a[1], a[4], a[7]];
		default:
			return [a[2], a[5], a[8]];
	}
}

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

export function vec3Add(a: Vec3, b: Vec3): Vec3 {
	return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function vec3Sub(a: Vec3, b: Vec3): Vec3 {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vec3Scale(a: Vec3, k: number): Vec3 {
	return [a[0] * k, a[1] * k, a[2] * k];
}

export function vec3Dot(a: Vec3, b: Vec3): number {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vec3Cross(a: Vec3, b: Vec3): Vec3 {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function vec3Norm(a: Vec3): number {
	return Math.hypot(a[0], a[1], a[2]);
}

export function vec3Normalize(a: Vec3): Vec3 {
	const n = vec3Norm(a);
	if (n === 0) throw new Error("vec3Normalize: zero vector");
	return [a[0] / n, a[1] / n, a[2] / n];
}

// ---------------------------------------------------------------------------
// SO(3)
// ---------------------------------------------------------------------------

/** Skew-symmetric cross-product matrix. */
export function skew(w: Vec3): Mat3 {
	return [0, -w[2], w[1], w[2], 0, -w[0], -w[1], w[0], 0];
}

/** Rodrigues: rotation vector -> rotation matrix. */
export function expSO3(w: Vec3): Mat3 {
	const theta = vec3Norm(w);
	if (theta < 1e-12) {
		const K = skew(w);
		return [1 + K[0], K[1], K[2], K[3], 1 + K[4], K[5], K[6], K[7], 1 + K[8]];
	}
	const k: Vec3 = [w[0] / theta, w[1] / theta, w[2] / theta];
	const K = skew(k);
	const K2 = mat3Mul(K, K);
	const s = Math.sin(theta);
	const c = 1 - Math.cos(theta);
	const out: number[] = new Array(9);
	for (let i = 0; i < 9; i++) {
		out[i] = (i % 4 === 0 ? 1 : 0) + s * K[i]! + c * K2[i]!;
	}
	return out as unknown as Mat3;
}

/** Rotation matrix -> rotation vector. */
export function logSO3(R: Mat3): Vec3 {
	const trace = R[0] + R[4] + R[8];
	const cos = Math.min(1, Math.max(-1, (trace - 1) / 2));
	const theta = Math.acos(cos);
	if (theta < 1e-9) {
		return [(R[7] - R[5]) / 2, (R[2] - R[6]) / 2, (R[3] - R[1]) / 2];
	}
	const k = theta / (2 * Math.sin(theta));
	return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}

/** Geodesic angle between two rotations, in radians. */
export function rotationGeodesic(a: Mat3, b: Mat3): number {
	const rel = mat3Mul(mat3Transpose(a), b);
	const trace = rel[0] + rel[4] + rel[8];
	const cos = Math.min(1, Math.max(-1, (trace - 1) / 2));
	return Math.acos(cos);
}

/**
 * Nearest rotation matrix in the Frobenius sense (polar decomposition via SVD),
 * with the determinant forced to +1 so a reflection can never be returned.
 */
export function nearestRotation(M: Mat3): Mat3 {
	const A = new Matrix(3, 3, Float64Array.from(M));
	const { U, V } = svd(A);
	// R = U * diag(1,1,det(U V^T)) * V^T
	const u: Mat3 = [
		U.get(0, 0),
		U.get(0, 1),
		U.get(0, 2),
		U.get(1, 0),
		U.get(1, 1),
		U.get(1, 2),
		U.get(2, 0),
		U.get(2, 1),
		U.get(2, 2),
	];
	const v: Mat3 = [
		V.get(0, 0),
		V.get(0, 1),
		V.get(0, 2),
		V.get(1, 0),
		V.get(1, 1),
		V.get(1, 2),
		V.get(2, 0),
		V.get(2, 1),
		V.get(2, 2),
	];
	const uvT = mat3Mul(u, mat3Transpose(v));
	const d = mat3Det(uvT) < 0 ? -1 : 1;
	const corrected = mat3Mul(u, [1, 0, 0, 0, 1, 0, 0, 0, d]);
	return mat3Mul(corrected, mat3Transpose(v));
}

/** Householder reflection about the plane through the origin with unit normal n. */
export function householder(n: Vec3): Mat3 {
	return [
		1 - 2 * n[0] * n[0],
		-2 * n[0] * n[1],
		-2 * n[0] * n[2],
		-2 * n[1] * n[0],
		1 - 2 * n[1] * n[1],
		-2 * n[1] * n[2],
		-2 * n[2] * n[0],
		-2 * n[2] * n[1],
		1 - 2 * n[2] * n[2],
	];
}

// ---------------------------------------------------------------------------
// Small dense solve (for Levenberg-Marquardt normal equations)
// ---------------------------------------------------------------------------

/**
 * Solves the symmetric positive-definite system `A x = b` in place by Cholesky.
 * Returns null if A is not positive definite, which is the caller's signal to
 * raise the LM damping term.
 */
export function solveSpd(A: Matrix, b: number[]): number[] | null {
	const n = A.rows;
	const L = new Matrix(n, n);
	for (let i = 0; i < n; i++) {
		for (let j = 0; j <= i; j++) {
			let sum = A.get(i, j);
			for (let k = 0; k < j; k++) sum -= L.get(i, k) * L.get(j, k);
			if (i === j) {
				if (!(sum > 0)) return null;
				L.set(i, j, Math.sqrt(sum));
			} else {
				L.set(i, j, sum / L.get(j, j));
			}
		}
	}
	const y: number[] = new Array(n).fill(0);
	for (let i = 0; i < n; i++) {
		let sum = b[i]!;
		for (let k = 0; k < i; k++) sum -= L.get(i, k) * y[k]!;
		y[i] = sum / L.get(i, i);
	}
	const x: number[] = new Array(n).fill(0);
	for (let i = n - 1; i >= 0; i--) {
		let sum = y[i]!;
		for (let k = i + 1; k < n; k++) sum -= L.get(k, i) * x[k]!;
		x[i] = sum / L.get(i, i);
	}
	return x;
}
