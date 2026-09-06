const assert=require('assert');
const {parseBoundary,parseMultipart}=require('../src/multipart.js');
let pass=0,fail=0;
const check=(n,f)=>{try{f();console.log('  PASS  '+n);pass++}catch(e){console.log('  FAIL  '+n+'\n        '+e.message);fail++}};
console.log('\nMultipart parser tests\n');

check('extracts boundary from content-type',()=>{
  assert.strictEqual(parseBoundary('multipart/form-data; boundary=----abc123'),'----abc123');
  assert.strictEqual(parseBoundary('multipart/form-data; boundary="quoted-x"'),'quoted-x');
});

check('binary file bytes survive round-trip exactly',()=>{
  const b='BOUNDARY123';
  // Include bytes that would corrupt under any string conversion: 0x00, 0xFF,
  // 0x80-0x9F (invalid UTF-8 continuation bytes), and a stray CRLF.
  const payload=Buffer.from([0x00,0xFF,0x80,0x9F,0x0d,0x0a,0x50,0x4b,0x03,0x04,0xC3,0x28]);
  const body=Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="model"; filename="m.stl"\r\nContent-Type: model/stl\r\n\r\n`),
    payload,
    Buffer.from(`\r\n--${b}\r\nContent-Disposition: form-data; name="multicolor"\r\n\r\ntrue\r\n--${b}--\r\n`)
  ]);
  const {fields,files}=parseMultipart(body,b);
  assert.strictEqual(files.length,1,'one file');
  assert.strictEqual(files[0].filename,'m.stl');
  assert.ok(files[0].data.equals(payload),
    'bytes differ!\n  expected '+payload.toString('hex')+'\n  got      '+files[0].data.toString('hex'));
  assert.strictEqual(fields.multicolor,'true');
});

check('parses multiple text fields',()=>{
  const b='X';
  const body=Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--${b}\r\nContent-Disposition: form-data; name="dims"\r\n\r\n{"x":200,"y":10,"z":10}\r\n--${b}--\r\n`);
  const {fields}=parseMultipart(body,b);
  assert.strictEqual(fields.a,'1');
  assert.deepStrictEqual(JSON.parse(fields.dims),{x:200,y:10,z:10});
});

check('handles empty body without throwing',()=>{
  const {fields,files}=parseMultipart(Buffer.from(''),'B');
  assert.strictEqual(files.length,0);
  assert.deepStrictEqual(fields,{});
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail===0?0:1);
