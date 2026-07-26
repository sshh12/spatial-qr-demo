import type { RoomState, Viewer } from "./api.ts";
import { VIEWING_CONE_DEG } from "./legibility.ts";

/**
 * The export, and the one rule that shapes it.
 *
 * The file has to be interpretable by a tool that has never heard of this app.
 * That means the coordinate frame, the units and the provenance of every
 * estimated quantity travel *inside* the file rather than in a README nobody
 * will have open -- because the failure mode otherwise is silent. Somebody
 * reads a column called `x`, assumes the axis convention their own tool uses,
 * and gets a mirrored room with no error to tell them so. The flip is already
 * the hardest failure in this system to see; it must not be re-introduced at
 * the file boundary.
 *
 * The same reasoning puts display heights first and metres second everywhere
 * here, exactly as the UI does. Display heights are a ratio of two lengths in
 * the same units and carry no guess at all. Metres inherit the display's
 * physical size, so they never appear without `heightSource` and a sigma
 * sitting beside them.
 */

export const EXPORT_SCHEMA = "spatial-qr/scan-export@1";
export type ExportFormat = "json" | "csv" | "gltf";

export interface ExportedPosition {
	/** Stable within this room and this room only. Never a person. */
	readonly id: string;
	readonly name: string | null;
	readonly at: string;
	readonly spherical: {
		readonly azimuthDeg: number;
		readonly elevationDeg: number;
		readonly distanceDisplayHeights: number;
	};
	readonly cartesian: {
		readonly displayHeights: readonly [number, number, number];
		readonly metres: readonly [number, number, number] | null;
	};
	readonly uncertainty: {
		readonly sigmaDisplayHeights: number;
		readonly sigmaM: number | null;
		readonly tier: string;
	};
	readonly withinViewingCone: boolean;
	readonly ambiguous: boolean;
	/**
	 * The other candidate position, when the mirror flip was never resolved.
	 *
	 * Present rather than dropped: a consumer that averages an unresolved pair
	 * gets a point in the middle of the room where nobody stood, and a consumer
	 * that knows about the ambiguity can do something better. Hiding it would
	 * make the file look more certain than the measurement was.
	 */
	readonly mirrorBranch: {
		readonly azimuthDeg: number;
		readonly elevationDeg: number;
		readonly distanceDisplayHeights: number;
	} | null;
}

export interface ScanExport {
	readonly schema: typeof EXPORT_SCHEMA;
	readonly generator: string;
	readonly exportedAt: string;
	readonly room: {
		readonly token: string;
		readonly label: string | null;
		readonly surface: string;
		readonly createdAt: string;
	};
	readonly frame: {
		readonly handedness: "right";
		readonly up: "+y";
		readonly origin: string;
		readonly axes: string;
		readonly units: { readonly primary: string; readonly derived: string };
	};
	readonly display: {
		readonly heightM: number | null;
		readonly aspect: number;
		readonly heightSource: DisplaySizeSource;
		readonly heightSigmaRel: number | null;
	};
	readonly marker: {
		readonly symbolEdgeMm: number;
		readonly moduleCount: number | null;
		readonly edgeToScreenHeight: number;
	};
	readonly positions: readonly ExportedPosition[];
	readonly summary: {
		readonly n: number;
		readonly medianDistanceDisplayHeights: number | null;
		readonly azimuthSpreadDeg: number | null;
		readonly withinViewingConeFraction: number | null;
		readonly viewingConeDeg: number;
	};
}

/**
 * Where the display's physical height came from, which decides whether metres
 * mean anything at all.
 *
 * `layout-measured` is a live display reporting what it is actually showing,
 * scaled by a card-ruler calibration somebody performed. `token-declared` is
 * the size baked into the QR payload at creation. `none` means no physical size
 * was ever established, and every metric field in the file is null rather than
 * invented.
 */
export type DisplaySizeSource = "layout-measured" | "token-declared" | "none";

/** The 1-sigma relative error carried by a declared display size. */
const DECLARED_SIZE_SIGMA_REL = 0.12;

