import QRCode from "qrcode";
import {
	type Camera,
	type GroundTruth,
	gaussian,
	makeRng,
	matT,
	matVec,
	type V3,
	type Viewpoint,
	viewpointToPose,
} from "./groundtruth.ts";

/**
 * Synthetic capture of a display showing a QR marker.
 *
 * THIS FILE MUST NOT IMPORT ANYTHING FROM src/core.
 *
 * It works by ray casting -- for every sample, a ray leaves the camera, meets
 * the marker plane, and reads the display's paint function at that point. The
 * solver works the other way, projecting model points forward through a
 * homography. Two opposite directions through two separately written
 * implementations is the only way the accuracy numbers mean anything.
 */

// ---------------------------------------------------------------------------
// The display
// ---------------------------------------------------------------------------

export interface DisplayContent {
	/** Viewport size in CSS pixels. */
	readonly widthCss: number;
	readonly heightCss: number;
	/** Symbol edge in CSS pixels, excluding the quiet zone. */
	readonly symbolEdgeCss: number;
	readonly symbolCentreCss: { readonly x: number; readonly y: number };
	readonly modules: { readonly size: number; readonly get: (col: number, row: number) => boolean };
	readonly brackets:
		| readonly {
				readonly corner: { x: number; y: number };
				readonly armA: { x: number; y: number };
				readonly armB: { x: number; y: number };
				readonly thicknessCss: number;
		  }[]
		| null;
	/** Page background outside the quiet zone, in linear light. */
	readonly pageLinear: number;
	/** Simulated panel subpixel pitch in CSS px; 0 disables the panel model. */
	readonly panelPitchCss: number;
	/** Depth of the panel's black matrix, 0..1. */
	readonly panelDepth: number;
}

export interface MarkerSpec {
	readonly text: string;
	readonly version?: number;
	readonly errorCorrectionLevel?: "L" | "M" | "Q" | "H";
}

export function buildModules(spec: MarkerSpec): {
	size: number;
	get: (col: number, row: number) => boolean;
	version: number;
} {
	const qr = QRCode.create(spec.text, {
		errorCorrectionLevel: spec.errorCorrectionLevel ?? "M",
		...(spec.version ? { version: spec.version } : {}),
	});
	const size = qr.modules.size;
	const data = qr.modules.data;
	return {
		size,
		version: qr.version,
		get: (col, row) => {
			if (col < 0 || row < 0 || col >= size || row >= size) return false;
			return data[row * size + col] === 1;
		},
	};
}

export interface DisplayOptions {
	readonly widthCss?: number;
	readonly heightCss?: number;
	/** "idle" puts the marker at 34% of viewport height; "fullbleed" at 88%. */
	readonly mode?: "idle" | "fullbleed";
	readonly withBrackets?: boolean;
	readonly panelPitchCss?: number;
	readonly panelDepth?: number;
	/** Vertical offset of the marker centre, as a fraction of viewport height. */
	readonly verticalOffset?: number;
}

export function makeDisplay(spec: MarkerSpec, options: DisplayOptions = {}): DisplayContent {
	const widthCss = options.widthCss ?? 2560;
	const heightCss = options.heightCss ?? 1440;
	const mode = options.mode ?? "fullbleed";
	const modules = buildModules(spec);

	// The quiet-zone-inclusive box, then back out the symbol edge from it. Getting
	// this backwards -- treating the rendered box as the symbol -- overstates
	// distance by 32% at version 2.
	const boxFraction = mode === "fullbleed" ? 0.88 : 0.34;
	const boxCss = heightCss * boxFraction;
	const symbolEdgeCss = (boxCss * modules.size) / (modules.size + 8);

	const offset = options.verticalOffset ?? (mode === "fullbleed" ? 0.02 : 0);
	const centre = { x: widthCss / 2, y: heightCss * (0.5 + offset) };

	const inset = Math.round(heightCss * 0.02);
	const armLength = Math.round(Math.min(widthCss, heightCss) * 0.16);
	const thickness = Math.max(3, Math.round(heightCss * 0.011));
	const corners = [
		{ x: inset, y: inset },
		{ x: widthCss - inset, y: inset },
		{ x: widthCss - inset, y: heightCss - inset },
		{ x: inset, y: heightCss - inset },
	];
	const brackets = options.withBrackets
		? corners.map((c, i) => {
				const next = corners[(i + 1) % 4]!;
				const prev = corners[(i + 3) % 4]!;
				const toward = (p: { x: number; y: number }) => {
					const dx = p.x - c.x;
					const dy = p.y - c.y;
					const len = Math.hypot(dx, dy);
					return { x: c.x + (dx / len) * armLength, y: c.y + (dy / len) * armLength };
				};
				return { corner: c, armA: toward(next), armB: toward(prev), thicknessCss: thickness };
			})
		: null;

	return {
		widthCss,
		heightCss,
		symbolEdgeCss,
		symbolCentreCss: centre,
		modules,
		brackets,
		pageLinear: 1,
		panelPitchCss: options.panelPitchCss ?? 0,
		panelDepth: options.panelDepth ?? 0.55,
	};
}

