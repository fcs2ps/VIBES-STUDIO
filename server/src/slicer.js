'use strict';

const { execFile } = require('child_process');
const { promises: fs } = require('fs');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const zipReader = require('./zip');
const { writeZip } = require('./zipwrite');
const { parseGcodeStats, FeatureScanner } = require('./gcode');

// Cap on how much G-code we will decompress into memory. Real plate G-code for
// a bed-filling model runs to a few hundred MB at most; anything past this is
// either pathological or malicious, and we only need the header and footer
// comments anyway.
const MAX_GCODE_BYTES = 512 * 1024 * 1024;

const PROFILE_DIR = process.env.PROFILE_DIR || path.join(__dirname, '..', 'profiles');
// A Bambu project is sliced with its own settings and can be a 3M-triangle,
// 4-filament job - one real customer model took 52s. The old 3-minute cap was
// close enough to that to be a coin flip on a slower shop machine.
const SLICE_TIMEOUT_MS = Number(process.env.SLICE_TIMEOUT_MS || 600000);

/*
 * WHICH SLICER ANSWERS, AND WHY IT MATTERS
 *
 * Production runs Bambu Studio, because the shop prints from Bambu Studio and a
 * quote has to be the number the shop will see. OrcaSlicer is the fallback that
 * makes the folder run on a machine with nothing installed — good enough to
 * develop against, and measured within 1% of Bambu on the same input, but it is
 * not the same program and it does not get to answer a customer by accident.
 *
 * Each engine reads its own profile set. `server/profiles/` is Bambu's presets
 * exactly as Bambu wrote them; `server/profiles/orca/` is the same settings
 * adapted so OrcaSlicer will accept them at all. See build-profiles.js.
 */
const VENDOR_DIR = path.join(__dirname, '..', '..', 'vendor');

const ENGINES = {
  bambu: {
    label: 'Bambu Studio',
    env: 'BAMBU_STUDIO_BIN',
    profileDir: PROFILE_DIR,
    vendorDir: 'bambu-studio',
    candidates: [
      '/opt/bambu-studio/AppRun',
      '/usr/local/bin/bambu-studio',
      '/usr/bin/bambu-studio',
      'C:\\Program Files\\Bambu Studio\\bambu-studio.exe',
      'C:\\Program Files (x86)\\Bambu Studio\\bambu-studio.exe',
      `${os.homedir()}\\AppData\\Local\\Programs\\Bambu Studio\\bambu-studio.exe`,
      '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio',
      '/Applications/Bambu Studio.app/Contents/MacOS/BambuStudio',
      `${os.homedir()}/Applications/BambuStudio.AppImage`,
    ],
  },
  orca: {
    label: 'OrcaSlicer',
    env: 'ORCA_SLICER_BIN',
    profileDir: path.join(PROFILE_DIR, 'orca'),
    vendorDir: 'orcaslicer',
    candidates: [
      '/opt/OrcaSlicer/AppRun',
      '/usr/local/bin/orca-slicer',
      '/usr/bin/orca-slicer',
      'C:\\Program Files\\OrcaSlicer\\orca-slicer.exe',
      'C:\\Program Files (x86)\\OrcaSlicer\\orca-slicer.exe',
      `${os.homedir()}\\AppData\\Local\\Programs\\OrcaSlicer\\orca-slicer.exe`,
      '/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer',
      `${os.homedir()}/Applications/OrcaSlicer.AppImage`,
    ],
  },
};

/** Auto-resolution order. Bambu first: it is the one the shop prints with. */
const ENGINE_ORDER = ['bambu', 'orca'];

function executable(p) {
  try { fsSync.accessSync(p, fsSync.constants.X_OK); return true; } catch { return false; }
}

/**
 * The engine `setup.js` configured for this checkout, if it is the one asked
 * for.
 *
 * vendor/MANIFEST.json is the record of what setup found. It may point at a
 * copy bundled inside vendor/ (a released zip) or at a Bambu Studio installed
 * on the machine (a developer's checkout) — `bin` is relative to vendor/ in the
 * first case and absolute in the second, which is how they are told apart.
 */