export interface BuildExportOptions {
	readonly room: RoomState;
	readonly exportedAt: number;
	readonly generator?: string;
}

export function buildExport({
	room,
	exportedAt,
	generator = "spatial-qr",
}: BuildExportOptions): ScanExport {
	const display = displayGeometry(room);
	const positions = room.viewers
		.filter((v): v is Viewer & { pose: NonNullable<Viewer["pose"]> } => v.pose !== null)
		.sort((a, b) => a.at - b.at)
		.map((v) => exportPosition(v, display.heightM));

	return {
		schema: EXPORT_SCHEMA,
		generator,
		exportedAt: new Date(exportedAt).toISOString(),
		room: {
			token: room.token,
			label: room.label,
			surface: room.spec.surface,
			createdAt: new Date(room.createdAt).toISOString(),
		},
		frame: {
			handedness: "right",
			up: "+y",
			origin: "the centre of the display panel",
			axes:
				"+x to the viewer's right as they face the screen, +y up, " +
				"+z out of the screen into the room",
			units: {
				primary: "display heights (dimensionless, exact)",
				derived: "metres (inherits the display's physical size; see display.heightSigmaRel)",
			},
		},
		display: {
			heightM: display.heightM,
			aspect: display.aspect,
			heightSource: display.source,
			heightSigmaRel: display.sigmaRel,
		},
		marker: {
			symbolEdgeMm: room.layout?.symbolEdgeMm ?? room.spec.markerEdgeMm,
			moduleCount: room.layout?.moduleCount ?? null,
			edgeToScreenHeight: room.spec.edgeToScreenHeight,
		},
		positions,
		summary: summarise(positions),
	};
}

export interface DisplayGeometry {
	readonly heightM: number | null;
	readonly aspect: number;
	readonly source: DisplaySizeSource;
	readonly sigmaRel: number | null;
}

/**
 * The display's physical size, preferring what a live display measured over
 * what a token declared, and admitting to neither when there is nothing.
 *
 * Exported because the 3D view needs precisely the same answer the file does.
 * Two implementations of "how tall is this screen" is how a scene drawn at one
 * scale and a file written at another quietly stop describing the same room.
 */
export function displayGeometry(room: RoomState): DisplayGeometry {
	const layout = room.layout;
	if (layout && layout.symbolEdgeCssPx > 0 && layout.viewportCssPx.h > 0) {
		const mmPerCssPx = layout.symbolEdgeMm / layout.symbolEdgeCssPx;
		return {
			heightM: (layout.viewportCssPx.h * mmPerCssPx) / 1000,
			aspect: layout.viewportCssPx.w / layout.viewportCssPx.h,
			source: "layout-measured",
			// The card ruler resolves a credit card's 85.60mm edge against a screen
			// measurement; a percent or so, and it is the dominant term.
			sigmaRel: 0.012,
		};
	}

	const aspect = (room.spec.aspectNum || 16) / (room.spec.aspectDen || 9);
	if (room.spec.edgeToScreenHeight > 0 && room.spec.markerEdgeMm > 0) {
		return {
			heightM: room.spec.markerEdgeMm / room.spec.edgeToScreenHeight / 1000,
			aspect,
			source: "token-declared",
			sigmaRel: DECLARED_SIZE_SIGMA_REL,
		};
	}
	return { heightM: null, aspect, source: "none", sigmaRel: null };
}

