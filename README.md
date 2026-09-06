# Vibes 3D Studio

Instant-quote site for a 3D printing service. Customers upload a model, size and
orient it against a Bambu Lab P2S build volume, and get a price computed from a
**real slice on Bambu's own P2S profiles** — not a volume estimate.

```
index.html  style.css  bundle.js     the site (static, no build step to run it)
src/main.js                          frontend source
server/                              the quoting service (see server/README.md)
setup.js                             bundles Node + OrcaSlicer into vendor/
make-release.js                      builds the zip you hand to someone else
vendor/                              generated — the app's own copies of both
```

## Quick start

**Unzip the folder, then double-click `START-WINDOWS.bat`.**

That is the whole procedure. A terminal window opens and your browser opens the
site automatically at <http://localhost:8080>. Leave that window open while you
use the site — closing it stops the server.

A released zip carries Node.js, the slicing engine and the printer profiles
inside it. Nothing to install, nothing to download, no network needed, no
first-run setup. Copy the folder to another machine and it still runs.

**Windows only.** The launcher and the bundled engine are built for Windows.
See **`START-HERE.txt`** if double-clicking trips SmartScreen.

Prefer the command line? `vendor\node\node.exe start.js`, or plain
`node start.js` if you have Node installed.

### Building the zip you send to someone

```bash
npm install                       # once, for esbuild
node make-release.js              # -> dist/vibes3d-studio-<version>-win64.zip
```

`make-release.js` stages a clean copy of the app, rebuilds the storefront from
source, bundles a fresh `vendor/` for the target platform, checks the staged
folder actually contains everything the app needs at runtime, and zips it. It
refuses to produce a zip that would fail on the far end.

The result is about 90 MB zipped and 242 MB unpacked.

### What is bundled, and why it is OrcaSlicer

`node setup.js` fetches two things, verifies each against a pinned SHA-256, and
unpacks them into `vendor/`:

1. **Node.js**, so the folder does not need one installed.
2. **OrcaSlicer**, the slicing engine, trimmed from 415 MB to 163 MB by dropping
   GUI-only assets and the print profiles for the 60-odd printer vendors this
   app never slices for.

Bambu Studio ships only as a GUI installer, so no folder can carry it — that is
why the previous version of this app had to copy Bambu Studio off whatever
machine it ran on, and why a machine without it reported *"The slicing engine
isn't installed on the server yet."* OrcaSlicer is a fork of Bambu Studio that
takes the same command-line flags and publishes a portable build, so it can
travel inside the folder.

**The prices still come from Bambu's numbers.** The profiles are built from
Bambu Studio's own P2S presets — see the next section. OrcaSlicer is the engine
that reads them, not the source of the settings.

Setup finishes by slicing a test cube through the bundled copy and printing the
price, so it proves the folder works rather than reporting that files were
copied. `node setup.js --check` reports what's bundled; `--force` rebuilds it.

See **`vendor/README.md`** for what's inside, what the trim drops and why, and
the AGPL obligations that come with handing the folder to someone else.

### Printer profiles ship with the app

`server/profiles/` already contains the **Bambu Lab P2S defaults** — 0.4 mm
nozzle, 0.20 mm Standard process, Bambu PLA Basic and Bambu ASA — with every
inherited setting resolved, so exact pricing works out of the box with nothing
to configure.

They are built from **Bambu Studio's own presets**, not OrcaSlicer's copies of
them, so the settings behind a price are the settings the shop prints with. The
20 Bambu presets they are built from live in `server/profiles/bambu-presets/`
(78 KB), so the profiles can be rebuilt without a Bambu Studio install.

The resolving matters more than it sounds. `--load-settings` does **not** follow
a profile's `inherits` chain: only keys written in the file itself reach the
slicer, and everything else silently falls back to the engine's generic
defaults. Copying the vendor profiles verbatim therefore lost 146 of 198 process
settings, which meant a **200×200 bed** (so any model wider than ~200 mm was
rejected) and **20% infill instead of 15%** (so every quote overstated filament
by about 11%). Nothing warned: the slice succeeded and returned a confident,
wrong number. `build-profiles.js` resolves each chain in full.

Rebuild them only if you change how you actually print:

```bash
node server/scripts/build-profiles.js     # resolve Bambu's presets
node server/scripts/verify-profiles.js    # slice a test cube, print the price
```

Three things `build-profiles.js` handles that the old export did not, each
found by running a slice rather than by reading the files:

- **The machine G-code was truncated.** Bambu keeps the long start/end G-code in
  sibling presets named `<machine> template <key>`, which nothing references by
  path. The old export missed them, so `machine_start_gcode` was 577 characters
  of a real 11,543.
