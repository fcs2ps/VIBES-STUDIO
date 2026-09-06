'use strict';

/**
 * Vibes 3D Studio quoting service — zero external dependencies.
 *
 * Uses only Node built-ins (http, fs, path, crypto, zlib), so there is no
 * `npm install` step and nothing to fail on a machine without network access,
 * behind a corporate proxy, or with a restricted npm setup.
 *
 * Serves the API and, optionally, the static site from the same origin —
 * which is what lets the browser's fetch('/api/quote') work with no CORS
 * configuration at all.
 */

const http = require('http');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { promises: fsp } = require('fs');

const { sliceModel, readEmbeddedSliceInfo, diagnostics, SliceError } = require('./slicer');
const { computeQuote, CONFIG } = require('./pricing');
const { parseBoundary, readBody, parseMultipart } = require('./multipart');

// Ceiling for a buffered multipart upload. This one is held in memory (and
// copied again while the parts are split), so it stays modest.
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 100 * 1024 * 1024);

// Ceiling for a raw-body upload, which streams straight to disk at constant
// memory. A detailed model is bigger than it looks: a .3mf is compressed XML,
// but we send the mesh as uncompressed binary STL at 50 bytes per triangle,
// so a 2M-triangle model is a ~100 MB body from a 15 MB file.
const MAX_STREAM_BYTES = Number(process.env.MAX_STREAM_BYTES || 512 * 1024 * 1024);

/*
 * One slice at a time by default.
 *
 * Bambu Studio's CLI is itself multi-threaded and will happily use every core
 * it can see. Running two of them on a shop's desktop doesn't halve the wall
 * clock — they fight for CPU and memory, each slice gets slower, and the Node
 * process that has to answer /api/health is competing with them for the same
 * machine. Serialising costs a little throughput under load and buys a server
 * that keeps answering, which is the trade we want.
 */
const MAX_CONCURRENT_SLICES = Number(process.env.MAX_CONCURRENT_SLICES || 1);

// Past this many people waiting, new arrivals are told to come back rather
// than joining a queue they'd time out in anyway. An unbounded queue is how a
// busy server turns into an unresponsive one.
const MAX_QUEUE_DEPTH = Number(process.env.MAX_QUEUE_DEPTH || 8);
const QUEUE_WAIT_TIMEOUT_MS = Number(process.env.QUEUE_WAIT_TIMEOUT_MS || 150000);

const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

/* --------------------------------------------------------------- concurrency */

class BusyError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BusyError';
    this.code = code;
  }
}

let activeSlices = 0;
let waiting = [];

/**
 * Waits for a slicing slot.
 *
 * Rejects rather than queueing forever: a customer staring at a spinner that
 * will never resolve is worse than being told the shop is busy.
 */
function acquireSlot() {
  if (activeSlices < MAX_CONCURRENT_SLICES) {
    activeSlices++;
    return Promise.resolve(() => {});
  }
  if (waiting.length >= MAX_QUEUE_DEPTH) {
    return Promise.reject(new BusyError(
      'The shop is busy quoting other models right now. Try again in a minute.',
      'BUSY'
    ));
  }

  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, done: false };
    const timer = setTimeout(() => {
      if (waiter.done) return;
      waiter.done = true;
      waiting = waiting.filter((w) => w !== waiter);
      reject(new BusyError(
        'Quoting is taking longer than usual. Try again in a minute.',
        'BUSY_TIMEOUT'
      ));
    }, QUEUE_WAIT_TIMEOUT_MS);
    // Never let a pending quote hold the process open on shutdown.
    if (timer.unref) timer.unref();
    waiter.timer = timer;
    waiting.push(waiter);
  });
}

function releaseSlot() {
  // Skip anyone who timed out or hung up while queued, so a permit is never
  // handed to a request that has already gone.
  while (waiting.length) {
    const next = waiting.shift();
    if (next.done) continue;
    next.done = true;
    clearTimeout(next.timer);
    return next.resolve(() => {});
  }
  activeSlices = Math.max(0, activeSlices - 1);
}

/* -------------------------------------------------------------------- helpers */

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': CORS_ORIGIN,
  });
  res.end(payload);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/**
 * Top-level folders that sit next to the site but are not part of it.
 *
 * The launcher serves the whole app folder so that index.html and /api/* share
 * an origin. That convenience would otherwise publish everything else in the
 * folder too — the vendored slicer and Node binaries, and the server source
 * with the pricing rules in it. Nothing here is needed by the browser.
 */
const PRIVATE_DIRS = new Set(['vendor', 'server', 'src', 'node_modules', '.git']);

