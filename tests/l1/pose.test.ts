import { homographyDLT, homographyRms } from "@core/homography.ts";
import type { Mat3 } from "@core/linalg.ts";
import { rotationGeodesic } from "@core/linalg.ts";
import { moduleCountForVersion } from "@core/marker.ts";
import {
	cameraCentre,
	DEFAULT_GATES,
	intrinsicsMatrix,
	mirrorBranch,
	poseFromHomography,
	resolveByStep,
	solvePose,
} from "@core/pose.ts";
import type { FocalPrior } from "@core/types.ts";
import { describe, expect, it } from "vitest";
import {
	bearingErrorDeg,
	defaultCamera,
	percentile,
	synthesise,
} from "../support/correspondences.ts";

const N = moduleCountForVersion(2);
const cam = defaultCamera();

function pinnedPrior(f: number): FocalPrior {
	return { f0: f, sigmaLog: 1e-4, source: "supplied" };
}

function genericPrior(f0: number): FocalPrior {
	return { f0, sigmaLog: 0.15, source: "generic" };
}

const baseOptions = {
	imageWidth: cam.width,
	imageHeight: cam.height,
	moduleCount: N,
	sigmaPx: 0.3,
	principalPointSigmaPx: 0,
};

describe("homography", () => {
	it("reproduces exact projections to floating-point precision", () => {
		const s = synthesise({ azimuthDeg: 27, elevationDeg: 12, distanceEdges: 4 }, cam, {
			moduleCount: N,
		});
		const H = homographyDLT(s.correspondences);
		expect(homographyRms(H, s.correspondences)).toBeLessThan(1e-6);
	});

	it("is unchanged by a rigid change of image coordinates it cannot see", () => {
		// Hartley normalisation should make the solve independent of where the
		// image origin happens to be; this catches a missing normalisation step,
		// which otherwise only shows up as mysterious noise sensitivity.
		const s = synthesise({ azimuthDeg: 15, elevationDeg: 5, distanceEdges: 6 }, cam, {
			moduleCount: N,
		});
		const shifted = s.correspondences.map((c) => ({
			...c,
			image: { x: c.image.x + 10_000, y: c.image.y + 10_000 },
		}));
		const H = homographyDLT(shifted);
		expect(homographyRms(H, shifted)).toBeLessThan(1e-4);
	});
});

describe("closed-form pose", () => {
	it("recovers ground truth exactly from noiseless correspondences", () => {
		for (const view of [
			{ azimuthDeg: 0, elevationDeg: 0, distanceEdges: 5 },
			{ azimuthDeg: 35, elevationDeg: 18, distanceEdges: 3.2 },
			{ azimuthDeg: -52, elevationDeg: -9, distanceEdges: 8, rollDeg: 22 },
		]) {
			const s = synthesise(view, cam, { moduleCount: N });
			const H = homographyDLT(s.correspondences);
			const pose = poseFromHomography(H, intrinsicsMatrix({ f: cam.f, cx: cam.cx, cy: cam.cy }));

			const truthR = [
				s.truth.R[0][0],
				s.truth.R[0][1],
				s.truth.R[0][2],
				s.truth.R[1][0],
				s.truth.R[1][1],
				s.truth.R[1][2],
				s.truth.R[2][0],
				s.truth.R[2][1],
				s.truth.R[2][2],
			] as unknown as Mat3;

			expect(rotationGeodesic(pose.R, truthR)).toBeLessThan(1e-6);
			const c = cameraCentre(pose);
			expect(
				Math.hypot(c[0] - s.truth.C[0], c[1] - s.truth.C[1], c[2] - s.truth.C[2]),
			).toBeLessThan(1e-6);
		}
	});
});

