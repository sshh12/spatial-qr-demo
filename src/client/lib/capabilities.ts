/**
 * What this browser will and will not let us do, checked rather than assumed.
 */

export type InAppBrowser =
	| { kind: "none" }
	| { kind: "android-webview"; app: string; intentEscape: true }
	| { kind: "ios-webview"; app: string; intentEscape: false };

const ANDROID_APPS: [RegExp, string][] = [
	[/FBAN|FBAV|FB_IAB/i, "Facebook"],
	[/Instagram/i, "Instagram"],
	[/Threads/i, "Threads"],
	[/Twitter|TwitterAndroid/i, "X"],
	[/LinkedInApp/i, "LinkedIn"],
	[/Line\//i, "LINE"],
	[/Snapchat/i, "Snapchat"],
	[/Slack/i, "Slack"],
	[/Reddit/i, "Reddit"],
];

/**
 * On a front-page day the majority path is not the QR scan -- it is somebody
 * tapping a shared link inside X, Threads, Reddit, LinkedIn or Slack. Meta's
 * Android apps do not grant camera access to their WebView at all, and iOS
 * SFSafariViewController denies silently with no prompt, which is why "rejected
 * in under 200ms with no visible prompt" has to be a distinct diagnostic state
 * from a user saying no: the Settings advice that helps one is useless for the
 * other.
 */
export function detectInAppBrowser(ua = navigator.userAgent): InAppBrowser {
	const isIos = /iPhone|iPad|iPod/i.test(ua);
	for (const [pattern, app] of ANDROID_APPS) {
		if (pattern.test(ua)) {
			return isIos
				? { kind: "ios-webview", app, intentEscape: false }
				: { kind: "android-webview", app, intentEscape: true };
		}
	}
	// iOS in-app browsers based on WKWebView report as Safari but lack the
	// standalone-Safari version token pattern in a few detectable ways.
	if (isIos && /AppleWebKit/i.test(ua) && !/Safari\//i.test(ua)) {
		return { kind: "ios-webview", app: "an app", intentEscape: false };
	}
	return { kind: "none" };
}

export interface CanvasIntegrity {
	readonly ok: boolean;
	readonly maxDelta: number;
	readonly reason: string | null;
}

/**
 * Brave perturbs canvas readback to defeat fingerprinting, and this entire
 * pipeline reads frames through a canvas. The damage is silent: the QR still
 * decodes, so nothing errors, but the sub-pixel refinement is working on pixels
 * that were quietly altered, and the answer is wrong with full confidence.
 *
 * Twenty lines to draw a known pattern, read it back, and compare exactly. On a
 * mismatch we route to the no-camera path and say so, which Brave users will
 * appreciate rather than resent.
 */
export function canvasIntegritySelfTest(): CanvasIntegrity {
	try {
		const canvas = document.createElement("canvas");
		canvas.width = 32;
		canvas.height = 32;
		const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
		if (!ctx) return { ok: false, maxDelta: 255, reason: "no-2d-context" };

		const expected = new Uint8ClampedArray(32 * 32 * 4);
		for (let y = 0; y < 32; y++) {
			for (let x = 0; x < 32; x++) {
				const v = (x * 8 + y * 3) % 256;
				const i = (y * 32 + x) * 4;
				expected[i] = v;
				expected[i + 1] = (v * 2) % 256;
				expected[i + 2] = (v * 3) % 256;
				expected[i + 3] = 255;
			}
		}
		ctx.putImageData(new ImageData(expected, 32, 32), 0, 0);
		const read = ctx.getImageData(0, 0, 32, 32).data;

		let maxDelta = 0;
		for (let i = 0; i < expected.length; i++) {
			maxDelta = Math.max(maxDelta, Math.abs(read[i]! - expected[i]!));
		}
		return {
			ok: maxDelta === 0,
			maxDelta,
			reason: maxDelta === 0 ? null : "canvas-readback-perturbed",
		};
	} catch (err) {
		return { ok: false, maxDelta: 255, reason: err instanceof Error ? err.message : "unknown" };
	}
}

export type CameraSupport = "ok" | "insecure" | "unsupported";

/**
 * Why the camera might be unavailable before we ever ask for it.
 *
 * These are two different situations with two different answers and they must
 * not be collapsed. "Not a secure context" is fixable by the visitor: open the
 * HTTPS address. "Secure, but this browser exposes no camera API at all" is not
 * fixable by anyone, and telling that person to check their connection sends
 * them somewhere useless -- the right move is to put them straight on the
 * no-camera route.
 *
 * The distinction is not hypothetical. Playwright's WebKit build on Windows
 * reports isSecureContext true and has no navigator.mediaDevices whatsoever,
 * and so do several locked-down enterprise browser configurations.
 */
export function cameraSupport(): CameraSupport {
	if (typeof window === "undefined") return "unsupported";
	if (!window.isSecureContext) return "insecure";
	if (typeof navigator.mediaDevices?.getUserMedia !== "function") return "unsupported";
	return "ok";
}

export function secureContextReady(): boolean {
	return cameraSupport() === "ok";
}

export function prefersReducedMotion(): boolean {
	return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Browser zoom invalidates the card ruler outright: the CSS pixel changes size
 * underneath the measurement. `visualViewport.scale` catches pinch zoom, and the
 * dpr-versus-outerWidth ratio catches desktop page zoom.
 */
export function zoomFactor(): number {
	const visual = window.visualViewport?.scale ?? 1;
	const page =
		window.outerWidth > 0 && window.innerWidth > 0
			? Math.round((window.outerWidth / window.innerWidth) * 100) / 100
			: 1;
	// Page zoom also changes innerWidth, so only trust it when it is close to a
	// recognisable zoom step; otherwise a narrow window reads as zoom.
	return Math.max(visual, Math.abs(page - 1) > 0.05 && page < 3 ? page : 1);
}

export function isZoomed(): boolean {
	return Math.abs(zoomFactor() - 1) > 0.02;
}
