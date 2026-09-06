const assert=require('assert');
const zip=require('../src/zip.js');
const zlib=require('zlib');
let pass=0,fail=0;
const check=(n,f)=>{try{f();console.log('  PASS  '+n);pass++}catch(e){console.log('  FAIL  '+n+'\n        '+e.message);fail++}};
console.log('\nZIP reader tests\n');

// The fixture is built here with Node's own zlib rather than shelling out to
// python3 and /tmp — the service has no dependencies, and its tests shouldn't
// acquire one that isn't present on Windows.
const CRC_TABLE=(()=>{const t=new Int32Array(256);
  for(let i=0;i<256;i++){let c=i;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[i]=c;}
  return t;})();
function crc32(buf){let c=-1;for(let i=0;i<buf.length;i++)c=CRC_TABLE[(c^buf[i])&0xff]^(c>>>8);return (c^-1)>>>0;}

/** @param {Array<{name:string,data:string,store?:boolean}>} entries */
function makeZip(entries){
  const locals=[],centrals=[];let offset=0;
  for(const e of entries){
    const name=Buffer.from(e.name,'utf8');
    const raw=Buffer.from(e.data,'utf8');
    const method=e.store?0:8;
    const body=e.store?raw:zlib.deflateRawSync(raw);
    const crc=crc32(raw);

    const lfh=Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50,0); lfh.writeUInt16LE(20,4); lfh.writeUInt16LE(0,6);
    lfh.writeUInt16LE(method,8); lfh.writeUInt16LE(0,10); lfh.writeUInt16LE(0,12);
    lfh.writeUInt32LE(crc,14); lfh.writeUInt32LE(body.length,18); lfh.writeUInt32LE(raw.length,22);
    lfh.writeUInt16LE(name.length,26); lfh.writeUInt16LE(0,28);
    locals.push(lfh,name,body);

    const cdh=Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50,0); cdh.writeUInt16LE(20,4); cdh.writeUInt16LE(20,6);
    cdh.writeUInt16LE(0,8); cdh.writeUInt16LE(method,10); cdh.writeUInt16LE(0,12); cdh.writeUInt16LE(0,14);
    cdh.writeUInt32LE(crc,16); cdh.writeUInt32LE(body.length,20); cdh.writeUInt32LE(raw.length,24);
    cdh.writeUInt16LE(name.length,28); cdh.writeUInt16LE(0,30); cdh.writeUInt16LE(0,32);
    cdh.writeUInt16LE(0,34); cdh.writeUInt16LE(0,36); cdh.writeUInt32LE(0,38);
    cdh.writeUInt32LE(offset,42);
    centrals.push(cdh,name);

    offset+=lfh.length+name.length+body.length;
  }
  const cd=Buffer.concat(centrals);
  const eocd=Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0); eocd.writeUInt16LE(0,4); eocd.writeUInt16LE(0,6);
  eocd.writeUInt16LE(entries.length,8); eocd.writeUInt16LE(entries.length,10);
  eocd.writeUInt32LE(cd.length,12); eocd.writeUInt32LE(offset,16); eocd.writeUInt16LE(0,20);
  return Buffer.concat([...locals,cd,eocd]);
}

const buf=makeZip([
  {name:'Metadata/plate_1.gcode',data:'; total filament used [g] = 123.45\nG1 X1\n'},
  {name:'Metadata/plate_2.gcode',data:'; total filament used [g] = 999.00\n'},
  {name:'stored.txt',data:'plain',store:true},
]);

check('detects a ZIP by magic number',()=>{
  assert.strictEqual(zip.isZip(buf),true);
  assert.strictEqual(zip.isZip(Buffer.from('; not a zip')),false);
});

check('lists all entries',()=>{
  const names=zip.listEntries(buf).map(e=>e.name).sort();
  assert.deepStrictEqual(names,['Metadata/plate_1.gcode','Metadata/plate_2.gcode','stored.txt']);
});

check('inflates a deflated entry correctly',()=>{
  const e=zip.listEntries(buf).find(x=>x.name==='Metadata/plate_1.gcode');
  const text=zip.readEntry(buf,e).toString('utf8');
  assert.ok(text.includes('123.45'),'got: '+text.slice(0,60));
});

/*
 * A .3mf is a ZIP, and the tools that write them use ZIP64 freely. Before the
 * reader understood it, such a file parsed as ZERO entries instead of failing:
 * isBambuProject() said "not a project" and readEmbeddedSliceInfo() said "no
 * slice info", so a customer's own sliced project was quietly re-sliced with
 * our profile and quoted from the wrong numbers, with nothing saying so.
 *
 * Built with the system zip tooling via Node's own zlib is not possible here,
 * so this constructs a minimal ZIP64 archive by hand: a classic EOCD carrying
 * the 0xFFFF/0xFFFFFFFF placeholders, plus the ZIP64 EOCD and locator that
 * hold the real values.
 */
function buildZip64(name, content) {
  const zlib = require('zlib');
  const nameBuf = Buffer.from(name, 'utf8');
  const raw = Buffer.from(content, 'utf8');
  const deflated = zlib.deflateRawSync(raw);

  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(8, 8);
  lfh.writeUInt32LE(deflated.length, 18);
  lfh.writeUInt32LE(raw.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  const local = Buffer.concat([lfh, nameBuf, deflated]);

  // Central directory entry: sizes and offset saturated, real values in extra.
  const extra = Buffer.alloc(28);
  extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(24, 2);
  extra.writeBigUInt64LE(BigInt(raw.length), 4);
  extra.writeBigUInt64LE(BigInt(deflated.length), 12);
  extra.writeBigUInt64LE(0n, 20);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(0xffffffff, 20); cd.writeUInt32LE(0xffffffff, 24);
  cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt16LE(extra.length, 30);
  cd.writeUInt32LE(0xffffffff, 42);
  const central = Buffer.concat([cd, nameBuf, extra]);

  const z64 = Buffer.alloc(56);
  z64.writeUInt32LE(0x06064b50, 0);
  z64.writeBigUInt64LE(44n, 4);
  z64.writeUInt16LE(45, 12); z64.writeUInt16LE(45, 14);
  z64.writeBigUInt64LE(1n, 24); z64.writeBigUInt64LE(1n, 32);
  z64.writeBigUInt64LE(BigInt(central.length), 40);
  z64.writeBigUInt64LE(BigInt(local.length), 48);

  const loc = Buffer.alloc(20);
  loc.writeUInt32LE(0x07064b50, 0);
  loc.writeBigUInt64LE(BigInt(local.length + central.length), 8);
  loc.writeUInt32LE(1, 16);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 8); eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(0xffffffff, 12); eocd.writeUInt32LE(0xffffffff, 16);

  return Buffer.concat([local, central, z64, loc, eocd]);
}

const z64buf = buildZip64('Metadata/slice_info.config', '<filament used_g="134.15"/>');

check('reads a ZIP64 archive rather than reporting it empty',()=>{
  const names=zip.listEntries(z64buf).map(e=>e.name);
  assert.deepStrictEqual(names,['Metadata/slice_info.config']);
});

check('resolves ZIP64 sizes and offsets from the extra field',()=>{
  const e=zip.listEntries(z64buf)[0];
  assert.strictEqual(e.uncompressedSize,27);
  assert.strictEqual(e.localHeaderOffset,0);
  assert.ok(zip.readEntry(z64buf,e).toString('utf8').includes('134.15'));
});

check('rejects a non-ZIP buffer with a clear error',()=>{
  assert.throws(()=>zip.listEntries(Buffer.from('nonsense'.repeat(10))),/valid ZIP/);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail===0?0:1);
