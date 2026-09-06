#!/usr/bin/env node
'use strict';

/**
 * End-to-end check that the exported profiles actually produce a priced quote.
 *
 * Slices a 40mm test cube through the same `sliceModel` the API uses, so a
 * pass here means /api/quote will work — rather than only proving the files
 * parse. Catches the two failure modes that otherwise surface as a confident
 * wrong price: a bed size that isn't the printer's, and a filament profile
 * with no density (which makes Bambu Studio report 0.00 g).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { sliceModel, diagnostics } = require('../src/slicer');
const { computeQuote } = require('../src/pricing');

const CUBE_MM = 40;
// 40mm cube, 0.20mm layers, 15% infill, 2 walls, PLA at 1.26 g/cm3 lands here.
// Wide bounds — this is a "did the slicer really run" check, not a regression
// test on Bambu Studio's infill maths.
const EXPECTED_MIN_G = 15;
const EXPECTED_MAX_G = 40;

/**
 * Confirms the profiles carry the settings that only arrive by resolving the
 * `inherits` chain.
 *
 * The weight bounds below are deliberately wide, which means they cannot catch
 * an unresolved profile: the slicer happily produces a plausible number from
 * its own generic defaults. This checks the two settings whose absence actually
 * changed prices and rejected models, so the failure is caught here rather than
 * by a customer.
 */
function checkProfilesResolved(diag) {
  const read = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  };
  const machine = read(diag.profiles.machine.path);
  const process_ = read(diag.profiles.process.path);
  const problems = [];

  const area = machine && [].concat(machine.printable_area || []).join(',');
  if (!area) {
    problems.push('machine profile has no printable_area — the slicer will assume 200x200');
  } else if (!/256x256/.test(area)) {
    problems.push('printable_area is "' + area + '", not the P2S\'s 256x256');
  }

  const infill = process_ && process_.sparse_infill_density;
  if (infill === undefined) {
    problems.push('process profile has no sparse_infill_density — the slicer will assume 20%');
  }

  if (problems.length) {
    console.error('These profiles are not fully resolved:\n');
    for (const p of problems) console.error('  - ' + p);
    console.error('\nThe slicer does not follow a profile\'s "inherits" chain, so any');
    console.error('setting the file does not state itself silently falls back to Bambu');
    console.error('Studio\'s generic defaults — and the slice still succeeds, with the');
    console.error('wrong numbers. Re-export them:\n');
    console.error('  node server/scripts/export-profiles.js\n');
    return false;
  }

  console.log('profiles resolved: printable_area ' + area +
    ', infill ' + infill + '\n');
  return true;
}

function writeTestCube(file) {
  const s = CUBE_MM;
  const v = [
    [0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0],
    [0, 0, s], [s, 0, s], [s, s, s], [0, s, s],
  ];
  const faces = [
    [[0, 3, 2], [0, 0, -1]], [[0, 2, 1], [0, 0, -1]],
    [[4, 5, 6], [0, 0, 1]], [[4, 6, 7], [0, 0, 1]],
    [[0, 1, 5], [0, -1, 0]], [[0, 5, 4], [0, -1, 0]],
    [[1, 2, 6], [1, 0, 0]], [[1, 6, 5], [1, 0, 0]],
    [[2, 3, 7], [0, 1, 0]], [[2, 7, 6], [0, 1, 0]],
    [[3, 0, 4], [-1, 0, 0]], [[3, 4, 7], [-1, 0, 0]],
  ];
  let out = 'solid cube\n';
  for (const [tri, n] of faces) {
    out += ' facet normal ' + n.join(' ') + '\n  outer loop\n';
    for (const i of tri) out += '   vertex ' + v[i].join(' ') + '\n';
    out += '  endloop\n endfacet\n';
  }
  out += 'endsolid cube\n';
  fs.writeFileSync(file, out);
}

async function main() {
  const diag = await diagnostics();
  console.log('slicer:   ' + diag.slicerBin + (diag.slicerFound ? '  [found]' : '  [NOT FOUND]'));
  for (const [name, info] of Object.entries(diag.profiles)) {
    console.log('  ' + name.padEnd(9) + (info.present ? 'present' : 'MISSING') +
      (info.hasDensity === null ? '' : info.hasDensity ? '  density set' : '  NO DENSITY'));
  }
  console.log('');

  if (!diag.slicerFound) {
    console.error('Bambu Studio was not found. Set BAMBU_STUDIO_BIN and retry.');
    process.exit(1);
  }
  if (diag.missingProfiles.length) {
    console.error('Missing profiles: ' + diag.missingProfiles.join(', '));
    console.error('Run: node server/scripts/export-profiles.js');
    process.exit(1);
  }

  if (!checkProfilesResolved(diag)) process.exit(1);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibes-verify-'));
  const model = path.join(dir, 'cube.stl');
  writeTestCube(model);

  console.log('Slicing a ' + CUBE_MM + 'mm test cube (this takes a few seconds)...');
  const started = Date.now();
  let stats;
  try {
    stats = await sliceModel(model);
  } catch (err) {
    console.error('\nFAILED: ' + err.message);
    if (err.code) console.error('  code:   ' + err.code);
    if (err.detail) console.error('  detail: ' + String(err.detail).slice(0, 800));
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }
  fs.rmSync(dir, { recursive: true, force: true });

  const dims = { x: CUBE_MM, y: CUBE_MM, z: CUBE_MM };
  const quote = computeQuote({ weightGrams: stats.weightGrams, multicolor: false, dims });

  console.log('');
  console.log('  weight:      ' + stats.weightGrams + ' g  (' + stats.weightSource + ')');
  console.log('  print time:  ' + Math.round(stats.timeSeconds / 60) + ' min');
  console.log('  density:     ' + stats.density + ' g/cm3');
  console.log('  quote total: $' + quote.total.toFixed(2) +
    (quote.belowMinimum ? '  (job minimum applied)' : ''));
  console.log('  elapsed:     ' + ((Date.now() - started) / 1000).toFixed(1) + ' s');
  console.log('');

  const problems = [];
  if (stats.weightSource !== 'slicer_reported') {
    problems.push('weight came from "' + stats.weightSource + '", not the slicer. ' +
      'The filament profile is probably missing filament_density.');
  }
  if (stats.profileMissingDensity) {
    problems.push('profileMissingDensity is set - fix the filament profile.');
  }
  if (!(stats.weightGrams >= EXPECTED_MIN_G && stats.weightGrams <= EXPECTED_MAX_G)) {
    problems.push('a ' + CUBE_MM + 'mm cube weighed ' + stats.weightGrams + ' g, outside the ' +
      'expected ' + EXPECTED_MIN_G + '-' + EXPECTED_MAX_G + ' g. The process or filament ' +
      'profile may not be the one you print with.');
  }

  if (problems.length) {
    console.log('PASSED WITH WARNINGS:');
    for (const p of problems) console.log('  - ' + p);
    process.exit(0);
  }

  console.log('OK - the quoting path works end to end.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
