import type { Ghost } from "@core/api.ts";
import type { MarkerLayout } from "@core/marker.ts";
import { estimateRange, focalPxFromEquiv, moduleCountForVersion } from "@core/marker.ts";
import { destinationHost } from "@core/redirect.ts";
import { mintToken, payloadForToken, versionForPayload } from "@core/token.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { navigate } from "../App.tsx";
import { Marker } from "../components/Marker.tsx";
import { PlanView } from "../components/PlanView.tsx";
import { api } from "../lib/api.ts";
import { clientId, loadCalibration, rememberRoom, setTabRoom, tabRoom } from "../lib/identity.ts";
import { useSession } from "../lib/session.ts";
import { DEFAULT_MM_PER_CSS_PX } from "../lib/units.ts";
import { useHandheld } from "../lib/viewport.ts";

type Beat = "idle" | "connected" | "swapped" | "captured" | "revealed";

/** How long the screen stays full-bleed with nobody having pressed the shutter. */
const AIM_TIMEOUT_MS = 120_000;
/** And how long it waits for a result after one has. */
const SOLVE_TIMEOUT_MS = 20_000;

/**
 * The display page, which stops being a page and becomes the instrument.
 *
 * The measurement *is* the visitor's position, so we cannot ask them to move
 * without corrupting the very thing being measured. The only legitimate way to
 * improve the geometry is to move the screen instead -- which is what the swap
 * is. It looks like choreography and it is choreography, but it is load-bearing
 * choreography: full-bleed plus corner brackets is roughly a four-fold
 * improvement in the conditioning of the azimuth estimate.
 */
