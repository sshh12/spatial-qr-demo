import type { Ghost, Viewer, WirePose } from "@core/api.ts";
import { tierFromPose } from "@core/api.ts";
import type { MarkerLayout } from "@core/marker.ts";
import type { RedirectFacts } from "@core/redirect.ts";
import { buildRedirectUrl, destinationHost, reportedTier } from "@core/redirect.ts";
import { decodeToken } from "@core/token.ts";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { captureBurst } from "../capture/burst.ts";
import {
	focalPxFor,
	grabPreviewFrame,
	readCameraInfo,
	releaseCamera,
	requestCamera,
} from "../capture/camera.ts";
import type { AimResult, SerialBranch, SolveResult } from "../capture/protocol.ts";
import { DetectorClient } from "../capture/worker-client.ts";
import type { ZoomMode, ZoomState } from "../capture/zoom.ts";
import {
	applyZoom,
	detectZoom,
	lensZoomState,
	NO_ZOOM,
	openLens,
	zoomSteps,
} from "../capture/zoom.ts";
import { PlanView } from "../components/PlanView.tsx";

/**
 * Three.js is a quarter of a megabyte gzipped and is not needed until the very
 * last screen. Loading it up front would compete with the detector wasm for the
 * few seconds of reading time on the cold open, which is exactly the budget that
 * makes the first capture feel instant.
 */
const Scene = lazy(() => import("../scene/Scene.tsx").then((m) => ({ default: m.Scene })));

import { api, beaconLeave } from "../lib/api.ts";
import {
	cameraSupport,
	canvasIntegritySelfTest,
	detectInAppBrowser,
	prefersReducedMotion,
} from "../lib/capabilities.ts";
import { clientId, deviceSignature } from "../lib/identity.ts";
import { useSession } from "../lib/session.ts";
import {
	DEFAULT_SIZE_SIGMA_REL,
	describe,
	formatSigned,
	readout as makeReadout,
	toWirePose,
} from "../lib/units.ts";

type Stage =
	| "cold"
	| "permission"
	| "look-up"
	| "aiming"
	| "capturing"
	| "solving"
	| "result"
	| "ambiguous"
	| "retry"
	| "no-camera"
	| "blocked";

/**
 * The phone flow, S0 to S7.
 *
 * One hard constraint shapes all of it: the entire journey is a single page
 * load. No navigation, no reload, no hash routing, no post-solve redirect. iOS
 * revokes an "Allow Once" camera grant the moment the page navigates, and there
 * is no API to ask for it again, so a mid-flow navigation is not a slow path --
 * it is an unrecoverable dead end.
 */
