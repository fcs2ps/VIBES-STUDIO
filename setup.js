#!/usr/bin/env node
'use strict';

/**
 * Vibes 3D Studio — dependency setup.
 *
 *     node setup.js
 *
 * Puts everything the quoting service needs into ./vendor, so the folder is
 * self-contained: no Node.js on PATH, no slicer installed, no environment
 * variables, no network.
 *
 *     vendor/node/          the Node runtime the launchers use
 *     vendor/orcaslicer/    the slicer, trimmed to what a headless slice needs
 *     vendor/licenses/      the bundled software's licenses and notices
 *     vendor/MANIFEST.json  what was vendored, from where, and when
 *
 * MOST PEOPLE NEVER RUN THIS
 *   A released zip already carries vendor/, which is the whole point of it.
 *   This script is what builds that zip (see make-release.js), and what
 *   repairs a folder whose vendor/ was deleted.
 *
 * WHY ORCASLICER AND NOT BAMBU STUDIO
 *   Bambu Studio ships only as a GUI installer. There is no archive to fetch
 *   and unpack, so a folder could never carry it — the old version of this
 *   script copied it out of an install on the machine, which meant every
 *   machine needed Bambu Studio installed first. That is exactly the error
 *   this replaced: "The slicing engine isn't installed on the server yet."
 *
 *   OrcaSlicer is a fork of Bambu Studio with the same command-line interface,
 *   and it publishes a portable archive. So it can be bundled, and the folder
 *   really does run anywhere.
 *
 *   The numbers still come from Bambu: the profiles are built from Bambu
 *   Studio's own presets by server/scripts/build-profiles.js. OrcaSlicer is
 *   the engine that reads them, not the source of the settings.
 *
 * USAGE
 *   node setup.js                     use Bambu Studio if installed, else fetch Orca
 *   node setup.js --from "<path>"     use the Bambu Studio at this path
 *   node setup.js --bundle-orca       always bundle OrcaSlicer (release builds)
 *   node setup.js --platform win32    vendor for Windows (cross-building)
 *   node setup.js --check             report what is vendored, change nothing
 *   node setup.js --force             rebuild vendor/ from scratch
 *   node setup.js --full              skip the trim, keep the whole slicer
 *   node setup.js --skip-verify       do not slice a test cube at the end
 */

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const { execFileSync } = require('child_process');

const zipReader = require('./server/src/zip');

const ROOT = __dirname;
const VENDOR = path.join(ROOT, 'vendor');
const MANIFEST = path.join(VENDOR, 'MANIFEST.json');
const CACHE = path.join(VENDOR, '.cache');

/* ================================================================ sources == */

const ORCA_VERSION = '2.4.0';
const NODE_VERSION = 'v22.11.0';

/**
 * Exactly what gets downloaded, per platform, with the SHA-256 of each file.
 *
 * The hashes are not ceremony: this unpacks an archive and then runs the
 * executable inside it, so "the bytes are the ones we tested" is the only
 * thing standing between a corrupted or substituted download and a program
 * this script launches.
 */
const SOURCES = {
  win32: {
    slicer: {
      url: `https://github.com/SoftFever/OrcaSlicer/releases/download/v${ORCA_VERSION}/OrcaSlicer_Windows_V${ORCA_VERSION}_portable.zip`,
      file: `OrcaSlicer_Windows_V${ORCA_VERSION}_portable.zip`,
      sha256: 'fb6766b847fe064b20eb4fd7574c66ff0354e1f0e3ca38fc2daa603ad3691e25',
      kind: 'zip',
      bin: 'orca-slicer.exe',
      resources: 'resources',
    },
    node: {
      url: `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip`,
      file: `node-${NODE_VERSION}-win-x64.zip`,
      sha256: '905373a059aecaf7f48c1ce10ffbd5334457ca00f678747f19db5ea7d256c236',
      kind: 'zip',
      // The archive has one top-level folder; we want the exe out of it.
      inner: `node-${NODE_VERSION}-win-x64/node.exe`,
      bin: 'node.exe',
    },
  },
  linux: {
    slicer: {
      url: `https://github.com/SoftFever/OrcaSlicer/releases/download/v${ORCA_VERSION}/OrcaSlicer_Linux_AppImage_Ubuntu2404_V${ORCA_VERSION}.AppImage`,
      file: `OrcaSlicer_Linux_AppImage_Ubuntu2404_V${ORCA_VERSION}.AppImage`,
      sha256: '46556197dcc2fb55140e0b1e70c28b4c4da3208f12a4a2522012837c9d77ee10',
      kind: 'appimage',
      bin: 'AppRun',
      resources: 'resources',
    },
    node: { local: true, bin: 'node' },
  },
};

