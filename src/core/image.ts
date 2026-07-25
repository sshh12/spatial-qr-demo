/** Single-channel image, row-major, 8 bits per sample. */
export interface GrayImage {
	readonly data: Uint8Array | Uint8ClampedArray;
	readonly width: number;
	readonly height: number;
}

/** Linear-light image, row-major, one float per sample in [0, 1]. */
export interface LinearImage {
	readonly data: Float32Array;
	readonly width: number;
	readonly height: number;
}

const SRGB_TO_LINEAR = (() => {
	const lut = new Float32Array(256);
	for (let i = 0; i < 256; i++) {
		const c = i / 255;
		lut[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	}
	return lut;
})();

/** Rec.601 luma. */
export function rgbaToGray(
	rgba: Uint8Array | Uint8ClampedArray,
	width: number,
	height: number,
): GrayImage {
	const out = new Uint8Array(width * height);
	for (let i = 0, p = 0; i < out.length; i++, p += 4) {
		out[i] = (0.299 * rgba[p]! + 0.587 * rgba[p + 1]! + 0.114 * rgba[p + 2]! + 0.5) | 0;
	}
	return { data: out, width, height };
}

/**
 * Decodes sRGB to linear light.
 *
 * Sub-pixel edge location is the centroid of the intensity gradient, and that
 * centroid is only unbiased in the domain where the blur is actually linear --
 * which is radiance, not the gamma-encoded value a camera hands over. Skipping
 * this step biases every edge toward the dark side by an amount that depends on
 * the local contrast, which is a systematic error, not noise, and no amount of
 * frame averaging removes it.
 */
export function toLinear(gray: GrayImage): LinearImage {
	const out = new Float32Array(gray.width * gray.height);
	for (let i = 0; i < out.length; i++) out[i] = SRGB_TO_LINEAR[gray.data[i]!]!;
	return { data: out, width: gray.width, height: gray.height };
}

/**
 * Bilinear sample, with edge clamping.
 *
 * Coordinate convention, used everywhere in this project: pixel `i` covers the
 * continuous interval [i, i+1), so its centre sits at i + 0.5. This is what
 * zxing reports in `position` -- a 150-pixel-wide symbol starting at pixel 24
 * comes back as x = 24 to x = 174, not 23.5 to 173.5 -- and it is what the
 * synthetic renderer samples on. Bilinear interpolation is defined between
 * sample *centres*, hence the half-pixel shift below. Getting this wrong costs
 * a systematic half-pixel on every corner, which is larger than the entire
 * noise budget the accuracy claims are built on.
 */
export function sampleLinear(img: LinearImage, xContinuous: number, yContinuous: number): number {
	const w = img.width;
	const h = img.height;
	const x = xContinuous - 0.5;
	const y = yContinuous - 0.5;
	const cx = Math.min(w - 1.0001, Math.max(0, x));
	const cy = Math.min(h - 1.0001, Math.max(0, y));
	const x0 = Math.floor(cx);
	const y0 = Math.floor(cy);
	const fx = cx - x0;
	const fy = cy - y0;
	const i = y0 * w + x0;
	const a = img.data[i]!;
	const b = img.data[i + 1]!;
	const c = img.data[i + w]!;
	const d = img.data[i + w + 1]!;
	return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/** Box-downsamples by an integer factor; used to feed the live aiming loop. */
export function downsample(gray: GrayImage, factor: number): GrayImage {
	if (factor <= 1) return gray;
	const w = Math.max(1, Math.floor(gray.width / factor));
	const h = Math.max(1, Math.floor(gray.height / factor));
	const out = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let sum = 0;
			let n = 0;
			for (let dy = 0; dy < factor; dy++) {
				const sy = y * factor + dy;
				if (sy >= gray.height) break;
				for (let dx = 0; dx < factor; dx++) {
					const sx = x * factor + dx;
					if (sx >= gray.width) break;
					sum += gray.data[sy * gray.width + sx]!;
					n++;
				}
			}
			out[y * w + x] = n > 0 ? (sum / n) | 0 : 0;
		}
	}
	return { data: out, width: w, height: h };
}
