/**
 * Storage is two ports, not one.
 *
 * `Store` is CRUD; `EventBus` is fan-out. They are separated because the
 * adapters satisfy them by genuinely different mechanisms -- Redis does keys and
 * pub/sub through two unrelated subsystems, and Postgres does fan-out through
 * LISTEN/NOTIFY, whose payload caps at 8000 bytes and therefore cannot carry the
 * same objects the tables hold. Folding both behind one interface hides that.
 *
 * Every driver states its capabilities, and the server asserts on them at boot.
 * The failure this prevents is the nastiest one available: with two replicas and
 * an in-memory bus, the phone POSTs to replica B while the desktop's SSE stream
 * is held on replica A, and the page simply never updates. No error, no log
 * line, no way to tell it apart from a slow network.
 */

export interface Capabilities {
	/** Survives a process restart. */
	readonly durable: boolean;
	/** Visible to every replica, not just the one that wrote it. */
	readonly sharedAcrossReplicas: boolean;
	/** Expires keys itself, rather than needing a sweeper. */
	readonly nativeTtl: boolean;
}

export interface Store {
	readonly name: string;
	readonly capabilities: Capabilities;

	get<T>(key: string): Promise<T | null>;
	set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
	delete(key: string): Promise<void>;

	/** Appends to a capped list, oldest entries evicted first. */
	listAppend<T>(key: string, value: T, options?: ListOptions): Promise<void>;
	/** Returns the list, oldest first. */
	listAll<T>(key: string): Promise<T[]>;

	/** Atomic counter, for rate limiting. */
	increment(key: string, amount: number, ttlMs: number): Promise<number>;

	/** Removes anything past its TTL. A no-op where the driver has native TTL. */
	sweep(now?: number): Promise<void>;
	close(): Promise<void>;
}

export interface ListOptions {
	readonly maxLength?: number;
	readonly ttlMs?: number;
}

export interface BusEvent<T = unknown> {
	/** Monotonic per topic, starting at 1. Doubles as the SSE event id. */
	readonly id: number;
	readonly type: string;
	readonly at: number;
	readonly data: T;
}

export type BusHandler = (event: BusEvent) => void;
export type Unsubscribe = () => void;

export interface EventBus {
	readonly name: string;
	readonly capabilities: Capabilities;

	publish<T>(topic: string, type: string, data: T, options?: ListOptions): Promise<BusEvent<T>>;
	subscribe(topic: string, handler: BusHandler): Unsubscribe;
	/** Everything after `id`, for Last-Event-ID replay and the polling fallback. */
	since(topic: string, id: number): Promise<BusEvent[]>;
	/** Current highest event id for a topic, so a poller can start at "now". */
	head(topic: string): Promise<number>;
	subscriberCount(topic: string): number;
	close(): Promise<void>;
}

export interface Ports {
	readonly store: Store;
	readonly bus: EventBus;
}

export class ReplicaSafetyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReplicaSafetyError";
	}
}

/**
 * Refuses to start rather than serve a silently broken deployment.
 *
 * CONCEPT.md section 4 and non-goal 8: single replica by construction with the
 * in-memory driver, and swapping in Redis is what unlocks scaling. This is the
 * assertion that makes that statement enforceable instead of aspirational.
 */
export function assertReplicaSafety(ports: Ports, numReplicas: number): void {
	if (numReplicas <= 1) return;
	const problems: string[] = [];
	if (!ports.store.capabilities.sharedAcrossReplicas) {
		problems.push(`store "${ports.store.name}" is not shared across replicas`);
	}
	if (!ports.bus.capabilities.sharedAcrossReplicas) {
		problems.push(`bus "${ports.bus.name}" is not shared across replicas`);
	}
	if (problems.length > 0) {
		throw new ReplicaSafetyError(
			`Refusing to start with NUM_REPLICAS=${numReplicas}: ${problems.join("; ")}. ` +
				"A phone would POST its pose to one replica while the display's event " +
				"stream is held open on another, and the page would never update, with " +
				"nothing in the logs. Set NUM_REPLICAS=1 or configure a shared driver.",
		);
	}
}
