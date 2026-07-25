const CLIENT_ID_KEY = "sqr.clientId";
const OWNER_PREFIX = "sqr.owner.";
const ROOMS_KEY = "sqr.rooms";
const CALIBRATION_KEY = "sqr.calibration";

function safeStorage(): Storage | null {
	try {
		const s = globalThis.localStorage;
		s.getItem("__probe__");
		return s;
	} catch {
		// Private mode, embedded webviews with storage blocked, and Lockdown Mode
		// all land here. Losing persistence is fine; throwing is not.
		return null;
	}
}

const TAB_ROOM_KEY = "sqr.tabRoom";

/**
 * The landing page's room, remembered per tab.
 *
 * `sessionStorage`, not `localStorage`, and the distinction is the whole design:
 * a tab is a screen. Two tabs are two screens and must not fight over one room;
 * one tab reloaded is still the same screen, and minting a new room there would
 * silently orphan any phone that had already scanned the old code -- the swap
 * would simply never arrive, with nothing to indicate why.
 */
export function tabRoom(): string | null {
	try {
		return globalThis.sessionStorage?.getItem(TAB_ROOM_KEY) ?? null;
	} catch {
		return null;
	}
}

export function setTabRoom(token: string): void {
	try {
		globalThis.sessionStorage?.setItem(TAB_ROOM_KEY, token);
	} catch {
		// Private mode or a webview with storage blocked. The room still works for
		// as long as the page stays loaded, which is the common case anyway.
	}
}

export function clientId(): string {
	const store = safeStorage();
	const existing = store?.getItem(CLIENT_ID_KEY);
	if (existing) return existing;
	const minted = crypto.randomUUID();
	store?.setItem(CLIENT_ID_KEY, minted);
	return minted;
}

export function ownerToken(token: string): string | null {
	return safeStorage()?.getItem(OWNER_PREFIX + token) ?? null;
}

export function mintOwnerToken(token: string): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	const value = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
	safeStorage()?.setItem(OWNER_PREFIX + token, value);
	return value;
}

export interface RememberedRoom {
	readonly token: string;
	readonly label: string | null;
	readonly at: number;
}

export function rememberRoom(room: RememberedRoom): void {
	const store = safeStorage();
	if (!store) return;
	const existing = listRooms().filter((r) => r.token !== room.token);
	store.setItem(ROOMS_KEY, JSON.stringify([room, ...existing].slice(0, 20)));
}

export function listRooms(): RememberedRoom[] {
	try {
		const raw = safeStorage()?.getItem(ROOMS_KEY);
		return raw ? (JSON.parse(raw) as RememberedRoom[]) : [];
	} catch {
		return [];
	}
}

export interface StoredCalibration {
	/** Millimetres per CSS pixel on this display. */
	readonly mmPerCssPx: number;
	readonly source: "measured" | "estimated" | "commons";
	readonly at: number;
}

export function loadCalibration(): StoredCalibration | null {
	try {
		const raw = safeStorage()?.getItem(CALIBRATION_KEY);
		return raw ? (JSON.parse(raw) as StoredCalibration) : null;
	} catch {
		return null;
	}
}

export function saveCalibration(value: StoredCalibration): void {
	safeStorage()?.setItem(CALIBRATION_KEY, JSON.stringify(value));
}

/**
 * A coarse device signature for the calibration commons.
 *
 * Deliberately low-entropy: platform bucket, screen size in CSS pixels, and
 * device pixel ratio rounded to one decimal. That is enough to say "phones like
 * yours usually measure 0.157 mm per CSS pixel" and not enough to pick anyone
 * out of a crowd. No canvas, no fonts, no WebGL strings, no user-agent string.
 */
export function deviceSignature(): string {
	if (typeof screen === "undefined") return "unknown";
	const platform = /android/i.test(navigator.userAgent)
		? "android"
		: /iphone|ipad|ipod/i.test(navigator.userAgent)
			? "ios"
			: "desktop";
	const w = Math.max(screen.width, screen.height);
	const h = Math.min(screen.width, screen.height);
	const dpr = Math.round((globalThis.devicePixelRatio || 1) * 10) / 10;
	return `${platform}|${w}x${h}|${dpr}`;
}
