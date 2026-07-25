import type {
	CalibrationSample,
	HelloRequest,
	HelloResponse,
	PoseRequest,
	Viewer,
} from "@core/api.ts";
import type { MarkerLayout } from "@core/marker.ts";
import { decodeToken, TokenError } from "@core/token.ts";
import type { Ports } from "@storage/ports.ts";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import {
	addCalibration,
	claimDisplay,
	clampPose,
	estimateCalibration,
	GHOST_COUNT_KEY,
	identityFor,
	loadRoom,
	pruneViewers,
	readGhosts,
	recordGhost,
	roomTopic,
	sanitiseName,
	saveRoom,
	tierFromPose,
	toRoomState,
} from "./domain.ts";

export interface AppOptions extends Ports {
	/** Explicit override. Normally the request's Host header is authoritative. */
	readonly baseUrl?: string;
	readonly now?: () => number;
	/** Writes allowed per IP per minute. */
	readonly writeRateLimit?: number;
	/** Concurrent event streams allowed per IP. */
	readonly streamLimit?: number;
	/** Serves the built client from disk in production. */
	readonly serveStatic?: (app: Hono) => void;
	readonly commit?: string;
}

const SSE_RETRY_MS = 2000;
const HEARTBEAT_MS = 20_000;
const MAX_BODY_BYTES = 8 * 1024;

/**
 * `createApp` is a pure function of its ports.
 *
 * No module-level state, no listening socket, no environment reads. The whole
 * API surface is therefore testable through `app.request()` without binding a
 * port, and the dev server mounts the very same object the production process
 * does, so there is one routing table rather than two that drift.
 */
