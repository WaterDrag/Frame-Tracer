// node tests/format.test.js soubor.pka ...
const fs = require('fs'), zlib = require('zlib');
const PT = require('../js/ptcrypto.js'), X = require('../js/ptxml.js'), F = require('../js/ptformat.js'), NM = require('../js/netmodel.js');
let fail = 0;
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fail++; };
// md5crypt / type7 známé hodnoty
ok(NM.md5crypt('password', 'saltsalt') === '$1$saltsalt$qjXMvbEw8oaL.CzflDtaK/', 'md5crypt vektor');
ok(NM.checkSecret('class', '$1$mERr$9cTjUIEqNGurQiFU.ZeCi1'), 'enable secret z PKA ověřen');
ok(NM.type7dec('0822455D0A16') === 'cisco', 'type7 dekódování');
ok(NM.type7dec(NM.type7enc('class')) === 'class', 'type7 roundtrip');
(async () => {
  for (const f of process.argv.slice(2)) {
    const { xml } = await PT.decode(fs.readFileSync(f), async b => zlib.inflateSync(b));
    ok(X.serialize(X.parse(xml)) === xml, 'XML bezztrátový roundtrip ' + f.split(/[\/]/).pop());
    const t0 = Date.now();
    const { project, ctx } = F.importXml(xml, f.split(/[\/]/).pop());
    console.log(`     import ${Date.now() - t0} ms: ${project.devices.length} zařízení, ${project.links.length} linek, instrukce: ${project.instructions ? project.instructions.length + ' znaků' : 'ne'}`);
    for (const d of project.devices) console.log(`     - ${d.name} [${d.ptType}/${d.model}] @${d.x},${d.y} porty: ${d.ports.filter(p => !p.hidden).map(p => p.name + (p.ip ? '=' + p.ip : '')).slice(0, 6).join(', ')}${d.ports.length > 6 ? '…' : ''}${d.cfg ? ' host=' + d.cfg.hostname + ' vlans=' + Object.keys(d.cfg.vlans).join('/') : ''}`);
    for (const l of project.links) {
      const a = project.devices.find(d => d.id === l.a.dev), b = project.devices.find(d => d.id === l.b.dev);
      ok(NM.findPort(a, l.a.port) && NM.findPort(b, l.b.port) && !NM.findPort(a, l.a.port).hidden, `link ${a.name}:${l.a.port} <-> ${b.name}:${l.b.port} (${l.cable})`);
    }
    // export beze změn -> import -> stejné
    const { xml: x2, warnings } = F.exportXml(project, ctx);
    const r2 = F.importXml(x2, 'x').project;
    ok(r2.devices.length === project.devices.length && r2.links.length === project.links.length, 'export/import zachová počty, varování: ' + warnings.length);
    const sw = r2.devices.find(d => d.ios);
    if (sw) console.log('     ukázka generovaného configu:', NM.generateConfig(sw).slice(0, 14).join(' | '));
    // re-encrypt
    const enc = await PT.encode(x2, async b => zlib.deflateSync(b));
    const back = await PT.decode(enc, async b => zlib.inflateSync(b));
    ok(back.xml === x2 && back.tagOk, 'zašifrovaný export jde znovu otevřít');
  }
  process.exit(fail ? 1 : 0);
})();
