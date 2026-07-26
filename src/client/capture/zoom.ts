/**
 * Camera zoom, and why it is worth the trouble.
 *
 * The usable range of this whole system is `f / (moduleCount * pxPerModuleGate)`
 * -- see `estimateRange`. Range is *linear* in focal length, so three times the
 * focal length is three times the distance you can scan from. Nothing else in
 * the product moves that number by anything like as much.
 *
 * The catch is that the solver does not measure focal length from nothing: it
 * runs a MAP estimate against a log-normal prior centred on a 26mm-equivalent
 * lens, and the posterior width scales the recovered position *radially*. Zoom
 * to 3x while the prior still insists on 26mm and the prior fights the
 * photograph, dragging the reported distance toward the wrong answer with a
 * perfectly healthy-looking residual. So the prior has to move with the zoom.
 * That is not a refinement of this feature, it is the feature; the control is
 * the easy half.
 *
 * Two mechanisms, because the platforms genuinely differ:
 *
 *   - Chromium exposes a `zoom` constraint on the track. The reported value is
 *     an exact multiplier on the logical camera's reference focal length,
 *     whether the driver achieves it by moving to a telephoto module or by
 *     cropping, so scaling the prior by it is correct either way.
 *
 *   - Safari exposes no zoom constraint at all. What it does expose, once
 *     permission is granted, is the physical lenses as separate devices --
 *     "Back Telephoto Camera" alongside "Back Camera". Selecting one is
 *     unambiguously optical, which is the better outcome, but the factor has to
 *     be inferred from a label rather than read from the driver. So that path
 *     widens the prior instead of pretending to a precision it does not have.
 */

export interface Lens {
	readonly deviceId: string;
	readonly label: string;
	/** Focal length relative to the device's main camera. */
	readonly factor: number;
}

export type ZoomMode =
	| { readonly kind: "none" }
	| { readonly kind: "constraint"; readonly min: number; readonly max: number }
	| { readonly kind: "lens"; readonly lenses: readonly Lens[] };

export interface ZoomState {
	/** The factor to show the user. */
	readonly factor: number;
	/** What to multiply the focal-length prior's centre by. */
	readonly focalScale: number;
	/** The prior's 1-sigma width in log space, widened when the factor is a guess. */
	readonly focalSigmaLog: number;
	/** True when the factor came from the driver rather than from a lens label. */
	readonly measured: boolean;
}

/**
 * The prior's width at 1x, unchanged from the value the solver has always used.
 * Phone main cameras cluster tightly around 26mm-equivalent, and this is the
 * spread of that cluster.
 */
export const BASE_FOCAL_SIGMA_LOG = 0.15;

/**
 * Widened slightly for driver-reported zoom.
 *
 * The multiplier itself is exact, but on a logical camera that has switched to
 * a different physical module the *reference* focal it multiplies is no longer
 * quite the 26mm the base prior assumes.
 */
const CONSTRAINT_FOCAL_SIGMA_LOG = 0.18;

/**
 * And widened a lot for a lens picked by name.
 *
 * Apple has shipped 2x, 2.5x, 3x and 5x telephotos under labels that do not
 * distinguish them, so the centre of this prior is a guess spanning a factor of
 * two and a half. A wide prior is the honest response and it is also a safe
 * one: the posterior is capped at the prior's width, so a photograph that
 * constrains focal well will narrow it anyway, and one that does not will
 * report a correspondingly wider error bar rather than a confident wrong
 * number.
 */
const LENS_FOCAL_SIGMA_LOG = 0.3;

export const NO_ZOOM: ZoomState = {
	factor: 1,
	focalScale: 1,
	focalSigmaLog: BASE_FOCAL_SIGMA_LOG,
	measured: true,
};

interface ZoomCapability {
	readonly min?: number;
	readonly max?: number;
	readonly step?: number;
}

/** What this camera will actually let us do, asked rather than assumed. */
export async function detectZoom(track: MediaStreamTrack): Promise<ZoomMode> {
	// `zoom` is a registered media-capture extension rather than part of the
	// base MediaTrackCapabilities the DOM lib types describe, so it has to be
	// reached for explicitly. Its absence is the common case, not an error.
	const capabilities = safeCapabilities(track) as
		| (MediaTrackCapabilities & { zoom?: ZoomCapability })
		| null;
	const zoom = capabilities?.zoom;
	if (zoom && typeof zoom.max === "number" && zoom.max > 1) {
		return { kind: "constraint", min: typeof zoom.min === "number" ? zoom.min : 1, max: zoom.max };
	}

	const lenses = await backLenses();
	// One lens is not a choice, it is the camera we already have.
	if (lenses.length > 1) return { kind: "lens", lenses };
	return { kind: "none" };
}

function safeCapabilities(track: MediaStreamTrack): MediaTrackCapabilities | null {
	try {
		// Firefox has no getCapabilities at all; older WebKit throws on it.
		return typeof track.getCapabilities === "function" ? track.getCapabilities() : null;
	} catch {
		return null;
	}
}

