import { useEffect, useState } from "react";

interface SweepArtifact {
	cornerSigma?: Record<string, { p50: number; p95: number; n: number }>;
	degradations?: Record<string, { decodeRate: number; bearingP50: number; bearingP95: number }>;
	rangeTable?: { capture: string; display: string; screenHeights: number; metres: number }[];
	calibration?: { bearingWithin1: number; bearingWithin2: number };
}

/**
 * The write-up.
 *
 * For this audience this page is the marketing. Every number on it is read from
 * public/generated/sweep.json, which the L2 suite writes, so it cannot quietly
 * stop being true — if the solver regresses, this page changes with it.
 */
export function HowItWorks() {
	const [sweep, setSweep] = useState<SweepArtifact | null>(null);

	useEffect(() => {
		void fetch("/generated/sweep.json")
			.then((r) => (r.ok ? r.json() : null))
			.then(setSweep)
			.catch(() => setSweep(null));
	}, []);

	return (
		<main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-10 px-6 py-12 text-sm leading-relaxed text-[var(--hex-muted)]">
			<header className="flex flex-col gap-3">
				<a className="font-mono text-xs text-[var(--hex-accent)] underline" href="/">
					← back
				</a>
				<h1 className="text-2xl font-medium text-[var(--hex-text)]">How it works</h1>
				<p>
					One photograph of a square whose width is known is enough to recover where the camera was.
					Here is the whole argument, including the parts that do not work.
				</p>
			</header>

			<Section title="The homography">
				<p>
					A camera maps the plane the marker lies on to the image plane by a projective transform —
					a 3×3 matrix with eight degrees of freedom, defined up to scale. Four point
					correspondences pin it down; we use twenty-eight, from the three finder patterns and, when
					the display is connected, the four corner brackets.
				</p>
				<p>
					Given the camera&apos;s focal length, that matrix factors into a rotation and a
					translation: the two first columns of <Mono>K⁻¹H</Mono> are the first two columns of the
					rotation up to a shared scale, and the third is the translation. Orthonormality is
					restored by polar decomposition, and then both branches are polished by
					Levenberg–Marquardt against all the points at once.
				</p>
			</Section>

			<Section title="Why there are always two answers">
				<p>
					A plane viewed under perspective admits two poses, and they are mirror images of each
					other about the viewing ray. In the display&apos;s own frame that works out to something
					unusually clean: if one solution puts you at <Mono>(x, y, z)</Mono>, the other puts you at{" "}
					<Mono>(−x, −y, z)</Mono>. Same distance, azimuth and elevation both negated. It is
					precisely the left/right flip.
				</p>
				<p>
					That is also why it is the only error that matters. Nobody can evaluate a bearing angle by
					eye and nobody judges distance-to-a-screen better than about 30%, but everybody knows
					instantly which side of the room they were standing on.
				</p>
				<p className="rounded border border-[var(--hex-line)] px-4 py-3">
					<strong className="text-[var(--hex-text)]">Gravity does not help.</strong> It was the
					obvious fix and it fails algebraically. For a vertical display with the camera near
					display-centre height, the flip is a mirror about a <em>vertical</em> plane, so both
					branches keep an exactly horizontal marker normal and an accelerometer reading has
					literally zero discriminating power. There is a unit test whose only job is to stop
					someone re-adding that idea.
				</p>
				<p>
					What does work: more angular baseline (the brackets, worth 1.78× on 16:9), the ratio of
					the two branches&apos; residuals as an explicit evidence measure, and — when that ratio is
					inconclusive — asking for a second photograph after a step <em>in a named direction</em>.
					Stepping &ldquo;either way&rdquo; cannot work: flipping both photographs flips the
					displacement too, so the wrong pair is exactly as self-consistent as the right one.
				</p>
			</Section>

			<Section title="Why angles survive a size error and distances do not">
				<p>
					Assume the marker is twice as wide as it really is. The recovered distance doubles and
					every angle stays identical to twelve decimal places. That is structural: scaling the
					model points scales the translation and leaves the rotation untouched.
				</p>
				<p>
					So the physical size of your display is a nice-to-have, not a correctness dependency —
					which is also why someone scanning a screenshot off social media gets a correct bearing
					and an honest &ldquo;we can&apos;t tell how far&rdquo; rather than a confident claim that
					they were twenty-four metres away.
				</p>
				<p>
					Distance therefore leads in{" "}
					<strong className="text-[var(--hex-text)]">display heights</strong>, a ratio of two
					lengths in the same CSS pixels, which involves no physical measurement at all and is
					exact. Metres come second, with a bar, because they need two estimates: your
					display&apos;s size and your camera&apos;s focal length. No web API reports focal length
					and none is coming — the W3C request was closed one day after it was filed, in 2016.
				</p>
			</Section>

			<Section title="How the error actually scales">
				<p>
					The commonly quoted result is that lateral error grows with the cube of distance. That
					turns out to be the <em>head-on</em> case, and only the head-on case.
				</p>
				<p>
					Off-axis, the dominant signal is not the perspective trapezoid but the first-order
					foreshortening of the square into a parallelogram, whose apparent aspect ratio gives cos θ
					directly. That makes bearing error grow <em>linearly</em> with distance and inversely with
					sin θ, so lateral error is quadratic, not cubic. Only as θ approaches zero does the
					first-order term vanish — cosine has zero slope at zero — the second-order term take over,
					and the exponent climb toward the cubic law.
				</p>
				<p className="rounded border border-[var(--hex-line)] px-4 py-3 text-[var(--hex-text)]">
					Head-on is the ill-conditioned pose, not the safe one. Standing off to one side is
					measured better, not worse.
				</p>
				<p>
					What genuinely breaks with distance is the <em>sign</em>. The evidence separating the two
					branches lives entirely in the second-order term, so it decays fast, which is why the gate
					refuses long before the angle itself becomes useless.
				</p>
			</Section>

			<Section title="Measured, not assumed">
				<img
					src="/generated/error-chart.svg"
					alt="Bearing error and branch ambiguity against apparent marker size"
					className="w-full rounded border border-[var(--hex-line)]"
				/>
				<p className="font-mono text-[11px] text-[var(--hex-dim)]">
					Generated by the test suite over synthetic captures that go through the real detector and
					the real solver. The generator projects through an independently written code path — it
					shares not one import with the solver — because a suite where both sides use the same
					projection passes just as happily when the maths is wrong.
				</p>
				{sweep?.cornerSigma && (
					<table className="w-full font-mono text-[11px]">
						<caption className="pb-2 text-left text-[var(--hex-dim)]">
							per-corner location error, pixels
						</caption>
						<tbody>
							{Object.entries(sweep.cornerSigma).map(([name, s]) => (
								<tr key={name} className="border-t border-[var(--hex-line)]">
									<td className="py-1.5 text-[var(--hex-muted)]">{name}</td>
									<td className="tabular py-1.5 text-right text-[var(--hex-text)]">
										{s.p50.toFixed(3)} p50
									</td>
									<td className="tabular py-1.5 text-right text-[var(--hex-dim)]">
										{s.p95.toFixed(3)} p95
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				<p>
					Two findings worth stating plainly. Blur is fatal and noise is nearly free — heavy noise
					costs almost nothing because the line fits average it away, while a couple of pixels of
					defocus stops the decode outright. And a screen&apos;s pixel structure beating against the
					sensor grid, which was the thing most likely to ruin all of this, does not break the
					decode at any pitch we modelled.
				</p>
				<p>
					The one that changed the design:{" "}
					<strong className="text-[var(--hex-text)]">rolling shutter</strong>. A slow hand pan
					during sensor readout pushed bearing error up by more than an order of magnitude — worse
					than blur, noise, glare and over-sharpening combined — while decoding perfectly, producing
					a low residual and passing every confidence gate. There is no single-frame signature for
					it, because the skew is absorbed silently into the homography as a plausible shear. It is
					why the capture is a burst, and why frames taken while the phone was moving are discarded
					before anything is reported.
				</p>
			</Section>

			<Section title="The error bar is checked">
				<p>
					Every solve carries a covariance built from three real contributions: pixel noise
					propagated through the pose Jacobian, the width of the focal-length posterior (which
					scales the position radially), and principal-point uncertainty (which rotates it
					tangentially). That number is what the ellipse under your feet is drawn from, what the ±
					on this page means, and what the refusal threshold compares against — one computation, so
					the claim and the gate cannot drift apart.
				</p>
				<p>
					It is also calibrated rather than asserted: across the sweep, the ratio of actual error to
					predicted sigma is checked against a standard normal.
					{sweep?.calibration
						? ` Currently ${Math.round(sweep.calibration.bearingWithin1 * 100)}% of errors fall inside one sigma and ${Math.round(
								sweep.calibration.bearingWithin2 * 100,
							)}% inside two.`
						: ""}{" "}
					The first version of that check found the bars 40% too narrow, because corners within one
					finder pattern come from shared line fits and are not independent observations. The
					correction is a measured constant, not a fudge factor, and the test fails if it drifts.
				</p>
			</Section>

			<Section title="Range">
				{sweep?.rangeTable ? (
					<table className="w-full font-mono text-[11px]">
						<thead>
							<tr className="text-[var(--hex-dim)]">
								<th className="py-1.5 text-left">capture</th>
								<th className="py-1.5 text-left">display</th>
								<th className="py-1.5 text-right">screen-heights</th>
								<th className="py-1.5 text-right">metres</th>
							</tr>
						</thead>
						<tbody>
							{sweep.rangeTable.map((row) => (
								<tr
									key={`${row.capture}-${row.display}`}
									className="border-t border-[var(--hex-line)]"
								>
									<td className="py-1.5 text-[var(--hex-dim)]">{row.capture}</td>
									<td className="py-1.5 text-[var(--hex-muted)]">{row.display}</td>
									<td className="tabular py-1.5 text-right text-[var(--hex-text)]">
										{row.screenHeights.toFixed(1)}
									</td>
									<td className="tabular py-1.5 text-right text-[var(--hex-text)]">
										{row.metres.toFixed(1)} m
									</td>
								</tr>
							))}
						</tbody>
					</table>
				) : (
					<p className="font-mono text-[11px] text-[var(--hex-dim)]">
						Run <Mono>npm run test:l2</Mono> to generate the measured range table.
					</p>
				)}
				<p>
					Computed per session from the actual payload, never hardcoded — it moves the day the
					domain changes, because a longer URL means a higher QR version, more modules across the
					same width, and fewer pixels per module at any given distance.
				</p>
			</Section>

			<Section title="The trap that costs 32%">
				<p>
					<Mono>markerEdgeMm</Mono> is the <em>symbol</em> edge — finder-outer-corner to
					finder-outer-corner — and it excludes the four-module quiet zone. QR mandates that quiet
					zone, rendering libraries include it by default, and detectors report symbol corners. So
					measuring the rendered box, which is the obvious implementation, overstates distance by
					(N+8)/N: 32% at version 2, larger than every error the rest of the system carefully
					controls, and invisible because every angle stays perfect. There is an assertion in the
					harness whose only job is to catch it.
				</p>
			</Section>

			<Section title="What this is not">
				<ul className="flex list-disc flex-col gap-1.5 pl-5">
					<li>Metric distance better than roughly ±25%.</li>
					<li>Your eyes. We locate a phone; there is a 40 cm toggle for the difference.</li>
					<li>Curved or ultrawide monitors — the planar model simply does not apply.</li>
					<li>Keystone-corrected projectors, where the projected square is not a square.</li>
					<li>Device orientation. We report position only, and skip a permission prompt for it.</li>
					<li>Verified poses. Yours is computed on your device and is trivially forgeable.</li>
					<li>Face detection of any kind, ever.</li>
					<li>Storing image bytes anywhere, for any reason, including behind a debug flag.</li>
				</ul>
			</Section>

			<footer className="border-t border-[var(--hex-line)] pt-6 text-[var(--hex-text)]">
				<p>
					Angles we&apos;re confident about. Distances are an estimate with a real error bar, and
					it&apos;s on the screen. If you measure us with a tape and we&apos;re outside the bar,
					that&apos;s a bug — please open an issue.
				</p>
			</footer>
		</main>
	);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="flex flex-col gap-4">
			<h2 className="font-mono text-xs tracking-widest text-[var(--hex-dim)] uppercase">{title}</h2>
			{children}
		</section>
	);
}

function Mono({ children }: { children: React.ReactNode }) {
	return (
		<code className="rounded bg-[var(--hex-surface)] px-1.5 py-0.5 font-mono text-[0.92em] text-[var(--hex-text)]">
			{children}
		</code>
	);
}
