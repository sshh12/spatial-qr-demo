import { expect, type Page, test } from "@playwright/test";

/**
 * Isolation between strangers on the landing page.
 *
 * The landing page is the link that gets posted. On a front-page day it is open
 * on thousands of screens at once, and the swap is a full-screen takeover of
 * somebody's display. If two visitors could ever land in the same room, one
 * stranger's phone would blank another stranger's screen -- which is both a
 * broken demo and, on a shared or projected screen, genuinely alarming.
 *
 * So the guarantee is: every landing-page load is its own room, and nothing a
 * phone does in one room is observable in another. The only thing that crosses
 * between visitors is the ghost commons, which is anonymous, aggregated, and
 * deliberately global.
 */

async function tokenOf(page: Page): Promise<string> {
	const url = await page.getByTestId("scan-url").innerText();
	return url.split("/s/")[1]!.trim();
}

test.describe("landing page isolation", () => {
	test("two visitors get different rooms", async ({ browser }) => {
		const a = await browser.newContext();
		const b = await browser.newContext();
		const pageA = await a.newPage();
		const pageB = await b.newPage();
		await pageA.goto("/");
		await pageB.goto("/");

		const [tokenA, tokenB] = await Promise.all([tokenOf(pageA), tokenOf(pageB)]);
		expect(tokenA).not.toBe(tokenB);

		await a.close();
		await b.close();
	});

	test("a stranger's phone cannot take over your screen", async ({ browser }) => {
		const a = await browser.newContext();
		const b = await browser.newContext();
		const mine = await a.newPage();
		const theirs = await b.newPage();
		await mine.goto("/");
		await theirs.goto("/");

		const mineToken = await tokenOf(mine);
		const theirsToken = await tokenOf(theirs);

		// Their phone connects and arms, driving the swap on their screen.
		await theirs.request.post(`/api/s/${theirsToken}/hello`, { data: { role: "phone" } });
		await theirs.request.post(`/api/s/${theirsToken}/armed`, { data: {} });
		await expect(theirs.getByTestId("marker-fullbleed")).toBeVisible({ timeout: 15_000 });

		// Mine must be completely untouched: no swap, no flash, still idle.
		await expect(mine.getByTestId("marker-fullbleed")).toHaveCount(0);
		await expect(mine.getByTestId("live-strip")).toHaveAttribute("data-beat", "idle");

		// And their capture must not flash my screen either.
		await theirs.request.post(`/api/s/${theirsToken}/capturing`, { data: {} });
		await mine.waitForTimeout(1200);
		await expect(mine.getByTestId("shutter-flash")).toHaveCount(0);
		await expect(mine.getByTestId("live-strip")).toHaveAttribute("data-beat", "idle");

		// Their pose lands in their room and not in mine.
		const mineState = await (await mine.request.get(`/api/s/${mineToken}/state`)).json();
		expect(mineState.room.viewers).toEqual([]);

		await a.close();
		await b.close();
	});

	test("a reload keeps the same room, so a paired phone is not orphaned", async ({ browser }) => {
		// The room is the pairing. If reloading the display minted a new one, a
		// phone that had already scanned would be left talking to a room nobody is
		// listening to -- and the failure is silent: the swap simply never comes.
		const context = await browser.newContext();
		const page = await context.newPage();
		await page.goto("/");
		const before = await tokenOf(page);

		await page.reload();
		const after = await tokenOf(page);
		expect(after).toBe(before);

		await context.close();
	});

	test("a second tab is a second room", async ({ browser }) => {
		// Per tab, not per browser: two tabs are two screens as far as anyone is
		// concerned, and they must not fight over one room.
		const context = await browser.newContext();
		const first = await context.newPage();
		const second = await context.newPage();
		await first.goto("/");
		await second.goto("/");

		expect(await tokenOf(first)).not.toBe(await tokenOf(second));
		await context.close();
	});

	test("two displays that collide on one room do not both keep it", async ({ browser }) => {
		// The token carries 32 bits of entropy. Across tens of thousands of rooms
		// that is a real birthday collision risk -- about 10% somewhere in a window
		// of 30,000 rooms -- and the consequence is precisely the takeover this
		// suite exists to prevent. Rather than lengthening the token (which costs
		// QR symbol versions, which costs scan range), the collision is detected at
		// the only moment it matters: when a second display claims a room that
		// already has a different one live in it.
		const context = await browser.newContext();
		const page = await context.newPage();
		await page.goto("/");
		const token = await tokenOf(page);

		const owner = await page.evaluate(() => localStorage.getItem("sqr.clientId"));
		expect(owner).toBeTruthy();

		// A stranger whose token happened to collide is turned away.
		const stranger = await page.request.post(`/api/s/${token}/hello`, {
			data: { role: "display", clientId: "a-different-visitor" },
		});
		expect((await stranger.json()).collision).toBe(true);

		// The display that got there first keeps the room and is undisturbed.
		const mine = await page.request.post(`/api/s/${token}/hello`, {
			data: { role: "display", clientId: owner },
		});
		expect((await mine.json()).collision).toBe(false);
		await expect(page.getByTestId("live-strip")).toHaveAttribute("data-beat", "idle");

		// A phone is never blocked -- only a second display is.
		const phone = await page.request.post(`/api/s/${token}/hello`, {
			data: { role: "phone", clientId: "some-phone" },
		});
		expect((await phone.json()).collision).toBe(false);

		await context.close();
	});
});
