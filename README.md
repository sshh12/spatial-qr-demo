# spatial-qr

**A QR code that can tell where you were standing when you scanned it.**

You are looking at a screen with a square on it. We know exactly how wide that
square is. You point your phone's camera back at it, and the shape the square
makes in your photograph — the perspective distortion — is enough to solve for
where your camera was in the room. One photograph, no depth sensor, no AR
session, no login. Then the screen you were looking at draws you standing in
front of it.

The product spec is [CONCEPT.md](./CONCEPT.md). The maths is at `/how-it-works`,
rendered from numbers the test suite measures.

---

## Quick start

```bash
npm install
npm run dev            # one process, one port: Vite + the real Hono app
```

Open `http://localhost:5173`, then scan the code with a phone on the same
network. The phone must reach the page over HTTPS or `localhost` — browsers will
not hand over a camera otherwise, and Safari will not accept `127.0.0.1` even
though Chrome will.

```bash
npm run check          # lint, types, L1, L2 and the bundle budget
npm run e2e            # browser lanes (needs `npm run e2e:install` once)
npm run build && npm start
```

## What is actually claimed

| Quantity | Recoverable | Honest accuracy |
|---|---|---|
| Bearing (azimuth from the display normal) | yes | ~1–3° |
| Elevation | yes | ~1–3° |
| Distance in **display heights** | yes, exactly | limited only by pixel noise |
| Distance in metres | derived | ±10–25%, dominated by two guesses |
| Which side of the room you were on | *conditionally* | the one failure that matters |
| Camera focal length | no API; partially solvable from the image | prior + per-frame refinement |
| Physical display size | no API, ever | declared at creation |
| Where the *person* is | no — we locate the phone | ~40 cm forward, ~25 cm down |

Distance leads in display heights because that is a ratio of two lengths
measured in the same pixels: nothing anyone guessed enters into it. Metres come
second, with a visible bar, because they need the display's physical size and
the camera's focal length and both are estimates.

Every solve carries a covariance built from pixel noise, the focal-length
posterior width and principal-point uncertainty. That single number is what the
confidence ellipse is drawn from, what the ± on screen means, and what the
refusal threshold compares against — so the claim and the gate cannot drift
apart. It is checked against the actual error distribution in CI.

## Stack

| Layer | Choice |
|---|---|
| App | Vite 8 (Rolldown) + React 19 SPA, served in production by one Hono process on Node 24. One Railway service, one port, no meta-framework. |
| Detection | `zxing-wasm` reader-only subpath, self-hosted as a bundled asset. No CDN. |
| Corner accuracy | Own sub-pixel refiner: gradient-centroid edge sampling in linear light → exhaustive two-point RANSAC → total-least-squares line fit → intersect adjacent lines. |
| Pose | Normalised DLT homography → closed-form decomposition → explicit mirror branch → LM-refine both, each pinned to its own side → compare by posterior cost. ~450 lines, zero dependencies. |
| Intrinsics | MAP: log-normal prior at 26 mm-equivalent, golden-section over log *f*, curvature of the cost gives the posterior width. |
| Capture | rVFC aiming at ~640 px in a Worker → burst at native resolution → motion gate → medoid of survivors → `track.stop()` before WebGL mounts. |
| 3D | react-three-fiber + drei, 100% procedural geometry, zero downloaded assets. Lazy-loaded. |
| Styling | Tailwind v4 CSS-first, dark-only, OKLCH — with an sRGB hex mirror per token for three.js, checked for drift by a test. |
| Storage | Two ports (`Store`, `EventBus`) with explicit capability flags. In-memory driver only in v1; a boot assertion crashes rather than serve a broken multi-replica deployment. |
| Realtime | SSE with `retry:`, heartbeats, `Last-Event-ID`, `X-Accel-Buffering: no`, excluded from compression. Plus a `?since=` polling fallback. |
| Tooling | TypeScript strict with `noUncheckedIndexedAccess`, Biome, Vitest, Playwright. |

### Conventions

- **`npm start` must exist and must run the Node server.** Railpack detects Vite
  projects as static SPAs and deploys them behind Caddy, and the Hono process is
  then never started. The explicit start script is what prevents that.
- **Bind `0.0.0.0`.** Binding anything else is the most common cause of
  Railway's "Application failed to respond".
- **Chunk control is `codeSplitting`.** It was rollup's `manualChunks`, then
  rolldown's `advancedChunks`, and is now `output.codeSplitting` in Vite 8.
- **Never persist image bytes anywhere, for any reason, including behind a debug
  flag.** There is an end-to-end test that watches every outbound request.
- **`markerEdgeMm` is the *symbol* edge, excluding the four-module quiet zone.**
  Measuring the rendered box instead overstates distance by 32% at version 2 —
  larger than every error the rest of the system controls, and invisible,
  because every angle stays perfect.

## Testing

