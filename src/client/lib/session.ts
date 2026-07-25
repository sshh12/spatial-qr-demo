import type { RoomState, ServerEventType, Viewer } from "@core/api.ts";
import type { MarkerLayout } from "@core/marker.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";

export type ConnectionState = "connecting" | "live" | "polling" | "offline";

export interface SessionEvent {
	readonly type: ServerEventType;
	readonly data: unknown;
	readonly id: number;
}

export interface Session {
	readonly room: RoomState | null;
	readonly connection: ConnectionState;
	readonly lastEvent: SessionEvent | null;
	readonly refresh: () => Promise<void>;
}

export interface SessionOptions {
	/**
	 * Forces the polling path. This is the locked-down-network fallback, and it
	 * is also what the end-to-end tests drive, because asserting on a live event
	 * stream from Playwright means asserting on a race.
	 */
	readonly transport?: "auto" | "poll";
	readonly pollMs?: number;
}

/**
 * Subscribes to a room.
 *
 * Two properties matter more than they look. The stream is opened only while the
 * page is visible -- three thousand idle landing-page readers holding open
 * connections is the real scaling risk here, not the handful of people actually
 * scanning. And reconnects carry client-side jitter on top of the server's
 * `retry:` hint, so a restart does not bring everyone back in lockstep.
 */
export function useSession(token: string | null, options: SessionOptions = {}): Session {
	const [room, setRoom] = useState<RoomState | null>(null);
	const [connection, setConnection] = useState<ConnectionState>("connecting");
	const [lastEvent, setLastEvent] = useState<SessionEvent | null>(null);
	const cursor = useRef(0);
	const transport = options.transport ?? "auto";
	const pollMs = options.pollMs ?? 1200;

	const applyEvent = useCallback((event: SessionEvent) => {
		setLastEvent(event);
		cursor.current = Math.max(cursor.current, event.id);
		setRoom((current) => (current ? reduce(current, event) : current));
	}, []);

	const refresh = useCallback(async () => {
		if (!token) return;
		const { room: next, events } = await api.state(token, cursor.current);
		setRoom(next);
		cursor.current = Math.max(cursor.current, next.cursor);
		for (const event of events) {
			setLastEvent({ type: event.type as ServerEventType, data: event.data, id: event.id });
		}
	}, [token]);

	useEffect(() => {
		if (!token) return;
		let cancelled = false;
		let source: EventSource | null = null;
		let pollTimer: ReturnType<typeof setTimeout> | null = null;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

		const startPolling = () => {
			setConnection("polling");
			const tick = async () => {
				if (cancelled) return;
				try {
					const { room: next, events } = await api.state(token, cursor.current);
					if (cancelled) return;
					setRoom(next);
					for (const event of events) {
						applyEvent({ type: event.type as ServerEventType, data: event.data, id: event.id });
					}
					cursor.current = Math.max(cursor.current, next.cursor);
				} catch {
					if (!cancelled) setConnection("offline");
				}
				if (!cancelled) pollTimer = setTimeout(tick, pollMs);
			};
			void tick();
		};

		const startStream = () => {
			if (cancelled || document.visibilityState === "hidden") return;
			const url = `/api/s/${token}/events${cursor.current ? `?lastEventId=${cursor.current}` : ""}`;
			source = new EventSource(url);

			source.addEventListener("open", () => setConnection("live"));
			for (const type of [
				"phone-connected",
				"phone-armed",
				"capturing",
				"pose",
				"layout",
				"viewer-left",
				"room-cleared",
			] as const) {
				source.addEventListener(type, (raw) => {
					const message = raw as MessageEvent<string>;
					let data: unknown = null;
					try {
						data = JSON.parse(message.data);
					} catch {
						data = null;
					}
					applyEvent({ type, data, id: Number.parseInt(message.lastEventId, 10) || 0 });
				});
			}
			source.addEventListener("error", () => {
				source?.close();
				source = null;
				if (cancelled) return;
				setConnection("connecting");
				// Jitter on top of the server's retry hint.
				reconnectTimer = setTimeout(startStream, 1500 + Math.random() * 2500);
			});
		};

		const stop = () => {
			source?.close();
			source = null;
			if (pollTimer) clearTimeout(pollTimer);
			if (reconnectTimer) clearTimeout(reconnectTimer);
			pollTimer = null;
			reconnectTimer = null;
		};

		const start = () => {
			stop();
			if (transport === "poll" || typeof EventSource === "undefined") startPolling();
			else startStream();
		};

		const onVisibility = () => {
			if (document.visibilityState === "hidden") {
				stop();
				setConnection("connecting");
			} else {
				void refresh().catch(() => {});
				start();
			}
		};

		void refresh().catch(() => setConnection("offline"));
		start();
		document.addEventListener("visibilitychange", onVisibility);

		return () => {
			cancelled = true;
			stop();
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [token, transport, pollMs, applyEvent, refresh]);

	return { room, connection, lastEvent, refresh };
}

function reduce(room: RoomState, event: SessionEvent): RoomState {
	switch (event.type) {
		case "pose": {
			const viewer = event.data as Viewer;
			const others = room.viewers.filter((v) => v.id !== viewer.id);
			return { ...room, viewers: [...others, viewer], cursor: event.id };
		}
		case "viewer-left": {
			const { clientId } = event.data as { clientId: string };
			return { ...room, viewers: room.viewers.filter((v) => v.id !== clientId), cursor: event.id };
		}
		case "room-cleared":
			return { ...room, viewers: [], cursor: event.id };
		case "layout":
			return { ...room, layout: event.data as MarkerLayout, cursor: event.id };
		default:
			return { ...room, cursor: Math.max(room.cursor, event.id) };
	}
}
