import type { MarkerLayout } from "@core/marker.ts";
import type { ImagePoint } from "@core/types.ts";
import { grabFrame } from "./camera.ts";
import type { SolveResult } from "./protocol.ts";
import type { DetectorClient } from "./worker-client.ts";

export interface BurstOptions {
	readonly video: HTMLVideoElement;
	readonly canvas: HTMLCanvasElement;
	readonly detector: DetectorClient;
	readonly layout: MarkerLayout | null;
	readonly focalPx: number;
	readonly focalSigmaLog: number;
	readonly sigmaPx: number;
	readonly frames?: number;
	readonly onFrame?: (index: number, total: number) => void;
	/**
	 * Maximum quad movement between consecutive frames, as a fraction of the
	 * symbol's apparent edge. See the note on the motion gate below.
	 */
	readonly motionGate?: number;
}

export interface BurstOutcome {
	/** The frame the answer comes from, or null if nothing survived. */
	readonly chosen: SolveResult | null;
	/** A representative unresolved mirror pair, when that is why no answer survived. */
	readonly ambiguous: SolveResult | null;
	readonly survivors: readonly SolveResult[];
	readonly attempted: number;
	readonly rejectedForMotion: number;
	readonly rejectedBySolver: number;
	readonly reasons: readonly string[];
	readonly elapsedMs: number;
}

const DEFAULT_FRAMES = 8;

/**
 * Rolling shutter is the reason this gate exists.
 *
 * In the L2 degradation sweep, a rolling-shutter skew corresponding to a slow
 * hand pan pushed p50 bearing error from 0.06 to 1.49 degrees -- an order of
 * magnitude worse than blur, noise, glare or over-sharpening -- and it did it
 * while decoding perfectly, producing a low residual, and passing every
 * confidence gate. There is no signature in a single frame to catch it by,
 * because the skew is absorbed silently into the homography as a plausible
 * shear.
 *
 * What it does need is motion, and motion is visible *across* frames. So the
 * burst measures how far the quad travelled between consecutive captures and
 * throws away the ones taken while the phone was moving. It is the only defence
 * available, and without it the largest error in the system is invisible.
 */
const DEFAULT_MOTION_GATE = 0.02;

function centroid(quad: readonly ImagePoint[] | null): ImagePoint | null {
	if (!quad || quad.length === 0) return null;
	let x = 0;
	let y = 0;
	for (const p of quad) {
		x += p.x;
		y += p.y;
	}
	return { x: x / quad.length, y: y / quad.length };
}

function apparentEdge(quad: readonly ImagePoint[] | null): number {
	if (!quad || quad.length < 4) return Number.NaN;
	let total = 0;
	for (let i = 0; i < 4; i++) {
		const a = quad[i]!;
		const b = quad[(i + 1) % 4]!;
		total += Math.hypot(b.x - a.x, b.y - a.y);
	}
	return total / 4;
}

export async function captureBurst(options: BurstOptions): Promise<BurstOutcome> {
	const started = performance.now();
	const total = options.frames ?? DEFAULT_FRAMES;
	const gate = options.motionGate ?? DEFAULT_MOTION_GATE;

	const results: SolveResult[] = [];
	const centroids: (ImagePoint | null)[] = [];
	const reasons: string[] = [];
	let rejectedBySolver = 0;

	for (let i = 0; i < total; i++) {
		options.onFrame?.(i, total);
		const frame = grabFrame(options.video, options.canvas);
		if (!frame) continue;
		const result = await options.detector.solve(frame, {
			layout: options.layout,
			focalPx: options.focalPx,
			focalSigmaLog: options.focalSigmaLog,
			sigmaPx: options.sigmaPx,
		});
		results.push(result);
		centroids.push(centroid(result.detectedQuad));
		if (!result.ok && result.reason) reasons.push(result.reason.detail);
		// Give the sensor a moment so consecutive frames are genuinely different
		// exposures rather than the same buffer read twice.
		await new Promise((resolve) => setTimeout(resolve, 24));
	}

	// Motion, measured against whichever neighbour is closer in time.
	const moved: boolean[] = results.map(() => false);
	for (let i = 0; i < results.length; i++) {
		const here = centroids[i];
		const edge = apparentEdge(results[i]?.detectedQuad ?? null);
		if (!here || !Number.isFinite(edge) || edge <= 0) continue;
		let best = Number.POSITIVE_INFINITY;
		for (const j of [i - 1, i + 1]) {
			const other = centroids[j];
			if (!other) continue;
			best = Math.min(best, Math.hypot(other.x - here.x, other.y - here.y) / edge);
		}
		if (Number.isFinite(best) && best > gate) moved[i] = true;
	}

	let survivors = results.filter((r, i) => r.ok && !moved[i]);
	const ambiguous = medoid(results.filter((r) => r.reason?.code === "ambiguous"));
	const rejectedForMotion = results.filter((r, i) => r.ok && moved[i]).length;
	rejectedBySolver = results.filter((r) => !r.ok).length;

	// If motion knocked out everything, fall back rather than refuse outright --
	// a shaky capture with a wider error bar beats no answer at all.
	if (survivors.length === 0) survivors = results.filter((r) => r.ok);

	return {
		chosen: medoid(survivors),
		ambiguous,
		survivors,
		attempted: results.length,
		rejectedForMotion,
		rejectedBySolver,
		reasons: [...new Set(reasons)],
		elapsedMs: performance.now() - started,
	};
}

/**
 * The middle frame by azimuth, not the mean of all of them.
 *
 * Median rather than mean because the error distribution is bimodal, not
 * Gaussian: a frame that picked the wrong pose branch does not sit slightly off
 * the truth, it sits on the other side of the room, and averaging it in would
 * drag the answer into the middle where nobody was standing.
 *
 * Returning a single real frame rather than a blended one keeps the reported
 * pose, its covariance and the reprojection overlay describing the same
 * photograph. The burst's job here is outlier rejection; it deliberately does
 * not shrink the error bar, because burst frames share every systematic error
 * they have.
 */
function medoid(results: readonly SolveResult[]): SolveResult | null {
	if (results.length === 0) return null;
	const sorted = [...results].sort(
		(a, b) => (a.primary?.azimuthDeg ?? 0) - (b.primary?.azimuthDeg ?? 0),
	);
	return sorted[Math.floor(sorted.length / 2)] ?? null;
}