describe("the mirror branch", () => {
	it("places the camera at (-x, -y, z): azimuth and elevation both flip", () => {
		const s = synthesise({ azimuthDeg: 31, elevationDeg: 14, distanceEdges: 5 }, cam, {
			moduleCount: N,
		});
		const H = homographyDLT(s.correspondences);
		const pose = poseFromHomography(H, intrinsicsMatrix({ f: cam.f, cx: cam.cx, cy: cam.cy }));
		const mirrored = mirrorBranch(pose);

		const a = cameraCentre(pose);
		const b = cameraCentre(mirrored);
		expect(b[0]).toBeCloseTo(-a[0], 9);
		expect(b[1]).toBeCloseTo(-a[1], 9);
		expect(b[2]).toBeCloseTo(a[2], 9);
	});

	it("is still a rotation, not a reflection", () => {
		const s = synthesise(
			{ azimuthDeg: -40, elevationDeg: 20, distanceEdges: 4, rollDeg: 15 },
			cam,
			{ moduleCount: N },
		);
		const H = homographyDLT(s.correspondences);
		const pose = poseFromHomography(H, intrinsicsMatrix({ f: cam.f, cx: cam.cx, cy: cam.cy }));
		const m = mirrorBranch(pose).R;
		const det =
			m[0] * (m[4] * m[8] - m[5] * m[7]) -
			m[1] * (m[3] * m[8] - m[5] * m[6]) +
			m[2] * (m[3] * m[7] - m[4] * m[6]);
		expect(det).toBeCloseTo(1, 9);
	});

	it("keeps an exactly horizontal marker normal in both branches (gravity cannot help)", () => {
		// CONCEPT.md 6.1. The flip is a mirror about a vertical plane, so the
		// marker normal stays horizontal in both branches and an accelerometer
		// reading has literally zero discriminating power. This test exists so
		// that nobody re-adds the "just use gravity" idea in six months.
		const s = synthesise({ azimuthDeg: 33, elevationDeg: 0, distanceEdges: 5 }, cam, {
			moduleCount: N,
		});
		const H = homographyDLT(s.correspondences);
		const pose = poseFromHomography(H, intrinsicsMatrix({ f: cam.f, cx: cam.cx, cy: cam.cy }));
		const mirrored = mirrorBranch(pose);

		// Marker normal is the third column of R, expressed in the camera frame.
		// "Horizontal" in the camera frame here means no component along camera-y,
		// because the camera has no roll and the display is vertical.
		expect(Math.abs(pose.R[5])).toBeLessThan(1e-9);
		expect(Math.abs(mirrored.R[5])).toBeLessThan(1e-9);
	});
});

