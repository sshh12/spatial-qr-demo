import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = {
	"@core": fileURLToPath(new URL("./src/core", import.meta.url)),
	"@client": fileURLToPath(new URL("./src/client", import.meta.url)),
	"@server": fileURLToPath(new URL("./src/server", import.meta.url)),
	"@storage": fileURLToPath(new URL("./src/storage", import.meta.url)),
};

export default defineConfig({
	test: {
		projects: [
			{
				resolve: { alias },
				test: {
					name: "l1",
					environment: "node",
					include: ["tests/l1/**/*.test.ts", "tests/unit/**/*.test.ts"],
					testTimeout: 30_000,
				},
			},
			{
				resolve: { alias },
				test: {
					name: "l2",
					environment: "node",
					include: ["tests/l2/**/*.test.ts"],
					testTimeout: 900_000,
					hookTimeout: 120_000,
					// The sweep is CPU-bound and already batched; one worker keeps the
					// numbers reproducible and the wasm instance warm.
					pool: "forks",
					maxWorkers: 1,
					fileParallelism: false,
				},
			},
		],
	},
});
