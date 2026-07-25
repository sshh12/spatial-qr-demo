import type { EventBus, Store } from "@storage/ports.ts";
import { expect, it } from "vitest";

/**
 * One conformance suite, run against every driver.
 *
 * The point of the two ports is that a Redis or Postgres adapter can be dropped
 * in without re-reasoning about the server. That only holds if "behaves like the
 * in-memory one" is a thing that can be checked, so it is checked here rather
 * than described in a comment.
 */

export type StoreFactory = (options: { now: () => number }) => Store;

export type BusFactory = (options: { now: () => number }) => EventBus;

export function runStoreConformance(factory: StoreFactory): void {
	let clock = 1_000_000;
	const now = () => clock;
	const make = () => {
		clock = 1_000_000;
		return factory({ now });
	};

	it("round-trips a value", async () => {
		const store = make();
		expect(await store.get("missing")).toBeNull();
		await store.set("a", { hello: "world", n: 3 });
		expect(await store.get("a")).toEqual({ hello: "world", n: 3 });
		await store.close();
	});

	it("returns a copy, so a caller cannot mutate stored state by accident", async () => {
		const store = make();
		const value = { list: [1, 2, 3] };
		await store.set("a", value);
		value.list.push(4);
		const read = await store.get<typeof value>("a");
		expect(read?.list).toEqual([1, 2, 3]);
		read!.list.push(9);
		expect((await store.get<typeof value>("a"))!.list).toEqual([1, 2, 3]);
		await store.close();
	});

	it("expires keys at their TTL", async () => {
		const store = make();
		await store.set("a", 1, 5_000);
		clock += 4_999;
		expect(await store.get("a")).toBe(1);
		clock += 2;
		expect(await store.get("a")).toBeNull();
		await store.close();
	});

	it("deletes", async () => {
		const store = make();
		await store.set("a", 1);
		await store.delete("a");
		expect(await store.get("a")).toBeNull();
		await store.close();
	});

	it("caps list length, evicting the oldest", async () => {
		const store = make();
		for (let i = 0; i < 10; i++) {
			await store.listAppend("l", i, { maxLength: 4 });
		}
		expect(await store.listAll("l")).toEqual([6, 7, 8, 9]);
		await store.close();
	});

	it("returns an empty list for an unknown key", async () => {
		const store = make();
		expect(await store.listAll("nope")).toEqual([]);
		await store.close();
	});

	it("increments atomically and applies a TTL on first write", async () => {
		const store = make();
		expect(await store.increment("c", 1, 1_000)).toBe(1);
		expect(await store.increment("c", 2, 1_000)).toBe(3);
		clock += 1_001;
		expect(await store.increment("c", 1, 1_000)).toBe(1);
		await store.close();
	});

	it("sweeps expired keys without touching live ones", async () => {
		const store = make();
		await store.set("dead", 1, 100);
		await store.set("alive", 1, 100_000);
		clock += 500;
		await store.sweep();
		expect(await store.get("dead")).toBeNull();
		expect(await store.get("alive")).toBe(1);
		await store.close();
	});
}

export function runBusConformance(factory: BusFactory): void {
	let clock = 2_000_000;
	const now = () => clock;
	const make = () => {
		clock = 2_000_000;
		return factory({ now });
	};

	it("delivers to subscribers and numbers events from one", async () => {
		const bus = make();
		const seen: number[] = [];
		bus.subscribe("room", (e) => seen.push(e.id));
		const first = await bus.publish("room", "pose", { a: 1 });
		const second = await bus.publish("room", "pose", { a: 2 });
		expect(first.id).toBe(1);
		expect(second.id).toBe(2);
		expect(seen).toEqual([1, 2]);
		await bus.close();
	});

	it("keeps topics isolated", async () => {
		const bus = make();
		const seen: string[] = [];
		bus.subscribe("a", () => seen.push("a"));
		bus.subscribe("b", () => seen.push("b"));
		await bus.publish("a", "x", {});
		expect(seen).toEqual(["a"]);
		await bus.close();
	});

	it("replays from an event id, which is what Last-Event-ID needs", async () => {
		const bus = make();
		await bus.publish("room", "pose", { n: 1 });
		await bus.publish("room", "pose", { n: 2 });
		await bus.publish("room", "pose", { n: 3 });
		expect((await bus.since("room", 1)).map((e) => e.data)).toEqual([{ n: 2 }, { n: 3 }]);
		expect(await bus.since("room", 3)).toEqual([]);
		expect(await bus.head("room")).toBe(3);
		await bus.close();
	});

	it("reports a head of zero for a topic nobody has used", async () => {
		const bus = make();
		expect(await bus.head("never")).toBe(0);
		expect(await bus.since("never", 0)).toEqual([]);
		await bus.close();
	});

	it("unsubscribes cleanly", async () => {
		const bus = make();
		const seen: number[] = [];
		const off = bus.subscribe("room", (e) => seen.push(e.id));
		await bus.publish("room", "x", {});
		off();
		await bus.publish("room", "x", {});
		expect(seen).toEqual([1]);
		expect(bus.subscriberCount("room")).toBe(0);
		await bus.close();
	});

	it("survives a subscriber that throws", async () => {
		// One SSE connection tearing down mid-write must not stop the others from
		// getting the event.
		const bus = make();
		const seen: number[] = [];
		bus.subscribe("room", () => {
			throw new Error("boom");
		});
		bus.subscribe("room", (e) => seen.push(e.id));
		await bus.publish("room", "x", {});
		expect(seen).toEqual([1]);
		await bus.close();
	});

	it("caps retained history", async () => {
		const bus = make();
		for (let i = 0; i < 20; i++) await bus.publish("room", "x", { i }, { maxLength: 5 });
		const replay = await bus.since("room", 0);
		expect(replay.length).toBe(5);
		expect(replay[0]!.data).toEqual({ i: 15 });
		await bus.close();
	});
}
