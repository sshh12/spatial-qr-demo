import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";

/**
 * Serve the built app to a phone on the same network.
 *
 * Two processes: the app on plain HTTP, and a TLS terminator in front of it
 * bound to every interface. The TLS half is not optional. Browsers refuse
 * `getUserMedia` outside a secure context, `localhost` gets a special exemption
 * and a LAN address does not -- so `http://192.168.x.x:3000` gives you the
 * display page and a camera that will never turn on.
 *
 * The certificate is self-signed, so the phone will warn once. Accept it.
 */

const APP_PORT = process.env.PORT ?? "3210";
const TLS_PORT = process.env.HTTPS_PORT ?? "3211";

const children = [
	spawn(process.execPath, ["dist/server/index.js"], {
		env: { ...process.env, PORT: APP_PORT, NUM_REPLICAS: "1" },
		stdio: "inherit",
	}),
	spawn(process.execPath, ["scripts/https-proxy.mjs"], {
		env: { ...process.env, HTTPS_PORT: TLS_PORT, HTTPS_HOST: "0.0.0.0", TARGET_PORT: APP_PORT },
		stdio: "inherit",
	}),
];

const addresses = Object.values(networkInterfaces())
	.flatMap((entries) => entries ?? [])
	.filter((entry) => entry.family === "IPv4" && !entry.internal)
	.map((entry) => entry.address);

setTimeout(() => {
	console.log("\n  Open this on the computer whose screen you want to measure:\n");
	for (const address of addresses) console.log(`      https://${address}:${TLS_PORT}\n`);
	console.log("  Then scan the code with the phone, on the same network.");
	console.log("  Both will warn about the certificate once. That is expected: it is");
	console.log("  self-signed, and the camera will not work over plain HTTP.\n");
}, 800);

const stop = () => {
	for (const child of children) child.kill();
	process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) child.on("exit", stop);
