# Spatial QR — concept

**A QR code that can tell where you were standing when you scanned it.**

You are looking at a screen with a square on it. We know exactly how wide that
square is. You point your phone's camera back at it, and the shape the square
makes in your photo — the perspective distortion — is enough to solve for where
your camera was in the room. One photograph, no depth sensor, no AR session,
no login. Then the screen you were looking at draws you standing in front of it.

This document resolves the product. The next document is the technical plan.

---

## 1. The honest claim

Everything downstream depends on being precise about what a single photo of a
known square actually tells you. It is not "we know where you are." It is:

> **We can tell you which direction you were standing, to within a couple of
> degrees. We can tell you roughly how far, to within about 10–25%, and the
> error bar is on screen. We are measuring your phone's camera, not your
> eyes — that's another 40 cm.**

### What is recoverable

| Quantity | Recoverable | Honest accuracy |
|---|---|---|
| **Bearing** (azimuth from display normal) | yes | ~1–3° |
| **Elevation** | yes | ~1–3° |
| **Distance in screen-heights** (dimensionless) | yes, **exactly** | limited only by pixel noise |
| **Distance in metres** | derived | ±10–25%, dominated by two user-supplied guesses |
| **Which side of the room you were on** | *conditionally* | the one failure that matters — §6.1 |
| Camera focal length | no API; partially solvable from the image | see §7 |
| Physical display size | no API, ever | must be declared at creation |
| Where the *person* is | no — we locate the phone | systematically ~40 cm forward, ~25 cm down |

### The three facts that shape the entire product

**Scale error has exactly zero effect on any angle.** Assuming the marker is
half or double its true size scales the distance by exactly that factor while
leaving azimuth and elevation unchanged to six decimal places. This is a
structural property of the homography, not of our code. It is why the product
works at all: it means the "someone scanned a screenshot of this off Twitter"
case degrades gracefully instead of catastrophically, and it means the physical
size input is a nice-to-have rather than a correctness dependency.

**Lateral position error scales as `σ_px · Z³ / (f · S²)`** — cubic in
distance, inverse-*square* in marker size. At 0.5 px corner noise:

| Setup | Lateral σ |
|---|---|
| 20 cm QR @ 0.7 m (at a desk) | 0.9 cm |
| 20 cm QR @ 1.0 m | 2.5 cm |
| 20 cm QR @ 3.0 m | **59 cm** head-on, 38 cm at 30° |
| 34 cm full-bleed @ 3.0 m | 23 cm / 12 cm |
| 2 m projection @ 4.0 m | 1.0 cm |

Desk distance is trivially accurate. Projector scale is trivially accurate.
There is exactly **one** bad regime — a monitor-sized marker at living-room
distance — and essentially every engineering decision below is aimed at that
single cell. Capture resolution is a free 3× lever on it (σ ∝ 1/f, f ∝ capture
width), and growing the marker is a 4× lever, and they multiply.

**Humans can't perceive most of these errors — but everyone perceives one.**
Nobody can evaluate a bearing angle by eye, and nobody judges
distance-to-a-screen better than ~30%. But every single person knows instantly
whether they were standing left or right of centre. **The left/right flip is
the only perceptually fatal error; a 40% distance error is perceptually
invisible.** The engineering budget follows that, not the other way round.

### Consequences for how we present numbers

Distance leads with **screen-heights** — dimensionless and exact — and shows
metres as a derived secondary with a visible error band. That single framing
decision simultaneously neutralises screenshot recapture, unknown display size,
TV overscan, wrong-lens selection, and the tape-measure test.

---

## 2. The experience

### 2.1 Desktop — the landing page

Near-black, one column, one code. Above the fold: the claim, the QR at ~34vh,
the URL beneath it in plain text (for people who reasonably won't scan a QR
from a stranger), and a live strip. Below: **"What is this?"** — an explainer
whose actual job is converting a suspicious person into someone who grants
camera permission. It makes the argument in order: here is the geometry, here
is why we need a second scan, here is exactly what leaves your device (four
numbers), here is the source.

**The idle QR does not need to be pose-quality.** It only has to be decodable
by a phone's camera app from where someone naturally stands. This resolves the
tension between "geometry wants a huge marker" and "the page should look like a
page." Pose accuracy comes from the swap.

### 2.2 The swap — the desktop stops being a page and becomes the instrument

This is the product, and it is load-bearing rather than decorative. The
measurement *is* the user's position, so we cannot ask them to move without
corrupting the thing we are measuring. **The only legitimate way to improve the
geometry is to move the screen, not the person.**

| # | Trigger | Desktop does |
|---|---|---|
| 0 | idle | QR at 34vh, URL beneath, live strip below |
| 1 | phone opens `/s/:token` | strip reads *"A phone just connected."* A hairline pulse crosses the QR frame. Then ~2 s of deliberate nothing — they're still reading their phone. |
| 2 | phone taps **Turn on camera** | **The swap.** 600 ms. All chrome fades out, background goes pure white, the QR scales to full-bleed, and four L-brackets snap to the true viewport corners. One line of 11 px mono: `SPATIAL-QR · 336 mm · hold still` |
| 3 | phone captures | one 8%-opacity white frame for 90 ms — reads unmistakably as a shutter |
| 4 | server has the pose | the marker collapses to a card in the corner and **the floorplan draws itself** at full page size: screen as a thick line, metre arcs sweeping out, radial ticks, then the dot lands with a small overshoot. Numbers count up in mono. |
| 5 | +12 s | eases back to idle. The new dot joins the corner floorplan permanently. |