export function Scan({ token }: { token: string }) {
	const [stage, setStage] = useState<Stage>("cold");
	const [aim, setAim] = useState<AimResult | null>(null);
	const [solved, setSolved] = useState<SolveResult | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const [progress, setProgress] = useState(0);
	const [eyes, setEyes] = useState(false);
	const [ghosts, setGhosts] = useState<readonly Ghost[]>([]);
	const [detectorReady, setDetectorReady] = useState(false);
	const [screenshot, setScreenshot] = useState(false);
	/** What was reported for this visitor, and therefore what may travel onward. */
	const [reported, setReported] = useState<Omit<RedirectFacts, "token"> | null>(null);
	const [stayed, setStayed] = useState(false);
	const [zoomMode, setZoomMode] = useState<ZoomMode>({ kind: "none" });
	const [zoom, setZoom] = useState<ZoomState>(NO_ZOOM);
	const [zoomBusy, setZoomBusy] = useState(false);

	const videoRef = useRef<HTMLVideoElement>(null);
	const previewCanvas = useRef<HTMLCanvasElement>(document.createElement("canvas"));
	const captureCanvas = useRef<HTMLCanvasElement>(document.createElement("canvas"));
	const frozenCanvas = useRef<HTMLCanvasElement>(document.createElement("canvas"));
	const streamRef = useRef<MediaStream | null>(null);
	const detector = useRef<DetectorClient>(new DetectorClient());
	const me = useRef(clientId());
	const rvfcHandle = useRef<number | null>(null);
	const cameraInfo = useRef<{ width: number; height: number } | null>(null);

	const spec = useMemo(() => {
		try {
			return decodeToken(token);
		} catch {
			return null;
		}
	}, [token]);

	const { room, refresh } = useSession(token);
	const inApp = useMemo(() => detectInAppBrowser(), []);
	const integrity = useMemo(() => canvasIntegritySelfTest(), []);
	const reduced = useMemo(() => prefersReducedMotion(), []);
	const support = useMemo(() => cameraSupport(), []);

	// A browser with no camera API at all is not a failure to explain away, it is
	// a visitor to route. Send them down the path that works rather than showing
	// them a dead end that blames their connection.
	useEffect(() => {
		if (support === "unsupported" && stage === "cold") {
			setFailure("no-camera-api");
			setStage("no-camera");
		}
	}, [support, stage]);

	/**
	 * The layout the display says it is showing right now.
	 *
	 * The phone never guesses. If no display is connected -- printed code, closed
	 * tab, link opened from a tweet -- we fall back to the token's own declared
	 * size and say so, with the range budget cut to match.
	 */
	const layout: MarkerLayout | null = room?.layout ?? null;
	const detached = !layout;

	/**
	 * The onward destination, if this code was created with one.
	 *
	 * Derived rather than latched, because the room can arrive after the solve
	 * does on a slow connection. Latching it at any single moment would mean a
	 * fast solve silently loses the redirect the creator configured.
	 */
	const destination = room?.redirect ?? null;
	const handoffUrl = useMemo(
		() => (destination && reported ? buildRedirectUrl(destination, { ...reported, token }) : null),
		[destination, reported, token],
	);

	const activeLayout: MarkerLayout | null = useMemo(() => {
		if (layout) return layout;
		if (!spec) return null;
		return {
			id: "idle",
			moduleCount: 25,
			symbolEdgeCssPx: 100,
			symbolEdgeMm: spec.markerEdgeMm,
			viewportCssPx: { w: spec.aspectNum * 100, h: spec.aspectDen * 100 },
			symbolCentreCssPx: { x: 0, y: 0 },
			brackets: null,
			nonce: "",
		};
	}, [layout, spec]);

	useEffect(() => {
		detector.current.start();
		void detector.current.ready.then(() => setDetectorReady(true));
		const client = detector.current;
		return () => client.terminate();
	}, []);

	useEffect(() => {
		void api.hello(token, "phone", me.current).catch(() => {});
		void api
			.ghosts(400)
			.then((g) => setGhosts(g.ghosts))
			.catch(() => {});
		const onLeave = () => beaconLeave(token, me.current);
		window.addEventListener("pagehide", onLeave);
		return () => {
			window.removeEventListener("pagehide", onLeave);
			releaseCamera(streamRef.current);
		};
	}, [token]);

	const stopAiming = useCallback(() => {
		if (rvfcHandle.current !== null) {
			const video = videoRef.current as unknown as {
				cancelVideoFrameCallback?: (h: number) => void;
			} | null;
			video?.cancelVideoFrameCallback?.(rvfcHandle.current);
			rvfcHandle.current = null;
		}
	}, []);

	/** S3: the live aiming loop, at ~640px, in the worker. */
	const startAiming = useCallback(() => {
		const video = videoRef.current;
		if (!video) return;
		let busy = false;
		const schedule = () => {
			const withCallback = video as unknown as {
				requestVideoFrameCallback?: (cb: () => void) => number;
			};
			if (withCallback.requestVideoFrameCallback) {
				rvfcHandle.current = withCallback.requestVideoFrameCallback(tick);
			} else {
				rvfcHandle.current = requestAnimationFrame(tick) as unknown as number;
			}
		};
		const tick = () => {
			if (busy) {
				schedule();
				return;
			}
			busy = true;
			const frame = grabPreviewFrame(video, previewCanvas.current, 640);
			if (!frame) {
				busy = false;
				schedule();
				return;
			}
			detector.current
				.aim(frame)
				.then((result) => {
					const scale = video.videoWidth / frame.width || 1;
					setAim({
						...result,
						quad: result.quad?.map((p) => ({ x: p.x * scale, y: p.y * scale })) ?? null,
						pxPerModule: result.pxPerModule * scale,
					});
				})
				.catch((err) => {
					// A worker that is failing every frame must not look identical to a
					// worker that simply cannot see a code.
					console.error("detector:", err instanceof Error ? err.message : err);
				})
				.finally(() => {
					busy = false;
					schedule();
				});
		};
		schedule();
	}, []);

	/** S1: fires synchronously from the tap, with nothing else in the handler. */
	const onEnableCamera = useCallback(async () => {
		const outcome = await requestCamera();
		if (outcome.kind !== "granted") {
			setFailure(outcome.kind);
			setStage(outcome.kind === "blocked-by-app" ? "blocked" : "no-camera");
			return;
		}
		streamRef.current = outcome.stream;
		const track = outcome.stream.getVideoTracks()[0];
		if (track) {
			const info = readCameraInfo(track);
			cameraInfo.current = { width: info.width, height: info.height };
			// Lens labels are blank until a grant exists, so this cannot run any
			// earlier than the line above it.
			void detectZoom(track)
				.then(setZoomMode)
				.catch(() => {});
		}
		const video = videoRef.current;
		if (video) {
			video.srcObject = outcome.stream;
			video.setAttribute("playsinline", "");
			video.muted = true;
			await video.play().catch(() => {});
		}

		// S2: tell the display to swap, then wait -- but not forever.
		setStage("look-up");
		void api.armed(token).catch(() => {});
		window.setTimeout(() => {
			setStage((current) => (current === "look-up" ? "aiming" : current));
			startAiming();
		}, 900);
	}, [token, startAiming]);

	useEffect(() => {
		if (stage === "aiming" && rvfcHandle.current === null) startAiming();
	}, [stage, startAiming]);

	/**
	 * Zoom, by whichever of the two mechanisms this browser has.
	 *
	 * The lens branch swaps the whole stream, so it acquires the replacement
	 * before releasing what it has: on iOS a lost camera grant cannot be asked
	 * for again inside one page load, and this runs mid-flow. A failed swap
	 * therefore leaves the visitor exactly where they were rather than ending
	 * their session at the moment they tried to improve it.
	 */
	const onZoom = useCallback(
		async (factor: number) => {
			const track = streamRef.current?.getVideoTracks()[0];
			if (!track || zoomMode.kind === "none" || zoomBusy) return;
			setZoomBusy(true);
			try {
				if (zoomMode.kind === "constraint") {
					setZoom(await applyZoom(track, factor));
				} else {
					const lens = zoomMode.lenses.find((l) => l.factor === factor);
					if (!lens) return;
					const next = await openLens(lens.deviceId);
					if (!next) return;
					const previous = streamRef.current;
					streamRef.current = next;
					const video = videoRef.current;
					if (video) {
						video.srcObject = next;
						await video.play().catch(() => {});
					}
					releaseCamera(previous);
					setZoom(lensZoomState(lens));
				}
				// A zoom or a lens swap can renegotiate the resolution, and the focal
				// prior is expressed in pixels of whatever resolution is now in force.
				const active = streamRef.current?.getVideoTracks()[0];
				if (active) {
					const info = readCameraInfo(active);
					cameraInfo.current = { width: info.width, height: info.height };
				}
			} finally {
				setZoomBusy(false);
			}
		},
		[zoomMode, zoomBusy],
	);

	/** S4-S5: burst, freeze, solve. */
	const onCapture = useCallback(async () => {
		const video = videoRef.current;
		if (!video) return;
		setStage("capturing");
		void api.capturing(token).catch(() => {});

		const width = video.videoWidth || 1280;
		const outcome = await captureBurst({
			video,
			canvas: captureCanvas.current,
			detector: detector.current,
			layout: activeLayout,
			// The prior moves with the zoom, or zoom makes the answer worse rather
			// than better: the solver's MAP estimate would spend the whole capture
			// pulling a 3x focal length back toward a 26mm-equivalent prior, and
			// the posterior width scales the reported position radially.
			focalPx: focalPxFor(width) * zoom.focalScale,
			focalSigmaLog: zoom.focalSigmaLog,
			sigmaPx: 0.35,
			frames: 8,
			onFrame: (i, total) => setProgress((i + 1) / total),
		});

		// Freeze the winning frame for the overlay and the display plane.
		const frozen = frozenCanvas.current;
		frozen.width = Math.min(1024, width);
		frozen.height = Math.round((frozen.width * video.videoHeight) / (video.videoWidth || 1));
		frozen.getContext("2d")?.drawImage(video, 0, 0, frozen.width, frozen.height);

		// The promise from the cold open, paid immediately and visibly.
		stopAiming();
		releaseCamera(streamRef.current);
		streamRef.current = null;
		if (video) video.srcObject = null;

		setStage("solving");
		await new Promise((resolve) => setTimeout(resolve, reduced ? 0 : 700));

		if (!outcome.chosen) {
			if (outcome.ambiguous) {
				setSolved(outcome.ambiguous);
				setStage("ambiguous");
				return;
			}
			setFailure(friendlyCaptureFailure(outcome.reasons[0]));
			setStage("retry");
			return;
		}
		setSolved(outcome.chosen);
		setStage("result");
	}, [token, activeLayout, reduced, stopAiming, zoom]);

	// Post the four numbers once we have them.
	const posted = useRef(false);
	useEffect(() => {
		if (stage !== "result" || !solved?.primary || !activeLayout || posted.current) return;
		posted.current = true;
		const pose = toWirePose(solved.primary, {
			edgeToScreenHeight: layout
				? layout.symbolEdgeCssPx / layout.viewportCssPx.h
				: (spec?.edgeToScreenHeight ?? 0),
			symbolEdgeMm: activeLayout.symbolEdgeMm,
			sizeSigmaRel: DEFAULT_SIZE_SIGMA_REL,
		});
		// Optimistic first, so a phone that has lost the network still reaches the
		// destination it was sent to; overwritten by the clamped, server-tiered
		// numbers the moment they come back.
		setReported({
			pose,
			tier: reportedTier(tierFromPose(pose)),
			source: "measured",
			at: Date.now(),
		});
		void api
			.pose(token, me.current, pose, { ambiguous: solved.branchMargin < 3 })
			.then(({ viewer }) => {
				setReported({
					pose: viewer.pose ?? pose,
					tier: reportedTier(viewer.tier),
					source: "measured",
					at: viewer.at,
				});
			})
			.catch(() => {});
		void refresh().catch(() => {});

		// Every solid solve converges a focal length. Aggregated by device
		// signature that becomes a real per-model prior, which is the larger of
		// the two accuracy levers the commons has.
		//
		// Zoomed captures are excluded outright rather than divided by their
		// factor. The commons is keyed on a coarse device signature that says
		// nothing about which lens was active, so a telephoto sample would land in
		// the same bucket as a main-camera one and drag the median for every
		// future visitor on that model. Dividing would only help if the factor
		// were exact, and on the lens path it is inferred from a label.
		if (solved.tier === "solid" && cameraInfo.current?.width && zoom.factor === 1) {
			void api
				.contributeCalibration({
					signature: deviceSignature(),
					focalOverWidth: solved.primary.focalPx / cameraInfo.current.width,
				})
				.catch(() => {});
		}
	}, [stage, solved, activeLayout, token, layout, spec, refresh, zoom]);

	// Hard blocks, checked before anything else is offered.
	if (!spec)
		return (
			<Shell>
				<Fatal title="Display not found" detail="This QR link is incomplete or invalid." />
			</Shell>
		);
	if (support === "insecure" && stage === "cold") {
		return (
			<Shell>
				<Fatal
					title="The camera needs a secure connection."
					detail="Open this page over HTTPS and it will work."
				/>
			</Shell>
		);
	}
	if (!integrity.ok && stage === "cold") {
		return (
			<Shell>
				<FarblingNotice onContinue={() => setStage("no-camera")} />
			</Shell>
		);
	}

	// Linked: measure the ratio from what the display says it is showing.
	// Detached: read it from the token, which is why it is in the token.
	const displayContext = activeLayout
		? {
				edgeToScreenHeight: layout
					? layout.symbolEdgeCssPx / layout.viewportCssPx.h
					: (spec.edgeToScreenHeight ?? 0),
				symbolEdgeMm: activeLayout.symbolEdgeMm,
				sizeSigmaRel: DEFAULT_SIZE_SIGMA_REL,
			}
		: null;

	return (
		<Shell>
			<video
				ref={videoRef}
				playsInline
				muted
				autoPlay
				className={
					stage === "aiming" || stage === "capturing"
						? "fixed inset-0 h-full w-full object-cover"
						: "hidden"
				}
				data-testid="viewfinder"
			/>

			{stage === "aiming" || stage === "capturing" ? (
				<Viewfinder
					aim={aim}
					stage={stage}
					progress={progress}
					failure={failure}
					onCapture={onCapture}
					video={videoRef.current}
					zoomMode={zoomMode}
					zoom={zoom}
					zoomBusy={zoomBusy}
					onZoom={onZoom}
				/>
			) : null}

			{stage === "cold" && (
				<ColdOpen
					ready={detectorReady}
					inApp={inApp}
					detached={detached}
					onStart={() => setStage("permission")}
					onNoCamera={() => setStage("no-camera")}
				/>
			)}

			{stage === "permission" && (
				<Permission
					inApp={inApp}
					onEnable={onEnableCamera}
					onNoCamera={() => setStage("no-camera")}
				/>
			)}

			{stage === "look-up" && <LookUp detached={detached} />}

			{stage === "solving" && <Solving frozen={frozenCanvas.current} solved={solved} />}

			{stage === "ambiguous" && solved && (
				<Ambiguous
					solved={solved}
					onRetry={() => {
						setStage("cold");
						posted.current = false;
					}}
				/>
			)}

			{stage === "retry" && (
				<RetryCapture
					reason={failure}
					onRetry={() => {
						setFailure(null);
						setProgress(0);
						void onEnableCamera();
					}}
				/>
			)}

			{stage === "blocked" && <BlockedByApp inApp={inApp} onCopy={() => copyLink()} />}

			{stage === "no-camera" &&
				displayContext &&
				(handoffUrl && reported ? (
					<Handoff url={handoffUrl} facts={reported} />
				) : (
					<NoCamera
						token={token}
						clientId={me.current}
						ghosts={ghosts}
						reason={failure}
						onPlaced={setReported}
					/>
				))}

			{stage === "result" &&
				solved?.primary &&
				displayContext &&
				(handoffUrl && reported && !stayed ? (
					<Handoff
						url={handoffUrl}
						facts={reported}
						onShowResult={() => setStayed(true)}
						detached={detached}
					/>
				) : (
					<Result
						solved={solved}
						display={displayContext}
						viewers={room?.viewers ?? []}
						ghosts={ghosts}
						meId={me.current}
						eyes={eyes}
						onToggleEyes={() => setEyes((v) => !v)}
						frozen={frozenCanvas.current}
						aspect={(spec.aspectNum || 16) / (spec.aspectDen || 9)}
						detached={detached}
						screenshot={screenshot}
						onScreenshot={() => setScreenshot(true)}
						continueUrl={handoffUrl}
					/>
				))}

			<Readout
				stage={stage}
				aim={aim}
				solved={solved}
				camera={cameraInfo.current}
				detached={detached}
				zoom={zoom}
			/>
		</Shell>
	);
}

