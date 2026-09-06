#!/usr/bin/env node
'use strict';

/**
 * Builds the profiles the quote service slices with, from Bambu Studio's own
 * preset database.
 *
 *     node server/scripts/build-profiles.js --from "<BambuStudio data dir>"
 *
 * The numbers in a quote have to be the numbers the shop prints with, so the
 * settings come from Bambu's presets rather than OrcaSlicer's re-derived
 * copies of them. OrcaSlicer is only the engine that reads them.
 *
 * WHY EVERY FILE IS RESOLVED, NOT COPIED VERBATIM
 *   `--load-settings` and `--load-filaments` do NOT follow a profile's
 *   `inherits` chain. Only keys written in the file itself reach the slicer;
 *   everything else silently falls back to the engine's generic defaults, and
 *   the slice still succeeds — with the wrong numbers. Two that bit this
 *   project before:
 *
 *     printable_area         256x256 in the profile -> 200x200 default, so
 *                            anything over ~200mm was rejected as "no object
 *                            fully inside the plate"
 *     sparse_infill_density  15% in the profile -> 20% default, which
 *                            overstated filament on every quote
 *
 *   So each chain is resolved here and the complete configuration written out.
 *
 * TWO SETS, BECAUSE THERE ARE TWO ENGINES
 *   `server/profiles/`      Bambu's presets exactly as Bambu wrote them. This
 *                           is the canonical set and what production slices
 *                           with, because production runs Bambu Studio.
 *   `server/profiles/orca/` the same settings, adapted so OrcaSlicer will
 *                           accept them. Only the dev fallback uses these.
 *
 *   OrcaSlicer needs two changes and refuses the job without them. Bambu's
 *   start/end G-code uses template variables only Bambu Studio defines
 *   (`filament_type[initial_no_support_filament_id]`), which Orca rejects with
 *   "Not a variable name", return -100 — so the Orca set takes those blocks
 *   from Orca's own profile for the same printer. And Bambu's "auto" for
 *   tree_support_wall_count is -1, which Orca validates out of range.
 *
 *   Neither change touches a setting that moves the numbers. Measured on the
 *   same models, the two engines agree to within 1%.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = process.env.PROFILE_DIR || path.join(__dirname, '..', 'profiles');

/**
 * The presets to build, and what the service calls each one.
 *
 * Adding a material means adding a filament row here and a matching entry in
 * FILAMENT_PROFILES in src/slicer.js and `materials` in src/pricing.js.
 */
const TARGETS = [
  { out: 'p2s_machine.json', kind: 'machine', preset: 'Bambu Lab P2S 0.4 nozzle' },
  { out: 'p2s_process.json', kind: 'process', preset: '0.20mm Standard @BBL P2S' },
  { out: 'pla_basic.json', kind: 'filament', preset: 'Bambu PLA Basic @BBL P2S' },
  { out: 'asa_basic.json', kind: 'filament', preset: 'Bambu ASA @BBL P2S 0.4 nozzle' },
];

/** Machine G-code taken from OrcaSlicer's profile rather than Bambu's. */
const GCODE_KEYS = [
  'machine_start_gcode', 'machine_end_gcode', 'change_filament_gcode',
  'layer_change_gcode', 'time_lapse_gcode', 'machine_pause_gcode',
  'wrapping_detection_gcode', 'template_custom_gcode', 'printing_by_object_gcode',
  'before_layer_change_gcode', 'change_extrusion_role_gcode',
];

/**
 * Values Bambu accepts that OrcaSlicer rejects outright, with the replacement
 * and the reason. A slice dies on these rather than degrading, so each one is
 * a hard blocker discovered by running the slice.
 *
 * Applied only to the OrcaSlicer set. The Bambu set keeps Bambu's own values.
 */
const VALUE_FIXES = {
  process: {
    /*
     * Bambu uses -1 for "auto"; OrcaSlicer validates this to [0,2] and aborts
     * with "tree_support_wall_count: -1 not in range".
     *
     * Which legal value stands in for "auto" is not arbitrary — it moves the
     * number. Measured against Bambu Studio's own tree support on the same
     * two models: 0 gave +73% support on the lego figure and +53% on the
     * figurine, 2 gave +102%, and 1 gave +43% and +9%. So 1 it is.
     */
    tree_support_wall_count: { from: '-1', to: '1' },
  },
};

/**
 * Settings that belong to the plate rather than to any preset, and that the
 * slicer still insists on. Bambu's presets do not carry them because in the
 * GUI they come from the project.
 */