**Why L-brackets.** A full-bleed QR is square, so on 16:9 it spans 100% of the
height but only 56% of the width. Brackets at the true display corners extend
the horizontal baseline by **1.78×**, which lands directly on azimuth — the
headline number. They also give redundancy when glare kills a symbol corner.
They need no dictionary coding, because the session already told the phone
exactly what is on screen. About forty lines of code.

**The phone never guesses which marker is displayed.** It reads it from session
state and refuses to capture until the desktop has ACKed the swap. If no
desktop is connected — page closed, session expired, link opened from a tweet —
the phone is told `activeMarker: "idle"` with its true mm size and proceeds
against the small code with the range budget cut proportionally and an honest
banner: *"The screen you scanned isn't connected, so we're working from the
small code. Good to about 0.9 m here."*

### 2.3 Phone — the flow

**Hard constraint that shapes everything: the entire flow is one page load.**
No navigation, no reload, no hash routing, no post-solve redirect. iOS revokes
*Allow Once* on navigation, and a revoked camera mid-flow is an unrecoverable
dead end with no API to re-prompt.

| | Screen | What happens |
|---|---|---|
| **S0** | Cold open | *"You just scanned a square. We know exactly how wide it is."* No permission request on load, ever. Three mono lines: `One photograph. / Decoded on this phone. / Four numbers sent, and you'll see them first.` The WASM detector prefetches during this screen — the reading time is what buys the 450 KB. |
| **S1** | Permission | Native prompt fires synchronously from the tap, nothing else in that handler. Three distinct denial states — §6.5. |
| **S2** | *"Look up at the screen."* | ~800 ms, or until the desktop ACKs the swap. Falls through to idle-marker mode after 2 s. |
| **S3** | Viewfinder | Detection at ~640 px grayscale in a Worker at 10–15 Hz. A hairline target box **snaps to the detected quad** with a 120 ms spring and one haptic tick. That single frame — a box visibly clamping onto the real thing — is more persuasive about local processing than any copy. A gauge below shows one message at a time driven by measured px/module. **Never any instruction to move sideways: the angle is the measurement.** |
| **S4** | Capture | 10-frame burst at native resolution → shutter flash → freeze on the lowest-residual frame → **`track.stop()` immediately and visibly.** The OS camera indicator extinguishes. Hold this beat for 700 ms and do not rush it: it is the payment on the promise made in S0, it costs nothing, and it is the only moment where a sceptic gets hard evidence. |
| **S5** | Solve | The frozen frame desaturates, the detected quad stays lit, and the **reprojected model quad is drawn over it** — and lands on top. You watch the maths agree with the photograph. |
| **S6** | Reveal | The frozen photograph scales down, rotates in 3D, and **settles as the display plane inside the scene.** The photo literally becomes the screen in the room. Floor arcs draw outward, the camera flies to a three-quarter view, the figure fades in, the confidence ellipse blooms under its feet. ~1.4 s, wrapped in `prefers-reduced-motion`. |
| **S7** | Result | 3D above the fold. Below: plan view, the readout, the eyes toggle, skins, share, create CTA, maths link. |

A persistent 11 px mono readout is visible throughout:
`1920×1440 · marker 168 px · 6.7 px/mod · f 1442 assumed`. This is
simultaneously the trust artefact, the `?debug=1` HUD, and the thing Playwright
asserts on — which is why it will not rot.

### 2.4 The scene — honest reconstruction, not a theatre

No walls, because we don't know where your walls are. A floor marked with metre
arcs and degree ticks. The display as a rectangle at true physical size, showing
your own frozen photograph. A figure standing at the solved position. A dashed
line to the screen with the distance on it. **A confidence ellipse at true scale
under the figure's feet.** Beside it, a plan view showing the same thing flat,
and a monospace readout giving every number with its error bar and every
assumption named.

We chose this over a theatre metaphor for one decisive reason: **a theatre seat
cannot be checked, and a reconstruction of your actual room can.** A viewer
glances at it and thinks *"yeah, about two metres out and off to the left"* —
and that instant self-verification is what makes it real to a casual viewer and
credible to a skeptical one, from one artefact. "Row F, Seat 12" is
additionally a claim of ±20 cm precision the geometry cannot support at 3 m,
with nowhere to put an error bar.

The theatre ships as a one-tap **skin** over the identical solved position, and
it says *"nearest seat: F12 — you were 18 cm from its centre."*

**The eyes toggle.** We measured your phone. Your eyes are roughly 40 cm behind
it and 25 cm above it. Show both, with a toggle, and name it in the readout.
This is the largest single real-world error in the system — at 1.5 m, arm
extension is a 27–40% distance error, dwarfing the entire focal-length budget —
so it is presented as a feature rather than buried.

### 2.5 Rooms, ghosts, and the calibration commons

**Live layer.** Everyone currently connected to this room, at their solved
position, in real time. A talk, a classroom, or an office wall fills up.

**Room history.** Everyone who has scanned this particular display.

**The commons (ghosts).** Faint markers showing where everyone who ever scanned
*any* spatial QR stood — stored normalised as `(azimuth°, elevation°, distance
in screen-heights)` so a 14" laptop and a 27" monitor overlay sanely, then
re-projected onto *your* display's geometry.

This last layer exists to solve a specific problem: the median visitor is alone
at their laptop, and a shared room with one person in it is a worse demo than a
solo one. Per-display history doesn't help — on launch day every display is
brand new. A **global** normalised commons is dense within the first hour of
traffic and gets better forever. The counter is stated truthfully
(`you · 8,412 who stood here before you`), including on day zero when it reads
in single digits.

**The calibration commons.** The same idea applied to hardware, and it is the
one mechanism that makes the demo measurably better as more people use it:

