import type { RoomState, Viewer, WirePose } from "@core/api.ts";
import {
	buildExport,
	cartesian,
	displayGeometry,
	EXPORT_SCHEMA,
	isExportFormat,
	lookAtOriginQuaternion,
	serialiseExport,
	toCsv,
	toGltf,
} from "@core/export.ts";
import { describe, expect, it } from "vitest";

/**
 * The export is a boundary, and boundaries are where silent errors live.
 *
 * A consumer of this file cannot check its axis convention against anything --
 * a mirrored room looks exactly like a correct one. So the frame, the units and
 * the provenance of every estimated number are asserted here rather than left
 * to a comment, and the metric fields are asserted to be *absent* rather than
 * zero when nothing established a physical size.
 */

function viewer(overrides: Partial<Viewer> = {}): Viewer {
	const pose: WirePose = { az: -30, el: 5, dh: 2.4, sd: 0.12 };
	return {
		id: "v1",
		name: null,
		hue: 0,
		shape: 0,
		pose,
		tier: "solid",
		ambiguous: false,
		at: 1_700_000_000_000,
		...overrides,
	};
}

function room(overrides: Partial<RoomState> = {}): RoomState {
	return {
		token: "TESTTOKEN",
		spec: {
			schemaVersion: 1,
			markerEdgeMm: 112,
			aspectNum: 16,
			aspectDen: 9,
			surface: "monitor",
			edgeToScreenHeight: 1 / 3,
		},
		label: null,
		allowNames: false,
		persistent: false,
		redirect: null,
		createdAt: 1_699_999_000_000,
		layout: {
			id: "fullbleed",
			moduleCount: 25,
			symbolEdgeCssPx: 360,
			symbolEdgeMm: 112,
			viewportCssPx: { w: 1920, h: 1080 },
			symbolCentreCssPx: { x: 960, y: 540 },
			brackets: null,
			nonce: "ABC123",
		},
		layoutAt: 1_699_999_500_000,
		viewers: [viewer()],
		cursor: 0,
		phonesConnected: 1,
		displaysConnected: 1,
		...overrides,
	} as RoomState;
}

describe("the exported frame", () => {
	it("states its axes and units inside the file", () => {
		const data = buildExport({ room: room(), exportedAt: 1_700_000_100_000 });
		expect(data.schema).toBe(EXPORT_SCHEMA);
		expect(data.frame.handedness).toBe("right");
		expect(data.frame.up).toBe("+y");
		// The one sentence that stops a consumer producing a mirrored room.
		expect(data.frame.axes).toContain("+x to the viewer's right");
		expect(data.frame.units.primary).toContain("display heights");
	});

	it("agrees with the 3D scene's own spherical-to-Cartesian", () => {
		// Negative azimuth is to the viewer's left, which must be negative x.
		const [x, y, z] = cartesian(-30, 5, 2.4);
		expect(x).toBeLessThan(0);
		expect(y).toBeGreaterThan(0);
		expect(z).toBeGreaterThan(0);
		expect(Math.hypot(x, y, z)).toBeCloseTo(2.4, 10);
	});
});

describe("the display's physical size", () => {
	it("prefers a live layout and says so", () => {
		const geometry = displayGeometry(room());
		expect(geometry.source).toBe("layout-measured");
		// 1080 css px at 112/360 mm per px is 336 mm.
		expect(geometry.heightM).toBeCloseTo(0.336, 6);
		expect(geometry.aspect).toBeCloseTo(16 / 9, 6);
	});

	it("falls back to the token, with a much wider bar", () => {
		const geometry = displayGeometry(room({ layout: null }));
		expect(geometry.source).toBe("token-declared");
		// 112 mm at one third of the screen height is a 336 mm screen.
		expect(geometry.heightM).toBeCloseTo(0.336, 6);
		expect(geometry.sigmaRel!).toBeGreaterThan(0.1);
	});

	it("omits metres entirely when nothing established a size", () => {
		const bare = room({
			layout: null,
			spec: { ...room().spec, edgeToScreenHeight: 0 },
		});
		const data = buildExport({ room: bare, exportedAt: 1 });
		expect(data.display.heightSource).toBe("none");
		expect(data.display.heightM).toBeNull();
		// Null, not zero. A zero would average and sum as though it were measured.
		expect(data.positions[0]!.cartesian.metres).toBeNull();
		expect(data.positions[0]!.uncertainty.sigmaM).toBeNull();
	});
});