describe("solvePose", () => {
	it("recovers position and bearing from clean correspondences", () => {
		for (const view of [
			{ azimuthDeg: 22, elevationDeg: 11, distanceEdges: 4 },
			{ azimuthDeg: -38, elevationDeg: 6, distanceEdges: 6 },
			{ azimuthDeg: 8, elevationDeg: -14, distanceEdges: 3 },
		]) {
			const s = synthesise(view, cam, { moduleCount: N });
			const sol = solvePose(s.correspondences, { ...baseOptions, prior: pinnedPrior(cam.f) });

			expect(sol.primary.azimuthDeg).toBeCloseTo(view.azimuthDeg, 4);
			expect(sol.primary.elevationDeg).toBeCloseTo(view.elevationDeg, 4);
			expect(sol.primary.distanceEdges).toBeCloseTo(view.distanceEdges, 4);
			expect(sol.tier).not.toBe("refused");
		}
	});

	it("keeps the alternate branch on the other side of the display", () => {
		const view = { azimuthDeg: 26, elevationDeg: 10, distanceEdges: 5 };
		const s = synthesise(view, cam, { moduleCount: N, sigmaPx: 0.4, seed: 7 });
		const sol = solvePose(s.correspondences, { ...baseOptions, prior: pinnedPrior(cam.f) });
		expect(Math.sign(sol.alternate.azimuthDeg)).toBe(-Math.sign(sol.primary.azimuthDeg));
	});

	it("refuses rather than guessing when the two branches are equally good", () => {
		// Far away, where perspective is weak: the honest answer is "two poses fit".
		const view = { azimuthDeg: 20, elevationDeg: 2, distanceEdges: 60 };
		const s = synthesise(view, cam, { moduleCount: N, sigmaPx: 1.2, seed: 99 });
		const sol = solvePose(s.correspondences, {
			...baseOptions,
			sigmaPx: 1.2,
			prior: genericPrior(cam.f),
		});
		expect(sol.tier).toBe("refused");
		expect(sol.refusal?.code).toMatch(/ambiguous|marker-too-small|high-residual/);
	});

	it("treats a head-on view as unambiguous rather than maximally ambiguous", () => {
		const s = synthesise({ azimuthDeg: 0, elevationDeg: 0.4, distanceEdges: 4 }, cam, {
			moduleCount: N,
			sigmaPx: 0.3,
			seed: 3,
		});
		const sol = solvePose(s.correspondences, { ...baseOptions, prior: pinnedPrior(cam.f) });
		expect(sol.branchSeparationDeg).toBeLessThan(DEFAULT_GATES.collapseSeparationDeg);
		expect(sol.branchMargin).toBe(Number.POSITIVE_INFINITY);
		expect(sol.tier).not.toBe("refused");
	});

	it("reports a distance error bar that shrinks as the focal prior tightens", () => {
		const s = synthesise({ azimuthDeg: 25, elevationDeg: 12, distanceEdges: 4 }, cam, {
			moduleCount: N,
			sigmaPx: 0.3,
			seed: 11,
		});
		const loose = solvePose(s.correspondences, {
			...baseOptions,
			prior: { f0: cam.f, sigmaLog: 0.15, source: "generic" },
		});
		const tight = solvePose(s.correspondences, {
			...baseOptions,
			prior: { f0: cam.f, sigmaLog: 0.02, source: "measured" },
		});
		expect(tight.primary.focalSigmaLog).toBeLessThan(loose.primary.focalSigmaLog);
		expect(loose.primary.focalSigmaLog).toBeLessThanOrEqual(0.15);
	});
});

describe("the scale-invariance property the whole product rests on", () => {
	it("leaves every angle untouched when the assumed marker size is wrong", () => {
		// CONCEPT.md section 1. Assuming the marker is k times its true size scales
		// distance by exactly k and moves no angle at all. If this ever fails, the
		// screenshot path and the whole "size is a nice-to-have" argument fail with
		// it, so it is asserted to twelve digits rather than loosely.
		const view = { azimuthDeg: 29, elevationDeg: -13, distanceEdges: 5 };
		const s = synthesise(view, cam, { moduleCount: N, sigmaPx: 0.5, seed: 21 });

		const truthSolve = solvePose(s.correspondences, {
			...baseOptions,
			prior: pinnedPrior(cam.f),
		});

		for (const k of [0.5, 2, 7.3]) {
			const scaled = s.correspondences.map((c) => ({
				...c,
				model: { x: c.model.x * k, y: c.model.y * k },
			}));
			const solve = solvePose(scaled, { ...baseOptions, prior: pinnedPrior(cam.f) });

			expect(solve.primary.azimuthDeg).toBeCloseTo(truthSolve.primary.azimuthDeg, 9);
			expect(solve.primary.elevationDeg).toBeCloseTo(truthSolve.primary.elevationDeg, 9);
			expect(solve.primary.distanceEdges / truthSolve.primary.distanceEdges).toBeCloseTo(k, 9);
		}
	});
});

