# vendor/

Everything the app needs to run, inside the app folder, so it depends on
nothing installed on the machine.

```
vendor/
  node/                the Node runtime the launchers run start.js with
  orcaslicer/          the slicing engine, trimmed to what a headless slice needs
  licenses/            the bundled software's licences and source pointers
  MANIFEST.json        what was bundled, from where, and when
```

**A released zip already contains this folder.** That is the point of it: the
person who receives the zip unpacks it and runs the app, with no Node
installed, no slicer installed, and no network connection.

This folder is generated, and it is not in git. It is rebuilt by `node
setup.js` and can be deleted at any time — but a folder without it is not a
folder you can hand to anyone.

## How it gets built

```bash
node setup.js                     # fetch and bundle for this platform
node setup.js --platform win32    # bundle for Windows (cross-building)
node setup.js --check             # report what is bundled, change nothing
node setup.js --force             # rebuild from scratch
node setup.js --full              # skip the trim, keep the whole slicer
```

Setup finishes by slicing a test cube through the bundled copy, so it either
proves the folder works or tells you what is wrong. "Files were copied" is not
the same claim.

To build the zip you actually send to someone, use `node make-release.js`,
which stages a clean copy, bundles a fresh `vendor/` for the target platform,
checks the result is complete, and zips it.

## Why OrcaSlicer and not Bambu Studio

Bambu Studio ships only as a GUI installer. There is no portable archive to
fetch and unpack, so a folder could never carry it — which is why the previous
version of this app copied Bambu Studio out of an install on the machine it ran
on, and why a machine without Bambu Studio produced:

> The slicing engine isn't installed on the server yet.

OrcaSlicer is a fork of Bambu Studio. It takes the same command-line flags
(`--load-settings`, `--load-filaments`, `--slice`, `--export-3mf`), and it
publishes a portable build. So it can be bundled, and the folder really does
run anywhere.

**The numbers still come from Bambu.** The profiles in `server/profiles/` are
built by `server/scripts/build-profiles.js` from Bambu Studio's own presets for
the P2S — the layer heights, speeds, temperatures, flow and filament densities
the shop prints with. OrcaSlicer is the engine that reads them, not the source
of the settings.

The one thing taken from OrcaSlicer's own profile is the machine start/end
G-code, because Bambu's uses template variables only Bambu Studio defines
(`filament_type[initial_no_support_filament_id]`) and OrcaSlicer aborts on
them. These files are never printed — they exist to produce a weight and a
time. Measured cost of that swap on a 40 mm PLA cube: 20.37 g against 20.62 g,
about 1%.

## Why the copy is trimmed

The official Windows portable release is 415 MB; the bundled copy is 163 MB.
The difference is all GUI: the hardware-error database, rendering assets,
translations, embedded web views, fonts, sample models — plus the print
profiles for the 60-odd printer vendors this app never slices for. A headless
slice on a Bambu P2S touches none of it.

The exact list, with a reason per entry, is `EXCLUDE_RESOURCES` and
`KEEP_PROFILE_VENDORS` in `setup.js`.

This is verified rather than assumed: a 40 mm PLA cube produces **byte-identical
G-code** trimmed and untrimmed — 20.28 g, 1319 s, 6691.78 mm either way. If a
future OrcaSlicer needs something the trim drops, `node setup.js --force
--full` gets you running again immediately, and the fix is to move that entry
out of the list.

## Verified self-contained

The shipped Windows folder was checked by running it, not by reading it: the
bundled `vendor/node/node.exe` running `server/scripts/verify-profiles.js`
resolves the bundled `vendor/orcaslicer/orca-slicer.exe`, slices a 40 mm cube
and prices it — 20.28 g, 22 min, $20.00 — with no Node and no slicer installed
on the machine. The Windows and Linux builds return identical figures.

`server/src/slicer.js` picks the engine in this order:

1. `ORCA_SLICER_BIN`, if set — the deliberate override
   (`BAMBU_STUDIO_BIN` is still honoured, for shops that set it before the
   engine changed)
2. this folder
3. an OrcaSlicer installed on the machine

The bundled copy beats an installed one so a folder carrying its own slicer
doesn't quietly switch to a different version that happens to be present.
Different version, different numbers, and nothing on screen would say so.

## Licences — read this before you pass the folder on

OrcaSlicer is **AGPLv3**. Handing this folder to someone else — a colleague, a
download page, a customer — is redistribution, and redistribution carries
obligations: keep the licence and notices intact, and be able to point whoever
receives it at the corresponding source.

`vendor/licenses/` is written by `setup.js` for exactly this reason. It
contains OrcaSlicer's licence text and a `NOTICE.md` naming the precise release
that was bundled, its SHA-256, and the upstream source tag it was built from.
The binaries are the official unmodified release, so the upstream tag *is* the
corresponding source.

Keep that folder with the app. Not legal advice.