/** Linear-light reflectance of the display at a CSS-pixel coordinate. */
function paint(d: DisplayContent, x: number, y: number): number {
	let value = d.pageLinear;

	const half = d.symbolEdgeCss / 2;
	const left = d.symbolCentreCss.x - half;
	const top = d.symbolCentreCss.y - half;
	const moduleCss = d.symbolEdgeCss / d.modules.size;

	if (x >= left && x < left + d.symbolEdgeCss && y >= top && y < top + d.symbolEdgeCss) {
		const col = Math.floor((x - left) / moduleCss);
		const row = Math.floor((y - top) / moduleCss);
		value = d.modules.get(col, row) ? 0 : 1;
	}

	if (d.brackets) {
		const centre = { x: d.widthCss / 2, y: d.heightCss / 2 };
		for (const b of d.brackets) {
			if (
				inArm(b.corner, b.armA, b.thicknessCss, centre, x, y) ||
				inArm(b.corner, b.armB, b.thicknessCss, centre, x, y)
			) {
				return panel(d, x, y, 0);
			}
		}
	}

	return panel(d, x, y, value);
}

/**
 * A bracket arm is a rectangle running from the outer corner along the display
 * edge, with its thickness growing *inward*. The outer edge is therefore exactly
 * the display edge line, which is the line the refiner fits.
 */
function inArm(
	corner: { x: number; y: number },
	end: { x: number; y: number },
	thickness: number,
	centre: { x: number; y: number },
	x: number,
	y: number,
): boolean {
	const dx = end.x - corner.x;
	const dy = end.y - corner.y;
	const len = Math.hypot(dx, dy);
	if (len < 1e-9) return false;
	const ux = dx / len;
	const uy = dy / len;

	let nx = -uy;
	let ny = ux;
	if (nx * (centre.x - corner.x) + ny * (centre.y - corner.y) < 0) {
		nx = -nx;
		ny = -ny;
	}

	const px = x - corner.x;
	const py = y - corner.y;
	const along = px * ux + py * uy;
	const across = px * nx + py * ny;
	return along >= 0 && along <= len && across >= 0 && across <= thickness;
}

/**
 * The panel's own pixel structure.
 *
 * Real screen-capture moire comes from the display's black matrix beating
 * against the sensor's pixel grid. Modelling the matrix here and integrating
 * over the sensor's pixel footprint reproduces that mechanism, rather than the
 * unrelated aliasing that a naive downsample test produces.
 */