describe("positions", () => {
	it("carries the mirror branch when the flip was never resolved", () => {
		const data = buildExport({
			room: room({ viewers: [viewer({ ambiguous: true })] }),
			exportedAt: 1,
		});
		const p = data.positions[0]!;
		expect(p.ambiguous).toBe(true);
		// The flip mirrors through the vertical plane: azimuth negates, the rest holds.
		expect(p.mirrorBranch).toEqual({
			azimuthDeg: 30,
			elevationDeg: 5,
			distanceDisplayHeights: 2.4,
		});
	});

	it("drops viewers that never solved, rather than exporting a null pose", () => {
		const data = buildExport({
			room: room({ viewers: [viewer(), viewer({ id: "v2", pose: null })] }),
			exportedAt: 1,
		});
		expect(data.positions).toHaveLength(1);
		expect(data.summary.n).toBe(1);
	});

	it("summarises the cone and the spread", () => {
		const data = buildExport({
			room: room({
				viewers: [
					viewer({ id: "a", pose: { az: -10, el: 0, dh: 2, sd: 0.1 } }),
					viewer({ id: "b", pose: { az: 55, el: 0, dh: 4, sd: 0.1 } }),
				],
			}),
			exportedAt: 1,
		});
		expect(data.summary.azimuthSpreadDeg).toBe(65);
		// 55 degrees is outside the 40-degree viewing cone; -10 is inside.
		expect(data.summary.withinViewingConeFraction).toBe(0.5);
		expect(data.summary.medianDistanceDisplayHeights).toBe(3);
	});
});

describe("csv", () => {
	it("leaves metric cells empty rather than zero when there is no size", () => {
		const bare = room({ layout: null, spec: { ...room().spec, edgeToScreenHeight: 0 } });
		const csv = toCsv(buildExport({ room: bare, exportedAt: 1 }));
		const [header, row] = csv.trim().split("\n");
		const columns = header!.split(",");
		const cells = row!.split(",");
		expect(cells[columns.indexOf("distance_m")]).toBe("");
		expect(cells[columns.indexOf("x_m")]).toBe("");
		expect(cells[columns.indexOf("distance_display_heights")]).toBe("2.4000");
	});

	it("quotes a label containing a comma so the columns cannot shift", () => {
		const data = buildExport({
			room: room({ viewers: [viewer({ name: 'Sam, "the back row"' })] }),
			exportedAt: 1,
		});
		// Names are free text and reach this file verbatim.
		const csv = toCsv({
			...data,
			positions: [{ ...data.positions[0]!, id: 'Sam, "the back row"' }],
		});
		expect(csv).toContain('"Sam, ""the back row"""');
		expect(csv.trim().split("\n")).toHaveLength(2);
	});
});

describe("gltf", () => {
	it("points every camera at the display", () => {
		const data = buildExport({ room: room(), exportedAt: 1 });
		const gltf = toGltf(data) as {
			nodes: { name: string; translation?: number[]; rotation?: number[] }[];
			buffers: { uri: string }[];
			accessors: unknown[];
		};
		const camera = gltf.nodes.find((n) => n.name.startsWith("scan_"))!;
		expect(camera.translation).toHaveLength(3);

		// A glTF camera looks down its own -Z, so rotating -Z by the node's
		// quaternion must produce a vector pointing back at the origin.
		const forward = rotate([0, 0, -1], camera.rotation as [number, number, number, number]);
		const position = camera.translation as [number, number, number];
		const toOrigin = position.map((v) => -v / Math.hypot(...position));
		for (let i = 0; i < 3; i++) expect(forward[i]).toBeCloseTo(toOrigin[i]!, 6);
	});

	it("stays a single file, with the display quad embedded", () => {
		const gltf = toGltf(buildExport({ room: room(), exportedAt: 1 })) as {
			buffers: { uri: string; byteLength: number }[];
		};
		expect(gltf.buffers[0]!.uri.startsWith("data:application/octet-stream;base64,")).toBe(true);
		// Four vec3 positions plus six uint16 indices.
		expect(gltf.buffers[0]!.byteLength).toBe(60);
	});

	it("keeps the basis well-formed for a camera directly overhead", () => {
		// The degenerate case for a +Y world up: without a fallback reference the
		// cross product collapses and the file becomes unopenable.
		const q = lookAtOriginQuaternion(0, 3, 0);
		expect(q.every(Number.isFinite)).toBe(true);
		expect(Math.hypot(...q)).toBeCloseTo(1, 6);
		const forward = rotate([0, 0, -1], q);
		expect(forward[1]).toBeCloseTo(-1, 6);
	});
});

describe("serialisation", () => {
	it("names the file and the type per format", () => {
		const data = buildExport({ room: room(), exportedAt: 1 });
		expect(serialiseExport(data, "json").filename).toBe("spatial-qr-TESTTOKEN.json");
		expect(serialiseExport(data, "csv").contentType).toContain("text/csv");
		expect(serialiseExport(data, "gltf").contentType).toBe("model/gltf+json");
		expect(JSON.parse(serialiseExport(data, "gltf").body).asset.version).toBe("2.0");
	});

	it("rejects a format it does not produce", () => {
		expect(isExportFormat("json")).toBe(true);
		expect(isExportFormat("obj")).toBe(false);
		expect(isExportFormat(undefined)).toBe(false);
	});
});

/** Rotate a vector by a glTF quaternion, [x, y, z, w]. */
function rotate(
	v: readonly [number, number, number],
	q: readonly [number, number, number, number],
): [number, number, number] {
	const [x, y, z, w] = q;
	const [vx, vy, vz] = v;
	const ux = y * vz - z * vy + w * vx;
	const uy = z * vx - x * vz + w * vy;
	const uz = x * vy - y * vx + w * vz;
	return [vx + 2 * (y * uz - z * uy), vy + 2 * (z * ux - x * uz), vz + 2 * (x * uy - y * ux)];
}