function exportPosition(
	viewer: Viewer & { pose: NonNullable<Viewer["pose"]> },
	heightM: number | null,
): ExportedPosition {
	const { az, el, dh, sd } = viewer.pose;
	const [x, y, z] = cartesian(az, el, dh);
	return {
		id: viewer.id,
		name: viewer.name,
		at: new Date(viewer.at).toISOString(),
		spherical: { azimuthDeg: az, elevationDeg: el, distanceDisplayHeights: dh },
		cartesian: {
			displayHeights: [x, y, z],
			metres: heightM === null ? null : [x * heightM, y * heightM, z * heightM],
		},
		uncertainty: {
			sigmaDisplayHeights: sd,
			sigmaM: heightM === null ? null : sd * heightM,
			tier: viewer.tier,
		},
		withinViewingCone: Math.abs(az) <= VIEWING_CONE_DEG,
		ambiguous: viewer.ambiguous,
		// The flip mirrors through the display's vertical plane, so it negates the
		// azimuth and leaves distance and elevation alone.
		mirrorBranch: viewer.ambiguous
			? { azimuthDeg: -az, elevationDeg: el, distanceDisplayHeights: dh }
			: null,
	};
}

/** Spherical to Cartesian, matching the 3D scene exactly. */
export function cartesian(az: number, el: number, dh: number): [number, number, number] {
	const a = (az * Math.PI) / 180;
	const e = (el * Math.PI) / 180;
	return [dh * Math.cos(e) * Math.sin(a), dh * Math.sin(e), dh * Math.cos(e) * Math.cos(a)];
}

function summarise(positions: readonly ExportedPosition[]): ScanExport["summary"] {
	if (positions.length === 0) {
		return {
			n: 0,
			medianDistanceDisplayHeights: null,
			azimuthSpreadDeg: null,
			withinViewingConeFraction: null,
			viewingConeDeg: VIEWING_CONE_DEG,
		};
	}
	const distances = positions.map((p) => p.spherical.distanceDisplayHeights).sort((a, b) => a - b);
	const azimuths = positions.map((p) => p.spherical.azimuthDeg);
	const inside = positions.filter((p) => p.withinViewingCone).length;
	return {
		n: positions.length,
		medianDistanceDisplayHeights: median(distances),
		azimuthSpreadDeg: Math.max(...azimuths) - Math.min(...azimuths),
		withinViewingConeFraction: inside / positions.length,
		viewingConeDeg: VIEWING_CONE_DEG,
	};
}

