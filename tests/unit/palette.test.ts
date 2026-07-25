import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FALLBACK_HEX, PALETTE_KEYS } from "@client/lib/palette.ts";
import { describe, expect, it } from "vitest";
import { deltaOk, oklchToHex } from "../support/oklch.ts";

const css = readFileSync(
	fileURLToPath(new URL("../../src/client/styles.css", import.meta.url)),
	"utf8",
);

function readCustomProperty(name: string): string | null {
	const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
	return match?.[1]?.trim() ?? null;
}

function parseOklch(value: string): { l: number; c: number; h: number } | null {
	const match = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/.exec(value);
	if (!match) return null;
	return { l: Number(match[1]), c: Number(match[2]), h: Number(match[3]) };
}

/**
 * Two encodings of one palette have to agree.
 *
 * Tailwind v4 wants OKLCH. three.js cannot read it -- `Color.setStyle` does not
 * parse `oklch()`, and an unregistered custom property comes back from
 * getComputedStyle as the authored string rather than a resolved colour, so
 * feeding the OKLCH token to three produces black. Hence a hex mirror for every
 * token the scene touches.
 *
 * That arrangement rots the moment someone tweaks one and forgets the other, so
 * this converts the OKLCH back to sRGB and fails if the pair has drifted
 * perceptibly. It is the difference between "keep these in sync" being a comment
 * and being true.
 */
describe("palette", () => {
	it("keeps every OKLCH token and its sRGB mirror describing the same colour", () => {
		for (const key of PALETTE_KEYS) {
			const oklchRaw = readCustomProperty(`color-${key}`);
			const hexRaw = readCustomProperty(`hex-${key}`);
			expect(oklchRaw, `--color-${key} missing from styles.css`).toBeTruthy();
			expect(hexRaw, `--hex-${key} missing from styles.css`).toBeTruthy();

			const parsed = parseOklch(oklchRaw!);
			expect(parsed, `--color-${key} is not an oklch() value`).toBeTruthy();

			const roundTripped = oklchToHex(parsed!);
			// 0.02 in OKLab is around the just-noticeable threshold, so anything
			// under it is a rounding artefact rather than a divergence.
			expect(
				deltaOk(roundTripped, hexRaw!),
				`${key}: oklch ${oklchRaw} -> ${roundTripped}, but --hex-${key} is ${hexRaw}`,
			).toBeLessThan(0.02);
		}
	});

	it("has a fallback for every token, for the frames before CSS lands", () => {
		for (const key of PALETTE_KEYS) {
			const hexRaw = readCustomProperty(`hex-${key}`);
			expect(FALLBACK_HEX[key]).toBe(hexRaw);
		}
	});

	it("declares pixelated last so it beats the crisp-edges fallback", () => {
		// Declaration order decides which value wins, and `pixelated` is the one
		// that must: an anti-aliased module edge is a biased module edge, and the
		// sub-pixel refiner would inherit that bias with no way to detect it.
		const marker = /\.marker-canvas\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
		// Match the declarations, not the prose: the comment above them mentions
		// both values and would otherwise decide the outcome of this test.
		const crisp = marker.indexOf("image-rendering: crisp-edges");
		const pixelated = marker.indexOf("image-rendering: pixelated");
		expect(crisp).toBeGreaterThan(-1);
		expect(pixelated).toBeGreaterThan(crisp);
	});
});
