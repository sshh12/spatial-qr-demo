# spatial-qr

Spatial QR estimates a phone camera's angle and distance from a QR code shown at
a declared size. The image is processed on the phone and never uploaded.

The flow has three steps:

1. A display shows the QR code and reports its measured or estimated size.
2. A phone captures a short burst, rejects moving frames, and chooses a stable one.
3. The phone solves its position; the display plots the result.

No depth sensor, AR session, account, or face detection is involved.

## What it measures

| Result | Meaning | Accuracy or dependency |
|---|---|---|
| Side-to-side angle | Left or right of the display | about 1–3° |
| Vertical angle | Above or below its centre | about 1–3° |
| Distance in display heights | Distance relative to screen height | no physical-size guess |
| Distance in metres | Uses estimated display and camera data | about ±10–25% |

The result locates the camera, not the person holding it. Display heights avoid
a physical-size estimate, but still include uncertainty from the image
measurement. Metres also depend on the declared display size and estimated
camera focal length, so the UI shows an error bar.

The app refuses captures that are too small, unclear, or ambiguous. If two
mirror-image positions fit equally well, it asks for another scan after a step
to the right.

## Run locally

Requires Node.js 24 or newer.

For desktop development:

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

For a real phone on the same network:

```bash
npm install
npm run phone
```

`npm run phone` builds the app, starts the server, and prints a local HTTPS
address. Open that address on the display, accept the self-signed certificate,
then scan the code. Accept the certificate on the phone too. HTTPS is required
because browsers do not expose the camera to ordinary LAN HTTP origins.

Production build:

```bash
npm run build
npm start
```

## Privacy boundaries

The position result contains:

- horizontal and vertical angle;
- distance in display heights;
- the result's uncertainty.

Solid results can also contribute a coarse device signature and focal estimate
to pooled calibration. Captured images remain in browser memory for the result
and are never uploaded. The camera stream stops after capture. The app does not
detect faces. A share card contains the result diagram, not the camera image.

## Known limits

- Metre distance is not intended to beat roughly ±25%.
- Curved displays do not fit the planar model. Ultrawide displays are not tested.
- Keystone-corrected projectors distort the square before the camera sees it.
- Printed codes without a known physical size provide angles, not metres.
- The app reports position, not camera orientation or verified identity.
- The included storage driver supports one server replica and ephemeral history.

## Architecture

| Area | Implementation |
|---|---|
| Web app | React 19 and Vite 8, served by a Hono Node process |
| Detection | `zxing-wasm` plus a local subpixel corner refiner |
| Position solve | Homography decomposition, both mirror branches, nonlinear refinement |
| Capture | Worker-based live aiming, native-resolution burst, motion rejection |
| Result | Procedural React Three Fiber scene plus an SVG plan view |
| State | Explicit `Store` and `EventBus` ports; in-memory adapters in v1 |

The scan route stays on one page from permission through result because iOS can
revoke an “Allow Once” camera grant during navigation. Three.js is loaded only
for the result, after the camera has stopped.

## Tests

```bash
npm test          # pure geometry and unit tests
npm run test:l2   # rendered QR frames through the detector and solver
npm run e2e       # browser flow and scene checks
npm run check     # lint, types, L1, L2, and bundle budget
```

The L2 generator and production solver use separate projection
implementations. Browser capture tests feed known QR video frames through the
real detector and assert on recovered geometry, not only on flow completion.

Real-device testing is still required for iOS camera acquisition, autofocus,
lens distortion, and panel behavior that a synthetic renderer cannot reproduce.

## Project map

```text
src/core/      geometry, marker model, and wire types
src/client/    capture pipeline, routes, and result views
src/server/    Hono app and Node entry point
src/storage/   storage and event-bus ports
tests/         unit, geometry, rendered-frame, and browser tests
scripts/       phone HTTPS helper, fixtures, and bundle checks
```

The in-app `/how-it-works` page explains the geometry with measurements produced
by the test suite. [CONCEPT.md](./CONCEPT.md) records the design decisions and
the implementation findings that revised them.

## Deploy

```bash
railway up
```

[`railway.json`](./railway.json) configures one replica, `npm start`, and the
`/healthz` check. Production must provide HTTPS for camera access.

## License

MIT. See [LICENSE](./LICENSE).