function Shell({ children }: { children: React.ReactNode }) {
	return (
		<main className="relative mx-auto min-h-screen w-full max-w-lg px-5 py-8">{children}</main>
	);
}

function Fatal({ title, detail }: { title: string; detail?: string }) {
	return (
		<section className="flex min-h-[70vh] flex-col justify-center gap-3" data-testid="stage-fatal">
			<h1 className="text-xl leading-snug font-medium">{title}</h1>
			{detail && <p className="text-sm text-[var(--hex-muted)]">{detail}</p>}
			<a className="font-mono text-xs text-[var(--hex-accent)] underline" href="/">
				Open the demo
			</a>
		</section>
	);
}

/** The in-app browser's name, or a neutral stand-in when there isn't one. */
function appName(inApp: ReturnType<typeof detectInAppBrowser>): string {
	return inApp.kind === "none" ? "This browser" : inApp.app;
}

/** S0. No permission request on load, ever. */
function ColdOpen({
	ready,
	inApp,
	detached,
	onStart,
	onNoCamera,
}: {
	ready: boolean;
	inApp: ReturnType<typeof detectInAppBrowser>;
	detached: boolean;
	onStart: () => void;
	onNoCamera: () => void;
}) {
	return (
		<section className="flex min-h-[80vh] flex-col justify-center gap-8" data-testid="stage-cold">
			<div className="flex flex-col gap-3">
				<h1 className="text-2xl leading-snug font-medium">This display can locate your phone.</h1>
				<p className="text-sm leading-relaxed text-[var(--hex-muted)]">
					A short camera capture measures the code&apos;s perspective, revealing your phone&apos;s
					angle and distance from the screen.
				</p>
			</div>

			<ul className="flex flex-col gap-2 font-mono text-xs text-[var(--hex-dim)]">
				<li>Camera starts only after you tap.</li>
				<li>Images stay on this phone.</li>
				<li>Position and uncertainty are sent.</li>
			</ul>

			{detached && (
				<p className="rounded border border-[var(--hex-warn)]/40 px-4 py-3 text-xs text-[var(--hex-warn)]">
					The display is no longer connected. We&apos;ll measure from the smaller code you scanned,
					so the usable range is shorter.
				</p>
			)}

			{inApp.kind !== "none" && (
				<p className="rounded border border-[var(--hex-warn)]/40 px-4 py-3 text-xs text-[var(--hex-warn)]">
					Camera access sometimes fails inside {inApp.app}. If it does, we&apos;ll help you open
					this page in Safari or Chrome.
				</p>
			)}

			<div className="flex flex-col gap-3">
				<button
					type="button"
					onClick={onStart}
					disabled={!ready}
					data-testid="begin"
					className="rounded bg-[var(--hex-accent)] px-5 py-3.5 font-mono text-sm text-black transition disabled:opacity-40"
				>
					{ready ? "Start" : "Getting the decoder ready…"}
				</button>
				<button
					type="button"
					onClick={onNoCamera}
					className="text-center font-mono text-xs text-[var(--hex-dim)] underline"
				>
					Place me manually
				</button>
			</div>
		</section>
	);
}

