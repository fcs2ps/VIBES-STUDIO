# Printer profiles

Four files, all present and ready to quote against:

| File | What it holds |
|---|---|
| `p2s_machine.json` | Bambu Lab P2S printer definition (bed size, nozzle, kinematics) |
| `p2s_process.json` | Print process — layer height, infill %, wall count, supports |
| `pla_basic.json` | PLA filament — including `filament_density`, which quoting needs |
| `asa_basic.json` | ASA filament — 1.05 g/cm³ against PLA's 1.26, so the same part weighs ~17% less |

These are the **Bambu Lab P2S factory defaults**: `Bambu Lab P2S 0.4 nozzle`,
`0.20mm Standard @BBL P2S`, `Bambu PLA Basic @BBL P2S` at 1.26 g/cm³. They are
byte-identical to what `export-profiles.js` produces from a stock Bambu Studio
install, so exact pricing works with nothing to set up.

Confirm the whole path works whenever you want:

```bash
node ../scripts/verify-profiles.js
```

That slices a 40mm test cube through the same code `/api/quote` uses, so a pass
means quoting works — not just that the files parse. A stock P2S lands at
**20.42 g** (15% infill, 2 walls, 0.20 mm layers). If you get 23.04 g, the
profiles are unresolved and every quote is roughly 11% over.

## Re-exporting them

Only needed if you change how you actually print — a different layer height,
infill, wall count or filament. Select it in the Bambu Studio GUI, then:

```bash
node ../scripts/export-profiles.js
```

It reads your selection from `BambuStudio.conf` and rewrites these three files
from the matching vendor profiles — looking first inside `vendor/bambu-studio/`,
then at an installed Bambu Studio.

It **refuses** to export a machine that isn't a P2S. The viewer clamps uploads
to the P2S build volume and the customer is never shown another printer, so
quoting against one would price every order against a machine that was never on
screen. `--allow-other-printer` overrides that, and means you also need to
update the build volume in `src/main.js`.

## Don't hand-write or hand-edit these

These files are **fully resolved**, and that is the whole point.

`--load-settings` and `--load-filaments` do **not** follow a profile's
`inherits` chain. Only the keys written in the file itself reach the slicer;
for every other setting it quietly uses its own generic defaults. Shipping the
vendor leaf profiles verbatim — which is what this used to do — threw away 42
of 116 machine settings and 146 of 198 process settings. Two of the casualties
mattered a great deal:

| Setting | Profile says | Slicer actually used |
|---|---|---|
| `printable_area` | 256×256 | **200×200** — rejected anything wider as "no object fully inside the plate" |
| `sparse_infill_density` | 15% | **20%** — overstated filament on every quote by ~11% |

Nothing warned about either. The slice succeeded and returned a confident,
wrong number.

So `export-profiles.js` resolves each chain itself and writes the complete
configuration. Two rules keep that working:

- **Keep the identity keys.** `name`, `inherits`, `from` and `setting_id` come
  from the leaf and must stay. They are what the printer/process compatibility
  check keys off; dropping them is what produces *"The selected printer is not
  compatible with the process preset"*. Resolving the values while keeping the
  identity does **not** trip that check — `verify-profiles.js` proves it.
- **Resolve within one vendor.** Twelve manufacturers ship a preset named
  `fdm_process_common` and they disagree — Bambu's sets `wall_loops: 2`,
  Anker's and Prusa's set 3. An index built across all vendors resolves that
  name to whichever directory the filesystem listed first, and a Bambu profile
  silently inherits another manufacturer's wall count.

The trade-off is that these no longer improve on their own when Bambu Studio
updates. Re-run `export-profiles.js` after an update to pick up changes.

## Why `--export-settings` isn't the answer

Bambu Studio's `--export-settings` dumps the *current project* configuration.
Run headlessly there is no project, so it writes the application's generic
defaults — a 200×200×100 bed and `filament_density: 0` — regardless of which
printer is selected in the GUI. Slicing against that produces confident, wrong
prices, and rejects any part over 200mm as off the bed.

## Filament density is worth checking by name

`filament_density` decides grams, and grams decide the price. It lives in a
parent of the leaf profile, so it is one of the keys that only arrives because
the chain is resolved. Without it Bambu Studio writes
`total filament used [g] = 0.00` and the service falls back to computing weight
from extruded volume — correct, but flagged.

If `/api/health` or a quote response reports `profileMissingDensity: true`, set
a density in Bambu Studio (Filament → Advanced) and re-run the export.

## The settings you choose here define every quote

The infill percentage and wall count in `p2s_process.json` are what the service
quotes against. If you later change how you actually print, re-run the export or
your prices will drift away from your real material cost.
