const assert = require('assert');
const { computeQuote, CONFIG } = require('../src/pricing.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  PASS  ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); fail++; }
}

console.log('\nPricing tests\n');

check('prices at $0.60/gram with no flat fee', () => {
  const q = computeQuote({ weightGrams: 100 });
  assert.strictEqual(q.lines[0].amount, 60.00, 'got ' + q.lines[0].amount);
  assert.strictEqual(q.total, 60.00);
});

check('Big Box regression: 458g slices to $274.80', () => {
  // The model that exposed the old heuristic (estimated 280.6g vs 458g real).
  const q = computeQuote({ weightGrams: 458, dims: { x: 200, y: 200, z: 200 } });
  assert.strictEqual(q.weightGrams, 458);
  const filament = q.lines.find((l) => /^Filament/.test(l.label));
  assert.strictEqual(filament.amount, 274.80, 'got ' + filament.amount);
  assert.strictEqual(q.total, 274.80, 'size alone must not add anything, got ' + q.total);
});

check('enforces the $20 minimum on tiny prints', () => {
  const q = computeQuote({ weightGrams: 2 }); // $1.20 of filament
  assert.strictEqual(q.subtotal, 1.20);
  assert.strictEqual(q.total, CONFIG.minimumCharge);
  assert.strictEqual(q.belowMinimum, true);
});

check('bills each component of the slice at the same rate', () => {
  // The figures a real Bambu slice reported for a 4-filament job.
  const q = computeQuote({
    weightGrams: 214.36,
    material: 'PLA',
    colorCount: 4,
    breakdown: { model: 53.46, support: 14.67, purge: 107.97, tower: 38.26, total: 214.36 },
  });

  const by = (re) => q.lines.find((l) => re.test(l.label));
  assert.strictEqual(by(/^Model/).amount, 32.08, 'model ' + by(/^Model/).amount);
  assert.strictEqual(by(/^Support/).amount, 8.80, 'support ' + by(/^Support/).amount);
  assert.strictEqual(by(/^Purged/).amount, 64.78, 'purge ' + by(/^Purged/).amount);
  assert.strictEqual(by(/^Prime tower/).amount, 22.96, 'tower ' + by(/^Prime tower/).amount);
  assert.strictEqual(q.total, 128.62, 'total ' + q.total);
  assert.strictEqual(q.billableGrams, 214.36);
});

check('a single-color slice has no purge or tower lines', () => {
  const q = computeQuote({
    weightGrams: 31.39,
    colorCount: 1,
    breakdown: { model: 18.07, support: 13.36, purge: 0, tower: 0, total: 31.43 },
  });
  assert.ok(q.lines.some((l) => /^Model/.test(l.label)));
  assert.ok(q.lines.some((l) => /^Support/.test(l.label)));
  assert.ok(!q.lines.some((l) => /Purged|Prime tower/.test(l.label)),
    'nothing was purged, so nothing should be billed for it');
});

check('never bills less than the slicer\'s own total', () => {
  // If the feature scan comes up short of the slicer's figure, the difference
  // is still filament that left the spool - it must not be given away.
  const q = computeQuote({
    weightGrams: 100,
    colorCount: 1,
    breakdown: { model: 60, support: 10, purge: 0, tower: 0, total: 70 },
  });
  assert.strictEqual(q.billableGrams, 100, 'got ' + q.billableGrams);
  assert.strictEqual(q.total, 60.00, 'got ' + q.total);
  assert.ok(q.lines.some((l) => /Other extrusion/.test(l.label)),
    'the unaccounted grams should be visible, not hidden');
});

check('falls back to the plain total when no breakdown was readable', () => {
  const q = computeQuote({ weightGrams: 100, colorCount: 1, breakdown: null });
  assert.strictEqual(q.billableGrams, 100);
  assert.strictEqual(q.total, 60.00);
  assert.strictEqual(q.lines.filter((l) => !l.placeholder).length, 1);
});

check('ASA bills its own rate against the same components', () => {
  const q = computeQuote({
    weightGrams: 50, material: 'ASA', colorCount: 1,
    breakdown: { model: 40, support: 10, purge: 0, tower: 0, total: 50 },
  });
  assert.strictEqual(q.material, 'ASA');
  assert.strictEqual(q.total, round2(50 * 0.81), 'got ' + q.total);
});

function round2(n) { return Math.round(n * 100) / 100; }

check('rejects a zero or negative weight instead of quoting free', () => {
  assert.throws(() => computeQuote({ weightGrams: 0 }));
  assert.throws(() => computeQuote({ weightGrams: -5 }));
  assert.throws(() => computeQuote({ weightGrams: null }));
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
