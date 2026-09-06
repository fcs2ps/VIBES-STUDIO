#!/usr/bin/env node
'use strict';

/**
 * Vibes 3D Studio — one-time dependency setup.
 *
 *     node setup.js
 *
 * Copies everything the quoting service needs into ./vendor, so that from then
 * on the folder is self-contained: no Node.js on PATH, no Bambu Studio
 * installed, no environment variables, no network.
 *
 *     vendor/node/            the Node runtime the launchers use
 *     vendor/bambu-studio/    the slicer, trimmed to what a headless slice needs
 *     vendor/MANIFEST.json    what was vendored, from where, and when
 *
 * WHY COPY RATHER THAN DOWNLOAD
 *   Bambu Studio ships as a GUI installer, not a portable archive, so there is
 *   nothing to unpack even with a network connection. Copying an install we can
 *   see on disk is the only path that works offline, and it vendors *the version
 *   the shop already prints with* — which is the version whose numbers the
 *   prices are supposed to match.
 *
 * WHY A TRIMMED COPY
 *   A full install is ~780 MB, and most of that is the GUI: rendering assets,
 *   translations, the embedded web views, the hardware-error database, the
 *   bundled Visual C++ and WebView2 installers. A headless slice touches none of
 *   it. See EXCLUDE_RESOURCES for the list and the reason for each entry.
 *
 * USAGE
 *   node setup.js                      auto-detect an install and vendor it
 *   node setup.js --from "<dir>"       vendor a specific install
 *   node setup.js --full               skip the trimming, copy everything
 *   node setup.js --check              report what is vendored, change nothing
 *   node setup.js --force              re-vendor even if vendor/ already exists
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const VENDOR = path.join(ROOT, 'vendor');
const MANIFEST = path.join(VENDOR, 'MANIFEST.json');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
};

const OPT = {
  from: valueOf('--from'),
  full: has('--full'),
  check: has('--check'),
  force: has('--force'),
  quiet: has('--quiet'),
};

const line = (char = '-', n = 66) => char.repeat(n);
const say = (...a) => { if (!OPT.quiet) console.log(...a); };
const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(0) + ' MB';

/* ============================================ what a headless slice needs == */

/**
 * Directories under resources/ that exist only for the GUI. Every entry has
 * been checked against a real slice — if a trimmed copy ever stops slicing, the
 * fix is to move an entry out of this list, not to guess.
 */
const EXCLUDE_RESOURCES = new Set([
  'hms',      // 152 MB - hardware error-code database, shown in the GUI
  'images',   //  97 MB - icons, splash art, printer renders
  'web',      //  59 MB - embedded web views (login, device page, wiki)
  'fonts',    //  35 MB - GUI text rendering; slicing embosses no text
  'model',    //  15 MB - 3D models of the printers, for the device view
  'i18n',     //  11 MB - translations
  'calib',    //   9 MB - calibration test models
  'Icon.icns',
]);

/** Top-level entries that are GUI-only or belong to the installer, not the app. */
const EXCLUDE_TOP = new Set([
  'plugin',         // 202 MB - bundled vcredist + WebView2 installers, CA certs
  'Uninstall.exe',  // uninstalls the *system* install; must not travel with us
]);

/**
 * Visual C++ runtime. Bambu Studio's installer puts these in System32; a copied
 * install has no installer, so on a machine that has never run an MSVC-built
 * program the exe would fail to start with no useful error. App-local copies
 * are a supported Microsoft deployment model and cost about a megabyte.
 */
const VCRUNTIME_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'concrt140.dll'];

/* ================================================= finding an installation == */

function installCandidates() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [
      'C:\\Program Files\\Bambu Studio',
      'C:\\Program Files (x86)\\Bambu Studio',
      path.join(home, 'AppData', 'Local', 'Programs', 'Bambu Studio'),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/BambuStudio.app',
      '/Applications/Bambu Studio.app',
      path.join(home, 'Applications', 'BambuStudio.app'),
      path.join(home, 'Applications', 'Bambu Studio.app'),
    ];
  }
  return [
    path.join(home, 'Applications', 'BambuStudio.AppImage'),
    path.join(home, 'Applications', 'Bambu_Studio.AppImage'),
    path.join(home, 'Downloads', 'BambuStudio.AppImage'),
    '/opt/bambu-studio',
    '/usr/share/bambu-studio',
  ];
}

/** True if `p` looks like a Bambu Studio install rather than a lookalike. */
function looksLikeInstall(p) {
  try {
    const stat = fs.statSync(p);
    if (stat.isFile()) return /\.appimage$/i.test(p);            // Linux
    if (p.endsWith('.app')) return fs.existsSync(path.join(p, 'Contents', 'MacOS'));
    return fs.existsSync(path.join(p, 'resources', 'profiles'));
  } catch {
    return false;
  }
}

