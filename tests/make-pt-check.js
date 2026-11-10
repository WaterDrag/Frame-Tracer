// Vytvoří testovací soubor upravený NetTracerem, aby šel ověřit v Packet Traceru.
const fs = require('fs'), zlib = require('zlib');
const PT = require('../js/ptcrypto.js'), F = require('../js/ptformat.js'), NM = require('../js/netmodel.js');
(async () => {
  const [src, out] = process.argv.slice(2);
  const r = await PT.decode(fs.readFileSync(src), async b => zlib.inflateSync(b));
  const { project, ctx } = F.importXml(r.xml, 'x');
  const swA = project.devices.find(d => d.name === 'SW-A');
  const pc0 = project.devices.find(d => d.name === 'PC0');
  // 1) změna konfigurace switche
  const p5 = NM.findPort(swA, 'FastEthernet0/5'); p5.vlan = 20; p5.desc = 'Upraveno NetTracerem';
  swA.cfg.bannerMotd = 'Test NetTracer';
  // 2) přesun a přejmenování PC
  pc0.x += 60; pc0.name = 'PC0-NT';
  // 3) nové PC (klon existujícího modelu) + nový kabel
  const names = new Set(project.devices.map(d => d.name));
  const nd = NM.createDevice('PC-PT', swA.x - 80, swA.y + 120, names);
  nd.name = 'PC-novy';
  const nic = nd.ports[0]; nic.ip = '192.168.10.50'; nic.mask = '255.255.255.0';
  project.devices.push(nd);
  project.links.push({ id: NM.uid('lnk'), a: { dev: nd.id, port: 'FastEthernet0' }, b: { dev: swA.id, port: 'FastEthernet0/6' }, cable: 'straight' });
  // 4) poznámky: úprava existující + nová
  if (project.notes[0]) project.notes[0].text += '\n(upraveno NetTracerem)';
  project.notes.push({ id: 'note-nt', x: swA.x - 120, y: swA.y - 60, text: 'Nová poznámka z NetTraceru' });
  const { xml, warnings } = F.exportXml(project, ctx);
  fs.writeFileSync(out, await PT.encode(xml, async b => zlib.deflateSync(b)));
  console.log('Uloženo:', out); for (const w of warnings) console.log('  ' + w);
})();