function serveStatic(req, res, rootDir) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return sendJson(res, 400, { error: 'Bad URL' });
  }
  if (urlPath === '/') urlPath = '/index.html';

  // Resolve, then confirm the result stayed inside rootDir, so a crafted path
  // like /../../etc/passwd can't escape the served directory.
  const resolved = path.resolve(rootDir, '.' + urlPath);
  const rel = path.relative(rootDir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  if (PRIVATE_DIRS.has(rel.split(path.sep)[0])) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }

  fs.stat(resolved, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(resolved).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // The bundle changes on every rebuild; don't let a cached copy hide edits.
    if (resolved.endsWith('bundle.js')) headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    fs.createReadStream(resolved).pipe(res);
  });
}

/**
 * Sends a response and then closes the connection.
 *
 * The old code called `req.destroy()` the moment an upload went over the limit,
 * which tore the socket down before the 413 could be written — so the browser
 * saw a bare connection reset and reported "couldn't reach the quoting
 * service" for what was really "your model is too big". Write the response
 * first, close only once it has flushed.
 */
function respondAndClose(res, status, payload) {
  res.setHeader('Connection', 'close');
  const socket = res.socket;
  res.once('finish', () => {
    // Give the response a moment to leave the wire before dropping a client
    // that may still be sending.
    setTimeout(() => { if (socket && !socket.destroyed) socket.destroy(); }, 250).unref();
  });
  sendJson(res, status, payload);
}

/**
 * Streams the request body straight to a file on disk.
 *
 * WHY NOT BUFFER IT
 *   The multipart path holds the whole upload in memory and then copies it
 *   again to split the parts — roughly three times the file size resident at
 *   once. That is what put a hard 100 MB ceiling on uploads, and a detailed
 *   model hits it easily: a .3mf is compressed XML on disk, but we upload it
 *   as uncompressed binary STL at 50 bytes per triangle, so a 2M-triangle
 *   model is a ~100 MB body from a file that looked like 15 MB.
 *
 *   Streaming to disk costs constant memory no matter how large the model is,
 *   which is why this path's ceiling can be much higher than the buffered
 *   one's.
 */
function streamToFile(req, destPath, maxBytes) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    let total = 0;
    let settled = false;

    const fail = (code, message) => {
      if (settled) return;
      settled = true;
      req.unpipe(out);
      out.destroy();
      const err = new Error(message);
      err.code = code;
      reject(err);
    };

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) fail('FILE_TOO_LARGE', 'Payload too large');
    });
    req.on('aborted', () => fail('ABORTED', 'Upload aborted'));
    req.on('error', (err) => fail(err.code || 'REQ_ERROR', err.message));
    out.on('error', (err) => fail('WRITE_ERROR', err.message));
    // 'close', not 'finish': finish only means the bytes were handed to the
    // OS, while the file descriptor is still open. Windows refuses a second
    // process a read handle on a file we still hold open for writing, so
    // resolving on 'finish' hands the slicer a file it cannot parse.
    out.on('close', () => {
      if (settled) return;
      settled = true;
      resolve(total);
    });

    req.pipe(out);
  });
}

/**
 * Reads the model out of a request, by whichever route it arrived.
 *
 * Two shapes are supported on purpose. The browser sends the raw mesh as the
 * request body with its metadata in the query string, which is what lets the
 * upload stream to disk. `multipart/form-data` still works for curl, the test
 * suite, and anything else pointed at this endpoint.
 *
 * @returns {Promise<{modelPath: string, dims: object|null, multicolor: boolean}>}
 */
async function receiveModel(req, workDir, requestId) {
  const url = new URL(req.url, 'http://localhost');
  const contentType = req.headers['content-type'] || '';
  const boundary = parseBoundary(contentType);

  const readDims = (raw) => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (['x', 'y', 'z'].every((k) => Number.isFinite(parsed[k]) && parsed[k] > 0)) return parsed;
    } catch { /* dims are optional */ }
    return null;
  };

  const badRequest = (message, code) => {
    const err = new Error(message);
    err.httpStatus = 400;
    err.code = code || 'BAD_REQUEST';
    return err;
  };

  if (boundary) {
    const body = await readBody(req, MAX_UPLOAD_BYTES);
    const { fields, files } = parseMultipart(body, boundary);
    const file = files.find((f) => f.field === 'model');
    if (!file || file.data.length === 0) throw badRequest('No model file was uploaded.');
    if (!/\.(stl|3mf|obj)$/i.test(file.filename)) {
      throw badRequest('Only .stl, .3mf, and .obj files are accepted.');
    }
    const modelPath = path.join(workDir, 'model' + path.extname(file.filename).toLowerCase());
    await fsp.writeFile(modelPath, file.data);
    return {
      modelPath,
      dims: readDims(fields.dims),
      multicolor: fields.multicolor === 'true',
      colorCount: Number(fields.colors) || 1,
      material: fields.material,
    };
  }

  // Raw-body upload. The extension decides how the slicer reads the file, so
  // it is validated rather than trusted straight from the query string.
  const name = url.searchParams.get('name') || 'model.stl';
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (!['stl', '3mf', 'obj'].includes(ext)) {
    throw badRequest('Only .stl, .3mf, and .obj files are accepted.');
  }

  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_STREAM_BYTES) {
    const err = new Error('Payload too large');
    err.code = 'FILE_TOO_LARGE';
    err.declared = declared;
    throw err;
  }

  const modelPath = path.join(workDir, 'model.' + ext);
  const written = await streamToFile(req, modelPath, MAX_STREAM_BYTES);
  if (written === 0) throw badRequest('No model file was uploaded.');

  return {
    modelPath,
    dims: readDims(url.searchParams.get('dims')),
    multicolor: url.searchParams.get('multicolor') === 'true',
    colorCount: Number(url.searchParams.get('colors')) || 1,
    material: url.searchParams.get('material'),
  };
}