/** S1. The native prompt fires from this tap and nothing else is in the handler. */
function Permission({
	inApp,
	onEnable,
	onNoCamera,
}: {
	inApp: ReturnType<typeof detectInAppBrowser>;
	onEnable: () => void;
	onNoCamera: () => void;
}) {
	return (
		<section
			className="flex min-h-[80vh] flex-col justify-center gap-7"
			data-testid="stage-permission"
		>
			<h2 className="text-xl leading-snug font-medium">
				Allow camera access for one short capture.
			</h2>
			<p className="text-sm leading-relaxed text-[var(--hex-muted)]">
				Images are processed on this phone and never uploaded. The camera switches off as soon as
				capture ends.
			</p>
			{inApp.kind !== "none" && (
				<p className="font-mono text-xs text-[var(--hex-warn)]">
					in {inApp.app}&apos;s browser — this may be refused without a prompt
				</p>
			)}
			<button
				type="button"
				onClick={onEnable}
				data-testid="enable-camera"
				className="rounded bg-[var(--hex-accent)] px-5 py-3.5 font-mono text-sm text-black"
			>
				Turn on camera
			</button>
			<button
				type="button"
				onClick={onNoCamera}
				className="text-center font-mono text-xs text-[var(--hex-dim)] underline"
			>
				Place me manually
			</button>
		</section>
	);
}

/** S2. */
function LookUp({ detached }: { detached: boolean }) {
	return (
		<section
			className="flex min-h-[80vh] flex-col items-center justify-center gap-4 text-center"
			data-testid="stage-lookup"
		>
			<p className="text-2xl font-medium">Look back at the code.</p>
			<p className="font-mono text-xs text-[var(--hex-dim)]">
				{detached
					? "Point back at the code you scanned"
					: "The code is expanding for a clearer measurement"}
			</p>
		</section>
	);
}

