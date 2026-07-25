import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const manifest: { name: string; token: string }[] = JSON.parse(
	readFileSync(fileURLToPath(new URL("./fixtures/manifest.json", import.meta.url)), "utf8"),
);
const TOKEN = manifest[0]!.token;

/**
 * The WebKit lane, and exactly where it stops.
 *
 * Three separate limits stack up here, and it is worth being precise about
 * which is which rather than writing one vague caveat:
 *
 *  1. Playwright can grant camera permission in WebKit and serve a mock capture
 *     stream, but that stream is a synthetic pattern. There is no mechanism to
 *     feed QR content into it, so pose recovery cannot be tested here at all.
 *  2. Real Safari refuses `navigator.mediaDevices` on a plain-HTTP origin,
 *     localhost included. This lane therefore runs against a TLS terminator.
 *  3. Playwright's WebKit build on Windows ships no `navigator.mediaDevices`
 *     whatsoever, secure context or not. On such a runner the camera flow is
 *     unreachable and the only thing worth asserting is that the app notices
 *     and routes around it -- which is the same code path a locked-down
 *     enterprise browser takes, so it is worth asserting anyway.
 *
 * So the lane probes for the capability and tests whichever half it can reach.
 * On a macOS runner it covers the permission state machine and the video
 * plumbing; everywhere it covers routing, the single-page-load guarantee and
 * the no-camera fallback. Acquisition itself is human-verified on real
 * hardware, and the README says so instead of implying otherwise.
 */

async function hasCameraApi(page: Page): Promise<boolean> {
	return page.evaluate(() => typeof navigator.mediaDevices?.getUserMedia === "function");
}

test.describe("WebKit", () => {
	test("serves a secure context, which Safari requires before it will offer a camera", async ({
		page,
	}) => {
		await page.goto(`/s/${TOKEN}`);
		const secure = await page.evaluate(() => ({
			isSecureContext: window.isSecureContext,
			protocol: location.protocol,
		}));
		expect(secure.isSecureContext).toBe(true);
		expect(secure.protocol).toBe("https:");
	});

	test("routes around a browser with no camera API instead of blaming the connection", async ({
		page,
	}) => {
		await page.goto(`/s/${TOKEN}`);
		if (await hasCameraApi(page)) {
			test.skip(true, "this WebKit build does expose a camera API");
			return;
		}
		// The old behaviour here was a dead end reading "the camera needs a secure
		// connection" on a page that was already secure. This is the fix.
		await expect(page.getByTestId("stage-no-camera")).toBeVisible();
		await expect(page.getByTestId("plan-view")).toBeVisible();
		await expect(page.getByText(/cannot access a camera/i)).toBeVisible();
		await expect(page.getByTestId("stage-fatal")).toHaveCount(0);
	});

	test("gets through permission and into the viewfinder where the API exists", async ({ page }) => {
		await page.goto(`/s/${TOKEN}`);
		test.skip(!(await hasCameraApi(page)), "no camera API in this WebKit build");

		await expect(page.getByTestId("stage-cold")).toBeVisible();
		await page.getByTestId("begin").click({ timeout: 30_000 });
		await page.getByTestId("enable-camera").click();

		// The mock stream has no QR in it, so this is as far as it can go -- and
		// reaching it means getUserMedia, autoplay and the worker all worked.
		await expect(page.getByTestId("stage-aiming")).toBeVisible({ timeout: 25_000 });
		await expect(page.getByTestId("readout")).toContainText("no symbol");

		const attributes = await page.locator("video").evaluate((el) => {
			const v = el as HTMLVideoElement;
			return { playsInline: v.hasAttribute("playsinline"), muted: v.muted, autoplay: v.autoplay };
		});
		// Without playsinline, iOS takes the video fullscreen and the flow is over.
		expect(attributes.playsInline).toBe(true);
		expect(attributes.muted).toBe(true);
		expect(attributes.autoplay).toBe(true);
	});

	test("stays on one page load", async ({ page }) => {
		await page.goto(`/s/${TOKEN}`);
		let navigations = 0;
		page.on("framenavigated", (frame) => {
			if (frame === page.mainFrame()) navigations++;
		});

		if (await hasCameraApi(page)) {
			await page.getByTestId("begin").click({ timeout: 30_000 });
			await page.getByTestId("enable-camera").click();
			await expect(page.getByTestId("stage-aiming")).toBeVisible({ timeout: 25_000 });
		} else {
			await expect(page.getByTestId("stage-no-camera")).toBeVisible();
			await page.getByLabel("Angle left or right of screen centre").fill("40");
			await page.getByRole("button", { name: /add my position/i }).click();
			await expect(page.getByRole("button", { name: /position added/i })).toBeVisible();
		}
		expect(navigations).toBe(0);
	});

	test("renders the display page and the write-up", async ({ page }) => {
		await page.goto("/");
		await expect(page.locator('[data-testid="marker-slot"] canvas')).toBeVisible();
		await expect(page.getByTestId("scan-url")).toContainText("/s/");

		await page.goto("/how-it-works");
		await expect(page.getByRole("heading", { name: "How it works" })).toBeVisible();
	});
});
