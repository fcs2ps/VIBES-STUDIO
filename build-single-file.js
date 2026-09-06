#!/usr/bin/env node
/**
 * Produces dist/vibes3d-studio.html — the whole site in one file.
 *
 * Why: index.html loads style.css and bundle.js as siblings. Open the HTML on
 * its own, without those two files beside it, and both requests 404 — the page
 * renders unstyled and every button is dead. A single self-contained file
 * cannot fail that way, which makes it the right thing to hand someone who
 * just wants to double-click and look at it.
 *
 * Usage: node build-single-file.js
 */

const fs = require('fs');
const path = require('path');

const root = __dirname;
const outDir = path.join(root, 'dist');

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'bundle.js'), 'utf8');

// A literal </script> anywhere in the bundle would close the tag early and
// break the page in a way that's painful to debug, so fail loudly instead.
if (/<\/script/i.test(js)) {
  console.error('ERROR: bundle.js contains "</script" and cannot be inlined as-is.');
  process.exit(1);
}
if (/<\/style/i.test(css)) {
  console.error('ERROR: style.css contains "</style" and cannot be inlined as-is.');
  process.exit(1);
}

let out = html.replace(
  '<link rel="stylesheet" href="style.css">',
  '<style>\n' + css + '\n</style>'
);
if (out === html) {
  console.error('ERROR: could not find the style.css link tag to replace.');
  process.exit(1);
}

const before = out;
out = out.replace(
  '<script src="bundle.js"></script>',
  '<script>\n' + js + '\n</script>'
);
if (out === before) {
  console.error('ERROR: could not find the bundle.js script tag to replace.');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'vibes3d-studio.html');
fs.writeFileSync(outPath, out);

const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
console.log(`Wrote ${outPath} (${kb} KB)`);
