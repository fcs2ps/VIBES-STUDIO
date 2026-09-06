'use strict';

/**
 * Minimal ZIP writer, for rewriting a .3mf we were handed.
 *
 * WHY THIS EXISTS
 *   A painted multi-colour model carries its colour assignment as a per-triangle
 *   attribute, and PrusaSlicer writes it under a different name than OrcaSlicer
 *   reads. Correcting that means rewriting one entry inside the archive and
 *   handing the result to the slicer, which needs a writer — `zip.js` only
 *   reads. See `convertPaintAttributes` in slicer.js for what and why.
 *
 * Deliberately small: store or deflate, no zip64, no encryption, no streaming.
 * The archives it produces are a few megabytes and are consumed immediately by
 * a slicer process, then deleted. Anything more is scope this does not need.
 */

const zlib = require('zlib');

const LFH_SIG = 0x04034b50;
const CD_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/** Standard CRC-32, which the ZIP format requires per entry. */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/**
 * Builds a ZIP archive.
 *
 * @param {Array<{name: string, data: Buffer, store?: boolean}>} entries
 * @returns {Buffer}
 */
function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const store = entry.store === true;
    const body = store ? raw : zlib.deflateRawSync(raw, { level: 6 });
    const method = store ? 0 : 8;
    const crc = crc32(raw);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(LFH_SIG, 0);
    lfh.writeUInt16LE(20, 4);              // version needed
    lfh.writeUInt16LE(0, 6);               // flags
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(body.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    locals.push(lfh, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(CD_SIG, 0);
    cd.writeUInt16LE(20, 4);               // version made by
    cd.writeUInt16LE(20, 6);               // version needed
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, name);

    offset += lfh.length + name.length + body.length;
  }

  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, central, eocd]);
}

module.exports = { writeZip, crc32 };