function manifestBin(engineKey) {
  try {
    const manifest = JSON.parse(fsSync.readFileSync(path.join(VENDOR_DIR, 'MANIFEST.json'), 'utf8'));
    const slicer = manifest.slicer || {};

    // `engine` is explicit in current manifests; older ones only named the
    // program, so fall back to reading the name.
    const engine = slicer.engine
      || (String(slicer.name || '').toLowerCase().includes('bambu') ? 'bambu' : 'orca');
    if (engine !== engineKey || !slicer.bin) return null;

    const bin = path.isAbsolute(slicer.bin) ? slicer.bin : path.join(VENDOR_DIR, slicer.bin);
    if (!executable(bin)) return null;
    return { bin, vendored: !path.isAbsolute(slicer.bin) };
  } catch {
    return null;
  }
}

let resolved = null;

/**
 * Picks the engine and its binary.
 *
 * SLICER_ENGINE pins one ("bambu" or "orca"); the default tries Bambu first.
 * Within an engine: its explicit env override, then the bundled copy, then the
 * usual install locations.
 */
function resolveSlicer() {
  if (resolved) return resolved;

  const pinned = String(process.env.SLICER_ENGINE || '').trim().toLowerCase();
  const order = ENGINES[pinned] ? [pinned] : ENGINE_ORDER;

  for (const key of order) {
    const engine = ENGINES[key];

    const override = process.env[engine.env];
    if (override) return (resolved = { engine: key, label: engine.label, bin: override, vendored: false });

    const configured = manifestBin(key);
    if (configured) {
      return (resolved = {
        engine: key, label: engine.label, bin: configured.bin, vendored: configured.vendored,
      });
    }

    const found = engine.candidates.find(executable);
    if (found) return (resolved = { engine: key, label: engine.label, bin: found, vendored: false });
  }

  /*
   * Used by the release build's post-install check: without it a trim that
   * broke the bundled copy would fall through to an installed one and report a
   * pass the shipped folder cannot reproduce.
   */
  if (process.env.VENDOR_ONLY === '1') {
    const key = ENGINES[pinned] ? pinned : 'orca';
    return (resolved = {
      engine: key, label: ENGINES[key].label, vendored: false,
      bin: path.join(VENDOR_DIR, ENGINES[key].vendorDir, '(not bundled)'),
    });
  }

  // Last resort: hope one is on PATH.
  const key = ENGINES[pinned] ? pinned : 'orca';
  return (resolved = {
    engine: key, label: ENGINES[key].label, vendored: false,
    bin: key === 'bambu' ? 'bambu-studio' : 'orca-slicer',
  });
}

function resolveSlicerBin() { return resolveSlicer().bin; }

/** True once resolveSlicer() has settled on the copy inside vendor/. */
function usingVendoredSlicer() { return resolveSlicer().vendored; }

/**
 * The engine a quote may be answered with.
 *
 * REQUIRE_ENGINE=bambu makes the service refuse rather than answer with a
 * different program. A quote that silently changes by a few percent depending
 * on which binary happened to be installed is worse than no quote: nothing on
 * screen would say which one the customer got.
 */
function engineRefused() {
  const required = String(process.env.REQUIRE_ENGINE || '').trim().toLowerCase();
  if (!required || !ENGINES[required]) return null;
  const got = resolveSlicer();
  if (got.engine === required) return null;
  return `This service is configured to quote with ${ENGINES[required].label}, ` +
    `and it is not available (found ${got.label}).`;
}

class SliceError extends Error {
  constructor(message, { code = 'SLICE_FAILED', detail = null } = {}) {
    super(message);
    this.name = 'SliceError';
    this.code = code;
    this.detail = detail;
  }
}

function run(bin, args, { timeout, cwd }) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, {
      timeout,
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      killSignal: 'SIGKILL',
      // OrcaSlicer is a GUI app running headless; without these it can try
      // to open an X display and hang. xvfb-run in the Dockerfile covers the
      // rest.
      env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' },
    }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) {
          return reject(new SliceError(
            'Slicing timed out. The model may be too complex to quote automatically.',
            { code: 'SLICE_TIMEOUT' }
          ));
        }
        return reject(new SliceError('The slicer failed to process this model.', {
          code: 'SLICE_FAILED',
          detail: (stderr || stdout || err.message).slice(-4000),
        }));
      }
      resolve({ stdout, stderr });
    });
  });
}

// How much of each end of the G-code we keep. The summary comments we price
// from sit in the header and footer; the megabytes between them are toolpath.
const GCODE_EDGE_BYTES = 65536;

// Used when reading a project sliced elsewhere: its slice_info.config records
// grams but not the filament spec, and PLA at 1.75mm covers the overwhelming
// majority. The per-filament totals it reports are exact either way; only the
// component split leans on these.
const DEFAULT_DENSITY = 1.26;
const DEFAULT_DIAMETER = 1.75;

