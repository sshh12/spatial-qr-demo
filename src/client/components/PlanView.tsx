import type { Ghost, Viewer } from "@core/api.ts";
import { useId } from "react";
import { viewerColour } from "../lib/palette.ts";

export interface PlanViewProps {
	readonly viewers: readonly Viewer[];
	readonly ghosts?: readonly Ghost[];
	/** The viewer to highlight, if any. */
	readonly meId?: string | null;
	/** Draw both branches of an unresolved flip. */
	readonly ambiguousPair?: { readonly az: number; readonly dh: number } | null;
	readonly maxScreenHeights?: number;
	readonly showLegend?: boolean;
	readonly className?: string;
}

/**
 * The plan view: the same solved position, drawn flat.
 *
 * Bird's eye, screen along the top, viewers below it looking up at it. Drawn
 * this way round the viewer's right hand really is on the right of the picture,
 * so nobody has to perform a mental mirror to check the answer -- which matters,
 * because checking the answer against their own memory is the only verification
 * a casual visitor can actually do.
 */
export function PlanView({
	viewers,
	ghosts = [],
	meId = null,
	ambiguousPair = null,
	maxScreenHeights,
	showLegend = true,
	className = "",
}: PlanViewProps) {
	const clipId = useId();
	const W = 640;
	const H = 460;
	const originX = W / 2;
	const originY = 74;

	const distances = [
		...viewers.map((v) => v.pose?.dh ?? 0),
		...ghosts.map((g) => g.dh),
		ambiguousPair?.dh ?? 0,
	];
	const furthest = Math.max(1.6, ...distances);
	const span = maxScreenHeights ?? Math.ceil(furthest * 1.15);
	const scale = (H - originY - 34) / span;

	const rings = ringsFor(span);
	const project = (az: number, dh: number) => ({
		x: originX + Math.sin((az * Math.PI) / 180) * dh * scale,
		y: originY + Math.cos((az * Math.PI) / 180) * dh * scale,
	});

	return (
		<svg
			viewBox={`0 0 ${W} ${H}`}
			className={`w-full ${className}`}
			role="img"
			aria-label={
				ambiguousPair
					? "Top-down view of two possible camera positions, with the display at the top"
					: `Top-down view of ${viewers.length} measured ${viewers.length === 1 ? "position" : "positions"}, with the display at the top`
			}
			data-testid="plan-view"
		>
			<title>Camera positions viewed from above</title>
			<defs>
				<clipPath id={clipId}>
					<rect x="0" y={originY - 12} width={W} height={H - originY + 12} />
				</clipPath>
			</defs>

			<g clipPath={`url(#${clipId})`}>
				{rings.map((r) => (
					<g key={r}>
						<circle
							cx={originX}
							cy={originY}
							r={r * scale}
							fill="none"
							stroke="var(--hex-line)"
							strokeWidth={1}
						/>
						<text
							x={originX + r * scale + 6}
							y={originY + 13}
							fill="var(--hex-dim)"
							fontSize={11}
							fontFamily="var(--font-mono)"
						>
							{r}h
						</text>
					</g>
				))}

				{[-60, -40, -20, 0, 20, 40, 60].map((deg) => {
					const end = project(deg, span);
					return (
						<line
							key={deg}
							x1={originX}
							y1={originY}
							x2={end.x}
							y2={end.y}
							stroke="var(--hex-line)"
							strokeWidth={deg === 0 ? 1.2 : 0.6}
							strokeDasharray={deg === 0 ? "none" : "3 6"}
							opacity={deg === 0 ? 0.9 : 0.55}
						/>
					);
				})}

				{ghosts.map((g, i) => {
					const p = project(g.az, g.dh);
					return (
						<circle
							key={`${g.at}-${i}`}
							cx={p.x}
							cy={p.y}
							r={2.4}
							fill="var(--hex-muted)"
							opacity={0.18}
						/>
					);
				})}

				{ambiguousPair && (
					<g>
						{[ambiguousPair.az, -ambiguousPair.az].map((az) => {
							const p = project(az, ambiguousPair.dh);
							return (
								<g key={az}>
									<circle
										cx={p.x}
										cy={p.y}
										r={9}
										fill="none"
										stroke="var(--hex-warn)"
										strokeWidth={1.6}
										strokeDasharray="4 3"
									/>
									<circle cx={p.x} cy={p.y} r={3.5} fill="var(--hex-warn)" opacity={0.75} />
								</g>
							);
						})}
					</g>
				)}

				{viewers.map((v) => {
					if (!v.pose) return null;
					const p = project(v.pose.az, v.pose.dh);
					const isMe = v.id === meId;
					const colour = viewerColour(v.hue);
					return (
						<g key={v.id} data-testid={isMe ? "plan-me" : "plan-viewer"}>
							<circle
								cx={p.x}
								cy={p.y}
								r={Math.max(4, v.pose.sd * scale)}
								fill={colour}
								opacity={0.14}
							/>
							<circle cx={p.x} cy={p.y} r={isMe ? 6.5 : 5} fill={colour} />
							{isMe && (
								<>
									<line
										x1={originX}
										y1={originY}
										x2={p.x}
										y2={p.y}
										stroke={colour}
										strokeWidth={1}
										strokeDasharray="3 4"
										opacity={0.8}
									/>
									<circle cx={p.x} cy={p.y} r={11} fill="none" stroke={colour} strokeWidth={1.2} />
								</>
							)}
							{v.name && (
								<text
									x={p.x}
									y={p.y + 22}
									fill="var(--hex-muted)"
									fontSize={11}
									textAnchor="middle"
									fontFamily="var(--font-mono)"
								>
									{v.name}
								</text>
							)}
						</g>
					);
				})}
			</g>

			<rect
				x={originX - 92}
				y={originY - 6}
				width={184}
				height={7}
				rx={2.5}
				fill="var(--hex-text)"
			/>
			<text
				x={originX}
				y={originY - 16}
				fill="var(--hex-dim)"
				fontSize={11}
				textAnchor="middle"
				fontFamily="var(--font-mono)"
			>
				the display
			</text>

			{showLegend && (
				<text x={16} y={H - 14} fill="var(--hex-dim)" fontSize={11} fontFamily="var(--font-mono)">
					h = display height · ring spacing {rings[1] ? rings[1] - rings[0]! : 1}h
				</text>
			)}
		</svg>
	);
}

function ringsFor(span: number): number[] {
	const step = span <= 4 ? 1 : span <= 10 ? 2 : 5;
	const out: number[] = [];
	for (let r = step; r <= span; r += step) out.push(r);
	return out;
}
