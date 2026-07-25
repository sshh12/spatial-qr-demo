import type { BracketSpec, MarkerLayout } from "@core/marker.ts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { buildModules, paintMarker } from "../lib/qr.ts";

export interface MarkerProps {
	readonly text: string;
	readonly mode: "idle" | "fullbleed";
	/** Millimetres per CSS pixel on this display. */
	readonly mmPerCssPx: number;
	readonly nonce: string;
	readonly onLayout?: (layout: MarkerLayout) => void;
	/** Fraction of the viewport height the marker box occupies. */
	readonly heightFraction?: number;
	readonly className?: string;
}

export interface BracketGeometry {
	readonly specs: BracketSpec[];
	readonly armLength: number;
	readonly thickness: number;
	readonly inset: number;
}

/**
 * Brackets pinned to the display's true corners.
 *
 * A full-bleed square symbol spans the whole height of a 16:9 display but only
 * 56% of its width. Corner brackets stretch the horizontal baseline by 1.78x,
 * and azimuth -- the headline number, and the only one a person can check
 * against their own memory -- is exactly what a wider horizontal baseline buys.
 *
 * They need no dictionary coding or unique patterns, because the session
 * already told the phone precisely what is on screen and where. They are also
 * redundancy: when glare takes out a finder pattern, four corners survive.
 */
export function bracketGeometry(width: number, height: number): BracketGeometry {
	const inset = Math.round(height * 0.02);
	const armLength = Math.round(Math.min(width, height) * 0.16);
	const thickness = Math.max(3, Math.round(height * 0.011));
	const corners = [
		{ x: inset, y: inset },
		{ x: width - inset, y: inset },
		{ x: width - inset, y: height - inset },
		{ x: inset, y: height - inset },
	];
	const specs = corners.map((corner, i) => {
		const next = corners[(i + 1) % 4]!;
		const prev = corners[(i + 3) % 4]!;
		const toward = (p: { x: number; y: number }) => {
			const dx = p.x - corner.x;
			const dy = p.y - corner.y;
			const len = Math.hypot(dx, dy) || 1;
			return { x: corner.x + (dx / len) * armLength, y: corner.y + (dy / len) * armLength };
		};
		return {
			corner,
			armA: toward(next),
			armB: toward(prev),
			thicknessCssPx: thickness,
		} satisfies BracketSpec;
	});
	return { specs, armLength, thickness, inset };
}

export function Marker({
	text,
	mode,
	mmPerCssPx,
	nonce,
	onLayout,
	heightFraction,
	className = "",
}: MarkerProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const wrapRef = useRef<HTMLDivElement>(null);
	const [viewport, setViewport] = useState(() => ({
		w: typeof window === "undefined" ? 1280 : window.innerWidth,
		h: typeof window === "undefined" ? 720 : window.innerHeight,
	}));

	useEffect(() => {
		const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
		window.addEventListener("resize", onResize);
		window.addEventListener("orientationchange", onResize);
		return () => {
			window.removeEventListener("resize", onResize);
			window.removeEventListener("orientationchange", onResize);
		};
	}, []);

	const fraction = heightFraction ?? (mode === "fullbleed" ? 0.88 : 0.34);
	// Memoised deliberately. This object is a dependency of the layout effect,
	// which reports upward, which re-renders this component -- so rebuilding the
	// array every render is an infinite loop, and one that only appears in
	// full-bleed mode, which is to say only during the swap.
	const brackets = useMemo(
		() => (mode === "fullbleed" ? bracketGeometry(viewport.w, viewport.h) : null),
		[mode, viewport.w, viewport.h],
	);

	useLayoutEffect(() => {
		const canvas = canvasRef.current;
		const wrap = wrapRef.current;
		if (!canvas || !wrap) return;

		const modules = buildModules(text);
		const painted = paintMarker(
			canvas,
			modules,
			viewport.h * fraction,
			window.devicePixelRatio || 1,
		);

		// Measure where the symbol actually landed, rather than trusting the CSS to
		// have done what was asked. Everything the phone computes is relative to
		// this, so a layout shift of a few pixels is a real error, not a cosmetic one.
		const rect = canvas.getBoundingClientRect();
		const quietPx = (painted.boxCssPx / (modules.size + 8)) * 4;
		const layout: MarkerLayout = {
			id: mode,
			moduleCount: modules.size,
			symbolEdgeCssPx: painted.symbolEdgeCssPx,
			// The symbol edge, NOT the rendered box: the box includes the four-module
			// quiet zone, and confusing the two overstates distance by 32% at v2.
			symbolEdgeMm: painted.symbolEdgeCssPx * mmPerCssPx,
			viewportCssPx: { w: viewport.w, h: viewport.h },
			symbolCentreCssPx: {
				x: rect.left + quietPx + painted.symbolEdgeCssPx / 2,
				y: rect.top + quietPx + painted.symbolEdgeCssPx / 2,
			},
			brackets: brackets?.specs ?? null,
			nonce,
		};
		onLayout?.(layout);
	}, [text, mode, mmPerCssPx, nonce, viewport, fraction, onLayout, brackets]);

	if (mode === "fullbleed") {
		return (
			<div
				ref={wrapRef}
				data-testid="marker-fullbleed"
				className={`fixed inset-0 z-50 flex items-center justify-center bg-white ${className}`}
				style={{ paddingTop: `${viewport.h * 0.04}px` }}
			>
				<canvas
					ref={canvasRef}
					className="marker-canvas"
					aria-label="QR code used to measure camera position"
				/>
				{brackets?.specs.map((spec, i) => (
					<Bracket
						key={`${spec.corner.x}-${spec.corner.y}-${i}`}
						spec={spec}
						centre={{ x: viewport.w / 2, y: viewport.h / 2 }}
					/>
				))}
			</div>
		);
	}

	return (
		<div ref={wrapRef} className={className} data-testid="marker-idle">
			<canvas
				ref={canvasRef}
				className="marker-canvas"
				aria-label="QR code used to measure camera position"
			/>
		</div>
	);
}

function Bracket({ spec, centre }: { spec: BracketSpec; centre: { x: number; y: number } }) {
	const arms = [spec.armA, spec.armB].map((end, i) => {
		const dx = end.x - spec.corner.x;
		const dy = end.y - spec.corner.y;
		const length = Math.hypot(dx, dy);
		const thickness = spec.thicknessCssPx;

		// The arm's thickness must grow toward the display's centre. If it grew
		// outward the outer edge would sit a few pixels off the corner the phone
		// is told to expect, and the whole point of the bracket is that its outer
		// corner is exactly the display's corner.
		if (Math.abs(dx) > Math.abs(dy)) {
			const left = dx < 0 ? spec.corner.x - length : spec.corner.x;
			const top = spec.corner.y < centre.y ? spec.corner.y : spec.corner.y - thickness;
			return (
				<div
					key={i}
					className="absolute bg-black"
					style={{
						left: `${left}px`,
						top: `${top}px`,
						width: `${length}px`,
						height: `${thickness}px`,
					}}
				/>
			);
		}
		const top = dy < 0 ? spec.corner.y - length : spec.corner.y;
		const left = spec.corner.x < centre.x ? spec.corner.x : spec.corner.x - thickness;
		return (
			<div
				key={i}
				className="absolute bg-black"
				style={{
					left: `${left}px`,
					top: `${top}px`,
					width: `${thickness}px`,
					height: `${length}px`,
				}}
			/>
		);
	});
	return <>{arms}</>;
}
