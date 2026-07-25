import type { MarkerLayout } from "./marker.ts";
import type { TokenPayload } from "./token.ts";
import type { ConfidenceTier } from "./types.ts";

/**
 * The wire contract, shared verbatim by the phone, the display and the server.
 *
 * The pose payload is literally four numbers. The phone shows the user this
 * exact object before it is sent, which is the whole reason the capture screen
 * can promise "four numbers, and you'll see them first" and mean it. Angles are
 * degrees; distance is in *display heights*, which is dimensionless and
 * therefore exact -- no physical size, no focal length, nothing anyone had to
 * guess. The confidence tier is derived from these numbers on the server rather
 * than trusted from the client, so the payload cannot grow a fifth field by
 * accident.
 */
export interface WirePose {
	/** Azimuth in degrees; positive means the viewer stood to their own right. */
	readonly az: number;
	/** Elevation in degrees; positive means above the marker centre. */
	readonly el: number;
	/** Distance from the display, in display heights. */
	readonly dh: number;
	/** 1-sigma positional uncertainty, also in display heights. */
	readonly sd: number;
}

export const POSE_FIELDS = ["az", "el", "dh", "sd"] as const;

export type ViewerRole = "phone" | "display";

export interface Viewer {
	readonly id: string;
	/** Null in the public landing-page room, which has no free text at all. */
	readonly name: string | null;
	/** Assigned, never chosen: index into the palette. */
	readonly hue: number;
	readonly shape: number;
	readonly pose: WirePose | null;
	readonly tier: ConfidenceTier;
	/** True when the viewer's phone reported both branches as plausible. */
	readonly ambiguous: boolean;
	readonly at: number;
}

export interface RoomState {
	readonly token: string;
	readonly spec: TokenPayload;
	readonly label: string | null;
	readonly allowNames: boolean;
	readonly persistent: boolean;
	readonly createdAt: number;
	/** What the display says it is showing right now. Null if none is connected. */
	readonly layout: MarkerLayout | null;
	readonly layoutAt: number;
	readonly viewers: readonly Viewer[];
	/** Highest event id, so a poller knows where to resume. */
	readonly cursor: number;
	readonly phonesConnected: number;
	readonly displaysConnected: number;
}

/** A normalised, anonymous record of where somebody once stood. */
export interface Ghost {
	readonly az: number;
	readonly el: number;
	readonly dh: number;
	readonly at: number;
}

export interface GhostsResponse {
	readonly ghosts: readonly Ghost[];
	/** Total ever recorded, which is the number the counter quotes. */
	readonly total: number;
}

export type ServerEventType =
	| "phone-connected"
	| "phone-armed"
	| "capturing"
	| "pose"
	| "layout"
	| "viewer-left"
	| "room-cleared";

export interface HelloRequest {
	readonly role: ViewerRole;
	readonly clientId?: string;
	readonly name?: string;
}

export interface HelloResponse {
	readonly clientId: string;
	/**
	 * True when a *different* display already holds this room, meaning two
	 * visitors' random tokens collided. The caller must mint a new token rather
	 * than join: joining would let a stranger's phone drive this screen.
	 */
	readonly collision: boolean;
	readonly room: RoomState;
	readonly origin: string;
}

export interface HelloCollision {
	readonly collision: true;
	readonly clientId: string;
}

export interface PoseRequest {
	readonly clientId: string;
	readonly pose: WirePose;
	readonly ambiguous?: boolean;
	readonly name?: string;
	/** Opt-in contribution to the global normalised commons. */
	readonly contribute?: boolean;
}

export interface CalibrationSample {
	/** Coarse device signature; never a fingerprint, never stored per-user. */
	readonly signature: string;
	/** Millimetres per CSS pixel, measured with the bank-card ruler. */
	readonly mmPerCssPx?: number;
	/** Focal length divided by capture width, from a solid-tier solve. */
	readonly focalOverWidth?: number;
}

export interface CalibrationEstimate {
	readonly signature: string;
	readonly mmPerCssPx: { readonly median: number; readonly mad: number; readonly n: number } | null;
	readonly focalOverWidth: {
		readonly median: number;
		readonly mad: number;
		readonly n: number;
	} | null;
	/** False when there were too few samples to say anything without identifying anyone. */
	readonly offered: boolean;
}

/** Below this many samples the commons stays silent; k-anonymity by construction. */
export const CALIBRATION_MIN_SAMPLES = 5;

export interface ErrorResponse {
	readonly error: string;
	readonly detail?: string;
}