/**
 * Pulls the priceable parts of the plate G-code out of whatever the CLI
 * produced. `--export-3mf` writes a ZIP containing Metadata/plate_N.gcode — it
 * is not a bare .gcode file, which is a common tripping point.
 *
 * Returns only the head and tail, never the whole file: see `readEntryEnds` in
 * zip.js for why holding the middle is what made the server stop responding.
 */
async function extractGcode(outputPath) {
  const buf = await fs.readFile(outputPath);

  // Some flag combinations write raw .gcode rather than a .3mf container.
  if (!zipReader.isZip(buf)) {
    const head = buf.subarray(0, GCODE_EDGE_BYTES).toString('utf8');
    const tail = buf.subarray(Math.max(0, buf.length - GCODE_EDGE_BYTES)).toString('utf8');
    return head + '\n' + tail;
  }

  let entries;
  try {
    entries = zipReader.listEntries(buf);
  } catch (e) {
    throw new SliceError('Could not read the slicer output archive.', {
      code: 'NO_OUTPUT',
      detail: e.message,
    });
  }

  const gcodeEntries = entries
    .filter((e) => /\.gcode$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (gcodeEntries.length === 0) {
    throw new SliceError(
      'The slicer produced no G-code for this model. It may be empty, non-manifold, or outside the build volume.',
      { code: 'NO_GCODE', detail: entries.map((e) => e.name).join(', ') }
    );
  }

  // Lowest-numbered plate, for deterministic results across runs.
  const target = gcodeEntries[0];

  let ends;
  try {
    ends = await zipReader.readEntryEnds(
      buf, target, GCODE_EDGE_BYTES, GCODE_EDGE_BYTES, MAX_GCODE_BYTES
    );
  } catch (e) {
    if (e.code === 'TOO_LARGE') {
      throw new SliceError(
        'The sliced result is too large to process. Try a smaller or simpler model.',
        { code: 'GCODE_TOO_LARGE', detail: `${target.name} (${e.totalBytes}+ bytes)` }
      );
    }
    throw new SliceError('Could not read the sliced G-code.', {
      code: 'NO_OUTPUT',
      detail: e.message,
    });
  }

  return ends.head.toString('utf8') + '\n' + ends.tail.toString('utf8');
}

/**
 * Slicer return codes we can say something useful about.
 *
 * Anything not listed keeps the slicer's own wording, which is better than a
 * generic failure even when it is phrased for the GUI.
 */
const SLICER_RESULT_CODES = {
  '-50': {
    code: 'EXCEEDS_BED',
    message: 'This model is too large for the print plate. It has to fit inside ' +
      '256 × 256 × 256 mm — scale it down and try again.',
  },
  '-1': {
    code: 'SLICE_FAILED',
    message: 'The slicer could not process this model. It may have holes or ' +
      'self-intersecting surfaces — try repairing the mesh and uploading again.',
  },
};

/**
 * Reads the CLI's own result.json, which carries the real reason a slice
 * failed.
 *
 * This matters most on Windows, where orca-slicer.exe is a GUI-subsystem
 * binary and writes nothing to a console at all — so stdout and stderr come
 * back empty and the customer gets "the slicer failed to process this model"
 * with no reason attached. result.json is the only channel that says, for
 * example, "no object fully inside the plate".
 */
async function readSlicerResult(workDir) {
  try {
    const raw = await fs.readFile(path.join(workDir, 'result.json'), 'utf8');
    const json = JSON.parse(raw);
    return {
      message: typeof json.error_string === 'string' ? json.error_string.trim() : '',
      returnCode: json.return_code,
    };
  } catch {
    return null;
  }
}

// Each material slices with its own filament profile. ASA is 1.05 g/cm3
// against PLA's 1.26 and prints 50C hotter, so quoting one from the other's
// slice is wrong in grams before pricing is even applied.
const FILAMENT_PROFILES = {
  PLA: 'pla_basic.json',
  ASA: 'asa_basic.json',
};

function profilePaths(material = 'PLA') {
  // Each engine reads the set built for it; see build-profiles.js.
  const dir = ENGINES[resolveSlicer().engine].profileDir;
  const machine = process.env.MACHINE_PROFILE || path.join(dir, 'p2s_machine.json');
  const process_ = process.env.PROCESS_PROFILE || path.join(dir, 'p2s_process.json');
  const file = FILAMENT_PROFILES[material] || FILAMENT_PROFILES.PLA;
  const filament = process.env.FILAMENT_PROFILE || path.join(dir, file);
  return { machine, process: process_, filament };
}

async function assertProfilesExist(material) {
  const p = profilePaths(material);
  for (const [name, file] of Object.entries(p)) {
    try {
      await fs.access(file);
    } catch {
      throw new SliceError(
        `Missing the ${name} profile. Build the profiles before slicing — see server/README.md.`,
        { code: 'PROFILE_MISSING', detail: file }
      );
    }
  }
  return p;
}

/**
 * True when this upload is a Bambu Studio project rather than a bare mesh.
 *
 * A project carries Metadata/project_settings.config — the whole configuration
 * the customer set up: which filaments are loaded and in what colors, the prime
 * tower, the flush volumes, their support choices, their infill. Slicing it with
 * OUR profile would answer a different question than the one they asked.
 */
async function isBambuProject(modelPath) {
  try {
    const buf = await fs.readFile(modelPath);
    if (!zipReader.isZip(buf)) return false;
    return zipReader.listEntries(buf)
      .some((e) => /project_settings\.config$/i.test(e.name));
  } catch {
    return false;
  }
}

/* ======================================================= painted models == */

/*
 * A multi-colour model carries its colour assignment inside the .3mf, as a
 * per-triangle attribute. Two slicers, two names for it:
 *
 *   PrusaSlicer   slic3rpe:mmu_segmentation
 *   OrcaSlicer    paint_color
 *
 * OrcaSlicer knows both names but its command line drops the PrusaSlicer one on
 * import, and a model loaded with a single filament has nowhere to put colours
 * two and up anyway. Either way the paint is discarded in silence: the slice
 * succeeds, and it quotes the model as if it were one colour.
 *
 * That is not a rounding error. Where two colours meet, the slicer lays a solid
 * interface, and each colour region needs its own perimeter loops. On a painted
 * figurine measured against Bambu Studio, honouring the paint moved the model
 * from 19.57 g to 23.51 g against Bambu's 23.82 g - the difference between 18%
 * under and 1.3% under.
 */
const PAINT_ATTR_SOURCE = 'slic3rpe:mmu_segmentation';
const PAINT_ATTR_TARGET = 'paint_color';

// Bambu's AMS addresses 16 filaments; nothing sane paints more.
const MAX_PAINT_FILAMENTS = 16;

/** Model files inside a .3mf, where the per-triangle paint attributes live. */
const MODEL_ENTRY = /(^|\/)3D\/.*\.model$/i;

/**
 * Reads how many filaments a project's own configuration declares.
 *
 * Counting the distinct paint codes would mean decoding the subdivision
 * encoding; the config states the answer outright, in whichever slicer's
 * dialect the file was written.
 */
function declaredFilamentCount(entries, buf) {
  const read = (re) => {
    const e = entries.find((x) => re.test(x.name));
    if (!e) return null;
    try { return zipReader.readEntry(buf, e).toString('utf8'); } catch { return null; }
  };

  // Bambu / Orca project.
  const bambu = read(/project_settings\.config$/i);
  if (bambu) {
    try {
      const json = JSON.parse(bambu);
      const ids = json.filament_settings_id || json.filament_colour;
      if (Array.isArray(ids) && ids.length) return ids.length;
    } catch { /* fall through */ }
  }

  // PrusaSlicer project: per-filament settings are comma-separated lists.
  const prusa = read(/Slic3r_PE\.config$/i);
  if (prusa) {
    const m = /^;\s*filament_diameter\s*=\s*(.+)$/m.exec(prusa);
    if (m) {
      const n = m[1].split(',').length;
      if (n > 0) return n;
    }
  }
  return null;
}

/**
 * Reports whether an upload is painted, and with how many filaments.
 *
 * @returns {Promise<{painted: boolean, needsConversion: boolean, colorCount: number}>}
 */
async function inspectPaint(modelPath) {
  const none = { painted: false, needsConversion: false, colorCount: 1 };
  let buf;
  try {
    buf = await fs.readFile(modelPath);
  } catch {
    return none;
  }
  if (!zipReader.isZip(buf)) return none;

  let entries;
  try { entries = zipReader.listEntries(buf); } catch { return none; }

  let painted = false;
  let needsConversion = false;
  for (const entry of entries.filter((e) => MODEL_ENTRY.test(e.name))) {
    let text;
    try { text = zipReader.readEntry(buf, entry).toString('utf8'); } catch { continue; }
    if (text.includes(PAINT_ATTR_SOURCE)) { painted = true; needsConversion = true; break; }
    if (text.includes(PAINT_ATTR_TARGET + '=')) { painted = true; break; }
  }
  if (!painted) return none;

  const declared = declaredFilamentCount(entries, buf);
  const colorCount = Math.min(Math.max(declared || 4, 2), MAX_PAINT_FILAMENTS);
  return { painted, needsConversion, colorCount };
}

/**
 * Rewrites a .3mf so the slicer sees the paint under the name it reads.
 *
 * Only the attribute name changes; the encoded value is the same scheme in both
 * slicers, and every other entry is copied through byte for byte.
 */
async function convertPaintAttributes(modelPath, workDir) {
  const buf = await fs.readFile(modelPath);
  const entries = zipReader.listEntries(buf);

  const out = [];
  for (const entry of entries) {
    let data = zipReader.readEntry(buf, entry);
    if (MODEL_ENTRY.test(entry.name)) {
      const text = data.toString('utf8');
      if (text.includes(PAINT_ATTR_SOURCE)) {
        data = Buffer.from(
          text.split(PAINT_ATTR_SOURCE + '=').join(PAINT_ATTR_TARGET + '='), 'utf8');
      }
    }
    out.push({ name: entry.name, data });
  }

  const dest = path.join(workDir, 'painted.3mf');
  await fs.writeFile(dest, writeZip(out));
  return dest;
}

/**
 * Writes one filament profile per colour.
 *
 * The customer picks a material, not a palette, so every colour is the same
 * filament; they differ only by colour so the slicer keeps them apart. Grams
 * are what we price, and those do not depend on which colour went where.
 */
async function writePaintFilaments(filamentProfile, count, workDir) {
  const raw = await fs.readFile(filamentProfile, 'utf8');
  const base = JSON.parse(raw);
  const paths = [];
  for (let i = 0; i < count; i++) {
    const copy = { ...base };
    copy.name = `${base.name} c${i + 1}`;
    if (base.setting_id) copy.setting_id = `${base.setting_id}_c${i + 1}`;
    // Distinct colours only so the slicer treats them as separate filaments.
    const hue = Math.round((360 / count) * i);
    copy.filament_colour = [hslHex(hue)];
    const file = path.join(workDir, `filament_${i + 1}.json`);
    await fs.writeFile(file, JSON.stringify(copy, null, 2));
    paths.push(file);
  }
  return paths;
}

/*
 * How much filament one colour change wastes, in mm3.
 *
 * Left to itself the slicer derives a flush volume per colour pair from the
 * two colours, which is right in a GUI where the operator has chosen real
 * colours and wrong here: the colours we assign are placeholders, so the
 * matrix it computes is a number about nothing. A flat value is both more
 * honest and more accurate.
 *
 * 280 mm3 is Bambu Studio's stock figure for PLA, and it is what the shop's
 * own slices come out at: 346.85 g of purge over 996 changes on the painted
 * figurine is 276 mm3 a change. Slicing the same model with a flat 280 gives
 * 346.24 g against that 346.85 g.
 */
const FLUSH_VOLUME_MM3 = 280;

/**
 * Writes a process profile carrying a flush matrix the size of the palette.
 *
 * The matrix has one entry per ordered pair of filaments, so its size depends
 * on how many colours this particular model uses and it cannot live in the
 * profile on disk.
 */
async function writePaintProcess(processProfile, count, workDir) {
  const base = JSON.parse(await fs.readFile(processProfile, 'utf8'));
  const matrix = [];
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < count; j++) {
      matrix.push(i === j ? '0' : String(FLUSH_VOLUME_MM3));
    }
  }
  base.flush_volumes_matrix = matrix;
  const file = path.join(workDir, 'process_painted.json');
  await fs.writeFile(file, JSON.stringify(base, null, 2));
  return file;
}

