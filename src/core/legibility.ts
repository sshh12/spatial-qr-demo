/**
 * How far away a screen stops being readable.
 *
 * This is the one question the measured positions can answer that nothing else
 * on the page can. We know how far each person stood in display heights, and a
 * font size on that display is also a fraction of its height -- so the angle a
 * character subtended at each measured position is a ratio of two ratios, with
 * no physical size and no focal length anywhere in it. Exact, like the distance
 * unit it inherits, and for the same reason.
 *
 * Everything here is deliberately dimensionless. Converting to metres first
 * would drag the display's estimated physical size into an answer that does not
 * need it, and would put an error bar on a number that has none.
 */

/**
 * Minimum character height for legibility, in arcminutes.
 *
 * ISO 9241-303 puts the floor for character height at 16 arcminutes and
 * recommends 20-22 for sustained reading. The floor is the honest threshold to
 * draw a boundary at: below it the text is not small, it is unreadable.
 */
export const LEGIBLE_ARCMIN = 16;

/** The comfortable threshold, for sustained reading rather than a glance. */
export const COMFORTABLE_ARCMIN = 22;

/**
 * The furthest distance, in display heights, at which text stays legible.
 *
 * `textFraction` is the character height divided by the display's height, both
 * in the same units -- so 0.025 is text one fortieth of the screen's height,
 * which is roughly body text on a presentation slide.
 */
export function legibleDistanceHeights(textFraction: number, arcMinutes = LEGIBLE_ARCMIN): number {
	if (!(textFraction > 0) || !(arcMinutes > 0)) return 0;
	// Half-angle, because the character subtends `arcMinutes` in total.
	const halfAngleRad = (arcMinutes / 60 / 2) * (Math.PI / 180);
	return textFraction / (2 * Math.tan(halfAngleRad));
}

/** The inverse: what a character of that size actually subtended, in arcminutes. */
export function subtendedArcMin(textFraction: number, distanceHeights: number): number {
	if (!(distanceHeights > 0) || !(textFraction > 0)) return 0;
	const halfAngleRad = Math.atan(textFraction / (2 * distanceHeights));
	return ((halfAngleRad * 2 * 180) / Math.PI) * 60;
}

/**
 * A few reference text sizes, as fractions of display height.
 *
 * Named for what they are on a screen somebody is presenting from, because that
 * is the situation where the answer is actionable. The percentages are measured
 * off common defaults: 16px body text on a 1080p display is 1.5% of its height,
 * a 28px slide caption is 2.6%, a 54px slide heading is 5%.
 */
export const TEXT_SIZES = [
	{ id: "caption", label: "caption", fraction: 0.015 },
	{ id: "body", label: "slide body", fraction: 0.026 },
	{ id: "heading", label: "slide heading", fraction: 0.05 },
] as const;

export type TextSizeId = (typeof TEXT_SIZES)[number]["id"];

/**
 * The viewing cone, in degrees off the display's normal.
 *
 * Beyond roughly 40 degrees an IPS panel has lost a good part of its contrast
 * and a VA panel most of it, so a position outside this cone saw a measurably
 * worse picture than the one being presented. It is a property of the panel
 * rather than of the measurement, which is why it is a constant and not an
 * estimate with a bar on it.
 */
export const VIEWING_CONE_DEG = 40;