export function Display({ token: routeToken }: { token: string | null }) {
	// Reuse this tab's room across reloads; mint one only if the tab has none.
	const [token, setToken] = useState(
		() => routeToken ?? tabRoom() ?? persistNewRoom(mintEphemeralToken()),
	);
	const [beat, setBeat] = useState<Beat>("idle");
	const [layout, setLayout] = useState<MarkerLayout | null>(null);
	const [ghosts, setGhosts] = useState<readonly Ghost[]>([]);
	const [ghostTotal, setGhostTotal] = useState(0);
	const [flash, setFlash] = useState(0);
	const [showAnyway, setShowAnyway] = useState(false);
	const me = useRef(clientId());
	const nonce = useRef(mintNonce());
	const beatTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

	const { room, connection, lastEvent } = useSession(token);
	const handheld = useHandheld();

	const mmPerCssPx = loadCalibration()?.mmPerCssPx ?? DEFAULT_MM_PER_CSS_PX;
	const origin = typeof window === "undefined" ? "" : window.location.origin;
	const payload = useMemo(() => payloadForToken(origin, token), [origin, token]);
	const url = `${origin}/s/${token}`;
	const displayUrl = `${origin}/d/${token}`;

	useEffect(() => {
		if (routeToken) return;
		rememberRoom({ token, label: null, at: Date.now() });
	}, [routeToken, token]);

	/**
	 * Claim the room, hold the claim, and step aside if somebody else has it.
	 *
	 * The heartbeat is what keeps the claim alive; without it a display that sat
	 * quietly for a few minutes would look abandoned and could be taken over by a
	 * colliding token. It runs only while the tab is visible, because an invisible
	 * tab is not a screen anyone is looking at.
	 */
	useEffect(() => {
		if (routeToken) {
			void api.hello(token, "display", me.current).catch(() => {});
			return;
		}

		let cancelled = false;
		const beat = async () => {
			if (cancelled || document.visibilityState !== "visible") return;
			try {
				const response = await api.hello(token, "display", me.current);
				if (!cancelled && response.collision) {
					// Two visitors' random tokens collided. Take a new one rather than
					// share a screen with a stranger's phone.
					setToken(persistNewRoom(mintEphemeralToken()));
				}
			} catch {
				// Offline or rate-limited; the next beat will retry.
			}
		};

		void beat();
		const timer = setInterval(beat, 60_000);
		document.addEventListener("visibilitychange", beat);
		return () => {
			cancelled = true;
			clearInterval(timer);
			document.removeEventListener("visibilitychange", beat);
		};
	}, [token, routeToken]);

	useEffect(() => {
		void api
			.ghosts(500)
			.then((g) => {
				setGhosts(g.ghosts);
				setGhostTotal(g.total);
			})
			.catch(() => {});
	}, []);

	/**
	 * Publishing the layout is what lets the phone stop guessing.
	 *
	 * Guarded against republishing an identical layout: this call feeds a state
	 * update that re-renders the marker, so without the guard a single unstable
	 * dependency anywhere downstream becomes an unbounded POST loop against the
	 * write rate limiter.
	 */
	const lastPublished = useRef<string>("");
	const publishLayout = useCallback(
		(next: MarkerLayout) => {
			const key = JSON.stringify(next);
			if (key === lastPublished.current) return;
			lastPublished.current = key;
			setLayout(next);
			void api.layout(token, me.current, next).catch(() => {});
		},
		[token],
	);

	/**
	 * The display's screen must not sleep while somebody reads the explainer and
	 * then walks across the room to scan it.
	 */
	useEffect(() => {
		let sentinel: { release: () => Promise<void> } | null = null;
		const request = async () => {
			try {
				sentinel =
					(await (
						navigator as unknown as {
							wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
						}
					).wakeLock?.request("screen")) ?? null;
			} catch {
				// Denied or unsupported; the demo still works, the screen may dim.
			}
		};
		void request();
		const onVisible = () => {
			if (document.visibilityState === "visible") void request();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			document.removeEventListener("visibilitychange", onVisible);
			void sentinel?.release().catch(() => {});
		};
	}, []);

	// The five beats.
	useEffect(() => {
		if (!lastEvent) return;
		const schedule = (fn: () => void, ms: number) => {
			beatTimers.current.push(setTimeout(fn, ms));
		};
		switch (lastEvent.type) {
			case "phone-connected":
				setBeat("connected");
				break;
			case "phone-armed":
				// Beat 2: the swap. Everything else fades, the marker goes full-bleed,
				// and four brackets snap to the display's true corners.
				setFlash(0);
				setBeat("swapped");
				break;
			case "capturing":
				setFlash((n) => n + 1);
				schedule(() => setBeat("captured"), 120);
				break;
			case "pose":
				setBeat("revealed");
				// Beat 5: ease back to idle so the next person finds a page, not a
				// half-finished animation.
				schedule(() => setBeat("idle"), 12_000);
				break;
			default:
				break;
		}
	}, [lastEvent]);

	/**
	 * The swap is not allowed to strand the screen.
	 *
	 * Full bleed is entered on a phone's say-so and left on the pose that follows
	 * it -- and a pose is precisely what does not arrive when the solver refuses,
	 * when the phone is closed mid-aim, or when the connection drops between the
	 * two. Each of those leaves a white rectangle with no way out short of a
	 * reload, on the one screen in the room everybody is looking at. So the exit
	 * is timed as well as evented: generous while somebody is still walking back
	 * and aiming, short once the shutter has gone, because by then the answer is
	 * a few seconds away or it is not coming at all.
	 */
	useEffect(() => {
		if (beat !== "swapped" && beat !== "captured") return;
		// The shutter count decides which clock runs, rather than the beat. It is
		// reset when the swap begins, so `flash > 0` means precisely "a photograph
		// has been taken during *this* measurement" -- which also restarts the
		// wait when somebody captures a second time after a refusal, instead of
		// leaving them the remainder of the first attempt's.
		const timer = setTimeout(() => setBeat("idle"), flash > 0 ? SOLVE_TIMEOUT_MS : AIM_TIMEOUT_MS);
		return () => clearTimeout(timer);
	}, [beat, flash]);

	useEffect(
		() => () => {
			for (const timer of beatTimers.current) clearTimeout(timer);
		},
		[],
	);

	// A phone showing a code for a phone to scan is a closed loop with nobody in
	// it. The escape hatch matters though: a tablet on a stand is a real display.
	const dimmed = handheld && !showAnyway;

	const viewers = room?.viewers ?? [];
	const version = versionForPayload(payload);
	const moduleCount = moduleCountForVersion(version);
	const range = layout
		? estimateRange({
				focalPx: focalPxFromEquiv(1920),
				moduleCount,
				pxPerModuleGate: 6,
				symbolEdgeMm: layout.symbolEdgeMm,
				symbolEdgeCssPx: layout.symbolEdgeCssPx,
				displayHeightCssPx: layout.viewportCssPx.h,
			})
		: null;

	if (beat === "swapped" || beat === "captured") {
		return (
			<>
				<Marker
					text={payload}
					mode="fullbleed"
					mmPerCssPx={mmPerCssPx}
					nonce={nonce.current}
					onLayout={publishLayout}
				/>
				<div className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] text-center font-mono text-[11px] tracking-wide text-black/55">
					SPATIAL QR · {layout ? Math.round(layout.symbolEdgeMm) : "—"} mm · hold still
				</div>
				{flash > 0 && (
					<div
						key={flash}
						className="sqr-flash pointer-events-none fixed inset-0 z-[70] bg-white"
						data-testid="shutter-flash"
					/>
				)}
			</>
		);
	}

	return (
		<main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-10 px-6 py-10">
			<header className="flex flex-col items-center gap-5 text-center">
				<h1 className="max-w-xl text-balance text-2xl leading-snug font-medium sm:text-3xl">
					Scan this code. The screen will show where your phone was.
				</h1>
				<p className="max-w-lg text-sm leading-relaxed text-[var(--hex-muted)]">
					The code&apos;s shape in your camera reveals its angle and distance. No depth sensor, AR
					session or login.
				</p>

				<div className="relative" data-testid="marker-slot">
					<div
						className={
							dimmed
								? "pointer-events-none opacity-25 blur-[3px] grayscale transition duration-500"
								: "transition duration-500"
						}
						data-testid={dimmed ? "marker-dimmed" : "marker-live"}
						aria-hidden={dimmed}
					>
						<Marker
							text={payload}
							mode="idle"
							mmPerCssPx={mmPerCssPx}
							nonce={nonce.current}
							onLayout={publishLayout}
						/>
					</div>

					{/*
					 * This page is the thing you point a camera at. On the phone that
					 * would be doing the pointing, the code is not just useless -- it is
					 * actively confusing, because it invites a scan that cannot work.
					 * Blur it rather than remove it: it still has to be recognisable as
					 * the subject of the sentence above.
					 */}
					{dimmed && (
						<div
							className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4"
							data-testid="handheld-notice"
						>
							<p className="max-w-[15rem] text-sm leading-snug text-[var(--hex-text)]">
								Open this display on a larger screen.
							</p>
							<p className="max-w-[16rem] text-xs leading-relaxed text-[var(--hex-muted)]">
								Then use this phone to scan it.
							</p>
							<button
								type="button"
								onClick={() => setShowAnyway(true)}
								className="rounded border border-[var(--hex-line)] bg-[var(--hex-void)]/80 px-3 py-1.5 font-mono text-[11px] text-[var(--hex-muted)] backdrop-blur"
							>
								Use this device as the display
							</button>
						</div>
					)}

					{beat === "connected" && !dimmed && (
						<div className="pointer-events-none absolute inset-0 overflow-hidden">
							<div className="sqr-pulse h-px w-full bg-[var(--hex-accent)]" />
						</div>
					)}
				</div>

				<p className="font-mono text-xs text-[var(--hex-dim)]">
					{dimmed ? "Open on the larger screen:" : "Can't scan? Open this on your phone:"}{" "}
					<span className="text-[var(--hex-muted)]" data-testid="scan-url">
						{(dimmed ? displayUrl : url).replace(/^https?:\/\//, "")}
					</span>
				</p>
				{dimmed ? (
					<button
						type="button"
						onClick={() => {
							void navigator.clipboard?.writeText(displayUrl).catch(() => {});
						}}
						className="rounded border border-[var(--hex-line)] px-4 py-2 font-mono text-xs"
					>
						Copy address
					</button>
				) : (
					<p className="max-w-md text-xs text-[var(--hex-dim)]">
						Scan from where you want the phone&apos;s position measured.
					</p>
				)}
			</header>

			<LiveStrip
				beat={beat}
				connection={connection}
				viewerCount={viewers.length}
				ghostTotal={ghostTotal}
			/>

			{viewers.length > 0 && (
				<section className="sqr-fade-up rounded-lg border border-[var(--hex-line)] bg-[var(--hex-surface)]/40 p-4">
					<PlanView viewers={viewers} ghosts={ghosts} />
				</section>
			)}

			{room?.redirect && (
				<p
					className="rounded border border-[var(--hex-line)] px-4 py-3 font-mono text-xs text-[var(--hex-dim)]"
					data-testid="redirect-notice"
				>
					Solved scans continue to{" "}
					<span className="text-[var(--hex-muted)]">{destinationHost(room.redirect)}</span> with the
					measured position on the URL.
				</p>
			)}

			<Explainer range={range} />

			<footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--hex-line)] pt-5 text-xs text-[var(--hex-dim)]">
				<button
					type="button"
					onClick={() => navigate("/create")}
					className="rounded border border-[var(--hex-line)] px-3 py-2 font-mono text-[var(--hex-text)] transition hover:border-[var(--hex-accent)]"
				>
					Make one for another screen →
				</button>
				<a className="font-mono underline hover:text-[var(--hex-muted)]" href="/how-it-works">
					How it works
				</a>
			</footer>
		</main>
	);
}

