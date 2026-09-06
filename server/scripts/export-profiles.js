#!/usr/bin/env node
'use strict';

/**
 * Writes the three profiles the quote service loads, from a local Bambu Studio
 * installation. Cross-platform replacement for export-profiles.sh.
 *
 * WHY NOT `--export-settings`
 *   That dumps the *current project* config. Run headlessly there is no project,
 *   so it emits Bambu Studio's generic defaults — a 200x200x100 bed and
 *   filament_density 0 — regardless of which printer is selected in the GUI.
 *   Slicing against that produces confident, wrong prices. We read the selected
 *   preset names out of BambuStudio.conf and take the vendor profiles instead.
 *
 * WHY EVERY FILE IS RESOLVED, NOT COPIED VERBATIM
 *   `--load-settings` and `--load-filaments` do NOT follow a profile's
 *   `inherits` chain. Only keys written in the file itself reach the slicer;
 *   for everything else it silently uses its own generic defaults. Copying the
 *   vendor leaf profiles verbatim therefore threw away 42 of 116 machine
 *   settings and 146 of 198 process settings, including:
 *
 *     printable_area         256x256 in the profile -> 200x200 default used,
 *                            so anything with a footprint over ~200mm was
 *                            rejected as "no object fully inside the plate"
 *     sparse_infill_density  15% in the profile -> 20% default used, which
 *                            overstated filament on every single quote
 *
 *   Nothing warns about this: the slice succeeds and returns a confident,
 *   wrong number. So we resolve each chain ourselves and write the complete
 *   configuration.
 *
 *   The leaf's own values still win, and its identity keys (`name`,
 *   `inherits`, `from`, `setting_id`) are preserved — that identity is what
 *   the printer/process compatibility check keys off, and dropping it is what
 *   produces "The selected printer is not compatible with the process preset".
 *   Resolving the chain and keeping the identity does not trip that check;
 *   `verify-profiles.js` proves it end to end.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT_DIR = process.env.PROFILE_DIR || path.join(__dirname, '..', 'profiles');

/* ------------------------------------------------------- locating the install */

function resourceDirCandidates() {
  const home = os.homedir();
  const dirs = [];

  // The copy setup.js vendored into this folder, first — on a machine set up
  // that way it is the only Bambu Studio there is.
  const vendor = path.join(__dirname, '..', '..', 'vendor', 'bambu-studio');
  dirs.push(
    path.join(vendor, 'resources'),                                   // Windows / Linux tree
    path.join(vendor, 'BambuStudio.app', 'Contents', 'Resources'),    // macOS bundle
    path.join(vendor, 'Bambu Studio.app', 'Contents', 'Resources')
  );

  if (process.env.BAMBU_STUDIO_BIN) {
    // .../Bambu Studio/bambu-studio.exe -> .../Bambu Studio/resources
    dirs.push(path.join(path.dirname(process.env.BAMBU_STUDIO_BIN), 'resources'));
    // macOS bundle: .../Contents/MacOS/BambuStudio -> .../Contents/Resources
    dirs.push(path.resolve(path.dirname(process.env.BAMBU_STUDIO_BIN), '..', 'Resources'));
  }
  dirs.push(
    'C:\\Program Files\\Bambu Studio\\resources',
    'C:\\Program Files (x86)\\Bambu Studio\\resources',
    path.join(home, 'AppData', 'Local', 'Programs', 'Bambu Studio', 'resources'),
    '/Applications/BambuStudio.app/Contents/Resources',
    '/Applications/Bambu Studio.app/Contents/Resources',
    path.join(home, 'Applications', 'BambuStudio.app', 'Contents', 'Resources'),
    '/opt/bambu-studio/resources',
    '/usr/share/bambu-studio/resources'
  );
  return dirs;
}

function findResourceDir() {
  for (const d of resourceDirCandidates()) {
    if (fs.existsSync(path.join(d, 'profiles'))) return d;
  }
  return null;
}

function findConfigFile() {
  const home = os.homedir();
  const candidates = [
    path.join(home, 'AppData', 'Roaming', 'BambuStudio', 'BambuStudio.conf'),
    path.join(home, 'Library', 'Application Support', 'BambuStudio', 'BambuStudio.conf'),
    path.join(home, '.config', 'BambuStudio', 'BambuStudio.conf'),
  ];
  return candidates.find((f) => fs.existsSync(f)) || null;
}