function panel(d: DisplayContent, x: number, y: number, value: number): number {
	if (d.panelPitchCss <= 0) return value;
	const fx = (((x / d.panelPitchCss) % 1) + 1) % 1;
	const fy = (((y / d.panelPitchCss) % 1) + 1) % 1;
	const gap = 0.18;
	const dark = fx < gap || fy < gap;
	return dark ? value * (1 - d.panelDepth) : value;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export interface Degradations {
	/** Optical blur, 1 sigma, in output pixels. */
	readonly blurPx?: number;
	/** Sensor noise, 1 sigma, in 8-bit levels. */
	readonly noiseLevels?: number;
	/** Unsharp-mask amount applied by the ISP; phones do this and it biases edges. */
	readonly sharpen?: number;
	/** Encoding gamma; 2.2 is sRGB-ish. */
	readonly gamma?: number;
	/** Additive specular glare: centre in normalised frame coords and strength. */
	readonly glare?: {
		readonly x: number;
		readonly y: number;
		readonly r: number;
		readonly strength: number;
	};
	/**
	 * Rolling-shutter skew: total horizontal camera translation, in marker-edge
	 * units, swept across the frame from first row to last.
	 */
	readonly rollingShutterEdges?: number;
	/** Exposure multiplier applied in linear light before encoding. */
	readonly exposure?: number;
	readonly seed?: number;
}

export interface RenderOptions {
	readonly camera: Camera;
	readonly view: Viewpoint;
	readonly display: DisplayContent;
	/** Samples per output pixel, per axis. */
	readonly supersample?: number;
	readonly degradations?: Degradations;
	/** Linear-light value of everything that is not the display. */
	readonly roomLinear?: number;
}

export interface RenderResult {
	readonly gray: Uint8Array;
	readonly rgba: Uint8ClampedArray;
	readonly width: number;
	readonly height: number;
	readonly truth: GroundTruth;
	/** Symbol edge in marker-edge units is 1 by definition; this is its px size. */
	readonly symbolEdgePx: number;
	readonly moduleCount: number;
}

/** Display CSS pixel <-> marker-edge model coordinate. */
export function cssToModel(d: DisplayContent, p: { x: number; y: number }) {
	return {
		x: (p.x - d.symbolCentreCss.x) / d.symbolEdgeCss,
		y: -(p.y - d.symbolCentreCss.y) / d.symbolEdgeCss,
	};
}

export function modelToCss(d: DisplayContent, p: { x: number; y: number }) {
	return {
		x: p.x * d.symbolEdgeCss + d.symbolCentreCss.x,
		y: -p.y * d.symbolEdgeCss + d.symbolCentreCss.y,
	};
}

export function render(options: RenderOptions): RenderResult {
	const { camera, display } = options;
	const deg = options.degradations ?? {};
	const ss = options.supersample ?? 4;
	const rng = makeRng(deg.seed ?? 4242);
	const truth = viewpointToPose(options.view);
	const Rt = matT(truth.R);
	const roomLinear = options.roomLinear ?? 0.06;

	const width = camera.width;
	const height = camera.height;
	const linear = new Float32Array(width * height).fill(roomLinear);

	// Half-extent of the display in model units, plus a margin, so that only the
	// pixels that can possibly see the display are ray cast.
	const halfW = display.widthCss / 2 / display.symbolEdgeCss;
	const halfH = display.heightCss / 2 / display.symbolEdgeCss;
	const centre = cssToModel(display, {
		x: display.widthCss / 2,
		y: display.heightCss / 2,
	});

	const bounds = projectedBounds(truth, camera, centre, halfW, halfH);
	const x0 = Math.max(0, Math.floor(bounds.minX) - 2);
	const x1 = Math.min(width - 1, Math.ceil(bounds.maxX) + 2);
	const y0 = Math.max(0, Math.floor(bounds.minY) - 2);
	const y1 = Math.min(height - 1, Math.ceil(bounds.maxY) + 2);

	const blur = deg.blurPx ?? 0;
	const shutter = deg.rollingShutterEdges ?? 0;

	for (let py = y0; py <= y1; py++) {
		// Rolling shutter: the camera keeps moving while the sensor reads out, so
		// each row sees the world from a slightly different place.
		const rowShift = shutter * (py / Math.max(1, height - 1) - 0.5);
		const origin: V3 = [truth.C[0] + rowShift, truth.C[1], truth.C[2]];

		for (let px = x0; px <= x1; px++) {
			let acc = 0;
			for (let sy = 0; sy < ss; sy++) {
				for (let sx = 0; sx < ss; sx++) {
					// Stratified box sample over the pixel footprint, plus a Gaussian
					// offset standing in for the optical point-spread function. Doing the
					// blur here rather than as a post-pass keeps it in linear light and
					// ahead of sensor sampling, which is where it physically belongs.
					let ox = (sx + rng()) / ss - 0.5;
					let oy = (sy + rng()) / ss - 0.5;
					if (blur > 0) {
						ox += gaussian(rng) * blur;
						oy += gaussian(rng) * blur;
					}
					acc += traceSample(origin, Rt, camera, display, px + 0.5 + ox, py + 0.5 + oy, roomLinear);
				}
			}
			linear[py * width + px] = acc / (ss * ss);
		}
	}

	// Glare: additive, in linear light, before encoding.
	if (deg.glare) {
		const gx = deg.glare.x * width;
		const gy = deg.glare.y * height;
		const r2 = (deg.glare.r * Math.min(width, height)) ** 2;
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const d2 = (x - gx) ** 2 + (y - gy) ** 2;
				linear[y * width + x]! += deg.glare.strength * Math.exp(-d2 / r2);
			}
		}
	}

	const exposure = deg.exposure ?? 1;
	const gamma = deg.gamma ?? 2.2;
	const gray = new Uint8Array(width * height);
	for (let i = 0; i < linear.length; i++) {
		const v = Math.max(0, Math.min(1, linear[i]! * exposure));
		gray[i] = Math.round(255 * v ** (1 / gamma));
	}

	if (deg.sharpen && deg.sharpen > 0) unsharp(gray, width, height, deg.sharpen);

	if (deg.noiseLevels && deg.noiseLevels > 0) {
		for (let i = 0; i < gray.length; i++) {
			gray[i] = Math.max(0, Math.min(255, Math.round(gray[i]! + gaussian(rng) * deg.noiseLevels)));
		}
	}

	const rgba = new Uint8ClampedArray(width * height * 4);
	for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
		rgba[p] = gray[i]!;
		rgba[p + 1] = gray[i]!;
		rgba[p + 2] = gray[i]!;
		rgba[p + 3] = 255;
	}

	return {
		gray,
		rgba,
		width,
		height,
		truth,
		symbolEdgePx: camera.f / options.view.distanceEdges,
		moduleCount: display.modules.size,
	};
}

