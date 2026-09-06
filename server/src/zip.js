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
const ZIP64_EOCD_SIG = 0x06064b50;   // ZIP64 end of central directory
const ZIP64_LOC_SIG = 0x07064b50;    // ZIP64 EOCD locator
const ZIP64_EXTRA_ID = 0x0001;       // ZIP64 extended information extra field

// In a ZIP64 archive the classic EOCD keeps these saturated placeholders and
// the real values live in the ZIP64 record.
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

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
 * Reads a 64-bit little-endian value as a Number.
 *
 * Sizes and offsets past 2^53 cannot be represented exactly, but they also
 * cannot occur here: MAX_GCODE_BYTES caps us far below that, and a Buffer
 * cannot hold more anyway. Failing loudly beats silently truncating.
 */
function readU64(buf, off) {
  const v = buf.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('ZIP entry is larger than this reader can address.');
  }
  return Number(v);
}

/**
 * Resolves the central directory's entry count and offset, following the ZIP64
 * records when the classic EOCD only carries placeholders.
 *
 * WHY THIS MATTERS
 *   A .3mf is a ZIP, and the tools that write them switch to ZIP64 freely —
 *   Bambu Studio does. Before this, such a file parsed as *zero entries*
 *   rather than failing: `isBambuProject` said "not a project" and
 *   `readEmbeddedSliceInfo` said "no slice info", so a customer's own sliced
 *   project was silently re-sliced with our profile and quoted from the wrong
 *   numbers. Nothing anywhere said so, which is the worst kind of wrong.
 */
function locateCentralDirectory(buf, eocd) {
  let entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (entryCount !== U16_MAX && offset !== U32_MAX) return { entryCount, offset };

  // The ZIP64 locator sits immediately before the classic EOCD.
  const loc = eocd - 20;
  if (loc < 0 || buf.readUInt32LE(loc) !== ZIP64_LOC_SIG) {
    throw new Error('ZIP64 archive is missing its end-of-central-directory locator.');
  }
  const z64 = readU64(buf, loc + 8);
  if (z64 < 0 || z64 + 56 > buf.length || buf.readUInt32LE(z64) !== ZIP64_EOCD_SIG) {
    throw new Error('ZIP64 archive is missing its end-of-central-directory record.');
  }
  entryCount = readU64(buf, z64 + 32);
  offset = readU64(buf, z64 + 48);
  return { entryCount, offset };
}

/**
 * Pulls the real size and offset out of an entry's ZIP64 extra field.
 *
 * The fields appear in a fixed order but only the ones whose 32-bit slot is
 * saturated are present, so each is consumed conditionally.
 */
function applyZip64Extra(buf, start, len, entry) {
  let p = start;
  const end = start + len;
  while (p + 4 <= end) {
    const id = buf.readUInt16LE(p);
    const size = buf.readUInt16LE(p + 2);
    const body = p + 4;
    if (id === ZIP64_EXTRA_ID) {
      let q = body;
      if (entry.uncompressedSize === U32_MAX && q + 8 <= body + size) {
        entry.uncompressedSize = readU64(buf, q); q += 8;
      }
      if (entry.compressedSize === U32_MAX && q + 8 <= body + size) {
        entry.compressedSize = readU64(buf, q); q += 8;
      }
      if (entry.localHeaderOffset === U32_MAX && q + 8 <= body + size) {
        entry.localHeaderOffset = readU64(buf, q); q += 8;
      }
      return;
    }
    p = body + size;
  }
}

/**
 * Lists entries without decompressing any of them.
 * @returns {Array<{name: string, compressedSize: number, uncompressedSize: number,
 *                  method: number, localHeaderOffset: number}>}
 */
function listEntries(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new Error('Not a valid ZIP archive (no end-of-central-directory record).');

  const { entryCount, offset: cdStart } = locateCentralDirectory(buf, eocd);
  let offset = cdStart;

  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buf.length) break;
    if (buf.readUInt32LE(offset) !== CD_SIG) break;

    const method = buf.readUInt16LE(offset + 10);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    const entry = {
      name,
      compressedSize: buf.readUInt32LE(offset + 20),
      uncompressedSize: buf.readUInt32LE(offset + 24),
      method,
      localHeaderOffset: buf.readUInt32LE(offset + 42),
    };
    if (extraLen) applyZip64Extra(buf, offset + 46 + nameLen, extraLen, entry);

    entries.push(entry);
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