Four tiers, no human in the loop until a real-device pass at the end.

| Tier | What it is | Command |
|---|---|---|
| **L1** | The pure solver and the units. Synthetic correspondences, no images. | `npm test` |
| **L2** | Ray-traced frames → the real zxing-wasm → the real solver, over a pose × degradation grid. **This is where the numbers come from.** | `npm run test:l2` |
| **L3** | Playwright Chromium with a fake camera fed real QR content. | `npm run e2e` |
| **L4** | Structural assertions on the scene graph. | (part of `e2e`) |

Two things make the suite worth trusting:

**The generator projects through an independently written code path.**
`tests/support/groundtruth.ts` imports nothing from `src/core` — the vector
algebra, the camera construction and the projection are all written a second
time from the definitions. A suite where both sides share a projection would
pass just as happily with the sign of *y* flipped in both. A separate test pins
the two derivations of the QR module geometry against each other so a
disagreement is loud rather than cancelling.

**Assertions are on geodesic rotation error and translation error, never on
reprojection error** — reprojection is ~0 by construction for four coplanar
points and trusting it is the classic false-confidence trap. Everything is
asserted at p50 and p95, never per-case max.

The browser lanes feed Chromium real QR content through
`--use-file-for-fake-video-capture` with Y4M files generated from the same
renderer, at exact known poses, so `capture.spec.ts` asserts on *recovered
geometry* rather than on the flow completing.

### Where the tests stop

- **Playwright cannot feed QR content into WebKit.** Camera permissions and mock
  streams work, but the stream is a synthetic pattern. So the WebKit lane covers
  the permission state machine, the `playsinline`/`muted`/`autoplay` plumbing,
  the single-page-load guarantee and the no-camera fallback — and acquisition
  itself is human-verified on real hardware. On Windows, Playwright's WebKit
  build exposes no `navigator.mediaDevices` at all, so the lane there asserts
  that the app detects that and routes around it.
- **No WebGL screenshot diffing.** SwiftShader's automatic fallback was removed
  in Chrome 137 and a suite that fails on anti-aliasing gets muted within a week.
- **The synthetic renderer is not a camera.** It models optical blur, sensor
  noise, ISP sharpening, panel structure, rolling shutter, glare and gamma. It
  has no colour-filter array, no lens distortion and no autofocus breathing. The
  measured corner sigma is a floor, not an expectation.

## Non-goals

1. Metric distance better than roughly ±25%. Angles are rigorous; metres are an
   estimate with a visible bar.
2. Locating the person rather than the phone. Both are shown, with a toggle.
3. Curved and ultrawide monitors. The planar model does not apply.
4. E-ink, single-chip DLP, and keystone-corrected projectors.
5. Printed codes at unknown scale. Angles only.
6. Device orientation. Position only — which also spares a second permission
   prompt for data we decided not to use.
7. Verified or anti-forgery poses. The pose is computed on your device and
   reported. It is trivially forgeable, and nothing here depends on it being
   honest; refusing to upload pixels is worth more.
8. Horizontal scaling. Single replica by construction with the in-memory driver,
   enforced by a boot assertion. The seam for a Redis adapter is in place.
9. Durable live sessions. Feeds and history are ephemeral by design. The QR
   itself never dies, because the display spec is in the URL.
10. iOS in-app browsers that block the camera. We detect and instruct; we cannot
    escape programmatically, and we will not route anyone through a fake
    Shortcut to try.
11. Light mode. It's a dark room.
12. Automated iOS camera acquisition. See "where the tests stop".
13. Face detection of any kind, ever. Marker geometry is not biometric
    processing, and adding face detection would flip the GDPR classification
    into special-category data.
14. Persisting image bytes anywhere. Solver metadata and corner coordinates only.

## Deploying

```bash
railway up
```

`railway.json` is checked in: Railpack builder, `npm start`, one replica, a
dependency-free healthcheck at `/healthz`. HTTPS is automatic, which satisfies
the `getUserMedia` secure-context requirement for free.

`BASE_URL` is an *override*. The request's `Host` header is the source of truth,
so tunnel URLs and preview deployments work with no environment edit and
`og:image` URLs stay correct on every origin the app is reachable at.

Note that Cloudflare quick tunnels do not carry SSE. For local phone testing use
the polling path, a named tunnel, or Tailscale Funnel — otherwise the dev loop
cannot exercise its own headline feature.

## Layout

```
src/core/      the maths and the wire contract — pure, isomorphic, no I/O
src/storage/   two ports and the in-memory driver
src/server/    createApp({store, bus}) -> Hono, plus the Node entry
src/client/    the SPA: capture pipeline, scene, routes
tests/support/ the independent generator, the renderer, the conformance suite
tests/{l1,l2,unit,e2e}/
scripts/       fixture generation, the bundle gate, the test TLS terminator
```

## Licence

MIT. See [LICENSE](./LICENSE).
