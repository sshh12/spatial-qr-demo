import type { WirePose } from "@core/api.ts";
import {
	buildRedirectUrl,
	EXAMPLE_REDIRECT_FACTS,
	MAX_DESTINATION_LENGTH,
	normaliseDestination,
	REDIRECT_SCHEMA,
	type RedirectFacts,
	redirectParams,
	reportedTier,
} from "@core/redirect.ts";
import { describe, expect, it } from "vitest";

/**
 * The onward redirect, which is the only part of this app that hands a
 * measurement to somebody else's server.
 *
 * Two failures matter more than the rest. A destination that is not really a
 * URL ends up in a `location.replace` on a visitor's phone, so the scheme check
 * is a security boundary rather than input tidying. And the parameter shape is
 * a published contract that other people write code against, so it is pinned
 * here character by character -- a schema that quietly changes precision or
 * renames a field breaks every integration at once and silently.
 */

const POSE: WirePose = { az: -31.4, el: 8.2, dh: 2.41, sd: 0.28 };
const FACTS: RedirectFacts = {
	pose: POSE,
	tier: "solid",
	source: "measured",
	token: "040YP4090114C2632G",
	at: 1_753_440_000_000,
};

describe("the published parameter schema", () => {
	it("emits exactly the documented parameters, and only those", () => {
		// The Create page renders its reference table from REDIRECT_SCHEMA. If the
		// two ever disagree, a creator reads documentation for a payload nobody
		// sends -- so they are compared rather than trusted to stay in step.
		expect(redirectParams(FACTS).map(([key]) => key)).toEqual(REDIRECT_SCHEMA.map((f) => f.name));
	});

	it("produces the values the documentation gives as examples", () => {
		const emitted = new Map(redirectParams(EXAMPLE_REDIRECT_FACTS));
		for (const field of REDIRECT_SCHEMA) {
			expect(emitted.get(field.name), field.name).toBe(field.example);
		}
	});

	it("pins the exact string a destination receives", () => {
		expect(buildRedirectUrl("https://example.com/arrive", FACTS)).toBe(
			"https://example.com/arrive?sqr_v=1&sqr_az=-31.4&sqr_el=8.2&sqr_dh=2.41&sqr_sd=0.280" +
				"&sqr_tier=solid&sqr_src=measured&sqr_token=040yp4090114c2632g&sqr_at=1753440000",
		);
	});

	it("rounds to the precision the geometry actually supports", () => {
		// The bearing carries a degree or two of uncertainty. Emitting a float's
		// full expansion would advertise a precision that is not there.
		const params = new Map(
			redirectParams({ ...FACTS, pose: { az: -31.44999, el: 8.23881, dh: 2.4132, sd: 0.28449 } }),
		);
		expect(params.get("sqr_az")).toBe("-31.4");
		expect(params.get("sqr_el")).toBe("8.2");
		expect(params.get("sqr_dh")).toBe("2.41");
		// Three places on the uncertainty: a tight solve rounds to "0.00" at two,
		// which reads as a claim of no uncertainty at all.
		expect(params.get("sqr_sd")).toBe("0.284");
	});

	it("never emits negative zero, which reads as a direction that was not measured", () => {
		const params = new Map(redirectParams({ ...FACTS, pose: { ...POSE, az: -0.02, el: -0.001 } }));
		expect(params.get("sqr_az")).toBe("0.0");
		expect(params.get("sqr_el")).toBe("0.0");
	});

	it("sends the token in the same case the canonical URL uses", () => {
		expect(new Map(redirectParams(FACTS)).get("sqr_token")).toBe("040yp4090114c2632g");
	});

	it("reports the measurement time in whole seconds", () => {
		expect(new Map(redirectParams({ ...FACTS, at: 1_753_440_000_999 })).get("sqr_at")).toBe(
			"1753440000",
		);
	});

	it("distinguishes a hand-placed position from a measured one", () => {
		expect(new Map(redirectParams({ ...FACTS, source: "manual" })).get("sqr_src")).toBe("manual");
	});

	it("never reports a refused tier, because a refused pose never gets this far", () => {
		expect(reportedTier("solid")).toBe("solid");
		expect(reportedTier("soft")).toBe("soft");
		expect(reportedTier("refused")).toBe("soft");
	});
});

