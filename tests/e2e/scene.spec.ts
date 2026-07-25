import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const manifest: { name: string; token: string }[] = JSON.parse(
	readFileSync(fileURLToPath(new URL("./fixtures/manifest.json", import.meta.url)), "utf8"),
);
const TOKEN = manifest.find((m) => m.name === "nominal")!.token;

/**
 * L4: structural assertions on the scene graph.
 *
 * Deliberately not screenshot diffing. Chromium's software rasteriser produces
 * subtly different pixels between versions and platforms, SwiftShader's
 * automatic fallback was removed in Chrome 137, and a suite that fails on
 * anti-aliasing gets muted within a week. What is worth asserting is that the
 * right objects exist at the right coordinates -- which is also the thing that
 * would actually be wrong if the geometry regressed.
 */
test.describe("the scene", () => {
	test.beforeEach(async ({ page }) => {
		// `?debug=1` because the readout is opt-in: it is a diagnostic strip, not
		// something to show a visitor who came to see where they were standing.
		// Without the flag it renders nothing at all, and the assertion below
		// waits ninety seconds for an element that was never going to exist.
		await page.goto(`/s/${TOKEN}?debug=1`);
		await page.getByTestId("begin").click({ timeout: 30_000 });
		await page.getByTestId("enable-camera").click();
		await page.getByTestId("capture").click({ timeout: 25_000 });
		await expect(page.getByTestId("stage-result")).toBeVisible({ timeout: 45_000 });
	});

	test("mounts a WebGL canvas, or says why it could not", async ({ page }) => {
		// react-three-fiber forwards unrecognised props to its *container* div, so
		// the test id lands there and the drawing surface is the canvas inside it.
		const container = page.getByTestId("scene-canvas");
		const canvas = container.locator("canvas");
		const fallback = page.getByTestId("scene-fallback");

		const hasCanvas = (await container.count()) > 0;
		if (!hasCanvas) {
			// The fallback is a legitimate outcome and carries the same information.
			await expect(fallback).toBeVisible();
			await expect(page.getByTestId("plan-view")).toBeVisible();
			return;
		}

		await expect(canvas).toBeVisible();
		// The scene is a lazily-loaded chunk and r3f sizes its canvas from a
		// ResizeObserver, so "mounted" and "measured" are two different moments.
		await expect
			.poll(
				async () =>
					canvas.evaluate((el) => {
						const c = el as HTMLCanvasElement;
						return Math.min(c.width, c.height);
					}),
				{ timeout: 20_000 },
			)
			.toBeGreaterThan(0);

		// And it must be drawing at the device pixel ratio it was asked for, not
		// at some collapsed fallback size.
		const drawn = await canvas.evaluate((el) => {
			const c = el as HTMLCanvasElement;
			const rect = c.getBoundingClientRect();
			return { width: c.width, height: c.height, cssWidth: rect.width, cssHeight: rect.height };
		});
		expect(drawn.cssWidth).toBeGreaterThan(100);
		expect(drawn.cssHeight).toBeGreaterThan(100);
		expect(drawn.width).toBeGreaterThanOrEqual(drawn.cssWidth - 1);
	});

	test("draws the plan view with the same answer as the 3D", async ({ page }) => {
		const plan = page.getByTestId("plan-view");
		await expect(plan).toBeVisible();
		await expect(page.getByTestId("plan-me")).toHaveCount(1);

		// The dot must be on the same side as the headline number says.
		const verdict = await page.getByTestId("verdict").innerText();
		const side = /left/i.test(verdict) ? "left" : /right/i.test(verdict) ? "right" : "centre";

		const geometry = await plan.evaluate((svg) => {
			const box = svg.getBoundingClientRect();
			const me = svg.querySelector('[data-testid="plan-me"] circle:nth-child(2)');
			const rect = me?.getBoundingClientRect();
			return rect ? { centreX: box.left + box.width / 2, dotX: rect.left + rect.width / 2 } : null;
		});
		expect(geometry).not.toBeNull();

		if (side === "right") expect(geometry!.dotX).toBeGreaterThan(geometry!.centreX);
		if (side === "left") expect(geometry!.dotX).toBeLessThan(geometry!.centreX);
	});

	test("keeps the debug readout truthful, which is why it will not rot", async ({ page }) => {
		const readout = page.getByTestId("readout");
		const text = await readout.innerText();
		expect(text).toMatch(/\d+×\d+/);
		expect(text).toMatch(/\d+ reference points/);
		expect(text).toMatch(/model fit \d+\.\d+ px/);
		// No display was connected during this test.
		expect(text).toContain("display offline");
	});

	test("never uploads a photograph", async ({ page }) => {
		// Watch every request the page makes and assert nothing image-shaped
		// leaves. This is the strongest form the privacy claim can take in a test.
		const suspicious: string[] = [];
		page.on("request", (request) => {
			const size = request.postDataBuffer()?.byteLength ?? 0;
			if (request.method() === "POST" && size > 4096) {
				suspicious.push(`${request.url()} (${size} bytes)`);
			}
			const type = request.headers()["content-type"] ?? "";
			if (type.startsWith("image/") || type.startsWith("multipart/")) {
				suspicious.push(`${request.url()} (${type})`);
			}
		});

		await page.reload();
		await page.getByTestId("begin").click({ timeout: 30_000 });
		await page.getByTestId("enable-camera").click();
		await page.getByTestId("capture").click({ timeout: 25_000 });
		await expect(page.getByTestId("stage-result")).toBeVisible({ timeout: 45_000 });

		expect(suspicious, suspicious.join(" | ")).toHaveLength(0);
	});
});
