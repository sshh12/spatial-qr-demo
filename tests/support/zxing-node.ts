import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { DetectedSymbol } from "@core/detect.ts";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";

let prepared = false;

/**
 * Points zxing-wasm at the copy of the reader wasm that npm already installed,
 * rather than the CDN it reaches for by default. The tests must not depend on
 * the network, and the browser build self-hosts the same file.
 */
export function prepareZXing(): void {
	if (prepared) return;
	const require = createRequire(import.meta.url);
	const bytes = readFileSync(require.resolve("zxing-wasm/reader/zxing_reader.wasm"));
	prepareZXingModule({
		overrides: {
			wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
		},
		fireImmediately: true,
	});
	prepared = true;
}

export interface DecodeResult {
	readonly symbol: DetectedSymbol | null;
	readonly raw: unknown;
}

/** Runs the real reader over a raw RGBA frame. */
export async function decodeFrame(
	rgba: Uint8ClampedArray,
	width: number,
	height: number,
): Promise<DecodeResult> {
	prepareZXing();
	const results = await readBarcodes(
		{ data: rgba, width, height, colorSpace: "srgb" } as unknown as ImageData,
		{ formats: ["QRCode"], tryHarder: true, maxNumberOfSymbols: 1 },
	);
	const first = results[0];
	if (!first?.isValid || !first.position) return { symbol: null, raw: first ?? null };

	const version = Number.parseInt(first.version, 10);
	const moduleCount = Number.isFinite(version)
		? 17 + 4 * version
		: Math.round(Math.sqrt(first.symbol?.data?.length ?? 0));

	return {
		symbol: {
			corners: [
				{ x: first.position.topLeft.x, y: first.position.topLeft.y },
				{ x: first.position.topRight.x, y: first.position.topRight.y },
				{ x: first.position.bottomRight.x, y: first.position.bottomRight.y },
				{ x: first.position.bottomLeft.x, y: first.position.bottomLeft.y },
			],
			moduleCount,
			text: first.text,
			isMirrored: first.isMirrored,
		},
		raw: first,
	};
}
