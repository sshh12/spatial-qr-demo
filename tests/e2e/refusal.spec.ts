import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const manifest: { name: string; token: string }[] = JSON.parse(
	readFileSync(fileURLToPath(new URL("./fixtures/manifest.json", import.meta.url)), "utf8"),
);

/**
 * Refusing well is most of this product's credibility.
 *
 * A demo that says "I'm not sure which side of the room you were on, take a
 * step" reads as rigorous. The same system rendering somebody four hundred
 * metres behind the screen reads as broken. These tests exist to make sure the
 * first behaviour is the one that ships.
 */
test.describe("refusals", () => {
	test("never renders a result it cannot support", async ({ page }, testInfo) => {
		const fixture = manifest.find((m) => m.name === testInfo.project.name)!;
		await page.goto(`/s/${fixture.token}`);

		await page.getByTestId("begin").click({ timeout: 30_000 });
		await page.getByTestId("enable-camera").click();
		await expect(page.getByTestId("stage-aiming")).toBeVisible({ timeout: 20_000 });

		const capture = page.getByTestId("capture");
		if (await capture.isEnabled()) {
			await capture.click();
			// Give the burst time to finish and decide.
			await page.waitForTimeout(6000);
		} else {
			// The gauge already refused to arm, which is the earliest and cheapest
			// place to stop: a marker too small to read is not worth a capture.
			await expect(page.getByTestId("stage-aiming")).toBeVisible();
		}

		// Whatever happened, it must not be a confident answer.
		await expect(page.getByTestId("stage-result")).toHaveCount(0);
	});

	test("says something useful rather than spinning", async ({ page }, testInfo) => {
		const fixture = manifest.find((m) => m.name === testInfo.project.name)!;
		await page.goto(`/s/${fixture.token}`);
		await page.getByTestId("begin").click({ timeout: 30_000 });
		await page.getByTestId("enable-camera").click();
		await expect(page.getByTestId("stage-aiming")).toBeVisible({ timeout: 20_000 });

		const message = page.locator('[data-testid="stage-aiming"] p').first();
		await expect(message).not.toBeEmpty();

		// Whichever refusal it is, it has to name the situation. "Point at the
		// screen" is the honest message when nothing decoded at all, which is what
		// twenty-six marker-widths away actually looks like.
		const text = (await message.innerText()).toLowerCase();
		expect(text).toMatch(/point at the screen|too far|closer|edge/);
	});

	test("rejects a token that is not a display", async ({ page }) => {
		await page.goto("/s/NOTAREALTOKEN00");
		await expect(page.getByTestId("stage-fatal")).toBeVisible();
		await expect(page.getByTestId("stage-cold")).toHaveCount(0);
	});
});