- **Supports were switched on.** The exported process profile had
  `enable_support: 1`; Bambu's stock *0.20mm Standard @BBL P2S* has it off. Every
  quote was pricing supports the customer never asked for.
- **ASA could not be sliced at all.** With no `curr_bed_type`, the engine
  defaults to a Cool Plate, which ASA is not allowed on, and the job fails
  outright with *"Cool Plate does not support filament 1"*. It is now set to
  Textured PEI, the plate that takes PLA and ASA both.

The machine start/end G-code is taken from OrcaSlicer's profile for the same
printer rather than Bambu's, because Bambu's uses template variables only Bambu
Studio defines and OrcaSlicer refuses to parse them. Those blocks are never
printed — they exist to produce a weight and a time. Measured cost on a 40 mm
PLA cube: 20.37 g against 20.62 g, about 1%.

### Why you can't just open the HTML file

Double-clicking `index.html` loads the site, but:

- **the quoting service isn't running**, so "Get exact price" has nothing to
  call, and
- the page runs on `file://`, which browsers treat as a foreign origin — so
  even a running API would be blocked.

The launcher serves both from one origin, which makes the whole flow work with
nothing to configure. `dist/vibes3d-studio.html` is still handy for looking at
the design offline, but exact pricing will not work from it.

### Which slicer a price came from

`server/src/slicer.js` resolves the slicer in this order:

1. `ORCA_SLICER_BIN`, if set — the deliberate override
   (`BAMBU_STUDIO_BIN` is still honoured, for shops that set it before the
   engine changed)
2. `vendor/orcaslicer/` — the bundled copy
3. an OrcaSlicer installed on the machine, in the usual locations

The bundled copy beats an installed one, so a folder carrying its own slicer
doesn't quietly switch to whatever version happens to be on the host. The
startup checklist and `/api/health` both say which one is in use
(`setup.slicerVendored`).

### Rebuilding after edits

```bash
npm install                  # front-end build tools only
npx esbuild src/main.js --bundle --format=iife --outfile=bundle.js
node build-single-file.js    # regenerates dist/vibes3d-studio.html
node smoke-test.cjs          # headless check that the UI wires up
cd server && npm test        # 24 tests, no install needed
```

The **server has no dependencies at all** — it runs on Node built-ins only.
Nothing to install, nothing to break behind a proxy or without network access.

## Deploying it as a service

The launcher runs the shop on one machine. **Production runs in a container
instead, and quotes with Bambu Studio** — the same program the shop prints
with, so the price a customer sees is the number the shop sees.

```bash
cd server
docker compose up -d --build
curl localhost:8080/api/health      # expect "slicerEngine": "bambu"
```

The Bambu Studio release is pinned in the `Dockerfile` with its SHA-256, and
the image verifies the download before running it. Nothing needs installing on
the host, and nobody — customer or shop — downloads a slicer.

`server/profiles/` travels into the image. `vendor/` does not: the container
builds its own slicer in.

### Cloud hosting

What the container needs, and what it costs.

**Host OS.** Any Linux that runs Docker — Ubuntu 22.04 or 24.04 LTS, Debian 12,
or the equivalent. The image is `ubuntu:24.04` internally, so the host
distribution does not have to match. x86-64 only: Bambu Studio publishes no
ARM64 Linux build, so Graviton, Ampere and Apple-silicon hosts are out.

**Specs.**

| | Minimum | Recommended | Why |
|---|---|---|---|
| vCPU | 2 | **8** | Slicing parallelises across layers, and cores are the cheapest way to make a quote feel instant |
| RAM | 4 GB | 8 GB | A 25 MB / 500k-triangle mesh peaks around 3 GB while slicing |
| Disk | 10 GB | 20 GB | The image is ~2.5 GB; the rest is headroom for the layer cache |
| Network | — | — | Outbound only, at build time. The running service needs no internet |

Measured slice times on **4 cores**: a 40 mm cube under a second, a 110 mm
figurine about 40 s, a 500k-triangle model about 2 minutes. Eight cores is the
difference between "wait a moment" and "wait, is it broken".

**Roughly $40–90/month** for an 8-core instance on Hetzner, DigitalOcean or
Fly. Keep it always-on — a cold start costs more than the slice does.

**Configuration.** `docker-compose.yml` carries sensible defaults. The ones
worth knowing:

| Variable | Default | |
|---|---|---|
| `REQUIRE_ENGINE` | `bambu` | Refuse to quote if Bambu Studio is not the engine, rather than answering with a different program |
| `QUOTE_CPUS` | `8.0` | Container CPU limit |
| `MAX_CONCURRENT_SLICES` | `2` | Slices at once. Above this, requests queue |
| `SLICE_TIMEOUT_MS` | `180000` | Give up on a model that will not slice |
| `MAX_UPLOAD_BYTES` | `104857600` | 100 MB upload cap |
| `CORS_ORIGIN` | `*` | **Set this to your site's origin in production** |