const PROCESS_DEFAULTS = {
  /*
   * Which build plate the shop runs. This is not cosmetic: the slicer checks
   * the filament against the plate and refuses the job outright when they do
   * not match — ASA on the default Cool Plate dies with "Cool Plate does not
   * support filament 1" (return -61) and produces no quote at all. Textured
   * PEI is the plate that takes PLA and ASA both.
   */
  curr_bed_type: 'Textured PEI Plate',

  /*
   * Where the prime tower stands. Also not cosmetic: a painted multi-colour
   * model needs one, and with no position stated the slicer puts it off the
   * plate and refuses the whole job with "Found G-code in unprintable area of
   * multi-extruder" (return -102) — so a multi-colour upload gets no quote at
   * all. Back corner of the 256mm plate, clear of a centred part.
   */
  wipe_tower_x: ['200'],
  wipe_tower_y: ['200'],

  /*
   * Supports on. Bambu's stock "0.20mm Standard @BBL P2S" ships with them off,
   * but the shop prints with them on, and a quote has to match the shop rather
   * than the preset: a figurine that needs support and is priced without it is
   * priced under. Type and threshold stay as Bambu's — tree(auto) at 30 deg.
   */
  enable_support: '1',

  /*
   * How much filament a colour change wastes, as a multiple of the flush
   * volume. OrcaSlicer defaults this to 0.3; Bambu does not, and the gap is
   * most of a multi-colour quote. On the painted figurine, 0.3 produced 149 g
   * of purge against Bambu Studio's 347 g — under by 197 g, about $118 of PLA
   * the shop would have eaten.
   */
  flush_multiplier: ['1.0'],
};

/* ------------------------------------------------------------------ index -- */

/** Indexes every preset in a vendor tree by name, so `inherits` can be followed. */
function indexTree(vendorDir) {
  const idx = { machine: new Map(), process: new Map(), filament: new Map() };
  for (const kind of Object.keys(idx)) {
    const base = path.join(vendorDir, kind);
    if (!fs.existsSync(base)) continue;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!e.isFile() || !e.name.endsWith('.json')) continue;
        try {
          const json = JSON.parse(fs.readFileSync(full, 'utf8'));
          if (json && json.name && !idx[kind].has(json.name)) {
            idx[kind].set(json.name, { file: full, json });
          }
        } catch { /* a malformed preset is not one we can inherit from */ }
      }
    };
    walk(base);
  }
  return idx;
}

/**
 * Bambu keeps the long machine G-code in sibling presets named
 * "<machine> template <key>" that the leaf profile never references by path.
 * Only the naming convention connects them.
 */
function mergeGcodeTemplates(idx, presetName, out) {
  const prefix = presetName + ' template ';
  for (const [name, rec] of idx.machine) {
    if (!name.startsWith(prefix)) continue;
    const key = name.slice(prefix.length);
    if (rec.json[key] !== undefined) out[key] = rec.json[key];
  }
}

/** Collapses a preset and everything it inherits into one standalone object. */
function flatten(idx, kind, presetName) {
  const chain = [];
  const seen = new Set();
  let cur = presetName;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const rec = idx[kind].get(cur);
    if (!rec) {
      throw new Error(`missing ${kind} preset "${cur}" (following inherits from "${presetName}")`);
    }
    chain.push(rec);
    cur = rec.json.inherits;
  }

  // Base first so the leaf's own values win.
  const out = {};
  for (const rec of chain.slice().reverse()) Object.assign(out, rec.json);

  // Identity stays the leaf's: the printer/process compatibility check keys off
  // it, and dropping it produces "The selected printer is not compatible with
  // the process preset".
  const leaf = chain[0].json;
  out.name = leaf.name;
  out.from = leaf.from || 'system';
  out.instantiation = leaf.instantiation || 'true';
  if (leaf.inherits !== undefined) out.inherits = leaf.inherits; else delete out.inherits;
  if (leaf.setting_id !== undefined) out.setting_id = leaf.setting_id;

  if (kind === 'machine') mergeGcodeTemplates(idx, presetName, out);
  if (kind === 'process') Object.assign(out, PROCESS_DEFAULTS);

  return { json: out, chain: chain.map((r) => r.json.name) };
}

/* ------------------------------------------------------------- locating -- */