function median(sorted: readonly number[]): number {
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[mid]!;
	return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/* -------------------------------------------------------------------------- */
/* CSV                                                                        */
/* -------------------------------------------------------------------------- */

const CSV_COLUMNS = [
	"id",
	"at",
	"azimuth_deg",
	"elevation_deg",
	"distance_display_heights",
	"sigma_display_heights",
	"x_display_heights",
	"y_display_heights",
	"z_display_heights",
	"distance_m",
	"x_m",
	"y_m",
	"z_m",
	"sigma_m",
	"tier",
	"within_viewing_cone",
	"ambiguous",
] as const;

/**
 * The same rows, for the half of "drop it into another tool" that means a
 * spreadsheet. Metric columns are empty rather than zero when no physical size
 * was ever established -- a zero would sum and average as though it were a
 * measurement.
 */
export function toCsv(data: ScanExport): string {
	const lines = [CSV_COLUMNS.join(",")];
	for (const p of data.positions) {
		const m = p.cartesian.metres;
		const heightM = data.display.heightM;
		lines.push(
			[
				csvCell(p.id),
				csvCell(p.at),
				num(p.spherical.azimuthDeg),
				num(p.spherical.elevationDeg),
				num(p.spherical.distanceDisplayHeights),
				num(p.uncertainty.sigmaDisplayHeights),
				num(p.cartesian.displayHeights[0]),
				num(p.cartesian.displayHeights[1]),
				num(p.cartesian.displayHeights[2]),
				heightM === null ? "" : num(p.spherical.distanceDisplayHeights * heightM),
				m === null ? "" : num(m[0]),
				m === null ? "" : num(m[1]),
				m === null ? "" : num(m[2]),
				p.uncertainty.sigmaM === null ? "" : num(p.uncertainty.sigmaM),
				csvCell(p.uncertainty.tier),
				p.withinViewingCone ? "true" : "false",
				p.ambiguous ? "true" : "false",
			].join(","),
		);
	}
	return `${lines.join("\n")}\n`;
}

function num(value: number): string {
	return Number.isFinite(value) ? value.toFixed(4) : "";
}

function csvCell(value: string | null): string {
	if (value === null) return "";
	// A room label is free text and can contain anything, including the comma
	// and quote that would otherwise shift every column after it.
	return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/* -------------------------------------------------------------------------- */
/* glTF                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The assumed field of view for exported cameras, as a 35mm equivalent.
 *
 * The wire pose is four numbers and is deliberately not allowed to grow a
 * fifth, so the solved focal length of each capture never reaches the room
 * state and cannot reach this file. The exported cameras therefore carry a
 * stated default rather than a measured intrinsic -- their *positions* are the
 * measurement, and the frustum is there so you can see which way they faced.
 */
const ASSUMED_EQUIV_MM = 26;
const FRAME_HEIGHT_MM = 24;
const FRAME_WIDTH_MM = 36;

/**
 * Every scan as a real camera in a glTF scene, with the display as a quad.
 *
 * This is the most literal reading of "drop it into another tool": open the
 * file in Blender and each measured position is a camera you can look through,
 * pointed at a rectangle the size of the actual screen. Nothing here needs a
 * runtime -- glTF's JSON flavour embeds its one small buffer as a data URI, so
 * the export stays a single file with no companion .bin to lose.
 */
export function toGltf(data: ScanExport): unknown {
	// Fall back to a metre-tall display when no physical size was established,
	// so the scene is still navigable, and say so in the asset's copyright.
	const heightM = data.display.heightM ?? 1;
	const widthM = heightM * data.display.aspect;
	const buffer = displayQuadBuffer(widthM, heightM);

	const yfov = 2 * Math.atan(FRAME_HEIGHT_MM / 2 / ASSUMED_EQUIV_MM);
	const nodes: unknown[] = [{ name: "display", mesh: 0 }];
	const cameras: unknown[] = [
		{
			name: `assumed-${ASSUMED_EQUIV_MM}mm-equivalent`,
			type: "perspective",
			perspective: {
				yfov,
				aspectRatio: FRAME_WIDTH_MM / FRAME_HEIGHT_MM,
				znear: 0.01,
				zfar: 100,
			},
		},
	];

	for (const p of data.positions) {
		const [x, y, z] = p.cartesian.metres ?? p.cartesian.displayHeights;
		nodes.push({
			name: `scan_${p.id}`,
			camera: 0,
			translation: [x, y, z],
			rotation: lookAtOriginQuaternion(x, y, z),
			extras: {
				at: p.at,
				azimuthDeg: p.spherical.azimuthDeg,
				elevationDeg: p.spherical.elevationDeg,
				distanceDisplayHeights: p.spherical.distanceDisplayHeights,
				sigmaDisplayHeights: p.uncertainty.sigmaDisplayHeights,
				tier: p.uncertainty.tier,
				ambiguous: p.ambiguous,
			},
		});
	}

	return {
		asset: {
			version: "2.0",
			generator: `${data.generator} (${data.schema})`,
			copyright:
				data.display.heightSource === "none"
					? "No physical display size was established; this scene is scaled in display heights, not metres."
					: `Display height ${heightM.toFixed(3)} m, source: ${data.display.heightSource}.`,
		},
		scene: 0,
		scenes: [{ name: data.room.label ?? data.room.token, nodes: nodes.map((_, i) => i) }],
		nodes,
		cameras,
		meshes: [
			{
				name: "display",
				primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }],
			},
		],
		accessors: [
			{
				bufferView: 0,
				componentType: 5126, // FLOAT
				count: 4,
				type: "VEC3",
				min: [-widthM / 2, -heightM / 2, 0],
				max: [widthM / 2, heightM / 2, 0],
			},
			{
				bufferView: 1,
				componentType: 5123, // UNSIGNED_SHORT
				count: 6,
				type: "SCALAR",
			},
		],
		bufferViews: [
			{ buffer: 0, byteOffset: 0, byteLength: 48, target: 34962 },
			{ buffer: 0, byteOffset: 48, byteLength: 12, target: 34963 },
		],
		buffers: [
			{
				byteLength: buffer.byteLength,
				uri: `data:application/octet-stream;base64,${base64(buffer)}`,
			},
		],
	};
}

