import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const ARTIFACT_DIR = resolve(process.cwd(), "public/generated");

export function writeArtifact(name: string, contents: string): string {
	const path = resolve(ARTIFACT_DIR, name);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents, "utf8");
	return path;
}

export function percentile(values: readonly number[], p: number): number {
	const clean = values.filter((v) => Number.isFinite(v));
	if (clean.length === 0) return Number.NaN;
	const sorted = [...clean].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx]!;
}

export function mean(values: readonly number[]): number {
	const clean = values.filter((v) => Number.isFinite(v));
	if (clean.length === 0) return Number.NaN;
	return clean.reduce((a, b) => a + b, 0) / clean.length;
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

export interface SeriesPoint {
	readonly x: number;
	readonly y: number;
}

export interface ChartSeries {
	readonly label: string;
	readonly colour: string;
	readonly points: readonly SeriesPoint[];
	readonly dashed?: boolean;
	/** Plot against the right-hand axis instead of the left. */
	readonly rightAxis?: boolean;
}

export interface ChartOptions {
	readonly title: string;
	readonly xLabel: string;
	readonly yLabel: string;
	readonly rightLabel?: string;
	readonly series: readonly ChartSeries[];
	readonly logX?: boolean;
	readonly logY?: boolean;
	readonly yMax?: number;
	readonly rightMax?: number;
	readonly footnote?: string;
}

/**
 * A dependency-free SVG line chart. This is CI output that ships to
 * /how-it-works, so it is generated from the measured numbers rather than drawn
 * by hand -- a chart that cannot go stale is worth more than a prettier one that
 * can.
 */
export function renderChart(options: ChartOptions): string {
	const W = 880;
	const H = 460;
	const pad = { top: 52, right: options.rightLabel ? 74 : 28, bottom: 62, left: 74 };
	const plotW = W - pad.left - pad.right;
	const plotH = H - pad.top - pad.bottom;

	// Drop non-finite points before anything measures them. A single NaN reaching
	// Math.min poisons the whole axis, every coordinate becomes NaN, and the SVG
	// renders as an empty frame with plausible-looking axis labels -- which is a
	// far worse failure than an error, because it looks like a finished chart.
	const series = options.series
		.map((s) => ({
			...s,
			points: s.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
		}))
		.filter((s) => s.points.length > 0);

	const all = series.flatMap((s) => s.points);
	if (all.length === 0)
		return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"/>`;

	const xs = all.map((p) => p.x);
	const left = series.filter((s) => !s.rightAxis).flatMap((s) => s.points.map((p) => p.y));
	const right = series.filter((s) => s.rightAxis).flatMap((s) => s.points.map((p) => p.y));

	const xMin = Math.min(...xs);
	const xMax = Math.max(...xs);
	const yMin = options.logY ? Math.max(1e-4, Math.min(...left)) : 0;
	const yMax = options.yMax ?? Math.max(...left) * 1.12;
	const rMax = options.rightMax ?? (right.length ? Math.max(...right) * 1.12 || 1 : 1);

	const tx = (x: number) => {
		const v = options.logX
			? (Math.log(x) - Math.log(xMin)) / (Math.log(xMax) - Math.log(xMin) || 1)
			: (x - xMin) / (xMax - xMin || 1);
		return pad.left + v * plotW;
	};
	const ty = (y: number) => {
		const v = options.logY
			? (Math.log(Math.max(y, yMin)) - Math.log(yMin)) / (Math.log(yMax) - Math.log(yMin) || 1)
			: (y - yMin) / (yMax - yMin || 1);
		return pad.top + plotH - v * plotH;
	};
	const tr = (y: number) => pad.top + plotH - (y / (rMax || 1)) * plotH;

	const parts: string[] = [];
	parts.push(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">`,
	);
	parts.push(`<rect width="${W}" height="${H}" fill="#0a0a0c"/>`);
	parts.push(
		`<text x="${pad.left}" y="28" fill="#e8e8ea" font-size="15">${escapeXml(options.title)}</text>`,
	);

	// Grid
	const yTicks = 5;
	for (let i = 0; i <= yTicks; i++) {
		const value = options.logY
			? Math.exp(Math.log(yMin) + (i / yTicks) * (Math.log(yMax) - Math.log(yMin)))
			: yMin + (i / yTicks) * (yMax - yMin);
		const y = ty(value);
		parts.push(
			`<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${(pad.left + plotW).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#26262b" stroke-width="1"/>`,
		);
		parts.push(
			`<text x="${pad.left - 8}" y="${(y + 4).toFixed(1)}" fill="#8a8a94" font-size="11" text-anchor="end">${formatTick(value)}</text>`,
		);
	}
	const xTicks = 6;
	for (let i = 0; i <= xTicks; i++) {
		const value = options.logX
			? Math.exp(Math.log(xMin) + (i / xTicks) * (Math.log(xMax) - Math.log(xMin)))
			: xMin + (i / xTicks) * (xMax - xMin);
		const x = tx(value);
		parts.push(
			`<line x1="${x.toFixed(1)}" y1="${pad.top}" x2="${x.toFixed(1)}" y2="${pad.top + plotH}" stroke="#1c1c20" stroke-width="1"/>`,
		);
		parts.push(
			`<text x="${x.toFixed(1)}" y="${pad.top + plotH + 20}" fill="#8a8a94" font-size="11" text-anchor="middle">${formatTick(value)}</text>`,
		);
	}

	if (options.rightLabel) {
		for (let i = 0; i <= yTicks; i++) {
			const value = (i / yTicks) * rMax;
			parts.push(
				`<text x="${pad.left + plotW + 8}" y="${(tr(value) + 4).toFixed(1)}" fill="#8a8a94" font-size="11">${(value * 100).toFixed(0)}%</text>`,
			);
		}
	}

	for (const s of series) {
		const map = s.rightAxis ? tr : ty;
		const d = s.points
			.map((p, i) => `${i === 0 ? "M" : "L"}${tx(p.x).toFixed(1)},${map(p.y).toFixed(1)}`)
			.join(" ");
		parts.push(
			`<path d="${d}" fill="none" stroke="${s.colour}" stroke-width="2"${s.dashed ? ' stroke-dasharray="5 4"' : ""}/>`,
		);
		for (const p of s.points) {
			parts.push(
				`<circle cx="${tx(p.x).toFixed(1)}" cy="${map(p.y).toFixed(1)}" r="2.6" fill="${s.colour}"/>`,
			);
		}
	}

	// Legend
	let lx = pad.left;
	for (const s of series) {
		parts.push(`<rect x="${lx}" y="${H - 26}" width="16" height="3" fill="${s.colour}"/>`);
		parts.push(
			`<text x="${lx + 22}" y="${H - 20}" fill="#b6b6be" font-size="11">${escapeXml(s.label)}</text>`,
		);
		lx += 30 + s.label.length * 6.4;
	}

	parts.push(
		`<text x="${(pad.left + plotW / 2).toFixed(0)}" y="${H - 40}" fill="#8a8a94" font-size="11" text-anchor="middle">${escapeXml(options.xLabel)}</text>`,
	);
	parts.push(
		`<text x="16" y="${(pad.top + plotH / 2).toFixed(0)}" fill="#8a8a94" font-size="11" text-anchor="middle" transform="rotate(-90 16 ${(pad.top + plotH / 2).toFixed(0)})">${escapeXml(options.yLabel)}</text>`,
	);
	if (options.footnote) {
		parts.push(
			`<text x="${pad.left}" y="44" fill="#6c6c76" font-size="10.5">${escapeXml(options.footnote)}</text>`,
		);
	}
	parts.push("</svg>");
	return parts.join("\n");
}

function formatTick(v: number): string {
	if (v === 0) return "0";
	const abs = Math.abs(v);
	if (abs >= 100) return v.toFixed(0);
	if (abs >= 10) return v.toFixed(1);
	if (abs >= 1) return v.toFixed(2);
	return v.toPrecision(2);
}

function escapeXml(s: string): string {
	return s.replace(/[<>&"]/g, (c) => `&${{ "<": "lt", ">": "gt", "&": "amp", '"': "quot" }[c]};`);
}