describe("accuracy under pixel noise", () => {
	it("holds bearing error inside the claimed 1-3 degrees at room scale", () => {
		const errors: number[] = [];
		const distanceErrors: number[] = [];
		let flips = 0;
		let attempted = 0;

		for (let seed = 0; seed < 240; seed++) {
			const rnd = (a: number, b: number) => a + (((seed * 2654435761) % 1000) / 1000) * (b - a);
			const view = {
				azimuthDeg: rnd(-45, 45) * (seed % 2 === 0 ? 1 : -1),
				elevationDeg: rnd(-20, 20),
				distanceEdges: 3 + (((seed * 7919) % 100) / 100) * 5,
				rollDeg: rnd(-8, 8),
			};
			const s = synthesise(view, cam, { moduleCount: N, sigmaPx: 0.5, seed: 1000 + seed });
			const sol = solvePose(s.correspondences, {
				...baseOptions,
				sigmaPx: 0.5,
				prior: genericPrior(cam.f),
			});
			if (sol.tier === "refused") continue;
			attempted++;

			errors.push(bearingErrorDeg(sol.primary.camera, s.truth.C));
			distanceErrors.push(
				Math.abs(sol.primary.distanceEdges - view.distanceEdges) / view.distanceEdges,
			);
			if (Math.sign(sol.primary.azimuthDeg) !== Math.sign(view.azimuthDeg)) flips++;
		}

		expect(attempted).toBeGreaterThan(150);
		// Assert on p50/p95, never per-case max: one unlucky draw is not a
		// regression and a suite that fails on it gets muted within a week.
		expect(percentile(errors, 50)).toBeLessThan(1.0);
		expect(percentile(errors, 95)).toBeLessThan(3.0);
		expect(percentile(distanceErrors, 95)).toBeLessThan(0.25);
		expect(flips / attempted).toBeLessThan(0.02);
	});

	/**
	 * How the error actually scales, measured rather than assumed.
	 *
	 * CONCEPT.md quotes lateral sigma proportional to Z^3 / (f * S^2). That is the
	 * *head-on* case, and only the head-on case. Off-axis, the dominant signal is
	 * not the perspective trapezoid at all -- it is the first-order foreshortening
	 * of the square into a parallelogram, whose apparent aspect ratio gives
	 * cos(theta) directly. That yields
	 *
	 *     sigma_bearing ~ sigma_px * Z / (f * sin(theta))
	 *
	 * so bearing error is *linear* in distance off-axis, and lateral error is
	 * quadratic, not cubic. Only as theta approaches zero does the first-order
	 * term vanish (cos has zero slope at 0), the second-order perspective term
	 * take over, and the exponent climb toward the quoted cubic.
	 *
	 * The practical consequence is the interesting half: head-on is the
	 * ill-conditioned pose, not the safe one, and off-axis angles survive to much
	 * greater distance than the cubic law suggests. What actually breaks with
	 * distance is the *sign*, which is the next test.
	 */
	const bearingMagnitudeError = (distance: number, azimuthDeg: number): number => {
		const samples: number[] = [];
		for (let seed = 0; seed < 80; seed++) {
			const s = synthesise({ azimuthDeg, elevationDeg: 6, distanceEdges: distance }, cam, {
				moduleCount: N,
				sigmaPx: 0.5,
				seed: 5000 + seed,
			});
			const sol = solvePose(s.correspondences, {
				...baseOptions,
				sigmaPx: 0.5,
				prior: pinnedPrior(cam.f),
				gates: { ...DEFAULT_GATES, softMargin: 0, softPxPerModule: 0, maxRmsPx: 1e9 },
			});
			// Magnitude only; the sign is a separate failure mode, tested below.
			samples.push(Math.abs(Math.abs(sol.primary.azimuthDeg) - Math.abs(azimuthDeg)));
		}
		return percentile(samples, 50);
	};

	it("has bearing error linear in distance when off-axis", () => {
		const near = bearingMagnitudeError(4, 20);
		const far = bearingMagnitudeError(32, 20);
		const exponent = Math.log(far / near) / Math.log(8);
		expect(exponent).toBeGreaterThan(0.8);
		expect(exponent).toBeLessThan(1.4);

		// Lateral error is therefore quadratic: lateral = Z * bearing.
		expect(exponent + 1).toBeGreaterThan(1.8);
	});

	it("scales bearing error as 1/sin(theta), so head-on is the worst pose", () => {
		const shallow = bearingMagnitudeError(8, 5);
		const oblique = bearingMagnitudeError(8, 40);
		// sin(40)/sin(5) is about 7.4; allow a wide band, assert the direction and
		// rough magnitude rather than a constant.
		expect(shallow / oblique).toBeGreaterThan(3);
		expect(shallow / oblique).toBeLessThan(15);
	});

	it("climbs toward the cubic law only as the view approaches head-on", () => {
		const headOn =
			Math.log(bearingMagnitudeError(32, 0.5) / bearingMagnitudeError(4, 0.5)) / Math.log(8);
		const offAxis =
			Math.log(bearingMagnitudeError(32, 20) / bearingMagnitudeError(4, 20)) / Math.log(8);
		expect(headOn).toBeGreaterThan(offAxis);
	});

	it("loses the *sign* long before it loses the angle, and the gate catches it", () => {
		// This is the failure that matters: nobody can evaluate a bearing by eye,
		// but everybody knows which side of the room they were standing on. The
		// branch-margin gate exists to refuse exactly this regime.
		const measure = (distance: number) => {
			let flips = 0;
			let refused = 0;
			const total = 80;
			for (let seed = 0; seed < total; seed++) {
				const s = synthesise({ azimuthDeg: 10, elevationDeg: 6, distanceEdges: distance }, cam, {
					moduleCount: N,
					sigmaPx: 0.5,
					seed: 60000 + seed,
				});
				const sol = solvePose(s.correspondences, {
					...baseOptions,
					sigmaPx: 0.5,
					prior: pinnedPrior(cam.f),
					gates: { ...DEFAULT_GATES, softPxPerModule: 0, maxRmsPx: 1e9 },
				});
				if (sol.tier === "refused") refused++;
				else if (Math.sign(sol.primary.azimuthDeg) !== 1) flips++;
			}
			return { flipRate: flips / total, refusedRate: refused / total };
		};

		const close = measure(6);
		const far = measure(32);

		// Close in, no refusals and no flips.
		expect(close.refusedRate).toBeLessThan(0.05);
		expect(close.flipRate).toBe(0);

		// Far out, the solver refuses rather than guessing a side.
		expect(far.refusedRate).toBeGreaterThan(0.7);
		expect(far.flipRate).toBeLessThan(0.1);
	});
});

