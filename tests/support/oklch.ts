/**
 * sRGB <-> OKLCH, written out here rather than pulled in as a dependency.
 *
 * Used by tests/unit/palette.test.ts to check that the OKLCH tokens Tailwind
 * consumes and the sRGB hex mirrors three.js consumes still describe the same
 * colours. Two encodings of one palette is a maintenance hazard unless the
 * agreement is enforced.
 */

export interface Oklch {
	readonly l: number;
	readonly c: number;
	readonly h: number;
}

function srgbToLinear(v: number): number {
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(v: number): number {
	return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}

export function hexToRgb(hex: string): [number, number, number] {
	const clean = hex.replace("#", "");
	const full =
		clean.length === 3
			? clean
					.split("")
					.map((c) => c + c)
					.join("")
			: clean;
	return [
		Number.parseInt(full.slice(0, 2), 16) / 255,
		Number.parseInt(full.slice(2, 4), 16) / 255,
		Number.parseInt(full.slice(4, 6), 16) / 255,
	];
}

export function rgbToHex(r: number, g: number, b: number): string {
	const to = (v: number) =>
		Math.max(0, Math.min(255, Math.round(v * 255)))
			.toString(16)
			.padStart(2, "0");
	return `#${to(r)}${to(g)}${to(b)}`;
}

export function hexToOklch(hex: string): Oklch {
	const [sr, sg, sb] = hexToRgb(hex);
	const r = srgbToLinear(sr);
	const g = srgbToLinear(sg);
	const b = srgbToLinear(sb);

	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

	const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
	const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

	const chroma = Math.hypot(A, B);
	let hue = (Math.atan2(B, A) * 180) / Math.PI;
	if (hue < 0) hue += 360;
	return { l: L, c: chroma, h: hue };
}

export function oklchToHex(colour: Oklch): string {
	const hRad = (colour.h * Math.PI) / 180;
	const A = colour.c * Math.cos(hRad);
	const B = colour.c * Math.sin(hRad);

	const l_ = colour.l + 0.3963377774 * A + 0.2158037573 * B;
	const m_ = colour.l - 0.1055613458 * A - 0.0638541728 * B;
	const s_ = colour.l - 0.0894841775 * A - 1.291485548 * B;

	const l = l_ ** 3;
	const m = m_ ** 3;
	const s = s_ ** 3;

	return rgbToHex(
		linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
		linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
		linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
	);
}

/** Perceptual distance in OKLab, which is roughly "just noticeable" at 0.02. */
export function deltaOk(a: string, b: string): number {
	const x = hexToOklch(a);
	const y = hexToOklch(b);
	const ax = x.c * Math.cos((x.h * Math.PI) / 180);
	const bx = x.c * Math.sin((x.h * Math.PI) / 180);
	const ay = y.c * Math.cos((y.h * Math.PI) / 180);
	const by = y.c * Math.sin((y.h * Math.PI) / 180);
	return Math.hypot(x.l - y.l, ax - ay, bx - by);
}
