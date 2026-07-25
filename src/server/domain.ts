import type {
	CalibrationEstimate,
	CalibrationSample,
	Ghost,
	RoomState,
	Viewer,
	WirePose,
} from "@core/api.ts";
import { CALIBRATION_MIN_SAMPLES } from "@core/api.ts";
import type { MarkerLayout } from "@core/marker.ts";
import { decodeToken } from "@core/token.ts";
import type { ConfidenceTier } from "@core/types.ts";
import type { EventBus, Store } from "@storage/ports.ts";

export const ROOM_TTL_MS = 4 * 60 * 60 * 1000;
export const PERSISTENT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const VIEWER_TTL_MS = 30 * 60 * 1000;
export const MAX_VIEWERS = 200;
export const MAX_GHOSTS = 4000;
export const MAX_NAME_LENGTH = 24;

export const roomKey = (token: string) => `room:${token}`;
export const roomTopic = (token: string) => `room:${token}`;
export const GHOSTS_KEY = "ghosts";
export const GHOST_COUNT_KEY = "ghosts:total";
export const calibrationKey = (signature: string) => `cal:${signature}`;

export interface StoredRoom {
	token: string;
	label: string | null;
	allowNames: boolean;
	persistent: boolean;
	ownerTokenHash: string | null;
	createdAt: number;
	layout: MarkerLayout | null;
	layoutAt: number;
	viewers: Record<string, Viewer>;
	connections: Record<string, { role: string; at: number }>;
	/** Which client's display currently holds this room. See claimDisplay. */
	displayOwner: string | null;
}

/**
 * How long a display keeps its claim on a room without being heard from.
 *
 * The display heartbeats while its tab is visible, so this only has to outlast a
 * backgrounded tab briefly. Short enough that an abandoned room frees up, long
 * enough that a laptop lid closed for a minute does not lose its pairing.
 */
export const DISPLAY_CLAIM_TTL_MS = 3 * 60 * 1000;

export type ClaimOutcome = "claimed" | "renewed" | "collision";

/**
 * One display per room, enforced.
 *
 * The room token carries 32 bits of entropy, which is generous for one person
 * and thin across a front page: at thirty thousand concurrent rooms the birthday
 * probability that *some* pair collides is around 10%. The consequence is not a
 * cosmetic glitch -- the swap is a full-screen takeover, so a collision means a
 * stranger's phone blanking somebody else's screen, possibly a projected one.
 *
 * Lengthening the token would fix it and cost scan range: three more characters
 * pushes the payload past version 2's alphanumeric capacity, and more modules
 * across the same width is fewer pixels per module at every distance. So instead
 * the collision is caught at the only moment it can do harm -- when a second,
 * different display tries to claim a room that already has a live one -- and the
 * newcomer is told to mint a fresh token. The first arrival is never disturbed.
 */
export function claimDisplay(room: StoredRoom, clientId: string, now: number): ClaimOutcome {
	const owner = room.displayOwner;
	if (!owner || owner === clientId) {
		room.displayOwner = clientId;
		return owner === clientId ? "renewed" : "claimed";
	}
	const lastSeen = room.connections[owner]?.at ?? 0;
	if (now - lastSeen < DISPLAY_CLAIM_TTL_MS) return "collision";
	// The previous display is gone. Rooms are ephemeral; let the newcomer have it.
	room.displayOwner = clientId;
	return "claimed";
}

/**
 * Server-side plausibility clamps.
 *
 * The pose is computed on the visitor's own device and reported, so it is
 * trivially forgeable -- and deliberately so; nothing in the demo depends on it
 * being honest, and refusing to upload pixels is worth far more than
 * unforgeable geometry. What the server does owe everyone else in the room is
 * that a forged pose cannot render as something absurd or break the scene.
 */