**Storage.** `/tmp` is mounted as a 2 GB tmpfs, so uploaded models and slice
scratch never touch disk and do not survive a restart. That is deliberate:
customer files are not yours to keep.

**Licensing.** Bambu Studio is AGPLv3. Running it on your own server is
ordinary use. The `Dockerfile` is publishable because it only *fetches* Bambu
Studio; the image you build from it contains Bambu Studio, so **keep that image
in a private registry**. Not legal advice.

**Health.** `/api/health` reports which engine answered and whether it is the
required one. Alert on `slicerEngine` changing or `engineRefused` becoming
non-null: both mean quotes have stopped, which is the correct behaviour but
worth knowing about.

## How a quote is produced

1. The viewer loads `.stl` / `.obj` / `.3mf`, correcting Z-up files to the
   viewer's Y-up convention and centring the part on the plate.
2. Orientation is chosen automatically: the model is centerd on the plate,
   rested on it, and stood upright if it is clearly elongated and arrived lying
   down. That last rule is deliberately narrow — it only fires when one axis is
   at least 1.5x the next, so a wide flat panel is left lying rather than stood
   on its edge, which would be taller, tippier and need far more support.
3. The customer scales with the slider under the viewer, which runs from 100%
   (the size the file arrived at — never smaller) to whatever still fits the
   256×256×256 mm P2S volume, reading out both the percentage and the longest
   side in mm.
4. The quote starts **automatically** as soon as the model loads — uploading a
   file is a request for its price, so there is no second button to find. Only
   on load, though: re-slicing on every scale or rotation tweak would queue a
   slice per keystroke, so those mark the quote stale and wait for
   "Get exact price".
5. The mesh is exported as binary STL in printer coordinates and uploaded.
   Sending the transformed geometry — rather than the original file plus
   transform parameters — means the slicer measures exactly what the customer
   saw, with no second copy of the transform math to drift out of sync.

   Both the mesh walk and the STL write happen in chunks with the thread handed
   back between them. Done straight through, a 600k-triangle model froze the
   page for seconds and the browser offered to kill it; chunked, the longest
   single task is about 0.4s and the progress bar shows real percentages.
6. The service slices it headlessly, parses filament weight from the G-code, and
   returns a priced quote showing the grams it is based on. The panel shows each
   stage — reading, preparing, uploading, slicing — rather than one
   undifferentiated spinner.

   Print time is **not** shown. The API still returns `slice.printTimeSeconds`
   and it is parsed correctly, but it was only ever right for a single-color
   print, and an uploaded mesh carries no color data to derive the real figure
   from. A number that is right sometimes is worse than no number.
7. Changing the size or the material marks the quote stale and
   returns the panel to its idle state, so nobody checks out against a price
   that no longer matches the plate.

## Pricing lives only on the server

`server/src/pricing.js` is the single source of truth. The browser computes no
totals — a price the client can compute is a price the client can edit, and one
formula can't drift from another that doesn't exist.

Every gram is billed at **$0.60/g** for PLA, **$0.81/g** for ASA. A quote is not
a set of markups — it is the slice, itemized:

```
Model (53.46g @ $0.60/g)                       $32.08
Support (14.67g @ $0.60/g)                      $8.80
Purged (color changes) (107.97g @ $0.60/g)     $64.78
Prime tower (38.26g @ $0.60/g)                 $22.96
                                              -------
                                              $128.62
```

Those are the figures from a real 4-filament Bambu slice, billed straight
through — the same 53.46 / 14.67 / 107.97 / 38.26 the Slicing Result panel
shows.

### Where the grams come from

Bambu tags every run of extrusion in the G-code with `; FEATURE: <role>` and
prints in relative-E mode, so summing E between those markers gives filament per
component — the same data the slicer's GUI reads for its own table.
`FeatureScanner` in `server/src/gcode.js` does that in one streaming pass,
keeping only running sums, so a hundred-megabyte plate costs nothing in memory.

Two details it has to get right, both found by checking against a slice whose
header reported 30.00g:

- **A bare `G1 E0.8` is a deretraction**, priming the nozzle after a hop, not
  material. Support geometry is full of them — one per island, hundreds per
  print. Counting them gave 43.17g, 44% over.
- **G2/G3 arcs are extrusion too.** That slice had 70,498 of them and support is
  almost entirely arcs; skipping them gave 19.07g, 36% under.

With both handled it returns **30.05g against 30.00g — 0.17% out**.

