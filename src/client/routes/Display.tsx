import type { Ghost } from "@core/api.ts";
import type { MarkerLayout } from "@core/marker.ts";
import { estimateRange, focalPxFromEquiv, moduleCountForVersion } from "@core/marker.ts";
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
					SPATIAL-QR · {layout ? Math.round(layout.symbolEdgeMm) : "—"} mm · hold still
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
					A QR code that can tell where you were standing when you scanned it.
				</h1>
				<p className="max-w-lg text-sm leading-relaxed text-[var(--hex-muted)]">
					You are looking at a square. We know exactly how wide it is. Point your phone's camera
					back at it, and the shape it makes in your photograph is enough to solve for where you
					were.
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
								This code is meant to be looked <em>at</em>, not looked <em>from</em>.
							</p>
							<p className="max-w-[16rem] text-xs leading-relaxed text-[var(--hex-muted)]">
								Open this page on a laptop, monitor or TV, then scan it from here.
							</p>
							<button
								type="button"
								onClick={() => setShowAnyway(true)}
								className="rounded border border-[var(--hex-line)] bg-[var(--hex-void)]/80 px-3 py-1.5 font-mono text-[11px] text-[var(--hex-muted)] backdrop-blur"
							>
								this device is the screen — show it
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
					{dimmed ? "the address to open on the big screen:" : "or type it in:"}{" "}
					<span className="text-[var(--hex-muted)]" data-testid="scan-url">
						{url.replace(/^https?:\/\//, "")}
					</span>
				</p>
				{dimmed ? (
					<button
						type="button"
						onClick={() => {
							void navigator.clipboard?.writeText(url).catch(() => {});
						}}
						className="rounded border border-[var(--hex-line)] px-4 py-2 font-mono text-xs"
					>
						copy the address
					</button>
				) : (
					<p className="max-w-md text-xs text-[var(--hex-dim)]">
						The code is plain on purpose. Rounded corners and a logo in the middle would cost us a
						degree.
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

			<Explainer range={range} moduleCount={moduleCount} version={version} />

			<footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--hex-line)] pt-5 text-xs text-[var(--hex-dim)]">
				<button
					type="button"
					onClick={() => navigate("/create")}
					className="rounded border border-[var(--hex-line)] px-3 py-2 font-mono text-[var(--hex-text)] transition hover:border-[var(--hex-accent)]"
				>
					Make one for your own screen →
				</button>
				<a className="font-mono underline hover:text-[var(--hex-muted)]" href="/how-it-works">
					how it works, with the maths
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
			? "A phone just connected."
			: beat === "revealed"
				? "Solved. That dot is where the camera was."
				: viewerCount > 0
					? `${viewerCount} ${viewerCount === 1 ? "person is" : "people are"} in this room.`
					: "Nobody is standing here yet.";

	return (
		<div
			className="flex items-center justify-between gap-4 rounded border border-[var(--hex-line)] px-4 py-3 font-mono text-xs"
			data-testid="live-strip"
			data-beat={beat}
		>
			<span className="text-[var(--hex-text)]">{message}</span>
			<span className="text-[var(--hex-dim)]">
				{/* Stated truthfully, including on day zero when it reads in single digits. */}
				{ghostTotal.toLocaleString()} before you ·{" "}
				<span data-testid="connection-state">{connection}</span>
			</span>
		</div>
	);
}

function Explainer({
	range,
	moduleCount,
	version,
}: {
	range: { maxDistanceM: number; maxDistanceScreenHeights: number } | null;
	moduleCount: number;
	version: number;
}) {
	return (
		<section className="flex flex-col gap-5 text-sm leading-relaxed text-[var(--hex-muted)]">
			<h2 className="font-mono text-xs tracking-widest text-[var(--hex-dim)] uppercase">
				What is this?
			</h2>

			<p>
				<strong className="text-[var(--hex-text)]">The geometry.</strong> A square photographed
				straight on looks square. Photographed from the side it looks like a trapezoid, and the
				exact shape of that trapezoid depends on one thing: where the camera was. Solving backwards
				from the shape to the position is a hundred-year-old piece of projective geometry.
			</p>

			<p>
				<strong className="text-[var(--hex-text)]">Why we ask for a second look.</strong> The code
				above only has to be big enough for your camera app to notice. When you tap the button on
				your phone, this screen clears and the code fills it, with brackets in the corners. A bigger
				square is a better measurement — and moving the screen is the only way to improve the
				geometry without moving you, which would change the answer we are trying to find.
			</p>

			<p>
				<strong className="text-[var(--hex-text)]">What leaves your phone.</strong> Four numbers:
				two angles, a distance in screen-heights, and how sure we are. The photograph is decoded and
				solved on your device and never uploaded. You see the four numbers before they are sent, and
				the camera light goes out before anything is drawn.
			</p>

			<p>
				<strong className="text-[var(--hex-text)]">How good is it, honestly.</strong> Angles land
				within a degree or two. Distance comes as a ratio of screen-heights, which is exact because
				it never involves a physical measurement — and then in metres, which needs two guesses (how
				big your screen is, and your camera's focal length) and carries a visible error bar because
				of it. We are also measuring your phone, not your eyes; those are about 40 cm apart, and
				there is a toggle for it.
			</p>

			{range && (
				<p className="rounded border border-[var(--hex-line)] px-4 py-3 font-mono text-xs text-[var(--hex-dim)]">
					this display, this payload: version {version}, {moduleCount} modules · good to about{" "}
					<span className="text-[var(--hex-text)]">
						{range.maxDistanceScreenHeights.toFixed(1)} screen-heights
					</span>{" "}
					({range.maxDistanceM.toFixed(1)} m) at 1920px capture · computed, not remembered
				</p>
			)}
		</section>
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