- **Display side.** When someone calibrates with the card ruler, we store
  `device signature → measured mm-per-CSS-pixel`. A future visitor on matching
  hardware is *pre-filled* with "we think your screen is 163 DPI — right?" and
  one tap to accept or recalibrate.
- **Camera side — the larger accuracy lever.** Every solid-tier solve converges
  a focal length via the MAP search. Aggregated by device signature, that
  becomes a real per-model focal prior, tightening σ from the generic 15% toward
  something measured, which feeds straight into metric distance.

Designed honestly, this means:

- It is a **prior, never a truth.** The same signature can mean different
  physical screens (external monitors, scaled resolutions), so it prefills and
  asks; it never silently overrides.
- **Median and MAD, not mean.** Only offered when `n ≥ 5` and dispersion is low,
  which also makes it k-anonymous by construction.
- **Only solid-tier solves contribute**, or garbage poisons the prior.
- No per-user record is kept — only the aggregate.

### 2.6 Create your own

`/create` mints a persistent room: pick the surface, run the card ruler, name
it, get a short URL and a printable/displayable code. Physical size, aspect
ratio and surface type are encoded in the URL token itself, so the code keeps
working forever regardless of server state.

### 2.7 Share

A 1200×630 card rendered on the phone: the plan view, the three numbers with
their error bars, and the confidence badge. The sheet says plainly: *"This
uploads the diagram above so it shows as a preview when you post it. It does
not upload your photograph."*

---

## 3. Product decisions — locked

| Decision | Choice |
|---|---|
| **Where the payoff renders** | **Both, choreographed.** Desktop plays the reveal; phone shows a synced companion (plan + numbers + share card). If no desktop is listening, the phone silently renders the full scene. |
| **Multiplayer** | **Shared + live**, plus the global normalised ghost commons as a persistent layer. |
| **Scene** | **Honest reconstruction.** Theatre available as a skin over identical geometry. |
| **Scale input** | **Bank-card ruler** (ISO/IEC 7810 ID-1 = 85.60 × 53.98 mm, <0.3% manufacturing tolerance, ~1.2% with human matching) on the *display* device at creation, backed by the crowdsourced prefill, with preset diagonals as fallback and a **blocking browser-zoom guard**. Result carries a `measured` / `estimated` badge. |
| **Identity** | **Anonymous by default.** The landing-page room is auto-assigned colour/shape with **no free text at all**. Rooms you create may opt into display names; the creator holds an owner token with clear/kick, plus a length cap and a global kill switch. |
| **Room model** | **Two tiers.** Landing page mints an ephemeral tab-room (~4 h TTL). `/create` mints a persistent room with a short URL and an owner token in localStorage. |
| **Hero range** | **Room-scale, quotable as "about six to eight screen-heights."** |
| **Where the solve happens** | **Entirely on the phone.** Pixels never leave the device. Four numbers are POSTed. This is the trust story and it outranks forgery-resistance, because nothing in the demo depends on a pose being honest. |
| **Scope** | **Launch-ready v1** — landing + explainer, phone capture, live desktop reveal, shared rooms + ghosts, create-your-own, calibration commons, share cards, full synthetic test harness, README with the maths. |

### The range table, and why it's the most useful thing on the page

For a full-bleed marker on 16:9 at 1920×1440 capture (26 mm-eq → f ≈ 1442 px):

> **Z_max ≈ 8 × the display's height** (≈5.5× if the phone clamps to 1280×960)

| Display | Height | Good to |
|---|---|---|
| 16" laptop | 199 mm | 1.6 m |
| 27" monitor | 336 mm | 2.8 m |
| 55" TV | 685 mm | 5.6 m |
| 100" projector | 1245 mm | 10.3 m |

This goes on the page, in the create flow, and in the README. It is memorable,
checkable with a tape measure, and it tells someone instantly whether their
setup will work. **The app computes it per-session and refuses out-of-range
rather than producing rubbish.** Keep it computed, never hardcoded — it moves
when the URL length moves.

---

## 4. Stack — locked

