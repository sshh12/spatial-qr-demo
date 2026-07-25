import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { encodeToken, payloadForToken } from "../src/core/token.ts";
import { defaultCamera } from "../tests/support/correspondences.ts";
import { type Degradations, makeDisplay, render } from "../tests/support/render.ts";

/**
 * Camera fixtures for the end-to-end suite.
 *
 * Chromium's `--use-file-for-fake-video-capture` accepts a raw Y4M stream and
 * loops it, which is the only way to put real QR content in front of a real
 * `getUserMedia` call. These files are produced by the same ray-casting renderer
 * the L2 sweep uses, so each one has an exact known pose -- the browser test can
 * therefore assert on the recovered geometry rather than merely on the flow
 * completing.
 *
 * Note the resolution: the fake device ignores the constraints the app asks for
 * and reports the file's own size instead. That is not a limitation to work
 * around, it is the behaviour worth testing, since real phones do the same
 * thing. One fixture is deliberately a different size from the rest so a
 * regression that hardcodes the requested resolution fails CI.
 */

const OUT = resolve(process.cwd(), "tests/e2e/fixtures");

/** Fixed entropy: the tests navigate to these exact tokens. */
/**
 * The full-bleed marker box is 88% of the display height, and the symbol is
 * 25/33 of that box because the four-module quiet zone is not part of the
 * symbol. Both factors have to be here, and getting the second one wrong is the
 * 32% trap.
 */
const EDGE_TO_SCREEN_HEIGHT = 0.88 * (25 / 33);

export const FIXTURE_TOKENS = {
	nominal: encodeToken({
		schemaVersion: 1,
		markerEdgeMm: 1440 * EDGE_TO_SCREEN_HEIGHT * 0.2646,
		aspectNum: 16,
		aspectDen: 9,
		surface: "monitor",
		edgeToScreenHeight: EDGE_TO_SCREEN_HEIGHT,
		rand: 0x5eed0001,
	}),
	far: encodeToken({
		schemaVersion: 1,
		markerEdgeMm: 1440 * EDGE_TO_SCREEN_HEIGHT * 0.2646,
		aspectNum: 16,
		aspectDen: 9,
		surface: "monitor",
		edgeToScreenHeight: EDGE_TO_SCREEN_HEIGHT,
		rand: 0x5eed0002,
	}),
};

interface Fixture {
	readonly name: string;
	readonly token: string;
	readonly width: number;
	readonly height: number;
	readonly view: { azimuthDeg: number; elevationDeg: number; distanceEdges: number };
	readonly frames: number;
	readonly degradations: Degradations;
	readonly blank?: boolean;
}

const FIXTURES: Fixture[] = [
	{
		name: "nominal",
		token: FIXTURE_TOKENS.nominal,
		width: 1280,
		height: 960,
		view: { azimuthDeg: 24, elevationDeg: 9, distanceEdges: 3.4 },
		frames: 10,
		degradations: { blurPx: 0.5, noiseLevels: 2, sharpen: 0.3 },
	},
	{
		// Deliberately a different resolution from the one above.
		name: "oblique",
		token: FIXTURE_TOKENS.nominal,
		width: 960,
		height: 720,
		view: { azimuthDeg: -38, elevationDeg: 12, distanceEdges: 3.0 },
		frames: 10,
		degradations: { blurPx: 0.5, noiseLevels: 2.5, sharpen: 0.35 },
	},
	{
		name: "too-far",
		token: FIXTURE_TOKENS.far,
		width: 1280,
		height: 960,
		view: { azimuthDeg: 6, elevationDeg: 4, distanceEdges: 26 },
		frames: 6,
		degradations: { blurPx: 0.6, noiseLevels: 3 },
	},
	{
		name: "no-code",
		token: FIXTURE_TOKENS.nominal,
		width: 1280,
		height: 960,
		view: { azimuthDeg: 0, elevationDeg: 0, distanceEdges: 5 },
		frames: 4,
		degradations: {},
		blank: true,
	},
];

function y4mHeader(width: number, height: number): Buffer {
	return Buffer.from(`YUV4MPEG2 W${width} H${height} F15:1 Ip A1:1 C420jpeg\n`, "ascii");
}

/** Greyscale into 4:2:0: the luma plane carries everything, chroma is neutral. */
function y4mFrame(gray: Uint8Array, width: number, height: number): Buffer {
	const cw = width >> 1;
	const ch = height >> 1;
	const frame = Buffer.alloc(6 + width * height + 2 * cw * ch);
	frame.write("FRAME\n", 0, "ascii");
	Buffer.from(gray.buffer, gray.byteOffset, gray.byteLength).copy(frame, 6);
	frame.fill(128, 6 + width * height);
	return frame;
}

function build(fixture: Fixture): { path: string; meta: Record<string, unknown> } {
	const camera = defaultCamera(fixture.width, fixture.height);
	const payload = payloadForToken("https://localhost", fixture.token);
	const display = makeDisplay(
		{ text: payload },
		{ mode: "fullbleed", widthCss: 2560, heightCss: 1440 },
	);

	const chunks: Buffer[] = [y4mHeader(fixture.width, fixture.height)];
	for (let i = 0; i < fixture.frames; i++) {
		if (fixture.blank) {
			// A flat grey field: decodable by nothing, which is the point.
			const gray = new Uint8Array(fixture.width * fixture.height).fill(96 + (i % 3));
			chunks.push(y4mFrame(gray, fixture.width, fixture.height));
			continue;
		}
		const frame = render({
			camera,
			view: fixture.view,
			display,
			supersample: 3,
			degradations: { ...fixture.degradations, seed: 1000 + i * 37 },
		});
		chunks.push(y4mFrame(frame.gray, fixture.width, fixture.height));
	}

	const path = resolve(OUT, `${fixture.name}.y4m`);
	writeFileSync(path, Buffer.concat(chunks));

	return {
		path,
		meta: {
			name: fixture.name,
			token: fixture.token,
			payload,
			width: fixture.width,
			height: fixture.height,
			frames: fixture.frames,
			truth: fixture.view,
			symbolEdgeCssPx: display.symbolEdgeCss,
			displayHeightCssPx: display.heightCss,
			moduleCount: display.modules.size,
			// What the app should recover, in the units it reports.
			expectedScreenHeights:
				(fixture.view.distanceEdges * display.symbolEdgeCss) / display.heightCss,
		},
	};
}

export function buildFixtures(quiet = false): Record<string, unknown>[] {
	mkdirSync(OUT, { recursive: true });
	const manifest = FIXTURES.map((f) => build(f).meta);
	writeFileSync(resolve(OUT, "manifest.json"), JSON.stringify(manifest, null, "\t"));
	if (!quiet) {
		for (const entry of manifest) {
			console.log(
				`${String(entry.name).padEnd(10)} ${entry.width}x${entry.height}  ` +
					`v${(Number(entry.moduleCount) - 17) / 4}  az ${(entry.truth as { azimuthDeg: number }).azimuthDeg}  ` +
					`${Number(entry.expectedScreenHeights).toFixed(2)} screen-heights`,
			);
		}
		console.log(`\nwrote ${manifest.length} fixtures to ${OUT}`);
	}
	return manifest;
}

export const FIXTURE_DIR = OUT;

// Running as a script rather than being imported by the Playwright setup.
if (process.argv[1]?.includes("make-fixtures")) buildFixtures();
