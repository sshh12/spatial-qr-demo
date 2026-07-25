import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** Paths owned by the Hono app. Everything else is the SPA. */
const API_PREFIX = /^\/(api\/|healthz$|healthz\?|og\/)/;

/**
 * Mounts the real Hono app inside the Vite dev server so dev and prod share one
 * routing table and one origin. The store is stashed on globalThis so that
 * ssrLoadModule re-evaluations (HMR of server code) do not wipe live sessions.
 */
function honoDev(): Plugin {
	return {
		name: "spatial-qr:hono-dev",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const url = req.url ?? "/";
				if (!API_PREFIX.test(url)) return next();
				server
					.ssrLoadModule("/src/server/dev-entry.ts")
					.then((mod) => {
						(mod as { listener: (a: unknown, b: unknown) => void }).listener(req, res);
					})
					.catch((err) => {
						server.ssrFixStacktrace(err as Error);
						next(err);
					});
			});
		},
	};
}

export default defineConfig({
	plugins: [react(), tailwindcss(), honoDev()],
	resolve: {
		alias: {
			"@core": fileURLToPath(new URL("./src/core", import.meta.url)),
			"@client": fileURLToPath(new URL("./src/client", import.meta.url)),
			"@server": fileURLToPath(new URL("./src/server", import.meta.url)),
			"@storage": fileURLToPath(new URL("./src/storage", import.meta.url)),
		},
	},
	build: {
		outDir: "dist/client",
		emptyOutDir: true,
		target: "es2022",
		sourcemap: true,
		reportCompressedSize: true,
		rollupOptions: {
			output: {
				// Chunk control has been renamed twice on the way to Vite 8: rollup's
				// `manualChunks` became rolldown's `advancedChunks`, which is now
				// `codeSplitting`. On a Three.js + WASM app this is the single biggest
				// bundle risk, so it is worth being explicit rather than inheriting a
				// default.
				codeSplitting: {
					groups: [
						{ name: "zxing", test: /node_modules[\\/]zxing-wasm[\\/]/ },
						{ name: "three", test: /node_modules[\\/](three|@react-three)[\\/]/ },
						{ name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
					],
				},
			},
		},
	},
	server: {
		host: true,
		port: 5173,
	},
	preview: { port: 4173 },
});
