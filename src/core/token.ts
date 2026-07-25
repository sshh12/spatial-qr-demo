import { SURFACES, type Surface } from "./types.ts";

/**
 * The self-describing URL token.
 *
 * Ten bytes -- schema version, symbol edge, aspect ratio, surface, and 32 bits
 * of entropy -- encoded as sixteen uppercase base32 characters. Everything the
 * phone needs to solve a pose is in the URL, so `/s/:token` resolves with zero
 * server state. A code tweeted last week still works after the process is
 * relocated, redeployed or wiped; only the live feed and the room's history are
 * lost, and both are explicitly ephemeral.
 *
 * Crockford base32 rather than base64url for one hard reason: QR's alphanumeric
 * mode covers digits, A-Z and a handful of symbols but no lowercase. A mixed-case
 * token forces byte mode and costs about 45% of the payload capacity, which
 * costs symbol versions, which costs scan range. Crockford also drops I, L, O
 * and U, so the token cannot contain a character anyone would misread aloud.
 *
 * The 32 random bits are not optional. Without them two people who both create a
 * 336 mm monitor code would land in the same room, share a live feed, and see
 * each other's ghosts.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DECODE = (() => {
	const map = new Map<string, number>();
	for (let i = 0; i < ALPHABET.length; i++) map.set(ALPHABET[i]!, i);
	// Crockford's documented confusables, so a hand-typed token still works.
	map.set("I", 1);
	map.set("L", 1);
	map.set("O", 0);
	map.set("U", map.get("V")!);
	return map;
})();

const TOKEN_BYTES = 11;
/** ceil(11 * 8 / 5) = 18 characters. */
export const TOKEN_LENGTH = 18;
export const TOKEN_SCHEMA_VERSION = 1;

/** Encoded in tenths of a millimetre, so the range is 0.1 mm to 6553.5 mm. */
const MM_SCALE = 10;
export const MIN_EDGE_MM = 5;
export const MAX_EDGE_MM = 6000;

export interface TokenPayload {
	readonly schemaVersion: number;
	/** Symbol edge in millimetres, EXCLUDING the quiet zone. */
	readonly markerEdgeMm: number;
	readonly aspectNum: number;
	readonly aspectDen: number;
	readonly surface: Surface;
	/**
	 * Symbol edge divided by the display's height, both in the same units.
	 *
	 * This is what makes the headline unit -- distance in display heights --
	 * survive with no display connected: a printed code, a closed tab, a link
	 * opened from a tweet. Without it the token knows how big the marker is in
	 * millimetres but not how big it is relative to the screen, so the one
	 * quantity that needs no guesses would be the one we could not report.
	 *
	 * Quantised to 1/255, so the absolute error is at most 1/510. Across the
	 * ratios this app mints -- 0.258 for the idle marker, 0.667 full-bleed --
	 * that is under 1% relative, against a metric distance estimate carrying 15%.
	 * Zero means "not on a display", and distance is then reported in marker
	 * widths instead.
	 */
	readonly edgeToScreenHeight: number;
	/** 32 bits of entropy, as an unsigned integer. */
	readonly rand: number;
}

export class TokenError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TokenError";
	}
}