/* ================================================== what a slice needs not == */

/**
 * Directories under resources/ that exist only for the GUI.
 *
 * Every entry here was removed and then checked against a real slice: a 40mm
 * PLA cube produces byte-identical G-code with them present and absent
 * (20.28 g, 1319 s, 6691.78 mm either way). If a future OrcaSlicer needs one
 * of these, the fix is to move it out of this list, not to guess — and
 * `node setup.js --force --full` gets you running again immediately.
 */
const EXCLUDE_RESOURCES = new Set([
  'hms',           // 65 MB - hardware error-code database, shown in the GUI
  'images',        // 35 MB - icons, splash art, printer renders
  'fonts',         // 35 MB - GUI text rendering; slicing embosses no text
  'web',           // 22 MB - embedded web views (login, device page, wiki)
  'i18n',          // 15 MB - translations
  'handy_models',  // 4.5 MB - the sample models offered in the GUI
  'calib',         // 2.1 MB - calibration test models
  'tooltip',       // 1.1 MB - GUI tooltip text
  'shaders',       // 328 KB - 3D preview rendering
  'dailytip',
]);

/**
 * Printer vendors under resources/profiles/. We slice for one printer on
 * Bambu profiles, so the other 60-odd vendors are 68 MB of dead weight — but
 * BBL has to stay: build-profiles.js reads the machine G-code out of it.
 */
const KEEP_PROFILE_VENDORS = new Set(['BBL']);

/* ==================================================================== cli == */

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
};

const OPT = {
  platform: valueOf('--platform') || process.platform,
  check: has('--check'),
  force: has('--force'),
  full: has('--full'),
  quiet: has('--quiet'),
  skipVerify: has('--skip-verify'),
  bundleOrca: has('--bundle-orca'),
  from: valueOf('--from'),
};

const line = (char = '-', n = 66) => char.repeat(n);
const say = (...a) => { if (!OPT.quiet) console.log(...a); };
const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(0) + ' MB';

function fail(message, details = []) {
  console.error('\n  ' + message);
  for (const d of details) console.error('  ' + d);
  console.error('');
  process.exit(1);
}

/* =============================================================== download == */

/**
 * GETs a URL to a file, following redirects, and honouring HTTPS_PROXY.
 *
 * Node's https module ignores the proxy environment variables, and release
 * assets are served by a redirect to a different host — both of which silently
 * turn into a hang or a 4-byte "file" if unhandled.
 */
function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    const target = new URL(url);

    const request = (opts) => https.get(opts, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        return download(new URL(res.headers.location, url).href, dest, onProgress)
          .then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const total = Number(res.headers['content-length'] || 0);
      let seen = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => { seen += c.length; if (onProgress) onProgress(seen, total); });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
    }).on('error', reject);

    if (!proxy) return request(url);

    // Tunnel through the proxy with CONNECT, then speak TLS inside it.
    const p = new URL(proxy);
    require('http').request({
      host: p.hostname,
      port: p.port || 80,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
    }).on('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error(`proxy CONNECT ${res.statusCode}`));
      request({
        socket,
        agent: false,
        host: target.hostname,
        servername: target.hostname,
        path: target.pathname + target.search,
      });
    }).on('error', reject).end();
  });
}

