import type {
	CalibrationEstimate,
	CalibrationSample,
	ClaimRequest,
	GhostsResponse,
	HelloResponse,
	RoomState,
	Viewer,
	ViewerRole,
	WirePose,
} from "@core/api.ts";
import type { MarkerLayout } from "@core/marker.ts";
import type { BusEvent } from "@storage/ports.ts";

async function postJson<T>(path: string, body: unknown): Promise<T> {
	const res = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new ApiError(res.status, detail || res.statusText);
	}
	return (await res.json()) as T;
}

export class ApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

export const api = {
	hello: (token: string, role: ViewerRole, clientId: string) =>
		postJson<HelloResponse>(`/api/s/${token}/hello`, { role, clientId }),

	layout: (token: string, clientId: string, layout: MarkerLayout) =>
		postJson<{ ok: true }>(`/api/s/${token}/layout`, { clientId, layout }),

	armed: (token: string) => postJson<{ ok: true }>(`/api/s/${token}/armed`, {}),

	capturing: (token: string) => postJson<{ ok: true }>(`/api/s/${token}/capturing`, {}),

	pose: (
		token: string,
		clientId: string,
		pose: WirePose,
		extra: { name?: string; ambiguous?: boolean; contribute?: boolean } = {},
		// The viewer comes back clamped and with a server-derived tier. When a
		// scan redirects onward, those are the numbers that travel -- so what a
		// destination receives is exactly what the room recorded, never a
		// second opinion computed on the phone.
	) => postJson<{ ok: true; viewer: Viewer }>(`/api/s/${token}/pose`, { clientId, pose, ...extra }),

	leave: (token: string, clientId: string) =>
		postJson<{ ok: true }>(`/api/s/${token}/leave`, { clientId }),

	claim: (token: string, ownerToken: string, options: Omit<ClaimRequest, "ownerToken"> = {}) =>
		postJson<{ ok: true; room: RoomState }>(`/api/s/${token}/claim`, { ownerToken, ...options }),

	clear: (token: string, ownerToken: string) =>
		postJson<{ ok: true }>(`/api/s/${token}/clear`, { ownerToken }),

	state: async (token: string, since?: number) => {
		const query = since === undefined ? "" : `?since=${since}`;
		const res = await fetch(`/api/s/${token}/state${query}`);
		if (!res.ok) throw new ApiError(res.status, res.statusText);
		return (await res.json()) as { room: RoomState; events: BusEvent[] };
	},

	ghosts: async (limit = 600) => {
		const res = await fetch(`/api/ghosts?limit=${limit}`);
		if (!res.ok) throw new ApiError(res.status, res.statusText);
		return (await res.json()) as GhostsResponse;
	},

	calibration: async (signature: string) => {
		const res = await fetch(`/api/calibration/${encodeURIComponent(signature)}`);
		if (!res.ok) throw new ApiError(res.status, res.statusText);
		return (await res.json()) as CalibrationEstimate;
	},

	contributeCalibration: (sample: CalibrationSample) =>
		postJson<{ ok: true }>("/api/calibration", sample),
};

/** Fire-and-forget, and specifically one that survives the page going away. */
export function beaconLeave(token: string, clientId: string): void {
	const body = JSON.stringify({ clientId });
	if (navigator.sendBeacon) {
		navigator.sendBeacon(`/api/s/${token}/leave`, new Blob([body], { type: "application/json" }));
		return;
	}
	void fetch(`/api/s/${token}/leave`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
		keepalive: true,
	}).catch(() => {});
}
