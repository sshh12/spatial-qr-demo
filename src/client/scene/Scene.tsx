import type { Ghost, Viewer } from "@core/api.ts";
import { ContactShadows, Environment, Lightformer, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Component, type ReactNode, useMemo, useRef } from "react";
import * as THREE from "three";
import { hex, viewerColour } from "../lib/palette.ts";

export interface SceneProps {
	readonly viewers: readonly Viewer[];
	readonly ghosts?: readonly Ghost[];
	readonly meId?: string | null;
	/** Physical height of the display, in metres. */
	readonly displayHeightM: number;
	readonly displayAspect: number;
	/** The captured frame, painted onto the display plane. */
	readonly photo?: HTMLCanvasElement | null;
	/** Show eye position rather than phone position. */
	readonly eyes?: boolean;
	readonly reducedMotion?: boolean;
	readonly className?: string;
}

/**
 * The honest reconstruction.
 *
 * No walls, because we do not know where the walls are. No theatre, because a
 * theatre seat cannot be checked and a reconstruction of the room somebody was
 * just standing in can. The one liberty taken is the ground plane: we have no
 * idea how high the display is mounted, so the plane drawn here is the
 * horizontal plane through the display's own centre, and the readout says so.
 * Inventing a floor height would be inventing the one number nobody measured.
 *
 * All geometry is procedural and all lighting comes from Lightformers inside a
 * locally-generated environment. There is not a single downloaded asset, which
 * keeps the bundle honest and the licence surface empty. `<Environment preset>`
 * is deliberately not used: it fetches an HDRI from a CDN.
 */
/**
 * Is there a usable WebGL context at all?
 *
 * Checked rather than assumed, because the failure mode otherwise is a canvas
 * of zero size sitting where the scene should be -- which looks like a bug in
 * the geometry rather than a missing GPU. Headless browsers without a GPU,
 * blocked contexts and exhausted devices all land here, and all of them are
 * recoverable: the plan view carries the same information.
 */
function webglAvailable(): boolean {
	if (typeof document === "undefined") return false;
	try {
		const probe = document.createElement("canvas");
		const gl =
			probe.getContext("webgl2") ??
			probe.getContext("webgl") ??
			probe.getContext("experimental-webgl");
		if (!gl) return false;
		(gl as WebGLRenderingContext).getExtension("WEBGL_lose_context")?.loseContext();
		return true;
	} catch {
		return false;
	}
}

export function Scene(props: SceneProps) {
	const supported = useMemo(webglAvailable, []);
	if (!supported) {
		return (
			<div
				data-testid="scene-fallback"
				className="flex h-full min-h-48 items-center justify-center px-6 text-center font-mono text-xs text-[var(--hex-muted)]"
			>
				3D is unavailable on this device, so the plan view below is the whole story.
				<br />
				It has the same numbers in it.
			</div>
		);
	}

	return (
		<SceneBoundary>
			<Canvas
				className={props.className}
				dpr={[1, 2]}
				gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
				camera={{ position: [1.9, 1.35, 3.4], fov: 42, near: 0.05, far: 80 }}
				data-testid="scene-canvas"
				onCreated={({ gl, scene }) => {
					gl.setClearColor(new THREE.Color(hex("void")));
					scene.fog = new THREE.Fog(new THREE.Color(hex("void")), 9, 26);
				}}
			>
				<SceneContents {...props} />
			</Canvas>
		</SceneBoundary>
	);
}

function SceneContents({
	viewers,
	ghosts = [],
	meId = null,
	displayHeightM,
	displayAspect,
	photo = null,
	eyes = false,
	reducedMotion = false,
}: SceneProps) {
	const displayWidthM = displayHeightM * displayAspect;

	return (
		<>
			<ambientLight intensity={0.22} />
			<Environment resolution={256} frames={1}>
				{/* Procedural studio lighting: zero bytes downloaded, no CDN. */}
				<Lightformer
					form="rect"
					intensity={1.6}
					position={[0, 3, 2]}
					scale={[6, 3, 1]}
					color="#ffffff"
				/>
				<Lightformer
					form="rect"
					intensity={0.6}
					position={[-4, 1.4, -2]}
					scale={[5, 4, 1]}
					color={hex("accent")}
				/>
				<Lightformer
					form="circle"
					intensity={0.9}
					position={[4, 2.4, -1]}
					scale={3}
					color="#ffffff"
				/>
			</Environment>

			<ReferencePlane heightM={displayHeightM} />
			<DistanceArcs displayHeightM={displayHeightM} maxScreenHeights={maxHeights(viewers)} />
			<DisplayPanel widthM={displayWidthM} heightM={displayHeightM} photo={photo} />

			{ghosts.map((g, i) => (
				<GhostMark key={`${g.at}-${i}`} ghost={g} displayHeightM={displayHeightM} />
			))}

			{viewers.map((v) =>
				v.pose ? (
					<ViewerMark
						key={v.id}
						viewer={v}
						displayHeightM={displayHeightM}
						isMe={v.id === meId}
						eyes={eyes}
					/>
				) : null,
			)}

			<ContactShadows
				position={[0, -displayHeightM / 2 + 0.001, 0]}
				opacity={0.42}
				scale={16}
				blur={2.4}
				far={5}
				resolution={512}
			/>

			<OrbitControls
				makeDefault
				enablePan={false}
				enableDamping={!reducedMotion}
				dampingFactor={0.08}
				minDistance={1.2}
				maxDistance={18}
				maxPolarAngle={Math.PI * 0.52}
				target={[0, 0, 0]}
				autoRotate={!reducedMotion}
				autoRotateSpeed={0.35}
			/>
		</>
	);
}

