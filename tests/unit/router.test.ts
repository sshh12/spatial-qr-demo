import { parseRoute } from "@client/App.tsx";
import { payloadForToken } from "@core/token.ts";
import { describe, expect, it } from "vitest";

/**
 * The router, driven by the URLs a phone camera actually produces.
 *
 * The QR payload is uppercase from end to end because QR's alphanumeric mode has
 * no lowercase, and dropping to byte mode costs about 45% of the payload
 * capacity. So a scanned code opens `/S/TOKEN`, not `/s/token`. A router that
 * only knew the lowercase form sent every real scan to a 404 -- and no test
 * caught it, because every test navigated by hand with the right case.
 *
 * These cases are derived from `payloadForToken` rather than written out, so
 * they cannot drift away from what is actually encoded in the square.
 */
describe("routing the scanned URL", () => {
	const TOKEN = "040YP4090114C2632G";

	function pathOf(payload: string): string {
		return new URL(payload.replace(/^HTTPS:/, "https:")).pathname;
	}

	it("routes the path the QR payload really contains", () => {
		const payload = payloadForToken("https://192.168.1.50:3211", TOKEN);
		expect(payload).toContain("/S/");
		const route = parseRoute(pathOf(payload));
		expect(route).toEqual({ name: "scan", token: TOKEN });
	});

	it("accepts either case, from either direction", () => {
		for (const path of [
			`/s/${TOKEN}`,
			`/S/${TOKEN}`,
			`/s/${TOKEN.toLowerCase()}`,
			`/S/${TOKEN.toLowerCase()}`,
		]) {
			expect(parseRoute(path), path).toEqual({ name: "scan", token: TOKEN });
		}
	});

	it("normalises the token so the solver always sees one form", () => {
		expect(parseRoute(`/s/${TOKEN.toLowerCase()}`)).toEqual(parseRoute(`/S/${TOKEN}`));
	});

	it("handles the display link the same way", () => {
		expect(parseRoute(`/D/${TOKEN}`)).toEqual({ name: "display", token: TOKEN });
		expect(parseRoute(`/d/${TOKEN.toLowerCase()}`)).toEqual({ name: "display", token: TOKEN });
	});

	it("tolerates a trailing slash", () => {
		expect(parseRoute(`/S/${TOKEN}/`)).toEqual({ name: "scan", token: TOKEN });
		expect(parseRoute("/")).toEqual({ name: "display", token: null });
	});

	it("still routes the static pages", () => {
		expect(parseRoute("/create").name).toBe("create");
		expect(parseRoute("/Create").name).toBe("create");
		expect(parseRoute("/how-it-works").name).toBe("how");
	});

	it("does not invent a room for a path that is not one", () => {
		expect(parseRoute("/s/").name).toBe("not-found");
		expect(parseRoute("/nonsense").name).toBe("not-found");
		expect(parseRoute("/s/has-a-hyphen").name).toBe("not-found");
	});
});
