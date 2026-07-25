import type { Ghost, Viewer } from "@core/api.ts";
import type { MarkerLayout } from "@core/marker.ts";
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
			focalPx: focalPxFor(width),
			focalSigmaLog: 0.15,
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
			setFailure(outcome.reasons[0] ?? "nothing usable in that capture");
			setStage("aiming");
			return;
		}
		setSolved(outcome.chosen);

		if (!outcome.chosen.ok) {
			setStage(outcome.chosen.reason?.code === "ambiguous" ? "ambiguous" : "aiming");
			setFailure(outcome.chosen.reason?.detail ?? null);
			return;
		}

		setStage("result");
	}, [token, activeLayout, reduced, stopAiming]);

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
		void api.pose(token, me.current, pose, { ambiguous: solved.branchMargin < 3 }).catch(() => {});
		void refresh().catch(() => {});

		// Every solid solve converges a focal length. Aggregated by device
		// signature that becomes a real per-model prior, which is the larger of
		// the two accuracy levers the commons has.
		if (solved.tier === "solid" && cameraInfo.current?.width) {
			void api
				.contributeCalibration({
					signature: deviceSignature(),
					focalOverWidth: solved.primary.focalPx / cameraInfo.current.width,
				})
				.catch(() => {});
		}
	}, [stage, solved, activeLayout, token, layout, spec, refresh]);

	// Hard blocks, checked before anything else is offered.
	if (!spec)
		return (
			<Shell>
				<Fatal title="That link is not a display we know about." />
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
					detached={detached}
					onCapture={onCapture}
					video={videoRef.current}
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

			{stage === "blocked" && <BlockedByApp inApp={inApp} onCopy={() => copyLink()} />}

			{stage === "no-camera" && displayContext && (
				<NoCamera
					token={token}
					clientId={me.current}
					ghosts={ghosts}
					reason={failure}
					displayHeight={activeLayout?.viewportCssPx.h ?? 1080}
				/>
			)}

			{stage === "result" && solved?.primary && displayContext && (
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
				/>
			)}

			<Readout
				stage={stage}
				aim={aim}
				solved={solved}
				camera={cameraInfo.current}
				detached={detached}
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
				start again
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
				<h1 className="text-2xl leading-snug font-medium">
					You just scanned a square. We know exactly how wide it is.
				</h1>
				<p className="text-sm leading-relaxed text-[var(--hex-muted)]">
					Take one photograph of it and we can work out where you are standing, from the shape it
					makes in the picture.
				</p>
			</div>

			<ul className="flex flex-col gap-2 font-mono text-xs text-[var(--hex-dim)]">
				<li>One photograph.</li>
				<li>Decoded on this phone.</li>
				<li>Four numbers sent, and you&apos;ll see them first.</li>
			</ul>

			{detached && (
				<p className="rounded border border-[var(--hex-warn)]/40 px-4 py-3 text-xs text-[var(--hex-warn)]">
					The screen you scanned isn&apos;t connected, so we&apos;ll work from the small code. That
					shortens the useful range, and the error bar will show it.
				</p>
			)}

			{inApp.kind !== "none" && (
				<p className="rounded border border-[var(--hex-warn)]/40 px-4 py-3 text-xs text-[var(--hex-warn)]">
					You&apos;re inside {inApp.app}&apos;s built-in browser, which often refuses camera access
					without asking. If it does, we&apos;ll show you how to get out.
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
					I&apos;d rather not use my camera
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
				Your phone is about to ask for the camera.
			</h2>
			<p className="text-sm leading-relaxed text-[var(--hex-muted)]">
				Frames are read on this device. Nothing is uploaded, and the camera is switched off the
				instant the photograph is taken — you&apos;ll see the indicator go out.
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
				place myself on a plan instead
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
			<p className="text-2xl font-medium">Look up at the screen.</p>
			<p className="font-mono text-xs text-[var(--hex-dim)]">
				{detached ? "working from the small code" : "it is making itself bigger for you"}
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
	detached,
	onCapture,
	video,
}: {
	aim: AimResult | null;
	stage: Stage;
	progress: number;
	failure: string | null;
	detached: boolean;
	onCapture: () => void;
	video: HTMLVideoElement | null;
}) {
	const size = video ? { w: video.videoWidth, h: video.videoHeight } : { w: 1, h: 1 };
	const gauge = gaugeMessage(aim, detached);
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
					{stage === "capturing" ? `holding still… ${Math.round(progress * 100)}%` : gauge.text}
				</p>
			</div>

			<div className="flex flex-col items-center gap-4 pb-10">
				{failure && (
					<p className="mx-6 rounded bg-black/70 px-4 py-2 text-center font-mono text-xs text-[var(--hex-warn)]">
						{failure}
					</p>
				)}
				<button
					type="button"
					onClick={onCapture}
					disabled={!canCapture}
					data-testid="capture"
					className="h-20 w-20 rounded-full border-4 border-white bg-white/25 backdrop-blur transition disabled:opacity-30"
					aria-label="Take the photograph"
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
 */
function gaugeMessage(aim: AimResult | null, detached: boolean): { text: string; ready: boolean } {
	if (!aim?.found) return { text: "point at the screen", ready: false };
	if (aim.touchesBorder)
		return { text: "the code runs off the edge — step back a little", ready: false };
	if (aim.pxPerModule < 3.5) return { text: "too far away to read it properly", ready: false };
	if (aim.pxPerModule < 6) {
		return { text: detached ? "closer would help" : "closer would help", ready: true };
	}
	return { text: "hold still", ready: true };
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
						<title>The reprojected model square, drawn over the photograph it came from</title>
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
				camera off · solving from the frozen frame
			</p>
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
			<h2 className="text-xl leading-snug font-medium">Two answers fit this photograph.</h2>
			<PlanView viewers={[]} ambiguousPair={{ az, dh }} showLegend={false} />
			<p className="text-sm leading-relaxed text-[var(--hex-muted)]">
				One on each side of the screen, and the picture honestly can&apos;t tell them apart. That is
				a known property of measuring a flat square from one viewpoint, not a bug we can fix from
				here.
			</p>
			<p className="text-sm text-[var(--hex-text)]">
				Take one step <strong>to your right</strong> and photograph it again. A step in a known
				direction breaks the tie outright — stepping either way would not, because flipping both
				photographs flips the step with them.
			</p>
			<button
				type="button"
				onClick={onRetry}
				className="rounded bg-[var(--hex-accent)] px-5 py-3 font-mono text-sm text-black"
			>
				I&apos;ve stepped right — go again
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
				That was the app, not your phone&apos;s settings, so checking your privacy settings
				won&apos;t help. Open this link in your normal browser instead.
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
				Copy the link
			</button>
			<p className="font-mono text-[11px] text-[var(--hex-dim)]">
				We deliberately do not bounce you through a Shortcut to work around this. Sending a
				security-conscious person through a fake shortcut is the opposite of the point.
			</p>
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
				Your browser is protecting you in a way that breaks this.
			</h2>
			<p className="text-sm leading-relaxed text-[var(--hex-muted)]">
				Brave and some privacy extensions add tiny random changes to any image read back from a
				canvas, to stop fingerprinting. It&apos;s good protection, and this demo reads camera frames
				exactly that way, so its measurement would be quietly wrong rather than obviously broken.
			</p>
			<p className="text-sm text-[var(--hex-muted)]">
				We&apos;d rather tell you than show you a confident wrong answer.
			</p>
			<button
				type="button"
				onClick={onContinue}
				className="rounded bg-[var(--hex-accent)] px-5 py-3 font-mono text-sm text-black"
			>
				Place myself on a plan instead
			</button>
		</section>
	);
}

/** 6.6: a real route, not an apology. Also the accessibility path. */
function NoCamera({
	token,
	clientId: id,
	ghosts,
	reason,
	displayHeight,
}: {
	token: string;
	clientId: string;
	ghosts: readonly Ghost[];
	reason: string | null;
	displayHeight: number;
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
				{reason === "no-camera-api"
					? "This browser doesn't offer a camera API at all, so there is nothing to ask for. "
					: reason === "denied"
						? "No camera, no problem — "
						: ""}
				Drag the two sliders until the dot is roughly where you are. You&apos;ll join the same room
				and the same scene as everybody who used their camera.
			</p>

			<PlanView viewers={[viewer]} ghosts={ghosts} meId={id} />

			<label className="flex flex-col gap-2 font-mono text-xs text-[var(--hex-dim)]">
				angle: {formatSigned(az)}° {az < -2 ? "left" : az > 2 ? "right" : "centre"}
				<input
					type="range"
					min={-70}
					max={70}
					value={az}
					onChange={(e) => setAz(Number(e.target.value))}
					className="accent-[var(--hex-accent)]"
					aria-label="angle from the centre of the screen"
				/>
			</label>
			<label className="flex flex-col gap-2 font-mono text-xs text-[var(--hex-dim)]">
				distance: {dh.toFixed(1)} screen-heights
				<input
					type="range"
					min={0.5}
					max={12}
					step={0.1}
					value={dh}
					onChange={(e) => setDh(Number(e.target.value))}
					className="accent-[var(--hex-accent)]"
					aria-label="distance in screen heights"
				/>
			</label>

			<button
				type="button"
				disabled={sent}
				onClick={() => {
					setSent(true);
					void api
						.pose(token, id, { az, el: 0, dh, sd: 0.25 }, { contribute: false })
						.catch(() => {});
				}}
				className="rounded bg-[var(--hex-accent)] px-5 py-3 font-mono text-sm text-black disabled:opacity-40"
			>
				{sent ? "you're in the room" : "That's where I am"}
			</button>
			<p className="font-mono text-[11px] text-[var(--hex-dim)]">
				placed by hand · not counted in the measurements · display height{" "}
				{Math.round(displayHeight)}px
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
}) {
	const branch = solved.primary as SerialBranch;
	const r = makeReadout(branch, display);
	const displayHeightM =
		display.edgeToScreenHeight > 0
			? display.symbolEdgeMm / 1000 / display.edgeToScreenHeight
			: display.symbolEdgeMm / 1000;

	return (
		<section className="flex flex-col gap-7 pb-16" data-testid="stage-result">
			<div className="h-[52vh] min-h-64 overflow-hidden rounded border border-[var(--hex-line)]">
				<Suspense
					fallback={
						<div className="flex h-full items-center justify-center font-mono text-xs text-[var(--hex-dim)]">
							building the room…
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

			<div className="flex flex-col gap-2">
				<h2 className="text-xl leading-snug font-medium" data-testid="verdict">
					You were {describe(r)}.
				</h2>
				<p className="font-mono text-xs text-[var(--hex-dim)]">
					{solved.tier === "solid" ? "solid" : "soft — the ellipse is wider for a reason"} ·{" "}
					{solved.pointCount} corners · {solved.bracketCount} brackets
				</p>
			</div>

			<dl className="grid grid-cols-2 gap-4 font-mono text-xs">
				<Stat
					label="bearing"
					value={`${formatSigned(r.azimuthDeg, 1)}°`}
					note={`± ${r.azimuthSigmaDeg.toFixed(1)}° · ${r.side}`}
				/>
				<Stat
					label="elevation"
					value={`${formatSigned(r.elevationDeg, 1)}°`}
					note={`± ${r.elevationSigmaDeg.toFixed(1)}°`}
				/>
				<Stat
					label="distance"
					value={`${(eyes ? r.eyes.screenHeights : r.screenHeights).toFixed(2)} h`}
					note={`± ${r.screenHeightsSigma.toFixed(2)} ${r.dimensionlessUnit} · exact, no physical units`}
				/>
				<Stat
					label="in metres"
					value={`${(eyes ? r.eyes.metres : r.metres).toFixed(2)} m`}
					note={`± ${r.metresSigma.toFixed(2)} · needs two guesses`}
				/>
			</dl>

			<button
				type="button"
				onClick={onToggleEyes}
				data-testid="eyes-toggle"
				className="self-start rounded border border-[var(--hex-line)] px-4 py-2 font-mono text-xs"
			>
				showing: {eyes ? "your eyes (estimated)" : "your phone (measured)"} — switch
			</button>

			<p className="text-xs leading-relaxed text-[var(--hex-dim)]">
				We measured the camera. Your eyes are roughly 40 cm behind it and 25 cm above it, which at
				this distance is a bigger correction than everything else on this page put together.
			</p>

			<PlanView viewers={viewers} ghosts={ghosts} meId={meId} />

			{detached && (
				<p className="rounded border border-[var(--hex-warn)]/40 px-4 py-3 text-xs text-[var(--hex-warn)]">
					No display was connected, so this used the code&apos;s declared size. Angles are
					unaffected by that — they are unaffected by size errors of any magnitude — but the metric
					distance leans on it.
				</p>
			)}

			{!screenshot && (
				<button
					type="button"
					onClick={onScreenshot}
					className="self-start font-mono text-xs text-[var(--hex-accent)] underline"
				>
					share this
				</button>
			)}
			{screenshot && (
				<p className="rounded border border-[var(--hex-line)] px-4 py-3 text-xs text-[var(--hex-muted)]">
					Sharing uploads the diagram above so it shows as a preview when you post it. It does not
					upload your photograph.
					<br />
					<a
						className="text-[var(--hex-accent)] underline"
						href={`/og/${location.pathname.split("/").pop()}.svg`}
					>
						open the card
					</a>
				</p>
			)}

			<a className="font-mono text-xs text-[var(--hex-accent)] underline" href="/how-it-works">
				how this was calculated →
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
}: {
	stage: Stage;
	aim: AimResult | null;
	solved: SolveResult | null;
	camera: { width: number; height: number } | null;
	detached: boolean;
}) {
	const parts = [
		camera ? `${camera.width}×${camera.height}` : "no camera",
		aim?.found ? `${aim.pxPerModule.toFixed(1)} px/mod` : "no symbol",
		solved ? `${solved.pointCount} pts` : null,
		solved ? `rms ${solved.rmsPx.toFixed(2)}px` : null,
		solved?.primary ? `f ${solved.primary.focalPx.toFixed(0)}` : null,
		solved
			? `margin ${Number.isFinite(solved.branchMargin) ? solved.branchMargin.toFixed(1) : "∞"}`
			: null,
		detached ? "detached" : "linked",
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

function intentUrl(): string {
	const url = window.location.href.replace(/^https?:\/\//, "");
	return `intent://${url}#Intent;scheme=https;package=com.android.chrome;end`;
}
