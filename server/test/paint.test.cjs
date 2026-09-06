'use strict';
/**
 * Painted multi-colour uploads.
 *
 * A .3mf carries its colour assignment as a per-triangle attribute, and
 * PrusaSlicer and OrcaSlicer disagree about its name. Miss that and the paint
 * is dropped in silence: the slice succeeds and quotes the model as one
 * colour. On a real painted figurine that was 19.57 g against Bambu Studio's
 * 23.82 g — 18% under, with nothing on screen saying so.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeZip } = require('../src/zipwrite');
const zip = require('../src/zip');
const { inspectPaint, convertPaintAttributes } = require('../src/slicer');

let pass = 0, fail = 0;
const checks = [];
function check(name, fn) { checks.push([name, fn]); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibes-paint-test-'));

function make3mf(name, triangleAttr, configEntry) {
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
       xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">
 <resources><object id="1" type="model"><mesh><triangles>
  <triangle v1="0" v2="1" v3="2"${triangleAttr ? ' ' + triangleAttr : ''}/>
 </triangles></mesh></object></resources>
</model>`;
  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
    { name: '3D/3dmodel.model', data: Buffer.from(model, 'utf8') },
  ];
  if (configEntry) entries.push(configEntry);
  const file = path.join(dir, name);
  fs.writeFileSync(file, writeZip(entries));
  return file;
}

const prusaCfg = {
  name: 'Metadata/Slic3r_PE.config',
  data: Buffer.from('; filament_diameter = 1.75,1.75,1.75,1.75,1.75\n', 'utf8'),
};
const bambuCfg = {
  name: 'Metadata/project_settings.config',
  data: Buffer.from(JSON.stringify({ filament_settings_id: ['a', 'b', 'c'] }), 'utf8'),
};

check('a plain unpainted model is not treated as painted', async () => {
  const r = await inspectPaint(make3mf('plain.3mf', null));
  assert.strictEqual(r.painted, false);
  assert.strictEqual(r.colorCount, 1);
});

check('an STL is not treated as painted', async () => {
  const f = path.join(dir, 'x.stl');
  fs.writeFileSync(f, 'solid x\nendsolid x\n');
  assert.strictEqual((await inspectPaint(f)).painted, false);
});

check('detects PrusaSlicer paint and flags it for conversion', async () => {
  const r = await inspectPaint(make3mf('prusa.3mf', 'slic3rpe:mmu_segmentation="0C"', prusaCfg));
  assert.strictEqual(r.painted, true);
  assert.strictEqual(r.needsConversion, true);
  assert.strictEqual(r.colorCount, 5, 'filament count comes from the embedded config');
});

check('detects OrcaSlicer paint without converting it', async () => {
  const r = await inspectPaint(make3mf('orca.3mf', 'paint_color="0C"', bambuCfg));
  assert.strictEqual(r.painted, true);
  assert.strictEqual(r.needsConversion, false);
  assert.strictEqual(r.colorCount, 3);
});

check('conversion renames the attribute and keeps everything else', async () => {
  const src = make3mf('conv.3mf', 'slic3rpe:mmu_segmentation="4A"', prusaCfg);
  const out = await convertPaintAttributes(src, dir);
  const buf = fs.readFileSync(out);
  const entries = zip.listEntries(buf);

  const names = entries.map((e) => e.name).sort();
  assert.deepStrictEqual(names,
    ['3D/3dmodel.model', 'Metadata/Slic3r_PE.config', '[Content_Types].xml']);

  const model = zip.readEntry(buf, entries.find((e) => /3dmodel/.test(e.name))).toString('utf8');
  assert.ok(model.includes('paint_color="4A"'), 'attribute renamed');
  assert.ok(!model.includes('mmu_segmentation'), 'old name gone');
  assert.ok(model.includes('v1="0" v2="1" v3="2"'), 'geometry untouched');

  const cfg = zip.readEntry(buf, entries.find((e) => /Slic3r_PE/.test(e.name))).toString('utf8');
  assert.ok(cfg.includes('filament_diameter'), 'other entries copied through');
});

check('the converted file is still readable as a project', async () => {
  const src = make3mf('conv2.3mf', 'slic3rpe:mmu_segmentation="4A"', prusaCfg);
  const out = await convertPaintAttributes(src, dir);
  const again = await inspectPaint(out);
  assert.strictEqual(again.painted, true);
  assert.strictEqual(again.needsConversion, false, 'no longer needs converting');
});

(async () => {
  console.log('\nPainted model tests\n');
  for (const [name, fn] of checks) {
    try { await fn(); console.log('  PASS  ' + name); pass++; }
    catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); fail++; }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
