# vendor/

Everything the app needs to run, copied into the app folder so it depends on
nothing installed on the machine.

**This folder is generated. Don't edit it, and don't commit it.** It is rebuilt
by `node setup.js` and can be deleted at any time — the app keeps working as
long as Node and Bambu Studio are installed the ordinary way.

```
vendor/
  node/                the Node runtime the launchers run start.js with
  bambu-studio/        the slicer, trimmed to what a headless slice needs
  MANIFEST.json        what was vendored, from where, and when
```

## How it gets built

```bash
node setup.js            # auto-detect an install and vendor it
node setup.js --check    # report what's vendored, change nothing
node setup.js --force    # rebuild from scratch
node setup.js --full     # skip the trimming, copy the whole install
```

Setup finishes by slicing a test cube through the vendored copy, so it either
proves the folder works or tells you what's wrong. "Files were copied" is not
the same claim.

## Why it copies instead of downloading

Bambu Studio ships as a GUI installer, not a portable archive, so there is
nothing to fetch and unpack even with a network connection. Copying an install
already on disk works offline — and it vendors *the version the shop already
prints with*, which is the version whose numbers the prices are supposed to
match.

The Node binary is self-contained on all three platforms, so setup copies the
one running it. No download, no version matching.

## Why the Bambu Studio copy is trimmed

A full install is ~780 MB; the vendored copy is ~200 MB. The difference is all
GUI: rendering assets, translations, embedded web views, the hardware-error
database, printer models, and the bundled Visual C++ and WebView2 installers. A
headless slice touches none of it.

The exact list, with a reason per entry, is `EXCLUDE_RESOURCES` and
`EXCLUDE_TOP` in `setup.js`. If a Bambu Studio update ever needs something the
trim drops, `node setup.js --force --full` gets you running again immediately,
and the fix is to move that entry out of the list.

On Windows setup also brings in the Visual C++ runtime DLLs. Bambu Studio's
installer normally puts those in System32; a copied install has no installer, so
without them the exe would refuse to start on a machine that has never run an
MSVC-built program.

## Verified self-contained

The vendored slicer resolves its own print profiles. With
`%APPDATA%\BambuStudio` absent entirely — a machine that has never run Bambu
Studio — a 40 mm test cube still slices to 23.04 g, the same figure the system
install produces. Nothing here falls back to a system install at runtime.

`server/src/slicer.js` picks the slicer in this order:

1. `BAMBU_STUDIO_BIN`, if set — the deliberate override
2. this folder
3. a Bambu Studio installed on the machine

The vendored copy beats an installed one so a folder carrying its own slicer
doesn't quietly switch to a different version that happens to be present.
Different version, different numbers, and nothing on screen would say so.

## Before you zip this folder up and send it to someone

Bambu Studio is **AGPLv3**. Copying it into your own folder for your own use is
ordinary use. Distributing that copy — handing the zip to a colleague, putting
it on a download page, shipping it to a customer — is redistribution, and it
carries obligations: keep the license and notices intact, and offer the
corresponding source.

That is why `setup.js` copies from an install on the machine rather than
bundling binaries into the project: each machine vendors its own, and nothing is
redistributed. If you do want to hand the whole folder to someone, either delete
`vendor/bambu-studio/` first and let them run `node setup.js`, or read the AGPL
and satisfy it deliberately. Not legal advice.
