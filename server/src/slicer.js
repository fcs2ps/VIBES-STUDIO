'use strict';

const { execFile } = require('child_process');
const { promises: fs } = require('fs');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const zipReader = require('./zip');
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

// A copy of Bambu Studio that `setup.js` placed inside this folder. When it is
// there, the app has no external dependencies at all — which is the whole point
// of vendoring — so it is checked before anything installed on the machine.
const VENDOR_DIR = path.join(__dirname, '..', '..', 'vendor');

/**
 * Reads the vendored slicer's path out of vendor/MANIFEST.json.
 *
 * The manifest records where setup.js actually put the binary, which differs by
 * platform (a bare .exe, an .app bundle, an .AppImage). Reading it beats
 * re-deriving the layout here and drifting out of step with setup.js.
 */
function vendoredBin() {
  try {
    const manifest = JSON.parse(fsSync.readFileSync(path.join(VENDOR_DIR, 'MANIFEST.json'), 'utf8'));
    const bin = path.join(VENDOR_DIR, manifest.bambuStudio.bin);
    fsSync.accessSync(bin, fsSync.constants.X_OK);
    return bin;
  } catch {
    return null;
  }
}

/**
 * Locates the Bambu Studio executable.
 *
 * Order: an explicit BAMBU_STUDIO_BIN, then the vendored copy, then the
 * standard install locations. The vendored copy beats an installed one so that
 * a folder carrying its own slicer does not quietly switch to a different
 * version that happens to be on the machine — different version, different
 * numbers, and nothing on screen would say so.
 */
const CANDIDATE_PATHS = [
  // macOS
  '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio',
  '/Applications/Bambu Studio.app/Contents/MacOS/BambuStudio',
  `${os.homedir()}/Applications/BambuStudio.app/Contents/MacOS/BambuStudio`,
  // Windows
  'C:\\Program Files\\Bambu Studio\\bambu-studio.exe',
  'C:\\Program Files (x86)\\Bambu Studio\\bambu-studio.exe',
  `${os.homedir()}\\AppData\\Local\\Programs\\Bambu Studio\\bambu-studio.exe`,
  // Linux (Docker image installs this wrapper)
  '/usr/local/bin/bambu-studio',
  '/opt/bambu-studio/AppRun',
  `${os.homedir()}/Applications/BambuStudio.AppImage`,
  `${os.homedir()}/.local/bin/bambu-studio`,
];

let resolvedBin = null;
let resolvedFromVendor = false;

function resolveBambuBin() {
  if (resolvedBin) return resolvedBin;

  if (process.env.BAMBU_STUDIO_BIN) {
    resolvedBin = process.env.BAMBU_STUDIO_BIN;
    return resolvedBin;
  }

  const vendored = vendoredBin();
  if (vendored) {
    resolvedBin = vendored;
    resolvedFromVendor = true;
    return resolvedBin;
  }

  // Used by setup.js's post-install check: without it, a trim that broke the
  // vendored copy would fall through to a system install and report a pass the
  // shipped folder cannot reproduce.
  if (process.env.VENDOR_ONLY === '1') {
    resolvedBin = path.join(VENDOR_DIR, 'bambu-studio', '(not vendored)');
    return resolvedBin;
  }

  for (const candidate of CANDIDATE_PATHS) {
    try {
      fsSync.accessSync(candidate, fsSync.constants.X_OK);
      resolvedBin = candidate;
      return resolvedBin;
    } catch { /* keep looking */ }
  }

  // Last resort: hope it's on PATH.
  resolvedBin = 'bambu-studio';
  return resolvedBin;
}

/** True once resolveBambuBin() has settled on the copy inside vendor/. */
function usingVendoredSlicer() {
  resolveBambuBin();
  return resolvedFromVendor;
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
      // Bambu Studio is a GUI app running headless; without these it can try
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
 * This matters most on Windows, where bambu-studio.exe is a GUI-subsystem
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
  const machine = process.env.MACHINE_PROFILE || path.join(PROFILE_DIR, 'p2s_machine.json');
  const process_ = process.env.PROCESS_PROFILE || path.join(PROFILE_DIR, 'p2s_process.json');
  const file = FILAMENT_PROFILES[material] || FILAMENT_PROFILES.PLA;
  const filament = process.env.FILAMENT_PROFILE || path.join(PROFILE_DIR, file);
  return { machine, process: process_, filament };
}

async function assertProfilesExist(material) {
  const p = profilePaths(material);
  for (const [name, file] of Object.entries(p)) {
    try {
      await fs.access(file);
    } catch {
      throw new SliceError(
        `Missing the ${name} profile. Export real profiles from Bambu Studio before slicing — see server/README.md.`,
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

/**
 * Totals filament per component by streaming the plate G-code once.
 *
 * Bambu tags every run of extrusion with `; FEATURE: <role>` and prints in
 * relative-E mode, so summing E between those markers reproduces the same
 * Model / Support / Purged / Tower split the Bambu Studio GUI shows — it is the
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
      breakdown = await scanBreakdown(buf, gentry, DEFAULT_DENSITY, DEFAULT_DIAMETER);
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

  try {
    const args = useProjectSettings ? [] : [
      '--load-settings', `${profiles.machine};${profiles.process}`,
      '--load-filaments', profiles.filament,
      // Place the part on the plate. Note we deliberately do NOT pass
      // --orient: the customer already chose an orientation in the viewer,
      // and letting the slicer re-orient would silently quote a different
      // print than the one they approved.
    ];

    // A project already has its objects placed on the plate; re-arranging one
    // moves the print the customer approved.
    if (!useProjectSettings) args.push('--arrange', '1');
    args.push('--slice', '0', '--debug', '2', '--export-3mf', outputPath, modelPath);

    let stdout = '';
    let stderr = '';
    try {
      ({ stdout, stderr } = await run(resolveBambuBin(), args, {
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
        // Bambu Studio GUI — it talks about plates and .3mf projects, neither
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
    await run(resolveBambuBin(), ['--help'], { timeout: 15000 });
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
  const bin = resolveBambuBin();
  const slicerVendored = usingVendoredSlicer();
  const slicerFound = await slicerAvailable();

  const paths = profilePaths();
  // Report each material's filament profile, so a missing ASA export shows up
  // at startup rather than on the first ASA order.
  for (const [material, file] of Object.entries(FILAMENT_PROFILES)) {
    paths['filament:' + material] = path.join(PROFILE_DIR, file);
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
    slicerFound,
    slicerVendored,
    profiles,
    missingProfiles,
    ready: slicerFound && missingProfiles.length === 0,
  };
}

module.exports = {
  sliceModel,
  readEmbeddedSliceInfo,
  slicerAvailable,
  diagnostics,
  resolveBambuBin,
  usingVendoredSlicer,
  SliceError,
  profilePaths,
};