/* --------------------------------------------------------------------- routes */

async function handleHealth(req, res) {
  let diag = null;
  try {
    diag = await diagnostics();
  } catch { /* report what we can */ }

  sendJson(res, 200, {
    ok: true,
    slicer: diag && diag.slicerFound ? 'ready' : 'unavailable',
    setup: diag ? {
      ready: diag.ready,
      slicerFound: diag.slicerFound,
      // Which program produced this price, and whether it came from the copy
      // bundled in the app folder or one installed on the host. Production
      // quotes with Bambu Studio; OrcaSlicer is the development fallback.
      slicerEngine: diag.slicerEngine,
      slicerLabel: diag.slicerLabel,
      slicerVendored: diag.slicerVendored,
      engineRefused: diag.engineRefused,
      missingProfiles: diag.missingProfiles,
    } : null,
    queueDepth: waiting.length,
    activeSlices,
    pricing: {
      minimumCharge: CONFIG.minimumCharge,
      defaultMaterial: CONFIG.defaultMaterial,
      materials: Object.entries(CONFIG.materials).map(([key, m]) => ({
        key,
        label: m.label,
        costPerGram: m.costPerGram,
      })),
    },
  });
}

async function handleQuote(req, res) {
  const requestId = crypto.randomUUID();

  // Scratch space for the upload, removed in the finally below whatever
  // happens next.
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vibes-upload-'));
  const cleanup = () => fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});

  let received;
  try {
    received = await receiveModel(req, workDir, requestId);
  } catch (err) {
    await cleanup();
    if (err.code === 'FILE_TOO_LARGE') {
      const mb = (n) => Math.round(n / (1024 * 1024));
      return respondAndClose(res, 413, {
        error: 'This model is too detailed to quote automatically. It comes to more than ' +
          mb(MAX_STREAM_BYTES) + ' MB of mesh data \u2014 try reducing its detail, or ' +
          'send it to us directly.',
        code: 'FILE_TOO_LARGE',
        requestId,
      });
    }
    if (err.code === 'ABORTED') return;   // the customer navigated away
    return sendJson(res, err.httpStatus || 400, {
      error: err.httpStatus ? err.message : 'Upload failed.',
      code: err.code,
      requestId,
    });
  }

  const { modelPath, dims } = received;

  // Colors drive purge and prime tower, which are real grams on the plate.
  const colorCount = Math.max(1, Math.min(16, Math.round(received.colorCount || 1)));

  // An unknown material would otherwise slice with PLA and bill at PLA's rate
  // while the customer believes they ordered something else.
  const material = CONFIG.materials[received.material] ? received.material : CONFIG.defaultMaterial;

  if (dims) {
    const { width, depth, height } = CONFIG.bed;
    if (dims.x > width || dims.z > depth || dims.y > height) {
      await cleanup();
      return sendJson(res, 422, {
        error: 'That model is larger than the P2S build volume.',
        code: 'EXCEEDS_BED',
        requestId,
      });
    }
  }

  try {
    await acquireSlot();
  } catch (err) {
    await cleanup();
    if (err instanceof BusyError) {
      res.setHeader('Retry-After', '60');
      return sendJson(res, 503, { error: err.message, code: err.code, requestId });
    }
    throw err;
  }

  const startedAt = Date.now();
  try {
    /*
     * If the customer uploaded a project they already sliced in Bambu Studio,
     * it carries Bambu's own per-filament totals. Those beat anything we can
     * compute: they include the real purge and prime tower for the actual
     * color layout, which an uploaded mesh gives us no way to work out.
     */
    const embedded = await readEmbeddedSliceInfo(modelPath);
    if (embedded) {
      const quote = computeQuote({
        weightGrams: embedded.grams,
        material,
        colorCount: embedded.filaments.length,
        breakdown: embedded.breakdown,
      });
      return sendJson(res, 200, {
        requestId,
        quote,
        slice: {
          weightGrams: embedded.grams,
          weightSource: 'bambu_project',
          filaments: embedded.filaments,
          breakdown: embedded.breakdown,
          printTimeSeconds: embedded.timeSeconds,
          profileMissingDensity: false,
        },
        elapsedMs: Date.now() - startedAt,
      });
    }

    const stats = await sliceModel(modelPath, {
      material,
      fallbackDensity: CONFIG.materials[material].density,
    });
    // Everything the purge and tower estimate needs comes from the slice
    // itself - layer count, the flush volume Bambu publishes, and the density
    // of the filament actually loaded.
    const quote = computeQuote({
      weightGrams: stats.weightGrams,
      material,
      colorCount,
      breakdown: stats.breakdown,
    });

    sendJson(res, 200, {
      requestId,
      quote,
      slice: {
        weightGrams: Math.round(stats.weightGrams * 100) / 100,
        layerCount: stats.layerCount,
        breakdown: stats.breakdown,
        filaments: stats.filaments || null,
        usedProjectSettings: !!stats.usedProjectSettings,
        weightSource: stats.weightSource,
        volumeCm3: stats.volumeCm3,
        lengthMm: stats.lengthMm,
        printTimeSeconds: stats.timeSeconds,
        profileMissingDensity: stats.profileMissingDensity,
      },
      elapsedMs: Date.now() - startedAt,
    });
  } catch (err) {
    if (err instanceof SliceError) {
      console.error(`[${requestId}] slice error ${err.code}:`, err.detail || err.message);
      const status = err.code === 'SLICE_TIMEOUT' ? 504
        : err.code === 'PROFILE_MISSING' ? 503
        : 422;
      return sendJson(res, status, { error: err.message, code: err.code, requestId });
    }
    console.error(`[${requestId}] unexpected error:`, err);
    sendJson(res, 500, { error: 'Unexpected error while generating your quote.', requestId });
  } finally {
    releaseSlot();
    await cleanup();
  }
}