export function createApp(options: AppOptions): Hono {
	const { store, bus } = options;
	const now = options.now ?? (() => Date.now());
	const writeRateLimit = options.writeRateLimit ?? 120;
	const streamLimit = options.streamLimit ?? 12;
	const streamsByIp = new Map<string, number>();

	const app = new Hono();

	app.use(
		"*",
		secureHeaders({
			// A camera-geometry demo has no business inside someone else's frame.
			xFrameOptions: "DENY",
			crossOriginEmbedderPolicy: false,
			contentSecurityPolicy: {
				defaultSrc: ["'self'"],
				scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
				styleSrc: ["'self'", "'unsafe-inline'"],
				imgSrc: ["'self'", "data:", "blob:"],
				mediaSrc: ["'self'", "blob:"],
				connectSrc: ["'self'"],
				workerSrc: ["'self'", "blob:"],
				frameAncestors: ["'none'"],
				objectSrc: ["'none'"],
				baseUri: ["'self'"],
			},
		}),
	);

	app.use("*", async (c, next) => {
		c.header("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
		await next();
	});

	// Compression must never see the event stream: a buffered SSE response is an
	// SSE response that never arrives.
	app.use("*", async (c, next) => {
		if (c.req.path.endsWith("/events")) return next();
		return compress()(c, next);
	});

	// -----------------------------------------------------------------------
	// Health
	// -----------------------------------------------------------------------

	app.get("/healthz", (c) =>
		c.json({
			ok: true,
			commit: options.commit ?? "dev",
			store: { name: store.name, ...store.capabilities },
			bus: { name: bus.name, ...bus.capabilities },
		}),
	);

	// -----------------------------------------------------------------------
	// Rooms
	// -----------------------------------------------------------------------

	const api = new Hono();

	const clientIp = (c: { req: { header: (k: string) => string | undefined } }) =>
		(c.req.header("x-forwarded-for") ?? "").split(",")[0]?.trim() ||
		c.req.header("x-real-ip") ||
		"local";

	const limitWrites = async (
		c: Parameters<Parameters<Hono["use"]>[1]>[0],
		next: () => Promise<void>,
	) => {
		const ip = clientIp(c);
		const count = await store.increment(`rate:${ip}`, 1, 60_000);
		if (count > writeRateLimit) {
			return c.json({ error: "rate-limited" }, 429);
		}
		return next();
	};

	async function readJson<T>(c: { req: { text: () => Promise<string> } }): Promise<T | null> {
		const text = await c.req.text();
		if (text.length > MAX_BODY_BYTES) return null;
		try {
			return JSON.parse(text) as T;
		} catch {
			return null;
		}
	}

	function requireToken(token: string): string | null {
		try {
			decodeToken(token);
			return token.toUpperCase();
		} catch (err) {
			if (err instanceof TokenError) return null;
			throw err;
		}
	}

	api.post("/s/:token/hello", limitWrites, async (c) => {
		const token = requireToken(c.req.param("token"));
		if (!token) return c.json({ error: "bad-token" }, 400);
		const body = await readJson<HelloRequest>(c);
		if (!body || (body.role !== "phone" && body.role !== "display")) {
			return c.json({ error: "bad-request" }, 400);
		}

		const at = now();
		const clientId = body.clientId?.slice(0, 64) || crypto.randomUUID();
		const room = await loadRoom(store, token, at);
		pruneViewers(room, at);

		// One display per room. A second, different one means two strangers' random
		// tokens collided, and admitting both would let one person's phone take
		// over the other's screen. The newcomer is told to mint a fresh token; the
		// display that arrived first is never disturbed.
		if (body.role === "display" && claimDisplay(room, clientId, at) === "collision") {
			await saveRoom(store, room);
			return c.json({ collision: true, clientId });
		}

		room.connections[clientId] = { role: body.role, at };
		await saveRoom(store, room);

		if (body.role === "phone") {
			await bus.publish(roomTopic(token), "phone-connected", { clientId }, { ttlMs: 4 * 3600_000 });
		}

		const response: HelloResponse = {
			clientId,
			collision: false,
			room: await toRoomState(room, bus, token),
			origin: resolveOrigin(
				c.req.header("host"),
				c.req.header("x-forwarded-proto"),
				options.baseUrl,
			),
		};
		return c.json(response);
	});

	/** The display tells the phone exactly what is on screen. */
	api.post("/s/:token/layout", limitWrites, async (c) => {
		const token = requireToken(c.req.param("token"));
		if (!token) return c.json({ error: "bad-token" }, 400);
		const body = await readJson<{ clientId: string; layout: MarkerLayout }>(c);
		if (!body?.layout) return c.json({ error: "bad-request" }, 400);

		const at = now();
		const room = await loadRoom(store, token, at);
		pruneViewers(room, at);
		room.layout = body.layout;
		room.layoutAt = at;
		room.connections[body.clientId ?? "display"] = { role: "display", at };
		await saveRoom(store, room);
		await bus.publish(roomTopic(token), "layout", body.layout);
		return c.json({ ok: true, at });
	});

	/** The shutter beat: the display flashes because the phone is capturing now. */
	api.post("/s/:token/capturing", limitWrites, async (c) => {
		const token = requireToken(c.req.param("token"));
		if (!token) return c.json({ error: "bad-token" }, 400);
		await bus.publish(roomTopic(token), "capturing", { at: now() });
		return c.json({ ok: true });
	});

	api.post("/s/:token/armed", limitWrites, async (c) => {
		const token = requireToken(c.req.param("token"));
		if (!token) return c.json({ error: "bad-token" }, 400);
		await bus.publish(roomTopic(token), "phone-armed", { at: now() });
		return c.json({ ok: true });
	});

	api.post("/s/:token/pose", limitWrites, async (c) => {
		const token = requireToken(c.req.param("token"));
		if (!token) return c.json({ error: "bad-token" }, 400);
		const body = await readJson<PoseRequest>(c);
		if (!body?.clientId || !body.pose) return c.json({ error: "bad-request" }, 400);

		const pose = clampPose(body.pose);
		if (!pose) return c.json({ error: "implausible-pose" }, 422);
		const tier = tierFromPose(pose);
		if (tier === "refused") return c.json({ error: "below-confidence-floor" }, 422);

		const at = now();
		const room = await loadRoom(store, token, at);
		pruneViewers(room, at);

		const viewer: Viewer = {
			id: body.clientId.slice(0, 64),
			name: sanitiseName(body.name, room.allowNames),
			...identityFor(body.clientId),
			pose,
			tier,
			ambiguous: Boolean(body.ambiguous),
			at,
		};
		room.viewers[viewer.id] = viewer;
		await saveRoom(store, room);
		await bus.publish(roomTopic(token), "pose", viewer);

		// Only solid-tier solves feed the commons, or the aggregate is poisoned by
		// exactly the captures the gate already decided not to trust.
		if (body.contribute !== false && tier === "solid") {
			await recordGhost(store, pose, at);
		}
		return c.json({ ok: true, viewer });
	});

	api.post("/s/:token/leave", limitWrites, async (c) => {
		const token = requireToken(c.req.param("token"));
		if (!token) return c.json({ error: "bad-token" }, 400);
		const body = await readJson<{ clientId: string }>(c);
		if (!body?.clientId) return c.json({ error: "bad-request" }, 400);
		const at = now();
		const room = await loadRoom(store, token, at);
		delete room.viewers[body.clientId];
		delete room.connections[body.clientId];
		await saveRoom(store, room);
		await bus.publish(roomTopic(token), "viewer-left", { clientId: body.clientId });
		return c.json({ ok: true });
	});

	/** Room creation: label, names opt-in, and an owner token the creator holds. */
	api.post("/s/:token/claim", limitWrites, async (c) => {
		const token = requireToken(c.req.param("token"));
		if (!token) return c.json({ error: "bad-token" }, 400);
		const body = await readJson<{
			ownerToken: string;
			label?: string;
			allowNames?: boolean;
		}>(c);
		if (!body?.ownerToken || body.ownerToken.length < 16) {
			return c.json({ error: "bad-request" }, 400);
		}

		const at = now();
		const room = await loadRoom(store, token, at);
		const hash = await hashOwnerToken(body.ownerToken);
		if (room.ownerTokenHash && room.ownerTokenHash !== hash) {
			return c.json({ error: "already-claimed" }, 403);
		}
		room.ownerTokenHash = hash;
		room.persistent = true;
		room.label = sanitiseName(body.label, true);
		room.allowNames = Boolean(body.allowNames);
		await saveRoom(store, room);
		return c.json({ ok: true, room: await toRoomState(room, bus, token) });
	});

	/** The owner's kill switch. */
	api.post("/s/:token/clear", limitWrites, async (c) => {
		const token = requireToken(c.req.param("token"));
		if (!token) return c.json({ error: "bad-token" }, 400);
		const body = await readJson<{ ownerToken: string }>(c);
		if (!body?.ownerToken) return c.json({ error: "bad-request" }, 400);
		const at = now();
		const room = await loadRoom(store, token, at);
		if (!room.ownerTokenHash || room.ownerTokenHash !== (await hashOwnerToken(body.ownerToken))) {
			return c.json({ error: "forbidden" }, 403);
		}
		room.viewers = {};
		await saveRoom(store, room);
		await bus.publish(roomTopic(token), "room-cleared", {});
		return c.json({ ok: true });
	});

	/**
	 * The polling fallback.
	 *
	 * This is not only for locked-down networks. It is also the deterministic,
	 * non-racing path the end-to-end tests drive, because asserting on an SSE
	 * stream from Playwright means asserting on a race.
	 */
	api.get("/s/:token/state", async (c) => {
		const token = requireToken(c.req.param("token"));
		if (!token) return c.json({ error: "bad-token" }, 400);
		const at = now();
		const room = await loadRoom(store, token, at);
		pruneViewers(room, at);
		const since = Number.parseInt(c.req.query("since") ?? "", 10);
		const events = Number.isFinite(since) ? await bus.since(roomTopic(token), since) : [];
		return c.json({
			room: await toRoomState(room, bus, token),
			events,
		});
	});

	api.get("/s/:token/events", async (c) => {
		const token = requireToken(c.req.param("token"));
		if (!token) return c.json({ error: "bad-token" }, 400);

		const ip = clientIp(c);
		const open = streamsByIp.get(ip) ?? 0;
		if (open >= streamLimit) return c.json({ error: "too-many-streams" }, 429);

		// nginx and friends buffer text/event-stream unless told not to.
		c.header("X-Accel-Buffering", "no");
		c.header("Cache-Control", "no-cache, no-transform");

		const lastEventId = Number.parseInt(
			c.req.header("Last-Event-ID") ?? c.req.query("lastEventId") ?? "",
			10,
		);

		return streamSSE(c, async (stream) => {
			streamsByIp.set(ip, open + 1);
			const topic = roomTopic(token);
			const queue: { id: number; type: string; data: unknown }[] = [];
			let notify: (() => void) | null = null;

			const unsubscribe = bus.subscribe(topic, (event) => {
				queue.push({ id: event.id, type: event.type, data: event.data });
				notify?.();
			});

			stream.onAbort(() => {
				unsubscribe();
				streamsByIp.set(ip, Math.max(0, (streamsByIp.get(ip) ?? 1) - 1));
				notify?.();
			});

			try {
				// An explicit retry hint plus client-side jitter is what keeps a
				// thundering herd of reconnects from arriving in lockstep.
				await stream.writeSSE({
					data: String(SSE_RETRY_MS),
					event: "retry-hint",
					retry: SSE_RETRY_MS,
				});

				if (Number.isFinite(lastEventId)) {
					for (const missed of await bus.since(topic, lastEventId)) {
						await stream.writeSSE({
							id: String(missed.id),
							event: missed.type,
							data: JSON.stringify(missed.data),
						});
					}
				}

				let lastBeat = now();
				while (!stream.aborted) {
					while (queue.length > 0) {
						const event = queue.shift()!;
						await stream.writeSSE({
							id: String(event.id),
							event: event.type,
							data: JSON.stringify(event.data),
						});
					}
					if (stream.aborted) break;
					if (now() - lastBeat >= HEARTBEAT_MS) {
						await stream.writeSSE({ data: "", event: "heartbeat" });
						lastBeat = now();
					}
					await new Promise<void>((resolve) => {
						const timer = setTimeout(() => {
							notify = null;
							resolve();
						}, 1000);
						notify = () => {
							clearTimeout(timer);
							notify = null;
							resolve();
						};
					});
				}
			} finally {
				unsubscribe();
				streamsByIp.set(ip, Math.max(0, (streamsByIp.get(ip) ?? 1) - 1));
			}
		});
	});

	// -----------------------------------------------------------------------
	// The commons
	// -----------------------------------------------------------------------

	api.get("/ghosts", async (c) => {
		const limit = Math.min(
			2000,
			Math.max(1, Number.parseInt(c.req.query("limit") ?? "600", 10) || 600),
		);
		const ghosts = await readGhosts(store, limit);
		const total = (await store.get<number>(GHOST_COUNT_KEY)) ?? ghosts.length;
		return c.json({ ghosts, total });
	});

	api.get("/calibration/:signature", async (c) => {
		const signature = c.req.param("signature").slice(0, 120);
		return c.json(await estimateCalibration(store, signature));
	});

	api.post("/calibration", limitWrites, async (c) => {
		const body = await readJson<CalibrationSample>(c);
		if (!body?.signature) return c.json({ error: "bad-request" }, 400);
		await addCalibration(store, { ...body, signature: body.signature.slice(0, 120) }, now());
		return c.json({ ok: true });
	});

	app.route("/api", api);

	// -----------------------------------------------------------------------
	// Share cards
	// -----------------------------------------------------------------------

	app.get("/og/:token", async (c) => {
		const raw = c.req.param("token").replace(/\.svg$/i, "");
		const token = requireToken(raw);
		if (!token) return c.text("bad token", 400);
		const room = await loadRoom(store, token, now());
		const viewers = Object.values(room.viewers).filter((v) => v.pose);
		return c.body(shareCard(token, viewers, room.label), 200, {
			"Content-Type": "image/svg+xml",
			"Cache-Control": "public, max-age=60",
		});
	});

	/**
	 * Redirect the shouting form of a scanned URL to a quiet one.
	 *
	 * The QR payload is uppercase throughout so that it stays inside QR's
	 * alphanumeric character set, which has no lowercase at all. That is a real
	 * saving -- byte mode costs about 45% of the payload capacity and pushes the
	 * symbol up a version or two -- but it means the address a phone opens is
	 * `/S/040YP...`, and the first thing a visitor sees is their own address bar
	 * yelling. CONCEPT.md section 5 calls for this redirect; it happens before the
	 * static handler and before any camera permission exists, so the navigation
	 * costs nothing.
	 */
	app.get("/:prefix{[sSdD]}/:token{[0-9A-Za-z]+}", (c, next) => {
		const prefix = c.req.param("prefix");
		const token = c.req.param("token");
		const canonical = `/${prefix.toLowerCase()}/${token.toLowerCase()}`;
		if (c.req.path === canonical) return next();
		const query = new URL(c.req.url).search;
		return c.redirect(canonical + query, 302);
	});

	options.serveStatic?.(app);

	app.notFound((c) => {
		if (c.req.path.startsWith("/api/")) return c.json({ error: "not-found" }, 404);
		return c.text("Not found", 404);
	});

	return app;
}

/**
 * The request's Host is the source of truth; BASE_URL only overrides it.
 *
 * This is what makes a tunnel URL or a preview deployment work with no
 * environment edit, and keeps absolute og:image URLs correct on every origin
 * the app is reachable at rather than only the one someone remembered to
 * configure.
 */
export function resolveOrigin(
	host: string | undefined,
	forwardedProto: string | undefined,
	override: string | undefined,
): string {
	if (override) return override.replace(/\/+$/, "");
	if (!host) return "http://localhost:3000";
	const proto =
		forwardedProto?.split(",")[0]?.trim() ??
		(host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
	return `${proto}://${host}`;
}

async function hashOwnerToken(token: string): Promise<string> {
	const bytes = new TextEncoder().encode(`spatial-qr:${token}`);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function shareCard(token: string, viewers: Viewer[], label: string | null): string {
	const W = 1200;
	const H = 630;
	const cx = W / 2;
	const cy = H * 0.86;
	const scale = H * 0.13;

	const dots = viewers
		.slice(-40)
		.map((v) => {
			const az = ((v.pose?.az ?? 0) * Math.PI) / 180;
			const d = v.pose?.dh ?? 1;
			const x = cx + Math.sin(az) * d * scale;
			const y = cy - Math.cos(az) * d * scale;
			const colour = `hsl(${v.hue} 70% 62%)`;
			return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="${colour}" opacity="0.92"/>`;
		})
		.join("");

	const arcs = [1, 2, 3, 4]
		.map(
			(r) =>
				`<path d="M ${cx - r * scale} ${cy} A ${r * scale} ${r * scale} 0 0 1 ${cx + r * scale} ${cy}" fill="none" stroke="#2a2a31" stroke-width="1.5"/>` +
				`<text x="${cx + r * scale + 6}" y="${cy - 4}" fill="#55555f" font-size="15" font-family="monospace">${r}h</text>`,
		)
		.join("");

	const headline =
		viewers.length === 1 ? "1 camera position" : `${viewers.length} camera positions`;

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">
<rect width="${W}" height="${H}" fill="#08080a"/>
<text x="64" y="92" fill="#f4f4f6" font-size="42">Camera positions measured from a QR code</text>
<text x="64" y="136" fill="#8a8a94" font-size="21">${escapeXml(label ?? "spatial-qr")} &#183; ${escapeXml(headline)}</text>
<rect x="${cx - H * 0.16}" y="${cy - 16}" width="${H * 0.32}" height="9" rx="3" fill="#e8e8ea"/>
<text x="${cx}" y="${cy - 28}" fill="#8a8a94" font-size="15" text-anchor="middle">the display</text>
${arcs}
${dots}
<text x="64" y="${H - 42}" fill="#55555f" font-size="16">distance in display heights &#183; angles to a degree or two &#183; ${escapeXml(token)}</text>
</svg>`;
}

function escapeXml(s: string): string {
	return s.replace(/[<>&"]/g, (c) => `&${{ "<": "lt", ">": "gt", "&": "amp", '"': "quot" }[c]};`);
}
