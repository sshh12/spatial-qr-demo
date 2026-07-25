import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { assertReplicaSafety } from "@storage/ports.ts";
import type { Hono } from "hono";
import { createApp } from "./app.ts";
import { createPorts } from "./ports.ts";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, "../client");
const indexHtmlPath = join(clientDir, "index.html");

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const numReplicas = Number.parseInt(process.env.NUM_REPLICAS ?? "1", 10);

const ports = createPorts(process.env);

// Crash loudly rather than serve a deployment whose only symptom is that the
// page silently never updates.
assertReplicaSafety(ports, numReplicas);

const indexHtml = existsSync(indexHtmlPath) ? readFileSync(indexHtmlPath, "utf8") : null;

function mountStatic(app: Hono): void {
	if (!indexHtml) {
		app.get("/", (c) =>
			c.text(
				"Client bundle not found. Run `npm run build:client` first, or use `npm run dev`.",
				503,
			),
		);
		return;
	}
	app.use(
		"/assets/*",
		serveStatic({
			root: relativeFromCwd(clientDir),
			// Hashed filenames, so they can be cached hard.
			onFound: (_path, c) => {
				c.header("Cache-Control", "public, max-age=31536000, immutable");
			},
		}),
	);
	app.use("/*", serveStatic({ root: relativeFromCwd(clientDir) }));

	// SPA fallback. Every client route is one page load by design -- iOS revokes
	// "Allow Once" camera permission on navigation, so the capture flow must
	// never reload.
	app.get("*", (c) => c.html(indexHtml));
}

function relativeFromCwd(absolute: string): string {
	const rel = resolve(absolute)
		.slice(resolve(process.cwd()).length + 1)
		.replace(/\\/g, "/");
	return rel.length > 0 ? `./${rel}` : ".";
}

const app = createApp({
	...ports,
	baseUrl: process.env.BASE_URL,
	commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
	serveStatic: mountStatic,
});

// Railway relocates workloads to rebalance compute, so in-memory state dies at
// unpredictable moments. Sweeping keeps that from also meaning unbounded growth.
const sweeper = setInterval(() => {
	void ports.store.sweep();
	void (ports.bus as { sweep?: () => Promise<void> }).sweep?.();
}, 60_000);
sweeper.unref?.();

const server = serve({
	fetch: app.fetch,
	port,
	// Binding anything but 0.0.0.0 is the single most common cause of Railway's
	// "Application failed to respond".
	hostname: "0.0.0.0",
});

console.log(
	`spatial-qr listening on 0.0.0.0:${port} ` +
		`(store=${ports.store.name}, bus=${ports.bus.name}, replicas=${numReplicas})`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		clearInterval(sweeper);
		server.close(() => {
			void ports.store.close();
			void ports.bus.close();
			process.exit(0);
		});
	});
}