/** S3 and S4. */
function Viewfinder({
	aim,
	stage,
	progress,
	failure,
	onCapture,
	video,
	zoomMode,
	zoom,
	zoomBusy,
	onZoom,
}: {
	aim: AimResult | null;
	stage: Stage;
	progress: number;
	failure: string | null;
	onCapture: () => void;
	video: HTMLVideoElement | null;
	zoomMode: ZoomMode;
	zoom: ZoomState;
	zoomBusy: boolean;
	onZoom: (factor: number) => void;
}) {
	const size = video ? { w: video.videoWidth, h: video.videoHeight } : { w: 1, h: 1 };
	const steps = zoomSteps(zoomMode);
	const canZoomFurther = steps.some((s) => s > zoom.factor + 0.05);
	const gauge = gaugeMessage(aim, canZoomFurther);
	const canCapture = Boolean(aim?.found) && gauge.ready && stage === "aiming";

	return (
		<div className="fixed inset-0 z-40 flex flex-col justify-between" data-testid="stage-aiming">
			{aim?.quad && (
				<svg
					className="pointer-events-none absolute inset-0 h-full w-full"
					viewBox={`0 0 ${size.w} ${size.h}`}
					preserveAspectRatio="xMidYMid slice"
					role="presentation"
					aria-hidden="true"
				>
					{/* The box clamps onto the real thing. That single frame argues for
					    on-device processing better than any sentence could. */}
					<polygon
						points={aim.quad.map((p) => `${p.x},${p.y}`).join(" ")}
						fill="none"
						stroke="var(--hex-accent)"
						strokeWidth={Math.max(2, size.w / 320)}
						style={{ transition: "all 120ms cubic-bezier(.2,.9,.3,1.2)" }}
						data-testid="lock-box"
					/>
				</svg>
			)}

			<div className="mt-6 flex justify-center px-6">
				<p className="rounded-full bg-black/60 px-4 py-2 font-mono text-xs text-white backdrop-blur">
					{stage === "capturing"
						? `Capturing… keep still · ${Math.round(progress * 100)}%`
						: gauge.text}
				</p>
			</div>

			<div className="flex flex-col items-center gap-4 pb-10">
				{failure && (
					<p className="mx-6 rounded bg-black/70 px-4 py-2 text-center font-mono text-xs text-[var(--hex-warn)]">
						{failure}
					</p>
				)}

				{/*
				 * Discrete stops rather than a slider. They are what a camera app
				 * trains the thumb to expect, they are hittable one-handed while the
				 * other hand holds the phone steady, and on the lens path they are
				 * the only thing on offer anyway -- there is no continuum between two
				 * pieces of glass.
				 */}
				{steps.length > 1 && stage === "aiming" && (
					<div
						className="flex items-center gap-1 rounded-full bg-black/60 p-1 backdrop-blur"
						data-testid="zoom-control"
					>
						{steps.map((step) => {
							const active = Math.abs(zoom.factor - step) < 0.05;
							return (
								<button
									key={step}
									type="button"
									onClick={() => onZoom(step)}
									disabled={zoomBusy}
									data-testid={`zoom-${step}`}
									aria-pressed={active}
									className={`h-9 min-w-11 rounded-full px-3 font-mono text-xs transition disabled:opacity-40 ${
										active ? "bg-white text-black" : "text-white"
									}`}
								>
									{step < 1 ? `${step}×` : `${Math.round(step)}×`}
								</button>
							);
						})}
					</div>
				)}

				<button
					type="button"
					onClick={onCapture}
					disabled={!canCapture}
					data-testid="capture"
					className="h-20 w-20 rounded-full border-4 border-white bg-white/25 backdrop-blur transition disabled:opacity-30"
					aria-label="Capture the code"
				/>
			</div>
		</div>
	);
}

/**
 * One message at a time, driven by measured pixels per module.
 *
 * Never an instruction to move sideways. The angle *is* the measurement: asking
 * somebody to step left would change the answer we are trying to report.
 *
 * Zoom is offered ahead of walking for exactly the same reason. "Move closer"
 * has always been an awkward thing for this app to say -- it buys resolution by
 * altering the quantity being measured, so the visitor gets a good reading of
 * somewhere they were not standing when they decided to scan. Zoom buys the
 * same resolution and changes nothing about where they are. Where the camera
 * offers it, it is the better instruction, and the walk is the fallback rather
 * than the default.
 */
function gaugeMessage(aim: AimResult | null, canZoom: boolean): { text: string; ready: boolean } {
	if (!aim?.found) return { text: "Point at the code", ready: false };
	if (aim.touchesBorder) return { text: "Step back until the whole code fits", ready: false };
	if (aim.pxPerModule < 3.5) {
		return {
			text: canZoom ? "Zoom in — the code is too small" : "Move closer — the code is too small",
			ready: false,
		};
	}
	if (aim.pxPerModule < 6) {
		return {
			text: canZoom
				? "Ready — zoom in for better accuracy"
				: "Ready — move closer for better accuracy",
			ready: true,
		};
	}
	return { text: "Hold still and tap the shutter", ready: true };
}

/** S5: watch the maths agree with the photograph. */
function Solving({ frozen, solved }: { frozen: HTMLCanvasElement; solved: SolveResult | null }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const host = ref.current;
		if (!host) return;
		frozen.className = "w-full rounded";
		host.replaceChildren(frozen);
	}, [frozen]);

	return (
		<section
			className="flex min-h-[80vh] flex-col justify-center gap-6"
			data-testid="stage-solving"
		>
			<div className="relative overflow-hidden rounded border border-[var(--hex-line)]">
				<div ref={ref} className="opacity-40 grayscale" />
				{solved?.reprojected && (
					<svg
						className="absolute inset-0 h-full w-full"
						viewBox={`0 0 ${frozen.width} ${frozen.height}`}
						role="img"
					>
						<title>Measured square projected over the captured image</title>
						<polygon
							points={solved.reprojected.map((p) => `${p.x},${p.y}`).join(" ")}
							fill="none"
							stroke="var(--hex-good)"
							strokeWidth={2}
						/>
					</svg>
				)}
			</div>
			<p className="text-center font-mono text-xs text-[var(--hex-dim)]">
				Camera off · checking this frame on your phone
			</p>
		</section>
	);
}

function RetryCapture({ reason, onRetry }: { reason: string | null; onRetry: () => void }) {
	return (
		<section className="flex min-h-[80vh] flex-col justify-center gap-5" data-testid="stage-retry">
			<h2 className="text-xl leading-snug font-medium">That capture was not clear enough.</h2>
			<p className="text-sm leading-relaxed text-[var(--hex-muted)]">
				{reason ?? "Keep the whole code in frame and hold the phone still."}
			</p>
			<button
				type="button"
				onClick={onRetry}
				className="rounded bg-[var(--hex-accent)] px-5 py-3 font-mono text-sm text-black"
			>
				Try again
			</button>
		</section>
	);
}

