/// <reference lib="webworker" />
import { extractCorrespondences } from "@core/detect.ts";
import { applyHomography, homographyDLT } from "@core/homography.ts";
import { rgbaToGray, toLinear } from "@core/image.ts";
import { symbolModelCorners } from "@core/marker.ts";
import { PoseSolveError, solvePose } from "@core/pose.ts";
import type { ImagePoint } from "@core/types.ts";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
// Self-hosted: the reader wasm is emitted as an asset by the bundler rather
// than fetched from a CDN. No third-party origin, works offline, and it keeps
// the connect-src CSP down to 'self'.
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import {
	type AimResult,
	type SolveResult,
	serialiseBranch,
	type WorkerRequest,
} from "./protocol.ts";

const scope = self as unknown as {
	postMessage: (message: unknown) => void;
	addEventListener: (type: "message", handler: (event: MessageEvent) => void) => void;
};

prepareZXingModule({
	overrides: {
		locateFile: (path: string, prefix: string) =>
			path.endsWith(".wasm") ? wasmUrl : prefix + path,
	},
});

async function decode(rgba: Uint8ClampedArray, width: number, height: number) {
	const results = await readBarcodes(
		{ data: rgba, width, height, colorSpace: "srgb" } as unknown as ImageData,
		{ formats: ["QRCode"], tryHarder: true, maxNumberOfSymbols: 1 },
	);
	const first = results[0];
	if (!first?.isValid || !first.position) return null;
	const version = Number.parseInt(first.version, 10);
	return {
		corners: [
			{ x: first.position.topLeft.x, y: first.position.topLeft.y },
			{ x: first.position.topRight.x, y: first.position.topRight.y },
			{ x: first.position.bottomRight.x, y: first.position.bottomRight.y },
			{ x: first.position.bottomLeft.x, y: first.position.bottomLeft.y },
		] as [ImagePoint, ImagePoint, ImagePoint, ImagePoint],
		moduleCount: Number.isFinite(version) ? 17 + 4 * version : 25,
		text: first.text,
		isMirrored: first.isMirrored,
	};
}

function meanEdge(points: readonly ImagePoint[]): number {
	let total = 0;
	for (let i = 0; i < points.length; i++) {
		const a = points[i]!;
		const b = points[(i + 1) % points.length]!;
		total += Math.hypot(b.x - a.x, b.y - a.y);
	}
	return total / points.length;
}

scope.addEventListener("message", (event: MessageEvent) => {
	const message = event.data as WorkerRequest;
	void handle(message).catch((err) => {
		scope.postMessage({
			type: "error",
			id: "id" in message ? message.id : 0,
			message: err instanceof Error ? err.message : String(err),
		});
	});
});

async function handle(message: WorkerRequest): Promise<void> {
	if (message.type === "init") {
		// Force the wasm to instantiate now, during the cold-open screen, so that
		// the first real frame is not paying for a 450 KB download.
		await decode(new Uint8ClampedArray(4), 1, 1).catch(() => null);
		scope.postMessage({ type: "ready" });
		return;
	}

	const rgba = new Uint8ClampedArray(message.buffer);
	const found = await decode(rgba, message.width, message.height);

	if (message.type === "aim") {
		const border = 2;
		const result: AimResult = {
			type: "aim",
			id: message.id,
			found: Boolean(found),
			quad: found?.corners ?? null,
			pxPerModule: found ? meanEdge(found.corners) / found.moduleCount : 0,
			moduleCount: found?.moduleCount ?? 0,
			text: found?.text ?? null,
			touchesBorder: found
				? found.corners.some(
						(c) =>
							c.x < border ||
							c.y < border ||
							c.x > message.width - border ||
							c.y > message.height - border,
					)
				: false,
			isMirrored: found?.isMirrored ?? false,
		};
		scope.postMessage(result);
		return;
	}

	const fail = (reasonCode: string, detail: string): SolveResult => ({
		type: "solve",
		id: message.id,
		ok: false,
		reason: { code: reasonCode as never, detail },
		tier: null,
		primary: null,
		alternate: null,
		branchMargin: 0,
		pxPerModule: 0,
		pointCount: 0,
		bracketCount: 0,
		rmsPx: Number.NaN,
		focalPx: message.focalPx,
		reprojected: null,
		detectedQuad: found?.corners ?? null,
		text: found?.text ?? null,
		dropped: [],
		solveMs: 0,
	});

	if (!found) {
		scope.postMessage(fail("too-few-points", "no symbol in this frame"));
		return;
	}
	// Someone will photograph a reflection. isMirrored gives us that for free.
	if (found.isMirrored) {
		scope.postMessage(fail("mirrored", "this looks like a reflection"));
		return;
	}

	const linear = toLinear(rgbaToGray(rgba, message.width, message.height));
	const extraction = extractCorrespondences(linear, found, { layout: message.layout ?? null });

	if (extraction.touchesBorder) {
		scope.postMessage(fail("touches-border", "the code runs off the edge of the frame"));
		return;
	}
	if (extraction.correspondences.length < 8) {
		scope.postMessage(
			fail("too-few-points", `only ${extraction.correspondences.length} usable corners`),
		);
		return;
	}

	try {
		const solution = solvePose(extraction.correspondences, {
			imageWidth: message.width,
			imageHeight: message.height,
			moduleCount: found.moduleCount,
			sigmaPx: message.sigmaPx,
			prior: {
				f0: message.focalPx,
				sigmaLog: message.focalSigmaLog,
				source: "generic",
			},
		});

		const H = homographyDLT(extraction.correspondences);
		const reprojected = symbolModelCorners().map((m) => applyHomography(H, m));

		const result: SolveResult = {
			type: "solve",
			id: message.id,
			ok: solution.tier !== "refused",
			reason: solution.refusal,
			tier: solution.tier,
			primary: serialiseBranch(solution.primary),
			alternate: serialiseBranch(solution.alternate),
			branchMargin: solution.branchMargin,
			pxPerModule: solution.pxPerModule,
			pointCount: solution.pointCount,
			bracketCount: extraction.bracketCount,
			rmsPx: solution.primary.rmsPx,
			focalPx: solution.primary.focalPx,
			reprojected,
			detectedQuad: found.corners,
			text: found.text,
			dropped: extraction.dropped,
			solveMs: solution.solveMs,
		};
		scope.postMessage(result);
	} catch (err) {
		if (err instanceof PoseSolveError) {
			scope.postMessage(fail(err.refusal.code, err.refusal.detail));
			return;
		}
		throw err;
	}
}