| Layer | Choice | Why |
|---|---|---|
| **App** | Vite (Rolldown) + React 19 SPA, served in production by one Hono process on Node 24 LTS. One Railway service, one port, no meta-framework. | Every meaningful surface is client-only — getUserMedia, WASM, WebGL. SSR is *negative* value. `createApp({store, bus}) → Hono` is a pure function, unit-testable via `app.request()` with no port. |
| **Detection** | `zxing-wasm` reader-only subpath (~1.04 MB wasm / ~449 KB gzip). | The only option that is maintained, identical on iOS and Android, robust at oblique angles, and returns symbol-outer-boundary corners. `BarcodeDetector` is **broken on iOS since 17.6** and absent on Chrome Windows/Linux, so feature-detecting it is unsafe. jsQR has had no release since 2021 and fails at yaw ≥ 30°. |
| **Corner accuracy** | Own sub-pixel refiner (~150 lines): gradient-centroid edge sampling on the four symbol boundaries → RANSAC total-least-squares line fit → intersect adjacent lines. Extended to the three finder patterns for ~28 correspondences. | zxing-cpp computes sub-pixel corners and then **rounds them to integers at the API boundary**. Raw corners carry 0.75–7.2 px error, which would cap every downstream number. |
| **Pose** | Normalised DLT homography → closed-form decomposition → explicit IPPE mirror branch → LM-refine **both** → pick lower reprojection, **carry the ratio as confidence.** ~300 lines, zero deps. | No credible lightweight JS/TS PnP library exists. Auditable dependency-free source is an asset in a repo strangers will read. opencv.js is 13 MB and doesn't ship `solvePnP` in the stock binding config. |
| **Intrinsics** | MAP: log-normal prior at 26 mm-eq (σ 15%, tightened per-device by the commons) + golden-section search over log *f* minimising reprojection + prior penalty, over all ~28 points, from the same single frame. | No web API exposes focal length and none is coming — the W3C issue was closed one day after filing in 2016. Cross-check with radial distortion, **not** vanishing points (see §7). |
| **Capture** | Live rVFC detection at ~640 px in a Worker for aiming → burst of 8–12 frames at native resolution on tap → reject by reprojection + ambiguity ratio → **median** of survivors → `track.stop()` before WebGL mounts. | `ImageCapture.takePhoto` is absent on iOS Safari in every version including 26, so a still-capture architecture has no iOS path. Median not mean, because the error distribution is bimodal (two pose branches), not Gaussian. |
| **3D** | react-three-fiber + drei on WebGLRenderer, 100% procedural geometry, zero downloaded assets. drei `<Lightformer>` for studio IBL. | Declarative graph matches the reactive problem — poses arrive and avatars mount over SSE. Lightformers give real studio lighting for zero asset bytes and zero licence surface. Do **not** use `<Environment preset>`, which fetches an HDRI from a CDN. |
| **Styling** | Tailwind v4 CSS-first (`@theme`), dark-only, OKLCH — with each token **mirrored as an sRGB hex custom property** for three.js. | One palette source for DOM and scene. The mirror step is required: `THREE.Color.setStyle()` doesn't parse `oklch()`, and unregistered custom properties return the authored string verbatim. |
| **Storage** | **Two ports** — `Store` (CRUD) and `EventBus` (fanout) — each carrying explicit `capabilities: { durable, sharedAcrossReplicas, nativeTtl }`. In-memory default; Redis and Postgres adapters behind one shared conformance suite. Boot-time assertion **crashes loudly** if `NUM_REPLICAS > 1` without shared drivers. | Splitting them makes the adapter matrix legible — Redis satisfies them by two different mechanisms; Postgres does fanout via LISTEN/NOTIFY, whose payload caps at 8000 bytes. A silent multi-replica fanout failure (phone hits B, desktop subscribed on A, page just never updates) is the worst possible mode. |
| **Realtime** | SSE over a Hono streaming route with explicit `retry: 2000`, `: heartbeat` every 20 s, `Last-Event-ID`, `X-Accel-Buffering: no`, and **excluded from compression middleware.** Plus a `?since=` polling endpoint. | One-way problem; `EventSource` gives free reconnect. Railway's own guide recommends SSE for this shape. Polling is the locked-down-network fallback *and* the deterministic, non-racing Playwright path. |
| **Hosting** | Railway, Railpack builder, `railway.json` checked in, `numReplicas: 1`, dependency-free healthcheck, `hostname: '0.0.0.0'`. `BASE_URL` as an *override*, with request-`Host` derivation as source of truth. | Binding anything but `0.0.0.0` is the #1 cause of Railway's "Application failed to respond". Host-derivation makes tunnel URLs work with no env edit and keeps `og:image` absolute URLs correct on every origin. HTTPS is automatic, which satisfies the getUserMedia secure-context requirement for free. |
| **Tooling** | TypeScript strict with `noUncheckedIndexedAccess` **non-negotiable**; Biome; Vitest; Playwright. | You will index into corner arrays, 3×3 intrinsics and quaternion components constantly, and that flag catches exactly the off-by-one class that produces a plausible-but-wrong pose. |

### Traps to encode in the build, not rediscover

- **Railpack auto-detects Vite projects as static SPAs** and deploys them behind
  Caddy — the Hono process is never started. The explicit `start` script avoids
  it; name it in the README so a rename doesn't silently break the deploy.
- **Rolldown implements `advancedChunks`, not `manualChunks`.** Bundle control is
  the single biggest risk on a Three.js + WASM app.
- **Pin `three` to a version drei is actually tested against.** drei's stable
  line predates several three releases and its open `>=` peer range expresses no
  upper bound. Smoke-test `<Environment>`/`<Lightformer>`/`<ContactShadows>`
  before any scene work.
- **Cloudflare quick tunnels do not carry SSE.** The dev loop must use the
  polling path, a named tunnel, or Tailscale Funnel — otherwise the local
  phone-testing lane cannot exercise its own headline feature.
- **Never persist image bytes anywhere, for any reason, not even behind a debug
  flag.** That converts a fun demo into a privacy incident.

### The move that makes storage non-load-bearing

**A self-describing URL token**: base64url of
`[schemaVersion, markerEdgeMm, aspectNum, aspectDen, surfaceEnum, rand32]`,
~18–22 characters. `/s/:token` resolves with **zero server state**.

Railway relocates workloads to rebalance compute, so in-memory state dies at
*unpredictable* moments, not just at our deploys. With the token, a QR tweeted
last week still scans and solves after a total wipe; only the live feed and
ghost history are lost. The `rand32` is mandatory — without entropy, two people
who both create a 336 mm monitor code would share a session, a live feed, and
each other's ghosts.

### ⚠ The scale definition, which is easy to get wrong and expensive

**`markerEdgeMm` is the SYMBOL edge — finder-outer-corner to
finder-outer-corner, EXCLUDING the 4-module quiet zone.** QR mandates a
4-module quiet zone and rendering libraries include it by default, while
detectors return *symbol* corners. Measuring the rendered CSS box — the natural
implementation — overestimates distance by **32% at version 2**, which is larger
than every error the rest of the system carefully controls. Assert it in the
synthetic harness.

---

## 5. Marker design