function LiveStrip({
	beat,
	connection,
	viewerCount,
	ghostTotal,
}: {
	beat: Beat;
	connection: string;
	viewerCount: number;
	ghostTotal: number;
}) {
	const message =
		beat === "connected"
			? "Phone connected."
			: beat === "revealed"
				? "Solved. The dot marks the camera."
				: viewerCount > 0
					? `${viewerCount} ${viewerCount === 1 ? "camera" : "cameras"} measured on this display.`
					: "No scans yet.";

	return (
		<div
			className="flex items-center justify-between gap-4 rounded border border-[var(--hex-line)] px-4 py-3 font-mono text-xs"
			data-testid="live-strip"
			data-beat={beat}
		>
			<span className="text-[var(--hex-text)]">{message}</span>
			<span className="text-[var(--hex-dim)]">
				{/* Stated truthfully, including on day zero when it reads in single digits. */}
				{ghostTotal.toLocaleString()} past scans ·{" "}
				<span data-testid="connection-state">{connectionLabel(connection)}</span>
			</span>
		</div>
	);
}

function connectionLabel(connection: string): string {
	if (connection === "offline") return "offline";
	if (connection === "connecting") return "connecting";
	return "live";
}

function Explainer({
	range,
}: {
	range: { maxDistanceM: number; maxDistanceScreenHeights: number } | null;
}) {
	return (
		<section className="flex flex-col gap-5 text-sm leading-relaxed text-[var(--hex-muted)]">
			<h2 className="font-mono text-xs tracking-widest text-[var(--hex-dim)] uppercase">
				How the scan works
			</h2>

			{range && (
				<p
					className="rounded border border-[var(--hex-line)] px-4 py-3 font-mono text-xs text-[var(--hex-dim)]"
					data-testid="range-line"
				>
					<span className="text-[var(--hex-text)]">Estimated reliable range</span> ·{" "}
					{range.maxDistanceM.toFixed(1)} m, or {range.maxDistanceScreenHeights.toFixed(1)} display
					heights · assumes a 1920 px capture
				</p>
			)}

			<div className="grid gap-4 sm:grid-cols-3">
				<ExplainerStep number="1" title="Declared size">
					This display reports the code&apos;s measured or estimated on-screen size.
				</ExplainerStep>
				<ExplainerStep number="2" title="Short capture">
					The screen enlarges the code. Your phone rejects moving frames and chooses a stable one.
				</ExplainerStep>
				<ExplainerStep number="3" title="Camera position">
					Perspective gives two angles and distance. The screen plots the result.
				</ExplainerStep>
			</div>

			<p className="rounded border border-[var(--hex-line)] px-4 py-3">
				<strong className="text-[var(--hex-text)]">The image stays on your phone.</strong> The
				position and its uncertainty are sent. Solid results may also contribute coarse device data
				and a focal estimate to pooled calibration. The camera switches off before the result
				appears.
			</p>

			<p>
				Direction is usually within 1–3°. Distance in display heights needs no physical-size guess;
				metres do, so they come with an error bar. The dot marks the phone camera, with an optional
				estimate for your eyes.
			</p>
		</section>
	);
}