/** 6.1: the best screen in the product. */
function Ambiguous({ solved, onRetry }: { solved: SolveResult; onRetry: () => void }) {
	const az = Math.abs(solved.primary?.azimuthDeg ?? 20);
	const dh = solved.primary?.distanceEdges ?? 3;
	return (
		<section
			className="flex min-h-[80vh] flex-col justify-center gap-6"
			data-testid="stage-ambiguous"
		>
			<h2 className="text-xl leading-snug font-medium">Two positions fit this capture.</h2>
			<PlanView viewers={[]} ambiguousPair={{ az, dh }} showLegend={false} />
			<p className="text-sm leading-relaxed text-[var(--hex-muted)]">
				The geometry cannot yet tell which side of the screen you were on.
			</p>
			<p className="text-sm text-[var(--hex-text)]">
				Take one step <strong>to your right</strong>, then scan again. A known direction breaks the
				tie.
			</p>
			<button
				type="button"
				onClick={onRetry}
				className="rounded bg-[var(--hex-accent)] px-5 py-3 font-mono text-sm text-black"
			>
				I stepped right — scan again
			</button>
		</section>
	);
}

function BlockedByApp({
	inApp,
	onCopy,
}: {
	inApp: ReturnType<typeof detectInAppBrowser>;
	onCopy: () => void;
}) {
	return (
		<section
			className="flex min-h-[80vh] flex-col justify-center gap-5"
			data-testid="stage-blocked"
		>
			<h2 className="text-xl leading-snug font-medium">
				{appName(inApp)} blocked the camera without asking you.
			</h2>
			<p className="text-sm leading-relaxed text-[var(--hex-muted)]">
				{inApp.kind === "none"
					? "Open this link in your normal browser. Changing your phone's privacy settings will not override an embedded browser."
					: `Open this link in your normal browser. Changing your phone's privacy settings will not override the browser built into ${inApp.app}.`}
			</p>
			{inApp.kind === "android-webview" ? (
				<a
					className="rounded bg-[var(--hex-accent)] px-5 py-3 text-center font-mono text-sm text-black"
					href={intentUrl()}
				>
					Open in Chrome
				</a>
			) : (
				<ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-[var(--hex-muted)]">
					<li>Tap the ••• or share button in the corner.</li>
					<li>Choose “Open in Safari”.</li>
					<li>Or copy the link and paste it into Safari yourself.</li>
				</ol>
			)}
			<button
				type="button"
				onClick={onCopy}
				className="rounded border border-[var(--hex-line)] px-5 py-3 font-mono text-sm"
			>
				Copy link
			</button>
		</section>
	);
}

function FarblingNotice({ onContinue }: { onContinue: () => void }) {
	return (
		<section
			className="flex min-h-[80vh] flex-col justify-center gap-5"
			data-testid="stage-farbling"
		>
			<h2 className="text-xl leading-snug font-medium">
				Image protection prevents an accurate reading.
			</h2>
			<p className="text-sm leading-relaxed text-[var(--hex-muted)]">
				Brave and some privacy extensions slightly alter images read by the browser. This demo reads
				camera frames the same way, so its result would be unreliable.
			</p>
			<button
				type="button"
				onClick={onContinue}
				className="rounded bg-[var(--hex-accent)] px-5 py-3 font-mono text-sm text-black"
			>
				Place me manually
			</button>
		</section>
	);
}

const HANDOFF_SECONDS = 3;

/**
 * The onward handoff, for a code created with a destination.
 *
 * It takes the place of the result screen rather than sitting after it: someone
 * who scanned a poster wants the poster's page, and making them scroll past a
 * 3D scene to reach it would be the demo getting in the way of the product.
 *
 * What survives from the result screen is the part that is a promise rather
 * than a flourish -- the numbers are on screen, in full, before they are sent
 * anywhere. The countdown gives that a few seconds to be read and can be
 * stopped by touching the screen or pressing any key, which is also what makes
 * the timed navigation escapable for somebody using a keyboard or a screen
 * reader. The destination is shown in full, because a redirect nobody can see
 * before it happens is just an open redirect with better manners.
 */
function Handoff({
	url,
	facts,
	onShowResult,
	detached,
}: {
	url: string;
	facts: Omit<RedirectFacts, "token">;
	onShowResult?: () => void;
	detached?: boolean;
}) {
	const [left, setLeft] = useState(HANDOFF_SECONDS);
	const [paused, setPaused] = useState(false);
	const host = useMemo(() => destinationHost(url), [url]);
	const go = useCallback(() => window.location.replace(url), [url]);

	useEffect(() => {
		if (paused) return;
		// `replace`, not `assign`: an interstitial is not somewhere the back
		// button should return anyone to.
		if (left <= 0) {
			go();
			return;
		}
		const timer = setTimeout(() => setLeft((v) => v - 1), 1000);
		return () => clearTimeout(timer);
	}, [left, paused, go]);

	const { pose } = facts;

	return (
		<section
			className="flex min-h-[80vh] flex-col justify-center gap-6"
			data-testid="handoff"
			data-seconds={paused ? "paused" : String(left)}
			onPointerDownCapture={() => setPaused(true)}
			onKeyDownCapture={() => setPaused(true)}
		>
			<div className="flex flex-col gap-2">
				<h2 className="text-xl leading-snug font-medium">
					Sending your position to <span className="break-all">{host}</span>.
				</h2>
				<p className="text-sm leading-relaxed text-[var(--hex-muted)]">
					These four numbers, and nothing else. No photograph leaves this phone.
				</p>
			</div>

			<dl className="grid grid-cols-2 gap-3 font-mono text-xs">
				<Stat
					label="side-to-side angle"
					value={`${formatSigned(pose.az, 1)}°`}
					note={pose.az < -2 ? "to the left" : pose.az > 2 ? "to the right" : "straight on"}
				/>
				<Stat label="vertical angle" value={`${formatSigned(pose.el, 1)}°`} note="above centre" />
				<Stat
					label="display heights"
					value={`${pose.dh.toFixed(2)} h`}
					note={`± ${pose.sd.toFixed(2)}`}
				/>
				<Stat
					label="confidence"
					value={facts.tier}
					note={facts.source === "manual" ? "placed by hand" : "measured"}
				/>
			</dl>

			<details className="rounded border border-[var(--hex-line)] px-4 py-3">
				<summary className="cursor-pointer font-mono text-xs text-[var(--hex-dim)]">
					Show the full address
				</summary>
				<code
					className="mt-3 block overflow-x-auto font-mono text-[11px] break-all text-[var(--hex-muted)]"
					data-testid="handoff-url"
				>
					{url}
				</code>
			</details>

			{detached && (
				<p className="rounded border border-[var(--hex-warn)]/40 px-4 py-3 text-xs text-[var(--hex-warn)]">
					The display was offline, so this was measured from the smaller code you scanned.
				</p>
			)}

			<div className="flex flex-col gap-3">
				<button
					type="button"
					onClick={go}
					data-testid="handoff-continue"
					className="rounded bg-[var(--hex-accent)] px-5 py-3.5 font-mono text-sm text-black"
				>
					{paused ? `Continue to ${host} →` : `Continuing in ${left}… go now →`}
				</button>
				{!paused && (
					<button
						type="button"
						onClick={() => setPaused(true)}
						data-testid="handoff-stay"
						className="text-center font-mono text-xs text-[var(--hex-dim)] underline"
					>
						Wait — don&apos;t send this yet
					</button>
				)}
				{paused && onShowResult && (
					<button
						type="button"
						onClick={onShowResult}
						className="text-center font-mono text-xs text-[var(--hex-dim)] underline"
					>
						See the full measurement instead
					</button>
				)}
			</div>

			<p className="font-mono text-[11px] text-[var(--hex-dim)]" role="status">
				{paused ? "Stopped. Nothing has been sent." : `Opening ${host} in ${left}…`}
			</p>
		</section>
	);
}

