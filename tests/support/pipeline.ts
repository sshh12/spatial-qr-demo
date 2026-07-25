import { type Extraction, extractCorrespondences } from "@core/detect.ts";
import { rgbaToGray, toLinear } from "@core/image.ts";
import type { MarkerLayout } from "@core/marker.ts";
import { DEFAULT_GATES, type Gates, PoseSolveError, solvePose } from "@core/pose.ts";
import type { FocalPrior, PoseSolution } from "@core/types.ts";
import type { Camera, Viewpoint } from "./groundtruth.ts";
import { cssToModel, type Degradations, type DisplayContent, render } from "./render.ts";
import { decodeFrame } from "./zxing-node.ts";

/**
 * The whole system under test: render a frame through the independent
 * ray-casting generator, decode it with the real zxing-wasm build, refine the
 * corners, solve, and compare against the pose the generator was given.
 */
export interface L2Case {
	readonly view: Viewpoint;
	readonly camera: Camera;
	readonly display: DisplayContent;
	readonly degradations?: Degradations;
	readonly supersample?: number;
	/** Per-corner noise the solver is told to assume. */
	readonly sigmaPx?: number;
	/** Relative error deliberately injected into the focal prior's mean. */
	readonly priorRelError?: number;
	readonly priorSigmaLog?: number;
	readonly useBrackets?: boolean;
	readonly gates?: Gates;
	readonly principalPointSigmaPx?: number;
}

export interface L2Outcome {
	readonly decoded: boolean;
	readonly extraction: Extraction | null;
	readonly solution: PoseSolution | null;
	readonly error: string | null;
	/** Angle between the solved and true camera directions, in degrees. */
	readonly bearingErrorDeg: number;
	/** Signed azimuth error, in degrees. */
	readonly azimuthErrorDeg: number;
	readonly elevationErrorDeg: number;
	/** Relative distance error, dimensionless. */
	readonly distanceRelError: number;
	/** True when the solver put the viewer on the wrong side of the display. */
	readonly flipped: boolean;
	readonly pxPerModule: number;
	readonly pointCount: number;
	readonly bracketCount: number;
	readonly renderMs: number;
	readonly solveMs: number;
}

/** Describes to the detector exactly what the display was showing. */
export function layoutFromDisplay(
	display: DisplayContent,
	symbolEdgeMm: number,
	withBrackets: boolean,
): MarkerLayout {
	return {
		id: withBrackets ? "fullbleed" : "idle",
		moduleCount: display.modules.size,
		symbolEdgeCssPx: display.symbolEdgeCss,
		symbolEdgeMm,
		viewportCssPx: { w: display.widthCss, h: display.heightCss },
		symbolCentreCssPx: display.symbolCentreCss,
		brackets:
			withBrackets && display.brackets
				? display.brackets.map((b) => ({
						corner: b.corner,
						armA: b.armA,
						armB: b.armB,
						thicknessCssPx: b.thicknessCss,
					}))
				: null,
		nonce: "TEST",
	};
}

export async function runCase(testCase: L2Case): Promise<L2Outcome> {
	const t0 = performance.now();
	const frame = render({
		camera: testCase.camera,
		view: testCase.view,
		display: testCase.display,
		supersample: testCase.supersample ?? 4,
		degradations: testCase.degradations,
	});
	const renderMs = performance.now() - t0;

	const empty = {
		decoded: false,
		extraction: null,
		solution: null,
		bearingErrorDeg: Number.NaN,
		azimuthErrorDeg: Number.NaN,
		elevationErrorDeg: Number.NaN,
		distanceRelError: Number.NaN,
		flipped: false,
		pxPerModule: Number.NaN,
		pointCount: 0,
		bracketCount: 0,
		renderMs,
		solveMs: 0,
	};

	const { symbol } = await decodeFrame(frame.rgba, frame.width, frame.height);
	if (!symbol) return { ...empty, error: "no-decode" };

	const linear = toLinear(rgbaToGray(frame.rgba, frame.width, frame.height));
	const layout = layoutFromDisplay(
		testCase.display,
		testCase.display.symbolEdgeCss,
		testCase.useBrackets ?? false,
	);
	const extraction = extractCorrespondences(linear, symbol, { layout });

	if (extraction.correspondences.length < 8) {
		return { ...empty, decoded: true, extraction, error: "too-few-points" };
	}

	const sigmaPx = testCase.sigmaPx ?? 0.35;
	const prior: FocalPrior = {
		f0: testCase.camera.f * (1 + (testCase.priorRelError ?? 0)),
		sigmaLog: testCase.priorSigmaLog ?? 0.15,
		source: "generic",
	};

	let solution: PoseSolution;
	try {
		solution = solvePose(extraction.correspondences, {
			imageWidth: frame.width,
			imageHeight: frame.height,
			moduleCount: symbol.moduleCount,
			sigmaPx,
			principalPointSigmaPx: testCase.principalPointSigmaPx ?? 0,
			prior,
			gates: testCase.gates ?? DEFAULT_GATES,
		});
	} catch (err) {
		return {
			...empty,
			decoded: true,
			extraction,
			error: err instanceof PoseSolveError ? err.refusal.code : String(err),
		};
	}

	const truthC = frame.truth.C;
	const p = solution.primary.camera;
	const nTruth = Math.hypot(truthC[0], truthC[1], truthC[2]);
	const nSolved = Math.hypot(p[0], p[1], p[2]);
	const cos = (p[0] * truthC[0] + p[1] * truthC[1] + p[2] * truthC[2]) / (nTruth * nSolved);
	const trueAz = (Math.atan2(truthC[0], truthC[2]) * 180) / Math.PI;
	const trueEl = (Math.atan2(truthC[1], Math.hypot(truthC[0], truthC[2])) * 180) / Math.PI;

	return {
		decoded: true,
		extraction,
		solution,
		error: null,
		bearingErrorDeg: (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI,
		azimuthErrorDeg: solution.primary.azimuthDeg - trueAz,
		elevationErrorDeg: solution.primary.elevationDeg - trueEl,
		distanceRelError: (nSolved - nTruth) / nTruth,
		flipped: Math.abs(trueAz) > 2 && Math.sign(solution.primary.azimuthDeg) !== Math.sign(trueAz),
		pxPerModule: solution.pxPerModule,
		pointCount: solution.pointCount,
		bracketCount: extraction.bracketCount,
		renderMs,
		solveMs: solution.solveMs,
	};
}

/** Where a model point lands on the display, for assertions about geometry. */
export { cssToModel };
