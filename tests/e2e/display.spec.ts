import { expect, test } from "@playwright/test";

/**
 * The display page, and the swap.
 *
 * The swap is the product, not decoration: the measurement *is* the visitor's
 * position, so we cannot ask them to move without changing the answer. Moving
 * the screen instead is the only legitimate way to improve the geometry, and it
 * is worth roughly 1.78x on the horizontal baseline that azimuth depends on.
 */
test.describe("display", () => {
	test("renders a marker at integer device pixels per module", async ({ page }) => {
		await page.goto("/");
		const canvas = page.locator('[data-testid="marker-slot"] canvas');
		await expect(canvas).toBeVisible();

		const geometry = await canvas.evaluate((el) => {
			const c = el as HTMLCanvasElement;
			return {
				deviceWidth: c.width,
				cssWidth: Number.parseFloat(c.style.width),
				dpr: window.devicePixelRatio,
				rendering: getComputedStyle(c).imageRendering,
			};
		});

		// Module count comes from the payload's QR version, which moves with the
		// origin's length -- so it is read back rather than assumed.
		const url = await page.getByTestId("scan-url").innerText();
		const token = url.split("/s/")[1]!.trim();
		await page.waitForTimeout(400);
		const { room } = await (await page.request.get(`/api/s/${token}/state`)).json();
		const totalModules = room.layout.moduleCount + 8;
		const modulePx = geometry.deviceWidth / totalModules;
		expect(Number.isInteger(modulePx), `${modulePx} device px per module`).toBe(true);
		expect(modulePx).toBeGreaterThanOrEqual(3);
		expect(geometry.rendering).toBe("pixelated");

		// No CSS transform anywhere in the ancestor chain: a resampled module edge
		// is a biased module edge, and the sub-pixel refiner would inherit that.
		const transformed = await canvas.evaluate((el) => {
			let node: HTMLElement | null = el as HTMLElement;
			while (node) {
				const t = getComputedStyle(node).transform;
				if (t && t !== "none") return t;
				node = node.parentElement;
			}
			return null;
		});
		expect(transformed).toBeNull();
	});

	test("shows the URL in plain text for people who will not scan a stranger's QR", async ({
		page,
	}) => {
		await page.goto("/");
		await expect(page.getByTestId("scan-url")).toContainText("/s/");
	});

	test("runs the swap when a phone arms, and puts brackets on the true corners", async ({
		page,
		context,
	}) => {
		await page.goto("/");
		const url = await page.getByTestId("scan-url").innerText();
		const token = url.split("/s/")[1]!.trim();

		await expect(page.getByTestId("live-strip")).toHaveAttribute("data-beat", "idle");

		// A second tab stands in for the phone.
		const phone = await context.newPage();
		await phone.request.post(`/api/s/${token}/hello`, { data: { role: "phone" } });
		await expect(page.getByTestId("live-strip")).toHaveAttribute("data-beat", "connected", {
			timeout: 15_000,
		});

		await phone.request.post(`/api/s/${token}/armed`, { data: {} });
		const fullbleed = page.getByTestId("marker-fullbleed");
		await expect(fullbleed).toBeVisible({ timeout: 15_000 });

		// Four brackets, eight arms, all black on white.
		const arms = fullbleed.locator("div.absolute.bg-black");
		await expect(arms).toHaveCount(8);

		const geometry = await page.evaluate(() => {
			const boxes = [...document.querySelectorAll('[data-testid="marker-fullbleed"] div.absolute')];
			return boxes
				.map((b) => b.getBoundingClientRect())
				.map((r) => ({
					left: Math.round(r.left),
					top: Math.round(r.top),
					right: Math.round(r.right),
					bottom: Math.round(r.bottom),
				}));
		});
		const inset = Math.round(page.viewportSize()!.height * 0.02);
		// Every arm must touch one of the four inset lines: the outer edge of the
		// bracket is the display's edge, which is the line the refiner fits.
		for (const box of geometry) {
			const touches =
				box.top === inset ||
				box.left === inset ||
				Math.abs(box.bottom - (page.viewportSize()!.height - inset)) <= 1 ||
				Math.abs(box.right - (page.viewportSize()!.width - inset)) <= 1;
			expect(touches, JSON.stringify(box)).toBe(true);
		}

		// The shutter beat.
		await phone.request.post(`/api/s/${token}/capturing`, { data: {} });
		await expect(page.getByTestId("shutter-flash")).toBeAttached({ timeout: 10_000 });

		await phone.close();
	});

	test("publishes the symbol edge, not the quiet-zone box", async ({ page }) => {
		await page.goto("/");
		const url = await page.getByTestId("scan-url").innerText();
		const token = url.split("/s/")[1]!.trim();

		// Give the layout a moment to be posted.
		await page.waitForTimeout(500);
		const state = await page.request.get(`/api/s/${token}/state`);
		const { room } = await state.json();
		expect(room.layout).toBeTruthy();

		const canvas = await page
			.locator('[data-testid="marker-slot"] canvas')
			.evaluate((el) => ({ css: Number.parseFloat((el as HTMLCanvasElement).style.width) }));

		// The rendered box includes four quiet-zone modules on each side, so the
		// symbol edge must be N/(N+8) of it. Confusing the two overstates distance
		// by 32% at version 2 -- larger than every error the rest of the system
		// controls, and invisible, because every angle stays perfect.
		const n = room.layout.moduleCount;
		expect(room.layout.symbolEdgeCssPx).toBeCloseTo(canvas.css * (n / (n + 8)), 1);
		expect(room.layout.symbolEdgeCssPx).toBeLessThan(canvas.css);
	});

	test("computes the range table rather than remembering it", async ({ page }) => {
		await page.goto("/");
		const line = page.getByText(/Estimated reliable range/);
		await expect(line).toBeVisible();
		await expect(line).toContainText("display heights");
		await expect(line).toContainText("1920 px capture");
	});

	test("how-it-works loads the generated artefacts", async ({ page }) => {
		await page.goto("/how-it-works");
		await expect(page.getByRole("heading", { name: "How it works" })).toBeVisible();
		const chart = page.getByAltText(/bearing error/i);
		await expect(chart).toBeVisible();
		const loaded = await chart.evaluate((img) => (img as HTMLImageElement).naturalWidth > 0);
		expect(loaded, "the CI-generated chart must actually exist").toBe(true);
	});

	test("the create flow blocks on browser zoom", async ({ page }) => {
		await page.goto("/create");
		await expect(page.getByTestId("card-ruler")).toBeVisible();
		await expect(page.getByTestId("calibration-badge")).toContainText("measured");
		await expect(page.getByTestId("create-room")).toBeEnabled();
	});
});
