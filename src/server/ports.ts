import { createMemoryPorts } from "@storage/memory.ts";
import type { Ports } from "@storage/ports.ts";

/**
 * Driver selection.
 *
 * Only the in-memory driver ships in v1, and non-goal 8 says so out loud. The
 * seam is here, with the capability flags already threaded through, so that
 * adding a Redis adapter is a new file and one case rather than a refactor --
 * and so that adding one without setting `sharedAcrossReplicas` correctly fails
 * at boot instead of in production.
 */
export function createPorts(env: NodeJS.ProcessEnv): Ports {
	const driver = (env.STORAGE_DRIVER ?? "memory").toLowerCase();
	switch (driver) {
		case "memory":
			return createMemoryPorts();
		default:
			throw new Error(`Unknown STORAGE_DRIVER "${driver}". Only "memory" ships in v1; see README.`);
	}
}