/** Evenly spaced, fully saturated colours - only their distinctness matters. */
function hslHex(hue) {
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    const v = 0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * v).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Totals filament per component by streaming the plate G-code once.
 *
 * Bambu tags every run of extrusion with `; FEATURE: <role>` and prints in
 * relative-E mode, so summing E between those markers reproduces the same
 * Model / Support / Purged / Tower split a slicer GUI shows — it is the
 * same data the GUI reads.
 *
 * Two things this has to get right, both found the hard way against a slice
 * whose header reported 30.00g:
 *   - a bare `G1 E0.8` is a deretraction priming the nozzle, not material, and
 *     support is full of them. Counting those gave 43.17g, 44% over.
 *   - G2/G3 arcs are extrusion too. This slice had 70,498 of them and support is
 *     almost entirely arcs; skipping them gave 19.07g, 36% under.
 * With both handled it returns 30.05g — 0.17% out.
 *
 * Streams rather than buffers: plate G-code runs to hundreds of megabytes and
 * only running sums are kept.
 */
async function scanBreakdown(buf, entry, density, diameter) {
  const scan = new FeatureScanner();
  try {
    await zipReader.streamEntry(
      buf, entry, (chunk) => scan.push(chunk.toString('utf8')), MAX_GCODE_BYTES
    );
  } catch {
    return null;          // a breakdown is a bonus; never fail a quote over it
  }
  scan.end();
  return scan.grams(density, diameter);
}

