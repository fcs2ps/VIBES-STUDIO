#!/usr/bin/env node
'use strict';

/**
 * Builds the zip you hand to someone else.
 *
 *     node make-release.js                 build for Windows (the default)
 *     node make-release.js --platform linux
 *     node make-release.js --keep          leave the staging folder behind
 *
 * The output is a folder that runs on unzip: it carries Node, OrcaSlicer and
 * the print profiles, and needs nothing installed on the machine that receives
 * it. That is the whole contract, so this script checks it rather than
 * assuming it — see verifyStaging() at the bottom, which walks the staged tree
 * and fails the build if anything the app needs at runtime is absent.
 *
 * WHY A STAGING COPY
 *   The working tree carries a vendor/ for whatever platform you develop on,
 *   plus node_modules, a download cache and .git — none of which belong in a
 *   release, and the first of which is actively wrong when cross-building for
 *   Windows from a Mac or Linux box. So the release is assembled in its own
 *   folder from an explicit list of what ships, and vendor/ is built fresh
 *   inside it for the target platform.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

/* ==================================================================== cli == */

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
};
const OPT = {
  platform: valueOf('--platform') || 'win32',
  keep: has('--keep'),
  skipZip: has('--skip-zip'),
};

const line = (c = '-', n = 66) => c.repeat(n);
const mb = (b) => (b / (1024 * 1024)).toFixed(0) + ' MB';

function fail(msg, details = []) {
  console.error('\n  ' + msg);
  for (const d of details) console.error('  ' + d);
  console.error('');
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
}

/* =============================================================== manifest == */

/**
 * Everything that ships, and nothing that does not.
 *
 * An allow-list rather than an ignore-list: a new build artifact or a stray
 * credentials file added to the working tree should not silently become part
 * of a zip that goes to other people.
 */
const SHIP = [
  'index.html',
  'style.css',
  'bundle.js',
  'start.js',
  'setup.js',
  'package.json',
  'README.md',
  'START-HERE.txt',
  'START-WINDOWS.bat',
  'dist/vibes3d-studio.html',
  'server/',
  'src/',
];

/** Paths inside the shipped subtrees that stay behind. */
const SHIP_EXCLUDE = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)result\.json$/,
  /(^|\/)\.DS_Store$/,
];

function shouldShip(rel) {
  return !SHIP_EXCLUDE.some((re) => re.test(rel));
}

function copyInto(stage, rel) {
  const from = path.join(ROOT, rel.replace(/\/$/, ''));
  const to = path.join(stage, rel.replace(/\/$/, ''));
  if (!fs.existsSync(from)) fail(`Cannot build a release: ${rel} is missing.`);

  const st = fs.statSync(from);
  if (st.isFile()) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    return 1;
  }

  let n = 0;
  const walk = (src, dst, prefix) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const childRel = prefix ? `${prefix}/${e.name}` : e.name;
      if (!shouldShip(childRel)) continue;
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      if (e.isDirectory()) walk(s, d, childRel);
      else if (e.isFile()) { fs.copyFileSync(s, d); n++; }
    }
  };
  walk(from, to, rel.replace(/\/$/, ''));
  return n;
}

function dirSize(p) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) { try { total += fs.statSync(full).size; } catch {} }
    }
  };
  try { walk(p); } catch {}
  return total;
}

/* ================================================================ verify == */

/**
 * Walks the staged folder and asserts that what a fresh machine needs is
 * actually in it.
 *
 * This exists because the failure it guards against is silent and expensive:
 * the zip looks right, unzips fine, starts fine, and only fails when a
 * customer asks for a price. Everything here is a thing whose absence produced
 * exactly that.
 */
function verifyStaging(stage, platform) {
  const problems = [];
  const need = (rel, why) => {
    if (!fs.existsSync(path.join(stage, rel))) problems.push(`${rel} — ${why}`);
  };

  const manifestPath = path.join(stage, 'vendor', 'MANIFEST.json');
  if (!fs.existsSync(manifestPath)) {
    problems.push('vendor/MANIFEST.json — nothing was bundled');
  } else {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    need(path.join('vendor', m.slicer.bin), 'the slicer the manifest points at');
    need(path.join('vendor', m.node.bin), 'the Node runtime the launcher runs');
    if (m.platform !== `${platform}-x64`) {
      problems.push(`vendor/MANIFEST.json says ${m.platform}, not ${platform}-x64`);
    }
    // The machine G-code in the profiles came out of this tree, and
    // build-profiles.js reads it again on any rebuild.
    need(path.join('vendor', 'orcaslicer', 'resources', 'profiles', 'BBL'),
      'the Bambu profile tree the slicer resolves against');
  }

  need('vendor/licenses/NOTICE.md', 'the AGPL notice for the bundled slicer');
  need('vendor/licenses/OrcaSlicer-LICENSE.txt', 'the bundled slicer\'s licence');

  for (const p of ['p2s_machine.json', 'p2s_process.json', 'pla_basic.json', 'asa_basic.json']) {
    need(`server/profiles/${p}`, 'a print profile the quote service loads');
  }
  need('server/profiles/bambu-presets/BBL', 'the Bambu presets profiles are rebuilt from');
  need('index.html', 'the storefront');
  need('bundle.js', 'the storefront\'s script');
  need('start.js', 'the launcher');
  if (platform === 'win32') need('START-WINDOWS.bat', 'the thing people double-click');

  // A profile that lost its inheritance resolution slices happily and prices
  // wrongly, so check the two settings whose absence actually changed quotes.
  try {
    const machine = JSON.parse(fs.readFileSync(path.join(stage, 'server/profiles/p2s_machine.json'), 'utf8'));
    const proc = JSON.parse(fs.readFileSync(path.join(stage, 'server/profiles/p2s_process.json'), 'utf8'));
    if (!String(machine.printable_area || '').includes('256x256')) {
      problems.push('server/profiles/p2s_machine.json — printable_area is not the P2S\'s 256x256');
    }
    if (proc.sparse_infill_density === undefined) {
      problems.push('server/profiles/p2s_process.json — no sparse_infill_density; the slicer would use its own default');
    }
    if (!proc.curr_bed_type) {
      problems.push('server/profiles/p2s_process.json — no curr_bed_type; ASA fails with "Cool Plate does not support filament 1"');
    }
  } catch (e) {
    problems.push('server/profiles — could not be read: ' + e.message);
  }

  if (problems.length) {
    console.error('\n' + line());
    console.error('  THE STAGED RELEASE IS INCOMPLETE - not zipping it');
    console.error(line() + '\n');
    for (const p of problems) console.error('  - ' + p);
    console.error('');
    process.exit(1);
  }
}