/* ------------------------------------------------------------ reading choices */

/**
 * BambuStudio.conf is JSON followed by a `# MD5 checksum ...` trailer, so it
 * cannot be handed straight to JSON.parse.
 */
function readConfig(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const end = raw.lastIndexOf('\n}');
  if (end === -1) return null;
  try {
    return JSON.parse(raw.slice(0, end + 2));
  } catch {
    return null;
  }
}

/*
 * Filaments the service quotes, and the vendor preset each one slices with.
 *
 * Material is not just a price: ASA is 1.05 g/cm3 against PLA's 1.26, so the
 * same model is ~17% lighter in ASA, and it prints at 270C rather than 220C.
 * Quoting ASA from a PLA slice would be wrong in grams before any pricing is
 * applied, so each material gets its own filament profile and its own slice.
 */
const FILAMENTS = [
  { key: 'PLA', file: 'pla_basic.json', preset: null },   // null = whatever the GUI has selected
  { key: 'ASA', file: 'asa_basic.json', preset: 'Bambu ASA @BBL P2S 0.4 nozzle' },
];

const DEFAULTS = {
  machine: 'Bambu Lab P2S 0.4 nozzle',
  process: '0.20mm Standard @BBL P2S',
  filament: 'Bambu PLA Basic @BBL P2S',
};

function selectedPresets(config) {
  const p = (config && config.presets) || {};
  const filament = Array.isArray(p.filaments) && p.filaments.length
    ? p.filaments[0]
    : p.filament;
  return {
    machine: p.machine || DEFAULTS.machine,
    process: p.process || DEFAULTS.process,
    filament: filament || DEFAULTS.filament,
  };
}

/* ------------------------------------------------------- the profile database */

/**
 * Indexes one vendor's presets by category and preset name.
 *
 * WHY ONE VENDOR AND NOT ALL OF THEM
 *   Twelve vendors each ship a preset literally named `fdm_process_common`,
 *   and they disagree — Bambu's sets `wall_loops: 2`, Anker's and Prusa's set
 *   3. An index built across every vendor resolves that name to whichever
 *   directory `readdirSync` happened to return first (Anker), so a Bambu
 *   profile would quietly inherit another manufacturer's wall count and every
 *   quote would carry an extra perimeter. Resolution stays inside the vendor
 *   that owns the leaf preset.
 */
function indexVendor(resourceDir, vendor) {
  const dir0 = path.join(resourceDir, 'profiles', vendor);
  const index = { machine: new Map(), process: new Map(), filament: new Map() };

  for (const category of Object.keys(index)) {
    const dir = path.join(dir0, category);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const full = path.join(dir, file);
      let json;
      try { json = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
      const name = json.name || path.basename(file, '.json');
      if (!index[category].has(name)) index[category].set(name, { file: full, json });
    }
  }
  return index;
}

/** Vendor directories present in a Bambu Studio install, Bambu's own first. */
function vendorNames(resourceDir) {
  const root = path.join(resourceDir, 'profiles');
  const dirs = fs.readdirSync(root).filter((v) => {
    try { return fs.statSync(path.join(root, v)).isDirectory(); } catch { return false; }
  });
  return dirs.sort((a, b) => (a === 'BBL' ? -1 : b === 'BBL' ? 1 : a.localeCompare(b)));
}

/** The vendor whose machine directory defines `machineName`. */
function vendorFor(resourceDir, machineName) {
  for (const vendor of vendorNames(resourceDir)) {
    if (indexVendor(resourceDir, vendor).machine.has(machineName)) return vendor;
  }
  return null;
}

/**
 * Resolves the preset to export, tolerating names that aren't vendor presets.
 *
 * Bambu Studio records the *current project's* preset in BambuStudio.conf, and
 * once you tweak a setting with a project open that becomes a project-local
 * name like "(MyModel.3mf)(MyModel.3mf)". It exists only inside that project
 * file, not in the vendor database, so looking it up throws — which meant this
 * script crashed for anyone who had been working on a model before running it.
 *
 * Falling back to the documented P2S default is the safe answer: it is the
 * profile the service is supposed to quote against anyway. It warns loudly,
 * because silently exporting different settings than the operator has selected
 * is exactly the kind of drift that makes prices wrong.
 */
