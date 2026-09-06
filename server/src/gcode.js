'use strict';

/**
 * Parses the summary comments Bambu Studio / OrcaSlicer / PrusaSlicer append
 * to generated G-code.
 *
 * These slicers all descend from Slic3r, so they share a comment vocabulary,
 * but the exact spelling drifts between versions and forks. Rather than
 * matching one rigid string, each field below tries several known spellings.
 *
 * IMPORTANT — the zero-grams trap:
 *   Bambu Studio only emits a non-zero `total filament used [g]` when the
 *   loaded filament profile actually carries a `filament_density` (and it
 *   reports cost only with `filament_cost`). With a stripped or hand-rolled
 *   profile it happily prints `= 0.00` and slices fine otherwise. Quoting
 *   from that value directly would hand the customer a free print.
 *
 *   So weight is resolved in priority order:
 *     1. reported grams, but only if > 0
 *     2. volume (cm3) x density
 *     3. length (mm) x filament cross-section x density
 *   and the result records which path was used, so the API can flag a
 *   misconfigured profile instead of silently under-quoting.
 */

const PATTERNS = {
  weightGrams: [
    /^;\s*total filament used \[g\]\s*[=:]\s*([0-9.]+)/im,
    /^;\s*total filament weight \[g\]\s*[=:]\s*([0-9.]+)/im,
    /^;\s*filament used \[g\]\s*[=:]\s*([0-9.]+)/im,
  ],
  volumeCm3: [
    /^;\s*total filament used \[cm3\]\s*[=:]\s*([0-9.]+)/im,
    /^;\s*filament used \[cm3\]\s*[=:]\s*([0-9.]+)/im,
    /^;\s*filament used \[cm\^3\]\s*[=:]\s*([0-9.]+)/im,
  ],
  lengthMm: [
    /^;\s*total filament used \[mm\]\s*[=:]\s*([0-9.]+)/im,
    /^;\s*filament used \[mm\]\s*[=:]\s*([0-9.]+)/im,
  ],
  // Bambu puts BOTH durations on one line:
  //   "; model printing time: 2h 56m 9s; total estimated time: 2h 56m 29s"
  // so these must match mid-line (the line does not start with "total
  // estimated time"), and each capture must stop at the ";" that begins the
  // next field. Capturing to end-of-line instead swallowed the second
  // duration, and parseDuration then summed the two into a print time almost
  // exactly twice the real one.
  // Bambu puts BOTH durations on a single line:
  //   "; model printing time: 2h 56m 9s; total estimated time: 2h 56m 29s"
  // so these must match mid-line (that line does not start with "total
  // estimated time"), and each capture has to stop at the ";" that begins the
  // next field. Capturing to end-of-line instead swallowed the second duration,
  // and parseDuration then summed the two into a print time almost exactly
  // twice the real one.
  timeSeconds: [
    /total estimated time\s*[=:]\s*([^;\n]+)/i,
    /estimated printing time \(normal mode\)\s*[=:]\s*([^;\n]+)/i,
    /model printing time\s*[=:]\s*([^;\n]+)/i,
  ],
  filamentDensity: [
    /^;\s*filament_density\s*[=:]\s*([0-9.]+)/im,
  ],
  layerCount: [
    /^;\s*total layer number:\s*([0-9]+)/im,
  ],
  filamentDiameter: [
    /^;\s*filament_diameter\s*[=:]\s*([0-9.]+)/im,
  ],
};

function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

