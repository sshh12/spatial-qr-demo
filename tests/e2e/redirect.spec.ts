import { expect, type Page, test } from "@playwright/test";

/**
 * The onward redirect: this app used as a general QR service.
 *
 * A code created with a destination stops showing the demo's own result and
 * hands the measured position to somebody else's URL instead. That makes the
 * redirect the entire product for anyone using it that way, and it is also the
 * one place where a value a stranger typed ends up in a `location.replace` on a
 * visitor's phone -- so both the delivery and the refusals are covered here.
 *
 * The manual placement route is what these drive, because it exercises the
 * whole handoff without needing a camera fixture: the position is lifted from
 * the sliders, posted, tiered by the server, and appended to the destination by
 * exactly the same code path a photographed solve uses.
 */

const DESTINATION = "http://localhost:3210/how-it-works";

/** A fresh room per test: claiming a shared fixture token would leak a redirect into the others. */
async function freshToken(page: Page): Promise<string> {
	await page.goto("/");
	const url = await page.getByTestId("scan-url").innerText();
	return url.split("/s/")[1]!.trim();
}

async function createCodeWithRedirect(page: Page, redirect: string) {
	const token = await freshToken(page);
	const res = await page.request.post(`/api/s/${token}/claim`, {
		data: { ownerToken: "e2e-owner-token-0123456789", redirect },
	});
	expect(res.status()).toBe(200);
	return token;
}

async function placeManually(page: Page, token: string) {
	await page.goto(`/s/${token}`);
	await page.getByRole("button", { name: /place me manually/i }).click({ timeout: 30_000 });
	await page.getByLabel("Angle left or right of screen centre").fill("-40");
	await page.getByRole("button", { name: /add my position/i }).click();
}

test.describe("onward redirect", () => {
	test("hands the position to the destination and goes there", async ({ page }) => {
		const token = await createCodeWithRedirect(page, DESTINATION);
		await placeManually(page, token);

		// The numbers are on screen, in full, before anything is sent. That is the
		// same promise the result screen makes, kept on the way out of the app.
		const handoff = page.getByTestId("handoff");
		await expect(handoff).toBeVisible();
		await expect(handoff).toContainText("localhost:3210");

		await page.waitForURL(/\/how-it-works\?/, { timeout: 20_000 });
		const arrived = new URL(page.url());
		expect(arrived.pathname).toBe("/how-it-works");
		expect(arrived.searchParams.get("sqr_v")).toBe("1");
		expect(arrived.searchParams.get("sqr_token")).toBe(token.toLowerCase());
		// Dragged sliders are not a photograph, and a destination is told so.
		expect(arrived.searchParams.get("sqr_src")).toBe("manual");
		expect(Number(arrived.searchParams.get("sqr_az"))).toBeCloseTo(-40, 0);
		expect(Number(arrived.searchParams.get("sqr_dh"))).toBeGreaterThan(0);
		expect(["solid", "soft"]).toContain(arrived.searchParams.get("sqr_tier"));
	});

	test("keeps the creator's own query string and replaces any sqr_ already there", async ({
		page,
	}) => {
		const token = await createCodeWithRedirect(page, `${DESTINATION}?utm=poster&sqr_az=89`);
		await placeManually(page, token);

		await page.waitForURL(/\/how-it-works\?/, { timeout: 20_000 });
		const arrived = new URL(page.url());
		expect(arrived.searchParams.get("utm")).toBe("poster");
		// A forged position in the configured destination must not survive next to
		// the measured one, or nobody downstream can tell which to believe.
		expect(arrived.searchParams.getAll("sqr_az")).toHaveLength(1);
		expect(Number(arrived.searchParams.get("sqr_az"))).toBeCloseTo(-40, 0);
	});

	test("stops on request, and sends nothing until asked again", async ({ page }) => {
		const token = await createCodeWithRedirect(page, DESTINATION);
		await placeManually(page, token);

		await page.getByTestId("handoff-stay").click();
		await expect(page.getByTestId("handoff")).toHaveAttribute("data-seconds", "paused");

		// Comfortably past the countdown: a stopped handoff stays stopped.
		await page.waitForTimeout(5000);
		// Lowercase: the scanned URL is uppercase and the server canonicalises it.
		expect(page.url()).toContain(`/s/${token.toLowerCase()}`);

		await page.getByTestId("handoff-continue").click();
		await page.waitForURL(/\/how-it-works\?/, { timeout: 20_000 });
		expect(new URL(page.url()).searchParams.get("sqr_v")).toBe("1");
	});

	test("a code with no destination still shows the demo's own result", async ({ page }) => {
		const token = await freshToken(page);
		await placeManually(page, token);

		await expect(page.getByRole("button", { name: /position added/i })).toBeVisible();
		await expect(page.getByTestId("handoff")).toHaveCount(0);
		// Lowercase: the scanned URL is uppercase and the server canonicalises it.
		expect(page.url()).toContain(`/s/${token.toLowerCase()}`);
	});

	test("refuses a destination it would not send a visitor to", async ({ page }) => {
		// The server is the only copy of this check that counts, so it is asserted
		// against the API rather than through the form that also runs it.
		const token = await freshToken(page);
		for (const bad of ["javascript:alert(1)", "http://example.com/a", "not a url"]) {
			const res = await page.request.post(`/api/s/${token}/claim`, {
				data: { ownerToken: "e2e-owner-token-0123456789", redirect: bad },
			});
			expect(res.status(), bad).toBe(400);
		}
		const state = await (await page.request.get(`/api/s/${token}/state`)).json();
		expect(state.room.redirect).toBeNull();
	});
});

test.describe("creating a code with a destination", () => {
	test("shows the exact URL a destination will receive", async ({ page }) => {
		await page.goto("/create");
		await page.getByTestId("redirect-input").fill("example.com/arrive?utm=poster");

		// Built by the same function the phone uses, so what a creator reads here
		// is the string their server actually gets rather than a description of it.
		const example = page.getByTestId("redirect-example");
		await expect(example).toContainText("https://example.com/arrive?utm=poster");
		await expect(example).toContainText("sqr_v=1");
		await expect(example).toContainText("sqr_az=-31.4");
		await expect(page.getByTestId("create-room")).toBeEnabled();
	});

	test("will not create a code pointing somewhere it refuses to send anyone", async ({ page }) => {
		await page.goto("/create");
		await page.getByTestId("redirect-input").fill("javascript:alert(1)");
		await expect(page.getByTestId("redirect-schema")).toHaveCount(0);
		await expect(page.getByTestId("create-room")).toBeDisabled();

		await page.getByTestId("redirect-input").fill("https://example.com/arrive");
		await expect(page.getByTestId("create-room")).toBeEnabled();
	});
});
