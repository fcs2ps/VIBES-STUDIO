# Vibes 3D Studio — quote service

Slices uploaded models with **Bambu Studio's headless CLI** and returns a price
based on the real filament weight, not a volume estimate.

## Why this exists

The browser-only version guessed weight as `volume × density × a fixed fill
factor`. That factor can't be right for both solid blocks (which the slicer
hollows out) and thin-walled parts (which are already mostly air in the mesh
but print nearly solid). On a 200mm hollow box it under-estimated by ~40%
— 280g against a real 458g. A real slice removes the guess entirely.

## Running it on one machine

For the single-machine case — the shop's own computer — don't use Docker. Run
`node setup.js` from the project root: it bundles Node and Bambu Studio into
`vendor/` and `start.js` serves the site and this API from one origin. See the
root `README.md`. The rest of this file is about deploying it as a service.

## Setup

### 1. Printer profiles (already done)

`profiles/` ships with the Bambu Lab P2S factory defaults, so there is nothing
to export before the service can price anything. Confirm it end to end:

```bash
node scripts/verify-profiles.js   # slices a test cube and prices it
```

`verify-profiles.js` exercises the same code path as `/api/quote`, so a pass
means quoting works end to end rather than only that the files parse.

Re-export only if you change how you actually print. Select the process and
filament you use in the Bambu Studio GUI, then:

```bash
node scripts/export-profiles.js   # rewrites the three files in profiles/
```

It refuses to export a non-P2S machine, since the viewer only ever shows a P2S
build volume; `--allow-other-printer` overrides that.

Do **not** hand-write these. They are fully resolved on purpose: the CLI does
not follow a profile's `inherits` chain, so any key the file doesn't state
itself falls back to Bambu Studio's generic defaults — silently, with a
successful slice and a wrong number. The leaf's identity keys (`name`,
`inherits`, `from`, `setting_id`) are preserved so the printer/process
compatibility check still passes.

Do not use `--export-settings` either: headless it dumps Bambu Studio's generic
defaults (200×200×100 bed, zero filament density), not your printer.
`profiles/README.md` has the details.

**The process profile defines every quote.** Its infill percentage and wall
count are what customers are priced against. If you change how you actually
print, update it or your prices drift from your real material cost.

### 2. Build and run

The AppImage URL changes with each release, so it isn't pinned here. Grab the
current Linux asset from
<https://github.com/bambulab/BambuStudio/releases>:

```bash
export BAMBU_URL="https://github.com/bambulab/BambuStudio/releases/download/.../Bambu_Studio_ubuntu-24.04_....AppImage"
export CORS_ORIGIN="https://vibes3dstudio.com"
docker compose up -d --build
```

Verify:

```bash
curl localhost:8080/api/health
```

`slicer` should read `ready`. If it says `unavailable`, the CLI isn't
resolving inside the container.

### 3. Point the front end at it

Same-origin (both behind one reverse proxy) needs no configuration. Otherwise
set the base URL in `index.html`:

```html
<script>window.VIBES_API_BASE = 'https://quotes.vibes3dstudio.com';</script>
```

## API

### `GET /api/health`

```json
{ "ok": true, "slicer": "ready", "queueDepth": 0, "activeSlices": 0,
  "setup": { "ready": true, "slicerFound": true, "slicerVendored": true,
             "missingProfiles": [] },
  "pricing": { "costPerGram": 0.6, "minimumCharge": 20, "material": "PLA" } }
```

### `POST /api/quote`

Two request shapes. **Raw body** is what the browser uses: the mesh is the
request body and its metadata rides in the query string, which lets the server
stream it straight to disk.

```
POST /api/quote?name=model.stl&multicolor=false&dims={"x":40,"y":40,"z":40}
Content-Type: application/octet-stream
<binary STL bytes>
```

| Param | Notes |
|---|---|
| `name` | Filename; only its extension is used, and only `.stl` / `.3mf` / `.obj` are accepted. |
| `multicolor` | `"true"` / `"false"` |
| `dims` | JSON `{x,y,z}` mm, printer axes (Z up). Drives the large-print surcharge and the bed check. |

**`multipart/form-data`** still works, for curl and anything else pointed at
this endpoint — fields `model` (file), `multicolor`, `dims`. It is capped much
lower, because that path buffers the whole upload in memory.