describe("two-view disambiguation", () => {
	it("resolves the flip from a step in a named direction", () => {
		// A step in an *unnamed* direction cannot work: flipping both captures
		// negates the displacement, so the flipped pair is exactly as
		// self-consistent as the true one. Naming the direction breaks the symmetry.
		const first = { azimuthDeg: 24, elevationDeg: 6, distanceEdges: 6 };
		const stepEdges = 0.35;
		const firstC = {
			x: first.distanceEdges * Math.sin((first.azimuthDeg * Math.PI) / 180),
			z: first.distanceEdges * Math.cos((first.azimuthDeg * Math.PI) / 180),
		};
		const secondX = firstC.x + stepEdges;
		const second = {
			azimuthDeg: (Math.atan2(secondX, firstC.z) * 180) / Math.PI,
			elevationDeg: 6,
			distanceEdges: Math.hypot(secondX, firstC.z) / Math.cos((6 * Math.PI) / 180),
		};

		const sa = synthesise(first, cam, { moduleCount: N, sigmaPx: 0.5, seed: 31 });
		const sb = synthesise(second, cam, { moduleCount: N, sigmaPx: 0.5, seed: 32 });
		const solA = solvePose(sa.correspondences, { ...baseOptions, prior: genericPrior(cam.f) });
		const solB = solvePose(sb.correspondences, { ...baseOptions, prior: genericPrior(cam.f) });

		const resolved = resolveByStep(solA, solB, "right");
		expect(resolved.confident).toBe(true);
		expect(resolved.lateralEdges).toBeGreaterThan(0);
		expect(Math.sign(resolved.first.azimuthDeg)).toBe(1);
	});
});
