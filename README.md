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

A code created with an onward destination sends those same three values to that
destination and nothing more — no image, and nothing the demo's own server would
not have received. The visitor sees the numbers and the full outgoing address
before it happens, and can stop it.

## Redirecting onward

A code created with a destination stops showing the demo's own result. The
solved position is appended to that URL and the phone goes there, which makes
the app usable as a general QR redirect service that happens to know where the
scan came from. The field is on `/create`; leave it empty for the demo.

Every parameter is namespaced `sqr_`, and all nine are always present:

| Parameter | Example | Meaning |
|---|---|---|
| `sqr_v` | `1` | Schema version. Increments only for a breaking change. |
| `sqr_az` | `-31.4` | Side-to-side angle in degrees, one decimal. 0 is straight in front; positive is to the right as you face the screen. Range ±89. |
| `sqr_el` | `8.2` | Vertical angle in degrees, one decimal. Positive is above the centre of the code. Range ±89. |
| `sqr_dh` | `2.41` | Distance in display heights, two decimals. Dimensionless, so it needs no screen size and no camera data. |
| `sqr_sd` | `0.280` | One standard deviation of positional uncertainty, three decimals, in display heights. |
| `sqr_tier` | `solid` | `solid` or `soft`, derived on the server from `sd/dh`: solid at or under 0.12. Worse is refused and never redirects. |
| `sqr_src` | `measured` | `measured` from a photograph, or `manual` if the visitor placed themselves by hand having no camera. |
| `sqr_token` | `040yp4090114c2632g` | The code that was scanned, lowercase. |
| `sqr_at` | `1753440000` | When the position was measured, in whole seconds since the Unix epoch. |

So `https://example.com/arrive?utm=poster` receives:

```
https://example.com/arrive?utm=poster&sqr_v=1&sqr_az=-31.4&sqr_el=8.2&sqr_dh=2.41
  &sqr_sd=0.280&sqr_tier=solid&sqr_src=measured&sqr_token=040yp4090114c2632g&sqr_at=1753440000
```

Your own query string and fragment are preserved. Any `sqr_` parameter already
in the destination is replaced, so a crafted link cannot smuggle a second
position past the measured one.

**These values are not authenticated.** The pose is computed on the visitor's
own phone and is trivially forgeable by design — see `clampPose` — and anyone
can type this URL by hand. Treat the position as a signal for what to show,
never as proof of where somebody stood, and never gate access on it.

To recover metres, decode `sqr_token`: the display's height in millimetres is
`markerEdgeMm / edgeToScreenHeight`, so `metres = sqr_dh × height / 1000`. When
`edgeToScreenHeight` is 0 the code was not on a display, and distance is in
marker widths.

Destinations must be `https`, at most 512 characters, and carry no credentials;
plain `http` is accepted only on loopback, for local development. Anything else
is refused at creation time rather than at scan time. The handoff shows the
numbers and the full outgoing address for a few seconds and can be stopped by
touching the screen or pressing a key — this is the one deliberate exception to
the scan route's single-page-load rule, and it happens only after the camera has
already been released.

## Known limits

- Metre distance is not intended to beat roughly ±25%.
- Curved displays do not fit the planar model. Ultrawide displays are not tested.
- Keystone-corrected projectors distort the square before the camera sees it.
- Printed codes without a known physical size provide angles, not metres.
- The app reports position, not camera orientation or verified identity.
- A redirect destination lives in the room record, so it is lost when the
  in-memory store restarts. A durable driver is what makes a printed code's
  destination survive a redeploy.
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
src/core/      geometry, marker model, wire types, and the redirect schema
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