/* =================================================================== zip == */

/**
 * Zips `stage` into `outFile`.
 *
 * Shells out rather than implementing deflate: every platform this runs on
 * has one of these, and a release archive is exactly the wrong place to debug
 * a hand-rolled zip writer.
 */
function makeZip(stage, outFile, folderName) {
  const parent = path.dirname(stage);
  fs.rmSync(outFile, { force: true });

  const attempts = process.platform === 'win32'
    ? [['powershell', ['-NoProfile', '-Command',
        `Compress-Archive -Path '${path.join(parent, folderName)}' -DestinationPath '${outFile}' -CompressionLevel Optimal`]]]
    : [['zip', ['-r', '-q', '-9', outFile, folderName]],
       ['7z', ['a', '-tzip', '-mx=9', outFile, folderName]]];

  for (const [cmd, args] of attempts) {
    try {
      execFileSync(cmd, args, { cwd: parent, stdio: 'ignore' });
      if (fs.existsSync(outFile)) return true;
    } catch { /* try the next one */ }
  }
  return false;
}

/* ================================================================== main == */

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const folderName = 'vibes3d-studio';
  const stageParent = fs.mkdtempSync(path.join(os.tmpdir(), 'vibes-release-'));
  const stage = path.join(stageParent, folderName);

  console.log('\n' + line());
  console.log('  BUILDING A RELEASE  -  ' + OPT.platform);
  console.log(line() + '\n');

  // 1. The storefront, from source, so the zip can never carry a stale bundle.
  console.log('  building the storefront...');
  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch {
    fail('esbuild is not installed, so the storefront cannot be rebuilt.', [
      'Run "npm install" here first. A release must be built from source —',
      'shipping whatever bundle.js happens to be lying around is how a zip',
      'goes out with last week\'s storefront in it.',
    ]);
  }
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'main.js')],
    bundle: true,
    format: 'iife',
    outfile: path.join(ROOT, 'bundle.js'),
  });
  run(process.execPath, ['build-single-file.js'], { stdio: 'ignore' });
  console.log('  [ok]  bundle.js and dist/vibes3d-studio.html rebuilt\n');

  // 2. The files that ship.
  let files = 0;
  for (const rel of SHIP) files += copyInto(stage, rel);
  console.log(`  [ok]  staged ${files} project files`);

  // 3. A vendor/ built for the target, inside the staging folder.
  console.log(`\n  bundling Node and OrcaSlicer for ${OPT.platform}...\n`);
  const cache = path.join(ROOT, 'vendor', '.cache');
  if (fs.existsSync(cache)) {
    // Reuse anything already downloaded; setup re-checks every hash anyway.
    fs.mkdirSync(path.join(stage, 'vendor', '.cache'), { recursive: true });
    for (const f of fs.readdirSync(cache)) {
      fs.copyFileSync(path.join(cache, f), path.join(stage, 'vendor', '.cache', f));
    }
  }
  run(process.execPath, [path.join(stage, 'setup.js'), '--platform', OPT.platform, '--force'],
    { cwd: stage });

  // The download cache is a build artifact, not part of the app.
  fs.rmSync(path.join(stage, 'vendor', '.cache'), { recursive: true, force: true });

  // 4. Check the contract before shipping it.
  console.log('\n  checking the staged folder is complete...');
  verifyStaging(stage, OPT.platform);
  console.log('  [ok]  everything the app needs at runtime is present\n');

  const bytes = dirSize(stage);
  console.log(`  unpacked size: ${mb(bytes)}`);

  if (OPT.skipZip) {
    console.log(`\n  Staged (not zipped): ${stage}\n`);
    return;
  }

  // 5. Zip it.
  fs.mkdirSync(DIST, { recursive: true });
  const outFile = path.join(DIST, `${folderName}-${pkg.version}-${OPT.platform === 'win32' ? 'win64' : OPT.platform}.zip`);
  console.log('  zipping...');
  if (!makeZip(stage, outFile, folderName)) {
    fail('Could not create the zip.', [
      'No usable zip tool was found (tried zip, 7z).',
      `The finished folder is here, zip it yourself:  ${stage}`,
    ]);
  }

  const zipped = fs.statSync(outFile).size;
  if (!OPT.keep) fs.rmSync(stageParent, { recursive: true, force: true });

  console.log('\n' + line());
  console.log('  DONE');
  console.log(line());
  console.log(`\n  ${outFile}`);
  console.log(`  ${mb(zipped)} zipped, ${mb(bytes)} unpacked\n`);
  console.log('  Hand this to someone with no Node and no slicer installed.');
  console.log('  They unzip it and double-click ' +
    (OPT.platform === 'win32' ? 'START-WINDOWS.bat' : 'start.js') + '.\n');
  if (OPT.keep) console.log(`  Staging kept at: ${stage}\n`);
}

main();
