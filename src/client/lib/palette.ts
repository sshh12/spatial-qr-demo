/**
 * The bridge between the CSS palette and the 3D scene.
 *
 * Reads the `--hex-*` custom properties defined in styles.css. Those exist
 * because three.js cannot consume the OKLCH tokens Tailwind wants, and because
 * an unregistered custom property resolves to its authored string rather than a
 * computed colour -- so asking the DOM for `--color-accent` returns the literal
 * text "oklch(...)", which `THREE.Color.setStyle` silently turns into black.
 */

export const PALETTE_KEYS = [
	"void",
	"surface",
	"line",
	"dim",
	"muted",
	"text",
	"accent",
	"warn",
	"danger",
	"good",
] as const;

export type PaletteKey = (typeof PALETTE_KEYS)[number];

/** Fallbacks, used before styles load and inside tests with no document. */
export const FALLBACK_HEX: Record<PaletteKey, string> = {
	void: "#08080a",
	surface: "#131317",
	line: "#2a2a31",
	dim: "#6f6f7a",
	muted: "#9a9aa4",
	text: "#eeeef0",
	accent: "#4cc9f0",
	warn: "#f2b134",
	danger: "#ef476f",
	good: "#57d99a",
};

let cache: Record<PaletteKey, string> | null = null;

export function palette(): Record<PaletteKey, string> {
	if (cache) return cache;
	if (typeof document === "undefined") return FALLBACK_HEX;
	const style = getComputedStyle(document.documentElement);
	const out = { ...FALLBACK_HEX };
	for (const key of PALETTE_KEYS) {
		const value = style.getPropertyValue(`--hex-${key}`).trim();
		if (/^#[0-9a-f]{3,8}$/i.test(value)) out[key] = value;
	}
	cache = out;
	return out;
}

export function hex(key: PaletteKey): string {
	return palette()[key];
}

/** Numeric form, for three.js constructors that want 0xRRGGBB. */
export function hexNumber(key: PaletteKey): number {
	return Number.parseInt(hex(key).slice(1), 16);
}

/** Deterministic per-viewer colour, from the hue the server assigned. */
export function viewerColour(hue: number, lightness = 62): string {
	return `hsl(${hue} 68% ${lightness}%)`;
}
