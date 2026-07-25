import type { MarkerLayout } from "@core/marker.ts";
import type { AimResult, SolveResult, WorkerResponse } from "./protocol.ts";

/**
 * Owns the detection worker and turns its message protocol into promises.
 *
 * Everything expensive -- wasm decode, sub-pixel refinement, the pose solve --
 * happens off the main thread, because the aiming loop has to keep a hairline
 * box glued to a moving quad at 10-15 Hz while it does.
 */
export class DetectorClient {
	private worker: Worker | null = null;
	private nextId = 1;
	private readonly pending = new Map<number, (response: WorkerResponse) => void>();
	private readyResolve: (() => void) | null = null;
	readonly ready: Promise<void>;

	constructor() {
		this.ready = new Promise<void>((resolve) => {
			this.readyResolve = resolve;
		});
	}

	/**
	 * Starts the worker and pulls the wasm down immediately.
	 *
	 * Called on the cold-open screen, so the ~450 KB is paid for by the seconds
	 * somebody spends reading "one photograph, decoded on this phone" rather than
	 * by the first frame after they tap.
	 */
	start(): void {
		if (this.worker) return;
		this.worker = new Worker(new URL("./detect.worker.ts", import.meta.url), {
			type: "module",
			name: "spatial-qr-detector",
		});
		this.worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
			const response = event.data;
			if (response.type === "ready") {
				this.readyResolve?.();
				this.readyResolve = null;
				return;
			}
			const resolve = this.pending.get(response.id);
			if (resolve) {
				this.pending.delete(response.id);
				resolve(response);
			}
		});
		this.worker.postMessage({ type: "init" });
	}

	private send<T extends WorkerResponse>(
		message: Record<string, unknown>,
		transfer: Transferable[],
	): Promise<T> {
		const worker = this.worker;
		if (!worker) return Promise.reject(new Error("detector not started"));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, (response) => {
				if (response.type === "error") reject(new Error(response.message));
				else resolve(response as T);
			});
			worker.postMessage({ ...message, id }, transfer);
		});
	}

	aim(frame: { data: Uint8ClampedArray; width: number; height: number }): Promise<AimResult> {
		// The buffer is transferred, not copied: at 15 Hz the copy alone would be
		// tens of megabytes a second.
		const buffer = frame.data.buffer as ArrayBuffer;
		return this.send<AimResult>({ type: "aim", buffer, width: frame.width, height: frame.height }, [
			buffer,
		]);
	}

	solve(
		frame: { data: Uint8ClampedArray; width: number; height: number },
		options: {
			layout: MarkerLayout | null;
			focalPx: number;
			focalSigmaLog: number;
			sigmaPx: number;
			expectedText?: string | null;
		},
	): Promise<SolveResult> {
		const buffer = frame.data.buffer as ArrayBuffer;
		return this.send<SolveResult>(
			{
				type: "solve",
				buffer,
				width: frame.width,
				height: frame.height,
				layout: options.layout,
				focalPx: options.focalPx,
				focalSigmaLog: options.focalSigmaLog,
				sigmaPx: options.sigmaPx,
				expectedText: options.expectedText ?? null,
			},
			[buffer],
		);
	}

	terminate(): void {
		this.worker?.terminate();
		this.worker = null;
		this.pending.clear();
	}
}
