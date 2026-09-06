#!/usr/bin/env node
/**
 * Vibes 3D Studio — one-command launcher.
 *
 * Starts the website and the quoting API together, on one port.
 *
 *     node start.js
 *
 * No dependencies to install: the server uses only Node built-ins. That
 * removes the most common way this fails on someone else's machine — npm
 * being absent, blocked by a proxy, or refusing to run at all.
 *
 * WHY A SERVER AT ALL
 *   Opening index.html straight off disk gives you the site but no backend,
 *   so "Get exact price" has nothing to call. The page also runs on file://
 *   there, which browsers treat as a foreign origin, so even a running API
 *   would be blocked. Serving both from one HTTP origin makes the whole flow
 *   work with nothing to configure.
 */

'use strict';

const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8080);

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 18) {
  console.error(`\nThis needs Node.js 18 or newer. You have ${process.version}.`);
  console.error('Download the LTS version from https://nodejs.org\n');
  process.exit(1);
}

const line = (char = '─', n = 66) => char.repeat(n);

let createServer, installProcessGuards, diagnostics;
try {
  ({ createServer, installProcessGuards } = require(path.join(ROOT, 'server', 'src', 'index.js')));
  ({ diagnostics } = require(path.join(ROOT, 'server', 'src', 'slicer.js')));
} catch (err) {
  console.error('\nFailed to load the quoting service:\n');
  console.error(' ', err.message);
  console.error('\nMake sure you unzipped the whole folder and are running this');
  console.error('from inside it (the "server" folder must sit next to start.js).\n');
  process.exit(1);
}

// A quoting service that exits takes the storefront down with it, and from the
// browser that looks exactly like "it worked once, then couldn't connect".
installProcessGuards();

// staticDir makes the server hand out index.html/style.css/bundle.js from the
// same origin as /api/*, which is the entire point of the launcher.
const server = createServer({ staticDir: ROOT });

server.listen(PORT, async () => {
  const url = `http://localhost:${PORT}`;

  console.log('\n' + line());
  console.log('  VIBES 3D STUDIO');
  console.log(line());
  console.log(`\n  Open:  ${url}\n`);

  let diag = null;
  try {
    diag = await diagnostics();
  } catch (err) {
    console.log('  Could not run startup checks:', err.message, '\n');
  }

  if (diag) {
    console.log('  Slicing engine');
    if (diag.slicerFound && diag.slicerVendored) {
      console.log('    [ok]  OrcaSlicer - bundled in this folder');
      console.log(`          ${diag.slicerBin}`);
    } else if (diag.slicerFound) {
      console.log('    [ok]  OrcaSlicer - using the copy installed on this machine');
      console.log(`          ${diag.slicerBin}`);
      console.log('          This folder is meant to carry its own. Rebuild it with:');
      console.log('            node setup.js --force');
    } else {
      console.log('    [--]  No slicer found - and this folder should have one.');
      console.log('          A released copy of this app carries OrcaSlicer inside it,');
      console.log('          so either vendor/ was deleted or the zip was unpacked');
      console.log('          incompletely. Rebuild it:');
      console.log('            node setup.js');
      console.log('          Or point at an OrcaSlicer you already have:');
      console.log('            ORCA_SLICER_BIN=/path/to/orca-slicer');
    }

    console.log('\n  Printer profiles');
    for (const [name, info] of Object.entries(diag.profiles)) {
      if (!info.present) {
        console.log(`    [--]  ${name}: missing (${path.basename(info.path)})`);
      } else if (name === 'filament' && info.hasDensity === false) {
        console.log(`    [!!]  ${name}: present, but no filament_density set`);
        console.log('          Quotes still work (weight is derived from volume),');
        console.log('          but fixing the profile is more accurate.');
      } else {
        console.log(`    [ok]  ${name}`);
      }
    }
    if (diag.missingProfiles.length) {
      console.log('\n          Rebuild them from Bambu\'s presets:');
      console.log('            node server/scripts/build-profiles.js');
      console.log('          Then check the result end to end:');
      console.log('            node server/scripts/verify-profiles.js');
    }

    console.log('\n' + line());
    if (diag.ready) {
      console.log('  Ready. Upload a model and get a price.');
    } else {
      console.log('  The site, uploads and 3D viewer all work now.');
      console.log('  "Get exact price" needs the items marked [--] above.');
    }
    console.log(line() + '\n');
  }

  console.log('  Keep this window open while you use the site.');
  console.log('  Press Ctrl+C to stop.\n');

  if (process.env.NO_OPEN !== '1') {
    try {
      const opener =
        process.platform === 'darwin' ? ['open', [url]] :
        process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] :
        ['xdg-open', [url]];
      spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref();
    } catch { /* the printed URL still works */ }
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error('  Something else is running there — maybe another copy of this.');
    console.error(`  Try a different port:   PORT=8081 node start.js\n`);
  } else {
    console.error('\n  Server error:', err.message, '\n');
  }
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n  Shutting down.');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
