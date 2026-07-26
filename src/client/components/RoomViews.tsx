import type { Ghost, RoomState, Viewer } from "@core/api.ts";
import { displayGeometry } from "@core/export.ts";
import {
	COMFORTABLE_ARCMIN,
	legibleDistanceHeights,
	TEXT_SIZES,
	type TextSizeId,
	VIEWING_CONE_DEG,
} from "@core/legibility.ts";
import { lazy, Suspense, useMemo, useState } from "react";
import { PlanView } from "./PlanView.tsx";

/**
 * Three.js is a quarter of a megabyte gzipped and this page's job on load is to
 * render a QR code somebody is about to photograph. The scene waits until a
 * visitor asks for it by name.
 */
const Scene = lazy(() => import("../scene/Scene.tsx").then((m) => ({ default: m.Scene })));

type Tab = "plan" | "scene";

export interface RoomViewsProps {
	readonly token: string;
	readonly room: RoomState | null;
	readonly viewers: readonly Viewer[];
	readonly ghosts: readonly Ghost[];
	readonly reducedMotion?: boolean;
}

/**
 * The measured room, in whichever projection you want it.
 *
 * The plan view stays the default and the 3D is opt-in, which is the right way
 * round: flat, top-down and unrotatable is the view a visitor can actually
 * check against their own memory of where they stood, and checking the answer
 * is the only verification a casual visitor can perform. The 3D view is the one
 * that shows elevation and the legibility boundary, so it earns its tab, but it
 * does not get to be the first thing anybody sees.
 */
export function RoomViews({ token, room, viewers, ghosts, reducedMotion = false }: RoomViewsProps) {
	const [tab, setTab] = useState<Tab>("plan");
	const [textSize, setTextSize] = useState<TextSizeId>("body");
	const [cutoff, setCutoff] = useState<number | null>(null);

	const placed = useMemo(
		() => viewers.filter((v) => v.pose).sort((a, b) => a.at - b.at),
		[viewers],
	);

	// The scrubber selects a prefix of the session rather than a window of it:
	// the question somebody asks of a filling room is "what did it look like by
	// then", not "who was there in that minute and nobody else".
	const shown = useMemo(
		() => (cutoff === null ? placed : placed.filter((v) => v.at <= cutoff)),
		[placed, cutoff],
	);

	const geometry = useMemo(() => (room ? displayGeometry(room) : null), [room]);
	const fraction = TEXT_SIZES.find((t) => t.id === textSize)?.fraction ?? 0.026;
	const legibleHeights = legibleDistanceHeights(fraction);
	const comfortableHeights = legibleDistanceHeights(fraction, COMFORTABLE_ARCMIN);

	if (placed.length === 0) return null;

	return (
		<section
			className="sqr-fade-up flex flex-col gap-4 rounded-lg border border-[var(--hex-line)] bg-[var(--hex-surface)]/40 p-4"
			data-testid="room-views"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div
					className="flex items-center gap-1 rounded border border-[var(--hex-line)] p-0.5"
					role="tablist"
					aria-label="How to view the measured positions"
				>
					<TabButton current={tab} value="plan" onSelect={setTab}>
						Plan
					</TabButton>
					<TabButton current={tab} value="scene" onSelect={setTab}>
						3D
					</TabButton>
				</div>
				<ExportLinks token={token} count={placed.length} />
			</div>

			<div className="min-h-[300px]">
				{tab === "plan" ? (
					<PlanView viewers={shown} ghosts={ghosts} />
				) : (
					<Suspense
						fallback={
							<div className="flex h-[360px] items-center justify-center font-mono text-xs text-[var(--hex-dim)]">
								Loading the scene…
							</div>
						}
					>
						<Scene
							viewers={shown}
							ghosts={ghosts}
							displayHeightM={geometry?.heightM ?? 1}
							displayAspect={geometry?.aspect ?? 16 / 9}
							legibleRadiusHeights={legibleHeights}
							reducedMotion={reducedMotion}
							className="h-[360px] w-full rounded"
						/>
					</Suspense>
				)}
			</div>

			<Scrubber positions={placed} cutoff={cutoff} onChange={setCutoff} />

			<Stats
				positions={shown}
				legibleHeights={legibleHeights}
				comfortableHeights={comfortableHeights}
				heightM={geometry?.heightM ?? null}
			/>

			<div className="flex flex-wrap items-center gap-2">
				<span className="font-mono text-[11px] text-[var(--hex-dim)]">Text size</span>
				{TEXT_SIZES.map((size) => (
					<button
						key={size.id}
						type="button"
						onClick={() => setTextSize(size.id)}
						aria-pressed={textSize === size.id}
						className={`rounded border px-2.5 py-1 font-mono text-[11px] transition ${
							textSize === size.id
								? "border-[var(--hex-accent)] text-[var(--hex-text)]"
								: "border-[var(--hex-line)] text-[var(--hex-dim)]"
						}`}
					>
						{size.label}
					</button>
				))}
			</div>
		</section>
	);
}

