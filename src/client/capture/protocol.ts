import type { MarkerLayout } from "@core/marker.ts";
import type { ConfidenceTier, ImagePoint, PoseBranch, RefusalReason } from "@core/types.ts";

/** Messages between the capture UI and the detection worker. */

export interface InitMessage {
	readonly type: "init";
}

export interface AimMessage {
	readonly type: "aim";
	readonly id: number;
	readonly buffer: ArrayBuffer;
	readonly width: number;
	readonly height: number;
}

export interface SolveMessage {
	readonly type: "solve";
	readonly id: number;
	readonly buffer: ArrayBuffer;
	readonly width: number;
	readonly height: number;
	readonly layout: MarkerLayout | null;
	readonly focalPx: number;
	readonly focalSigmaLog: number;
	readonly sigmaPx: number;
	readonly expectedText: string | null;
}

export type WorkerRequest = InitMessage | AimMessage | SolveMessage;

export interface AimResult {
	readonly type: "aim";
	readonly id: number;
	readonly found: boolean;
	readonly quad: readonly ImagePoint[] | null;
	readonly pxPerModule: number;
	readonly moduleCount: number;
	readonly text: string | null;
	readonly touchesBorder: boolean;
	readonly isMirrored: boolean;
}

export interface SolveResult {
	readonly type: "solve";
	readonly id: number;
	readonly ok: boolean;
	readonly reason: RefusalReason | null;
	readonly tier: ConfidenceTier | null;
	readonly primary: SerialBranch | null;
	readonly alternate: SerialBranch | null;
	readonly branchMargin: number;
	readonly pxPerModule: number;
	readonly pointCount: number;
	readonly bracketCount: number;
	readonly rmsPx: number;
	readonly focalPx: number;
	/** The reprojected model quad, drawn over the frozen frame. */
	readonly reprojected: readonly ImagePoint[] | null;
	readonly detectedQuad: readonly ImagePoint[] | null;
	readonly text: string | null;
	readonly dropped: readonly string[];
	readonly solveMs: number;
}

export interface ReadyResult {
	readonly type: "ready";
}

export interface ErrorResult {
	readonly type: "error";
	readonly id: number;
	readonly message: string;
}

export type WorkerResponse = AimResult | SolveResult | ReadyResult | ErrorResult;

/** A PoseBranch flattened for structured clone; matrices stay as arrays. */
export interface SerialBranch {
	readonly azimuthDeg: number;
	readonly elevationDeg: number;
	readonly distanceEdges: number;
	readonly camera: readonly [number, number, number];
	readonly bearingSigmaDeg: number;
	readonly distanceSigmaRel: number;
	readonly focalPx: number;
	readonly focalSigmaLog: number;
	readonly rmsPx: number;
	readonly floorCovariance: readonly [number, number, number, number];
}

export function serialiseBranch(branch: PoseBranch): SerialBranch {
	return {
		azimuthDeg: branch.azimuthDeg,
		elevationDeg: branch.elevationDeg,
		distanceEdges: branch.distanceEdges,
		camera: [branch.camera[0], branch.camera[1], branch.camera[2]],
		bearingSigmaDeg: branch.bearingSigmaDeg,
		distanceSigmaRel: branch.distanceSigmaRel,
		focalPx: branch.focalPx,
		focalSigmaLog: branch.focalSigmaLog,
		rmsPx: branch.rmsPx,
		floorCovariance: branch.floorCovariance,
	};
}
