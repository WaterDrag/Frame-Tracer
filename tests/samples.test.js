// node tests/samples.test.js "<složka se .pkt>" [filtr]
// Otevře všechny .pkt/.pka, uloží, znovu otevře a zkusí pingy mezi koncovými zařízeními.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const PT = require('../js/ptcrypto.js'), F = require('../js/ptformat.js'), NM = require('../js/netmodel.js'), { Sim } = require('../js/sim.js');
const root = process.argv[2], filt = process.argv[3] ? new RegExp(process.argv[3], 'i') : null;
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(pkt|pka)$/i.test(e.name) && (!filt || filt.test(p))) files.push(p); } })(root);
const inflate = async b => zlib.inflateSync(b), deflate = async b => zlib.deflateSync(b);
(async () => {
  let okFiles = 0, errFiles = [], pings = 0, pingOk = 0;
  const pingFails = [];
  for (const f of files) {
    const rel = path.relative(root, f);
    try {
      const r = await PT.decode(fs.readFileSync(f), inflate);
      if (r.tagOk === false) throw new Error('tag');
      const { project, ctx } = F.importXml(r.xml, path.basename(f));
      const { xml } = F.exportXml(project, ctx);
      const enc = await PT.encode(xml, deflate);
      const back = await PT.decode(enc, inflate);
      const p2 = F.importXml(back.xml, 'x').project;
      if (p2.devices.length !== project.devices.length || p2.links.length !== project.links.length) throw new Error('round-trip počty');
      okFiles++;
      // pingy mezi hosty se statickou IP / DHCP
      const sim = new Sim(p2);
      const hosts = p2.devices.filter(d => NM.HOST_KINDS.has(d.kind) && d.power !== false);
      for (const h of hosts) { const n = h.ports.find(p => !p.hidden && /Ethernet/.test(p.name)); if (n && n.dhcp && !n.ip) { const d = sim.dhcp(h, n); if (d) { n.ip = d.ip; n.mask = d.mask; h.gateway = d.gw || ''; sim.touch(); } } }
      const withIp = hosts.filter(h => h.ports.some(p => p.ip && !p.hidden && sim.linkOf(h.id, p.name)));
      let fileFails = [];
      for (let i = 0; i < withIp.length; i++) for (let j = 0; j < withIp.length && j < 6; j++) {
        if (i === j) continue;
        const a = withIp[i], b = withIp[j];
        const bp = b.ports.find(p => p.ip && !p.hidden && sim.linkOf(b.id, p.name)), ip = bp.ip;
        const ap = a.ports.find(p => p.ip && !p.hidden && sim.linkOf(a.id, p.name));
        // počítej jen pingy, které mají šanci fungovat i v Packet Traceru
        if (/^169\.254\./.test(ap.ip) || /^169\.254\./.test(ip)) continue;
        if (!a.gateway && !NM.IP.sameNet(ap.ip, ip, ap.mask)) continue;
        const res = sim.ping(a, ip); pings++;
        if (res.ok) pingOk++; else fileFails.push(`${a.name}->${b.name}(${ip}):${res.reason}@${res.from ? res.from.name : '?'}`);
      }
      if (fileFails.length) pingFails.push(`${rel}: ${fileFails.length} selhalo, např. ${fileFails.slice(0, 2).join('; ')}`);
    } catch (e) { errFiles.push(`${rel}: ${e.message}`); }
  }
  console.log(`Soubory: ${okFiles}/${files.length} OK (otevřít → uložit → otevřít)`);
  for (const e of errFiles) console.log('  CHYBA ' + e);
  console.log(`Pingy mezi hosty: ${pingOk}/${pings} úspěšných`);
  for (const p of pingFails.slice(0, 60)) console.log('  ' + p);
})();
