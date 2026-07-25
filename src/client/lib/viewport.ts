import { useEffect, useState } from "react";

/**
 * Is this the kind of device you would *hold*, rather than one you would put a
 * marker on?
 *
 * Deliberately not user-agent sniffing. The question is not "is this iOS", it is
 * "is this screen something a person could reasonably point a different camera
 * at" -- and the honest signals for that are a coarse pointer and a small
 * viewport. A tablet propped on a desk is a legitimate display and gets to say
 * so; a phone in someone's hand is not, because the only camera nearby is the
 * one attached to it.
 */
export function useHandheld(): boolean {
	const [handheld, setHandheld] = useState(() => detect());

	useEffect(() => {
		const update = () => setHandheld(detect());
		const media = matchMedia("(pointer: coarse)");
		media.addEventListener("change", update);
		window.addEventListener("resize", update);
		window.addEventListener("orientationchange", update);
		return () => {
			media.removeEventListener("change", update);
			window.removeEventListener("resize", update);
			window.removeEventListener("orientationchange", update);
		};
	}, []);

	return handheld;
}

function detect(): boolean {
	if (typeof window === "undefined" || typeof matchMedia !== "function") return false;
	const coarse = matchMedia("(pointer: coarse)").matches;
	const small = Math.min(window.innerWidth, window.innerHeight) < 820;
	return coarse && small;
}