/**
 * The density the slice was actually computed with, from the project's own
 * filament settings, weighted by how much of each filament the print uses.
 *
 * Assuming one figure is close but not free: this project mixes a 1.24 g/cm3
 * generic PLA with a 1.26 Bambu PLA Basic, and pricing the whole print at 1.26
 * read 1.5% heavy across every component.
 */
function projectDensity(entries, buf, filaments) {
  const entry = entries.find((e) => /project_settings\.config$/i.test(e.name));
  if (!entry) return null;
  let densities;
  try {
    densities = JSON.parse(zipReader.readEntry(buf, entry).toString('utf8')).filament_density;
  } catch { return null; }
  if (!Array.isArray(densities) || !densities.length) return null;

  let grams = 0;
  let weighted = 0;
  for (const f of filaments) {
    const d = parseFloat(densities[Number(f.id) - 1]);
    if (!Number.isFinite(d) || d <= 0) continue;
    weighted += d * f.grams;
    grams += f.grams;
  }
  if (grams <= 0) return null;
  return weighted / grams;
}

/**
 * Reads the numbers Bambu Studio already computed, out of a sliced project.
 *
 * A .3mf that has been sliced carries Metadata/slice_info.config, and in it one
 * row per filament with the grams that filament actually consumed:
 *
 *     <filament id="1" type="PLA" used_m="16.42" used_g="134.15" .../>
 *
 * That figure is everything that filament extruded - model, support, purge and
 * prime tower - so summing the rows reproduces Bambu's own Total exactly.
 *
 * WHY THIS MATTERS
 *   We cannot slice a multicolor job ourselves. Loading four filament profiles
 *   works, but an uploaded mesh carries no instruction about which filament goes
 *   where, so the slicer uses the first one and never changes: no purge, no
 *   tower. Where the colors go is a decision made in Bambu Studio, not data in
 *   the file. When the customer has already made that decision and sliced it,
 *   their project holds the real answer - and reading it beats any estimate we
 *   could compute.
 *
 * @returns {Promise<null|{grams:number, filaments:Array, source:string}>}
 */
