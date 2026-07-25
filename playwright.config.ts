import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const fixture = (name: string) =>
	fileURLToPath(new URL(`./tests/e2e/fixtures/${name}.y4m`, import.meta.url));

/**
 * Chromium's fake camera.
 *
 * `--use-fake-device-for-media-stream` plus `--use-file-for-fake-video-capture`
 * is the only way to put real QR content in front of a real getUserMedia call,
 * and it accepts raw Y4M. The file is looped, which is what lets the burst
 * capture see several frames.
 */
function fakeCamera(name: string): string[] {
	return [
		"--use-fake-device-for-media-stream",
		`--use-file-for-fake-video-capture=${fixture(name)}`,
		"--autoplay-policy=no-user-gesture-required",
	];
}

const viewport = { width: 412, height: 900 };

export default defineConfig({
	testDir: "./tests/e2e",
	globalSetup: "./tests/e2e/global-setup.ts",
	timeout: 90_000,
	expect: { timeout: 15_000 },
	fullyParallel: false,
	workers: 1,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

	use: {
		// `localhost`, not `127.0.0.1`: WebKit only treats the hostname as a
		// potentially-trustworthy origin, so the app's secure-context guard
		// correctly refuses to offer the camera on the IP form. Chromium accepts
		// both, which is exactly how this stays hidden until the WebKit lane runs.
		baseURL: "http://localhost:3210",
		permissions: ["camera"],
		trace: "retain-on-failure",
		video: "off",
	},

	projects: [
		{
			name: "nominal",
			testMatch: /(capture|scene)\.spec\.ts/,
			use: {
				...devices["Desktop Chrome"],
				// Not chromium-headless-shell: that has no GPU, and everything
				// downstream of <Canvas> needs one. SwiftShader's automatic fallback
				// was removed in Chrome 137, so there is no software rescue.
				channel: "chromium",
				viewport,
				isMobile: false,
				launchOptions: { args: fakeCamera("nominal") },
			},
		},
		{
			name: "oblique",
			testMatch: /capture\.spec\.ts/,
			use: {
				...devices["Desktop Chrome"],
				channel: "chromium",
				viewport,
				launchOptions: { args: fakeCamera("oblique") },
			},
		},
		{
			name: "too-far",
			testMatch: /refusal\.spec\.ts/,
			use: {
				...devices["Desktop Chrome"],
				channel: "chromium",
				viewport,
				launchOptions: { args: fakeCamera("too-far") },
			},
		},
		{
			name: "no-code",
			testMatch: /refusal\.spec\.ts/,
			use: {
				...devices["Desktop Chrome"],
				channel: "chromium",
				viewport,
				launchOptions: { args: fakeCamera("no-code") },
			},
		},
		{
			name: "desktop",
			testMatch: /(display|fallback|isolation|redirect)\.spec\.ts/,
			use: {
				...devices["Desktop Chrome"],
				channel: "chromium",
				viewport: { width: 1280, height: 800 },
			},
		},
		{
			/**
			 * The WebKit lane.
			 *
			 * Playwright can now grant camera permission in WebKit and serve a mock
			 * capture stream, but that stream is a synthetic pattern -- there is no
			 * way to feed QR content into it. So acquisition itself stays
			 * human-verified on a real device, and what this lane covers is
			 * everything on the near side of the frame boundary: the permission
			 * state machine, the playsinline/muted/autoplay plumbing, and the
			 * "no code in view" path. That boundary is stated in the README rather
			 * than implied.
			 */
			name: "webkit",
			testMatch: /webkit\.spec\.ts/,
			use: {
				...devices["Desktop Safari"],
				viewport,
				// WebKit will not expose navigator.mediaDevices on a plain-HTTP
				// origin, localhost included, so this lane runs against the TLS
				// terminator. The certificate is self-signed and generated at setup.
				baseURL: "https://localhost:3211",
				ignoreHTTPSErrors: true,
			},
		},
	],

	webServer: [
		{
			command: "npm run build && npm start",
			url: "http://localhost:3210/healthz",
			reuseExistingServer: !process.env.CI,
			timeout: 240_000,
			env: { PORT: "3210", NUM_REPLICAS: "1" },
			stdout: "pipe",
			stderr: "pipe",
		},
		{
			command: "node scripts/https-proxy.mjs",
			url: "https://localhost:3211/healthz",
			reuseExistingServer: !process.env.CI,
			timeout: 60_000,
			ignoreHTTPSErrors: true,
			env: { HTTPS_PORT: "3211", TARGET_PORT: "3210" },
			stdout: "pipe",
			stderr: "pipe",
		},
	],
});