function maxHeights(viewers: readonly Viewer[]): number {
	return Math.max(2, ...viewers.map((v) => v.pose?.dh ?? 0));
}

/** The horizontal plane through the display's centre. Not a floor. */
function ReferencePlane({ heightM }: { heightM: number }) {
	const y = -heightM / 2;
	return (
		<mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, y, 0]} receiveShadow>
			<planeGeometry args={[40, 40]} />
			<meshStandardMaterial color={hex("void")} roughness={0.95} metalness={0} />
		</mesh>
	);
}

/**
 * Arcs at whole display heights, with metre arcs underneath them in a dimmer
 * colour. Display heights lead because they are exact; metres follow because
 * they are an estimate, and the visual hierarchy matches the epistemic one.
 */
function DistanceArcs({
	displayHeightM,
	maxScreenHeights,
}: {
	displayHeightM: number;
	maxScreenHeights: number;
}) {
	const y = -displayHeightM / 2 + 0.004;
	const step = maxScreenHeights <= 4 ? 1 : maxScreenHeights <= 10 ? 2 : 5;

	const arcs = useMemo(() => {
		const out: { radius: number; primary: boolean }[] = [];
		for (let h = step; h <= maxScreenHeights + step; h += step) {
			out.push({ radius: h * displayHeightM, primary: true });
		}
		for (let m = 1; m <= Math.ceil(maxScreenHeights * displayHeightM) + 1; m++) {
			out.push({ radius: m, primary: false });
		}
		return out;
	}, [displayHeightM, maxScreenHeights, step]);

	return (
		<group position={[0, y, 0]}>
			{arcs.map((arc, i) => (
				<mesh key={`${arc.primary ? "h" : "m"}-${i}`} rotation={[-Math.PI / 2, 0, 0]}>
					<ringGeometry
						args={[arc.radius - (arc.primary ? 0.008 : 0.004), arc.radius, 128, 1, 0, Math.PI]}
					/>
					<meshBasicMaterial
						color={arc.primary ? hex("line") : hex("surface")}
						transparent
						opacity={arc.primary ? 0.85 : 0.5}
						side={THREE.DoubleSide}
					/>
				</mesh>
			))}
		</group>
	);
}

function DisplayPanel({
	widthM,
	heightM,
	photo,
}: {
	widthM: number;
	heightM: number;
	photo: HTMLCanvasElement | null;
}) {
	const texture = useMemo(() => {
		if (!photo) return null;
		const t = new THREE.CanvasTexture(photo);
		t.colorSpace = THREE.SRGBColorSpace;
		return t;
	}, [photo]);

	return (
		<group>
			<mesh position={[0, 0, 0]}>
				<planeGeometry args={[widthM, heightM]} />
				{texture ? (
					<meshBasicMaterial map={texture} toneMapped={false} />
				) : (
					<meshStandardMaterial
						color={hex("surface")}
						emissive={new THREE.Color(hex("accent"))}
						emissiveIntensity={0.16}
						roughness={0.4}
					/>
				)}
			</mesh>
			{/* Bezel, so the plane reads as a physical object at a physical size. */}
			<mesh position={[0, 0, -0.006]}>
				<planeGeometry args={[widthM * 1.035, heightM * 1.05]} />
				<meshStandardMaterial color="#000000" roughness={0.6} />
			</mesh>
		</group>
	);
}

function positionOf(
	pose: { az: number; el: number; dh: number },
	displayHeightM: number,
	eyes: boolean,
): THREE.Vector3 {
	const az = (pose.az * Math.PI) / 180;
	const el = (pose.el * Math.PI) / 180;
	const distance = Math.max(0.05, pose.dh * displayHeightM - (eyes ? 0.4 : 0));
	return new THREE.Vector3(
		distance * Math.cos(el) * Math.sin(az),
		distance * Math.sin(el) + (eyes ? 0.25 : 0),
		distance * Math.cos(el) * Math.cos(az),
	);
}

