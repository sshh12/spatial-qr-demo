import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

interface FixtureMeta {
	name: string;
	token: string;
	width: number;
	height: number;
	truth: { azimuthDeg: number; elevationDeg: number; distanceEdges: number };
	expectedScreenHeights: number;
}

const manifest: FixtureMeta[] = JSON.parse(
	readFileSync(fileURLToPath(new URL("./fixtures/manifest.json", import.meta.url)), "utf8"),
);

function fixtureFor(projectName: string): FixtureMeta {
	const found = manifest.find((m) => m.name === projectName);
	if (!found) throw new Error(`no fixture for project ${projectName}`);
	return found;
}

/**
 * The whole phone pipeline, in a real browser, against known ground truth.
 *
 * Nothing here is mocked below the UI: a real getUserMedia call returns a real
 * MediaStream fed from a Y4M file that the synthetic renderer produced at an
 * exact pose. The frames go through the real canvas readback, the real
 * zxing-wasm build in a real worker, the real sub-pixel refiner and the real
 * solver. So this asserts on recovered geometry, not merely on the flow
 * completing -- which is the difference between an end-to-end test and a
 * screenshot of one.
 */
test.describe("phone capture", () => {
	test("recovers the pose the camera fixture was rendered from", async ({ page }, testInfo) => {
		const fixture = fixtureFor(testInfo.project.name);
		const errors = collectErrors(page);

		await page.goto(`/s/${fixture.token}?debug=1`);

		// S0: no permission request on load, ever.
		await expect(page.getByTestId("stage-cold")).toBeVisible();
		expect(await cameraActive(page)).toBe(false);

		await page.getByTestId("begin").click({ timeout: 30_000 });
		await expect(page.getByTestId("stage-permission")).toBeVisible();
		await page.getByTestId("enable-camera").click();

		// S3: the box locks onto the real thing.
		await expect(page.getByTestId("stage-aiming")).toBeVisible({ timeout: 20_000 });
		await expect(page.getByTestId("lock-box")).toBeVisible({ timeout: 20_000 });

		const readout = page.getByTestId("readout");
		await expect(readout).toContainText(`${fixture.width}×${fixture.height}`);

		const capture = page.getByTestId("capture");
		await expect(capture).toBeEnabled({ timeout: 20_000 });
		await capture.click();

		await expect(page.getByTestId("stage-result")).toBeVisible({ timeout: 45_000 });

		// The camera indicator must be out before the scene is drawn. This is the
		// promise the cold open makes, and it costs nothing to keep.
		expect(await cameraActive(page)).toBe(false);

		const stats = await readStats(page);
		expect(Math.abs(stats.azimuth - fixture.truth.azimuthDeg)).toBeLessThan(3);
		expect(Math.abs(stats.elevation - fixture.truth.elevationDeg)).toBeLessThan(3);
		expect(Math.sign(stats.azimuth)).toBe(Math.sign(fixture.truth.azimuthDeg));

		// Distance in display heights is exact by construction, so it can be held
		// to a tight tolerance; metres cannot, and is not asserted here.
		expect(stats.screenHeights).toBeGreaterThan(fixture.expectedScreenHeights * 0.75);
		expect(stats.screenHeights).toBeLessThan(fixture.expectedScreenHeights * 1.25);

		expect(errors, `console errors: ${errors.join(" | ")}`).toHaveLength(0);
	});

	test("never navigates between the permission grant and the result", async ({
		page,
	}, testInfo) => {
		// iOS revokes an "Allow Once" grant on navigation with no way to ask again,
		// so a single navigation here is not a slow path, it is a dead end. The
		// whole flow is one page load and this is the assertion that keeps it that way.
		const fixture = fixtureFor(testInfo.project.name);
		await page.goto(`/s/${fixture.token}`);

		let navigations = 0;
		page.on("framenavigated", (frame) => {
			if (frame === page.mainFrame()) navigations++;
		});

		await page.getByTestId("begin").click({ timeout: 30_000 });
		await page.getByTestId("enable-camera").click();
		await expect(page.getByTestId("stage-aiming")).toBeVisible({ timeout: 20_000 });
		await page.getByTestId("capture").click({ timeout: 20_000 });
		await expect(page.getByTestId("stage-result")).toBeVisible({ timeout: 45_000 });

		expect(navigations).toBe(0);
	});

	test("shows the eyes toggle and moves the number when it is used", async ({ page }, testInfo) => {
		const fixture = fixtureFor(testInfo.project.name);
		await page.goto(`/s/${fixture.token}`);
		await page.getByTestId("begin").click({ timeout: 30_000 });
		await page.getByTestId("enable-camera").click();
		await page.getByTestId("capture").click({ timeout: 25_000 });
		await expect(page.getByTestId("stage-result")).toBeVisible({ timeout: 45_000 });

		const before = await readStats(page);
		const toggle = page.getByTestId("eyes-toggle");
		await expect(toggle).toContainText("Show estimated eye position");
		await toggle.click();
		await expect(toggle).toContainText("Show measured phone position");

		const after = await readStats(page);
		// Eyes are behind the phone, so the reported distance must shrink.
		expect(after.metres).toBeLessThan(before.metres);
	});
});

/** Reads the four headline numbers off the result screen. */
async function readStats(page: Page): Promise<{
	azimuth: number;
	elevation: number;
	screenHeights: number;
	metres: number;
}> {
	const values = await page.locator('[data-testid="stage-result"] dl dd').allInnerTexts();
	const numeric = values
		.map((v) => Number.parseFloat(v.replace(/−/g, "-").replace(/[^0-9.-]/g, "")))
		.filter((v) => Number.isFinite(v));
	// Layout order: bearing, elevation, distance in heights, distance in metres,
	// each followed by its note line.
	return {
		azimuth: numeric[0] ?? Number.NaN,
		elevation: numeric[2] ?? Number.NaN,
		screenHeights: numeric[4] ?? Number.NaN,
		metres: numeric[6] ?? Number.NaN,
	};
}

/** Is any live camera track still attached to the page? */
async function cameraActive(page: Page): Promise<boolean> {
	return page.evaluate(() => {
		const video = document.querySelector("video");
		const stream = video?.srcObject as MediaStream | null;
		if (!stream) return false;
		return stream.getVideoTracks().some((t) => t.readyState === "live");
	});
}

function collectErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(msg.text());
	});
	page.on("pageerror", (err) => errors.push(err.message));
	return errors;
}