/** 6.6: a real route, not an apology. Also the accessibility path. */
function NoCamera({
	token,
	clientId: id,
	ghosts,
	reason,
	onPlaced,
}: {
	token: string;
	clientId: string;
	ghosts: readonly Ghost[];
	reason: string | null;
	/** Lifts the placement so a redirect can carry it, marked as hand-placed. */
	onPlaced?: (facts: Omit<RedirectFacts, "token">) => void;
}) {
	const [az, setAz] = useState(-18);
	const [dh, setDh] = useState(2.4);
	const [sent, setSent] = useState(false);

	const viewer: Viewer = {
		id,
		name: null,
		hue: 200,
		shape: 0,
		pose: { az, el: 0, dh, sd: 0.25 },
		tier: "soft",
		ambiguous: false,
		at: Date.now(),
	};

	return (
		<section
			className="flex min-h-[80vh] flex-col justify-center gap-6"
			data-testid="stage-no-camera"
		>
			<h2 className="text-xl leading-snug font-medium">Put yourself on the plan.</h2>
			<p className="text-sm leading-relaxed text-[var(--hex-muted)]">
				{reason === "no-camera-api" ? "This browser cannot access a camera. " : ""}
				Drag the controls until the dot is roughly where you are. Your position will be added to
				this scan.
			</p>

			<PlanView viewers={[viewer]} ghosts={ghosts} meId={id} />

			<label className="flex flex-col gap-2 font-mono text-xs text-[var(--hex-dim)]">
				Side-to-side angle: {formatSigned(az)}° {az < -2 ? "left" : az > 2 ? "right" : "centre"}
				<input
					type="range"
					min={-70}
					max={70}
					value={az}
					onChange={(e) => setAz(Number(e.target.value))}
					className="accent-[var(--hex-accent)]"
					aria-label="Angle left or right of screen centre"
				/>
			</label>
			<label className="flex flex-col gap-2 font-mono text-xs text-[var(--hex-dim)]">
				Distance from the screen: {dh.toFixed(1)} display heights
				<input
					type="range"
					min={0.5}
					max={12}
					step={0.1}
					value={dh}
					onChange={(e) => setDh(Number(e.target.value))}
					className="accent-[var(--hex-accent)]"
					aria-label="Distance from screen in display heights"
				/>
			</label>

			<button
				type="button"
				disabled={sent}
				onClick={() => {
					setSent(true);
					const pose: WirePose = { az, el: 0, dh, sd: 0.25 };
					// A destination is told this was placed by hand, not measured, so
					// it can weigh it accordingly rather than reading dragged sliders
					// as a photograph.
					const placed = (p: WirePose, tier: RedirectFacts["tier"]) =>
						onPlaced?.({ pose: p, tier, source: "manual", at: Date.now() });
					void api
						.pose(token, id, pose, { contribute: false })
						.then(({ viewer }) => placed(viewer.pose ?? pose, reportedTier(viewer.tier)))
						.catch(() => placed(pose, reportedTier(tierFromPose(pose))));
				}}
				className="rounded bg-[var(--hex-accent)] px-5 py-3 font-mono text-sm text-black disabled:opacity-40"
			>
				{sent ? "Position added" : "Add my position"}
			</button>
			<p className="font-mono text-[11px] text-[var(--hex-dim)]">
				placed by hand · excluded from measured results
			</p>
		</section>
	);
}

