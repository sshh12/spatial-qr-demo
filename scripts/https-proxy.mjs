import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import selfsigned from "selfsigned";

/**
 * A TLS terminator, for the WebKit test lane and for testing on a real phone.
 *
 * Browsers will not hand over a camera to an insecure origin, and
 * `http://192.168.1.50:3000` is an insecure origin no matter how local your
 * network is. `localhost` gets a special exemption; a LAN IP does not. WebKit is
 * stricter again and refuses even `http://127.0.0.1`, which is exactly what a
 * real iPhone does.
 *
 * So: terminate TLS here with a self-signed certificate that names the machine's
 * LAN addresses, and forward plain HTTP to the app. The certificate is untrusted,
 * so the phone shows a warning once and you accept it.
 *
 *   HTTPS_PORT   port to listen on              (default 3211)
 *   HTTPS_HOST   interface to bind              (default 127.0.0.1; use 0.0.0.0 for LAN)
 *   TARGET_PORT  the app's plain HTTP port      (default 3210)
 *
 * Production needs none of this: Railway terminates TLS in front of the process,
 * which is why the secure-context requirement is satisfied there for free.
 */

const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? 3211);
const HTTPS_HOST = process.env.HTTPS_HOST ?? "127.0.0.1";
const TARGET_PORT = Number(process.env.TARGET_PORT ?? 3210);
const CERT_DIR = resolve(process.cwd(), ".playwright");

export function localAddresses() {
	const out = [];
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family === "IPv4" && !entry.internal) out.push(entry.address);
		}
	}
	return out;
}

export async function ensureCertificate(extraIps = []) {
	// The certificate must name every address the phone might use, so the cache
	// key has to include them or a stale localhost-only cert gets reused.
	const ips = ["127.0.0.1", ...extraIps];
	const tag = ips.join("_").replace(/[^0-9a-z]/gi, "-");
	const certPath = resolve(CERT_DIR, `cert-${tag}.pem`);
	const keyPath = resolve(CERT_DIR, `key-${tag}.pem`);

	if (existsSync(certPath) && existsSync(keyPath)) {
		return { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8") };
	}

	// selfsigned v5 returns a promise; v4 returned the pems directly.
	const pems = await selfsigned.generate([{ name: "commonName", value: "localhost" }], {
		days: 3650,
		keySize: 2048,
		extensions: [
			{
				name: "subjectAltName",
				altNames: [{ type: 2, value: "localhost" }, ...ips.map((ip) => ({ type: 7, ip }))],
			},
		],
	});
	mkdirSync(dirname(certPath), { recursive: true });
	writeFileSync(certPath, pems.cert);
	writeFileSync(keyPath, pems.private);
	return { cert: pems.cert, key: pems.private };
}

const lan = HTTPS_HOST === "127.0.0.1" ? [] : localAddresses();
const { cert, key } = await ensureCertificate(lan);

const server = createServer({ cert, key }, (req, res) => {
	const upstream = httpRequest(
		{
			host: "127.0.0.1",
			port: TARGET_PORT,
			method: req.method,
			path: req.url,
			headers: {
				...req.headers,
				// Pass the client's own Host through untouched. The app derives its
				// origin from it, so rewriting it here would bake an unreachable
				// address into the QR payload the phone is being asked to scan.
				"x-forwarded-proto": "https",
				"x-forwarded-host": req.headers.host ?? "",
			},
		},
		(upstreamRes) => {
			res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
			upstreamRes.pipe(res);
		},
	);
	upstream.on("error", () => {
		res.writeHead(502);
		res.end("upstream unavailable");
	});
	req.pipe(upstream);
});

server.listen(HTTPS_PORT, HTTPS_HOST, () => {
	console.log(`https://localhost:${HTTPS_PORT}  ->  http://127.0.0.1:${TARGET_PORT}`);
	for (const ip of lan) console.log(`https://${ip}:${HTTPS_PORT}`);
});
