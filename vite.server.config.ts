import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * The production server bundle. One Node process, one port. Dependencies stay
 * external so Railway's `npm ci --omit=dev` provides them.
 */
export default defineConfig({
	resolve: {
		alias: {
			"@core": fileURLToPath(new URL("./src/core", import.meta.url)),
			"@server": fileURLToPath(new URL("./src/server", import.meta.url)),
			"@storage": fileURLToPath(new URL("./src/storage", import.meta.url)),
		},
	},
	ssr: {
		target: "node",
		noExternal: [],
	},
	build: {
		ssr: "src/server/index.ts",
		outDir: "dist/server",
		emptyOutDir: true,
		target: "node24",
		sourcemap: true,
		minify: false,
		rollupOptions: {
			output: { entryFileNames: "index.js", format: "esm" },
		},
	},
});
