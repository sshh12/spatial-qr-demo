import { useEffect, useState } from "react";
import { Create } from "./routes/Create.tsx";
import { Display } from "./routes/Display.tsx";
import { HowItWorks } from "./routes/HowItWorks.tsx";
import { Scan } from "./routes/Scan.tsx";

export type Route =
	| { name: "display"; token: string | null }
	| { name: "scan"; token: string }
	| { name: "create" }
	| { name: "how" }
	| { name: "not-found" };

export function parseRoute(pathname: string): Route {
	const path = pathname.replace(/\/+$/, "") || "/";
	if (path === "/") return { name: "display", token: null };
	if (path.toLowerCase() === "/create") return { name: "create" };
	if (path.toLowerCase() === "/how-it-works") return { name: "how" };

	// Case-insensitive on purpose. The QR payload is uppercase from end to end --
	// `HTTPS://HOST/S/TOKEN` -- because QR's alphanumeric mode has no lowercase
	// and dropping to byte mode costs about 45% of the payload capacity, which
	// costs symbol versions, which costs scan range. So the path a phone actually
	// opens is `/S/...`, and a router that only knows `/s/...` sends every single
	// scanned code to a 404. The server also redirects to the lowercase form so
	// the address bar stops shouting, but the client must not depend on that.
	const scan = /^\/s\/([0-9a-z]+)$/i.exec(path);
	if (scan) return { name: "scan", token: scan[1]!.toUpperCase() };

	const display = /^\/d\/([0-9a-z]+)$/i.exec(path);
	if (display) return { name: "display", token: display[1]!.toUpperCase() };

	return { name: "not-found" };
}

/**
 * A twenty-line router, because there are five routes and one of them must
 * never navigate.
 *
 * The phone flow at /s/:token is a single page load from the cold open all the
 * way to the 3D reveal. iOS revokes an "Allow Once" camera grant on navigation
 * and offers no API to ask again, so a route change mid-flow is not a slow path,
 * it is a dead end. Pulling in a router that might prefetch, redirect or
 * remount would put that guarantee in someone else's hands.
 */
export function navigate(to: string): void {
	window.history.pushState({}, "", to);
	window.dispatchEvent(new PopStateEvent("popstate"));
}

export function App() {
	const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

	useEffect(() => {
		const onPop = () => setRoute(parseRoute(window.location.pathname));
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

	switch (route.name) {
		case "display":
			return <Display token={route.token} />;
		case "scan":
			return <Scan token={route.token} />;
		case "create":
			return <Create />;
		case "how":
			return <HowItWorks />;
		default:
			return (
				<main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-6">
					<h1 className="font-mono text-lg text-[var(--hex-text)]">Display not found</h1>
					<p className="text-sm text-[var(--hex-muted)]">
						We couldn&apos;t find a display at this address.
					</p>
					<a className="font-mono text-sm text-[var(--hex-accent)] underline" href="/">
						Open the demo
					</a>
				</main>
			);
	}
}
