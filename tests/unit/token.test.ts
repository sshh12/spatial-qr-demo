import { moduleCountForVersion } from "@core/marker.ts";
import {
	decodeToken,
	encodeToken,
	isAlphanumericPayload,
	MAX_EDGE_MM,
	mintToken,
	payloadForToken,
	TOKEN_LENGTH,
	TokenError,
	versionForPayload,
} from "@core/token.ts";
import { SURFACES } from "@core/types.ts";
import { describe, expect, it } from "vitest";

describe("URL token", () => {
	it("round-trips every field", () => {
		for (const surface of SURFACES) {
			const payload = {
				schemaVersion: 1,
				markerEdgeMm: 336.4,
				aspectNum: 16,
				aspectDen: 9,
				surface,
				edgeToScreenHeight: 100 / 255,
				rand: 0xdeadbeef,
			};
			const token = encodeToken(payload);
			expect(token).toHaveLength(TOKEN_LENGTH);
			expect(decodeToken(token)).toEqual(payload);
		}
	});

	it("keeps the display-height ratio well inside the uncertainty it competes with", () => {
		// Distance in display heights is the headline unit precisely because it
		// needs no guesses, so the one byte carrying it must not quietly undo that.
		// The quantisation is uniform, so the honest statement is an *absolute*
		// bound of half a step; the relative error is worst for small ratios.
		const halfStep = 1 / 510;
		for (const ratio of [0.1, 0.2578, 0.3333, 0.6667, 0.88, 1]) {
			const token = mintToken({
				markerEdgeMm: 336,
				aspectNum: 16,
				aspectDen: 9,
				surface: "monitor",
				edgeToScreenHeight: ratio,
			});
			const recovered = decodeToken(token).edgeToScreenHeight;
			expect(Math.abs(recovered - ratio)).toBeLessThanOrEqual(halfStep + 1e-12);
		}

		// The ratios this app actually mints: 0.258 for the idle marker (34% of the
		// viewport, less the quiet zone) and 0.667 full-bleed. Across that range the
		// relative error stays under 1%, against a metric distance estimate that
		// carries 15%.
		for (const ratio of [0.2578, 0.6667]) {
			const token = mintToken({
				markerEdgeMm: 336,
				aspectNum: 16,
				aspectDen: 9,
				surface: "monitor",
				edgeToScreenHeight: ratio,
			});
			const recovered = decodeToken(token).edgeToScreenHeight;
			expect(Math.abs(recovered - ratio) / ratio).toBeLessThan(0.01);
		}
	});

	it("uses zero to mean 'not on a display'", () => {
		const token = mintToken({
			markerEdgeMm: 200,
			aspectNum: 1,
			aspectDen: 1,
			surface: "print",
			edgeToScreenHeight: 0,
		});
		expect(decodeToken(token).edgeToScreenHeight).toBe(0);
		expect(decodeToken(token).surface).toBe("print");
	});

	it("stays inside QR alphanumeric mode", () => {
		// A lowercase character here would force byte mode, cost about 45% of the
		// payload capacity, and push the symbol up a version or two -- which is
		// scan range, directly.
		for (let i = 0; i < 200; i++) {
			const token = mintToken({
				markerEdgeMm: 100 + i,
				aspectNum: 16,
				aspectDen: 9,
				surface: "monitor",
				edgeToScreenHeight: 0.667,
			});
			expect(token).toMatch(/^[0-9A-Z]{18}$/);
			expect(isAlphanumericPayload(token)).toBe(true);
		}
	});

	it("keeps 0.1 mm resolution across the whole range", () => {
		for (const mm of [5, 12.3, 199, 336.4, 685.9, 1245.1, MAX_EDGE_MM - 0.1]) {
			const token = encodeToken({
				schemaVersion: 1,
				markerEdgeMm: mm,
				aspectNum: 16,
				aspectDen: 9,
				surface: "monitor",
				edgeToScreenHeight: 0.667,
				rand: 1,
			});
			expect(decodeToken(token).markerEdgeMm).toBeCloseTo(mm, 5);
		}
	});

	it("accepts Crockford's confusable characters when typed by hand", () => {
		const token = mintToken({
			markerEdgeMm: 336,
			aspectNum: 16,
			aspectDen: 9,
			surface: "monitor",
			edgeToScreenHeight: 0.667,
		});
		const typed = token.replace(/1/g, "I").replace(/0/g, "O").toLowerCase();
		expect(decodeToken(typed)).toEqual(decodeToken(token));
	});

	it("rejects malformed tokens instead of decoding garbage", () => {
		expect(() => decodeToken("TOOSHORT")).toThrow(TokenError);
		expect(() => decodeToken("0123456789ABCDEFGHI")).toThrow(TokenError);
		expect(() => decodeToken("!!!!!!!!!!!!!!!!!!")).toThrow(TokenError);
		// Schema version 0 is not version 1.
		expect(() => decodeToken("000000000000000000")).toThrow(TokenError);
	});

	it("gives distinct tokens to two people who build the same display", () => {
		// Without the 32 bits of entropy these would collide, and the two of them
		// would share a live feed and each other's ghosts.
		const spec = {
			markerEdgeMm: 336,
			aspectNum: 16,
			aspectDen: 9,
			surface: "monitor",
			edgeToScreenHeight: 0.667,
		} as const;
		const tokens = new Set(Array.from({ length: 500 }, () => mintToken(spec)));
		expect(tokens.size).toBe(500);
	});
});

describe("payload and symbol version", () => {
	it("builds an all-uppercase payload", () => {
		const p = payloadForToken("https://Example.com", "abc123");
		expect(p).toBe("HTTPS://EXAMPLE.COM/S/ABC123");
		expect(isAlphanumericPayload(p)).toBe(true);
	});

	it("prices the domain in symbol versions, as CONCEPT.md section 11 claims", () => {
		const short = payloadForToken("https://spqr.io", "0123456789ABCDEFGH");
		const railway = payloadForToken(
			"https://spatial-qr-demo-production.up.railway.app",
			"0123456789ABCDEFGH",
		);

		expect(versionForPayload(short)).toBe(2);
		expect(versionForPayload(railway)).toBe(4);

		// Which is the whole point: more modules across the same physical width
		// means fewer pixels per module at any given distance, and the range gate
		// is expressed in pixels per module.
		const shortModules = moduleCountForVersion(versionForPayload(short));
		const railwayModules = moduleCountForVersion(versionForPayload(railway));
		expect(shortModules).toBe(25);
		expect(railwayModules).toBe(33);
		expect(shortModules / railwayModules).toBeCloseTo(0.758, 2);
	});

	it("charges for lowercase by dropping out of alphanumeric mode", () => {
		const upper = "HTTPS://SPQR.IO/S/0123456789ABCDEF";
		const lower = "https://spqr.io/s/0123456789abcdef";
		expect(isAlphanumericPayload(upper)).toBe(true);
		expect(isAlphanumericPayload(lower)).toBe(false);
		expect(versionForPayload(lower)).toBeGreaterThan(versionForPayload(upper));
	});
});