function sha256(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

/**
 * Returns a verified local copy of `spec`, downloading it only if the cache
 * does not already hold one whose hash matches.
 */
async function fetchVerified(spec, label) {
  fs.mkdirSync(CACHE, { recursive: true });
  const dest = path.join(CACHE, spec.file);

  if (fs.existsSync(dest)) {
    const got = sha256(dest);
    if (got === spec.sha256) { say(`  [ok]  ${label} already downloaded`); return dest; }
    say(`  [--]  cached ${label} has the wrong hash; downloading again`);
    fs.rmSync(dest);
  }

  say(`  downloading ${label}...`);
  let lastTick = 0;
  try {
    await download(spec.url, dest, (seen, total) => {
      if (OPT.quiet) return;
      const now = Date.now();
      if (now - lastTick < 400) return;
      lastTick = now;
      const pct = total ? ` (${Math.round((seen / total) * 100)}%)` : '';
      process.stdout.write(`\r    ${mb(seen)}${pct}      `);
    });
  } catch (err) {
    fs.rmSync(dest, { force: true });
    fail(`Could not download ${label}.`, [
      String(err.message),
      '',
      `  ${spec.url}`,
      '',
      'If this machine has no internet access, download that file on one',
      `that does and drop it here, then run setup again:`,
      `  ${dest}`,
    ]);
  }
  if (!OPT.quiet) process.stdout.write('\r' + ' '.repeat(40) + '\r');

  const got = sha256(dest);
  if (got !== spec.sha256) {
    fs.rmSync(dest, { force: true });
    fail(`The downloaded ${label} is not the file we expect.`, [
      `expected sha256 ${spec.sha256}`,
      `got      sha256 ${got}`,
      '',
      'Refusing to unpack and run it. Try again; if it keeps happening,',
      'the release may have been re-published and setup.js needs updating.',
    ]);
  }
  say(`  [ok]  ${label} downloaded and verified (${mb(fs.statSync(dest).size)})`);
  return dest;
}

/* ================================================================ extract == */

let wrote = 0;
let wroteBytes = 0;
let lastTick = 0;

function tick() {
  if (OPT.quiet) return;
  const now = Date.now();
  if (now - lastTick < 250) return;
  lastTick = now;
  process.stdout.write(`\r    unpacking... ${wrote} files, ${mb(wroteBytes)}   `);
}

/**
 * Extracts a zip into `destDir`, skipping entries `filter` rejects.
 *
 * Uses the reader the quote service already ships rather than a dependency, so
 * setup keeps the same promise the server makes: Node built-ins only.
 */
function extractZip(zipPath, destDir, filter) {
  const buf = fs.readFileSync(zipPath);
  for (const entry of zipReader.listEntries(buf)) {
    const name = entry.name.replace(/\\/g, '/');
    if (name.endsWith('/')) continue;                       // directory marker

    // Never let an archive write outside the folder it is being unpacked into.
    const out = path.resolve(destDir, name);
    if (out !== destDir && !out.startsWith(destDir + path.sep)) continue;

    const rel = filter ? filter(name) : name;
    if (rel === null) continue;
    const target = path.resolve(destDir, rel);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    const data = zipReader.readEntry(buf, entry);
    fs.writeFileSync(target, data);
    wrote++; wroteBytes += data.length;
    tick();
  }
}

/** Unpacks an AppImage by asking it to extract itself. */
function extractAppImage(file, destDir) {
  fs.chmodSync(file, 0o755);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibes-appimage-'));
  execFileSync(path.resolve(file), ['--appimage-extract'], { cwd: tmp, stdio: 'ignore' });
  fs.renameSync(path.join(tmp, 'squashfs-root'), destDir);
  fs.rmSync(tmp, { recursive: true, force: true });
}

/** The trim, as a path filter. Returns the output path, or null to drop. */
function makeFilter(resourcesPrefix) {
  if (OPT.full) return (name) => name;
  const rp = resourcesPrefix + '/';
  return (name) => {
    if (!name.startsWith(rp)) return name;
    const parts = name.slice(rp.length).split('/');
    if (EXCLUDE_RESOURCES.has(parts[0])) return null;
    if (parts[0] === 'profiles' && parts.length > 1) {
      const vendorName = parts[1].replace(/\.json$/, '');
      if (!KEEP_PROFILE_VENDORS.has(vendorName)) return null;
    }
    return name;
  };
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

/* ================================================================ licenses == */

/**
 * Copies out the bundled software's license, and records what is bundled.
 *
 * OrcaSlicer is AGPLv3. Handing this folder to someone else is redistribution,
 * and redistribution carries obligations: keep the license and notices intact,
 * and be able to point at the corresponding source.
 */
function writeLicenses(orcaDir, spec) {
  const dir = path.join(VENDOR, 'licenses');
  fs.mkdirSync(dir, { recursive: true });

  for (const name of ['LICENSE.txt', 'LICENSE']) {
    const from = path.join(orcaDir, name);
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, path.join(dir, 'OrcaSlicer-LICENSE.txt'));
      break;
    }
  }

  fs.writeFileSync(path.join(dir, 'NOTICE.md'), `# Third-party software in this folder

## OrcaSlicer ${ORCA_VERSION}

\`vendor/orcaslicer/\` is an unmodified copy of the official OrcaSlicer
${ORCA_VERSION} portable release, with GUI-only resource folders removed to save
space. No code was changed.

  Licence: GNU AGPL v3.0 — see OrcaSlicer-LICENSE.txt
  Release: ${spec.url}
  SHA-256: ${spec.sha256}
  Source:  https://github.com/SoftFever/OrcaSlicer/tree/v${ORCA_VERSION}

The AGPL requires that anyone who receives these binaries can get the
corresponding source. The tag above is that source. If you pass this folder on,
pass this notice with it.

## Node.js ${NODE_VERSION}

\`vendor/node/\` is the official Node.js ${NODE_VERSION} build, unmodified.

  Licence: MIT — https://github.com/nodejs/node/blob/${NODE_VERSION}/LICENSE
  Source:  https://nodejs.org/dist/${NODE_VERSION}/

## Bambu Lab print profiles

\`server/profiles/bambu-presets/\` holds Bambu Lab's printer, process and
filament presets for the P2S, as published by Bambu Lab and distributed with
Bambu Studio. They are configuration data, not part of OrcaSlicer.
`);
}