function TabButton({
	current,
	value,
	onSelect,
	children,
}: {
	current: Tab;
	value: Tab;
	onSelect: (t: Tab) => void;
	children: React.ReactNode;
}) {
	const active = current === value;
	return (
		<button
			type="button"
			role="tab"
			aria-selected={active}
			onClick={() => onSelect(value)}
			data-testid={`tab-${value}`}
			className={`rounded px-3 py-1.5 font-mono text-xs transition ${
				active
					? "bg-[var(--hex-line)] text-[var(--hex-text)]"
					: "text-[var(--hex-dim)] hover:text-[var(--hex-muted)]"
			}`}
		>
			{children}
		</button>
	);
}

/**
 * Plain links, not a fetch-and-blob dance.
 *
 * The endpoint sets its own content type and filename, so an anchor is the
 * whole implementation -- and it means anything that can issue a GET gets the
 * same bytes the button does, which is the point of an export.
 */
function ExportLinks({ token, count }: { token: string; count: number }) {
	const formats = [
		{ id: "json", label: "JSON", title: "Positions, uncertainty and the coordinate frame" },
		{ id: "csv", label: "CSV", title: "One row per position, for a spreadsheet" },
		{ id: "gltf", label: "glTF", title: "Each scan as a camera you can open in Blender" },
	];
	return (
		<div className="flex items-center gap-2" data-testid="export-links">
			<span className="font-mono text-[11px] text-[var(--hex-dim)]">
				Export {count} {count === 1 ? "position" : "positions"}
			</span>
			{formats.map((f) => (
				<a
					key={f.id}
					href={`/api/s/${token}/export?format=${f.id}`}
					download
					title={f.title}
					data-testid={`export-${f.id}`}
					className="rounded border border-[var(--hex-line)] px-2.5 py-1 font-mono text-[11px] text-[var(--hex-muted)] transition hover:border-[var(--hex-accent)] hover:text-[var(--hex-text)]"
				>
					{f.label}
				</a>
			))}
		</div>
	);
}

/**
 * The session, replayed.
 *
 * Hidden below three positions, because a slider with two stops is furniture
 * rather than a control.
 */
function Scrubber({
	positions,
	cutoff,
	onChange,
}: {
	positions: readonly Viewer[];
	cutoff: number | null;
	onChange: (at: number | null) => void;
}) {
	if (positions.length < 3) return null;
	const last = positions[positions.length - 1]!;
	const index =
		cutoff === null
			? positions.length - 1
			: Math.max(0, positions.filter((v) => v.at <= cutoff).length - 1);
	const at = positions[index]?.at ?? last.at;
	const elapsed = Math.round((at - positions[0]!.at) / 1000);

	return (
		<div className="flex items-center gap-3" data-testid="scrubber">
			<input
				type="range"
				min={0}
				max={positions.length - 1}
				value={index}
				aria-label="Show positions measured up to this point in the session"
				onChange={(e) => {
					const next = Number(e.target.value);
					onChange(next >= positions.length - 1 ? null : (positions[next]?.at ?? null));
				}}
				className="h-1 w-full accent-[var(--hex-accent)]"
			/>
			<span className="tabular shrink-0 font-mono text-[11px] text-[var(--hex-dim)]">
				{index + 1}/{positions.length} · +{elapsed}s
			</span>
		</div>
	);
}

/**
 * What the positions add up to.
 *
 * Every figure here is dimensionless or a count, with one exception that is
 * labelled as an estimate. That is not squeamishness: the distances are exact
 * ratios and the metric conversion is not, so a strip that mixed them without
 * saying which was which would launder a guess into a statistic.
 */
function Stats({
	positions,
	legibleHeights,
	comfortableHeights,
	heightM,
}: {
	positions: readonly Viewer[];
	legibleHeights: number;
	comfortableHeights: number;
	heightM: number | null;
}) {
	const distances = positions.map((v) => v.pose!.dh).sort((a, b) => a - b);
	if (distances.length === 0) return null;
	const azimuths = positions.map((v) => v.pose!.az);
	const mid = Math.floor(distances.length / 2);
	const median =
		distances.length % 2 === 1 ? distances[mid]! : (distances[mid - 1]! + distances[mid]!) / 2;
	const spread = Math.max(...azimuths) - Math.min(...azimuths);
	const inCone = positions.filter((v) => Math.abs(v.pose!.az) <= VIEWING_CONE_DEG).length;
	const legible = distances.filter((d) => d <= legibleHeights).length;

	return (
		<dl
			className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-[var(--hex-line)] pt-3 font-mono text-[11px] sm:grid-cols-4"
			data-testid="room-stats"
		>
			<Stat
				label="median distance"
				value={`${median.toFixed(1)} h`}
				note={heightM ? `≈ ${(median * heightM).toFixed(1)} m` : "no size declared"}
			/>
			<Stat label="angular spread" value={`${spread.toFixed(0)}°`} note="widest to widest" />
			<Stat
				label="inside the cone"
				value={`${inCone}/${positions.length}`}
				note={`within ±${VIEWING_CONE_DEG}°`}
			/>
			<Stat
				label="text legible"
				value={`${legible}/${positions.length}`}
				note={`to ${legibleHeights.toFixed(1)} h, easy to ${comfortableHeights.toFixed(1)} h`}
			/>
		</dl>
	);
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
	return (
		<div className="flex flex-col gap-0.5">
			<dt className="text-[var(--hex-dim)]">{label}</dt>
			<dd className="tabular text-sm text-[var(--hex-text)]">{value}</dd>
			<dd className="text-[10px] text-[var(--hex-dim)]">{note}</dd>
		</div>
	);
}