async function readEmbeddedSliceInfo(modelPath) {
  let buf;
  try {
    buf = await fs.readFile(modelPath);
  } catch {
    return null;
  }
  if (!zipReader.isZip(buf)) return null;

  let entry;
  try {
    entry = zipReader.listEntries(buf)
      .find((e) => /(^|\/)slice_info\.config$/i.test(e.name));
  } catch {
    return null;
  }
  if (!entry) return null;

  let text;
  try {
    text = zipReader.readEntry(buf, entry).toString('utf8');
  } catch {
    return null;
  }

  const filaments = [];
  for (const m of text.matchAll(/<filament\s+([^>]*)\/>/g)) {
    const attrs = m[1];
    const grams = parseFloat((/used_g="([^"]*)"/.exec(attrs) || [])[1]);
    if (!Number.isFinite(grams) || grams <= 0) continue;
    filaments.push({
      id: (/\bid="([^"]*)"/.exec(attrs) || [])[1] || String(filaments.length + 1),
      type: (/\btype="([^"]*)"/.exec(attrs) || [])[1] || null,
      color: (/\bcolor="([^"]*)"/.exec(attrs) || [])[1] || null,
      grams,
    });
  }
  if (filaments.length === 0) return null;

  const grams = filaments.reduce((sum, f) => sum + f.grams, 0);
  const seconds = parseFloat((/key="prediction" value="([^"]*)"/.exec(text) || [])[1]);

  // A sliced project ships its own plate G-code, so the same feature scan gives
  // the real Model / Support / Purged / Tower split for a multicolour job — one
  // we could never slice ourselves, because the filament layout only exists
  // inside Bambu Studio.
  let breakdown = null;
  try {
    const gentry = zipReader.listEntries(buf)
      .filter((e) => /\.gcode$/i.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name))[0];
    if (gentry) {
      const density = projectDensity(zipReader.listEntries(buf), buf, filaments) || DEFAULT_DENSITY;
      breakdown = await scanBreakdown(buf, gentry, density, DEFAULT_DIAMETER);
    }
  } catch { /* the per-filament totals still stand on their own */ }

  return {
    grams: Math.round(grams * 100) / 100,
    filaments,
    timeSeconds: Number.isFinite(seconds) ? seconds : null,
    breakdown,
    source: 'bambu_project',
  };
}