function ViewerMark({
	viewer,
	displayHeightM,
	isMe,
	eyes,
}: {
	viewer: Viewer;
	displayHeightM: number;
	isMe: boolean;
	eyes: boolean;
}) {
	const pose = viewer.pose!;
	const colour = viewerColour(viewer.hue, isMe ? 66 : 56);
	const position = positionOf(pose, displayHeightM, eyes);
	const planeY = -displayHeightM / 2;
	const ellipseRadius = Math.max(0.03, pose.sd * displayHeightM);
	const ref = useRef<THREE.Group>(null);

	useFrame(({ clock }) => {
		if (isMe && ref.current) {
			ref.current.scale.setScalar(1 + Math.sin(clock.elapsedTime * 1.6) * 0.015);
		}
	});

	return (
		<group>
			{/* A dropped line, so the plan position is never ambiguous. */}
			<line>
				<bufferGeometry>
					<bufferAttribute
						attach="attributes-position"
						args={[
							new Float32Array([
								position.x,
								position.y,
								position.z,
								position.x,
								planeY,
								position.z,
							]),
							3,
						]}
					/>
				</bufferGeometry>
				<lineBasicMaterial color={colour} transparent opacity={0.45} />
			</line>

			<group ref={ref} position={[position.x, position.y, position.z]}>
				<mesh>
					<sphereGeometry args={[isMe ? 0.075 : 0.055, 24, 16]} />
					<meshStandardMaterial
						color={colour}
						emissive={new THREE.Color(colour)}
						emissiveIntensity={isMe ? 0.6 : 0.3}
						roughness={0.35}
					/>
				</mesh>
			</group>

			{isMe && <Figure position={position} planeY={planeY} colour={colour} eyes={eyes} />}

			{/* The confidence ellipse, drawn at true scale under the feet. */}
			<mesh rotation={[-Math.PI / 2, 0, 0]} position={[position.x, planeY + 0.006, position.z]}>
				<ringGeometry args={[Math.max(0.001, ellipseRadius * 0.92), ellipseRadius, 48]} />
				<meshBasicMaterial color={colour} transparent opacity={0.5} side={THREE.DoubleSide} />
			</mesh>
			<mesh rotation={[-Math.PI / 2, 0, 0]} position={[position.x, planeY + 0.005, position.z]}>
				<circleGeometry args={[ellipseRadius, 48]} />
				<meshBasicMaterial color={colour} transparent opacity={0.12} side={THREE.DoubleSide} />
			</mesh>
		</group>
	);
}

/**
 * A deliberately crude procedural person.
 *
 * Crude on purpose: we measured a camera, not a body. Anything more detailed
 * would be claiming knowledge of a pose, a height and a stance that no part of
 * this pipeline ever recovered.
 */
function Figure({
	position,
	planeY,
	colour,
	eyes,
}: {
	position: THREE.Vector3;
	planeY: number;
	colour: string;
	eyes: boolean;
}) {
	const handHeight = position.y;
	const eyeHeight = handHeight + (eyes ? 0 : 0.25);
	const bodyBottom = planeY;
	const bodyTop = eyeHeight - 0.12;
	const bodyHeight = Math.max(0.3, bodyTop - bodyBottom);
	const backOff = eyes ? 0 : 0.4;
	const away = new THREE.Vector3(position.x, 0, position.z).normalize();

	return (
		<group position={[position.x + away.x * backOff, 0, position.z + away.z * backOff]}>
			<mesh position={[0, bodyBottom + bodyHeight / 2, 0]}>
				<capsuleGeometry args={[0.13, Math.max(0.05, bodyHeight - 0.26), 6, 14]} />
				<meshStandardMaterial color={hex("surface")} roughness={0.75} />
			</mesh>
			<mesh position={[0, bodyTop + 0.11, 0]}>
				<sphereGeometry args={[0.105, 22, 16]} />
				<meshStandardMaterial color={hex("surface")} roughness={0.7} />
			</mesh>
			<mesh position={[0, bodyTop + 0.13, 0.1]}>
				<boxGeometry args={[0.1, 0.02, 0.02]} />
				<meshStandardMaterial
					color={colour}
					emissive={new THREE.Color(colour)}
					emissiveIntensity={0.5}
				/>
			</mesh>
		</group>
	);
}

function GhostMark({ ghost, displayHeightM }: { ghost: Ghost; displayHeightM: number }) {
	const position = positionOf(ghost, displayHeightM, false);
	return (
		<mesh
			position={[position.x, -displayHeightM / 2 + 0.01, position.z]}
			rotation={[-Math.PI / 2, 0, 0]}
		>
			<circleGeometry args={[0.035, 12]} />
			<meshBasicMaterial color={hex("muted")} transparent opacity={0.16} />
		</mesh>
	);
}

/**
 * WebGL is not guaranteed. Headless Chrome without a GPU, a blocked context, an
 * exhausted device -- all of them end here, and all of them are recoverable,
 * because the plan view carries the same information.
 */
class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	constructor(props: { children: ReactNode }) {
		super(props);
		this.state = { failed: false };
	}

	static getDerivedStateFromError() {
		return { failed: true };
	}

	override render() {
		if (this.state.failed) {
			return (
				<div
					data-testid="scene-fallback"
					className="flex h-full min-h-48 items-center justify-center px-6 text-center font-mono text-xs text-[var(--hex-muted)]"
				>
					3D is unavailable on this device, so the plan view below is the whole story.
					<br />
					It has the same numbers in it.
				</div>
			);
		}
		return this.props.children;
	}
}