/* --------------------------------------------------------------------- server */

/**
 * @param {object} opts
 * @param {string|null} opts.staticDir  also serve the site from here, or null for API only
 */
function createServer(opts = {}) {
  const staticDir = opts.staticDir || null;

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': CORS_ORIGIN,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    try {
      if (pathname === '/api/health' && req.method === 'GET') {
        return await handleHealth(req, res);
      }
      if (pathname === '/api/quote' && req.method === 'POST') {
        return await handleQuote(req, res);
      }
      if (pathname === '/api/orders' && req.method === 'POST') {
        // PLACEHOLDER: payment. When wiring up Stripe, send the requestId and
        // re-verify the price here rather than trusting a client-side total.
        return sendJson(res, 501, {
          error: 'Payment processing is not connected yet.',
          code: 'NOT_IMPLEMENTED',
        });
      }
      if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'Unknown endpoint.' });
      }

      if (staticDir) return serveStatic(req, res, staticDir);

      sendJson(res, 404, { error: 'Not found.' });
    } catch (err) {
      console.error('Unhandled request error:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error.' });
      else res.end();
    }
  });

  /*
   * A slice can legitimately run for minutes, so the socket has to be allowed
   * to sit idle for longer than Node's defaults permit — otherwise the server
   * hangs up mid-quote and the browser reports a connection error for work
   * that was actually still progressing.
   *
   * `requestTimeout` still bounds how long a single request may take overall,
   * so a stuck client can't pin a socket open forever.
   */
  server.keepAliveTimeout = 75000;
  server.headersTimeout = 80000;
  server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 600000);

  // A socket error (the browser tab closing mid-upload is the common one) must
  // not reach the process-level handler as an unhandled 'error' event.
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    else socket.destroy();
  });

  return server;
}

/**
 * Keeps the process alive through faults that would otherwise kill it.
 *
 * The failure the shop actually sees is "it worked once, then the page
 * couldn't connect" — which is what a crashed server looks like from a
 * browser. A quoting service that drops a request is annoying; one that exits
 * takes the whole storefront down until somebody notices the window closed.
 * Log loudly, stay up.
 */
function installProcessGuards() {
  process.on('uncaughtException', (err) => {
    console.error('\n  [uncaught exception] the server is staying up:\n ', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('\n  [unhandled rejection] the server is staying up:\n ', reason);
  });
}

module.exports = { createServer, installProcessGuards };

if (require.main === module) {
  const PORT = Number(process.env.PORT || 8080);
  createServer().listen(PORT, () => {
    console.log(`Vibes 3D quote service listening on :${PORT}`);
  });
}
