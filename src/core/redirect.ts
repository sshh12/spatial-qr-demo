import type { WirePose } from "./api.ts";
import type { ConfidenceTier } from "./types.ts";

/**
 * The onward redirect: this demo used as a general QR service that hands a
 * scanner's measured position to somebody else's URL.
 *
 * The creator supplies a destination once, at create time. After a scan solves,
 * the phone appends the position to that URL as query parameters and goes there.
 * So a single printed code can answer "which side of the room was this scanned
 * from" for an application that knows nothing about geometry.
 *
 * Three rules shape the schema, and all three are about not being lied to or
 * lying to anyone:
 *
 * 1. The parameters are exactly the wire pose plus provenance. `WirePose` is
 *    deliberately four numbers and `POSE_FIELDS` exists to keep it that way, so
 *    what we hand a third party is precisely what we hand our own server --
 *    nothing extra leaks out through the side door.
 * 2. Every parameter is namespaced `sqr_`, and any `sqr_` parameter already
 *    present in the destination is stripped before ours are appended. Otherwise
 *    a crafted link could carry a second, contradictory position past the one
 *    that was actually measured.
 * 3. None of it is authenticated, and that is stated rather than implied. The
 *    pose is computed on the visitor's own phone and is trivially forgeable by
 *    design -- see `clampPose`. Anyone can type these parameters by hand. They
 *    are a signal for tailoring content, never a fact to gate access on.
 */

export const REDIRECT_SCHEMA_VERSION = 1;

/** Every parameter this schema writes begins with it, and nothing else may. */
export const REDIRECT_PREFIX = "sqr_";

/**
 * Long enough for a real campaign URL with tracking parameters, short enough
 * that the room record cannot be used as free storage.
 */
export const MAX_DESTINATION_LENGTH = 512;

/** Whether the position was solved from a photograph or placed by hand. */
export type PoseSource = "measured" | "manual";

/** The confidence tier as it reaches a destination; "refused" never ships. */
export type ReportedTier = "solid" | "soft";

export interface RedirectFacts {
	readonly pose: WirePose;
	readonly tier: ReportedTier;
	readonly source: PoseSource;
	/** The code that was scanned. Lowercase on the wire, like the canonical URL. */
	readonly token: string;
	/** Milliseconds since the epoch; emitted as whole seconds. */
	readonly at: number;
}

export interface RedirectField {
	readonly name: string;
	readonly example: string;
	readonly meaning: string;
}

/**
 * The schema, as data.
 *
 * The Create page renders its reference table from this array and the tests
 * assert against it, so the documentation a creator reads cannot drift away
 * from the parameters that actually get sent.
 */
export const REDIRECT_SCHEMA: readonly RedirectField[] = [
	{
		name: "sqr_v",
		example: "1",
		meaning: "Schema version. Increments only for a breaking change.",
	},
	{
		name: "sqr_az",
		example: "-31.4",
		meaning:
			"Side-to-side angle in degrees, one decimal. 0 is straight in front of the code; positive means the phone was to the right as you face the screen. Range ±89.",
	},
	{
		name: "sqr_el",
		example: "8.2",
		meaning:
			"Vertical angle in degrees, one decimal. Positive means above the centre of the code. Range ±89.",
	},
	{
		name: "sqr_dh",
		example: "2.41",
		meaning:
			"Distance from the display in display heights, two decimals. Dimensionless, so it needs no screen size and no camera data — this is the trustworthy number.",
	},
	{
		name: "sqr_sd",
		example: "0.280",
		meaning:
			"One standard deviation of positional uncertainty, three decimals, also in display heights. Never present it without this.",
	},
	{
		name: "sqr_tier",
		example: "solid",
		meaning:
			"solid or soft. Derived on the server from sd/dh: solid at or under 0.12, soft above it. Anything worse is refused and never redirects.",
	},
	{
		name: "sqr_src",
		example: "measured",
		meaning:
			"measured from a photograph, or manual if the visitor placed themselves by hand because they had no camera. Treat manual as a rough hint.",
	},
	{
		name: "sqr_token",
		example: "040yp4090114c2632g",
		meaning:
			"The code that was scanned, lowercase. Decode it to recover the display's physical size.",
	},
	{
		name: "sqr_at",
		example: "1753440000",
		meaning: "When the position was measured, in whole seconds since the Unix epoch.",
	},
];

