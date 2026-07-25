import { mintToken } from "@core/token.ts";
import type { Surface } from "@core/types.ts";
import { useEffect, useMemo, useState } from "react";
import { navigate } from "../App.tsx";
import { api } from "../lib/api.ts";
import { isZoomed, zoomFactor } from "../lib/capabilities.ts";
import { deviceSignature, mintOwnerToken, rememberRoom, saveCalibration } from "../lib/identity.ts";
import { CARD_HEIGHT_MM, CARD_WIDTH_MM, DEFAULT_MM_PER_CSS_PX } from "../lib/units.ts";

const PRESETS: { label: string; diagonalIn: number; surface: Surface }[] = [
	{ label: '13" laptop', diagonalIn: 13.3, surface: "laptop" },
	{ label: '16" laptop', diagonalIn: 16, surface: "laptop" },
	{ label: '24" monitor', diagonalIn: 24, surface: "monitor" },
	{ label: '27" monitor', diagonalIn: 27, surface: "monitor" },
	{ label: '32" monitor', diagonalIn: 32, surface: "monitor" },
	{ label: '55" TV', diagonalIn: 55, surface: "tv" },
	{ label: '65" TV', diagonalIn: 65, surface: "tv" },
	{ label: '100" projector', diagonalIn: 100, surface: "projector" },
];

/**
 * Create your own.
 *
 * The physical size of a display is not available to any web API and never will
 * be, so somebody has to supply it. The bank card is the best available ruler:
 * ISO/IEC 7810 ID-1 is 85.60 x 53.98 mm with under 0.3% manufacturing tolerance,
 * and everybody has one in their pocket. Matching it by eye costs about another
 * percent, which is an order of magnitude better than guessing a diagonal.
 */
