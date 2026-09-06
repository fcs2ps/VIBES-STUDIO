'use strict';

/**
 * Minimal ZIP reader built on Node's bundled zlib.
 *
 * Replaces the fflate dependency. We only ever need to pull one named entry
 * (a plate's G-code) out of a slicer-produced .3mf, so a full ZIP library is
 * more than the job requires — and every dependency removed is one less thing
 * that has to install successfully on someone else's machine.
 *
 * Supports store (method 0) and deflate (method 8), which is everything a
 * slicer emits.
 */

const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;         // end of central directory
const CD_SIG = 0x02014b50;           // central directory file header
const LFH_SIG = 0x04034b50;          // local file header

function findEndOfCentralDirectory(buf) {
  // The EOCD sits at the end, after a comment of up to 65535 bytes.
  const maxScan = Math.min(buf.length, 65535 + 22);
  for (let i = buf.length - 22; i >= buf.length - maxScan; i--) {
    if (i < 0) break;
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Lists entries without decompressing any of them.
 * @returns {Array<{name: string, compressedSize: number, uncompressedSize: number,
 *                  method: number, localHeaderOffset: number}>}
 */
function listEntries(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new Error('Not a valid ZIP archive (no end-of-central-directory record).');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buf.length) break;
    if (buf.readUInt32LE(offset) !== CD_SIG) break;

    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    entries.push({ name, compressedSize, uncompressedSize, method, localHeaderOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Decompresses a single entry.
 * @param {Buffer} buf
 * @param {object} entry  from listEntries()
 * @returns {Buffer}
 */
function readEntry(buf, entry) {
  const lfh = entry.localHeaderOffset;
  if (buf.readUInt32LE(lfh) !== LFH_SIG) {
    throw new Error('Corrupt ZIP: bad local file header for ' + entry.name);
  }
  // The local header repeats the name/extra lengths, and they can differ from
  // the central directory's, so read them here rather than reusing those.
  const nameLen = buf.readUInt16LE(lfh + 26);
  const extraLen = buf.readUInt16LE(lfh + 28);
  const dataStart = lfh + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
}

/**
 * Inflates an entry but keeps only its first `headBytes` and last `tailBytes`.
 *
 * WHY THIS EXISTS
 *   Plate G-code for a bed-filling model runs to hundreds of megabytes, and
 *   every byte of it is toolpath we don't care about — the summary comments we
 *   price from live in the header and footer. `readEntry` inflates the whole
 *   thing into one Buffer and the caller then converts it to one String, which
 *   means roughly 2x its size resident and a synchronous stall long enough to
 *   stop the server answering anything at all, including /api/health. On a big
 *   enough plate it simply runs out of memory and takes the process with it.
 *
 *   This streams instead, holding only the two ends, so peak memory is a fixed
 *   ~128 KB no matter how large the plate is, and the event loop keeps turning
 *   while it works.
 *
 * @returns {Promise<{head: Buffer, tail: Buffer, totalBytes: number}>}
 */
function readEntryEnds(buf, entry, headBytes = 65536, tailBytes = 65536, maxBytes = Infinity) {
  const lfh = entry.localHeaderOffset;
  if (buf.readUInt32LE(lfh) !== LFH_SIG) {
    return Promise.reject(new Error('Corrupt ZIP: bad local file header for ' + entry.name));
  }
  const nameLen = buf.readUInt16LE(lfh + 26);
  const extraLen = buf.readUInt16LE(lfh + 28);
  const dataStart = lfh + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize);

  // Stored entries need no inflating, so slice the two ends straight out.
  if (entry.method === 0) {
    return Promise.resolve({
      head: Buffer.from(data.subarray(0, headBytes)),
      tail: Buffer.from(data.subarray(Math.max(0, data.length - tailBytes))),
      totalBytes: data.length,
    });
  }
  if (entry.method !== 8) {
    return Promise.reject(
      new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`)
    );
  }

  return new Promise((resolve, reject) => {
    const inflate = zlib.createInflateRaw();
    const headChunks = [];
    let headLen = 0;
    let tail = Buffer.alloc(0);
    let total = 0;
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      inflate.removeAllListeners();
      inflate.destroy();
      fn(arg);
    };

    inflate.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        const err = new Error('Entry exceeds the maximum decompressed size.');
        err.code = 'TOO_LARGE';
        err.totalBytes = total;
        return finish(reject, err);
      }
      if (headLen < headBytes) {
        const want = Math.min(headBytes - headLen, chunk.length);
        headChunks.push(chunk.subarray(0, want));
        headLen += want;
      }
      // Keep a rolling window of the last tailBytes and drop everything else.
      tail = tail.length === 0 && chunk.length >= tailBytes
        ? chunk.subarray(chunk.length - tailBytes)
        : Buffer.concat([tail, chunk]);
      if (tail.length > tailBytes) tail = tail.subarray(tail.length - tailBytes);
    });

    inflate.on('end', () => finish(resolve, {
      head: Buffer.concat(headChunks, headLen),
      tail: Buffer.from(tail),
      totalBytes: total,
    }));
    inflate.on('error', (err) => finish(reject, err));

    // Feed the compressed bytes in slices, yielding between them, so a large
    // entry never monopolises the event loop.
    const CHUNK = 1 << 20;
    let offset = 0;
    const pump = () => {
      if (settled) return;
      if (offset >= data.length) return inflate.end();
      const next = data.subarray(offset, offset + CHUNK);
      offset += CHUNK;
      if (inflate.write(next)) setImmediate(pump);
      else inflate.once('drain', pump);
    };
    pump();
  });
}

/**
 * Inflates an entry and hands it to `onChunk` a piece at a time.
 *
 * Same reasoning as readEntryEnds: plate G-code runs to hundreds of megabytes
 * and must never be resident in one buffer. This exists for the cases that
 * genuinely need every byte - totalling extrusion per feature, say - where the
 * caller keeps only running sums and the data itself is discarded as it flows.
 *
 * @returns {Promise<number>} total uncompressed bytes seen
 */
function streamEntry(buf, entry, onChunk, maxBytes = Infinity) {
  const lfh = entry.localHeaderOffset;
  if (buf.readUInt32LE(lfh) !== LFH_SIG) {
    return Promise.reject(new Error('Corrupt ZIP: bad local file header for ' + entry.name));
  }
  const nameLen = buf.readUInt16LE(lfh + 26);
  const extraLen = buf.readUInt16LE(lfh + 28);
  const dataStart = lfh + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) {
    onChunk(data);
    return Promise.resolve(data.length);
  }
  if (entry.method !== 8) {
    return Promise.reject(new Error('Unsupported ZIP compression method ' + entry.method));
  }

  return new Promise((resolve, reject) => {
    const inflate = zlib.createInflateRaw();
    let total = 0;
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      inflate.removeAllListeners();
      inflate.destroy();
      fn(arg);
    };

    inflate.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        const err = new Error('Entry exceeds the maximum decompressed size.');
        err.code = 'TOO_LARGE';
        return finish(reject, err);
      }
      try { onChunk(chunk); } catch (e) { finish(reject, e); }
    });
    inflate.on('end', () => finish(resolve, total));
    inflate.on('error', (err) => finish(reject, err));

    const CHUNK = 1 << 20;
    let offset = 0;
    const pump = () => {
      if (settled) return;
      if (offset >= data.length) return inflate.end();
      const next = data.subarray(offset, offset + CHUNK);
      offset += CHUNK;
      if (inflate.write(next)) setImmediate(pump);
      else inflate.once('drain', pump);
    };
    pump();
  });
}

function isZip(buf) {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
}

module.exports = { listEntries, readEntry, readEntryEnds, streamEntry, isZip };