/** Illustrative values for the preview on the Create page. */
export const EXAMPLE_REDIRECT_FACTS: RedirectFacts = {
	pose: { az: -31.4, el: 8.2, dh: 2.41, sd: 0.28 },
	tier: "solid",
	source: "measured",
	token: "040yp4090114c2632g",
	at: 1_753_440_000_000,
};

/**
 * Accept a destination, or refuse it.
 *
 * Shared by the Create page, which uses it for immediate feedback, and by the
 * claim endpoint, which is the only copy that counts. The scheme check is the
 * load-bearing part: `javascript:`, `data:` and friends parse perfectly well as
 * URLs, and this value ends up in a `location.replace` on a visitor's phone.
 *
 * Plain HTTP is refused except on loopback, where the test lane and the dev
 * server live. A position sent in clear text over someone's café wifi is not a
 * trade this demo makes on a visitor's behalf.
 */
export function normaliseDestination(raw: string | null | undefined): string | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_DESTINATION_LENGTH) return null;

	// People type "example.com/arrive". Only assume https when there is no scheme
	// at all -- never when one is present, or the check below would be bypassed.
	const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
	const candidate = hasScheme ? trimmed : `https://${trimmed.replace(/^\/+/, "")}`;

	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return null;
	}

	const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
	// Credentials in a URL are a phishing shape and browsers strip them anyway.
	if (url.username || url.password) return null;
	if (!url.hostname) return null;

	const normalised = url.toString();
	return normalised.length > MAX_DESTINATION_LENGTH ? null : normalised;
}

/**
 * The destination with the position appended.
 *
 * The destination's own query string and fragment both survive untouched, so a
 * creator can keep their campaign parameters; only the `sqr_` namespace is ours.
 */
export function buildRedirectUrl(destination: string, facts: RedirectFacts): string {
	const url = new URL(destination);
	for (const key of [...url.searchParams.keys()]) {
		if (key.startsWith(REDIRECT_PREFIX)) url.searchParams.delete(key);
	}
	for (const [key, value] of redirectParams(facts)) url.searchParams.set(key, value);
	return url.toString();
}

/** The parameters in schema order, which is also the order they are documented in. */
export function redirectParams(facts: RedirectFacts): readonly (readonly [string, string])[] {
	const { pose } = facts;
	return [
		["sqr_v", String(REDIRECT_SCHEMA_VERSION)],
		["sqr_az", fixed(pose.az, 1)],
		["sqr_el", fixed(pose.el, 1)],
		["sqr_dh", fixed(pose.dh, 2)],
		["sqr_sd", fixed(pose.sd, 3)],
		["sqr_tier", facts.tier],
		["sqr_src", facts.source],
		["sqr_token", facts.token.toLowerCase()],
		["sqr_at", String(Math.floor(facts.at / 1000))],
	];
}

/**
 * Rounded to the precision the measurement actually supports, and never "-0.0".
 *
 * Emitting a float's full expansion would advertise a precision the geometry
 * does not have: the bearing carries a degree or two of uncertainty, so digits
 * past the first decimal are noise dressed as signal.
 */
function fixed(value: number, places: number): string {
	if (!Number.isFinite(value)) return (0).toFixed(places);
	const text = value.toFixed(places);
	return text === `-${(0).toFixed(places)}` ? (0).toFixed(places) : text;
}

/**
 * Narrow a tier to what can actually ship.
 *
 * A refused pose is rejected by the server with a 422 and never reaches a
 * result screen, so it can never reach a destination either. Making that
 * unrepresentable in the type is cheaper than documenting it.
 */
export function reportedTier(tier: ConfidenceTier): ReportedTier {
	return tier === "solid" ? "solid" : "soft";
}

/** The host a visitor is about to be sent to, for the handoff screen. */
export function destinationHost(destination: string): string {
	try {
		return new URL(destination).host;
	} catch {
		return destination;
	}
}
