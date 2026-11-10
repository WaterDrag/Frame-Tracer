// node tests/notes.test.js soubor.pka – poznámky: import, úprava, přidání, smazání, export
const fs = require('fs'), zlib = require('zlib');
const PT = require('../js/ptcrypto.js'), F = require('../js/ptformat.js');
let fail = 0; const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fail++; };
(async () => {
  const r = await PT.decode(fs.readFileSync(process.argv[2]), async b => zlib.inflateSync(b));
  const { project, ctx } = F.importXml(r.xml, 'x');
  ok(project.notes.length === 5 && project.notes.some(n => n.text === 'VLAN 99\n192.168.99.0/29'), 'import 5 poznámek (' + project.notes.length + ')');
  project.notes[0].text = 'Upraveno'; project.notes[0].x = 10;
  project.notes.splice(1, 1);
  project.notes.push({ id: 'note-new', x: 200, y: 50, text: 'Nová & <poznámka>' });
  const { xml } = F.exportXml(project, ctx);
  const p2 = F.importXml(xml, 'y').project;
  ok(p2.notes.length === 5, 'po exportu 5 poznámek');
  ok(p2.notes.some(n => n.text === 'Upraveno' && n.x === 10), 'úprava textu a pozice');
  ok(p2.notes.some(n => n.text === 'Nová & <poznámka>' && n.x === 200), 'nová poznámka se speciálními znaky');
  process.exit(fail ? 1 : 0);
})();