export function clampPose(pose: WirePose): WirePose | null {
	const { az, el, dh, sd } = pose;
	if (![az, el, dh, sd].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
	if (Math.abs(az) > 89 || Math.abs(el) > 89) return null;
	if (dh <= 0.05 || dh > 60) return null;
	if (sd < 0 || sd > 30) return null;
	return {
		az: round(az, 3),
		el: round(el, 3),
		dh: round(dh, 4),
		sd: round(Math.max(sd, 1e-4), 4),
	};
}

function round(v: number, places: number): number {
	const k = 10 ** places;
	return Math.round(v * k) / k;
}

/** Tier is derived from the four numbers, never taken from the client. */
export function tierFromPose(pose: WirePose): ConfidenceTier {
	const relative = pose.sd / pose.dh;
	if (relative <= 0.12) return "solid";
	if (relative <= 0.35) return "soft";
	return "refused";
}

export function sanitiseName(raw: string | undefined, allowed: boolean): string | null {
	if (!allowed || !raw) return null;
	const cleaned = raw
		.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
		.trim()
		.slice(0, MAX_NAME_LENGTH);
	return cleaned.length > 0 ? cleaned : null;
}

/**
 * Colour and shape are assigned from the client id, never chosen.
 *
 * CONCEPT.md section 6.10: someone will arrange avatars into words within an
 * hour of the front page. Removing the choice removes the moderation queue.
 */
export function identityFor(clientId: string): { hue: number; shape: number } {
	let h = 2166136261;
	for (let i = 0; i < clientId.length; i++) {
		h ^= clientId.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	const v = h >>> 0;
	return { hue: v % 360, shape: (v >>> 9) % 5 };
}

export function emptyRoom(token: string, now: number): StoredRoom {
	return {
		token,
		label: null,
		allowNames: false,
		persistent: false,
		ownerTokenHash: null,
		createdAt: now,
		layout: null,
		layoutAt: 0,
		viewers: {},
		connections: {},
		displayOwner: null,
	};
}

export async function loadRoom(store: Store, token: string, now: number): Promise<StoredRoom> {
	const stored = await store.get<StoredRoom>(roomKey(token));
	return stored ?? emptyRoom(token, now);
}

export async function saveRoom(store: Store, room: StoredRoom): Promise<void> {
	await store.set(roomKey(room.token), room, room.persistent ? PERSISTENT_TTL_MS : ROOM_TTL_MS);
}

export function pruneViewers(room: StoredRoom, now: number): void {
	for (const [id, viewer] of Object.entries(room.viewers)) {
		if (now - viewer.at > VIEWER_TTL_MS) delete room.viewers[id];
	}
	for (const [id, connection] of Object.entries(room.connections)) {
		if (now - connection.at > VIEWER_TTL_MS) delete room.connections[id];
	}
	const ids = Object.keys(room.viewers);
	if (ids.length > MAX_VIEWERS) {
		const sorted = ids.sort((a, b) => room.viewers[a]!.at - room.viewers[b]!.at);
		for (const id of sorted.slice(0, ids.length - MAX_VIEWERS)) delete room.viewers[id];
	}
}

export async function toRoomState(
	room: StoredRoom,
	bus: EventBus,
	token: string,
): Promise<RoomState> {
	const connections = Object.values(room.connections);
	return {
		token,
		spec: decodeToken(token),
		label: room.label,
		allowNames: room.allowNames,
		persistent: room.persistent,
		createdAt: room.createdAt,
		layout: room.layout,
		layoutAt: room.layoutAt,
		viewers: Object.values(room.viewers).sort((a, b) => a.at - b.at),
		cursor: await bus.head(roomTopic(token)),
		phonesConnected: connections.filter((c) => c.role === "phone").length,
		displaysConnected: connections.filter((c) => c.role === "display").length,
	};
}

// ---------------------------------------------------------------------------
// The commons
// ---------------------------------------------------------------------------

export async function recordGhost(store: Store, pose: WirePose, now: number): Promise<void> {
	const ghost: Ghost = {
		az: round(pose.az, 1),
		el: round(pose.el, 1),
		dh: round(pose.dh, 2),
		at: now,
	};
	await store.listAppend(GHOSTS_KEY, ghost, { maxLength: MAX_GHOSTS });
	await store.increment(GHOST_COUNT_KEY, 1, PERSISTENT_TTL_MS);
}

export async function readGhosts(store: Store, limit: number): Promise<Ghost[]> {
	const all = await store.listAll<Ghost>(GHOSTS_KEY);
	if (all.length <= limit) return all;
	// Keep the most recent, which is also what decays the oldest out of the view.
	return all.slice(all.length - limit);
}

// ---------------------------------------------------------------------------
// The calibration commons
// ---------------------------------------------------------------------------

interface StoredCalibration {
	mmPerCssPx?: number;
	focalOverWidth?: number;
	at: number;
}

export async function addCalibration(
	store: Store,
	sample: CalibrationSample,
	now: number,
): Promise<void> {
	const entry: StoredCalibration = { at: now };
	if (typeof sample.mmPerCssPx === "number" && sample.mmPerCssPx > 0.05 && sample.mmPerCssPx < 2) {
		entry.mmPerCssPx = round(sample.mmPerCssPx, 5);
	}
	if (
		typeof sample.focalOverWidth === "number" &&
		sample.focalOverWidth > 0.3 &&
		sample.focalOverWidth < 4
	) {
		entry.focalOverWidth = round(sample.focalOverWidth, 5);
	}
	if (entry.mmPerCssPx === undefined && entry.focalOverWidth === undefined) return;
	await store.listAppend(calibrationKey(sample.signature), entry, {
		maxLength: 400,
		ttlMs: PERSISTENT_TTL_MS,
	});
}

/**
 * Median and median-absolute-deviation, never the mean.
 *
 * One person with a mis-set browser zoom, or one bad card match, would drag a
 * mean far enough to matter. The aggregate is also withheld below
 * CALIBRATION_MIN_SAMPLES, which makes it k-anonymous by construction rather
 * than by policy: an estimate that needs five contributors cannot be read back
 * as any one contributor's screen.
 */
function summarise(values: number[]): { median: number; mad: number; n: number } | null {
	if (values.length < CALIBRATION_MIN_SAMPLES) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const median = quantile(sorted, 0.5);
	const deviations = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
	return { median, mad: quantile(deviations, 0.5), n: values.length };
}

function quantile(sorted: number[], q: number): number {
	if (sorted.length === 0) return Number.NaN;
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	if (lo === hi) return sorted[lo]!;
	return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export async function estimateCalibration(
	store: Store,
	signature: string,
): Promise<CalibrationEstimate> {
	const samples = await store.listAll<StoredCalibration>(calibrationKey(signature));
	const mm = summarise(
		samples.map((s) => s.mmPerCssPx).filter((v): v is number => typeof v === "number"),
	);
	const focal = summarise(
		samples.map((s) => s.focalOverWidth).filter((v): v is number => typeof v === "number"),
	);
	// Dispersion too wide means the signature covers genuinely different
	// hardware -- an external monitor, a scaled resolution -- so say nothing.
	const usableMm = mm && mm.mad / mm.median < 0.08 ? mm : null;
	const usableFocal = focal && focal.mad / focal.median < 0.1 ? focal : null;
	return {
		signature,
		mmPerCssPx: usableMm,
		focalOverWidth: usableFocal,
		offered: Boolean(usableMm || usableFocal),
	};
}
