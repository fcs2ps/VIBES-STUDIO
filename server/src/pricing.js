'use strict';

/**
 * Authoritative pricing. The browser shows a rough preview while the customer
 * scales their model, but the number they are actually charged is computed
 * here, from a real slice — never trusted from the client.
 */

const CONFIG = {
  bed: { width: 256, depth: 256, height: 256 }, // Bambu Lab P2S

  /*
   * Rates are per gram of filament sold, not spool cost. The markup over spool
   * price covers machine time, labour and failed prints.
   *
   * ASA is derived from PLA at the same markup: Bambu's spools are $26.99/kg
   * for ASA against $19.99/kg for PLA, so 0.60 x (26.99 / 19.99) = 0.81. It is
   * also less dense (1.05 vs 1.26 g/cm3), which the slice already accounts for
   * because each material slices with its own filament profile - the same part
   * simply comes out lighter in ASA.
   *
   * Adjust `costPerGram` to whatever you actually charge; nothing else depends
   * on the derivation.
   */
  materials: {
    PLA: { label: 'PLA', density: 1.26, costPerGram: 0.60 },
    ASA: { label: 'ASA', density: 1.05, costPerGram: 0.81 },
  },
  defaultMaterial: 'PLA',

  minimumCharge: 20,
};

/**
 * @param {object} input
 * @param {number} input.weightGrams   real sliced weight - model plus support,
 *                                     straight from the slicer
 * @param {number} input.colorCount    distinct colors the file uses
 * @param {number} input.layerCount    layers, from the slicer
 * @param {number} input.flushVolumeMm3  purge per color change, from the slicer
 * @param {number} input.density       filament density, from the slicer
 */
function computeQuote(input) {
  const {
    weightGrams,
    material,
    colorCount = 1,
    // Grams per component, measured off the G-code by FeatureScanner. When it
    // is absent (an unreadable slice) the total is still billed, just without
    // the itemization.
    breakdown = null,
  } = input;

  if (!Number.isFinite(weightGrams) || weightGrams <= 0) {
    throw new Error('weightGrams must be a positive number');
  }

  const key = CONFIG.materials[material] ? material : CONFIG.defaultMaterial;
  const mat = CONFIG.materials[key];

  // The slice measures one color. A multicolor print of the same geometry
  // consumes several times that in purge and prime tower, so the billable
  // material is the sliced weight scaled up - not the sliced weight plus a
  // percentage on top of the price.
  const multicolor = colorCount > 1;
  const rate = mat.costPerGram;

  /*
   * Every component is filament off the same spool, so every one is billed at
   * the same rate. The lines exist to show where the grams went - which is the
   * difference between a shop that knows its margin and one that eats the
   * purge.
   */
  const parts = breakdown && breakdown.total > 0
    ? [
      ['Model', breakdown.model],
      ['Support', breakdown.support],
      ['Purged (color changes)', breakdown.purge],
      ['Prime tower', breakdown.tower],
    ].filter(([, g]) => g > 0)
    : [['Filament', weightGrams]];

  // The itemized grams should agree with the slicer's own total; if the scan
  // came up short, bill the slicer's figure so nothing is given away.
  const itemized = parts.reduce((sum, [, g]) => sum + g, 0);
  const billableGrams = Math.max(itemized, weightGrams);
  const shortfall = billableGrams - itemized;

  const lines = parts.map(([label, grams]) => ({
    label: `${label} (${grams.toFixed(2)}g @ $${rate.toFixed(2)}/g)`,
    amount: round2(grams * rate),
    surcharge: label !== 'Model' && label !== 'Filament',
  }));

  if (shortfall > 0.01) {
    lines.push({
      label: `Other extrusion (${shortfall.toFixed(2)}g @ $${rate.toFixed(2)}/g)`,
      amount: round2(shortfall * rate),
      surcharge: true,
    });
  }

  let subtotal = billableGrams * rate;

  const belowMinimum = subtotal < CONFIG.minimumCharge;
  const total = Math.max(subtotal, CONFIG.minimumCharge);

  lines.push({ label: 'Shipping', placeholder: true });
  lines.push({ label: 'Handling fee', placeholder: true });
  lines.push({ label: 'Tax', placeholder: true });

  return {
    lines,
    subtotal: round2(subtotal),
    total: round2(total),
    belowMinimum,
    weightGrams: round2(weightGrams),
    billableGrams: round2(billableGrams),
    breakdown: breakdown || null,
    material: key,
    colorCount,
    multicolor,
    currency: 'USD',
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { CONFIG, computeQuote };
