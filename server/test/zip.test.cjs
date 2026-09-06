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

check('rejects a non-ZIP buffer with a clear error',()=>{
  assert.throws(()=>zip.listEntries(Buffer.from('nonsense'.repeat(10))),/valid ZIP/);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail===0?0:1);