/**
 * The rear-facing physical cameras, as separate selectable devices.
 *
 * Labels are empty until a camera permission has been granted, which is why
 * this is never called before the stream exists.
 */
export async function backLenses(): Promise<readonly Lens[]> {
	if (!navigator.mediaDevices?.enumerateDevices) return [];
	let devices: MediaDeviceInfo[];
	try {
		devices = await navigator.mediaDevices.enumerateDevices();
	} catch {
		return [];
	}

	const seen = new Set<number>();
	const lenses: Lens[] = [];
	for (const device of devices) {
		if (device.kind !== "videoinput" || !device.label) continue;
		if (!/back|rear|environment/i.test(device.label)) continue;
		const factor = lensFactor(device.label);
		if (factor === null || seen.has(factor)) continue;
		seen.add(factor);
		lenses.push({ deviceId: device.deviceId, label: device.label, factor });
	}
	return lenses.sort((a, b) => a.factor - b.factor);
}

/**
 * The zoom factor a lens label implies, or null for the composite devices.
 *
 * "Back Dual Wide Camera" and "Back Triple Camera" are virtual devices that
 * switch modules on their own, so picking one buys nothing over the plain back
 * camera and its effective focal length is unknowable in advance. They are
 * skipped rather than offered.
 */
export function lensFactor(label: string): number | null {
	if (/dual|triple|virtual/i.test(label)) return null;
	if (/ultra.?wide/i.test(label)) return 0.5;
	// The midpoint of the 2x-3x range Apple ships under this one word. See
	// LENS_FOCAL_SIGMA_LOG for what is done about the remaining doubt.
	if (/telephoto|tele\b/i.test(label)) return 2.5;
	if (/wide|back camera|rear camera/i.test(label)) return 1;
	return null;
}

/** The factors worth offering as buttons, given what the camera supports. */
export function zoomSteps(mode: ZoomMode): readonly number[] {
	if (mode.kind === "none") return [];
	if (mode.kind === "lens") return mode.lenses.map((l) => l.factor);
	// Whole stops the user recognises from their own camera app, capped by what
	// the driver will actually do.
	const candidates = [1, 2, 3, 5, 10];
	const steps = candidates.filter((s) => s <= mode.max);
	// A camera whose maximum falls between stops still deserves its maximum.
	if (mode.max > (steps[steps.length - 1] ?? 0) * 1.4) steps.push(Math.round(mode.max));
	return steps;
}

/**
 * Ask the driver for a zoom factor and report what it actually did.
 *
 * The returned state carries the *applied* value read back from settings, not
 * the requested one -- drivers clamp, quantise and occasionally ignore, and the
 * focal prior has to follow the camera rather than the intention.
 */
export async function applyZoom(track: MediaStreamTrack, factor: number): Promise<ZoomState> {
	try {
		await track.applyConstraints({ advanced: [{ zoom: factor } as MediaTrackConstraintSet] });
	} catch {
		// Rejected outright; fall through and read back whatever is in force.
	}
	const applied = readAppliedZoom(track) ?? factor;
	return {
		factor: applied,
		focalScale: applied,
		focalSigmaLog: applied === 1 ? BASE_FOCAL_SIGMA_LOG : CONSTRAINT_FOCAL_SIGMA_LOG,
		measured: true,
	};
}

function readAppliedZoom(track: MediaStreamTrack): number | null {
	try {
		const zoom = (track.getSettings() as MediaTrackSettings & { zoom?: number }).zoom;
		return typeof zoom === "number" && zoom > 0 ? zoom : null;
	} catch {
		return null;
	}
}

/** The state implied by having selected a named lens. */
export function lensZoomState(lens: Lens): ZoomState {
	return {
		factor: lens.factor,
		focalScale: lens.factor,
		focalSigmaLog: lens.factor === 1 ? BASE_FOCAL_SIGMA_LOG : LENS_FOCAL_SIGMA_LOG,
		measured: false,
	};
}

/**
 * Swap to a different physical camera without ever being cameraless.
 *
 * The new stream is acquired *before* the old one is stopped. On iOS a camera
 * grant cannot be re-requested within a page load if it is lost, so releasing
 * first and failing second would end the visitor's session at the one moment
 * they were trying to improve it. Returns null on failure, leaving the caller's
 * existing stream untouched and still running.
 */
export async function openLens(deviceId: string): Promise<MediaStream | null> {
	try {
		return await navigator.mediaDevices.getUserMedia({
			audio: false,
			video: {
				deviceId: { exact: deviceId },
				width: { ideal: 3840 },
				height: { ideal: 2160 },
				frameRate: { ideal: 30 },
			},
		});
	} catch {
		return null;
	}
}

/**
 * How far the range moves for a given zoom.
 *
 * Stated in the aiming UI because "3x" on its own is a camera-app gesture,
 * whereas "good to 6 m" is the reason to reach for it.
 */
export function scaledRangeM(baseRangeM: number, zoom: ZoomState): number {
	return baseRangeM * zoom.focalScale;
}