function resolvePreset(index, category, name) {
  if (index[category].has(name)) return { name, hit: index[category].get(name) };

  const fallback = DEFAULTS[category];
  if (index[category].has(fallback)) {
    console.log('');
    console.log('NOTE: "' + name + '"');
    console.log('      is a project-local ' + category + ' preset, not a vendor one — Bambu Studio');
    console.log('      writes those when you change settings with a project open.');
    console.log('      Falling back to the default: ' + fallback);
    console.log('      Select a saved vendor preset in Bambu Studio if you want a different one.');
    console.log('');
    return { name: fallback, hit: index[category].get(fallback) };
  }
  return { name, hit: null };
}

function requirePreset(index, category, name) {
  const hit = index[category].get(name);
  if (!hit) {
    const near = [...index[category].keys()].filter((k) => k.includes('P2S')).slice(0, 8);
    throw new Error(
      'No ' + category + ' preset named "' + name + '" in the Bambu Studio profile database.' +
      (near.length ? '\n  Nearby: ' + near.join(', ') : '')
    );
  }
  return hit;
}

/** Walks the `inherits` chain so we can read values a leaf profile doesn't set. */
function flatten(index, category, name, seen) {
  seen = seen || new Set();
  if (seen.has(name)) return {};
  seen.add(name);
  const hit = index[category].get(name);
  if (!hit) return {};
  const base = hit.json.inherits ? flatten(index, category, hit.json.inherits, seen) : {};
  return Object.assign({}, base, hit.json);
}

/* -------------------------------------------------------------------- writing */

/**
 * Settings this service deliberately overrides on top of the vendor profile.
 *
 * Kept here rather than hand-edited into the JSON so they survive a re-export.
 * Anything in this table is a decision about how the shop runs, not a
 * correction to Bambu's profile — so each one carries its reason.
 */
const SERVICE_OVERRIDES = {
  process: {
    // Customers upload arbitrary geometry and nobody hand-orients it before
    // quoting. With supports off, a model with overhangs is quoted ~74% light
    // on material (measured: 18.02g vs 31.39g on a T-shaped test part) and
    // would likely fail on the plate anyway. tree(auto) lets the slicer decide
    // per model, so flat parts are unaffected.
    enable_support: '1',

    // ASA cannot print on the Cool or Supertack plates at all - its plate temp
    // for those is 0, and the slicer refuses the job outright with "Filaments
    // are not compatible with the plate type". Textured PEI is the one plate
    // both materials we offer are happy on (PLA 55C, ASA 100C), and leaving it
    // unset let the slicer pick a default that ASA rejected.
    curr_bed_type: 'Textured PEI Plate',
  },
};

// Keys `--load-filaments` needs explicitly, because it does not pull them
// through `inherits`. Without density the slicer reports 0.00 g.
const FILAMENT_OVERLAY_KEYS = ['filament_density', 'filament_diameter', 'filament_cost'];