/* =============================================================== reporting == */

/* ============================================ Bambu Studio on this machine == */

/**
 * Where Bambu Studio puts its executable when installed the ordinary way.
 *
 * A developer who already prints from Bambu Studio should not have to download
 * a second slicer to run this, and more to the point should not get quotes from
 * one: production prices with Bambu Studio, so a checkout that prices with
 * something else is a checkout that disagrees with production.
 */
function bambuCandidates() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [
      'C:\\Program Files\\Bambu Studio\\bambu-studio.exe',
      'C:\\Program Files (x86)\\Bambu Studio\\bambu-studio.exe',
      path.join(home, 'AppData', 'Local', 'Programs', 'Bambu Studio', 'bambu-studio.exe'),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio',
      '/Applications/Bambu Studio.app/Contents/MacOS/BambuStudio',
      path.join(home, 'Applications', 'BambuStudio.app', 'Contents', 'MacOS', 'BambuStudio'),
    ];
  }
  return [
    '/opt/bambu-studio/AppRun',
    '/usr/local/bin/bambu-studio',
    '/usr/bin/bambu-studio',
    path.join(home, 'Applications', 'BambuStudio.AppImage'),
  ];
}

function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

/**
 * Resolves whatever the user pointed --from at: the executable itself, an
 * install folder, or a macOS .app bundle.
 */
function resolveFrom(given) {
  const p = path.resolve(given);
  if (isExecutable(p) && fs.statSync(p).isFile()) return p;
  const inside = [
    path.join(p, 'bambu-studio.exe'),
    path.join(p, 'AppRun'),
    path.join(p, 'Contents', 'MacOS', 'BambuStudio'),
  ];
  return inside.find(isExecutable) || null;
}

function findBambuStudio() {
  if (OPT.from) return resolveFrom(OPT.from);
  if (process.env.BAMBU_STUDIO_BIN && isExecutable(process.env.BAMBU_STUDIO_BIN)) {
    return process.env.BAMBU_STUDIO_BIN;
  }
  return bambuCandidates().find(isExecutable) || null;
}

/** Points this checkout at an already-installed Bambu Studio. Nothing downloads. */
function useInstalledBambu(bin) {
  fs.mkdirSync(VENDOR, { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify({
    createdAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: { bin: null, version: process.version, system: true },
    slicer: {
      name: 'Bambu Studio',
      engine: 'bambu',
      bin,                       // absolute: installed, not bundled
      vendored: false,
      source: 'installed on this machine',
    },
  }, null, 2) + '\n');

  say('\n' + line());
  say('  VIBES 3D STUDIO - SETUP');
  say(line());
  say('\n  Found Bambu Studio already installed:');
  say(`    ${bin}\n`);
  say('  Using it. Nothing to download - this is the same program the shop');
  say('  prints with, so your quotes match production.\n');
}

function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return null; }
}

