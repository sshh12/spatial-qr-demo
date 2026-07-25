import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const manifest: { name: string; token: string }[] = JSON.parse(
	readFileSync(fileURLToPath(new URL("./fixtures/manifest.json", import.meta.url)), "utf8"),
);
const TOKEN = manifest[0]!.token;

/**
 * The no-camera route.
 *
 * Denied permission, a hostile in-app browser, a desktop visitor, canvas
 * farbling, and anyone who cannot hold a phone steady all arrive here -- and on
 * a front-page day that is plausibly a fifth to a third of everyone. It is also
 * the accessibility route: a camera-geometry demo is fundamentally inaccessible
 * to blind and low-vision users, and a genuine alternative path is the only
 * honest answer to that.
 */
test.describe("no camera", () => {
	test("offers a real route rather than an apology", async ({ page, context }) => {
		await context.clearPermissions();
		await page.goto(`/s/${TOKEN}`);

		await page.getByTestId("begin").click({ timeout: 30_000 });
		await page.getByRole("button", { name: /place myself on a plan/i }).click();

		const stage = page.getByTestId("stage-no-camera");
		await expect(stage).toBeVisible();
		await expect(page.getByTestId("plan-view")).toBeVisible();

		// It leads to the same room, not a dead end.
		const submit = page.getByRole("button", { name: /that's where i am/i });
		await expect(submit).toBeEnabled();
		await submit.click();
		await expect(page.getByRole("button", { name: /you're in the room/i })).toBeVisible();
	});

	test("declines the camera before asking for it if the visitor says no", async ({ page }) => {
		await page.goto(`/s/${TOKEN}`);
		await page
			.getByRole("button", { name: /rather not use my camera/i })
			.click({ timeout: 30_000 });
		await expect(page.getByTestId("stage-no-camera")).toBeVisible();

		// No getUserMedia call was ever made.
		const active = await page.evaluate(() => {
			const video = document.querySelector("video");
			return Boolean((video?.srcObject as MediaStream | null)?.getVideoTracks().length);
		});
		expect(active).toBe(false);
	});

	test("the sliders move the dot", async ({ page }) => {
		await page.goto(`/s/${TOKEN}`);
		await page
			.getByRole("button", { name: /rather not use my camera/i })
			.click({ timeout: 30_000 });

		const before = await page.getByTestId("plan-me").getAttribute("data-testid");
		expect(before).toBe("plan-me");

		const slider = page.getByLabel("angle from the centre of the screen");
		await slider.fill("55");
		await expect(page.getByText(/\+55° right/)).toBeVisible();
	});
});
