import { getRequestListener } from "@hono/node-server";
import { createMemoryPorts } from "@storage/memory.ts";
import type { Ports } from "@storage/ports.ts";
import { createApp } from "./app.ts";

/**
 * Dev-server entry.
 *
 * Vite re-evaluates this module whenever server code changes, so the ports are
 * parked on globalThis. Without that, every edit would silently wipe the room
 * you were mid-way through testing on your phone.
 */
const key = Symbol.for("spatial-qr.dev.ports");
const globals = globalThis as unknown as Record<symbol, Ports | undefined>;
const ports = globals[key] ?? createMemoryPorts();
globals[key] = ports;

export const listener = getRequestListener(
	createApp({ ...ports, baseUrl: process.env.BASE_URL, commit: "dev" }).fetch,
);