function traceSample(
	origin: V3,
	Rt: ReturnType<typeof matT>,
	camera: Camera,
	display: DisplayContent,
	px: number,
	py: number,
	roomLinear: number,
): number {
	// Ray direction in the camera frame, then rotated into the marker frame.
	const dCam: V3 = [(px - camera.cx) / camera.f, (py - camera.cy) / camera.f, 1];
	const d = matVec(Rt, dCam);
	if (Math.abs(d[2]) < 1e-12) return roomLinear;
	const t = -origin[2] / d[2];
	if (t <= 0) return roomLinear;

	const mx = origin[0] + t * d[0];
	const my = origin[1] + t * d[1];
	const css = modelToCss(display, { x: mx, y: my });
	if (css.x < 0 || css.y < 0 || css.x >= display.widthCss || css.y >= display.heightCss) {
		return roomLinear;
	}
	return paint(display, css.x, css.y);
}

function projectedBounds(
	truth: GroundTruth,
	camera: Camera,
	centre: { x: number; y: number },
	halfW: number,
	halfH: number,
) {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const sx of [-1, 1]) {
		for (const sy of [-1, 1]) {
			const p: V3 = [centre.x + sx * halfW, centre.y + sy * halfH, 0];
			const c = matVec(truth.R, p);
			const z = c[2] + truth.t[2];
			if (z <= 1e-6) return { minX: 0, minY: 0, maxX: camera.width, maxY: camera.height };
			const x = (camera.f * (c[0] + truth.t[0])) / z + camera.cx;
			const y = (camera.f * (c[1] + truth.t[1])) / z + camera.cy;
			minX = Math.min(minX, x);
			maxX = Math.max(maxX, x);
			minY = Math.min(minY, y);
			maxY = Math.max(maxY, y);
		}
	}
	return { minX, minY, maxX, maxY };
}

/** Unsharp mask with a 3x3 kernel, the way a phone ISP over-sharpens. */
function unsharp(gray: Uint8Array, width: number, height: number, amount: number): void {
	const copy = Uint8Array.from(gray);
	for (let y = 1; y < height - 1; y++) {
		for (let x = 1; x < width - 1; x++) {
			const i = y * width + x;
			const blurred =
				(copy[i - width - 1]! +
					2 * copy[i - width]! +
					copy[i - width + 1]! +
					2 * copy[i - 1]! +
					4 * copy[i]! +
					2 * copy[i + 1]! +
					copy[i + width - 1]! +
					2 * copy[i + width]! +
					copy[i + width + 1]!) /
				16;
			gray[i] = Math.max(0, Math.min(255, Math.round(copy[i]! + amount * (copy[i]! - blurred))));
		}
	}
}
