/*
 * ptformat.js – převod XML Packet Traceru <-> model Frame-Traceru.
 * Export funguje "záplatováním" původního XML: co Frame-Tracer nezná,
 * zůstane v souboru beze změny.
 */
(function (root) {
  'use strict';
  const X = (typeof module !== 'undefined' && module.exports) ? require('./ptxml.js') : root.PTXml;
  const NM = (typeof module !== 'undefined' && module.exports) ? require('./netmodel.js') : root.NetModel;

  const PORT_PREFIX = {
    eCopperFastEthernet: 'FastEthernet', eFiberFastEthernet: 'FastEthernet', eCopperGigabitEthernet: 'GigabitEthernet',
    eFiberGigabitEthernet: 'GigabitEthernet', eCopperTenGigabitEthernet: 'TenGigabitEthernet', eFiberTenGigabitEthernet: 'TenGigabitEthernet',
    eCopperEthernet: 'Ethernet', eFiberEthernet: 'Ethernet', eSerial: 'Serial', eModem: 'Modem', eHostWireless: 'Wireless',
    eAccessPointWireless: 'Port', eCoaxial: 'Coaxial', eUsb: 'Usb', eRS232: 'RS 232', eConsole: 'Console', eAux: 'Aux',
    eBluetooth: 'Bluetooth', eTrs35: 'RS 232', eCellular: 'Cellular', eCopperCoaxial: 'Coaxial', eCustomIoE: 'D', eCopperGigabitEthernetPoE: 'GigabitEthernet'
  };
  const HIDDEN_PORT = /^(eTrs35|eUsb|eRS232|eConsole|eAux|eBluetooth|eCustomIoE|eCellular)/;
  const MEDIA = t => /Fiber/.test(t) ? 'fiber' : /Serial/.test(t) ? 'serial' : /Wireless|Cellular|Bluetooth/.test(t) ? 'wireless'
    : /RS232|Console|Aux/.test(t) ? 'console' : /Ethernet/.test(t) ? 'copper' : 'other';
  const CABLE = { eStraightThrough: 'straight', eCrossOver: 'cross', eFiber: 'fiber', eSerialDCE: 'serial', eSerialDTE: 'serial', eConsole: 'console', eCoaxial: 'coax', ePhone: 'phone', eUsbCable: 'usb', eOctal: 'octal' };
  const CABLE_PT = { straight: ['eCopper', 'eStraightThrough'], cross: ['eCopper', 'eCrossOver'], fiber: ['eFiber', 'eFiber'], serial: ['eSerial', 'eSerialDCE'], console: ['eConsole', 'eConsole'], coax: ['eCoaxial', 'eCoaxial'] };
  const SKIP_TYPES = new Set(['Power Distribution Device', 'Sniffer']);

  function netRoot(doc) {
    const top = doc.children.find(X.isEl);
    if (!top) throw new Error('Prázdný XML dokument');
    if (top.name === 'PACKETTRACER5') return { top, pt: top, activity: false };
    if (top.name === 'PACKETTRACER5_ACTIVITY') return { top, pt: X.kid(top, 'PACKETTRACER5'), activity: true };
    throw new Error('Neznámý formát: kořen <' + top.name + '>');
  }

  /** Projde moduly a vrátí porty v pořadí dokumentu i s cestou slotů. */
  function collectPorts(engine) {
    const out = [];
    (function walk(mod, slotPath) {
      for (const c of mod.children) {
        if (c.name === 'SLOT') {
          const idx = X.kids(mod, 'SLOT').indexOf(c);
          for (const m of X.kids(c, 'MODULE')) walk(m, slotPath.concat(idx));
        } else if (c.name === 'PORT') out.push({ el: c, slotPath, idx: X.kids(mod, 'PORT').indexOf(c) });
        else if (c.name === 'MODULE') walk(c, slotPath);
      }
    })(X.kid(engine, 'MODULE') || { children: [] }, []);
    return out;
  }

  function importXml(xml, fileName) {
    const doc = X.parse(xml);
    const { top, pt, activity } = netRoot(doc);
    return importPt(doc, top, pt, activity, fileName);
  }
  /** Vzorové řešení aktivity (.pka má uvnitř 2. síť = odpověď) – vrací projekt nebo null */
  function importAnswer(ctx) {
    if (!ctx || !ctx.top || ctx.top.name !== 'PACKETTRACER5_ACTIVITY') return null;
    const pts = X.kids(ctx.top, 'PACKETTRACER5');
    if (pts.length < 2) return null;
    try { return importPt(ctx.doc, ctx.top, pts[1], true, 'answer').project; } catch (e) { return null; }
  }
  function importPt(doc, top, pt, activity, fileName) {
    const network = X.kid(pt, 'NETWORK');
    const project = {
      version: 1, name: (fileName || 'sit').replace(/\.(pkt|pka|xml)$/i, ''),
      devices: [], links: [], notes: [],
      instructions: null, description: '',
      source: { kind: activity ? 'pka' : 'pkt', fileName: fileName || 'sit.pkt', ptVersion: X.text(X.kid(pt, 'VERSION')) }
    };
    const ctx = { doc, top, pt, network, devEl: new Map(), linkEl: new Map(), portEl: new Map(), noteEl: new Map(), skippedRefs: new Set() };

    // popis / instrukce
    const desc = X.kid(network, 'DESCRIPTION');
    if (desc) project.description = X.text(desc);
    if (activity) {
      const page = X.path(top, 'ACTIVITY/INSTRUCTIONS/PAGE');
      if (page) project.instructions = X.text(page);
    }

    for (const dEl of X.kids(X.kid(network, 'DEVICES'), 'DEVICE')) {
      const eng = X.kid(dEl, 'ENGINE');
      const typeEl = X.kid(eng, 'TYPE');
      const ptType = X.text(typeEl).trim();
      const ref = X.text(X.kid(eng, 'SAVE_REF_ID')).trim();
      if (SKIP_TYPES.has(ptType)) { ctx.skippedRefs.add(ref); continue; }
      const model = X.attr(typeEl, 'model') || ptType;
      const kind = NM.KIND_BY_PTTYPE[ptType] || 'other';
      const lg = X.path(dEl, 'WORKSPACE/LOGICAL');
      const dev = {
        id: ref || NM.uid('dev'), kind, ptType, model, name: X.text(X.kid(eng, 'NAME')),
        x: parseFloat(X.text(X.kid(lg, 'X'))) || 0, y: parseFloat(X.text(X.kid(lg, 'Y'))) || 0,
        ports: [], gateway: X.text(X.kid(eng, 'GATEWAY')).trim(), dns: X.text(X.path(eng, 'DNS_CLIENT/SERVER_IP')).trim(),
        power: X.text(X.kid(eng, 'POWER')).trim() !== 'false', imported: true
      };
      if (dev.gateway === '0.0.0.0') dev.gateway = '';
      if (dev.dns === '0.0.0.0') dev.dns = '';
      const rcEl = X.kid(eng, 'RUNNINGCONFIG');
      const rcLines = rcEl ? X.kids(rcEl, 'LINE').map(l => X.text(l)) : [];
      const ifNames = rcLines.filter(l => /^interface\s/.test(l)).map(l => NM.expandIf(l.slice(10).replace(/\s+/g, '')) || l.slice(10).trim())
        .filter(n => !/^(Vlan|Loopback|Tunnel|Port-channel)/.test(n) && !n.includes('.'));
      const used = new Set();
      const typeCounters = {};
      const portRefs = [];
      for (const { el, slotPath, idx } of collectPorts(eng)) {
        const t = X.text(X.kid(el, 'TYPE')).trim();
        const prefix = PORT_PREFIX[t] || t.replace(/^e(Copper|Fiber)?/, '');
        let name = ifNames.find(n => !used.has(n) && n.startsWith(prefix) && !/[A-Za-z]/.test(n.slice(prefix.length)));
        if (name) used.add(name);
        else {
          typeCounters[prefix] = (typeCounters[prefix] || 0);
          if (NM.HOST_KINDS.has(kind) || kind === 'hub' || kind === 'cloud' || kind === 'other' || kind === 'ap')
            name = (prefix === 'Port' ? 'Port ' : prefix) + (slotPath.length ? slotPath[0] : typeCounters[prefix]);
          else name = prefix + [...slotPath, idx + ((kind === 'switch' || kind === 'l3switch') && !ifNames.length ? 1 : 0)].join('/');
          typeCounters[prefix]++;
          while (dev.ports.some(p => p.name === name)) name += "'";
        }
        const port = NM.newPort(name, {
          media: MEDIA(t), mac: X.text(X.kid(el, 'MACADDRESS')).trim() || NM.randomMac(),
          ip: X.text(X.kid(el, 'IP')).trim(), mask: X.text(X.kid(el, 'SUBNET')).trim(),
          desc: X.text(X.kid(el, 'DESCRIPTION')).trim(), hidden: HIDDEN_PORT.test(t), ptType: t,
          dhcp: X.text(X.kid(el, 'PORT_DHCP_ENABLE')).trim() === 'true', virtual: false,
          shutdown: X.text(X.kid(el, 'POWER')).trim() === 'false'
        });
        if (port.ip === '0.0.0.0') { port.ip = ''; port.mask = ''; }
        const pg = X.text(X.kid(el, 'PORT_GATEWAY')).trim();
        if (pg && pg !== '0.0.0.0' && !dev.gateway) dev.gateway = pg;
        dev.ports.push(port);
        portRefs.push([port, el]);
      }
      if (NM.IOS_KINDS.has(kind) || rcLines.length) {
        dev.ios = true;
        dev.cfg = NM.defaultCfg(dev);
        dev.cfg.hostname = dev.name;
        // VLAN databáze z XML
        const vl = X.kid(eng, 'VLANS');
        if (vl) for (const v of X.kids(vl, 'VLAN')) {
          const num = +X.attr(v, 'number'); const nm = X.attr(v, 'name');
          if (num && !(num >= 1002 && num <= 1005)) dev.cfg.vlans[num] = nm || ('VLAN' + String(num).padStart(4, '0'));
        }
        if (kind === 'router') for (const p of dev.ports) if (!p.hidden) p.shutdown = true;
        NM.applyConfigLines(dev, rcLines);
        const secEl = X.kid(eng, 'SECURITY');
        if (secEl) dev.cfg.rsaBits = +X.text(X.kid(secEl, 'MODULUS_BITS')) || 0;
        if ((kind === 'switch' || kind === 'l3switch') && !NM.findPort(dev, 'Vlan1')) dev.ports.push(NM.newPort('Vlan1', { shutdown: true }));
        const sc = X.kid(eng, 'STARTUPCONFIG');
        const scLines = sc ? X.kids(sc, 'LINE').map(l => X.text(l)) : [];
        dev.startup = scLines.length ? scLines : null;
      }
      if (NM.HOST_KINDS.has(kind)) dev.services = NM.defaultServices(kind);
      project.devices.push(dev);
      ctx.devEl.set(dev.id, dEl);
      ctx.portEl.set(dev.id, new Map(portRefs.map(([p, el]) => [p.name, el])));
    }

    const devById = new Map(project.devices.map(d => [d.id, d]));
    for (const lEl of X.kids(X.kid(network, 'LINKS'), 'LINK')) {
      const cab = X.kid(lEl, 'CABLE');
      if (!cab) continue;
      const from = X.text(X.kid(cab, 'FROM')).trim(), to = X.text(X.kid(cab, 'TO')).trim();
      const ports = X.kids(cab, 'PORT').map(p => X.text(p).trim());
      const da = devById.get(from), db = devById.get(to);
      if (!da || !db) continue;
      for (const [d, pn] of [[da, ports[0]], [db, ports[1]]]) {
        if (!NM.findPort(d, pn)) d.ports.push(NM.newPort(pn, { shutdown: false }));
      }
      const subType = X.text(X.kid(cab, 'TYPE')).trim();
      const link = { id: NM.uid('lnk'), a: { dev: da.id, port: NM.findPort(da, ports[0]).name }, b: { dev: db.id, port: NM.findPort(db, ports[1]).name },
                     cable: X.text(X.kid(lEl, 'TYPE')).trim() === 'eConsole' ? 'console' : (CABLE[subType] || (X.text(X.kid(lEl, 'TYPE')).includes('Fiber') ? 'fiber' : 'straight')), imported: true };
      project.links.push(link);
      ctx.linkEl.set(link.id, lEl);
    }
    // stavové informace pro ladění
    // textové poznámky v logickém zobrazení (PT je ukládá do PHYSICALWORKSPACE/NOTES)
    for (const nEl of X.kids(X.path(pt, 'PHYSICALWORKSPACE/NOTES'), 'NOTE')) {
      const id = 'note-' + (X.attr(nEl, 'uuid') || NM.uid('n')).replace(/[{}]/g, '');
      project.notes.push({ id, x: parseFloat(X.text(X.kid(nEl, 'X'))) || 0, y: parseFloat(X.text(X.kid(nEl, 'Y'))) || 0, text: X.text(X.kid(nEl, 'TEXT')), imported: true });
      ctx.noteEl.set(id, nEl);
    }
    project.stats = { devices: project.devices.length, links: project.links.length };
    return { project, ctx };
  }

  /* ------------------------------ export ----------------------------- */
  function setChildText(parent, name, value) {
    let el = X.kid(parent, name);
    if (!el) return false;
    X.setText(el, value);
    return true;
  }
  function randomRef() { let s = String(1 + Math.floor(Math.random() * 9)); for (let i = 0; i < 18; i++) s += Math.floor(Math.random() * 10); return 'save-ref-id:' + s; }
  function indentOf(el) {
    const sib = el.parent.children, i = sib.indexOf(el);
    const prev = sib[i - 1];
    return prev && prev.raw !== undefined && /^\s*$/.test(prev.raw) ? prev.raw : '\n';
  }
  function replaceLines(el, lines) {
    if (!el) return;
    const firstLine = X.kid(el, 'LINE');
    const ind = firstLine ? indentOf(firstLine) : '\n       ';
    const closeInd = el.children.length && el.children[el.children.length - 1].raw !== undefined ? el.children[el.children.length - 1].raw : '\n      ';
    el.children = [];
    for (const l of lines) { el.children.push({ raw: ind, parent: el }); el.children.push(X.make('LINE', l, el)); }
    el.children.push({ raw: /^\s*$/.test(closeInd) ? closeInd : '\n      ', parent: el });
    el.selfClose = false;
  }

  /**
   * Zapíše změny projektu do původního XML. Vrací { xml, warnings }.
   */
  function exportXml(project, ctx) {
    const warnings = [];
    const devicesEl = X.kid(ctx.network, 'DEVICES'), linksEl = X.kid(ctx.network, 'LINKS');
    const liveDevs = new Set(project.devices.map(d => d.id));
    // smazaná zařízení
    for (const [id, el] of [...ctx.devEl]) if (!liveDevs.has(id)) { X.remove(el); ctx.devEl.delete(id); }
    // nová zařízení: klon existujícího zařízení stejného modelu
    for (const d of project.devices) {
      if (ctx.devEl.has(d.id)) continue;
      const tmplEntry = [...ctx.devEl.entries()].find(([id]) => { const o = project.devices.find(x => x.id === id); return o && o.model === d.model; });
      if (!tmplEntry) { warnings.push(`Zařízení „${d.name}“ (${d.model}) nelze do .pkt uložit – v souboru není vzor tohoto modelu. Ulož projekt jako .ntj.`); continue; }
      const el = X.clone(tmplEntry[1], devicesEl);
      const ws = indentOf(tmplEntry[1]);
      devicesEl.children.splice(devicesEl.children.lastIndexOf(devicesEl.children.filter(X.isEl).pop()) + 1, 0, { raw: ws, parent: devicesEl }, el);
      const eng = X.kid(el, 'ENGINE');
      const ref = randomRef();
      setChildText(eng, 'SAVE_REF_ID', ref);
      X.walk(el, n => { if (/MEM_ADDR|DEV_ADDR/.test(n.name)) X.setText(n, '0'); });
      // přemapovat porty podle pořadí
      const tmplDev = project.devices.find(x => x.id === tmplEntry[0]);
      const tmplPorts = ctx.portEl.get(tmplEntry[0]);
      const map = new Map();
      for (const p of d.ports) {
        const tp = tmplDev.ports[d.ports.indexOf(p)];
        if (!tp || !tmplPorts.has(tp.name)) continue;
        const path = []; let n = tmplPorts.get(tp.name); while (n && n !== tmplEntry[1]) { path.unshift(n.parent.children.indexOf(n)); n = n.parent; }
        let m = el; for (const i of path) m = m.children[i];
        map.set(p.name, m);
      }
      ctx.portEl.set(d.id, map);
      ctx.devEl.set(d.id, el);
      // id zařízení musí odpovídat SAVE_REF_ID kvůli linkům
      const oldId = d.id; d.id = ref;
      for (const l of project.links) { if (l.a.dev === oldId) l.a.dev = ref; if (l.b.dev === oldId) l.b.dev = ref; }
      ctx.devEl.delete(oldId); ctx.devEl.set(ref, el); ctx.portEl.set(ref, map); ctx.portEl.delete(oldId);
      warnings.push(`Zařízení „${d.name}“ bylo vytvořeno klonem „${tmplDev.name}“ (experimentální).`);
    }
    // aktualizace zařízení
    for (const d of project.devices) {
      const el = ctx.devEl.get(d.id); if (!el) continue;
      const eng = X.kid(el, 'ENGINE');
      setChildText(eng, 'NAME', d.name);
      const lg = X.path(el, 'WORKSPACE/LOGICAL');
      if (lg) { setChildText(lg, 'X', String(Math.round(d.x * 100) / 100)); setChildText(lg, 'Y', String(Math.round(d.y * 100) / 100)); }
      setChildText(eng, 'POWER', d.power === false ? 'false' : 'true');
      if (X.kid(eng, 'GATEWAY')) setChildText(eng, 'GATEWAY', d.gateway || '');
      const dnsEl = X.path(eng, 'DNS_CLIENT/SERVER_IP'); if (dnsEl) X.setText(dnsEl, d.dns || '');
      const pmap = ctx.portEl.get(d.id) || new Map();
      for (const p of d.ports) {
        const pe = pmap.get(p.name); if (!pe) continue;
        if (X.kid(pe, 'IP')) { setChildText(pe, 'IP', p.dhcp ? (p.ip || '') : (p.ip || '')); setChildText(pe, 'SUBNET', p.mask || ''); }
        if (X.kid(pe, 'PORT_GATEWAY') && NM.HOST_KINDS.has(d.kind)) setChildText(pe, 'PORT_GATEWAY', d.gateway || '');
        if (X.kid(pe, 'PORT_DHCP_ENABLE')) setChildText(pe, 'PORT_DHCP_ENABLE', p.dhcp ? 'true' : 'false');
        if (X.kid(pe, 'DESCRIPTION')) setChildText(pe, 'DESCRIPTION', p.desc || '');
        if (d.ios) setChildText(pe, 'POWER', p.shutdown ? 'false' : 'true');
      }
      if (d.ios && d.cfg) {
        const lines = NM.generateConfig(d);
        const rc = X.kid(eng, 'RUNNINGCONFIG');
        replaceLines(rc, lines);
        if (d.startup && X.kid(eng, 'STARTUPCONFIG')) replaceLines(X.kid(eng, 'STARTUPCONFIG'), d.startup);
        setChildText(eng, 'SYS_NAME', d.cfg.hostname);
      }
    }
    // linky
    const liveLinks = new Set(project.links.map(l => l.id));
    for (const [id, el] of [...ctx.linkEl]) if (!liveLinks.has(id)) { X.remove(el); ctx.linkEl.delete(id); }
    const tmplLink = [...ctx.linkEl.values()][0];
    for (const l of project.links) {
      if (ctx.linkEl.has(l.id)) {
        // aktualizace portů (mohly se přepojit)
        const cab = X.kid(ctx.linkEl.get(l.id), 'CABLE');
        const ps = X.kids(cab, 'PORT');
        X.setText(X.kid(cab, 'FROM'), l.a.dev); X.setText(X.kid(cab, 'TO'), l.b.dev);
        if (ps[0]) X.setText(ps[0], l.a.port); if (ps[1]) X.setText(ps[1], l.b.port);
        continue;
      }
      if (!ctx.devEl.has(l.a.dev) || !ctx.devEl.has(l.b.dev)) continue;
      let el;
      if (tmplLink) el = X.clone(tmplLink, linksEl);
      else el = X.parse(`<LINK><TYPE>eCopper</TYPE><CABLE><LENGTH>1</LENGTH><FUNCTIONAL>true</FUNCTIONAL><FROM></FROM><PORT></PORT><TO></TO><PORT></PORT><TYPE>eStraightThrough</TYPE></CABLE></LINK>`).children[0];
      el.parent = linksEl;
      const [lt, ct] = CABLE_PT[l.cable] || CABLE_PT.straight;
      X.setText(X.kid(el, 'TYPE'), lt);
      const cab = X.kid(el, 'CABLE');
      X.setText(X.kid(cab, 'FROM'), l.a.dev); X.setText(X.kid(cab, 'TO'), l.b.dev);
      const ps = X.kids(cab, 'PORT'); X.setText(ps[0], l.a.port); X.setText(ps[1], l.b.port);
      const tEl = X.kids(cab, 'TYPE').pop(); if (tEl) X.setText(tEl, ct);
      for (const c of [...cab.children]) if (c.name && /MEM_ADDR/.test(c.name)) X.remove(c);
      linksEl.children.push({ raw: tmplLink ? indentOf(tmplLink) : '\n', parent: linksEl }, el);
      linksEl.selfClose = false;
      ctx.linkEl.set(l.id, el);
    }
    // poznámky
    const pws = X.kid(ctx.pt, 'PHYSICALWORKSPACE');
    if (pws) {
      if (!ctx.noteEl) ctx.noteEl = new Map();
      let notesEl = X.kid(pws, 'NOTES');
      const liveNotes = new Set((project.notes || []).map(n => n.id));
      for (const [id, el] of [...ctx.noteEl]) if (!liveNotes.has(id)) { X.remove(el); ctx.noteEl.delete(id); }
      for (const n of project.notes || []) {
        let el = ctx.noteEl.get(n.id);
        if (!el) {
          if (!notesEl) { notesEl = X.make('NOTES', undefined, pws); pws.children.push({ raw: '\n', parent: pws }, notesEl); }
          const uuid = '{' + 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }) + '}';
          el = X.parse(`<NOTE uuid="${uuid}"><X>0</X><Y>0</Y><Z>140000</Z><TEXT translate="true"></TEXT><NOTECLUSTERID>1-1</NOTECLUSTERID></NOTE>`).children[0];
          el.parent = notesEl;
          notesEl.children.push({ raw: '\n', parent: notesEl }, el);
          notesEl.selfClose = false;
          ctx.noteEl.set(n.id, el);
        }
        setChildText(el, 'X', String(Math.round(n.x)));
        setChildText(el, 'Y', String(Math.round(n.y)));
        setChildText(el, 'TEXT', n.text || '');
      }
    }
    return { xml: X.serialize(ctx.doc), warnings };
  }

  const api = { importXml, exportXml, importAnswer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PTFormat = api;
})(typeof self !== 'undefined' ? self : this);
