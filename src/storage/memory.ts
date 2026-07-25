import type {
	BusEvent,
	BusHandler,
	Capabilities,
	EventBus,
	ListOptions,
	Store,
	Unsubscribe,
} from "./ports.ts";

const MEMORY_CAPABILITIES: Capabilities = {
	durable: false,
	sharedAcrossReplicas: false,
	nativeTtl: false,
};

interface Entry {
	value: unknown;
	expiresAt: number;
}

export interface MemoryStoreOptions {
	/** Injectable clock, so the conformance suite can test TTL without waiting. */
	readonly now?: () => number;
	readonly defaultListLength?: number;
}

export class MemoryStore implements Store {
	readonly name = "memory";
	readonly capabilities = MEMORY_CAPABILITIES;

	private readonly entries = new Map<string, Entry>();
	private readonly now: () => number;
	private readonly defaultListLength: number;

	constructor(options: MemoryStoreOptions = {}) {
		this.now = options.now ?? (() => Date.now());
		this.defaultListLength = options.defaultListLength ?? 512;
	}

	private live(key: string): Entry | null {
		const entry = this.entries.get(key);
		if (!entry) return null;
		if (entry.expiresAt !== 0 && entry.expiresAt <= this.now()) {
			this.entries.delete(key);
			return null;
		}
		return entry;
	}

	async get<T>(key: string): Promise<T | null> {
		const entry = this.live(key);
		return entry ? (structuredClone(entry.value) as T) : null;
	}

	async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
		this.entries.set(key, {
			value: structuredClone(value),
			expiresAt: ttlMs && ttlMs > 0 ? this.now() + ttlMs : 0,
		});
	}

	async delete(key: string): Promise<void> {
		this.entries.delete(key);
	}

	async listAppend<T>(key: string, value: T, options: ListOptions = {}): Promise<void> {
		const entry = this.live(key);
		const list = (entry?.value as T[] | undefined) ?? [];
		list.push(structuredClone(value));
		const max = options.maxLength ?? this.defaultListLength;
		if (list.length > max) list.splice(0, list.length - max);
		this.entries.set(key, {
			value: list,
			expiresAt:
				options.ttlMs && options.ttlMs > 0 ? this.now() + options.ttlMs : (entry?.expiresAt ?? 0),
		});
	}

	async listAll<T>(key: string): Promise<T[]> {
		const entry = this.live(key);
		return entry ? (structuredClone(entry.value) as T[]) : [];
	}

	async increment(key: string, amount: number, ttlMs: number): Promise<number> {
		const entry = this.live(key);
		const next = ((entry?.value as number | undefined) ?? 0) + amount;
		this.entries.set(key, {
			value: next,
			expiresAt: entry?.expiresAt && entry.expiresAt !== 0 ? entry.expiresAt : this.now() + ttlMs,
		});
		return next;
	}

	async sweep(now = this.now()): Promise<void> {
		for (const [key, entry] of this.entries) {
			if (entry.expiresAt !== 0 && entry.expiresAt <= now) this.entries.delete(key);
		}
	}

	async close(): Promise<void> {
		this.entries.clear();
	}

	/** Test/diagnostic only. */
	get size(): number {
		return this.entries.size;
	}
}

interface Topic {
	nextId: number;
	events: BusEvent[];
	handlers: Set<BusHandler>;
	expiresAt: number;
}

export interface MemoryBusOptions {
	readonly now?: () => number;
	/** How many events to retain per topic for replay. */
	readonly historyLength?: number;
	readonly topicTtlMs?: number;
}

export class MemoryEventBus implements EventBus {
	readonly name = "memory";
	readonly capabilities = MEMORY_CAPABILITIES;

	private readonly topics = new Map<string, Topic>();
	private readonly now: () => number;
	private readonly historyLength: number;
	private readonly topicTtlMs: number;

	constructor(options: MemoryBusOptions = {}) {
		this.now = options.now ?? (() => Date.now());
		this.historyLength = options.historyLength ?? 256;
		this.topicTtlMs = options.topicTtlMs ?? 4 * 60 * 60 * 1000;
	}

	private topic(name: string): Topic {
		let topic = this.topics.get(name);
		if (
			topic &&
			topic.expiresAt !== 0 &&
			topic.expiresAt <= this.now() &&
			topic.handlers.size === 0
		) {
			this.topics.delete(name);
			topic = undefined;
		}
		if (!topic) {
			topic = { nextId: 1, events: [], handlers: new Set(), expiresAt: 0 };
			this.topics.set(name, topic);
		}
		return topic;
	}

	async publish<T>(
		name: string,
		type: string,
		data: T,
		options: ListOptions = {},
	): Promise<BusEvent<T>> {
		const topic = this.topic(name);
		const event: BusEvent<T> = {
			id: topic.nextId++,
			type,
			at: this.now(),
			data: structuredClone(data),
		};
		topic.events.push(event as BusEvent);
		const max = options.maxLength ?? this.historyLength;
		if (topic.events.length > max) topic.events.splice(0, topic.events.length - max);
		topic.expiresAt = this.now() + (options.ttlMs ?? this.topicTtlMs);

		for (const handler of [...topic.handlers]) {
			try {
				handler(event as BusEvent);
			} catch {
				// A dead subscriber must never take down a publish.
			}
		}
		return event;
	}

	subscribe(name: string, handler: BusHandler): Unsubscribe {
		const topic = this.topic(name);
		topic.handlers.add(handler);
		return () => {
			topic.handlers.delete(handler);
		};
	}

	async since(name: string, id: number): Promise<BusEvent[]> {
		const topic = this.topics.get(name);
		if (!topic) return [];
		return topic.events.filter((e) => e.id > id).map((e) => structuredClone(e));
	}

	async head(name: string): Promise<number> {
		const topic = this.topics.get(name);
		return topic ? topic.nextId - 1 : 0;
	}

	subscriberCount(name: string): number {
		return this.topics.get(name)?.handlers.size ?? 0;
	}

	async close(): Promise<void> {
		this.topics.clear();
	}

	/** Drops topics that have expired and have nobody listening. */
	async sweep(now = this.now()): Promise<void> {
		for (const [name, topic] of this.topics) {
			if (topic.expiresAt !== 0 && topic.expiresAt <= now && topic.handlers.size === 0) {
				this.topics.delete(name);
			}
		}
	}
}

export function createMemoryPorts(options: MemoryStoreOptions & MemoryBusOptions = {}) {
	return {
		store: new MemoryStore(options),
		bus: new MemoryEventBus(options),
	};
}