function main() {
  const resourceDir = findResourceDir();
  if (!resourceDir) {
    console.error('Could not find a Bambu Studio installation.');
    console.error('Set BAMBU_STUDIO_BIN to the executable and retry.');
    process.exit(1);
  }

  const configFile = findConfigFile();
  const config = configFile ? readConfig(configFile) : null;
  const picked = selectedPresets(config);

  console.log('Bambu Studio resources: ' + resourceDir);
  console.log(configFile
    ? 'Selected presets from:   ' + configFile
    : 'No BambuStudio.conf found - falling back to P2S defaults.');
  console.log('  machine:  ' + picked.machine);
  console.log('  process:  ' + picked.process);
  console.log('  filament: ' + picked.filament);
  console.log('');

  // The site quotes against a P2S: the viewer clamps to its 256mm build volume
  // and the shipped profiles are its defaults. Exporting a different printer
  // over them prices every customer against a machine the front end never
  // showed them, and nothing downstream would notice.
  // Checked against the *selected* machine, before any fallback: a shop that
  // has genuinely switched printers should be told, not quietly given P2S.
  if (!/P2S/i.test(picked.machine) && !/^\(.*\)\(.*\)$/.test(picked.machine)
      && !process.argv.includes('--allow-other-printer')) {
    console.error('Refusing to export: "' + picked.machine + '" is not a Bambu Lab P2S.');
    console.error('');
    console.error('This app quotes P2S prints - the viewer clamps models to the P2S');
    console.error('build volume, and the profiles already in server/profiles are the');
    console.error('P2S defaults. Overwriting them with another printer would quote');
    console.error('against a machine the customer was never shown.');
    console.error('');
    console.error('  - Nothing to do?  The P2S defaults ship with this app already.');
    console.error('  - Want the P2S profiles from your install? Select the P2S in');
    console.error('    Bambu Studio, then run this again.');
    console.error('  - Really quoting a different printer? Re-run with:');
    console.error('      --allow-other-printer');
    console.error('    and update the build volume in src/main.js to match.');
    console.error('');
    process.exit(1);
  }

  const vendor = vendorFor(resourceDir, picked.machine);
  if (!vendor) {
    console.error('No vendor in the profile database defines a machine named');
    console.error('"' + picked.machine + '".');
    process.exit(1);
  }
  console.log('  vendor:   ' + vendor);
  console.log('');

  const index = indexVendor(resourceDir, vendor);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Machine and process: the whole resolved chain, since the slicer won't
  // resolve it for us. flatten() merges parents first and the leaf last, so
  // the leaf's own values and its identity keys survive.
  const outputs = [
    ['machine', 'p2s_machine.json', picked.machine],
    ['process', 'p2s_process.json', picked.process],
    ...FILAMENTS.map((f) => ['filament', f.file, f.preset || picked.filament]),
  ];

  for (const [category, outName, wanted] of outputs) {
    const chosen = resolvePreset(index, category, wanted);
    if (!chosen.hit) requirePreset(index, category, wanted);   // throws with near-misses
    if (category !== 'filament' || wanted === picked.filament) picked[category] = chosen.name;

    const hit = chosen.hit;
    const resolved = flatten(index, category, chosen.name);
    const gained = Object.keys(resolved).length - Object.keys(hit.json).length;

    const overrides = SERVICE_OVERRIDES[category] || {};
    Object.assign(resolved, overrides);

    fs.writeFileSync(path.join(OUT_DIR, outName), JSON.stringify(resolved, null, 2));
    console.log('wrote ' + outName.padEnd(18) + '(' + chosen.name + ')');
    console.log('  ' + Object.keys(resolved).length + ' settings, ' + gained +
      ' of them inherited — all of which the slicer would otherwise have defaulted');
    for (const [k, v] of Object.entries(overrides)) {
      console.log('  override: ' + k + ' = ' + JSON.stringify(v) + '  (this service, not Bambu)');
    }
  }

  const filament = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'pla_basic.json'), 'utf8'));

  console.log('');
  for (const f of FILAMENTS) {
    const j = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f.file), 'utf8'));
    const d = parseFloat([].concat(j.filament_density || 0)[0]);
    const c = parseFloat([].concat(j.filament_cost || 0)[0]);
    console.log('  ' + f.key.padEnd(4) + ' density ' + (d || '?') + ' g/cm3   spool cost $' + (c || '?') + '/kg');
    if (!(d > 0)) console.log('    WARNING: no density - quotes for ' + f.key + ' will fall back to volume x density');
  }

  // Density decides grams, and grams decide the price, so it gets checked
  // rather than assumed. FILAMENT_OVERLAY_KEYS is what the resolve must supply.
  const missing = FILAMENT_OVERLAY_KEYS.filter((k) => filament[k] === undefined);
  if (missing.length) {
    console.log('');
    console.log('WARNING: the filament chain never sets: ' + missing.join(', '));
  }

  const density = parseFloat([].concat(filament.filament_density || 0)[0]);
  console.log('');
  if (!(density > 0)) {
    console.log('WARNING: filament_density is still 0. Quotes will fall back to');
    console.log('computing weight from extruded volume. Set a density in');
    console.log('Bambu Studio (Filament > Advanced) and re-run this script.');
  } else {
    console.log('filament_density = ' + density + ' g/cm3');
  }
  console.log('');
  console.log('Profiles written to ' + OUT_DIR);
  console.log('Verify with:  node server/scripts/verify-profiles.js');
}

main();
