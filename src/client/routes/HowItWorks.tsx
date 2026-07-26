import { useEffect, useState } from "react";

interface SweepArtifact {
	cornerSigma?: Record<string, { p50: number; p95: number; n: number }>;
	degradations?: Record<string, { decodeRate: number; bearingP50: number; bearingP95: number }>;
	rangeTable?: { capture: string; display: string; screenHeights: number; metres: number }[];
	calibration?: { bearingWithin1: number; bearingWithin2: number };
}

/** The public explanation, with measured data loaded from the L2 test sweep. */
export function HowItWorks() {
	const [sweep, setSweep] = useState<SweepArtifact | null>(null);

	useEffect(() => {
		void fetch("/generated/sweep.json")
			.then((response) => (response.ok ? response.json() : null))
			.then(setSweep)
			.catch(() => setSweep(null));
	}, []);

	const noise = sweep?.degradations?.["heavy-noise"];
	const motion = sweep?.degradations?.["rolling-shutter"];
	const blur = sweep?.degradations?.["heavy-blur"];

	return (
		<main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-12 px-6 py-12 text-sm leading-relaxed text-[var(--hex-muted)]">
			<header className="flex flex-col gap-3">
				<a className="font-mono text-xs text-[var(--hex-accent)] underline" href="/">
					← Back to the demo
				</a>
				<h1 className="text-2xl font-medium text-[var(--hex-text)]">How it works</h1>
				<p>
					A square of declared size can reveal a camera&apos;s position. Here is what the scan
					measures, how we test it, and where it stops working.
				</p>
			</header>

			<Section title="A distorted square reveals camera position">
				<GeometryDiagram />
				<div className="grid gap-3 sm:grid-cols-3">
					<Step number="1" title="Show a declared square">
						The display reports the code&apos;s measured or estimated size and shape.
					</Step>
					<Step number="2" title="Capture its perspective">
						The phone rejects moving frames and chooses a stable one from a short burst.
					</Step>
					<Step number="3" title="Solve the camera position">
						The square&apos;s distortion gives two angles and a distance.
					</Step>
				</div>
			</Section>

			<Section title="What one scan can recover">
				<div className="overflow-x-auto rounded border border-[var(--hex-line)]">
					<table className="w-full text-left">
						<thead className="font-mono text-[11px] text-[var(--hex-dim)] uppercase">
							<tr>
								<th className="px-3 py-2 font-normal">Result</th>
								<th className="px-3 py-2 font-normal">What it means</th>
								<th className="px-3 py-2 text-right font-normal">Accuracy or dependency</th>
							</tr>
						</thead>
						<tbody>
							<AccuracyRow
								result="Side-to-side angle"
								meaning="Left or right of the display"
								accuracy="about 1–3°"
							/>
							<AccuracyRow
								result="Vertical angle"
								meaning="Above or below its centre"
								accuracy="about 1–3°"
							/>
							<AccuracyRow
								result="Display heights"
								meaning="Distance relative to screen height"
								accuracy="no physical-size guess"
							/>
							<AccuracyRow
								result="Metres"
								meaning="Uses estimated screen and camera data"
								accuracy="about ±10–25%"
							/>
						</tbody>
					</table>
				</div>
				<p>
					The result locates the phone camera, not your body. The optional eye position moves the
					result about 40 cm back and 25 cm up.
				</p>
			</Section>

			<Section title="Range depends on the camera and display">
				{sweep?.rangeTable ? (
					<div className="overflow-x-auto rounded border border-[var(--hex-line)]">
						<table className="w-full font-mono text-[11px]">
							<thead>
								<tr className="text-[var(--hex-dim)]">
									<th className="px-3 py-2 text-left font-normal">Camera frame</th>
									<th className="px-3 py-2 text-left font-normal">Display</th>
									<th className="px-3 py-2 text-right font-normal">Display heights</th>
									<th className="px-3 py-2 text-right font-normal">Distance</th>
								</tr>
							</thead>
							<tbody>
								{sweep.rangeTable.map((row) => (
									<tr
										key={`${row.capture}-${row.display}`}
										className="border-t border-[var(--hex-line)]"
									>
										<td className="px-3 py-2 text-[var(--hex-dim)]">{row.capture}</td>
										<td className="px-3 py-2 text-[var(--hex-muted)]">{row.display}</td>
										<td className="tabular px-3 py-2 text-right text-[var(--hex-text)]">
											{row.screenHeights.toFixed(1)}h
										</td>
										<td className="tabular px-3 py-2 text-right text-[var(--hex-text)]">
											{row.metres.toFixed(1)} m
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : (
					<p className="rounded border border-[var(--hex-line)] px-4 py-3 font-mono text-xs text-[var(--hex-dim)]">
						Range data is unavailable.
					</p>
				)}
				<p>
					A larger display gives the camera more pixels to measure. QR density matters too: a longer
					URL adds modules, making each module smaller at the same distance. The app calculates this
					range for the code currently on screen.
				</p>
			</Section>

			<Section title="One frame can fit two positions">
				<MirrorDiagram />
				<p>
					A flat square can produce two mirror-image camera positions. They sit at the same distance
					on opposite sides of the screen, with opposite horizontal and vertical angles.
				</p>
				<p>
					The phone&apos;s tilt sensor cannot tell them apart. The two candidates are mirrored
					through a vertical plane, so the screen faces the same way relative to level in both, and
					knowing which way is down says nothing about which side of the room you are on.
				</p>
				<p>
					So the solver compares how well each position fits every measured point instead. If the
					evidence is too close to call, the app asks for another scan after one step to the right.
					That step is a direction it already knows, and it breaks the tie.
				</p>
			</Section>

			<Section title="The tests set the error bars">
				<figure className="flex flex-col gap-3">
					<img
						src="/generated/error-chart.svg"
						alt="Bearing error and branch ambiguity against apparent marker size"
						className="w-full rounded border border-[var(--hex-line)]"
					/>
					<figcaption className="font-mono text-[11px] text-[var(--hex-dim)]">
						Synthetic captures pass through the production detector and solver. A separate
						projection implementation supplies the known camera positions.
					</figcaption>
				</figure>

				<div className="grid gap-3 sm:grid-cols-3">
					<Datum
						title="Blur stops the scan"
						value={blur ? `${Math.round(blur.decodeRate * 100)}% decoded` : "No decode"}
					>
						Defocus removes the edges needed to read the code.
					</Datum>
					<Datum
						title="Noise has little effect"
						value={noise ? `${noise.bearingP95.toFixed(2)}° p95` : "Averaged out"}
					>
						Line fitting averages independent pixel noise.
					</Datum>
					<Datum
						title="Motion is the hard case"
						value={motion ? `${motion.bearingP95.toFixed(2)}° p95` : "Burst capture"}
					>
						Rolling shutter can look plausible, so moving frames are rejected.
					</Datum>
				</div>

				{sweep?.calibration && (
					<div className="grid grid-cols-2 gap-3 font-mono text-xs">
						<CalibrationStat
							label="Inside 1σ · 68% expected"
							value={`${Math.round(sweep.calibration.bearingWithin1 * 100)}%`}
						/>
						<CalibrationStat
							label="Inside 2σ · 95% expected"
							value={`${Math.round(sweep.calibration.bearingWithin2 * 100)}%`}
						/>
					</div>
				)}
				<p>
					Pixel noise, uncertainty in the camera&apos;s focal length, and uncertainty in the image
					centre all feed the same error calculation. That value draws the area around the result
					and decides when the app should refuse a scan.
				</p>
			</Section>

			<Section title="Size errors change metres, not angles">
				<p>
					If the code is twice as large as declared, the recovered distance also doubles. Both
					angles stay unchanged because scaling the model changes translation, not rotation.
				</p>
				<p>
					That is why display heights come before metres. They compare two lengths measured in the
					same image and do not need the display&apos;s physical size. They still carry
					image-measurement uncertainty.
				</p>
			</Section>

			<Section title="Limits and privacy">
				<div className="grid gap-6 sm:grid-cols-2">
					<div>
						<h3 className="mb-2 font-medium text-[var(--hex-text)]">The model does not cover</h3>
						<ul className="flex list-disc flex-col gap-1.5 pl-5">
							<li>Metre accuracy better than roughly ±25%.</li>
							<li>Curved displays. Ultrawide displays are not tested.</li>
							<li>Keystone-corrected projectors.</li>
							<li>Printed codes with unknown physical size.</li>
							<li>Camera orientation or a verified identity.</li>
						</ul>
					</div>
					<div>
						<h3 className="mb-2 font-medium text-[var(--hex-text)]">The position result</h3>
						<ul className="flex list-disc flex-col gap-1.5 pl-5">
							<li>Horizontal and vertical angle.</li>
							<li>Distance in display heights.</li>
							<li>The result&apos;s uncertainty.</li>
						</ul>
						<p className="mt-3">
							Solid results may also contribute a coarse device signature and focal estimate to
							pooled calibration. Captured images are not uploaded, and the app does not detect
							faces.
						</p>
					</div>
				</div>
			</Section>

			<Section title="Why I built this">
				<p>
					I built this because I thought it was cool that one photograph of an ordinary QR code
					could reveal roughly where the camera was. It was not made for a client, a product, or a
					particular use case; I just wanted to see if the idea worked and how far I could take it.
				</p>
				<p>Some possible uses:</p>
				<ul className="flex flex-col gap-2 pl-4">
					<Application title="Museums and exhibitions">
						Put the code beside an object and send scanners to the museum&apos;s existing web page.
						That page receives the viewing angle and distance in its URL, so it could show a detail
						that is visible from that side or play audio matched to the visitor&apos;s position.
					</Application>
					<Application title="Signs, displays, and wayfinding">
						Ask people to scan from where they naturally stop, then use the plan view, legibility
						check, or CSV export to see whether the display is mounted well and whether its text is
						large enough for the actual viewing distance.
					</Application>
					<Application title="Interactive art and spatial audio">
						Send the scan to an installation&apos;s web controller. It can read which side of the
						room the phone is on and how far away it is, then choose a visual layer, lighting cue,
						or audio mix for that position. Each scan is one input, not continuous tracking.
					</Application>
					<Application title="Architecture and 3D previsualisation">
						Collect scans from real seats or standing positions, export them as glTF cameras, and
						open the file in Blender. A designer can then preview a screen, stage, or installation
						from the viewpoints that were measured in the room.
					</Application>
					<Application title="Computer vision and geometry teaching">
						Use the live result to show how perspective reveals camera position—and why one flat
						image can sometimes produce two mirrored answers. The second-scan prompt and exported
						mirror branch make that failure visible instead of hiding it.
					</Application>
				</ul>
			</Section>

			<section className="flex flex-col gap-3">
				<h2 className="font-mono text-xs tracking-widest text-[var(--hex-dim)] uppercase">
					Technical notes
				</h2>
				<TechnicalNote title="From homography to camera position">
					A plane maps into an image through a 3×3 projective transform with eight independent
					values. Four matching points define it; this detector uses up to 28 points from the QR
					finder patterns and display-corner marks. The transform is decomposed into rotation and
					translation, then both mirror branches are refined against every point.
				</TechnicalNote>
				<TechnicalNote title="Why the QR quiet zone is excluded">
					The marker width runs from the outer corners of the QR symbol, not across its blank
					border. Detectors report symbol corners. Including the four-module quiet zone would
					overstate distance by 32% for a version 2 code while leaving both angles unchanged.
				</TechnicalNote>
				<TechnicalNote title="Corner-location measurements">
					{sweep?.cornerSigma ? (
						<ul className="grid gap-x-6 gap-y-1 font-mono text-xs sm:grid-cols-2">
							{Object.entries(sweep.cornerSigma).map(([name, value]) => (
								<li
									key={name}
									className="flex justify-between border-b border-[var(--hex-line)] py-1"
								>
									<span>{name}</span>
									<span className="text-[var(--hex-text)]">{value.p95.toFixed(2)} px p95</span>
								</li>
							))}
						</ul>
					) : (
						<p>Measurement data is unavailable.</p>
					)}
				</TechnicalNote>
			</section>
		</main>
	);
}

function Application({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<li className="list-disc">
			<span className="text-[var(--hex-text)]">{title}</span> — {children}
		</li>
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

function Step({
	number,
	title,
	children,
}: {
	number: string;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<div className="rounded border border-[var(--hex-line)] px-4 py-3">
			<p className="mb-1 font-mono text-[11px] text-[var(--hex-accent)]">{number}</p>
			<h3 className="mb-1 font-medium text-[var(--hex-text)]">{title}</h3>
			<p className="text-xs">{children}</p>
		</div>
	);
}

function AccuracyRow({
	result,
	meaning,
	accuracy,
}: {
	result: string;
	meaning: string;
	accuracy: string;
}) {
	return (
		<tr className="border-t border-[var(--hex-line)]">
			<th className="px-3 py-2 font-medium text-[var(--hex-text)]">{result}</th>
			<td className="px-3 py-2">{meaning}</td>
			<td className="px-3 py-2 text-right font-mono text-xs text-[var(--hex-text)]">{accuracy}</td>
		</tr>
	);
}

function Datum({
	title,
	value,
	children,
}: {
	title: string;
	value: string;
	children: React.ReactNode;
}) {
	return (
		<div className="rounded border border-[var(--hex-line)] px-4 py-3">
			<h3 className="font-medium text-[var(--hex-text)]">{title}</h3>
			<p className="my-1 font-mono text-xs text-[var(--hex-accent)]">{value}</p>
			<p className="text-xs">{children}</p>
		</div>
	);
}

function CalibrationStat({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded border border-[var(--hex-line)] px-3 py-2">
			<p className="text-[var(--hex-dim)]">{label}</p>
			<p className="text-lg text-[var(--hex-text)]">{value}</p>
		</div>
	);
}

function TechnicalNote({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<details className="rounded border border-[var(--hex-line)] px-4 py-3">
			<summary className="cursor-pointer font-medium text-[var(--hex-text)]">{title}</summary>
			<div className="mt-3">{children}</div>
		</details>
	);
}

function GeometryDiagram() {
	return (
		<svg
			viewBox="0 0 720 190"
			className="w-full rounded border border-[var(--hex-line)] bg-[var(--hex-surface)]/40"
			role="img"
			aria-labelledby="geometry-title geometry-description"
		>
			<title id="geometry-title">From declared square to camera position</title>
			<desc id="geometry-description">
				A square on a display appears as a trapezoid in a camera image. Its perspective locates the
				camera in a top-down plan.
			</desc>
			<g fill="none" stroke="var(--hex-line)" strokeWidth="2">
				<line x1="210" y1="92" x2="270" y2="92" />
				<line x1="450" y1="92" x2="510" y2="92" />
			</g>
			<g fill="var(--hex-dim)">
				<path d="M268 87l10 5-10 5z" />
				<path d="M508 87l10 5-10 5z" />
			</g>
			<rect
				x="58"
				y="35"
				width="110"
				height="110"
				rx="4"
				fill="none"
				stroke="var(--hex-text)"
				strokeWidth="5"
			/>
			<rect x="78" y="55" width="28" height="28" fill="var(--hex-text)" />
			<rect x="120" y="55" width="28" height="28" fill="var(--hex-text)" />
			<rect x="78" y="97" width="28" height="28" fill="var(--hex-text)" />
			<path
				d="M310 42 L420 57 L400 145 L294 124 Z"
				fill="none"
				stroke="var(--hex-accent)"
				strokeWidth="5"
			/>
			<path d="M558 50 H682" stroke="var(--hex-text)" strokeWidth="6" />
			<path d="M620 53 L585 137" stroke="var(--hex-accent)" strokeWidth="2" strokeDasharray="5 5" />
			<circle cx="585" cy="137" r="8" fill="var(--hex-accent)" />
			<g fill="var(--hex-dim)" fontFamily="var(--font-mono)" fontSize="11" textAnchor="middle">
				<text x="113" y="170">
					declared display
				</text>
				<text x="357" y="170">
					camera frame
				</text>
				<text x="620" y="170">
					position from above
				</text>
			</g>
		</svg>
	);
}

function MirrorDiagram() {
	return (
		<svg
			viewBox="0 0 640 210"
			className="w-full rounded border border-[var(--hex-line)] bg-[var(--hex-surface)]/40"
			role="img"
			aria-labelledby="mirror-title mirror-description"
		>
			<title id="mirror-title">Two mirror-image camera positions</title>
			<desc id="mirror-description">
				A display at the top with two possible camera positions at equal distances on opposite
				sides.
			</desc>
			<rect x="240" y="34" width="160" height="7" rx="3" fill="var(--hex-text)" />
			<line
				x1="320"
				y1="42"
				x2="198"
				y2="164"
				stroke="var(--hex-warn)"
				strokeWidth="2"
				strokeDasharray="5 5"
			/>
			<line
				x1="320"
				y1="42"
				x2="442"
				y2="164"
				stroke="var(--hex-warn)"
				strokeWidth="2"
				strokeDasharray="5 5"
			/>
			<circle cx="198" cy="164" r="9" fill="var(--hex-warn)" />
			<circle cx="442" cy="164" r="9" fill="var(--hex-warn)" />
			<g fill="var(--hex-dim)" fontFamily="var(--font-mono)" fontSize="11" textAnchor="middle">
				<text x="320" y="24">
					display
				</text>
				<text x="198" y="190">
					candidate A
				</text>
				<text x="442" y="190">
					candidate B
				</text>
			</g>
		</svg>
	);
}