/** Four corners and two triangles, in the XY plane, facing the room. */
function displayQuadBuffer(widthM: number, heightM: number): Uint8Array {
	const bytes = new Uint8Array(60);
	const view = new DataView(bytes.buffer);
	const hw = widthM / 2;
	const hh = heightM / 2;
	const corners = [
		[-hw, -hh, 0],
		[hw, -hh, 0],
		[hw, hh, 0],
		[-hw, hh, 0],
	];
	corners.forEach((c, i) => {
		view.setFloat32(i * 12 + 0, c[0]!, true);
		view.setFloat32(i * 12 + 4, c[1]!, true);
		view.setFloat32(i * 12 + 8, c[2]!, true);
	});
	[0, 1, 2, 0, 2, 3].forEach((index, i) => {
		view.setUint16(48 + i * 2, index, true);
	});
	return bytes;
}

/**
 * The rotation that points a glTF camera at the display.
 *
 * glTF cameras look down their own -Z with +Y up, so local +Z has to point
 * *away* from the origin -- straight back along the position vector. The
 * remaining two axes come from a world up of +Y, which is degenerate only for a
 * camera directly above or below the display's centre; that case falls back to
 * +Z as the reference so the basis stays well-formed rather than collapsing to
 * NaN and writing an unopenable file.
 */
export function lookAtOriginQuaternion(
	x: number,
	y: number,
	z: number,
): [number, number, number, number] {
	const length = Math.hypot(x, y, z);
	if (length === 0) return [0, 0, 0, 1];
	const fz: [number, number, number] = [x / length, y / length, z / length];
	const reference: [number, number, number] = Math.abs(fz[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0];

	const fx = normalise(cross(reference, fz));
	const fy = cross(fz, fx);

	// Shepperd's method: pick the largest diagonal term so the divisor is never
	// close to zero. The naive w-first form loses all precision at 180 degrees,
	// which here is a camera standing behind the screen -- rare, but reachable.
	const [m00, m10, m20] = fx;
	const [m01, m11, m21] = fy;
	const [m02, m12, m22] = fz;
	const trace = m00 + m11 + m22;

	if (trace > 0) {
		const s = Math.sqrt(trace + 1) * 2;
		return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
	}
	if (m00 > m11 && m00 > m22) {
		const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
		return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
	}
	if (m11 > m22) {
		const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
		return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
	}
	const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
	return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
}

function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
	return [
		a[1]! * b[2]! - a[2]! * b[1]!,
		a[2]! * b[0]! - a[0]! * b[2]!,
		a[0]! * b[1]! - a[1]! * b[0]!,
	];
}

function normalise(v: [number, number, number]): [number, number, number] {
	const length = Math.hypot(v[0], v[1], v[2]) || 1;
	return [v[0] / length, v[1] / length, v[2] / length];
}

/** Base64 without Buffer, so this stays usable from the browser as well. */
function base64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** Filename, content type and body for a chosen format. */
export function serialiseExport(
	data: ScanExport,
	format: ExportFormat,
): { readonly body: string; readonly contentType: string; readonly filename: string } {
	const stem = `spatial-qr-${data.room.token}`;
	if (format === "csv") {
		return { body: toCsv(data), contentType: "text/csv; charset=utf-8", filename: `${stem}.csv` };
	}
	if (format === "gltf") {
		return {
			body: JSON.stringify(toGltf(data), null, 2),
			contentType: "model/gltf+json",
			filename: `${stem}.gltf`,
		};
	}
	return {
		body: JSON.stringify(data, null, 2),
		contentType: "application/json; charset=utf-8",
		filename: `${stem}.json`,
	};
}

export function isExportFormat(value: string | undefined): value is ExportFormat {
	return value === "json" || value === "csv" || value === "gltf";
}