function firstNumber(text, patterns) {
  const raw = firstMatch(text, patterns);
  if (raw === null) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/** "1d 12h 57m 30s" / "2h 36m 25s" / "45m" -> seconds */
function parseDuration(str) {
  if (!str) return null;
  let total = 0;
  let matched = false;
  const units = { d: 86400, h: 3600, m: 60, s: 1 };
  const re = /([0-9.]+)\s*([dhms])/gi;
  let m;
  while ((m = re.exec(str)) !== null) {
    total += parseFloat(m[1]) * units[m[2].toLowerCase()];
    matched = true;
  }
  return matched ? Math.round(total) : null;
}

/**
 * @param {string} gcodeText  full G-code, or just its comment header
 * @param {object} opts
 * @param {number} opts.fallbackDensity   g/cm3, used if the G-code omits it
 * @param {number} opts.fallbackDiameter  mm, used if the G-code omits it
 */
/**
 * Volume purged on a single filament change, in mm3.
 *
 * Bambu writes a full NxN matrix of flush volumes - how much to push through
 * when going from filament i to filament j - as
 *
 *     ; flush_volumes_matrix = 0,280,280,280,280,0,280,...
 *
 * The diagonal is zero (no change), and the off-diagonal entries are the real
 * cost of a color change. This is the number that makes a purge estimate
 * grounded rather than invented: at the P2S's 280mm3 and PLA's 1.26 g/cm3 it
 * is 0.3528 g per change, and a measured 4-color slice reported 112.54 g over
 * 319 changes - 0.3528 g each, exactly.
 */
function parseFlushVolume(text) {
  const m = text.match(/^;\s*flush_volumes_matrix\s*[=:]\s*(.+)$/im);
  if (!m) return null;
  const values = m[1].split(',').map((n) => parseFloat(n)).filter((n) => Number.isFinite(n) && n > 0);
  if (values.length === 0) return null;
  // Off-diagonal entries can differ per filament pair; the typical one is what
  // a mixed job actually pays, so take the median rather than the extreme.
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

function parseGcodeStats(gcodeText, opts = {}) {
  const fallbackDensity = opts.fallbackDensity ?? 1.24;   // PLA
  const fallbackDiameter = opts.fallbackDiameter ?? 1.75; // standard filament

  const density = firstNumber(gcodeText, PATTERNS.filamentDensity) ?? fallbackDensity;
  const diameter = firstNumber(gcodeText, PATTERNS.filamentDiameter) ?? fallbackDiameter;

  const reportedGrams = firstNumber(gcodeText, PATTERNS.weightGrams);
  const volumeCm3 = firstNumber(gcodeText, PATTERNS.volumeCm3);
  const lengthMm = firstNumber(gcodeText, PATTERNS.lengthMm);
  const timeSeconds = parseDuration(firstMatch(gcodeText, PATTERNS.timeSeconds));
  const layerCount = firstNumber(gcodeText, PATTERNS.layerCount);
  const flushVolumeMm3 = parseFlushVolume(gcodeText);

  let weightGrams = null;
  let weightSource = null;

  if (reportedGrams !== null && reportedGrams > 0) {
    weightGrams = reportedGrams;
    weightSource = 'slicer_reported';
  } else if (volumeCm3 !== null && volumeCm3 > 0) {
    weightGrams = volumeCm3 * density;
    weightSource = 'volume_x_density';
  } else if (lengthMm !== null && lengthMm > 0) {
    // Cross-section of the filament strand x length x density.
    // For 1.75mm at 1.24 g/cm3 this reduces to ~0.00298 g per mm.
    const radiusCm = diameter / 2 / 10;
    const areaCm2 = Math.PI * radiusCm * radiusCm;
    weightGrams = areaCm2 * (lengthMm / 10) * density;
    weightSource = 'length_x_area_x_density';
  }

  return {
    weightGrams,
    weightSource,
    reportedGrams,
    volumeCm3,
    lengthMm,
    timeSeconds,
    layerCount,
    flushVolumeMm3,
    density,
    diameter,
    // True when the slicer itself couldn't price the material — a strong
    // signal the filament profile is missing filament_density.
    profileMissingDensity: reportedGrams !== null && reportedGrams === 0,
  };
}


/* ======================================================= per-feature totals */

/*
 * Which of Bambu's extrusion roles counts as what.
 *
 * The slicer annotates every run of extrusion with `; FEATURE: <role>`, and
 * prints in relative-E mode (M83), so the E on each move is filament consumed
 * right there. Totalling E between those markers reproduces exactly the
 * Model / Support / Purged / Tower split the Bambu Studio GUI shows - it is the
 * same data the GUI is reading.
 *
 * Anything unrecognized counts as model, which is the safe direction: an
 * unknown role is far more likely to be some new wall or infill variant than a
 * new kind of waste, and treating waste as model would under-quote.
 */
const FEATURE_CATEGORY = {
  'support': 'support',
  'support interface': 'support',
  'support transition': 'support',
  'prime tower': 'tower',
  'wipe tower': 'tower',
  'flush': 'purge',
  'purge': 'purge',
};

function categorizeFeature(name) {
  const key = String(name || '').trim().toLowerCase();
  return FEATURE_CATEGORY[key] || 'model';
}

/**
 * Totals filament use per component by streaming G-code text through, a chunk
 * at a time, keeping only running sums.
 *
 * Usage:
 *   const scan = new FeatureScanner();
 *   scan.push(chunkOfText);   // any number of times, split anywhere
 *   const grams = scan.grams(density, diameter);
 */
class FeatureScanner {
  constructor() {
    this.partial = '';
    this.current = 'model';
    this.mmByCategory = { model: 0, support: 0, purge: 0, tower: 0 };
    this.inFlush = false;
    this.flushBlocks = 0;
    // Bambu emits M83 (relative E) but tool-change blocks can flip to absolute,
    // so both are tracked rather than assumed.
    this.relative = true;
    this.lastAbsE = 0;
  }

  push(text) {
    const data = this.partial + text;
    const lines = data.split('\n');
    this.partial = lines.pop();          // keep the incomplete tail for next time
    for (const line of lines) this._line(line);
  }

  end() {
    if (this.partial) { this._line(this.partial); this.partial = ''; }
  }

  _line(line) {
    if (line.charCodeAt(0) === 59 /* ; */) {
      const m = /^;\s*FEATURE:\s*(.+)$/.exec(line);
      if (m) { this.current = categorizeFeature(m[1]); return; }

      /*
       * Purge is not executed G-code. On an AMS machine the flush is performed
       * by firmware macros (M620/M621), and the G-code only *annotates* how
       * much, as commented `;VG1 E<n>` lines between VFLUSH_START and
       * VFLUSH_END. Summing executed moves therefore misses every gram of it —
       * on a 319-change print that was 108g, half the job.
       */
      if (line.includes('VFLUSH_START')) { this.inFlush = true; this.flushBlocks++; return; }
      if (line.includes('VFLUSH_END')) { this.inFlush = false; return; }
      if (this.inFlush) {
        const v = /^;VG1\s+E([0-9.]+)/.exec(line.trim());
        if (v) this.mmByCategory.purge += parseFloat(v[1]);
      }
      return;
    }
    if (line.startsWith('M83')) { this.relative = true; return; }
    if (line.startsWith('M82')) { this.relative = false; return; }
    if (line.startsWith('G92')) {
      const e = /E(-?[0-9.]+)/.exec(line);
      if (e) this.lastAbsE = parseFloat(e[1]);
      return;
    }
    // G2/G3 are arc moves. Bambu fits arcs aggressively - this slice had 70,498
    // of them against far fewer straight moves, and support geometry is almost
    // entirely arcs - so ignoring them lost most of the support material.
    if (!/^G[0123] /.test(line)) return;

    // Only a move that travels lays material down. A bare `G1 E0.8 F1800` is a
    // deretraction priming the nozzle after a hop, and support geometry is full
    // of them - one per island, hundreds per print. Counting those more than
    // doubled the support figure and put the total 44% over what the slicer
    // itself reported.
    if (!/[XY]-?[0-9.]/.test(line)) return;

    const e = /\bE(-?[0-9.]+)/.exec(line);
    if (!e) return;
    const value = parseFloat(e[1]);
    if (!Number.isFinite(value)) return;

    if (this.relative) {
      // Retractions are negative and get pushed back out again; only forward
      // extrusion is material laid down.
      if (value > 0) this.mmByCategory[this.current] += value;
    } else {
      const delta = value - this.lastAbsE;
      this.lastAbsE = value;
      if (delta > 0) this.mmByCategory[this.current] += delta;
    }
  }

  /** How many filament changes the print makes - the count Bambu displays. */
  get filamentChanges() { return this.flushBlocks; }

  /** Converts filament length per category into grams. */
  grams(density, diameterMm) {
    const d = diameterMm || 1.75;
    const radiusCm = d / 2 / 10;
    const gramsPerMm = Math.PI * radiusCm * radiusCm * (1 / 10) * (density || 1.24);
    const out = {};
    let total = 0;
    for (const [k, mm] of Object.entries(this.mmByCategory)) {
      const g = mm * gramsPerMm;
      out[k] = Math.round(g * 100) / 100;
      total += g;
    }
    out.total = Math.round(total * 100) / 100;
    return out;
  }
}

module.exports = { parseGcodeStats, parseDuration, parseFlushVolume, FeatureScanner, categorizeFeature };