export function Create() {
	const [mode, setMode] = useState<"ruler" | "preset">("ruler");
	const [cardWidthCss, setCardWidthCss] = useState(340);
	const [preset, setPreset] = useState(PRESETS[3]!);
	const [label, setLabel] = useState("");
	const [zoomed, setZoomed] = useState(false);
	const [commons, setCommons] = useState<{ median: number; n: number } | null>(null);
	const [acceptedCommons, setAcceptedCommons] = useState(false);

	useEffect(() => {
		const check = () => setZoomed(isZoomed());
		check();
		window.addEventListener("resize", check);
		window.visualViewport?.addEventListener("resize", check);
		return () => {
			window.removeEventListener("resize", check);
			window.visualViewport?.removeEventListener("resize", check);
		};
	}, []);

	/**
	 * The calibration commons, offered as a prefill and never as a truth.
	 *
	 * The same coarse signature can mean genuinely different physical screens --
	 * an external monitor, a scaled resolution -- so it asks rather than
	 * overrides, and it stays quiet entirely until five people have contributed
	 * and their numbers agree, which makes it k-anonymous by construction.
	 */
	useEffect(() => {
		void api
			.calibration(deviceSignature())
			.then((estimate) => {
				if (estimate.mmPerCssPx) {
					setCommons({ median: estimate.mmPerCssPx.median, n: estimate.mmPerCssPx.n });
				}
			})
			.catch(() => {});
	}, []);

	const mmPerCssPx = useMemo(() => {
		if (acceptedCommons && commons) return commons.median;
		if (mode === "ruler") return CARD_WIDTH_MM / Math.max(40, cardWidthCss);
		const w = window.screen.width;
		const h = window.screen.height;
		const diagonalCss = Math.hypot(w, h);
		return (preset.diagonalIn * 25.4) / diagonalCss;
	}, [mode, cardWidthCss, preset, acceptedCommons, commons]);

	const viewportHeight = typeof window === "undefined" ? 1080 : window.innerHeight;
	const screenHeightMm = window.screen.height * mmPerCssPx;
	const measured = mode === "ruler" && !acceptedCommons;

	const onCreate = async () => {
		// The full-bleed marker box is 88% of the viewport height; the symbol edge
		// is 25/33 of that box, because the four-module quiet zone on each side is
		// NOT part of the symbol.
		const boxCss = viewportHeight * 0.88;
		const edgeCss = boxCss * (25 / 33);
		const edgeMm = Math.min(6000, Math.max(5, edgeCss * mmPerCssPx));
		const divisor = gcd(window.innerWidth, window.innerHeight) || 1;
		const surface = mode === "preset" ? preset.surface : "monitor";
		const token = mintToken({
			markerEdgeMm: edgeMm,
			aspectNum: clampByte(window.innerWidth / divisor),
			aspectDen: clampByte(window.innerHeight / divisor),
			surface,
			// Zero for print: there is no display, so distance gets reported in
			// marker widths rather than a screen height nobody has.
			edgeToScreenHeight: surface === "print" ? 0 : edgeCss / viewportHeight,
		});

		saveCalibration({
			mmPerCssPx,
			source: acceptedCommons ? "commons" : measured ? "measured" : "estimated",
			at: Date.now(),
		});
		if (measured) {
			void api.contributeCalibration({ signature: deviceSignature(), mmPerCssPx }).catch(() => {});
		}

		const owner = mintOwnerToken(token);
		await api.claim(token, owner, label.trim() || undefined, false).catch(() => {});
		rememberRoom({ token, label: label.trim() || null, at: Date.now() });
		navigate(`/d/${token}`);
	};

	return (
		<main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-8 px-6 py-10">
			<header className="flex flex-col gap-3">
				<h1 className="text-2xl font-medium">Create a display</h1>
				<p className="text-sm leading-relaxed text-[var(--hex-muted)]">
					Measure the screen so distance can be shown in metres. Its size and shape are stored in
					the QR URL, so the code does not depend on a saved server record.
				</p>
			</header>

			{zoomed && (
				<p
					className="rounded border border-[var(--hex-danger)]/50 bg-[var(--hex-danger)]/10 px-4 py-3 text-sm text-[var(--hex-danger)]"
					data-testid="zoom-guard"
				>
					Reset browser zoom to 100% before measuring. At {Math.round(zoomFactor() * 100)}%, the
					on-screen outline is not its intended physical size.
				</p>
			)}

			{commons && !acceptedCommons && (
				<div
					className="flex flex-col gap-3 rounded border border-[var(--hex-line)] px-4 py-4"
					data-testid="commons-prefill"
				>
					<p className="text-sm text-[var(--hex-muted)]">
						Measurements from{" "}
						<span className="text-[var(--hex-text)]">{commons.n} similar devices</span> suggest this
						screen is about {Math.round(window.screen.height * commons.median)} mm tall.
					</p>
					<div className="flex gap-2">
						<button
							type="button"
							onClick={() => setAcceptedCommons(true)}
							className="rounded bg-[var(--hex-accent)] px-4 py-2 font-mono text-xs text-black"
						>
							Use this estimate
						</button>
						<button
							type="button"
							onClick={() => setCommons(null)}
							className="rounded border border-[var(--hex-line)] px-4 py-2 font-mono text-xs"
						>
							Measure this screen
						</button>
					</div>
				</div>
			)}

			<div className="flex gap-2 font-mono text-xs">
				{(["ruler", "preset"] as const).map((m) => (
					<button
						key={m}
						type="button"
						onClick={() => {
							setMode(m);
							setAcceptedCommons(false);
						}}
						className={`rounded border px-3 py-2 ${
							mode === m
								? "border-[var(--hex-accent)] text-[var(--hex-text)]"
								: "border-[var(--hex-line)] text-[var(--hex-dim)]"
						}`}
					>
						{m === "ruler" ? "Measure with a bank card" : "Choose a screen size"}
					</button>
				))}
			</div>

			{mode === "ruler" ? (
				<section className="flex flex-col gap-4" data-testid="card-ruler">
					<p className="text-sm text-[var(--hex-muted)]">
						Hold a standard bank card flat against the screen. Drag the slider until the outline
						matches it. Standard cards are 85.60 × 53.98 mm.
					</p>
					<div
						className="rounded border border-[var(--hex-accent)] bg-[var(--hex-surface)]"
						style={{
							width: `${cardWidthCss}px`,
							height: `${(cardWidthCss * CARD_HEIGHT_MM) / CARD_WIDTH_MM}px`,
						}}
						aria-hidden="true"
					/>
					<input
						type="range"
						min={120}
						max={900}
						value={cardWidthCss}
						onChange={(e) => setCardWidthCss(Number(e.target.value))}
						className="accent-[var(--hex-accent)]"
						aria-label="Width of the on-screen card outline"
						data-testid="ruler-slider"
					/>
				</section>
			) : (
				<section className="flex flex-wrap gap-2" data-testid="preset-list">
					{PRESETS.map((p) => (
						<button
							key={p.label}
							type="button"
							onClick={() => setPreset(p)}
							className={`rounded border px-3 py-2 font-mono text-xs ${
								preset.label === p.label
									? "border-[var(--hex-accent)] text-[var(--hex-text)]"
									: "border-[var(--hex-line)] text-[var(--hex-dim)]"
							}`}
						>
							{p.label}
						</button>
					))}
				</section>
			)}

			<dl className="grid grid-cols-2 gap-3 font-mono text-xs">
				<div className="rounded border border-[var(--hex-line)] px-3 py-2">
					<dt className="text-[var(--hex-dim)]">Screen scale</dt>
					<dd className="tabular text-[var(--hex-text)]">
						{mmPerCssPx.toFixed(4)} mm per CSS pixel
					</dd>
				</div>
				<div className="rounded border border-[var(--hex-line)] px-3 py-2">
					<dt className="text-[var(--hex-dim)]">Estimated screen height</dt>
					<dd className="tabular text-[var(--hex-text)]">{Math.round(screenHeightMm)} mm tall</dd>
				</div>
			</dl>

			<span
				className={`self-start rounded px-2 py-1 font-mono text-[11px] ${
					measured
						? "bg-[var(--hex-good)]/15 text-[var(--hex-good)]"
						: "bg-[var(--hex-warn)]/15 text-[var(--hex-warn)]"
				}`}
				data-testid="calibration-badge"
			>
				{measured ? "measured" : acceptedCommons ? "based on similar screens" : "estimated"}
			</span>

			<section className="flex flex-col gap-4 border-t border-[var(--hex-line)] pt-6">
				<label className="flex flex-col gap-2 text-sm">
					<span className="text-[var(--hex-muted)]">Name this display (optional)</span>
					<input
						value={label}
						maxLength={24}
						onChange={(e) => setLabel(e.target.value)}
						placeholder="the office wall"
						className="rounded border border-[var(--hex-line)] bg-transparent px-3 py-2 font-mono text-sm outline-none focus:border-[var(--hex-accent)]"
					/>
				</label>
			</section>

			<button
				type="button"
				onClick={onCreate}
				disabled={zoomed}
				data-testid="create-room"
				className="self-start rounded bg-[var(--hex-accent)] px-5 py-3 font-mono text-sm text-black disabled:opacity-40"
			>
				Create display →
			</button>

			<p className="font-mono text-[11px] text-[var(--hex-dim)]">
				Screen size affects the estimate in metres. It does not change either angle.
			</p>
		</main>
	);
}

function clampByte(v: number): number {
	return Math.min(255, Math.max(1, Math.round(v)));
}

function gcd(a: number, b: number): number {
	return b === 0 ? a : gcd(b, a % b);
}

export const DEFAULT_MM = DEFAULT_MM_PER_CSS_PX;