- **Version 2 minimum, EC level M.** Version 1 has no alignment pattern and
  collapses at oblique angles (measured: 2/9 decode at 60° yaw versus v2's 8/9).
  Assert `version >= 2` in a unit test.
- **All-uppercase alphanumeric payload** — `HTTPS://EXAMPLE.COM/S/K7F2QX` —
  which stays in QR alphanumeric mode (~45% more capacity) and fits v2-M's 38
  characters. Redirect to lowercase on arrival so the address bar isn't
  shouting.
- **Integer device-pixels per module**, `image-rendering: pixelated`, no CSS
  transform anywhere in the ancestor chain. Anti-aliased module edges directly
  degrade the sub-pixel refinement everything else depends on.
- **Four-module quiet zone, pure white, always** — forced even in dark mode.
- **No logo, no rounded modules, no brand colour.** Every one of those eats the
  finder patterns and quiet zone, which is where all the geometric precision
  lives. Worth one line of caption on the page: *"The code is plain on purpose.
  Rounded corners cost us a degree."*
- **Render the marker vertically off-centre** so a standing viewer has 10–20° of
  elevation. Nearly free, and it fixes a real degeneracy (§7).

---

## 6. Corner cases designed for in v1

**6.1 The left/right flip — the only perceptually fatal error.** Compute both
IPPE branches always; use the reprojection **ratio** as confidence. Measured at
3 m / 20°: the lowest-reprojection branch was **196 cm wrong** while the
rejected branch was correct to 10 cm. Resolution, in priority order: (1)
**angular extent** — the L-brackets, 1.78× baseline; (2) the two-branch ratio
gate; (3) **two-view "take one step and tap again."**

*Do not use gravity.* For a vertical display with the camera near display-centre
height — the demo's nominal pose — the azimuth flip is a mirror about a
*vertical* plane, so both branches keep an exactly horizontal marker normal and
gravity has literally zero discriminating power. This was the obvious
mitigation, and it does not work.

The ambiguous screen is the **best** screen in the product: two mirrored dots on
a plan, and *"Two answers fit this photo. One on each side of the screen, and
the picture honestly can't tell them apart — this is a known property of
measuring a flat square, not a bug we can fix from here. Take one step to
either side and tap again."* Four seconds to resolve, it reads as rigour rather
than failure, and two views nail the focal length properly as a side effect.

**6.2 Someone scans a screenshot from Twitter.** Guaranteed at scale, and the
biggest single opportunity in the failure list. The QR decodes fine; the stored
size says 340 mm; the screenshotted marker is 30 mm; a naive app announces "you
were 24 metres away." Detect it with a **rotating nonce** in the desktop marker —
a screenshot deterministically carries a stale token. Then **do not error**:

> *"You're scanning a screenshot. Nice. We can still tell you: you were 31° left
> of the code. We can't tell how far, because we don't know how big that
> screenshot is on your screen. Want the real thing?"* → straight to
> **create your own.**

The highest-volume failure becomes the highest-volume acquisition path. This is
also the strongest argument for angle-first framing.

**6.3 Decode success ≠ geometry success.** A finger or a glare blob over one
corner lets error correction decode perfectly while the occluded corner is
extrapolated garbage, **with no error signal at all.** Independently verify each
corner against image-gradient evidence — a corner with no supporting
high-contrast edge is fabricated. Reject the frame. Separately reject any quad
*touching the frame border*: the range gate must be two-sided.

**6.4 iOS one-shot permission.** Entire flow in one page load. Never call
`getUserMedia` on load; priming interstitial with an explicit button. Assert
zero navigations between grant and scene mount in Playwright.

**6.5 In-app browsers — the *majority* traffic path on a front-page day.** The
QR path is safe (native Camera hands off to the system browser). The dangerous
path is a shared link tapped inside X, Threads, Reddit, LinkedIn or Slack.
Meta's Android apps don't grant camera to their WebView at all;
SFSafariViewController silently denies with no prompt. Treat "rejects in
<200 ms with no visible prompt" as a **distinct diagnostic state** from user
denial, because the Settings recovery advice is useless there. Android gets the
`intent://` escape. iOS gets copy-link plus illustrated per-app instructions —
and specifically **not** the Shortcuts x-callback hack, because bouncing a
security-conscious visitor through a fake shortcut is the exact opposite of the
trust we just spent two screens building.

**6.6 A real no-camera path, not an apology screen.** Denied permission,
hostile webview, desktop visitor, and accessibility all land here — plausibly
20–30% of visitors on a front-page day. Drag-to-position on a plan, then into
the *same* 3D scene. This is also the accessibility path: a camera-geometry demo
is fundamentally inaccessible to blind and low-vision users and to anyone who
can't hold a phone steady, and a real alternative route is the answer.

**6.7 Brave canvas farbling.** Brave perturbs canvas readback to defeat
fingerprinting, and our entire pipeline reads frames through canvas. Sub-pixel
refinement on perturbed pixels degrades **silently** — decoding still works, so
the app has no idea anything is wrong. Fix: a ~20-line boot self-test that draws
a known pattern, reads it back, and compares bit-exactly; on mismatch, route to
the no-camera path with an honest message. Brave users will appreciate being
told. Related: Brave randomises `enumerateDevices()` order, so never select a
camera by index.

**6.8 Plausibility gate.** Reject Z outside 0.2–30 m, solutions placing the
camera behind the marker plane, apparent marker height below threshold,
reprojection RMS above threshold, and **mirrored images** (`isMirrored` gives
this free — someone will scan a reflection). Never render nonsense.

**6.9 Confidence is a three-tier gate, not a boolean.**

| Tier | Condition | Behaviour |
|---|---|---|
| **Solid** | ≥7 px/module, branch margin ≥3, RMS <0.6 px | full result, tight ellipse, no badge, contributes to the calibration commons |
| **Soft** | 5–7 px/module, or margin 2–3 | full result, visibly larger ellipse, one muted line of explanation |
| **Refused** | margin <2 with opposite-signed azimuths, RMS >1.5 px, or implausible pose | no result; offer the two-view path |

A demo that says *"I'm not sure which side of the room you were on — take a
step"* reads as rigorous. The same system rendering someone 400 m behind the
screen reads as broken.

**6.10 Abuse floor.** Per-IP rate limit on the write path, server-side pose
clamps, body-size cap, per-IP SSE connection cap, ghost decay and hard caps, and
**no free-text labels in the public landing-page room.** Someone will arrange
avatars into words within an hour of the front page.

**6.11 Assume state vanishes at a random moment.** Self-describing token so QRs
never die. Honest "reconnecting" UI, never a silent blank. Open SSE **only when
the page is visible** — 3,000 idle landing-page readers against a connection cap
is the real scaling risk, not the scanners. Explicit `retry:` plus client jitter
for the thundering-herd reconnect. **Provision Redis before launch, not during
it.**

**6.12 Physical cases we detect and refuse rather than fudge.** Curved and
ultrawide monitors (1000R over an 800 mm marker is **83.5 mm of sagitta**, which
the homography silently absorbs as fake tilt); uncorrected projector keystone
(the projected marker is a *trapezoid*, so the known-square premise is false);
phone-showing-QR-to-another-phone (~5 cm marker at 40 cm — refuse with an
explanation, it's a teaching moment).

**Nearly free, do them anyway:** `navigator.wakeLock` on the desktop landing
page (the display sleeps while the visitor reads the explainer),
`Permissions-Policy: camera=(self)`, `frame-ancestors 'none'`.

---

## 7. Test harness

Zero human involvement until a real-device pass at the end. Four tiers:

- **L1 — the pure solver.** Vitest + fast-check against synthetic point
  correspondences, no images, hundreds of randomised poses, <20 s.
- **L2 — image-level, in Node.** A synthetic renderer with analytic ground truth
  → the *real* zxing-wasm → the *real* solver, over a pose × degradation grid.
  **This is where the accuracy sweep lives** and where the range table comes
  from.
- **L3 — Playwright Chromium** with the fake-camera flags, a handful of
  scenarios rather than a sweep.
- **L4 — structural assertions** on the 3D scene graph.

**The generator must project through an independent code path from the solver,
or the entire suite is a tautology that passes even when the maths is wrong.**
The two must not share a single import.

**Assert on geodesic rotation error and translation error, never on reprojection
error** — it is ~0 by construction for four coplanar points, and trusting it is
the classic false-confidence trap. Assert on p50 and p95, not per-case max.

Harness realities worth encoding: the Chromium switch is
`--use-fake-device-for-media-stream` and it accepts `.mjpeg` as well as `.y4m`;
the file-backed device **ignores getUserMedia resolution constraints** and
reports the file's native values, so the app must use `ideal` only and derive K
from `track.getSettings()` — deliberately ship one fixture whose resolution
differs from the request so a regression fails CI. Playwright's default headless
is `chromium-headless-shell` with GPU disabled, so use `channel: 'chromium'` for
anything downstream of `<Canvas>`. Skip WebGL screenshot diffing; SwiftShader
auto-fallback was removed in Chrome 137.

**Add a WebKit lane.** Playwright now maps camera permissions to WebKit
inspector-protocol permissions with mock capture streams. Those streams are
synthetic patterns, so we still **cannot feed QR content into WebKit** — but the
real `getUserMedia` call, the permission state machine, the
`playsinline`/`muted`/`autoplay` plumbing, and the "no QR found" path all become
exercisable in CI. That boundary gets stated in the README, not implied.

---

## 8. Non-goals — stated in the README

For this audience this is the most credible section in the document.

1. **Metric distance better than roughly ±25%.** Angles are rigorous; metres are
   an estimate with a visible bar.
2. **Locating the person rather than the phone.** We measure the camera. Your
   eyes are ~40 cm behind and ~25 cm above it. Both are shown.
3. **Curved and ultrawide monitors.** The planar model does not apply.
4. **E-ink, single-chip DLP, and keystone-corrected projectors.**
5. **Printed QR codes at unknown scale.** Angles only.
6. **Device orientation.** We report position only; the virtual camera always
   looks at the display. This also spares users a second permission prompt for
   data we've decided not to use.
7. **Verified or anti-forgery poses.** The pose is computed on your device and
   reported. It is trivially forgeable, and nothing in the demo depends on it
   being honest.
8. **Horizontal scaling.** Single replica by construction with the in-memory
   driver; a boot assertion enforces it. Swap `STORAGE_DRIVER=redis` to scale.
9. **Durable live sessions.** Feeds and history are ephemeral by design. The QR
   itself never dies, because the display spec is in the URL.
10. **iOS in-app browsers that block the camera.** We detect and instruct; we
    cannot escape programmatically, and we won't route you through a fake
    Shortcut to try.
11. **Light mode.** It's a dark room.
12. **Automated iOS camera acquisition.** Playwright cannot feed real QR content
    into WebKit. Everything downstream of the frame boundary is tested there;
    acquisition itself is human-verified on a real device.
13. **Face detection of any kind, ever.** Marker geometry is not biometric
    processing; adding face detection would flip the GDPR classification into
    special-category data. Saying *"we never look for faces"* is a strong,
    checkable claim.
14. **Persisting image bytes anywhere.** Solver metadata and corner coordinates
    only.

---

## 9. Riskiest assumptions, and the spikes that settle them

**Every one is testable before a line of app code exists.** Hardware available:
Android phone, external monitor, tape measure. iPhone arrives later today.

**R1 — Sub-pixel refinement really delivers ~0.3 px on photos of a real screen.**
*The single most load-bearing assumption in the project.* Every quantitative
claim above is conditioned on per-corner noise σ, and results swing from crisp
to coin-flip between σ = 0.5 px and σ = 2 px. The optimistic figures come from a
clean synthetic render with no colour-filter array, no sharpening overshoot, no
panel gamma, no RGB subpixel geometry, no glare, no rolling shutter — plausibly
an order of magnitude better than a handheld photo of an LCD.
*Experiment (20 min, no app):* display a v2 QR at a known mm size, take 15
photos from a fixed position, run zxing-wasm + the refiner in Node and measure
the **scatter across frames at a fixed pose**. That scatter *is* σ, directly,
with no ground truth needed. Repeat at 0°, 30°, 45°. **Then re-derive every gate
and tolerance in this document from the measured value.**

**R2 — The phone gives us more than 720p.** σ ∝ 1/f and f ∝ capture width, so
1280 vs 1920 vs 3840 is a 1.5–3× swing on every number here.
*Experiment (10 min):* a 15-line static page that requests `ideal` constraints
and prints `getSettings()` and `getCapabilities()` in big type. Never use
`exact` — Safari throws rather than degrading. Run on Android now, iPhone
tonight.

**R3 — We get the main camera and it stays put.** Assuming 26 mm and receiving a
13 mm ultra-wide is k = 2.0 — 100% distance error and up to 19.5° bearing error,
presenting as a completely successful decode with a confident low residual.
*Experiment (+5 min on R2):* log `getSettings()` every 500 ms for 30 s while
pointing at objects at 20 cm, 1 m and 4 m; any mid-stream change confirms
switching. Also print the frame to canvas and eyeball the field of view — an
ultra-wide is obvious to the naked eye.

**R4 — drei's stable line works on current three.** The scene's entire visual
identity rests on `<Environment>` + `<Lightformer>` + `<ContactShadows>`, and
drei's stable release predates several three versions that changed environment
map rotation mechanics. *Experiment (15 min):* a 20-line page with those three
components and one standard material. If lighting is wrong or rotated, pin back
and note it. **Do this before any scene work.**

**R5 — The swap round-trips fast enough to read as instant.** The whole product
shape depends on the desktop reacting inside the window a person perceives as
immediate. *Experiment (30 min):* skip the app — two static pages and a 40-line
Hono server, measure button-press → visible-swap on a real phone. Under ~400 ms
and the design holds; two seconds and we fall back to a static marker with a
much shorter honest range.

**Plus, five minutes each:** the Brave canvas self-test; and check whether any
cloud device farm actually offers camera injection for mobile web, before
committing to "iOS is human-verified only."

### Carried forward as genuinely unresolved

- **The disambiguation margin constant.** The `w²` scaling is confirmed; the
  constant and the θ-dependence are not, and `w_px` was never defined precisely.
  Treat it as an order-of-magnitude rule and derive the real capture gate
  empirically from measured σ. Express the gate as a **fraction of frame width**,
  never as an absolute pixel count.
- **iOS mid-stream lens switching** — rests on a single developer-forum thread.
  R3 settles it.
- **Whether real moiré actually breaks decode.** The synthetic aliasing test that
  suggested it shares almost no mechanism with real screen-capture moiré, and
  rolling-shutter banding — the most characteristic artefact of photographing a
  screen — was never modelled at all.
- **Chrome Android `focusDistance` accuracy** — no published measurement exists
  and the spec language is non-normative. Coarse cross-check only, never an
  input.

---

## 10. Build order

**Hour 0–1 — the spikes.** R1, R2+R3, R4, R5, Brave. **Do not write app code
until R1 and R2 have numbers**; they set every gate, tolerance and range claim
in the product.

| Day | Work |
|---|---|
| 1 | The solver, standalone and pure — zero I/O. Alongside it the dependency-free synthetic renderer that projects ground truth through an independent path. L1 property tests. Hand-compute one golden case on paper. |
| 2 | L2 — real detector on synthetic frames over the pose × degradation grid. Emit the error-vs-marker-size chart with flip rate overlaid; this is CI output and the centrepiece of `/how-it-works`. **Re-derive the range table from measured numbers.** |
| 3 | URL token codec (with the symbol-edge assertion), the `Store`/`EventBus` ports, in-memory adapter, conformance suite, boot-time capability assertion. |
| 4 | The mobile capture flow end to end and ugly — one page load, no 3D, no styling, numbers as plain text. This is where iOS realities bite and where the first real phone test happens. |
| 5 | The handshake: SSE + polling, the full-bleed swap, the brackets, the ACK gate. Verify it feels instant on a real phone. |
| 6–7 | The scene and the page. Floor arcs, figure, ellipse, plan view, readout, eyes toggle. Landing page, explainer, create flow with the card ruler and zoom guard. |
| 8 | The failure paths, which are most of the product's credibility — no-camera fallback, in-app browser detection, permission recovery, the two-dot ambiguity screen, screenshot detection, plausibility gate, Brave self-test. |
| 9 | L3/L4 and CI. Playwright Chromium fake-camera, the WebKit lane, structural 3D assertions, bundle-size gate, post-deploy smoke check asserting the live QR payload contains the production origin. |
| 10 | `/how-it-works`, the README, real-device pass, domain swap. |

`/how-it-works` is the marketing for this audience: the derivations, both
ambiguity branches drawn, why angles survive focal error while distances don't,
the `Z³/(f·S²)` law, the quiet-zone trap, and the CI-generated error chart. It
ends on the line the whole product is organised around:

> *Angles we're confident about. Distances are an estimate with a real error
> bar, and it's on the screen. If you measure us with a tape and we're outside
> the bar, that's a bug — please open an issue.*

---

## 11. Still open

- **Name and domain.** Building on `*.up.railway.app`; a short uppercase domain
  before launch is worth ~30% of scan range, because it keeps the payload in QR
  alphanumeric mode at version 2 instead of version 4. Keep the range table
  computed from the actual payload so it moves correctly at swap time.
- **iOS.** Everything is designed defensively for it — one page load, `ideal`
  constraints only, no `BarcodeDetector`, no `takePhoto`, no navigation between
  permission grant and scene mount — but it is unverified until the iPhone is in
  hand. Re-run R2 and R3 on it before day 4.

---

## 12. What the build measured, and what it changed

This section is written *after* implementation. Where measurement disagreed with
the document above, the measurement won and this is the record of it. Every
number here comes from `npm run test:l2`, which writes `public/generated/`.

**The `Z³/(f·S²)` law is the head-on case, and only the head-on case.** Off-axis,
the dominant signal is not the perspective trapezoid at all — it is the
first-order foreshortening of the square into a parallelogram, whose apparent
aspect ratio gives cos θ directly. Measured exponents: bearing error scales as
Z^1.0 at azimuth ≥ 2°, climbing toward Z^1.3 as azimuth → 0. So lateral error is
**quadratic off-axis and cubic only head-on**, and bearing error scales as
1/sin θ (measured 5× better at 40° than at 5°). §1's table understates how far
off-axis captures reach. The practical consequence is the interesting half:
**head-on is the ill-conditioned pose, not the safe one** — which corroborates
the research note that head-on carries maximum lateral σ. What genuinely breaks
with distance is the *sign*, whose evidence lives entirely in the second-order
term: flip rate at azimuth 10° went 0% at Z=8 → 38% at Z=32 with the gate open.

**§6.9's pixels-per-module gates were wrong in kind, not just in value.** With 28
sub-pixel points, bearing p95 stayed under 1.6° down to 3.6 px/module — well past
where the proposed gate of 5 was already refusing — and the flip rate was zero
throughout, because the branch margin is computed from the frame's own residuals
and therefore self-calibrates. What actually degrades at range is *distance*
(p95 hits 28% at 3.6 px/module), and what actually ends the range is zxing's own
decode floor at ~3.2 px/module. The gates are now: pixels-per-module as a decode
floor only (3.5), plus **predicted bearing and distance sigma computed per frame
from the pose covariance** — the same number the error bar shows, so the refusal
threshold and the public claim cannot drift apart.

**The error bars were 40% too narrow, and now are not.** Corners within one
finder pattern come from intersecting shared line fits, so they are not
independent observations, and `(JᵀJ)⁻¹` counts more evidence than exists. First
calibration run: p95 of |error|/σ was 2.71 against an honest 1.96, with 85% of
errors inside 2σ instead of 95%. A measured inflation constant of 1.4 fixes it
(now 74%/95% at 1σ/2σ, p95 z = 1.93), and a test fails if it drifts.

**Two of §9's carried-forward unknowns are settled.**
- *Moiré does not break decode.* Modelling the panel's black matrix and
  integrating it over the sensor footprint — the actual mechanism, unlike a naive
  downsample — gives 100% decode at every pitch tried, with bearing p95 of 0.21°
  and 0.58°. Corner sigma rises from 0.265 px to 0.327 px. It is a nuisance, not
  a threat.
- *Rolling shutter is the largest silent error in the system.* Never modelled
  before; now modelled, and it pushed bearing p50 from 0.06° to **1.49°** — worse
  than blur, noise, glare and over-sharpening combined — while decoding
  perfectly, producing a low residual, and passing every confidence gate. There
  is no single-frame signature, because the skew is absorbed into the homography
  as a plausible shear. This is why the burst now carries a **motion gate**:
  frames are discarded when the quad moved between captures. Without it, the
  biggest error in the pipeline is invisible.

**Blur is fatal; noise is nearly free.** Heavy noise (σ=14 levels) costs almost
nothing — the line fits average it away — while 2.2 px of defocus stops the
decode outright. ISP over-sharpening is the worst *realistic* corner-accuracy
degradation (0.378 px vs 0.265 nominal), because unsharp overshoot biases the
gradient centroid.

**Three changes the spec did not anticipate:**
- The token needed an eleventh byte. §4's field list carries `markerEdgeMm` but
  nothing relating the marker to the screen, so "distance in display heights" —
  the headline unit, chosen precisely because it needs no guesses — was
  unavailable in exactly the detached case §2.2 designed for. One quantised byte
  fixes it; tokens are 18 characters, still inside v2-M for a short domain.
- §6.1's "take one step to either side" cannot work. Flipping both captures
  negates the displacement, so the wrong pair is exactly as self-consistent as
  the right one. The step direction must be **named**; the copy now says "to your
  right".
- Safari will not expose `navigator.mediaDevices` on `http://127.0.0.1` even
  though Chrome will, and Playwright's Windows WebKit build exposes it nowhere.
  "Secure context" and "has a camera API" are two different failures needing two
  different answers, and conflating them produced a dead end that blamed the
  visitor's connection for something they could not fix.

**Still genuinely unresolved:** the real per-corner σ on a photograph of a real
LCD. Everything above is conditioned on a synthetic σ of 0.265 px, from a
renderer with no colour-filter array, no lens distortion and no autofocus
breathing. R1 remains the load-bearing experiment; the gates are now expressed
as functions of σ so that re-deriving them is a config change rather than an
audit.