| | Limit | Why |
|---|---|---|
| Raw body | `MAX_STREAM_BYTES`, default **512 MB** | streams to disk, constant memory |
| Multipart | `MAX_UPLOAD_BYTES`, default **100 MB** | buffered, then copied again to split parts |

A detailed model is far bigger than its file: a `.3mf` is compressed XML, but
the mesh is uploaded as uncompressed binary STL at 50 bytes per triangle, so a
2M-triangle model is a ~100 MB body from a 15 MB file. That is why the browser
uses the streaming path.

Returns the quote plus slice diagnostics:

```json
{
  "requestId": "…",
  "quote": { "lines": [...], "subtotal": 274.80, "total": 274.80,
             "belowMinimum": false, "weightGrams": 458 },
  "slice": { "weightGrams": 458, "weightSource": "slicer_reported",
             "printTimeSeconds": 133032, "profileMissingDensity": false },
  "elapsedMs": 41230
}
```

Watch `weightSource` and `profileMissingDensity` — see Troubleshooting.

Errors: `400` bad upload · `413` too large · `422` unsliceable or exceeds bed ·
`503` profiles missing, or busy (`BUSY` / `BUSY_TIMEOUT`, with `Retry-After`) ·
`504` slice timeout. Every error carries a `code` and a message written for the
customer, not for the slicer's own log.

### `POST /api/orders`

Returns `501`. **Placeholder for payment.** When wiring up Stripe, send the
`requestId` and re-verify the price server-side rather than trusting a total
that travelled through the browser.

## Pricing

All of it lives in `src/pricing.js` — the only copy. The browser computes no
prices, so the displayed total and the billed total cannot drift apart, and
editing values in devtools changes nothing.

| | |
|---|---|
| PLA | $0.60/gram, no flat fee |
| Multicolor | purge + prime tower, in grams, at the same rate |
| Minimum | $20 |

Multicolor adds grams, not a percentage. Purge comes from the slicer's own
`flush_volumes_matrix` (280 mm³ per change on the P2S) times the filament
density, over an estimated change count of `layers x (colors - 1)`; the prime
tower is a fitted 0.335 of the purge. Against a measured 4-color slice the
model reproduces 203.77 g as 203.31 g.

`parseGcodeStats` supplies `layerCount`, `flushVolumeMm3` and `density` from the
G-code, so the numbers follow the profile rather than being pinned in code.

```bash
npm test   # 24 tests: G-code parsing, pricing, multipart, zip
```

## Operational notes

**One slice at a time.** `MAX_CONCURRENT_SLICES` defaults to **1**. Bambu
Studio's CLI is itself multi-threaded and will use every core it can see, so two
of them don't halve the wall clock — they fight for CPU and memory, and the Node
process that has to answer `/api/health` competes with them for the same
machine. Serialising costs throughput under load and buys a server that keeps
answering.

**A bounded queue.** `MAX_QUEUE_DEPTH` (default 8) and `QUEUE_WAIT_TIMEOUT_MS`
(default 150s) cap the backlog. Past either, the request gets `503` with a
`Retry-After` rather than joining a queue it would time out in anyway — an
unbounded queue is how a busy server becomes an unresponsive one.

**G-code is never held whole.** Plate G-code runs to hundreds of megabytes and
all we need are the summary comments at each end. `zip.readEntryEnds` streams
the entry and keeps only the first and last 64 KB, so peak memory is fixed
regardless of plate size. Inflating the whole thing and converting it to a
string — what this used to do — stalled the event loop long enough to stop the
server answering anything, and on a big enough plate exhausted memory outright.

**The process stays up.** `installProcessGuards()` logs uncaught exceptions and
unhandled rejections instead of letting them exit. A dropped request is
annoying; a dead process takes the storefront down until somebody notices the
window closed, and from the browser both look like "couldn't connect".

**Which slicer ran.** `resolveBambuBin()` tries `BAMBU_STUDIO_BIN`, then
`vendor/bambu-studio/` in the project root, then the standard install paths. In
Docker the AppImage wrapper is on the first of those. `/api/health` reports
`setup.slicerVendored` so you can tell a bundled slicer from a host one — worth
checking when two deployments disagree about a price.

