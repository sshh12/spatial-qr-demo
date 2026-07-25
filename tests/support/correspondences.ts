import type { Correspondence } from "@core/types.ts";
import {
	type Camera,
	gaussian,
	gtModelPoints,
	makeRng,
	project,
	type Viewpoint,
	viewpointToPose,
} from "./groundtruth.ts";

export interface SynthOptions {
	readonly moduleCount: number;
	/** Per-corner pixel noise, 1 sigma. */
	readonly sigmaPx?: number;
	readonly seed?: number;
	/** Scales the model coordinates, i.e. pretends the marker is a different size. */
	readonly modelScale?: number;
	/** Extra model points, in marker-edge units, e.g. full-bleed brackets. */
	readonly extraModelPoints?: readonly { readonly x: number; readonly y: number }[];
}

export interface Synth {
	readonly correspondences: Correspondence[];
	readonly truth: ReturnType<typeof viewpointToPose>;
	readonly camera: Camera;
	/** True if every projected point landed inside the frame. */
	readonly inFrame: boolean;
}

/**
 * Builds the exact correspondence set the real pipeline would produce if its
 * detector were perfect, with optional Gaussian corner noise. Projection runs
 * entirely through tests/support/groundtruth.ts, which shares no code with the
 * solver.
 */
export function synthesise(view: Viewpoint, camera: Camera, options: SynthOptions): Synth {
	const truth = viewpointToPose(view);
	const rng = makeRng(options.seed ?? 12345);
	const sigma = options.sigmaPx ?? 0;
	const scale = options.modelScale ?? 1;

	const points = gtModelPoints(options.moduleCount).map((p) => ({
		x: p.x,
		y: p.y,
		label: p.label,
	}));
	for (const extra of options.extraModelPoints ?? []) {
		points.push({ x: extra.x, y: extra.y, label: "bracket" });
	}

	const correspondences: Correspondence[] = [];
	let inFrame = true;
	for (const p of points) {
		const img = project(truth, camera, p);
		if (img.z <= 0) {
			inFrame = false;
			continue;
		}
		if (img.x < 0 || img.y < 0 || img.x > camera.width || img.y > camera.height) {
			inFrame = false;
		}
		correspondences.push({
			model: { x: p.x * scale, y: p.y * scale },
			image: {
				x: img.x + (sigma > 0 ? gaussian(rng) * sigma : 0),
				y: img.y + (sigma > 0 ? gaussian(rng) * sigma : 0),
			},
			weight: 1,
			kind: p.label.startsWith("symbol")
				? "symbol-corner"
				: p.label === "bracket"
					? "bracket"
					: p.label.includes("inner")
						? "finder-inner"
						: "finder-outer",
		});
	}

	return { correspondences, truth, camera, inFrame };
}

/** A 1920x1440 phone frame with a 26mm-equivalent lens. */
export function defaultCamera(width = 1920, height = 1440, equivMm = 26): Camera {
	return {
		f: (width * equivMm) / 36,
		cx: width / 2,
		cy: height / 2,
		width,
		height,
	};
}

/** Angular error between two camera positions as seen from the marker, degrees. */
export function bearingErrorDeg(
	a: readonly [number, number, number],
	b: readonly [number, number, number],
): number {
	const na = Math.hypot(a[0], a[1], a[2]);
	const nb = Math.hypot(b[0], b[1], b[2]);
	if (na === 0 || nb === 0) return Number.NaN;
	const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (na * nb);
	return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
}

export function percentile(values: number[], p: number): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((x, y) => x - y);
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx]!;
}