function ExplainerStep({
	number,
	title,
	children,
}: {
	number: string;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<div className="rounded border border-[var(--hex-line)] px-4 py-3">
			<p className="mb-1 font-mono text-[11px] text-[var(--hex-accent)]">{number}</p>
			<h3 className="mb-1 text-sm font-medium text-[var(--hex-text)]">{title}</h3>
			<p className="text-xs leading-relaxed">{children}</p>
		</div>
	);
}

function mintEphemeralToken(): string {
	const height = typeof window === "undefined" ? 1080 : window.innerHeight;
	const width = typeof window === "undefined" ? 1920 : window.innerWidth;
	const mmPerCssPx = loadCalibration()?.mmPerCssPx ?? DEFAULT_MM_PER_CSS_PX;
	// The idle marker's symbol edge: 34% of the viewport height for the box, less
	// the four-module quiet zone on each side.
	const boxCss = height * 0.34;
	const edgeCss = boxCss * (25 / 33);
	const edgeMm = Math.min(6000, Math.max(5, edgeCss * mmPerCssPx));
	const divisor = gcd(width, height) || 1;
	return mintToken({
		markerEdgeMm: edgeMm,
		aspectNum: clampByte(width / divisor),
		aspectDen: clampByte(height / divisor),
		surface: "monitor",
		// So that "distance in display heights" still works for anyone who scans
		// this code with no display connected.
		edgeToScreenHeight: edgeCss / height,
	});
}

function persistNewRoom(token: string): string {
	setTabRoom(token);
	return token;
}

function clampByte(v: number): number {
	return Math.min(255, Math.max(1, Math.round(v)));
}

function gcd(a: number, b: number): number {
	return b === 0 ? a : gcd(b, a % b);
}

/**
 * A rotating value baked into the rendered marker.
 *
 * Somebody will screenshot this page and post it, and somebody else will scan
 * the screenshot. A screenshot carries a stale nonce deterministically, which is
 * how the phone knows to say "you are scanning a screenshot, nice" and offer the
 * real thing rather than announcing that they were standing 24 metres away.
 */
function mintNonce(): string {
	const bytes = new Uint8Array(3);
	crypto.getRandomValues(bytes);
	return [...bytes]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
		.toUpperCase();
}