**Before any real volume**, replace the in-process gate with a proper job queue
(BullMQ/Redis). It dies with the process and doesn't survive a restart
mid-slice.

**Timeouts.** `SLICE_TIMEOUT_MS` (default 180s) kills runaway slices; Bambu
Studio's CLI has no built-in timeout and a pathological model will otherwise
run forever.

**Orientation.** We deliberately do *not* pass `--orient`. The customer already
chose an orientation in the viewer, and letting the slicer silently re-orient
would quote a different print than the one they approved.

**Privacy.** Uploads go to tmpfs and are deleted after each request. Nothing
is persisted.

## Troubleshooting

**`slicer: "unavailable"`** — the AppImage didn't extract or is missing a
system library. Run `docker compose exec quote-service bambu-studio --help`.

**Quotes that look far too cheap** — check `weightSource` in the response.
`slicer_reported` is the good path. Anything else means Bambu Studio emitted
`0.00 g` because the filament profile has no density, and the service fell
back to computing weight itself. Quotes stay correct, but fix the profile.

**`NO_GCODE` / 422** — usually a non-manifold mesh, or a model landing outside
the build volume. Try the same file in the Bambu Studio GUI to confirm.

**`EXCEEDS_BED` / 422** — the slicer rejected the model as not fully inside the
plate (`return_code -50`). If it looks like it should fit, check
`printable_area` in `profiles/p2s_machine.json`: it must be the P2S's
256×256, and it is only there because `export-profiles.js` resolves the
`inherits` chain. An unresolved profile silently gets Bambu Studio's generic
200×200 default and rejects anything wider.

**A `413` that arrives as a dropped connection** — fixed, but worth knowing the
shape of it. `readBody` used to call `req.destroy()` the moment an upload went
over the limit, which tore the socket down before the 413 could be written, so
the browser reported "couldn't reach the quoting service" for what was really
"your model is too big". Oversize uploads now get a real response first and the
socket closes after it flushes.

**A streamed upload the slicer says it "can not parse"** — check that the write
stream resolved on `'close'` and not `'finish'`. `finish` only means the bytes
reached the OS; the file descriptor is still open, and Windows refuses another
process a read handle on a file we still hold open for writing.

**`export-profiles.js` says "No process preset named (Something.3mf)(Something.3mf)"**
— Bambu Studio records the *current project's* preset in `BambuStudio.conf`, and
editing any setting with a project open turns that into a project-local name
that exists only inside the project file. The exporter falls back to the
documented P2S default and says so loudly. Select a saved vendor preset in the
GUI if you want a different one exported.

**Print time roughly double the slicer's** — fixed, but the shape is worth
knowing. Bambu writes both durations on a single line:

```
; model printing time: 2h 56m 9s; total estimated time: 2h 56m 29s
```

A pattern anchored to the start of the line never matches `total estimated
time`, so `model printing time` matched instead and its end-of-line capture
swallowed the rest — then `parseDuration`, which sums every number+unit it
finds, added the two together. The patterns now match mid-line and stop at the
`;`. `server/test/gcode.test.cjs` pins this against the real line.

**Errors with no detail on Windows** — `bambu-studio.exe` is a GUI-subsystem
binary and writes nothing to a console, so stdout and stderr come back empty.
The reason is in the CLI's own `result.json`, written to its working directory;
`slicer.js` reads it and puts `error_string` in front of the customer.

**"The selected printer is not compatible with the process preset"** — the
machine or process profile was flattened, renamed, or hand-assembled. Both must
keep their `inherits` line so Bambu Studio can resolve them against its own
vendor database. Re-run `node scripts/export-profiles.js`.

**Nothing on stdout from the slicer on Windows** — expected.
`bambu-studio.exe` is a GUI-subsystem binary and writes nothing to a console,
so `SliceError.detail` comes back empty there. The CLI's own `result.json`,
written into the slice working directory, carries `error_string` instead.

**Slow first request** — no warm-up trick here; Bambu Studio starts fresh each
call. If cold-start latency matters, keep the container warm and scale
horizontally.

## Licensing

Bambu Studio is **AGPLv3**. Invoking the released CLI as a separate process is
ordinary use and how print-farm tooling generally works, but AGPL obligations
tighten considerably if you modify the slicer itself. Not legal advice — worth
a lawyer's read before this earns money.