/** Bambu's preset database, as shipped with an install or updated over the air. */
function bambuCandidates(explicit) {
  const dirs = [];
  const add = (d) => { if (d) dirs.push(d); };
  if (explicit) {
    // Accept the data dir, the vendor dir inside it, or the tree itself.
    add(path.join(explicit, 'system', 'BBL'));
    add(path.join(explicit, 'ota', 'presets', 'BBL'));
    add(path.join(explicit, 'BBL'));
    add(explicit);
  }
  const appdata = process.env.APPDATA;
  if (appdata) {
    add(path.join(appdata, 'BambuStudio', 'system', 'BBL'));
    add(path.join(appdata, 'BambuStudio', 'ota', 'presets', 'BBL'));
  }
  add(path.join(ROOT, 'server', 'profiles', 'bambu-presets', 'BBL'));
  return dirs;
}

/** OrcaSlicer's own preset tree, for the machine G-code blocks. */
function orcaCandidates(explicit) {
  const dirs = [];
  if (explicit) dirs.push(path.join(explicit, 'BBL'), explicit);
  const vendor = path.join(ROOT, 'vendor', 'orcaslicer');
  dirs.push(
    path.join(vendor, 'resources', 'profiles', 'BBL'),      // Windows / Linux
    path.join(vendor, 'OrcaSlicer.app', 'Contents', 'Resources', 'profiles', 'BBL')
  );
  return dirs;
}

function firstUsable(dirs, kinds = ['machine', 'process', 'filament']) {
  for (const d of dirs) {
    if (kinds.every((k) => fs.existsSync(path.join(d, k)))) return d;
  }
  return null;
}

/* ------------------------------------------------------------------ main -- */

function valueOf(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

/** Adapts a profile so OrcaSlicer will accept it. Returns what changed. */
function adaptForOrca(json, kind, preset, orcaIndex) {
  const notes = [];

  if (kind === 'machine') {
    const src = flatten(orcaIndex, 'machine', preset).json;
    let swapped = 0;
    for (const k of GCODE_KEYS) {
      if (src[k] !== undefined) { json[k] = src[k]; swapped++; }
      else delete json[k];
    }
    notes.push(`${swapped} G-code blocks from Orca`);
  }

  for (const [key, rule] of Object.entries(VALUE_FIXES[kind] || {})) {
    if (String(json[key]) === rule.from) {
      json[key] = rule.to;
      notes.push(`${key} ${rule.from} -> ${rule.to}`);
    }
  }
  return notes;
}

function main() {
  const bambuDir = firstUsable(bambuCandidates(valueOf('--from')));
  if (!bambuDir) {
    console.error('\n  Could not find Bambu Studio\'s preset database.\n');
    console.error('  It is the "system/BBL" folder inside Bambu Studio\'s data directory');
    console.error('  (on Windows: %APPDATA%\\BambuStudio). Point this at the data dir:\n');
    console.error('    node server/scripts/build-profiles.js --from "C:\\Users\\you\\AppData\\Roaming\\BambuStudio"\n');
    process.exit(1);
  }

  const orcaDir = firstUsable(orcaCandidates(valueOf('--orca')), ['machine']);
  const orcaOut = path.join(OUT_DIR, 'orca');

  console.log('\n  Bambu presets:  ' + bambuDir);
  console.log('  Orca presets:   ' + (orcaDir || '(none - skipping the OrcaSlicer set)') + '\n');

  const bambu = indexTree(bambuDir);
  const orca = orcaDir ? indexTree(orcaDir) : null;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (orca) fs.mkdirSync(orcaOut, { recursive: true });

  for (const t of TARGETS) {
    const { json, chain } = flatten(bambu, t.kind, t.preset);
    console.log(`  ${t.out.padEnd(20)} ${Object.keys(json).length} keys   ${chain.join(' <- ')}`);
    fs.writeFileSync(path.join(OUT_DIR, t.out), JSON.stringify(json, null, 2) + '\n');

    if (!orca) continue;
    const adapted = JSON.parse(JSON.stringify(json));
    const notes = adaptForOrca(adapted, t.kind, t.preset, orca);
    if (notes.length) console.log(`  ${''.padEnd(20)} orca/: ${notes.join(', ')}`);
    fs.writeFileSync(path.join(orcaOut, t.out), JSON.stringify(adapted, null, 2) + '\n');
  }

  console.log('\n  Wrote ' + TARGETS.length + ' Bambu Studio profiles to ' + OUT_DIR);
  if (orca) console.log('  Wrote ' + TARGETS.length + ' OrcaSlicer profiles to ' + orcaOut);
  else console.log('  No OrcaSlicer set written - pass --orca <resources/profiles> to build it.');
  console.log('  Verify with a real slice:  node server/scripts/verify-profiles.js\n');
}

main();
