// node tests/crypto.test.js [soubor.pka ...]
const fs = require('fs');
const zlib = require('zlib');
const PT = require('../js/ptcrypto.js');

const hex = b => Buffer.from(b).toString('hex').toUpperCase();
let fail = 0;
function check(name, got, exp) {
  const ok = got === exp;
  if (!ok) fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : `\n     got ${got}\n     exp ${exp}`}`);
}

check('Q0 prefix', hex(PT._Q0.subarray(0, 4)), 'A967B3E8');
check('Q1 prefix', hex(PT._Q1.subarray(0, 4)), '75F3C6F4');
// Oficiální test vektor Twofish-128: nulový klíč, nulový blok
const tf = new PT.Twofish(new Uint8Array(16)), out = new Uint8Array(16);
tf.encryptBlock(new Uint8Array(16), 0, out, 0);
check('Twofish-128 KAT', hex(out), '9F589F5CF6122C32B6BFEC2F2AE8C35A');

const inflate = async b => new Uint8Array(zlib.inflateSync(b));
const deflate = async b => new Uint8Array(zlib.deflateSync(b));

(async () => {
  for (const f of process.argv.slice(2)) {
    const bytes = new Uint8Array(fs.readFileSync(f));
    try {
      const r = await PT.decode(bytes, inflate);
      console.log(`OK   decode ${f}: format=${r.format} tagOk=${r.tagOk} xml=${r.xml.length} znaků, začátek: ${r.xml.slice(0, 80).replace(/\s+/g, ' ')}`);
      if (r.tagOk === false) fail++;
      const re = await PT.encode(r.xml, deflate);
      const r2 = await PT.decode(re, inflate);
      check(`roundtrip ${f}`, String(r2.xml === r.xml && r2.tagOk), 'true');
    } catch (e) { fail++; console.log(`FAIL decode ${f}: ${e.message}`); }
  }
  process.exit(fail ? 1 : 0);
})();