function report() {
  const m = readManifest();
  console.log('\n' + line());
  console.log('  BUNDLED DEPENDENCIES');
  console.log(line() + '\n');
  if (!m) {
    console.log('  Nothing bundled yet. Run:  node setup.js\n');
    return 1;
  }
  const ok = (p) => (p && fs.existsSync(p) ? '[ok]' : '[--]');
  const slicerBin = path.isAbsolute(m.slicer.bin) ? m.slicer.bin : path.join(VENDOR, m.slicer.bin);
  const detail = m.slicer.vendored === false
    ? 'installed on this machine'
    : `bundled, ${m.slicer.trimmed ? 'trimmed' : 'full'}, ${mb(m.slicer.bytes || 0)}`;
  console.log(`  ${ok(slicerBin)}  ${m.slicer.name}${m.slicer.version ? ' ' + m.slicer.version : ''} (${detail})`);
  console.log(`        ${slicerBin}`);

  const nodeBin = m.node && m.node.bin ? path.join(VENDOR, m.node.bin) : null;
  if (nodeBin) {
    console.log(`  ${ok(nodeBin)}  Node ${m.node.version}`);
    console.log(`        ${nodeBin}`);
  } else {
    console.log(`  [ok]  Node ${m.node ? m.node.version : process.version} (this machine's)`);
  }

  console.log(`\n  Configured ${m.createdAt} for ${m.platform}\n`);
  if (m.slicer.engine !== 'bambu') {
    console.log('  Note: quotes from OrcaSlicer are close but not identical to');
    console.log('  Bambu Studio. Install Bambu Studio and re-run setup to match');
    console.log('  production exactly.\n');
  }
  const healthy = fs.existsSync(slicerBin) && (!nodeBin || fs.existsSync(nodeBin));
  if (!healthy) console.log('  Something is missing. Re-run:  node setup.js --force\n');
  return healthy ? 0 : 1;
}

/* ==================================================================== main == */

