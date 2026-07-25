export type PermissionOutcome =
	| { kind: "granted"; stream: MediaStream }
	| { kind: "denied"; recoverable: boolean }
	| { kind: "blocked-by-app" }
	| { kind: "no-camera" }
	| { kind: "insecure" }
	| { kind: "failed"; message: string };

/**
 * Constraints, and the two rules that matter.
 *
 * Never `exact`: Safari throws rather than degrading, and Chromium's fake
 * file-backed camera -- which the whole end-to-end suite runs on -- ignores
 * resolution constraints entirely and reports the file's native size. Both cases
 * are fine under `ideal` and fatal under `exact`.
 *
 * And nothing is assumed about what came back. The focal length in pixels is
 * derived from `track.getSettings()`, because the resolution we asked for and
 * the resolution we got are routinely different numbers.
 */
export function videoConstraints(): MediaStreamConstraints {
	return {
		audio: false,
		video: {
			facingMode: { ideal: "environment" },
			width: { ideal: 3840 },
			height: { ideal: 2160 },
			frameRate: { ideal: 30 },
		},
	};
}

export interface CameraInfo {
	readonly width: number;
	readonly height: number;
	readonly frameRate: number;
	readonly deviceId: string | null;
	readonly label: string;
}

export function readCameraInfo(track: MediaStreamTrack): CameraInfo {
	const settings = track.getSettings();
	return {
		width: settings.width ?? 0,
		height: settings.height ?? 0,
		frameRate: settings.frameRate ?? 0,
		deviceId: settings.deviceId ?? null,
		label: track.label || "camera",
	};
}

/**
 * Asks for the camera.
 *
 * Must be called synchronously from a user gesture with nothing else in the
 * handler. On iOS the permission is one-shot: "Allow Once" is revoked on
 * navigation and there is no API to re-prompt, so the entire flow after this
 * point lives in a single page load.
 */
export async function requestCamera(): Promise<PermissionOutcome> {
	if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
		return { kind: "insecure" };
	}
	if (!window.isSecureContext) return { kind: "insecure" };

	const startedAt = performance.now();
	try {
		const stream = await navigator.mediaDevices.getUserMedia(videoConstraints());
		return { kind: "granted", stream };
	} catch (err) {
		const elapsed = performance.now() - startedAt;
		const name = err instanceof Error ? err.name : "";

		// A rejection this fast never showed a prompt, which means an embedding app
		// refused on the user's behalf. Telling that person to check their Settings
		// is useless advice, so it is a separate state with separate copy.
		if ((name === "NotAllowedError" || name === "SecurityError") && elapsed < 200) {
			return { kind: "blocked-by-app" };
		}
		if (name === "NotAllowedError" || name === "PermissionDeniedError") {
			return { kind: "denied", recoverable: true };
		}
		if (
			name === "NotFoundError" ||
			name === "DevicesNotFoundError" ||
			name === "OverconstrainedError"
		) {
			return { kind: "no-camera" };
		}
		return { kind: "failed", message: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Stops every track and makes sure the OS camera indicator actually goes out.
 *
 * This is the moment the cold-open screen promised, so it happens before the
 * WebGL scene mounts rather than whenever the page happens to unload.
 */
export function releaseCamera(stream: MediaStream | null): void {
	if (!stream) return;
	for (const track of stream.getTracks()) {
		try {
			track.stop();
		} catch {
			// Already ended.
		}
		stream.removeTrack(track);
	}
}

/** Grabs the current video frame at its native resolution. */
export function grabFrame(
	video: HTMLVideoElement,
	canvas: HTMLCanvasElement,
): { data: Uint8ClampedArray; width: number; height: number } | null {
	const width = video.videoWidth;
	const height = video.videoHeight;
	if (width === 0 || height === 0) return null;
	if (canvas.width !== width || canvas.height !== height) {
		canvas.width = width;
		canvas.height = height;
	}
	const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
	if (!ctx) return null;
	ctx.drawImage(video, 0, 0, width, height);
	const image = ctx.getImageData(0, 0, width, height);
	return { data: image.data, width, height };
}

/** Grabs a downscaled frame for the live aiming loop. */
export function grabPreviewFrame(
	video: HTMLVideoElement,
	canvas: HTMLCanvasElement,
	targetWidth: number,
): { data: Uint8ClampedArray; width: number; height: number; scale: number } | null {
	const nativeWidth = video.videoWidth;
	const nativeHeight = video.videoHeight;
	if (nativeWidth === 0 || nativeHeight === 0) return null;
	const scale = Math.min(1, targetWidth / nativeWidth);
	const width = Math.max(1, Math.round(nativeWidth * scale));
	const height = Math.max(1, Math.round(nativeHeight * scale));
	if (canvas.width !== width || canvas.height !== height) {
		canvas.width = width;
		canvas.height = height;
	}
	const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
	if (!ctx) return null;
	ctx.drawImage(video, 0, 0, width, height);
	// Read the fields explicitly. ImageData exposes data/width/height as
	// prototype accessors, so an object spread quietly produces an object with
	// none of them and the worker receives an undefined buffer.
	const image = ctx.getImageData(0, 0, width, height);
	return { data: image.data, width: image.width, height: image.height, scale };
}

/**
 * A 26mm-equivalent lens, expressed in pixels for this frame width.
 *
 * No web API exposes focal length and none is coming -- the W3C issue asking for
 * it was closed one day after it was filed, in 2016. This is the prior's mean;
 * the solver refines it per frame and reports how much the photograph actually
 * pinned it down.
 */
export function focalPxFor(width: number, equivMm = 26): number {
	return (width * equivMm) / 36;
}
