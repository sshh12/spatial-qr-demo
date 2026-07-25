import { createMemoryPorts, MemoryEventBus, MemoryStore } from "@storage/memory.ts";
import { assertReplicaSafety, ReplicaSafetyError } from "@storage/ports.ts";
import { describe, expect, it } from "vitest";
import { runBusConformance, runStoreConformance } from "../support/storage-conformance.ts";

describe("MemoryStore conformance", () => {
	runStoreConformance((options) => new MemoryStore(options));
});

describe("MemoryEventBus conformance", () => {
	runBusConformance((options) => new MemoryEventBus(options));
});

describe("replica safety", () => {
	it("allows a single replica on in-memory drivers", () => {
		expect(() => assertReplicaSafety(createMemoryPorts(), 1)).not.toThrow();
	});

	it("refuses to boot multiple replicas on in-memory drivers", () => {
		expect(() => assertReplicaSafety(createMemoryPorts(), 2)).toThrow(ReplicaSafetyError);
	});

	it("names both offending drivers so the fix is obvious", () => {
		try {
			assertReplicaSafety(createMemoryPorts(), 3);
			expect.unreachable();
		} catch (err) {
			const message = (err as Error).message;
			expect(message).toContain("NUM_REPLICAS=3");
			expect(message).toContain('store "memory"');
			expect(message).toContain('bus "memory"');
		}
	});

	it("permits multiple replicas when both drivers claim to be shared", () => {
		const ports = createMemoryPorts();
		const shared = { durable: true, sharedAcrossReplicas: true, nativeTtl: true };
		// Stand in for a future Redis adapter by overriding just the two fields
		// the assertion reads; the prototype methods stay intact.
		const store = Object.create(ports.store, {
			name: { value: "redis" },
			capabilities: { value: shared },
		}) as typeof ports.store;
		const bus = Object.create(ports.bus, {
			name: { value: "redis" },
			capabilities: { value: shared },
		}) as typeof ports.bus;
		expect(() => assertReplicaSafety({ store, bus }, 4)).not.toThrow();
	});
});