async function main() {
  if (OPT.check) process.exit(report());

  const src = SOURCES[OPT.platform];
  if (!src) {
    fail(`No sources defined for platform "${OPT.platform}".`, [
      'Supported: ' + Object.keys(SOURCES).join(', '),
    ]);
  }

  if (readManifest() && !OPT.force) {
    console.log('\n  Already set up. Nothing to do.');
    console.log('  Re-run with --force to configure again.');
    report();
    process.exit(0);
  }

  /*
   * The fast path, and the accurate one: if Bambu Studio is already on this
   * machine, point at it and stop. No download, no bundling, and the quotes
   * match production because it is the same program the shop prints with.
   *
   * Release builds skip this with --bundle-orca: a zip that goes to someone
   * else has to carry its own slicer, and it cannot carry Bambu Studio.
   */
  if (!OPT.bundleOrca && OPT.platform === process.platform) {
    const bambu = findBambuStudio();
    if (bambu) {
      useInstalledBambu(bambu);
      if (!OPT.skipVerify) {
        say('  Checking that a real slice runs through it...\n');
        try {
          execFileSync(process.execPath, [path.join(ROOT, 'server', 'scripts', 'verify-profiles.js')], {
            stdio: OPT.quiet ? 'ignore' : 'inherit',
            env: { ...process.env, SLICER_ENGINE: 'bambu', BAMBU_STUDIO_BIN: bambu },
          });
        } catch {
          console.error('\n  Bambu Studio was found but the test slice failed.');
          console.error('  Check it opens normally, then run setup again.\n');
          process.exit(1);
        }
      }
      say('\n' + line());
      say('  READY');
      say(line());
      say('\n  Start it with:  node start.js\n');
      return;
    }

    if (OPT.from) {
      fail(`No Bambu Studio executable under "${OPT.from}".`, [
        'Point --from at the folder holding bambu-studio.exe (Windows),',
        'the BambuStudio.app bundle (macOS), or the AppRun/AppImage (Linux).',
      ]);
    }

    say('\n  Bambu Studio is not installed on this machine.');
    say('  Falling back to bundling OrcaSlicer, which is close but not');
    say('  identical. Install Bambu Studio and re-run setup to match');
    say('  production exactly.\n');
  }

  say('\n' + line());
  say('  VIBES 3D STUDIO - SETUP');
  say(line());
  say(`\n  Bundling OrcaSlicer ${ORCA_VERSION} and Node ${NODE_VERSION} into ./vendor`);
  say(`  for ${OPT.platform}, so this folder runs on its own.\n`);

  fs.mkdirSync(VENDOR, { recursive: true });

  /* ---- slicer ---- */
  const slicerZip = await fetchVerified(src.slicer, `OrcaSlicer ${ORCA_VERSION}`);
  const orcaDir = path.join(VENDOR, 'orcaslicer');
  fs.rmSync(orcaDir, { recursive: true, force: true });

  wrote = 0; wroteBytes = 0;
  if (src.slicer.kind === 'appimage') {
    extractAppImage(slicerZip, orcaDir);
    if (!OPT.full) {
      const res = path.join(orcaDir, src.slicer.resources);
      for (const name of EXCLUDE_RESOURCES) {
        fs.rmSync(path.join(res, name), { recursive: true, force: true });
      }
      const profiles = path.join(res, 'profiles');
      if (fs.existsSync(profiles)) {
        for (const e of fs.readdirSync(profiles)) {
          if (!KEEP_PROFILE_VENDORS.has(e.replace(/\.json$/, ''))) {
            fs.rmSync(path.join(profiles, e), { recursive: true, force: true });
          }
        }
      }
    }
  } else {
    extractZip(slicerZip, orcaDir, makeFilter(src.slicer.resources));
  }
  if (!OPT.quiet) process.stdout.write('\r' + ' '.repeat(48) + '\r');

  const slicerBin = path.join(orcaDir, src.slicer.bin);
  if (!fs.existsSync(slicerBin)) {
    fail('The slicer unpacked but its executable is not where we expect.', [
      `Looked for: ${slicerBin}`,
      'Re-run with --force --full to rule out the trim.',
    ]);
  }
  if (OPT.platform !== 'win32') fs.chmodSync(slicerBin, 0o755);

  const slicerBytes = dirSize(orcaDir);
  say(`  [ok]  OrcaSlicer unpacked  (${mb(slicerBytes)}${OPT.full ? '' : ', trimmed'})`);

  /* ---- node ---- */
  const nodeDir = path.join(VENDOR, 'node');
  fs.rmSync(nodeDir, { recursive: true, force: true });
  fs.mkdirSync(nodeDir, { recursive: true });
  let nodeVersion;

  if (src.node.local) {
    // The Node binary is self-contained, so the runtime executing this script
    // is one we can hand to the launchers. No download, no version matching.
    fs.copyFileSync(process.execPath, path.join(nodeDir, src.node.bin));
    fs.chmodSync(path.join(nodeDir, src.node.bin), 0o755);
    nodeVersion = process.version;
  } else {
    const nodeZip = await fetchVerified(src.node, `Node ${NODE_VERSION}`);
    wrote = 0; wroteBytes = 0;
    extractZip(nodeZip, nodeDir, (name) => (name === src.node.inner ? src.node.bin : null));
    if (!fs.existsSync(path.join(nodeDir, src.node.bin))) {
      fail(`Node unpacked but ${src.node.bin} is missing.`, [`Expected ${src.node.inner} inside the archive.`]);
    }
    nodeVersion = NODE_VERSION;
  }
  say(`  [ok]  Node ${nodeVersion} bundled`);

  /* ---- licences ---- */
  writeLicenses(orcaDir, src.slicer);
  say('  [ok]  licences and notices written to vendor/licenses/');

  /* ---- manifest ---- */
  fs.writeFileSync(MANIFEST, JSON.stringify({
    createdAt: new Date().toISOString(),
    platform: `${OPT.platform}-x64`,
    node: { bin: path.join('node', src.node.bin), version: nodeVersion },
    slicer: {
      name: 'OrcaSlicer',
      version: ORCA_VERSION,
      bin: path.join('orcaslicer', src.slicer.bin),
      source: src.slicer.url,
      sha256: src.slicer.sha256 || null,
      trimmed: !OPT.full,
      bytes: slicerBytes,
    },
  }, null, 2) + '\n');

  if (OPT.skipVerify || OPT.platform !== process.platform) {
    say('\n  Skipping the test slice' +
      (OPT.platform !== process.platform ? ` (built for ${OPT.platform}, running on ${process.platform}).` : '.'));
    say('  Run it on the target machine with:  node server/scripts/verify-profiles.js\n');
  } else {
    say('\n  Checking that a real slice runs against the bundled copy...\n');
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'server', 'scripts', 'verify-profiles.js')], {
        stdio: OPT.quiet ? 'ignore' : 'inherit',
        env: { ...process.env, ORCA_SLICER_BIN: '', BAMBU_STUDIO_BIN: '', VENDOR_ONLY: '1' },
      });
    } catch {
      console.error('\n' + line());
      console.error('  The bundled copy did not produce a slice.');
      console.error(line());
      console.error('\n  Try the untrimmed copy, which rules out an over-eager trim:');
      console.error('    node setup.js --force --full\n');
      console.error('  If that works, the trim dropped something this OrcaSlicer');
      console.error('  version needs - see EXCLUDE_RESOURCES in setup.js.\n');
      process.exit(1);
    }
  }

  say('\n' + line());
  say('  READY');
  say(line());
  say('\n  Everything the app needs now lives in this folder.');
  say('  Start it with the launcher for your computer, or:  node start.js\n');
}

main().catch((err) => {
  console.error('\n  Setup failed:', err && err.message ? err.message : err, '\n');
  process.exit(1);
});