function base32Encode(bytes: Uint8Array): string {
	let out = "";
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += ALPHABET[(buffer >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
	return out;
}

function base32Decode(text: string, expectedBytes: number): Uint8Array {
	const out = new Uint8Array(expectedBytes);
	let buffer = 0;
	let bits = 0;
	let index = 0;
	for (const ch of text) {
		const value = DECODE.get(ch);
		if (value === undefined) throw new TokenError(`invalid character ${JSON.stringify(ch)}`);
		buffer = (buffer << 5) | value;
		bits += 5;
		if (bits >= 8) {
			if (index >= expectedBytes) throw new TokenError("token too long");
			out[index++] = (buffer >>> (bits - 8)) & 0xff;
			bits -= 8;
		}
	}
	if (index !== expectedBytes) throw new TokenError("token too short");
	return out;
}

export function encodeToken(payload: TokenPayload): string {
	const { markerEdgeMm, aspectNum, aspectDen, surface, rand } = payload;
	if (!(markerEdgeMm >= MIN_EDGE_MM && markerEdgeMm <= MAX_EDGE_MM)) {
		throw new TokenError(`markerEdgeMm ${markerEdgeMm} outside ${MIN_EDGE_MM}-${MAX_EDGE_MM}`);
	}
	if (!Number.isInteger(aspectNum) || aspectNum < 1 || aspectNum > 255) {
		throw new TokenError(`aspectNum ${aspectNum} must be 1-255`);
	}
	if (!Number.isInteger(aspectDen) || aspectDen < 1 || aspectDen > 255) {
		throw new TokenError(`aspectDen ${aspectDen} must be 1-255`);
	}
	const surfaceIndex = SURFACES.indexOf(surface);
	if (surfaceIndex < 0) throw new TokenError(`unknown surface ${surface}`);

	const tenths = Math.round(markerEdgeMm * MM_SCALE);
	const bytes = new Uint8Array(TOKEN_BYTES);
	bytes[0] = payload.schemaVersion & 0xff;
	bytes[1] = (tenths >>> 8) & 0xff;
	bytes[2] = tenths & 0xff;
	bytes[3] = aspectNum;
	bytes[4] = aspectDen;
	bytes[5] = surfaceIndex;
	bytes[6] = Math.min(255, Math.max(0, Math.round((payload.edgeToScreenHeight ?? 0) * 255)));
	bytes[7] = (rand >>> 24) & 0xff;
	bytes[8] = (rand >>> 16) & 0xff;
	bytes[9] = (rand >>> 8) & 0xff;
	bytes[10] = rand & 0xff;
	return base32Encode(bytes);
}

export function decodeToken(token: string): TokenPayload {
	const normalised = token.trim().toUpperCase().replace(/-/g, "");
	if (normalised.length !== TOKEN_LENGTH) {
		throw new TokenError(`expected ${TOKEN_LENGTH} characters, got ${normalised.length}`);
	}
	const bytes = base32Decode(normalised, TOKEN_BYTES);
	const schemaVersion = bytes[0]!;
	if (schemaVersion !== TOKEN_SCHEMA_VERSION) {
		throw new TokenError(`unsupported schema version ${schemaVersion}`);
	}
	const markerEdgeMm = ((bytes[1]! << 8) | bytes[2]!) / MM_SCALE;
	const aspectNum = bytes[3]!;
	const aspectDen = bytes[4]!;
	const surface = SURFACES[bytes[5]!];
	if (!surface) throw new TokenError(`unknown surface index ${bytes[5]}`);
	if (aspectNum < 1 || aspectDen < 1) throw new TokenError("degenerate aspect ratio");
	if (markerEdgeMm < MIN_EDGE_MM || markerEdgeMm > MAX_EDGE_MM) {
		throw new TokenError(`implausible marker edge ${markerEdgeMm} mm`);
	}
	return {
		schemaVersion,
		markerEdgeMm,
		aspectNum,
		aspectDen,
		surface,
		edgeToScreenHeight: bytes[6]! / 255,
		rand: ((bytes[7]! << 24) >>> 0) + (bytes[8]! << 16) + (bytes[9]! << 8) + bytes[10]!,
	};
}

export function randomEntropy(): number {
	const buf = new Uint32Array(1);
	crypto.getRandomValues(buf);
	return buf[0]!;
}

export function mintToken(spec: Omit<TokenPayload, "schemaVersion" | "rand">): string {
	return encodeToken({ ...spec, schemaVersion: TOKEN_SCHEMA_VERSION, rand: randomEntropy() });
}

/**
 * The scannable payload.
 *
 * Uppercase throughout so the whole string stays inside QR's alphanumeric
 * character set; the server redirects to lowercase on arrival so that the
 * address bar is not shouting at the visitor.
 */
export function payloadForToken(origin: string, token: string): string {
	const host = origin.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
	return `HTTPS://${host.toUpperCase()}/S/${token.toUpperCase()}`;
}

/** QR alphanumeric mode covers exactly these characters. */
const ALPHANUMERIC = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:");

export function isAlphanumericPayload(payload: string): boolean {
	for (const ch of payload) if (!ALPHANUMERIC.has(ch)) return false;
	return true;
}

/** Capacity of QR alphanumeric mode at error-correction level M, by version. */
const ALPHANUMERIC_CAPACITY_M: Record<number, number> = {
	1: 20,
	2: 38,
	3: 61,
	4: 90,
	5: 122,
	6: 154,
	7: 178,
	8: 221,
	9: 262,
	10: 311,
};

/**
 * Smallest QR version that will hold this payload at level M, which is what
 * decides the module count, which decides the scan range. Never hardcode the
 * range table: it moves the day the domain changes.
 */
export function versionForPayload(payload: string): number {
	if (!isAlphanumericPayload(payload)) {
		// Byte mode holds roughly 45% fewer characters.
		for (const [version, capacity] of Object.entries(ALPHANUMERIC_CAPACITY_M)) {
			if (payload.length <= capacity * 0.55) return Number(version);
		}
		return 10;
	}
	for (const [version, capacity] of Object.entries(ALPHANUMERIC_CAPACITY_M)) {
		if (payload.length <= capacity) return Number(version);
	}
	return 10;
}
