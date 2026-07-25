import { QUIET_ZONE_MODULES } from "@core/marker.ts";
import QRCode from "qrcode";

export interface ModuleMatrix {
	readonly size: number;
	readonly version: number;
	readonly get: (col: number, row: number) => boolean;
}

export function buildModules(text: string, minVersion?: number): ModuleMatrix {
	const qr = QRCode.create(text, {
		errorCorrectionLevel: "M",
		// Version 1 has no alignment pattern and collapses at oblique angles:
		// measured 2/9 decodes at 60 degrees yaw against version 2's 8/9.
		...(minVersion ? { version: Math.max(2, minVersion) } : {}),
	});
	const size = qr.modules.size;
	const data = qr.modules.data;
	if (size < 25) throw new Error(`refusing to render QR version ${qr.version}; need >= 2`);
	return {
		size,
		version: qr.version,
		get: (col, row) =>
			col >= 0 && row >= 0 && col < size && row < size && data[row * size + col] === 1,
	};
}

export interface PaintResult {
	/** Integer device pixels per module. */
	readonly modulePx: number;
	/** Symbol edge in CSS pixels, EXCLUDING the quiet zone. */
	readonly symbolEdgeCssPx: number;
	/** Whole rendered box in CSS pixels, INCLUDING the quiet zone. */
	readonly boxCssPx: number;
	readonly moduleCount: number;
}

/**
 * Paints a symbol at an exact integer number of device pixels per module.
 *
 * A fractional module size means anti-aliased module edges, and an anti-aliased
 * edge is a biased edge: the sub-pixel refiner locates the gradient centroid,
 * and a resampled boundary moves that centroid by a fraction of a pixel in a
 * direction that depends on the phase. That is a systematic error, and no
 * amount of frame averaging removes it. Hence: integer modules, no CSS
 * transform in the ancestor chain, and image-rendering: pixelated.
 */
export function paintMarker(
	canvas: HTMLCanvasElement,
	modules: ModuleMatrix,
	targetBoxCssPx: number,
	devicePixelRatio: number,
): PaintResult {
	const totalModules = modules.size + QUIET_ZONE_MODULES * 2;
	const modulePx = Math.max(1, Math.floor((targetBoxCssPx * devicePixelRatio) / totalModules));
	const sizeDevicePx = totalModules * modulePx;

	canvas.width = sizeDevicePx;
	canvas.height = sizeDevicePx;
	const boxCssPx = sizeDevicePx / devicePixelRatio;
	canvas.style.width = `${boxCssPx}px`;
	canvas.style.height = `${boxCssPx}px`;

	const ctx = canvas.getContext("2d", { alpha: false });
	if (!ctx) throw new Error("2d context unavailable");
	ctx.imageSmoothingEnabled = false;

	// The quiet zone is pure white always, even in dark mode. It is part of the
	// symbol's definition, not decoration.
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, sizeDevicePx, sizeDevicePx);
	ctx.fillStyle = "#000000";
	for (let row = 0; row < modules.size; row++) {
		for (let col = 0; col < modules.size; col++) {
			if (!modules.get(col, row)) continue;
			ctx.fillRect(
				(col + QUIET_ZONE_MODULES) * modulePx,
				(row + QUIET_ZONE_MODULES) * modulePx,
				modulePx,
				modulePx,
			);
		}
	}

	return {
		modulePx,
		symbolEdgeCssPx: (modules.size * modulePx) / devicePixelRatio,
		boxCssPx,
		moduleCount: modules.size,
	};
}