/**
 * Slices a model file and returns real material usage.
 *
 * @param {string} modelPath  absolute path to .stl / .3mf / .obj
 * @param {object} opts
 * @param {number} [opts.fallbackDensity]
 * @returns {Promise<object>} parsed stats plus raw slicer output
 */
async function sliceModel(modelPath, opts = {}) {
  const refused = engineRefused();
  if (refused) {
    throw new SliceError(
      'Exact pricing is temporarily unavailable. Please try again shortly.',
      { code: 'ENGINE_UNAVAILABLE', detail: refused }
    );
  }
  const profiles = await assertProfilesExist(opts.material);
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibes-slice-'));
  const outputPath = path.join(workDir, 'output.gcode.3mf');

  /*
   * A Bambu project is sliced with its own embedded configuration, not ours.
   *
   * That is the only way to reproduce a multicolor job: the filament layout
   * lives in the project, and overriding it with a single-filament profile
   * throws away every gram of purge and prime tower — on one real 4-color model
   * that was 146g of 214g, two thirds of the print.
   */
  const useProjectSettings = await isBambuProject(modelPath);

  /*
   * A painted model has to be sliced with one filament per colour, or the
   * paint is ignored and the model quotes as if it were a single colour.
   * A Bambu project already carries its own filament list, so this only
   * applies to the meshes we slice with our profiles.
   */
  const paint = useProjectSettings
    ? { painted: false, needsConversion: false, colorCount: 1 }
    : await inspectPaint(modelPath);

  try {
    let sliceInput = modelPath;
    if (paint.painted && paint.needsConversion) {
      sliceInput = await convertPaintAttributes(modelPath, workDir);
    }

    const filaments = paint.painted
      ? await writePaintFilaments(profiles.filament, paint.colorCount, workDir)
      : [profiles.filament];

    const processProfile = paint.painted
      ? await writePaintProcess(profiles.process, paint.colorCount, workDir)
      : profiles.process;

    const args = useProjectSettings ? [] : [
      '--load-settings', `${profiles.machine};${processProfile}`,
      '--load-filaments', filaments.join(';'),
      // Place the part on the plate. Note we deliberately do NOT pass
      // --orient: the customer already chose an orientation in the viewer,
      // and letting the slicer re-orient would silently quote a different
      // print than the one they approved.
    ];

    // A project already has its objects placed on the plate; re-arranging one
    // moves the print the customer approved.
    if (!useProjectSettings) args.push('--arrange', '1');
    args.push('--slice', '0', '--debug', '2', '--export-3mf', outputPath, sliceInput);

    let stdout = '';
    let stderr = '';
    try {
      ({ stdout, stderr } = await run(resolveSlicerBin(), args, {
        timeout: SLICE_TIMEOUT_MS,
        cwd: workDir,
      }));
    } catch (err) {
      // The CLI drops the actual reason into result.json in its working
      // directory. Prefer it over the generic message: it is the difference
      // between "the slicer failed" and "your model is bigger than the plate".
      const result = await readSlicerResult(workDir);
      if (err instanceof SliceError && result && result.message) {
        // The slicer's own wording is written for someone sitting in the
        // slicer's GUI — it talks about plates and .3mf projects, neither
        // of which a customer uploading an STL has any idea about. Translate
        // the codes we understand and keep the raw text in `detail` for us.
        const known = SLICER_RESULT_CODES[result.returnCode];
        err.code = known ? known.code : err.code;
        err.message = known ? known.message : result.message;
        err.detail = `return_code ${result.returnCode}: ${result.message}` +
          (err.detail ? ` · ${err.detail}` : '');
      }
      throw err;
    }

    let gcode;
    try {
      gcode = await extractGcode(outputPath);
    } catch (e) {
      if (e instanceof SliceError) {
        e.detail = e.detail || (stderr || stdout || '').slice(-4000);
        throw e;
      }
      throw new SliceError('The slicer did not produce a readable result.', {
        code: 'NO_OUTPUT',
        detail: (stderr || stdout || String(e)).slice(-4000),
      });
    }

    // Only the header carries the summary comments; no need to scan a
    // multi-hundred-megabyte toolpath body.
    const head = gcode.slice(0, 65536);
    const tail = gcode.slice(-65536);
    const stats = parseGcodeStats(head + '\n' + tail, {
      fallbackDensity: opts.fallbackDensity,
    });

    // A second, streaming pass over the same output splits that one weight into
    // the components the shop actually pays for.
    try {
      const outBuf = await fs.readFile(outputPath);
      if (zipReader.isZip(outBuf)) {
        const entry = zipReader.listEntries(outBuf)
          .filter((e) => /\.gcode$/i.test(e.name))
          .sort((a, b) => a.name.localeCompare(b.name))[0];
        if (entry) {
          stats.breakdown = await scanBreakdown(outBuf, entry, stats.density, stats.diameter);
        }
      }
    } catch { /* the total is still good without the split */ }

    if (stats.weightGrams === null || !(stats.weightGrams > 0)) {
      throw new SliceError(
        'Sliced successfully but could not determine filament usage.',
        { code: 'NO_WEIGHT', detail: head.slice(0, 2000) }
      );
    }

    stats.usedProjectSettings = useProjectSettings;
    stats.painted = paint.painted;
    if (paint.painted) stats.colorCount = paint.colorCount;

    /*
     * On a multi-filament plate the G-code header's `total filament weight`
     * only covers the first filament - 155.52g of a 228.54g print on one real
     * 4-color model. The per-filament rows in the output's own
     * slice_info.config are the complete figure, so prefer them.
     */
    try {
      const info = await readEmbeddedSliceInfo(outputPath);
      if (info && info.grams > (stats.weightGrams || 0)) {
        stats.weightGrams = info.grams;
        stats.filaments = info.filaments;
      }
    } catch { /* the header figure still stands */ }

    return stats;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function slicerAvailable() {
  try {
    await run(resolveSlicerBin(), ['--help'], { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reports what's set up and what isn't, so the launcher can print actionable
 * guidance at startup instead of failing on the first customer request.
 */
async function diagnostics() {
  const engine = resolveSlicer();
  const bin = engine.bin;
  const slicerVendored = engine.vendored;
  const slicerFound = await slicerAvailable();
  const refused = engineRefused();

  const paths = profilePaths();
  const dir = ENGINES[engine.engine].profileDir;
  // Report each material's filament profile, so a missing ASA export shows up
  // at startup rather than on the first ASA order.
  for (const [material, file] of Object.entries(FILAMENT_PROFILES)) {
    paths['filament:' + material] = path.join(dir, file);
  }
  delete paths.filament;

  const profiles = {};
  for (const [name, file] of Object.entries(paths)) {
    try {
      await fs.access(file);
      const raw = await fs.readFile(file, 'utf8');
      let hasDensity = null;
      if (name.startsWith('filament')) {
        try {
          const json = JSON.parse(raw);
          const d = json.filament_density;
          hasDensity = Array.isArray(d)
            ? d.some((v) => parseFloat(v) > 0)
            : parseFloat(d) > 0;
        } catch { hasDensity = false; }
      }
      profiles[name] = { path: file, present: true, hasDensity };
    } catch {
      profiles[name] = { path: file, present: false, hasDensity: null };
    }
  }

  const missingProfiles = Object.entries(profiles)
    .filter(([, v]) => !v.present)
    .map(([k]) => k);

  return {
    slicerBin: bin,
    slicerEngine: engine.engine,
    slicerLabel: engine.label,
    slicerFound,
    slicerVendored,
    engineRefused: refused,
    profiles,
    missingProfiles,
    ready: slicerFound && missingProfiles.length === 0 && !refused,
  };
}

module.exports = {
  sliceModel,
  readEmbeddedSliceInfo,
  slicerAvailable,
  diagnostics,
  resolveSlicerBin,
  resolveSlicer,
  usingVendoredSlicer,
  engineRefused,
  inspectPaint,
  convertPaintAttributes,
  SliceError,
  profilePaths,
};