describe("appending to a destination", () => {
	it("keeps the creator's own query string", () => {
		const url = new URL(buildRedirectUrl("https://example.com/a?utm=poster&id=7", FACTS));
		expect(url.searchParams.get("utm")).toBe("poster");
		expect(url.searchParams.get("id")).toBe("7");
		expect(url.searchParams.get("sqr_dh")).toBe("2.41");
	});

	it("keeps the fragment, which some single-page apps route on", () => {
		expect(buildRedirectUrl("https://example.com/a#/section", FACTS)).toContain("#/section");
	});

	it("replaces any sqr_ parameter already in the address", () => {
		// Otherwise a crafted link could carry a second, contradictory position
		// past the one that was actually measured, and the destination would have
		// no way to tell which of the two to believe.
		const url = new URL(
			buildRedirectUrl("https://example.com/a?sqr_az=89&sqr_tier=solid&keep=yes", FACTS),
		);
		expect(url.searchParams.getAll("sqr_az")).toEqual(["-31.4"]);
		expect(url.searchParams.getAll("sqr_tier")).toEqual(["solid"]);
		expect(url.searchParams.get("keep")).toBe("yes");
	});

	it("escapes values rather than splicing them into the query", () => {
		const url = buildRedirectUrl("https://example.com/a", { ...FACTS, token: "a&b=c" });
		expect(new URL(url).searchParams.get("sqr_token")).toBe("a&b=c");
	});
});

describe("accepting a destination", () => {
	it("takes a full https address unchanged", () => {
		expect(normaliseDestination("https://example.com/arrive?x=1")).toBe(
			"https://example.com/arrive?x=1",
		);
	});

	it("assumes https when somebody types a bare host, which everybody does", () => {
		expect(normaliseDestination("example.com/arrive")).toBe("https://example.com/arrive");
		expect(normaliseDestination("  example.com  ")).toBe("https://example.com/");
		expect(normaliseDestination("//example.com/a")).toBe("https://example.com/a");
	});

	it("refuses schemes that are not a web page", () => {
		// This value ends up in a location.replace on a visitor's phone. All of
		// these parse perfectly well as URLs, which is exactly the problem.
		for (const bad of [
			"javascript:alert(1)",
			"JavaScript:alert(1)",
			"data:text/html,<script>alert(1)</script>",
			"vbscript:msgbox(1)",
			"file:///etc/passwd",
			"ftp://example.com/x",
			"intent://example.com#Intent;end",
		]) {
			expect(normaliseDestination(bad), bad).toBeNull();
		}
	});

	it("refuses plain http off loopback, and allows it on", () => {
		// A position sent in clear text over a café network is not a trade this
		// demo makes for a visitor. Loopback is the dev server and the test lane.
		expect(normaliseDestination("http://example.com/a")).toBeNull();
		expect(normaliseDestination("http://localhost:3210/arrive")).toBe(
			"http://localhost:3210/arrive",
		);
		expect(normaliseDestination("http://127.0.0.1:3210/arrive")).toBe(
			"http://127.0.0.1:3210/arrive",
		);
	});

	it("refuses credentials in the address, which are a phishing shape", () => {
		expect(normaliseDestination("https://example.com@evil.test/")).toBeNull();
		expect(normaliseDestination("https://user:pw@example.com/")).toBeNull();
	});

	it("refuses what is not a URL at all", () => {
		for (const bad of ["", "   ", "not a url", "https://", null, undefined]) {
			expect(normaliseDestination(bad), JSON.stringify(bad)).toBeNull();
		}
	});

	it("caps the length, so a room record cannot be used as free storage", () => {
		const long = `https://example.com/${"a".repeat(MAX_DESTINATION_LENGTH)}`;
		expect(normaliseDestination(long)).toBeNull();
		expect(normaliseDestination(`https://example.com/${"a".repeat(400)}`)).not.toBeNull();
	});

	it("accepts everything it produces, so a stored value survives a round trip", () => {
		for (const raw of ["example.com", "https://example.com/a?b=c#d", "http://localhost:3210/x"]) {
			const once = normaliseDestination(raw)!;
			expect(normaliseDestination(once)).toBe(once);
		}
	});
});