function findInstall() {
  if (OPT.from) {
    const p = path.resolve(OPT.from);
    if (!looksLikeInstall(p)) {
      fail(`--from "${p}" is not a Bambu Studio installation.`, [
        'Point it at the folder containing bambu-studio.exe (Windows),',
        'the BambuStudio.app bundle (macOS), or the .AppImage file (Linux).',
      ]);
    }
    return p;
  }
  // An explicit BAMBU_STUDIO_BIN tells us where the install is even when it
  // sits somewhere we would never think to look.
  if (process.env.BAMBU_STUDIO_BIN) {
    const bin = process.env.BAMBU_STUDIO_BIN;
    const guesses = bin.includes('.app/')
      ? [path.resolve(path.dirname(bin), '..', '..')]            // .app/Contents/MacOS/x
      : [path.dirname(bin), bin];
    for (const g of guesses) if (looksLikeInstall(g)) return g;
  }
  return installCandidates().find(looksLikeInstall) || null;
}

/* ================================================================ copying == */

let copiedBytes = 0;
let copiedFiles = 0;
let lastTick = 0;

function tick() {
  if (OPT.quiet) return;
  const now = Date.now();
  if (now - lastTick < 250) return;
  lastTick = now;
  process.stdout.write(`\r  copying... ${copiedFiles} files, ${mb(copiedBytes)}   `);
}

/**
 * Recursive copy. `filter(relativePath)` returning false prunes the entry —
 * and, for a directory, the whole subtree beneath it.
 */
function copyTree(src, dest, filter, rel = '') {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (filter && !filter(childRel)) continue;

    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);

    if (entry.isSymbolicLink()) {
      // Preserve rather than dereference: macOS .app bundles are full of
      // Versions/Current links, and following them duplicates whole frameworks.
      try {
        fs.symlinkSync(fs.readlinkSync(from), to);
      } catch { /* a broken link is not worth failing the whole setup over */ }
    } else if (entry.isDirectory()) {
      copyTree(from, to, filter, childRel);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
      try { copiedBytes += fs.statSync(from).size; } catch {}
      copiedFiles++;
      tick();
    }
  }
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
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.size;
    walk(p);
  } catch {}
  return total;
}

/* ======================================================= vendoring Bambu == */

/** The trim filter, expressed once and reused across the three layouts. */
function makeFilter(resourcesPrefix) {
  if (OPT.full) return null;
  return (rel) => {
    if (EXCLUDE_TOP.has(rel)) return false;
    if (rel.startsWith(resourcesPrefix + '/')) {
      const top = rel.slice(resourcesPrefix.length + 1).split('/')[0];
      return !EXCLUDE_RESOURCES.has(top);
    }
    return true;
  };
}

function vendorBambuStudio(install) {
  const dest = path.join(VENDOR, 'bambu-studio');
  fs.rmSync(dest, { recursive: true, force: true });

  const stat = fs.statSync(install);

  // Linux: the whole application is a single AppImage file.
  if (stat.isFile()) {
    fs.mkdirSync(dest, { recursive: true });
    const to = path.join(dest, 'BambuStudio.AppImage');
    fs.copyFileSync(install, to);
    fs.chmodSync(to, 0o755);
    copiedBytes += stat.size; copiedFiles++;
    return { bin: path.relative(VENDOR, to), layout: 'appimage' };
  }

  if (install.endsWith('.app')) {
    const bundle = path.join(dest, path.basename(install));
    copyTree(install, bundle, makeFilter('Contents/Resources'));
    const macos = path.join(bundle, 'Contents', 'MacOS');
    const exe = fs.readdirSync(macos).find((f) => /bambu/i.test(f)) || 'BambuStudio';
    const bin = path.join(macos, exe);
    try { fs.chmodSync(bin, 0o755); } catch {}
    return { bin: path.relative(VENDOR, bin), layout: 'app-bundle' };
  }

  copyTree(install, dest, makeFilter('resources'));
  const bin = path.join(dest, 'bambu-studio.exe');
  if (!fs.existsSync(bin)) {
    fail('The copy finished but bambu-studio.exe is not in it.', [
      `Looked in: ${dest}`,
      'Re-run with --from pointing at the folder that holds bambu-studio.exe.',
    ]);
  }

  // App-local C++ runtime, so the copy starts on a machine that has never had
  // Bambu Studio — or any other MSVC-built program — installed.
  if (process.platform === 'win32') {
    const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    let brought = 0;
    for (const dll of VCRUNTIME_DLLS) {
      const from = path.join(sys32, dll);
      if (fs.existsSync(from) && !fs.existsSync(path.join(dest, dll))) {
        try { fs.copyFileSync(from, path.join(dest, dll)); brought++; } catch {}
      }
    }
    if (brought) say(`\r  bundled ${brought} Visual C++ runtime DLLs${' '.repeat(24)}`);
  }

  return { bin: path.relative(VENDOR, bin), layout: 'windows' };
}

/* ========================================================= vendoring Node == */

/**
 * The Node binary is self-contained on all three platforms, so the runtime
 * executing this script is also the runtime we can hand to the launchers. No
 * download, no version matching, no network.
 */
function vendorNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    fail(`Node ${process.version} is too old to vendor (18 or newer required).`, [
      'Install a current Node from https://nodejs.org and run setup again.',
      'The copy in vendor/ is what every other machine will run, so it has',
      'to be a version this app supports.',
    ]);
  }

  const dest = path.join(VENDOR, 'node');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  const to = path.join(dest, name);
  fs.copyFileSync(process.execPath, to);
  if (process.platform !== 'win32') fs.chmodSync(to, 0o755);
  copiedBytes += fs.statSync(to).size; copiedFiles++;

  return { bin: path.relative(VENDOR, to), version: process.version };
}

/* ============================================================== reporting == */

function fail(message, details = []) {
  console.error('\n  ' + message);
  for (const d of details) console.error('  ' + d);
  console.error('');
  process.exit(1);
}

function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return null; }
}

function report() {
  const m = readManifest();
  console.log('\n' + line());
  console.log('  VENDORED DEPENDENCIES');
  console.log(line() + '\n');
  if (!m) {
    console.log('  Nothing vendored yet. Run:  node setup.js\n');
    return 1;
  }
  const nodeBin = path.join(VENDOR, m.node.bin);
  const bambuBin = path.join(VENDOR, m.bambuStudio.bin);
  const ok = (p) => (fs.existsSync(p) ? '[ok]' : '[--]');
  console.log(`  ${ok(nodeBin)}  Node ${m.node.version}`);
  console.log(`        ${nodeBin}`);
  console.log(`  ${ok(bambuBin)}  Bambu Studio (${m.bambuStudio.trimmed ? 'trimmed' : 'full'} copy, ${mb(m.bambuStudio.bytes)})`);
  console.log(`        ${bambuBin}`);
  console.log(`\n  Vendored ${m.createdAt} on ${m.platform}`);
  console.log(`  Copied from:  ${m.bambuStudio.source}\n`);
  const healthy = fs.existsSync(nodeBin) && fs.existsSync(bambuBin);
  if (!healthy) console.log('  Something is missing. Re-run:  node setup.js --force\n');
  return healthy ? 0 : 1;
}

/* =================================================================== main == */

function main() {
  if (OPT.check) process.exit(report());

  if (readManifest() && !OPT.force) {
    console.log('\n  Already set up. Nothing to do.');
    console.log('  Re-run with --force to rebuild vendor/ from scratch.');
    report();
    process.exit(0);
  }

  say('\n' + line());
  say('  VIBES 3D STUDIO - SETUP');
  say(line());
  say('\n  This copies Node.js and Bambu Studio into ./vendor so the folder');
  say('  runs on its own. It takes a minute and about 250 MB of disk.\n');

  const install = findInstall();
  if (!install) {
    fail('Could not find a Bambu Studio installation to copy from.', [
      '',
      'Setup needs one installed copy to vendor. Bambu Studio ships as a GUI',
      'installer, so there is no archive to download and unpack automatically.',
      '',
      '  1. Install Bambu Studio once, from https://bambulab.com/download',
      '  2. Run this again:  node setup.js',
      '',
      'Already installed somewhere unusual? Point setup at it:',
      '  node setup.js --from "C:\\Path\\To\\Bambu Studio"',
    ]);
  }

  say(`  Bambu Studio found:  ${install}`);
  say(`  Full install size:   ${mb(dirSize(install))}\n`);

  fs.mkdirSync(VENDOR, { recursive: true });

  const bambuStudio = vendorBambuStudio(install);
  if (!OPT.quiet) process.stdout.write('\r' + ' '.repeat(64) + '\r');
  const bambuBytes = dirSize(path.join(VENDOR, 'bambu-studio'));
  say(`  [ok]  Bambu Studio vendored  (${mb(bambuBytes)})`);

  const node = vendorNode();
  say(`  [ok]  Node ${node.version} vendored`);

  fs.writeFileSync(MANIFEST, JSON.stringify({
    createdAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: { ...node, arch: process.arch },
    bambuStudio: {
      ...bambuStudio,
      source: install,
      trimmed: !OPT.full,
      bytes: bambuBytes,
    },
  }, null, 2) + '\n');

  say('\n  Checking that a real slice runs against the vendored copy...\n');

  // Prove it, rather than declaring success because files were copied. This
  // runs the same code path /api/quote uses, so a pass here means quoting
  // works. VENDOR_ONLY stops the check from silently falling back to the
  // system install and reporting a success the shipped folder can't reproduce.
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'server', 'scripts', 'verify-profiles.js')], {
      stdio: OPT.quiet ? 'ignore' : 'inherit',
      env: { ...process.env, BAMBU_STUDIO_BIN: '', VENDOR_ONLY: '1' },
    });
  } catch {
    console.error('\n' + line());
    console.error('  The vendored copy did not produce a slice.');
    console.error(line());
    console.error('\n  Try the untrimmed copy, which rules out an over-eager trim:');
    console.error('    node setup.js --force --full\n');
    console.error('  If that works, the trim dropped something this Bambu Studio');
    console.error('  version needs - see EXCLUDE_RESOURCES in setup.js.\n');
    process.exit(1);
  }

  say('\n' + line());
  say('  READY');
  say(line());
  say('\n  Everything the app needs now lives in this folder.');
  say('  Start it with the launcher for your computer, or:  node start.js\n');
}

main();