/** S6 and S7. */
function Result({
	solved,
	display,
	viewers,
	ghosts,
	meId,
	eyes,
	onToggleEyes,
	frozen,
	aspect,
	detached,
	screenshot,
	onScreenshot,
	continueUrl,
}: {
	solved: SolveResult;
	display: { edgeToScreenHeight: number; symbolEdgeMm: number; sizeSigmaRel: number };
	viewers: readonly Viewer[];
	ghosts: readonly Ghost[];
	meId: string;
	eyes: boolean;
	onToggleEyes: () => void;
	frozen: HTMLCanvasElement;
	aspect: number;
	detached: boolean;
	screenshot: boolean;
	onScreenshot: () => void;
	/** Present only when this code has a destination and the visitor stopped the countdown. */
	continueUrl: string | null;
}) {
	const branch = solved.primary as SerialBranch;
	const r = makeReadout(branch, display);
	const displayHeightM =
		display.edgeToScreenHeight > 0
			? display.symbolEdgeMm / 1000 / display.edgeToScreenHeight
			: display.symbolEdgeMm / 1000;

	return (
		<section className="flex flex-col gap-7 pb-16" data-testid="stage-result">
			{continueUrl && (
				<a
					href={continueUrl}
					data-testid="result-continue"
					className="rounded bg-[var(--hex-accent)] px-5 py-3.5 text-center font-mono text-sm text-black"
				>
					Continue to {destinationHost(continueUrl)} →
				</a>
			)}

			<div className="flex flex-col gap-2">
				<h2 className="text-xl leading-snug font-medium" data-testid="verdict">
					Your phone was {describe(r)}.
				</h2>
				<p className="font-mono text-xs text-[var(--hex-dim)]">
					{solved.tier === "solid"
						? "High confidence"
						: "Lower confidence · wider uncertainty area"}{" "}
					· {solved.pointCount} reference points
				</p>
			</div>

			<div className="h-[52vh] min-h-64 overflow-hidden rounded border border-[var(--hex-line)]">
				<Suspense
					fallback={
						<div className="flex h-full items-center justify-center font-mono text-xs text-[var(--hex-dim)]">
							Loading 3D view…
						</div>
					}
				>
					<Scene
						viewers={viewers}
						ghosts={ghosts}
						meId={meId}
						displayHeightM={Number.isFinite(displayHeightM) ? displayHeightM : 0.34}
						displayAspect={aspect}
						photo={frozen}
						eyes={eyes}
						reducedMotion={prefersReducedMotion()}
						className="h-full w-full"
					/>
				</Suspense>
			</div>

			<dl className="grid grid-cols-2 gap-4 font-mono text-xs">
				<Stat
					label="side-to-side angle"
					value={`${formatSigned(r.azimuthDeg, 1)}°`}
					note={`± ${r.azimuthSigmaDeg.toFixed(1)}° · ${r.side}`}
				/>
				<Stat
					label="vertical angle"
					value={`${formatSigned(r.elevationDeg, 1)}°`}
					note={`± ${r.elevationSigmaDeg.toFixed(1)}°`}
				/>
				<Stat
					label="display heights"
					value={`${(eyes ? r.eyes.screenHeights : r.screenHeights).toFixed(2)} h`}
					note={`± ${r.screenHeightsSigma.toFixed(2)} ${r.dimensionlessUnit} · no physical scale needed`}
				/>
				<Stat
					label="estimated distance"
					value={`${(eyes ? r.eyes.metres : r.metres).toFixed(2)} m`}
					note={`± ${r.metresSigma.toFixed(2)} · uses estimated screen and camera data`}
				/>
			</dl>

			<button
				type="button"
				onClick={onToggleEyes}
				data-testid="eyes-toggle"
				className="self-start rounded border border-[var(--hex-line)] px-4 py-2 font-mono text-xs"
			>
				{eyes ? "Show measured phone position" : "Show estimated eye position"}
			</button>

			<p className="text-xs leading-relaxed text-[var(--hex-dim)]">
				We measure the camera, not your body. Eye position is estimated 40 cm behind and 25 cm above
				the phone.
			</p>

			<PlanView viewers={viewers} ghosts={ghosts} meId={meId} />

			{detached && (
				<p className="rounded border border-[var(--hex-warn)]/40 px-4 py-3 text-xs text-[var(--hex-warn)]">
					The display was offline, so distance in metres uses the size stored in the QR code. Angles
					do not depend on that size.
				</p>
			)}

			{!screenshot && (
				<button
					type="button"
					onClick={onScreenshot}
					className="self-start font-mono text-xs text-[var(--hex-accent)] underline"
				>
					Create a share card
				</button>
			)}
			{screenshot && (
				<p className="rounded border border-[var(--hex-line)] px-4 py-3 text-xs text-[var(--hex-muted)]">
					The share card includes the diagram, not your photo.
					<br />
					<a
						className="text-[var(--hex-accent)] underline"
						href={`/og/${location.pathname.split("/").pop()}.svg`}
					>
						Open share card
					</a>
				</p>
			)}

			<a className="font-mono text-xs text-[var(--hex-accent)] underline" href="/how-it-works">
				How this was calculated →
			</a>
		</section>
	);
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
	return (
		<div className="flex flex-col gap-1 rounded border border-[var(--hex-line)] px-3 py-2.5">
			<dt className="text-[10px] tracking-widest text-[var(--hex-dim)] uppercase">{label}</dt>
			<dd className="tabular text-base text-[var(--hex-text)]">{value}</dd>
			<dd className="text-[10px] text-[var(--hex-dim)]">{note}</dd>
		</div>
	);
}

/**
 * The persistent readout.
 *
 * Simultaneously the trust artefact, the debug HUD and the thing the end-to-end
 * tests assert on. That last role is why it will not rot.
 */
function Readout({
	stage,
	aim,
	solved,
	camera,
	detached,
	zoom,
}: {
	stage: Stage;
	aim: AimResult | null;
	solved: SolveResult | null;
	camera: { width: number; height: number } | null;
	detached: boolean;
	zoom: ZoomState;
}) {
	const debug = new URLSearchParams(window.location.search).has("debug");
	if (!debug) return null;
	if (!["aiming", "capturing", "solving", "result", "ambiguous"].includes(stage)) return null;

	const parts = [
		camera ? `camera ${camera.width}×${camera.height}` : null,
		// The prior's width is worth showing beside the factor: on the lens path
		// it is the number that says how much of this answer came from the
		// photograph and how much from a guess about which glass is in front.
		zoom.factor === 1 ? null : `zoom ${zoom.factor.toFixed(1)}× ±${zoom.focalSigmaLog.toFixed(2)}`,
		aim?.found ? `code ${aim.pxPerModule.toFixed(1)} px/module` : null,
		solved ? `${solved.pointCount} reference points` : null,
		solved ? `model fit ${solved.rmsPx.toFixed(2)} px` : null,
		detached ? "display offline" : "display connected",
	].filter(Boolean);

	return (
		<p
			className="pointer-events-none fixed inset-x-0 bottom-0 z-[80] bg-black/55 px-3 py-1.5 text-center font-mono text-[11px] text-white/70 backdrop-blur"
			data-testid="readout"
			data-stage={stage}
		>
			{parts.join(" · ")}
		</p>
	);
}

function copyLink(): void {
	void navigator.clipboard?.writeText(window.location.href).catch(() => {});
}

function friendlyCaptureFailure(detail?: string): string {
	if (!detail) return "Keep the whole code in frame and hold the phone still.";
	if (/correspondence|hidden|blur/i.test(detail)) {
		return "The code was hidden or blurred. Keep it in frame, hold still, and try again.";
	}
	if (/px\/module|outside|distance|small/i.test(detail)) {
		return "The code was too small in the capture. Move closer and try again.";
	}
	if (/behind|reflection|mirrored/i.test(detail)) {
		return "This may be a reflection. Point the camera at the display itself.";
	}
	return "The geometry was not reliable enough. Hold still and try again.";
}

function intentUrl(): string {
	const url = window.location.href.replace(/^https?:\/\//, "");
	return `intent://${url}#Intent;scheme=https;package=com.android.chrome;end`;
}