If the scan ever totals less than the slicer's own figure, the difference is
billed as `Other extrusion` rather than quietly dropped: unaccounted grams still
left the spool.

### Purge and prime tower need a project you sliced

Those two components only exist in a multi-filament slice, and **we cannot
produce one**. Loading four filament profiles works — the CLI accepts it and
slices fine — but an uploaded mesh carries no instruction about *which* filament
goes where, so the slicer uses the first one and never changes. Tested with a
genuinely 4-color .3mf (four `<basematerials>`, per-triangle `p1`) and four
profiles loaded: still one filament, 42.51g, no purge, no tower. Where the
colors go is a decision made in Bambu Studio, not data in the file.

So for a multicolor job, **upload the .3mf you already sliced**. It carries
`Metadata/slice_info.config` with per-filament grams *and* its own plate G-code,
which the same feature scan splits into all four components — Bambu's numbers,
not an estimate of them, returned in milliseconds because nothing is re-sliced.
Rescaling in the viewer discards it and falls back to slicing the mesh.

Size on its own costs nothing: a big part and a small one at the same weight are
the same price. $20 job minimum.

## Known limitations

- **Payment isn't wired up.** `POST /api/orders` returns 501 and the checkout
  button shows a placeholder. Shipping, handling, and tax appear as
  "Added at checkout" line items.
- **Color count is detected, not asked.** Three sources are checked, because
  no single one covers real files:
  - core-spec `<basematerials>` / `<m:colorgroup>` referenced by an object's
    `pid`/`pindex` or a triangle's `p1` — what most exporters write;
  - `paint_color` on a triangle — Bambu and Orca color *painting*, which is
    outside the 3MF spec;
  - distinct `extruder` values in `Metadata/model_settings.config` — how a
    Bambu or Orca **project** assigns filaments per part, which is not in the
    3MF geometry at all. A four-color Bambu job would otherwise read as
    single-color and be quoted with no purge.

  An `.obj` splits by `usemtl`; an `.stl` carries no color, so it is always
  one. Only colors the geometry actually *references* count — a file can
  define a palette of eight and use two.
- **Color from a texture isn't detected.** A model colored by a texture map
  rather than per-part materials reads as single-color, because there are no
  discrete filaments to count. Nothing in the file says how it would be
  separated onto an AMS.
- **PLA and ASA.** Adding another means adding it to `CONFIG.materials` and
  adding it to `TARGETS` in `build-profiles.js`.
- **Quotes reflect one print profile.** Whatever infill and wall count you
  export into `p2s_process.json` is what every customer is priced against.
- **Supports are on** (`enable_support: 1`, tree(auto)). Customer uploads are
  never hand-oriented, so the slicer decides per model: flat parts get none,
  overhang parts get supports and are priced for them. With supports off, an
  overhang model quoted ~74% light on material (18.02g vs 31.39g on a T-shaped
  test part) and would likely have failed on the plate. It is a service
  override in `build-profiles.js`, so it survives a rebuild.
- **Print time is deliberately not shown.** It is parsed and returned by the
  API, but only ever matched reality for a single-color print — on a
  319-change multicolor job the slice said 2h13m against a real 16h4m, and an
  uploaded mesh carries no color data to do better. The *material* is
  corrected for purge; the time was removed rather than shown wrong.
- **One slice at a time.** `MAX_CONCURRENT_SLICES` defaults to 1 and the queue
  holds 8; past that the server returns 503 rather than growing a backlog it
  can't serve. Raise it only on a machine with cores to spare.
- **Very detailed models still have a ceiling.** The mesh uploads as
  uncompressed binary STL — 50 bytes per triangle — so a 2M-triangle model is a
  ~100 MB body from a file that looked like 15 MB. The browser streams it to
  disk, so the limit is `MAX_STREAM_BYTES` (512 MB, about 10M triangles) rather
  than available memory. Past that the customer is told to reduce detail.
- **`.3mf` is parsed by hand, not by `DOMParser`.** A .3mf stores one XML
  element per vertex and per triangle; handing that to `DOMParser` builds a
  node for every one, which measured 1.46s of unbreakable blocking on a
  320k-triangle model and put "Page Unresponsive" on screen for larger ones.
  `src/main.js` scans the XML linearly instead — 3.4x faster, chunked so it
  yields every ~8ms, and it reports real progress. It handles the 3MF
  Production Extension (cross-file `p:path` component references, which
  three.js's stock loader can't follow) in the same pass, so nothing is parsed
  twice.
- **OrcaSlicer is AGPLv3.** Calling the released CLI as a separate process is
  ordinary use; modifying the slicer tightens obligations considerably. Not
  legal advice.
