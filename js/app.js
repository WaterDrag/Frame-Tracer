/*
 * app.js – uživatelské rozhraní Frame-Traceru.
 */
(function () {
  'use strict';
  const NM = window.NetModel, { IP } = NM, Sim = window.NetSim.Sim, CLI = window.NetCLI;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
  const SVGNS = 'http://www.w3.org/2000/svg';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DCE = new Set(['switch', 'l3switch', 'hub', 'ap']);
  const CABLE_COLORS = { straight: 'var(--wire)', cross: 'var(--wire)', serial: '#ef4444', fiber: '#f97316', console: '#38bdf8', coax: '#a3a3a3', phone: '#a3a3a3', usb: '#a3a3a3', octal: '#a3a3a3', auto: 'var(--wire)' };
  const CABLE_NAMES = { straight: 'Přímý (straight-through)', cross: 'Křížený (cross-over)', serial: 'Sériový', fiber: 'Optický', console: 'Konzolový', coax: 'Koaxiální' };
  const KIND_NAMES = { router: 'Router', switch: 'Switch', l3switch: 'L3 switch', pc: 'PC', laptop: 'Laptop', server: 'Server', printer: 'Tiskárna', hub: 'Hub', cloud: 'Cloud', ap: 'Access point', other: 'Zařízení' };
  document.documentElement.style.setProperty('--wire', 'var(--muted)');

  /* =========================== stav =========================== */
  const S = {
    project: null, ctx: null, pktBytes: null, sim: null,
    sel: new Set(), selLink: null, selNote: null,
    tool: 'select', cable: null, placeModel: null, cableStart: null, pduSrc: null,
    view: { x: 0, y: 0, k: 1 },
    undo: [], redo: [],
    sessions: new Map(), terms: new Map(), insTab: new Map(),
    pdus: [], events: [], mode: 'realtime', simT: 0,
    dirty: false, dirtySinceSnap: false,
    cowork: null, peers: {}, remoteStale: false
  };
  window.NT = S; // ladění

  /* =========================== utility =========================== */
  function toast(msg, kind, ms) {
    const t = document.createElement('div');
    t.className = 'toast ' + (kind || '');
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, ms || 3200);
  }
  function devById(id) { return S.project.devices.find(d => d.id === id); }
  const devLabel = d => d ? d.name : '?';
  const isTyping = () => { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable); };
  function iconKind(d) { return window.Icons.has(d.kind) ? d.kind : 'other'; }
  function nicOf(d) { return d.ports.find(p => !p.hidden && !p.virtual && /Ethernet|Wireless/.test(p.name)) || d.ports.find(p => !p.hidden) || d.ports[0]; }
  function deviceIps(d) {
    if (NM.HOST_KINDS.has(d.kind)) { const n = nicOf(d); return n && n.ip ? [n.ip + '/' + IP.prefixLen(n.mask)] : []; }
    return d.ports.filter(p => p.ip && p.mask).map(p => p.ip + '/' + IP.prefixLen(p.mask)).slice(0, 3);
  }
  function download(bytesOrText, name, mime) {
    const blob = bytesOrText instanceof Blob ? bytesOrText : new Blob([bytesOrText], { type: mime || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  async function saveFile(bytesOrText, name, mime, desc, ext) {
    if (window.showSaveFilePicker) {
      try {
        const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: desc || name, accept: { [mime || 'application/octet-stream']: [ext || ('.' + name.split('.').pop())] } }] });
        const w = await h.createWritable(); await w.write(bytesOrText); await w.close();
        return h.name;
      } catch (e) { if (e.name === 'AbortError') return null; }
    }
    download(bytesOrText, name, mime);
    return name;
  }
  const inflate = async data => new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const deflate = async data => new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());

  function ask(title, html, buttons) {
    return new Promise(resolve => {
      const dlg = $('#dlg'), f = $('#dlgForm');
      f.innerHTML = `<h2>${esc(title)}</h2>${html}<div class="actions">${(buttons || [['ok', 'OK', 'primary']]).map(([v, l, c]) => `<button value="${v}" class="${c || ''}">${esc(l)}</button>`).join('')}</div>`;
      const onClose = () => { dlg.removeEventListener('close', onClose); resolve({ value: dlg.returnValue, form: f }); };
      dlg.addEventListener('close', onClose);
      dlg.returnValue = 'cancel';
      dlg.showModal();
      const first = f.querySelector('input,textarea'); if (first) setTimeout(() => first.focus(), 30);
    });
  }
  async function askText(title, value, label) {
    const r = await ask(title, `<label>${esc(label || '')}<textarea name="t" style="min-height:90px">${esc(value || '')}</textarea></label>`, [['cancel', 'Zrušit'], ['ok', 'Uložit', 'primary']]);
    return r.value === 'ok' ? r.form.t.value : null;
  }

  /* =========================== projekt =========================== */
  function emptyProject() {
    return { version: 1, name: 'Nový projekt', devices: [], links: [], notes: [], instructions: null, description: '', source: { kind: 'new' } };
  }
  function normalize(p) {
    p.devices = p.devices || []; p.links = p.links || []; p.notes = p.notes || [];
    for (const d of p.devices) {
      d.ports = d.ports || [];
      for (const q of d.ports) { q.extra = q.extra || []; if (q.allowed === undefined) q.allowed = 'all'; }
      if (d.ios && !d.cfg) d.cfg = NM.defaultCfg(d);
      if (d.cfg) {
        const def = NM.defaultCfg(d);
        for (const k of Object.keys(def)) if (d.cfg[k] === undefined) d.cfg[k] = def[k];
        d.cfg.lines.con = Object.assign({ password: '', login: false, extra: [] }, d.cfg.lines.con);
        d.cfg.lines.vty = Object.assign({ password: '', login: false, extra: [], range: '0 4' }, d.cfg.lines.vty);
      }
      if (NM.HOST_KINDS.has(d.kind) && !d.services) d.services = NM.defaultServices(d.kind);
    }
    return p;
  }
  function loadProject(p, opts) {
    opts = opts || {};
    S.project = normalize(p);
    S.ctx = opts.ctx || null;
    S.pktBytes = opts.pktBytes || null;
    if (!S.sim) S.sim = new Sim(S.project); else S.sim.setProject(S.project);
    S.sel.clear(); S.selLink = null; S.selNote = null;
    S.sessions.clear(); S.terms.clear(); S.undo = []; S.redo = [];
    S.pdus = []; S.events = [];
    S.dirty = !!opts.dirty;
    updateFileLabel();
    render(); renderInspector(); renderPdus(); renderEvents();
    if (!opts.keepView) setTimeout(fitView, 30);
    refreshProblems();
  }
  function snapshotJson() {
    const p = S.project;
    return JSON.stringify({ name: p.name, devices: p.devices, links: p.links, notes: p.notes });
  }
  /** Zavolej PŘED změnou – vrátí funkci, která změnu potvrdí do historie */
  function begin() {
    const before = snapshotJson();
    return function commit(opts) {
      if (snapshotJson() === before) return false;
      S.undo.push(before); if (S.undo.length > 150) S.undo.shift();
      S.redo = [];
      afterChange(opts);
      return true;
    };
  }
  function change(fn, opts) { const c = begin(); fn(); c(opts); }
  function restoreSnapshot(json) {
    const o = JSON.parse(json);
    Object.assign(S.project, { name: o.name, devices: o.devices, links: o.links, notes: o.notes });
    normalize(S.project);
    rebindSessions();
    for (const id of [...S.sel]) if (!devById(id)) S.sel.delete(id);
    if (S.selLink && !S.project.links.find(l => l.id === S.selLink)) S.selLink = null;
    afterChange({ inspector: true });
  }
  function undo() { if (!S.undo.length) return; S.redo.push(snapshotJson()); restoreSnapshot(S.undo.pop()); }
  function redo() { if (!S.redo.length) return; S.undo.push(snapshotJson()); restoreSnapshot(S.redo.pop()); }
  function rebindSessions() {
    for (const [id, s] of [...S.sessions]) {
      const d = devById(id);
      if (!d) { S.sessions.delete(id); S.terms.delete(id); continue; }
      s.dev = d;
      if (s.remote) { const r = devById(s.remote.dev.id); if (r) s.remote.dev = r; else s.remote = null; }
    }
  }
  let saveTimer = null, renderQueued = false;
  function afterChange(opts) {
    opts = opts || {};
    S.sim.p = S.project; S.sim.touch();
    S.dirty = true; S.dirtySinceSnap = true;
    updateFileLabel();
    scheduleRender();
    if (opts.inspector) renderInspector();
    else refreshInspectorLight();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { window.Backup.saveCurrent(S.project, S.pktBytes); refreshProblems(); }, 900);
    if (S.cowork && S.cowork.roomRef && !opts.remote) S.cowork.push(S.project);
  }
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    const run = () => { if (!renderQueued) return; renderQueued = false; render(); };
    requestAnimationFrame(run);
    setTimeout(run, 50); // záloha, když prohlížeč rAF ve skrytém okně brzdí
  }
  function updateFileLabel() {
    const p = S.project;
    const src = p.source && p.source.kind !== 'new' ? ` · ${esc(p.source.fileName || '')}` : '';
    $('#fileLabel').innerHTML = `<b>${esc(p.name)}</b>${S.dirty ? ' •' : ''}<span class="muted">${src}</span>`;
    document.title = (S.dirty ? '• ' : '') + p.name + ' – Frame-Tracer';
    $('#btnSavePkt').title = S.ctx ? 'Uložit do formátu Packet Traceru (Ctrl+S)' : 'Pro uložení do .pkt otevři nejdřív soubor z Packet Traceru (slouží jako šablona)';
  }

  /* =========================== soubory =========================== */
  async function openFile(file) {
    const name = file.name;
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      if (/\.(ntj|json)$/i.test(name)) {
        const o = JSON.parse(new TextDecoder().decode(bytes));
        const p = o.project || o;
        if (!p.devices) throw new Error('Soubor neobsahuje projekt Frame-Traceru.');
        let ctx = null, pkt = null;
        if (o.pkt) { pkt = window.Cowork.unb64(o.pkt); ctx = await ctxFromPkt(pkt); }
        await window.Backup.snapshot(S.project, 'Před otevřením ' + name).catch(() => {});
        loadProject(p, { ctx, pktBytes: pkt });
        toast('Projekt načten: ' + name, 'ok');
      } else {
        toast('Dešifruji ' + name + '…');
        const t0 = performance.now();
        const r = await window.PTCrypto.decode(bytes, inflate);
        const { project, ctx } = window.PTFormat.importXml(r.xml, name);
        let pkt = bytes;
        if (r.format === 'xml') pkt = await window.PTCrypto.encode(r.xml, deflate);
        await window.Backup.snapshot(S.project, 'Před otevřením ' + name).catch(() => {});
        loadProject(project, { ctx, pktBytes: pkt });
        const ms = Math.round(performance.now() - t0);
        toast(`Otevřeno ${name} (Packet Tracer ${project.source.ptVersion || '?'}) – ${project.devices.length} zařízení, ${project.links.length} kabelů, ${ms} ms`, 'ok', 5000);
        if (r.tagOk === false) toast('Pozor: kontrolní součet souboru nesedí, soubor může být poškozený.', 'warn', 6000);
      }
      window.Backup.saveCurrent(S.project, S.pktBytes);
      window.Backup.snapshot(S.project, 'Otevřen soubor ' + name, true).catch(() => {});
      if (S.cowork && S.cowork.roomRef) {
        const r = await ask('Sdílet v místnosti?', '<p>Jsi připojen ke společné místnosti. Chceš nahradit její obsah tímto souborem?</p>', [['no', 'Ne, odpojit se'], ['yes', 'Ano, sdílet', 'primary']]);
        if (r.value === 'yes') await replaceRoomContent(); else await leaveRoom();
      }
    } catch (e) {
      console.error(e);
      toast('Soubor nelze otevřít: ' + e.message, 'err', 6000);
    }
  }
  async function ctxFromPkt(bytes) {
    try {
      const r = await window.PTCrypto.decode(bytes, inflate);
      return window.PTFormat.importXml(r.xml, 'x').ctx;
    } catch (e) { console.warn('Šablonu .pkt nelze načíst', e); return null; }
  }
  async function savePkt() {
    if (!S.ctx) {
      await ask('Uložení do .pkt', `<p>Formát Packet Traceru je velmi složitý, proto Frame-Tracer ukládá .pkt tak, že <b>upraví původní soubor</b> – vše, co nezná, v něm zůstane beze změny.</p>
        <p>Tento projekt nevznikl z .pkt souboru. Možnosti:</p>
        <p>• ulož ho jako projekt Frame-Traceru (<b>Uložit projekt</b>, .ntj),<br>• nebo otevři libovolný .pkt soubor (třeba prázdný uložený z Packet Traceru) a síť postav v něm.</p>`);
      return;
    }
    try {
      const { xml, warnings } = window.PTFormat.exportXml(S.project, S.ctx);
      const bytes = await window.PTCrypto.encode(xml, deflate);
      const fname = (S.project.source && S.project.source.fileName) || (S.project.name + '.pkt');
      const saved = await saveFile(bytes, fname, 'application/octet-stream', 'Packet Tracer', fname.toLowerCase().endsWith('.pka') ? '.pka' : '.pkt');
      if (!saved) return;
      S.pktBytes = bytes;
      S.dirty = false; updateFileLabel();
      window.Backup.saveCurrent(S.project, S.pktBytes);
      window.Backup.snapshot(S.project, 'Uloženo jako ' + saved, true).catch(() => {});
      if (S.cowork && S.cowork.roomRef) { S.cowork.push(S.project); S.cowork.uploadPkt(bytes, fname); }
      render();
      toast('Uloženo: ' + saved, 'ok');
      for (const w of warnings) toast(w, 'warn', 7000);
    } catch (e) { console.error(e); toast('Uložení selhalo: ' + e.message, 'err', 6000); }
  }
  async function saveNtj() {
    const o = { format: 'nettracer', version: 1, savedAt: new Date().toISOString(), project: JSON.parse(window.Backup.serialize(S.project)) };
    if (S.pktBytes) o.pkt = window.Cowork.b64(S.pktBytes);
    const name = (S.project.name || 'projekt').replace(/[\\/:*?"<>|]+/g, '_') + '.ntj';
    const saved = await saveFile(JSON.stringify(o), name, 'application/json', 'Projekt Frame-Tracer', '.ntj');
    if (saved) { S.dirty = false; updateFileLabel(); toast('Projekt uložen: ' + saved, 'ok'); window.Backup.snapshot(S.project, 'Uloženo jako ' + saved, true).catch(() => {}); }
  }
  async function exportXml() {
    if (!S.ctx) { toast('XML export je dostupný pro projekty otevřené z .pkt/.pka.', 'warn'); return; }
    const { xml } = window.PTFormat.exportXml(S.project, S.ctx);
    download(xml, (S.project.name || 'sit') + '.xml', 'application/xml');
  }
  async function newProject() {
    if (S.project.devices.length) await window.Backup.snapshot(S.project, 'Před novým projektem', true).catch(() => {});
    if (S.cowork && S.cowork.roomRef) await leaveRoom();
    loadProject(emptyProject());
    window.Backup.saveCurrent(S.project, null);
  }

  /* =========================== vykreslení =========================== */
  const svg = $('#canvas'), vp = $('#viewport');
  function svgEl(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function applyView() { vp.setAttribute('transform', `translate(${S.view.x},${S.view.y}) scale(${S.view.k})`); }
  function toWorld(cx, cy) {
    const r = svg.getBoundingClientRect();
    return { x: (cx - r.left - S.view.x) / S.view.k, y: (cy - r.top - S.view.y) / S.view.k };
  }
  function fitView() {
    const ds = S.project.devices;
    const r = svg.getBoundingClientRect();
    if (!ds.length || !r.width) { S.view = { x: r.width / 2 || 300, y: r.height / 2 || 200, k: 1 }; applyView(); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const d of ds.concat(S.project.notes)) { x0 = Math.min(x0, d.x); y0 = Math.min(y0, d.y); x1 = Math.max(x1, d.x); y1 = Math.max(y1, d.y); }
    const pad = 90;
    const k = Math.max(0.2, Math.min(1.6, Math.min(r.width / (x1 - x0 + pad * 2), r.height / (y1 - y0 + pad * 2))));
    S.view = { k, x: r.width / 2 - ((x0 + x1) / 2) * k, y: r.height / 2 - ((y0 + y1) / 2) * k };
    applyView();
  }
  function zoomAt(f, cx, cy) {
    const r = svg.getBoundingClientRect();
    if (cx === undefined) { cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
    const k = Math.max(0.15, Math.min(4, S.view.k * f));
    const wx = (cx - r.left - S.view.x) / S.view.k, wy = (cy - r.top - S.view.y) / S.view.k;
    S.view.k = k; S.view.x = cx - r.left - wx * k; S.view.y = cy - r.top - wy * k;
    applyView();
  }

  function portLight(d, pName, linkUp) {
    const p = NM.findPort(d, pName);
    if (!p) return '#64748b';
    if (!linkUp) return 'var(--bad)';
    if (S.sim.isSwitchPort(d, p)) return 'var(--ok)';
    return 'var(--ok)';
  }
  function render() {
    if (!S.project) return;
    const showIps = $('#optIps').checked, showPorts = $('#optPorts').checked;
    const remoteSel = new Map();
    for (const [, peer] of Object.entries(S.peers || {})) for (const id of peer.sel || []) remoteSel.set(id, peer.color);
    // linky
    const gl = $('#lLinks'); gl.textContent = '';
    for (const l of S.project.links) {
      const a = devById(l.a.dev), b = devById(l.b.dev);
      if (!a || !b) continue;
      const st = S.sim.linkState(l);
      const g = svgEl('g', { class: 'link' + (S.selLink === l.id ? ' sel' : ''), 'data-link': l.id }, gl);
      const dash = l.cable === 'cross' ? '7 4' : l.cable === 'console' ? '3 4' : l.cable === 'serial' ? '10 3 2 3' : '';
      svgEl('line', { class: 'hit', x1: a.x, y1: a.y, x2: b.x, y2: b.y }, g);
      svgEl('line', { class: 'wire', x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: CABLE_COLORS[l.cable] || 'var(--wire)', 'stroke-dasharray': dash }, g);
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      if (l.cable !== 'console') {
        const off = Math.min(38, len / 2 - 4);
        svgEl('circle', { class: 'light', cx: a.x + ux * off, cy: a.y + uy * off, r: 4.5, fill: portLight(a, l.a.port, st.up) }, g);
        svgEl('circle', { class: 'light', cx: b.x - ux * off, cy: b.y - uy * off, r: 4.5, fill: portLight(b, l.b.port, st.up) }, g);
      }
      if (showPorts && len > 120) {
        const t1 = svgEl('text', { class: 'plbl', x: a.x + ux * 58, y: a.y + uy * 58 - 4, 'text-anchor': 'middle' }, g); t1.textContent = NM.shortIf(l.a.port);
        const t2 = svgEl('text', { class: 'plbl', x: b.x - ux * 58, y: b.y - uy * 58 - 4, 'text-anchor': 'middle' }, g); t2.textContent = NM.shortIf(l.b.port);
      }
      const tt = svgEl('title', {}, g); tt.textContent = `${a.name} ${l.a.port} ↔ ${b.name} ${l.b.port}\n${CABLE_NAMES[l.cable] || l.cable}${st.up ? '' : '\n⚠ ' + st.reason}`;
    }
    // zařízení
    const gd = $('#lDevices'); gd.textContent = '';
    for (const d of S.project.devices) {
      const cls = 'dev' + (S.sel.has(d.id) ? ' sel' : '') + (d.power === false ? ' off' : '') + (remoteSel.has(d.id) ? ' remote-sel' : '');
      const g = svgEl('g', { class: cls, 'data-dev': d.id, transform: `translate(${d.x},${d.y})` }, gd);
      if (remoteSel.has(d.id)) g.style.setProperty('--rc', remoteSel.get(d.id));
      const ips = showIps ? deviceIps(d) : [];
      svgEl('rect', { class: 'selbox', x: -38, y: -30, width: 76, height: 70 + ips.length * 13, rx: 8 }, g);
      svgEl('rect', { class: 'hit', x: -30, y: -25, width: 60, height: 50 }, g);
      svgEl('use', { href: '#ico-' + iconKind(d), x: -29, y: -24, width: 58, height: 47 }, g);
      const t = svgEl('text', { class: 'lbl', y: 37 }, g); t.textContent = d.name;
      ips.forEach((ip, i) => { const s = svgEl('text', { class: 'sub', y: 50 + i * 13 }, g); s.textContent = ip; });
    }
    // poznámky
    const gn = $('#lNotes'); gn.textContent = '';
    for (const n of S.project.notes) {
      const lines = String(n.text || '').split('\n');
      const w = Math.max(60, Math.min(320, Math.max(...lines.map(l => l.length)) * 7 + 16)), h = lines.length * 16 + 10;
      const g = svgEl('g', { class: 'note', 'data-note': n.id, transform: `translate(${n.x},${n.y})` }, gn);
      svgEl('rect', { width: w, height: h, rx: 4, 'stroke-width': S.selNote === n.id ? 2.5 : 1 }, g);
      lines.forEach((l, i) => { const t = svgEl('text', { x: 8, y: 18 + i * 16 }, g); t.textContent = l; });
    }
    renderCursors();
  }
  /** jen přepne zvýraznění výběru – bez přestavby SVG (zachová dvojklik) */
  function updateSel() {
    for (const g of $$('#lDevices [data-dev]')) g.classList.toggle('sel', S.sel.has(g.dataset.dev));
    for (const g of $$('#lLinks [data-link]')) g.classList.toggle('sel', S.selLink === g.dataset.link);
    for (const g of $$('#lNotes [data-note]')) { const r = g.querySelector('rect'); if (r) r.setAttribute('stroke-width', S.selNote === g.dataset.note ? 2.5 : 1); }
  }
  function capture(e) { try { svg.setPointerCapture(e.pointerId); } catch (er) { /* syntetické události */ } }
  function renderCursors() {
    const gc = $('#lCursors'); gc.textContent = '';
    for (const [, p] of Object.entries(S.peers || {})) {
      if (!p.cur) continue;
      const g = svgEl('g', { transform: `translate(${p.cur.x},${p.cur.y}) scale(${1 / S.view.k})` }, gc);
      svgEl('path', { d: 'M0 0L0 17L5 12L9 20L12 19L8 11L14 11Z', fill: p.color, stroke: '#fff', 'stroke-width': 1 }, g);
      const w = (p.name || '?').length * 6.5 + 12;
      svgEl('rect', { x: 14, y: 16, width: w, height: 17, rx: 8, fill: p.color }, g);
      const t = svgEl('text', { class: 'cursor-lbl', x: 20, y: 28.5 }, g); t.textContent = p.name || '?';
    }
  }

  /* =========================== paleta =========================== */
  const PALETTE = [
    ['Routery', ['2911', '1941', '4331']],
    ['Switche', ['2960-24TT', '3560-24PS', 'Hub-PT']],
    ['Koncová zařízení', ['PC-PT', 'Laptop-PT', 'Server-PT', 'Printer-PT']],
    ['Ostatní', ['Cloud-PT']]
  ];
  function buildPalette() {
    const root = $('#devicePalette');
    root.innerHTML = PALETTE.map(([title, models]) => `<h3>${title}</h3><div class="dev-grid">${models.map(m => {
      const c = NM.CATALOG[m];
      return `<button class="dev-tile" draggable="true" data-model="${m}" title="${esc(c.label)} – přetáhni na plochu">${window.Icons.icon(c.kind)}<span>${esc(c.label.replace(/^(Router|Switch) /, ''))}</span></button>`;
    }).join('')}</div>`).join('');
    root.addEventListener('dragstart', e => { const t = e.target.closest('.dev-tile'); if (t) { e.dataTransfer.setData('text/x-model', t.dataset.model); e.dataTransfer.effectAllowed = 'copy'; } });
    root.addEventListener('click', e => {
      const t = e.target.closest('.dev-tile'); if (!t) return;
      const on = S.placeModel === t.dataset.model;
      setTool('select');
      if (!on) { S.placeModel = t.dataset.model; t.classList.add('on'); hint(`Klikni na plochu pro umístění: ${NM.CATALOG[t.dataset.model].label} (Esc = zrušit)`); }
    });
  }
  function addDevice(model, x, y) {
    let d;
    change(() => {
      const names = new Set(S.project.devices.map(z => z.name));
      d = NM.createDevice(model, Math.round(x), Math.round(y), names);
      if (d.ios) d.ports.push(NM.newPort('Console', { hidden: true, media: 'console' }));
      if (NM.HOST_KINDS.has(d.kind)) d.ports.push(NM.newPort('RS 232', { hidden: true, media: 'console' }));
      S.project.devices.push(d);
      S.sel = new Set([d.id]); S.selLink = null;
    }, { inspector: true });
    return d;
  }

  /* =========================== nástroje =========================== */
  function hint(t) { const h = $('#toolHint'); if (t) { h.textContent = t; h.hidden = false; } else h.hidden = true; }
  function setTool(tool, cable) {
    S.tool = tool; S.cable = cable || null; S.cableStart = null; S.pduSrc = null; S.placeModel = null;
    $$('#palette [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === tool && !cable));
    $$('#palette [data-cable]').forEach(b => b.classList.toggle('on', b.dataset.cable === cable));
    $$('.dev-tile.on').forEach(b => b.classList.remove('on'));
    $('#lAnim').querySelectorAll('.ghost').forEach(g => g.remove());
    closePortMenu();
    svg.style.cursor = tool === 'select' ? '' : tool === 'delete' ? 'not-allowed' : 'crosshair';
    const hints = { cable: cable === 'auto' ? 'Automatický kabel: klikni na první a pak druhé zařízení' : 'Kabel: klikni na zařízení a vyber port', delete: 'Klikni na zařízení, kabel nebo poznámku pro smazání', note: 'Klikni na plochu pro vložení poznámky', pdu: 'Ping: klikni na zdrojové a potom cílové zařízení' };
    hint(hints[tool] || '');
  }

  /* -------- kabely -------- */
  function freePorts(d) { return d.ports.filter(p => !p.hidden && !p.virtual && !S.sim.linkOf(d.id, p.name)); }
  function consolePort(d) {
    const name = d.ios ? 'Console' : NM.HOST_KINDS.has(d.kind) ? 'RS 232' : null;
    if (!name) return null;
    let p = NM.findPort(d, name);
    if (!p) { p = NM.newPort(name, { hidden: true, media: 'console' }); d.ports.push(p); }
    return p;
  }
  function autoCableType(da, pa, db, pb) {
    if (pa.media === 'serial' && pb.media === 'serial') return 'serial';
    if (pa.media === 'fiber' && pb.media === 'fiber') return 'fiber';
    return DCE.has(da.kind) === DCE.has(db.kind) ? 'cross' : 'straight';
  }
  function pickAutoPort(d, other) {
    const f = freePorts(d);
    if (!f.length) return null;
    if (other) {
      const om = new Set(freePorts(other).map(p => p.media));
      return f.find(p => p.media === 'copper' && om.has('copper')) || f.find(p => om.has(p.media)) || f[0];
    }
    return f.find(p => p.media === 'copper') || f[0];
  }
  function portMenu(d, cable, x, y, cb) {
    const m = $('#portMenu');
    let ports = d.ports.filter(p => !p.hidden && !p.virtual);
    if (cable === 'serial') ports = ports.filter(p => p.media === 'serial');
    else if (cable === 'fiber') ports = ports.filter(p => p.media === 'fiber');
    else if (cable === 'console') { const cp = consolePort(d); ports = cp ? [cp] : []; }
    else ports = ports.filter(p => p.media !== 'serial' && p.media !== 'fiber' || cable === 'auto');
    if (!ports.length) { toast(`${d.name} nemá port vhodný pro ${CABLE_NAMES[cable] || cable} kabel.`, 'warn'); return; }
    m.innerHTML = `<div class="ttl">${esc(d.name)} – vyber port</div>` + ports.map(p => {
      const lk = S.sim.linkOf(d.id, p.name);
      const peer = lk && devById(lk.peer.dev);
      return `<button data-port="${esc(p.name)}" ${lk ? 'disabled' : ''}><span>${esc(p.name)}</span><small>${lk ? '→ ' + esc(peer ? peer.name : '') : p.media === 'serial' ? 'sériový' : p.media === 'fiber' ? 'optika' : 'volný'}</small></button>`;
    }).join('');
    m.hidden = false;
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x + 8, innerWidth - r.width - 8) + 'px';
    m.style.top = Math.min(y + 8, innerHeight - r.height - 8) + 'px';
    m.onclick = e => { const b = e.target.closest('button[data-port]'); if (!b || b.disabled) return; closePortMenu(); cb(NM.findPort(d, b.dataset.port)); };
  }
  function closePortMenu() { const m = $('#portMenu'); m.hidden = true; m.onclick = null; }
  function cableClick(d, ev) {
    const cable = S.cable;
    const finish = (pa, pb, da, db) => {
      const type = cable === 'auto' ? autoCableType(da, pa, db, pb) : cable;
      change(() => {
        S.project.links.push({ id: NM.uid('lnk'), a: { dev: da.id, port: pa.name }, b: { dev: db.id, port: pb.name }, cable: type });
      });
      const l = S.project.links[S.project.links.length - 1];
      const st = S.sim.linkState(l);
      if (!st.up && !st.console && !/shutdown/.test(st.reason)) toast(`Kabel zapojen, ale linka nefunguje: ${st.reason}`, 'warn', 5000);
      else if (/shutdown/.test(st.reason)) toast(`Zapojeno. Port je vypnutý – zapni ho („no shutdown“).`, '', 4000);
      S.cableStart = null;
      $('#lAnim').querySelectorAll('.ghost').forEach(g => g.remove());
      hint(cable === 'auto' ? 'Automatický kabel: klikni na první a pak druhé zařízení' : 'Kabel: klikni na zařízení a vyber port');
    };
    if (!S.cableStart) {
      const start = p => {
        S.cableStart = { dev: d.id, port: p.name };
        svgEl('line', { class: 'ghost', x1: d.x, y1: d.y, x2: d.x, y2: d.y }, $('#lAnim'));
        hint(`${d.name} ${p.name} → klikni na druhé zařízení`);
      };
      if (cable === 'auto') { const p = pickAutoPort(d); if (!p) { toast(d.name + ' nemá volný port.', 'warn'); return; } start(p); }
      else if (cable === 'console') { const p = consolePort(d); if (!p) { toast('Toto zařízení nemá konzolový port.', 'warn'); return; } if (S.sim.linkOf(d.id, p.name)) { toast('Konzolový port je obsazený.', 'warn'); return; } start(p); }
      else portMenu(d, cable, ev.clientX, ev.clientY, start);
      return;
    }
    const da = devById(S.cableStart.dev);
    if (!da || da.id === d.id) return;
    const pa = NM.findPort(da, S.cableStart.port);
    if (cable === 'auto') {
      let pb = pickAutoPort(d, da);
      if (pa.media === 'serial') pb = freePorts(d).find(p => p.media === 'serial') || null;
      if (!pb) { toast(d.name + ' nemá volný kompatibilní port.', 'warn'); return; }
      finish(pa, pb, da, d);
    } else if (cable === 'console') {
      const pb = consolePort(d);
      if (!pb || S.sim.linkOf(d.id, pb.name)) { toast('Konzolový port není volný.', 'warn'); return; }
      if (!!da.ios === !!d.ios) { toast('Konzolový kabel spojuje PC (RS 232) a router/switch (Console).', 'warn'); return; }
      finish(pa, pb, da, d);
    } else portMenu(d, cable, ev.clientX, ev.clientY, pb => finish(pa, pb, da, d));
  }

  /* -------- mazání -------- */
  function deleteDevices(ids) {
    change(() => {
      const set = new Set(ids);
      S.project.devices = S.project.devices.filter(d => !set.has(d.id));
      S.project.links = S.project.links.filter(l => !set.has(l.a.dev) && !set.has(l.b.dev));
      for (const id of ids) { S.sessions.delete(id); S.terms.delete(id); S.sel.delete(id); }
    }, { inspector: true });
  }
  function deleteLink(id) { change(() => { S.project.links = S.project.links.filter(l => l.id !== id); if (S.selLink === id) S.selLink = null; }, { inspector: true }); }
  function deleteNote(id) { change(() => { S.project.notes = S.project.notes.filter(n => n.id !== id); if (S.selNote === id) S.selNote = null; }, { inspector: true }); }
  function deleteSelection() {
    if (S.sel.size) deleteDevices([...S.sel]);
    else if (S.selLink) deleteLink(S.selLink);
    else if (S.selNote) deleteNote(S.selNote);
  }

  /* =========================== myš na plátně =========================== */
  let drag = null;
  svg.addEventListener('pointerdown', e => {
    if (e.button === 2) return;
    closePortMenu();
    svg.focus({ preventScroll: true });
    const w = toWorld(e.clientX, e.clientY);
    const devEl = e.target.closest('[data-dev]'), linkEl = e.target.closest('[data-link]'), noteEl = e.target.closest('[data-note]');
    const d = devEl && devById(devEl.dataset.dev);
    if (e.button === 1) { drag = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: S.view.x, vy: S.view.y }; capture(e); return; }
    if (S.placeModel && !d) { addDevice(S.placeModel, w.x, w.y); if (!e.shiftKey) setTool('select'); return; }
    if (S.tool === 'cable') { if (d) cableClick(d, e); else if (S.cableStart) { S.cableStart = null; $('#lAnim').querySelectorAll('.ghost').forEach(g => g.remove()); } return; }
    if (S.tool === 'delete') { if (d) deleteDevices([d.id]); else if (linkEl) deleteLink(linkEl.dataset.link); else if (noteEl) deleteNote(noteEl.dataset.note); return; }
    if (S.tool === 'pdu') { if (d) pduClick(d); return; }
    if (S.tool === 'note' && !d && !noteEl) {
      askText('Nová poznámka', '', 'Text poznámky').then(t => { if (t && t.trim()) change(() => S.project.notes.push({ id: NM.uid('note'), x: Math.round(w.x), y: Math.round(w.y), text: t })); });
      setTool('select'); return;
    }
    if (d) {
      if (e.shiftKey || e.ctrlKey) { S.sel.has(d.id) ? S.sel.delete(d.id) : S.sel.add(d.id); }
      else if (!S.sel.has(d.id)) S.sel = new Set([d.id]);
      S.selLink = null; S.selNote = null;
      const ids = [...S.sel];
      drag = { type: 'move', sx: w.x, sy: w.y, start: ids.map(id => { const z = devById(id); return { z, x: z.x, y: z.y }; }), commit: begin(), moved: false };
      capture(e);
      updateSel(); renderInspector(); sendSel();
      return;
    }
    if (noteEl) {
      const n = S.project.notes.find(z => z.id === noteEl.dataset.note);
      S.sel.clear(); S.selLink = null; S.selNote = n.id;
      drag = { type: 'note', sx: w.x, sy: w.y, n, x: n.x, y: n.y, commit: begin(), moved: false };
      capture(e); updateSel(); renderInspector(); return;
    }
    if (linkEl) { S.sel.clear(); S.selNote = null; S.selLink = linkEl.dataset.link; updateSel(); renderInspector(); sendSel(); return; }
    // pozadí
    if (e.shiftKey) { drag = { type: 'rubber', sx: w.x, sy: w.y }; capture(e); return; }
    drag = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: S.view.x, vy: S.view.y, click: true };
    capture(e);
  });
  svg.addEventListener('pointermove', e => {
    const w = toWorld(e.clientX, e.clientY);
    if (S.cowork && S.cowork.roomRef) S.cowork.setPresence({ cur: { x: Math.round(w.x), y: Math.round(w.y) } });
    if (S.cableStart) { const g = $('#lAnim .ghost'); if (g) { g.setAttribute('x2', w.x); g.setAttribute('y2', w.y); } }
    if (!drag) return;
    if (drag.type === 'pan') {
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.click = false;
      S.view.x = drag.vx + dx; S.view.y = drag.vy + dy; applyView(); renderCursors();
    } else if (drag.type === 'move') {
      const dx = w.x - drag.sx, dy = w.y - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) * S.view.k < 3) return;
      drag.moved = true;
      for (const s of drag.start) { s.z.x = Math.round(s.x + dx); s.z.y = Math.round(s.y + dy); }
      scheduleRender();
      if (S.cowork && S.cowork.roomRef) S.cowork.push(S.project);
    } else if (drag.type === 'note') {
      drag.moved = true; drag.n.x = Math.round(drag.x + w.x - drag.sx); drag.n.y = Math.round(drag.y + w.y - drag.sy); scheduleRender();
    } else if (drag.type === 'rubber') {
      const r = $('#rubber');
      r.setAttribute('x', Math.min(w.x, drag.sx)); r.setAttribute('y', Math.min(w.y, drag.sy));
      r.setAttribute('width', Math.abs(w.x - drag.sx)); r.setAttribute('height', Math.abs(w.y - drag.sy));
      r.setAttribute('visibility', 'visible'); drag.ex = w.x; drag.ey = w.y;
    }
  });
  svg.addEventListener('pointerup', e => {
    if (!drag) return;
    const dr = drag; drag = null;
    if (dr.type === 'move' || dr.type === 'note') { if (dr.moved) dr.commit(); }
    else if (dr.type === 'rubber') {
      $('#rubber').setAttribute('visibility', 'hidden');
      if (dr.ex !== undefined) {
        const x0 = Math.min(dr.sx, dr.ex), x1 = Math.max(dr.sx, dr.ex), y0 = Math.min(dr.sy, dr.ey), y1 = Math.max(dr.sy, dr.ey);
        S.sel = new Set(S.project.devices.filter(d => d.x >= x0 && d.x <= x1 && d.y >= y0 && d.y <= y1).map(d => d.id));
        S.selLink = null; S.selNote = null; updateSel(); renderInspector(); sendSel();
      }
    } else if (dr.type === 'pan' && dr.click) {
      if (S.sel.size || S.selLink || S.selNote) { S.sel.clear(); S.selLink = null; S.selNote = null; updateSel(); renderInspector(); sendSel(); }
    }
  });
  svg.addEventListener('dblclick', e => {
    // kvůli pointer capture je cílem události samotné SVG – zjisti prvek pod kurzorem
    const under = document.elementFromPoint(e.clientX, e.clientY) || e.target;
    const devEl = under.closest('[data-dev]'), noteEl = under.closest('[data-note]');
    if (devEl) {
      const d = devById(devEl.dataset.dev);
      S.insTab.set(d.id, d.ios ? 'cli' : NM.HOST_KINDS.has(d.kind) ? 'cmd' : 'ports');
      renderInspector();
      const inp = $('#inspector .term input'); if (inp) inp.focus();
    } else if (noteEl) {
      const n = S.project.notes.find(z => z.id === noteEl.dataset.note);
      askText('Upravit poznámku', n.text).then(t => { if (t !== null) change(() => { n.text = t; }); });
    }
  });
  svg.addEventListener('wheel', e => { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); renderCursors(); }, { passive: false });
  svg.addEventListener('contextmenu', e => { e.preventDefault(); if (S.tool !== 'select' || S.placeModel) setTool('select'); });
  const stage = $('#stage');
  stage.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('text/x-model')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  stage.addEventListener('drop', e => {
    const m = e.dataTransfer.getData('text/x-model');
    if (m) { e.preventDefault(); const w = toWorld(e.clientX, e.clientY); addDevice(m, w.x, w.y); }
  });
  function sendSel() { if (S.cowork && S.cowork.roomRef) S.cowork.setPresence({ sel: [...S.sel] }); }

  /* =========================== ping / animace =========================== */
  function pduClick(d) {
    if (!S.pduSrc) {
      if (!S.sim.l3Ifaces(d, true).length && !NM.HOST_KINDS.has(d.kind)) { toast(d.name + ' nemá žádnou IP adresu.', 'warn'); return; }
      S.pduSrc = d.id; hint(`Zdroj: ${d.name} → klikni na cíl`); return;
    }
    const src = devById(S.pduSrc);
    S.pduSrc = null; hint('Ping: klikni na zdrojové a potom cílové zařízení');
    if (!src || src.id === d.id) return;
    const dst = S.sim.l3Ifaces(d, true)[0];
    if (!dst) { toast(d.name + ' nemá IP adresu.', 'warn'); return; }
    runPing(src, dst.ip, d);
  }
  const REASONS = { acl: 'Zablokováno access-listem (ACL)', arp: 'ARP bez odpovědi (cíl/brána není v L2 síti)', unreachable: 'Cíl nedostupný (chybí trasa na routeru)', 'noroute-src': 'Zdroj nemá trasu ani výchozí bránu', ttl: 'Vypršelo TTL (smyčka?)', drop: 'Zařízení nesměruje (vypnutý routing)', noreply: 'Odpověď se nevrátila zpět', badip: 'Neplatná IP', loop: 'Směrovací smyčka' };
  function runPing(src, dstIp, dstDev) {
    const r = S.sim.ping(src, dstIp);
    const row = { id: S.pdus.length + 1, src: src.name, dst: (dstDev ? dstDev.name + ' ' : '') + dstIp, ok: r.ok, reason: r.ok ? '' : (REASONS[r.reason] || r.reason) + (r.from && !r.ok ? ` @ ${r.from.name}` : ''), t: new Date() };
    S.pdus.unshift(row); renderPdus();
    animatePing(src, r);
    return r;
  }
  function renderPdus() {
    const el = $('#bp-pdu');
    if (!S.pdus.length) { el.innerHTML = '<p class="muted" style="padding:10px">Zatím žádné pingy. Použij nástroj <b>Ping</b> (P) nebo příkaz <code>ping</code> v CLI.</p>'; return; }
    el.innerHTML = `<table class="grid"><tr><th>#</th><th>Stav</th><th>Zdroj</th><th>Cíl</th><th>Typ</th><th>Detail</th><th>Čas</th><th></th></tr>${S.pdus.map(p => `<tr><td>${p.id}</td><td class="${p.ok ? 'st-ok' : 'st-bad'}">${p.ok ? 'Úspěch' : 'Selhal'}</td><td>${esc(p.src)}</td><td>${esc(p.dst)}</td><td>ICMP</td><td class="muted">${esc(p.reason)}</td><td class="muted">${p.t.toLocaleTimeString()}</td><td><button class="small" data-repeat="${p.id}">Znovu</button></td></tr>`).join('')}</table>`;
  }
  $('#bp-pdu').addEventListener('click', e => {
    const b = e.target.closest('[data-repeat]'); if (!b) return;
    const p = S.pdus.find(x => x.id === +b.dataset.repeat);
    const src = S.project.devices.find(d => d.name === p.src); const ip = p.dst.split(' ').pop();
    if (src) runPing(src, ip, S.project.devices.find(d => S.sim.owns(d, ip)));
  });
  let animQueue = Promise.resolve();
  function animatePing(src, r) {
    const fwd = window.NetSim.Sim.flatten(r.fwd ? r.fwd.segments : []);
    const back = r.back ? window.NetSim.Sim.flatten(r.back.segments) : [];
    if (!fwd.length) fwd.push(src.id);
    animQueue = animQueue.then(async () => {
      const sim = S.mode === 'simulation';
      const per = (sim ? 650 : 170) / (sim ? +$('#simSpeed').value : 1);
      await moveEnvelope(fwd, '#fbbf24', per, 'ICMP Echo');
      if (!r.ok && (!r.back)) { failMark(r.fwd && r.fwd.at ? r.fwd.at : src); logEvent(r.fwd && r.fwd.at ? r.fwd.at.name : src.name, '—', 'ICMP', 'Zahozeno: ' + (REASONS[r.reason] || r.reason)); return; }
      if (back.length) await moveEnvelope(back, r.ok ? '#4ade80' : '#f87171', per, 'ICMP Echo Reply');
      if (!r.ok) failMark(r.back && r.back.at ? r.back.at : src);
    });
  }
  function logEvent(last, at, type, info) {
    S.events.push({ t: (S.simT += 0.001).toFixed(3), last, at, type, info });
    if (S.events.length > 500) S.events.shift();
    if (S.mode === 'simulation') renderEvents();
  }
  function renderEvents() {
    const el = $('#bp-events');
    if (!S.events.length) { el.innerHTML = '<p class="muted" style="padding:10px">Přepni na <b>Simulace</b> a pošli ping – uvidíš každý skok paketu.</p>'; return; }
    el.innerHTML = `<table class="grid"><tr><th>Čas (s)</th><th>Poslední zařízení</th><th>Na zařízení</th><th>Typ</th><th>Info</th></tr>${S.events.slice().reverse().map(ev => `<tr><td>${ev.t}</td><td>${esc(ev.last)}</td><td>${esc(ev.at)}</td><td>${esc(ev.type)}</td><td class="muted">${esc(ev.info || '')}</td></tr>`).join('')}</table>`;
  }
  function moveEnvelope(ids, color, per, type) {
    return new Promise(resolve => {
      const pts = ids.map(devById).filter(Boolean);
      if (pts.length < 2) { resolve(); return; }
      const g = svgEl('g', { style: `color:${color}` }, $('#lAnim'));
      svgEl('use', { href: '#ico-env', x: -10, y: -7, width: 20, height: 14 }, g);
      let i = 0, t0 = performance.now();
      if (S.mode === 'simulation') logEvent('—', pts[0].name, type, 'Vytvořen paket');
      const step = now => {
        const a = pts[i], b = pts[i + 1];
        const f = Math.min(1, (now - t0) / per);
        const x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f;
        g.setAttribute('transform', `translate(${x},${y - 18})`);
        if (f >= 1) {
          if (S.mode === 'simulation') logEvent(a.name, b.name, type, '');
          i++; t0 = now;
          if (i >= pts.length - 1) { g.remove(); resolve(); return; }
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }
  function failMark(d) {
    const g = svgEl('g', { transform: `translate(${d.x},${d.y - 30})` }, $('#lAnim'));
    svgEl('circle', { r: 11, fill: '#ef4444', stroke: '#fff', 'stroke-width': 2 }, g);
    svgEl('path', { d: 'M-4.5-4.5L4.5 4.5M4.5-4.5L-4.5 4.5', stroke: '#fff', 'stroke-width': 2.6, 'stroke-linecap': 'round' }, g);
    setTimeout(() => g.remove(), 1600);
  }

  /* =========================== diagnostika =========================== */
  let problems = [];
  function refreshProblems() {
    const P = [], sim = S.sim, p = S.project;
    const ipOwners = new Map();
    for (const d of p.devices) for (const q of d.ports) {
      if (!q.ip || !q.mask) continue;
      if (!IP.valid(q.ip) || !IP.maskValid(q.mask)) { P.push({ sev: 'err', dev: d.id, msg: `${d.name} ${q.name}: neplatná IP/maska ${q.ip} ${q.mask}` }); continue; }
      if (!IP.isHostAddr(q.ip, q.mask)) P.push({ sev: 'err', dev: d.id, msg: `${d.name} ${q.name}: ${q.ip}/${IP.prefixLen(q.mask)} je adresa sítě nebo broadcast` });
      const k = q.ip; if (!ipOwners.has(k)) ipOwners.set(k, []); ipOwners.get(k).push(`${d.name} ${NM.shortIf(q.name)}`);
    }
    for (const [ip, list] of ipOwners) if (list.length > 1) P.push({ sev: 'err', msg: `Duplicitní IP ${ip}: ${list.join(', ')}` });
    for (const l of p.links) {
      const st = sim.linkState(l); if (st.up) continue;
      const a = devById(l.a.dev), b = devById(l.b.dev);
      P.push({ sev: /shutdown/.test(st.reason) ? 'warn' : 'err', link: l.id, msg: `Kabel ${a && a.name} ${NM.shortIf(l.a.port)} ↔ ${b && b.name} ${NM.shortIf(l.b.port)}: ${st.reason}` });
    }
    for (const d of p.devices) {
      if (NM.HOST_KINDS.has(d.kind)) {
        const n = nicOf(d); if (!n) continue;
        const linked = sim.linkOf(d.id, n.name);
        if (linked && !n.ip) P.push({ sev: 'info', dev: d.id, msg: `${d.name}: nemá nastavenou IP adresu` });
        if (n.ip && d.gateway && IP.maskValid(n.mask) && IP.valid(d.gateway) && !IP.sameNet(n.ip, d.gateway, n.mask)) P.push({ sev: 'err', dev: d.id, msg: `${d.name}: brána ${d.gateway} není ve stejné síti jako ${n.ip}/${IP.prefixLen(n.mask)}` });
        else if (n.ip && d.gateway && linked && IP.valid(d.gateway)) {
          const r = sim.ping(d, d.gateway);
          if (!r.ok) P.push({ sev: 'warn', dev: d.id, msg: `${d.name}: výchozí brána ${d.gateway} neodpovídá` });
        }
      }
      if (d.ios && d.cfg && (d.kind === 'switch' || d.kind === 'l3switch')) {
        const missing = new Set();
        for (const q of d.ports) if (sim.isSwitchPort(d, q) && q.mode === 'access' && !d.cfg.vlans[q.vlan || 1]) missing.add(q.vlan);
        for (const v of missing) P.push({ sev: 'warn', dev: d.id, msg: `${d.name}: VLAN ${v} je přiřazená portům, ale neexistuje` });
        for (const q of d.ports) {
          if (!sim.isSwitchPort(d, q) || sim.effMode(d, q) !== 'trunk') continue;
          const lk = sim.linkOf(d.id, q.name); if (!lk) continue;
          const pd = devById(lk.peer.dev), pq = pd && NM.findPort(pd, lk.peer.port);
          if (pd && pq && pd.ios && sim.isSwitchPort(pd, pq) && sim.effMode(pd, pq) === 'trunk' && (q.native || 1) !== (pq.native || 1) && d.id < pd.id)
            P.push({ sev: 'warn', dev: d.id, msg: `Nesoulad native VLAN na trunku ${d.name} ${NM.shortIf(q.name)} (${q.native || 1}) ↔ ${pd.name} (${pq.native || 1})` });
        }
      }
      if (d.kind === 'router' && d.cfg) for (const q of d.ports) if (q.ip && q.shutdown && !q.hidden) P.push({ sev: 'warn', dev: d.id, msg: `${d.name} ${q.name}: má IP adresu, ale je vypnuté (shutdown)` });
    }
    problems = P;
    const n = P.filter(x => x.sev === 'err').length;
    $('#probCount').textContent = n ? String(n) : '';
    const el = $('#bp-problems');
    el.innerHTML = P.length ? P.map((x, i) => `<div class="prob" data-i="${i}"><span class="sev ${x.sev}"></span><span>${esc(x.msg)}</span></div>`).join('') : '<p class="muted" style="padding:10px">✓ Žádné problémy nenalezeny.</p>';
  }
  $('#bp-problems').addEventListener('click', e => {
    const it = e.target.closest('.prob'); if (!it) return;
    const x = problems[+it.dataset.i];
    if (x.dev) { S.sel = new Set([x.dev]); S.selLink = null; } else if (x.link) { S.sel.clear(); S.selLink = x.link; }
    render(); renderInspector();
  });

  /* =========================== inspektor =========================== */
  function renderInspector() {
    const el = $('#inspector');
    S.remoteStale = false;
    if (S.sel.size === 1) return renderDevice(el, devById([...S.sel][0]));
    if (S.sel.size > 1) {
      el.innerHTML = `<div class="ins-body"><h4>Vybráno ${S.sel.size} zařízení</h4><p class="muted">${[...S.sel].map(id => esc(devLabel(devById(id)))).join(', ')}</p><div class="row"><button class="danger" id="delSel">Smazat vybraná</button></div></div>`;
      $('#delSel').onclick = deleteSelection; return;
    }
    if (S.selLink) return renderLink(el, S.project.links.find(l => l.id === S.selLink));
    if (S.selNote) {
      const n = S.project.notes.find(z => z.id === S.selNote);
      el.innerHTML = `<div class="ins-body"><h4>Poznámka</h4><textarea id="noteText" style="width:100%;min-height:140px">${esc(n.text)}</textarea><div class="row" style="margin-top:8px"><button class="danger" id="delNote">Smazat</button></div></div>`;
      $('#noteText').onchange = e => change(() => { n.text = e.target.value; });
      $('#delNote').onclick = () => deleteNote(n.id); return;
    }
    renderOverview(el);
  }
  function refreshInspectorLight() {
    // po změně obnov inspektor, ale nepřerušuj psaní ani terminál
    const a = document.activeElement, insp = $('#inspector');
    if (a && insp.contains(a)) {
      if (a.closest('.term')) return;
      if (isTyping()) { S.remoteStale = true; return; }
    }
    const tab = S.sel.size === 1 ? S.insTab.get([...S.sel][0]) : null;
    if (tab === 'cli' || tab === 'cmd') return;
    renderInspector();
  }
  $('#inspector').addEventListener('focusout', () => setTimeout(() => {
    if (S.remoteStale && !$('#inspector').contains(document.activeElement)) renderInspector();
  }, 50));
  function renderOverview(el) {
    const p = S.project;
    const err = problems.filter(x => x.sev === 'err').length;
    el.innerHTML = `<div class="ins-body">
      <h4>Projekt</h4>
      <div class="form"><label>Název</label><input id="pName" value="${esc(p.name)}"></div>
      <div class="stats" style="margin-top:12px">
        <div class="card"><div class="big">${p.devices.length}</div><div class="muted">zařízení</div></div>
        <div class="card"><div class="big">${p.links.length}</div><div class="muted">kabelů</div></div>
        <div class="card"><div class="big" style="color:${err ? 'var(--bad)' : 'var(--ok)'}">${err}</div><div class="muted">chyb</div></div>
      </div>
      ${p.source && p.source.kind !== 'new' ? `<h4>Zdroj</h4><p class="muted">${esc(p.source.fileName)} · Packet Tracer ${esc(p.source.ptVersion || '?')} · ${p.source.kind === 'pka' ? 'aktivita (.pka)' : 'síť (.pkt)'}<br>${S.ctx ? '✓ lze ukládat zpět do .pkt' : '⚠ šablona .pkt není načtená'}</p>` : ''}
      ${p.instructions ? `<h4>Zadání aktivity</h4><iframe class="instr" sandbox="" id="instrFrame"></iframe>` : ''}
      <h4>Klávesové zkratky</h4>
      <p class="muted" style="line-height:1.7">V výběr · C automatický kabel · P ping · N poznámka · D mazání · F zobrazit vše<br>Del smazat · Ctrl+Z / Ctrl+Y zpět / znovu · Ctrl+S uložit · Ctrl+O otevřít<br>Shift+tažení výběr obdélníkem · dvojklik na zařízení otevře CLI</p>
    </div>`;
    $('#pName').onchange = e => change(() => { p.name = e.target.value || 'Projekt'; });
    if (p.instructions) $('#instrFrame').srcdoc = p.instructions;
  }
  function renderLink(el, l) {
    if (!l) { renderOverview(el); return; }
    const a = devById(l.a.dev), b = devById(l.b.dev), st = S.sim.linkState(l);
    el.innerHTML = `<div class="ins-body"><h4>Kabel</h4>
      <div class="form">
        <label>Konec A</label><span><b>${esc(a.name)}</b> <span class="mono">${esc(l.a.port)}</span></span>
        <label>Konec B</label><span><b>${esc(b.name)}</b> <span class="mono">${esc(l.b.port)}</span></span>
        <label>Typ</label><select id="cabType">${Object.entries(CABLE_NAMES).map(([k, v]) => `<option value="${k}" ${l.cable === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <label>Stav</label><span>${st.up ? '<span class="badge ok">funguje</span>' : `<span class="badge bad">nefunguje</span><br><span class="muted">${esc(st.reason)}</span>`}</span>
      </div><div class="row" style="margin-top:12px"><button class="danger" id="delLink">Odpojit kabel</button></div></div>`;
    $('#cabType').onchange = e => change(() => { l.cable = e.target.value; }, { inspector: true });
    $('#delLink').onclick = () => deleteLink(l.id);
  }

  function devTabs(d) {
    if (d.ios) return [['ports', 'Rozhraní'], ['cli', 'CLI'], ['config', 'Konfigurace'], ['cfgtxt', 'Running-config']];
    if (NM.HOST_KINDS.has(d.kind)) return [['ip', 'IP nastavení'], ['cmd', 'Příkazový řádek'], ...(d.kind === 'server' ? [['services', 'Služby']] : []), ['ports', 'Porty']];
    return [['ports', 'Porty']];
  }
  function renderDevice(el, d) {
    if (!d) { renderOverview(el); return; }
    const tabs = devTabs(d);
    let tab = S.insTab.get(d.id); if (!tabs.some(t => t[0] === tab)) tab = tabs[0][0];
    S.insTab.set(d.id, tab);
    el.innerHTML = `<div class="ins-head">${window.Icons.icon(iconKind(d))}<div class="nm"><input class="name" id="devName" value="${esc(d.name)}" title="Název zařízení (zobrazovaný)"><div class="model">${esc(KIND_NAMES[d.kind] || d.kind)} · ${esc(d.model)}</div></div>
      <button id="pwrBtn" class="small" title="Napájení">${d.power === false ? '⏻ Zapnout' : '⏻ Vypnout'}</button></div>
      <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="ins-body" id="insBody"></div>`;
    $('#devName').onchange = e => change(() => { d.name = e.target.value.trim() || d.name; });
    $('#pwrBtn').onclick = () => change(() => { d.power = d.power === false; }, { inspector: true });
    $$('.tabs [data-tab]', el).forEach(b => b.onclick = () => { S.insTab.set(d.id, b.dataset.tab); renderDevice(el, d); });
    const body = $('#insBody');
    ({ ports: tabPorts, cli: tabTerm, cmd: tabTerm, config: tabConfig, cfgtxt: tabCfgTxt, ip: tabIp, services: tabServices })[tab](body, d);
  }

  function statusDot(d, p) {
    const lk = S.sim.linkOf(d.id, p.name);
    const st = d.ios ? S.sim.ifStatus(d, p) : { up: S.sim.physUp(d, p) };
    if (p.shutdown) return '<span class="dot down" title="vypnuto (shutdown)"></span>';
    return st.up ? '<span class="dot up" title="up"></span>' : lk ? '<span class="dot down" title="down"></span>' : '<span class="dot idle" title="nezapojeno"></span>';
  }
  function tabPorts(body, d) {
    const sim = S.sim;
    const isSw = d.kind === 'switch' || d.kind === 'l3switch';
    const ports = d.ports.filter(p => !p.hidden || sim.linkOf(d.id, p.name));
    const vlanOpts = d.cfg ? Object.keys(d.cfg.vlans).map(Number).sort((a, b) => a - b) : [];
    let h = `<table class="ports"><tr><th></th><th>Rozhraní</th><th>${isSw ? 'Režim / VLAN' : 'IP adresa / maska'}</th><th title="Zapnuto">On</th></tr>`;
    for (const p of ports) {
      const lk = sim.linkOf(d.id, p.name), peer = lk && devById(lk.peer.dev);
      const swp = sim.isSwitchPort(d, p);
      let cfgCell;
      if (swp) {
        const eff = sim.effMode(d, p);
        cfgCell = `<select data-f="mode" title="Režim portu"><option value="access" ${p.mode === 'access' ? 'selected' : ''}>access</option><option value="trunk" ${p.mode === 'trunk' ? 'selected' : ''}>trunk</option><option value="dynamic" ${p.mode === 'dynamic' ? 'selected' : ''}>auto${p.mode === 'dynamic' ? ' (' + eff + ')' : ''}</option></select>
          ${eff === 'access' ? `<select data-f="vlan">${vlanOpts.map(v => `<option value="${v}" ${(p.vlan || 1) === v ? 'selected' : ''}>VLAN ${v}</option>`).join('')}${vlanOpts.includes(p.vlan || 1) ? '' : `<option selected>VLAN ${p.vlan} (chybí)</option>`}</select>` : `<span class="muted mono" title="Povolené VLAN">${p.allowed === 'all' ? 'všechny' : NM.vlanListStr(p.allowed)}</span>`}`;
      } else if (p.media === 'console') cfgCell = '<span class="muted">konzole</span>';
      else cfgCell = `<input data-f="ip" value="${esc(p.dhcp ? (p.ip || 'DHCP') : p.ip)}" placeholder="IP" style="width:52%"> <input data-f="mask" value="${esc(p.mask)}" placeholder="maska" style="width:44%">`;
      const on = d.ios || NM.HOST_KINDS.has(d.kind) ? `<input type="checkbox" data-f="on" ${p.shutdown ? '' : 'checked'}>` : '';
      h += `<tr data-port="${esc(p.name)}"><td>${statusDot(d, p)}</td><td class="mono" title="${esc(p.name)}${p.mac ? '\nMAC ' + p.mac : ''}">${esc(NM.shortIf(p.name))}${peer ? `<br><small class="muted">→ ${esc(peer.name)}</small>` : ''}</td><td>${cfgCell}</td><td>${on}</td></tr>`;
    }
    h += '</table>';
    if (d.kind === 'router' || d.kind === 'l3switch') h += `<p class="muted" style="margin-top:8px">Subrozhraní (router-on-a-stick), loopbacky a SVI přidáš v CLI, např. <code>interface g0/0.10</code>.</p>`;
    body.innerHTML = h;
    body.onchange = e => {
      const tr = e.target.closest('tr[data-port]'); if (!tr) return;
      const p = NM.findPort(d, tr.dataset.port), f = e.target.dataset.f, v = e.target.value.trim();
      if (f === 'ip' || f === 'mask') {
        const row = tr; const ipv = $('[data-f=ip]', row).value.trim(); let mk = $('[data-f=mask]', row).value.trim();
        if (f === 'ip' && IP.valid(ipv) && !mk) { mk = IP.classfulMask(ipv); $('[data-f=mask]', row).value = mk; }
        const okIp = !ipv || IP.valid(ipv), okM = !mk || IP.maskValid(mk);
        $('[data-f=ip]', row).classList.toggle('bad', !okIp); $('[data-f=mask]', row).classList.toggle('bad', !okM);
        if (!okIp || !okM) return;
        change(() => { p.ip = ipv; p.mask = ipv ? mk : ''; p.dhcp = false; });
      } else if (f === 'on') change(() => { p.shutdown = !e.target.checked; }, { inspector: true });
      else if (f === 'mode') change(() => { p.mode = v; }, { inspector: true });
      else if (f === 'vlan') change(() => { p.vlan = parseInt(v.replace(/\D/g, ''), 10) || 1; }, { inspector: true });
    };
  }

  /* -------- GUI konfigurace IOS -------- */
  function tabConfig(body, d) {
    const c = d.cfg, isSw = d.kind !== 'router';
    let h = `<h4>Globální</h4><div class="form">
      <label>Hostname</label><input data-g="hostname" value="${esc(c.hostname)}">
      <label>Enable secret</label><input data-g="secret" placeholder="${c.enableSecret ? '•••••• (nastaveno)' : 'nenastaveno'}" type="password">
      <label>Heslo konzole</label><input data-g="con" value="${esc(c.lines.con.password)}" placeholder="žádné">
      <label>Heslo VTY</label><input data-g="vty" value="${esc(c.lines.vty.password)}" placeholder="žádné">
      <label>Banner MOTD</label><input data-g="banner" value="${esc(c.bannerMotd)}">
      ${isSw && d.kind === 'switch' ? `<label>Default gateway</label><input data-g="dgw" value="${esc(c.defaultGateway)}">` : ''}
      ${d.kind === 'l3switch' ? `<label>IP routing</label><label class="chk"><input type="checkbox" data-g="iprouting" ${c.ipRouting ? 'checked' : ''}> zapnuto</label>` : ''}
      <label>Šifrovat hesla</label><label class="chk"><input type="checkbox" data-g="pwenc" ${c.servicePwdEnc ? 'checked' : ''}> service password-encryption</label>
    </div>`;
    if (isSw) {
      h += `<h4>VLAN databáze</h4><table class="ports"><tr><th>VLAN</th><th>Název</th><th></th></tr>${Object.keys(c.vlans).map(Number).sort((a, b) => a - b).map(v => `<tr><td class="mono">${v}</td><td><input data-vname="${v}" value="${esc(c.vlans[v])}" ${v === 1 ? 'disabled' : ''}></td><td>${v === 1 ? '' : `<button class="small danger" data-vdel="${v}">✕</button>`}</td></tr>`).join('')}
        <tr><td><input id="newVid" placeholder="ID" style="width:60px"></td><td><input id="newVname" placeholder="název (volitelný)"></td><td><button class="small" id="addVlan">Přidat</button></td></tr></table>`;
    }
    if (d.kind !== 'switch') {
      h += `<h4>Statické trasy</h4><table class="ports"><tr><th>Síť</th><th>Maska</th><th>Next hop</th><th></th></tr>${c.routes.map((r, i) => `<tr><td class="mono">${esc(r.net)}</td><td class="mono">${esc(r.mask)}</td><td class="mono">${esc(r.nh || r.iface)}</td><td><button class="small danger" data-rdel="${i}">✕</button></td></tr>`).join('')}
        <tr><td><input id="rNet" placeholder="0.0.0.0"></td><td><input id="rMask" placeholder="0.0.0.0"></td><td><input id="rNh" placeholder="next hop"></td><td><button class="small" id="addRoute">+</button></td></tr></table>`;
      const rp = [];
      if (c.rip) rp.push(`RIP v${c.rip.version}: ${c.rip.networks.join(', ') || '—'}`);
      for (const o of c.ospf) rp.push(`OSPF ${o.pid}: ${o.networks.map(n => `${n.net} ${n.wild} area ${n.area}`).join(', ') || '—'}`);
      for (const e of c.eigrp) rp.push(`EIGRP ${e.asn}: ${e.networks.map(n => n.net).join(', ') || '—'}`);
      h += `<h4>Dynamické směrování</h4><p class="muted">${rp.length ? rp.map(esc).join('<br>') : 'Nenastaveno.'} Konfiguruj v CLI (<code>router ospf 1</code>, <code>router rip</code>…).</p>`;
      if (c.dhcpPools.length) h += `<h4>DHCP pooly</h4><p class="muted mono">${c.dhcpPools.map(p => `${esc(p.name)}: ${esc(p.network)}/${p.mask ? IP.prefixLen(p.mask) : '?'} gw ${esc(p.router || '-')}`).join('<br>')}</p>`;
    }
    h += `<h4>Paměť</h4><div class="row"><button id="wrMem">Uložit startup-config (write)</button><span class="muted">${d.startup ? 'startup-config existuje' : 'startup-config je prázdný'}</span></div>`;
    body.innerHTML = h;
    body.onchange = e => {
      const t = e.target, g = t.dataset.g, v = t.value.trim();
      if (g === 'hostname') { if (/^[A-Za-z][\w-]*$/.test(v)) change(() => { c.hostname = v; }); else t.classList.add('bad'); }
      else if (g === 'secret' && v) change(() => { c.enableSecret = NM.makeSecret(v); }, { inspector: true });
      else if (g === 'con') change(() => { c.lines.con.password = v; c.lines.con.login = !!v; });
      else if (g === 'vty') change(() => { c.lines.vty.password = v; c.lines.vty.login = !!v; });
      else if (g === 'banner') change(() => { c.bannerMotd = v; });
      else if (g === 'dgw') { if (!v || IP.valid(v)) change(() => { c.defaultGateway = v; }); else t.classList.add('bad'); }
      else if (g === 'iprouting') change(() => { c.ipRouting = t.checked; });
      else if (g === 'pwenc') change(() => { c.servicePwdEnc = t.checked; });
      else if (t.dataset.vname) change(() => { c.vlans[+t.dataset.vname] = v || ('VLAN' + t.dataset.vname.padStart(4, '0')); });
    };
    body.onclick = e => {
      const t = e.target;
      if (t.id === 'addVlan') { const id = +$('#newVid').value; if (!id || id < 2 || id > 4094) { $('#newVid').classList.add('bad'); return; } change(() => { c.vlans[id] = $('#newVname').value.trim() || ('VLAN' + String(id).padStart(4, '0')); }, { inspector: true }); }
      if (t.dataset.vdel) change(() => { delete c.vlans[+t.dataset.vdel]; }, { inspector: true });
      if (t.id === 'addRoute') {
        const n = $('#rNet').value.trim(), m = $('#rMask').value.trim(), nh = $('#rNh').value.trim();
        if (!IP.valid(n) || !IP.maskValid(m) || !IP.valid(nh)) { toast('Zadej platnou síť, masku a next hop.', 'warn'); return; }
        change(() => { c.routes.push({ net: IP.str(IP.network(n, m)), mask: m, nh }); }, { inspector: true });
      }
      if (t.dataset.rdel !== undefined) change(() => { c.routes.splice(+t.dataset.rdel, 1); }, { inspector: true });
      if (t.id === 'wrMem') change(() => { d.startup = NM.generateConfig(d); }, { inspector: true });
    };
  }
  function tabCfgTxt(body, d) {
    const lines = NM.generateConfig(d);
    body.innerHTML = `<div class="row" style="margin-bottom:8px"><button id="cpCfg">Kopírovat</button><button id="pasteCfg">Vložit konfiguraci…</button><button id="dlCfg">Stáhnout .txt</button></div><pre class="cfg">${esc(lines.join('\n'))}</pre>`;
    $('#cpCfg').onclick = () => navigator.clipboard.writeText(lines.join('\n')).then(() => toast('Zkopírováno', 'ok'));
    $('#dlCfg').onclick = () => download(lines.join('\r\n'), (d.cfg.hostname || d.name) + '-running-config.txt', 'text/plain');
    $('#pasteCfg').onclick = async () => {
      const t = await askText('Vložit konfiguraci', '', 'Příkazy se provedou v režimu „configure terminal“ (jako vložení do konzole).');
      if (!t) return;
      const commit = begin();
      const s = CLI.newIosSession(d, S.sim); s.pending = null; s.mode = 'config';
      let errs = 0;
      for (const line of t.split(/\r?\n/)) { if (!line.trim() || line.trim() === '!') continue; const r = CLI.exec(s, line); if (/% (Invalid|Incomplete|Ambiguous)/.test(r.out)) errs++; }
      commit({ inspector: true });
      toast(errs ? `Konfigurace vložena, ${errs} řádků nebylo rozpoznáno.` : 'Konfigurace vložena.', errs ? 'warn' : 'ok');
    };
  }

  /* -------- PC: IP nastavení -------- */
  function tabIp(body, d) {
    const n = nicOf(d);
    if (!n) { body.innerHTML = '<p class="muted">Zařízení nemá síťovou kartu.</p>'; return; }
    body.innerHTML = `<h4>${esc(n.name)}</h4><div class="form">
      <label>Režim</label><div class="row"><label class="chk"><input type="radio" name="ipm" value="dhcp" ${n.dhcp ? 'checked' : ''}> DHCP</label><label class="chk"><input type="radio" name="ipm" value="static" ${n.dhcp ? '' : 'checked'}> Statická</label>${n.dhcp ? '<button class="small" id="dhcpRenew">Získat adresu</button>' : ''}</div>
      <label>IPv4 adresa</label><input id="ipA" value="${esc(n.ip)}" ${n.dhcp ? 'disabled' : ''}>
      <label>Maska</label><input id="ipM" value="${esc(n.mask)}" ${n.dhcp ? 'disabled' : ''}>
      <label>Výchozí brána</label><input id="ipG" value="${esc(d.gateway)}" ${n.dhcp ? 'disabled' : ''}>
      <label>DNS server</label><input id="ipD" value="${esc(d.dns)}" ${n.dhcp ? 'disabled' : ''}>
      <label>MAC</label><span class="mono muted">${esc(n.mac)}</span>
      <label>Port</label><label class="chk"><input type="checkbox" id="ipOn" ${n.shutdown ? '' : 'checked'}> zapnutý</label>
    </div><p class="muted" style="margin-top:10px">Změny se uloží po opuštění pole. Masku doplním automaticky podle třídy adresy.</p>`;
    const val = () => {
      const a = $('#ipA').value.trim(); let m = $('#ipM').value.trim(); const g = $('#ipG').value.trim(), dn = $('#ipD').value.trim();
      if (a && IP.valid(a) && !m) { m = IP.classfulMask(a); $('#ipM').value = m; }
      const ok = { ipA: !a || IP.valid(a), ipM: !m || IP.maskValid(m), ipG: !g || IP.valid(g), ipD: !dn || IP.valid(dn) };
      for (const k in ok) $('#' + k).classList.toggle('bad', !ok[k]);
      if (Object.values(ok).every(Boolean)) change(() => { n.ip = a; n.mask = a ? m : ''; d.gateway = g; d.dns = dn; });
    };
    ['ipA', 'ipM', 'ipG', 'ipD'].forEach(id => $('#' + id).onchange = val);
    $('#ipOn').onchange = e => change(() => { n.shutdown = !e.target.checked; }, { inspector: true });
    $$('input[name=ipm]', body).forEach(r => r.onchange = () => {
      if (r.value === 'dhcp') dhcpRenew(d, n); else change(() => { n.dhcp = false; }, { inspector: true });
    });
    const rb = $('#dhcpRenew'); if (rb) rb.onclick = () => dhcpRenew(d, n);
  }
  function dhcpRenew(d, n) {
    const commit = begin();
    n.dhcp = true;
    const r = S.sim.dhcp(d, n);
    if (r) { n.ip = r.ip; n.mask = r.mask; d.gateway = r.gw || ''; d.dns = r.dns || ''; toast(`${d.name}: DHCP přidělil ${r.ip} (server ${r.server.name})`, 'ok'); }
    else { n.ip = ''; n.mask = ''; toast(`${d.name}: DHCP požadavek selhal – v síti není dostupný DHCP server.`, 'warn', 4500); }
    commit({ inspector: true });
  }
  function tabServices(body, d) {
    const dh = d.services.dhcp, pool = dh.pools[0];
    body.innerHTML = `<h4>DHCP server</h4><div class="form">
      <label>Služba</label><label class="chk"><input type="checkbox" id="svOn" ${dh.enabled ? 'checked' : ''}> zapnuto</label>
      <label>Výchozí brána</label><input data-k="gateway" value="${esc(pool.gateway)}">
      <label>DNS server</label><input data-k="dns" value="${esc(pool.dns)}">
      <label>Počáteční IP</label><input data-k="start" value="${esc(pool.start)}">
      <label>Maska</label><input data-k="mask" value="${esc(pool.mask)}">
      <label>Max. uživatelů</label><input data-k="max" type="number" value="${esc(pool.max)}">
    </div><h4>Zápůjčky</h4><p class="muted mono">${[...S.sim.leasesOf(d)].map(([m, ip]) => `${ip} → ${m}`).join('<br>') || 'žádné'}</p>`;
    $('#svOn').onchange = e => change(() => { dh.enabled = e.target.checked; });
    body.onchange = e => { const k = e.target.dataset.k; if (!k) return; const v = e.target.value.trim(); if (k !== 'max' && v && !IP.valid(v)) { e.target.classList.add('bad'); return; } change(() => { pool[k] = k === 'max' ? (+v || 100) : v; }); };
  }

  /* -------- terminál (CLI / příkazový řádek) -------- */
  function getSession(d) {
    let s = S.sessions.get(d.id);
    if (!s) { s = d.ios ? CLI.newIosSession(d, S.sim) : CLI.newPcSession(d, S.sim); S.sessions.set(d.id, s); }
    return s;
  }
  function getTerm(d) {
    let t = S.terms.get(d.id);
    if (t) return t;
    const s = getSession(d);
    const el = document.createElement('div');
    el.className = 'term';
    el.innerHTML = `<div class="out"></div><div class="in-line"><span class="pr"></span><input spellcheck="false" autocomplete="off"></div>`;
    const out = $('.out', el), inp = $('input', el), pr = $('.pr', el);
    const promptOf = () => s.kind === 'ios' ? CLI.prompt(s) : CLI.pcPrompt(s);
    const isPw = () => promptOf() === 'Password: ';
    const write = txt => { out.appendChild(document.createTextNode(txt)); while (out.childNodes.length > 1500) out.firstChild.remove(); };
    const refresh = () => { pr.textContent = promptOf(); inp.type = isPw() ? 'password' : 'text'; el.scrollTop = el.scrollHeight; };
    let hi = -1;
    write(s.greeting || ''); refresh();
    const run = line => {
      const p = promptOf();
      const span = document.createElement('span'); span.className = 'cmd'; span.textContent = p + (isPw() ? '' : line) + '\n';
      out.appendChild(span);
      const commit = begin();
      const r = s.kind === 'ios' ? CLI.exec(s, line) : CLI.execPc(s, line);
      if (r.clear) out.textContent = '';
      if (r.out) write(r.out + (r.out.endsWith('\n') ? '' : '\n'));
      if (r.changed) commit(); else S.sim.touch();
      for (const a of r.anim || []) { const res = a.result; S.pdus.unshift({ id: S.pdus.length + 1, src: a.src.name, dst: a.dst, ok: res.ok, reason: res.ok ? '' : (REASONS[res.reason] || res.reason), t: new Date() }); renderPdus(); animatePing(a.src, res); }
      refresh();
    };
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { const v = inp.value; inp.value = ''; hi = -1; run(v); e.preventDefault(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const H = (s.remote || s).history; if (!H.length) return;
        hi = e.key === 'ArrowUp' ? (hi < 0 ? H.length - 1 : Math.max(0, hi - 1)) : (hi < 0 ? -1 : hi + 1);
        if (hi >= H.length) hi = -1;
        inp.value = hi < 0 ? '' : H[hi]; e.preventDefault();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const ss = s.remote || s; if (ss.kind === 'ios') inp.value = CLI.complete(ss, inp.value);
      } else if (e.key === '?' && (s.remote || s).kind === 'ios' && !isPw()) {
        e.preventDefault();
        const ss = s.remote || s;
        const span = document.createElement('span'); span.className = 'cmd'; span.textContent = promptOf() + inp.value + '?\n'; out.appendChild(span);
        write(CLI.help(ss, inp.value) + '\n'); refresh();
      } else if (e.key === 'z' && e.ctrlKey) { e.preventDefault(); const ss = s.remote || s; if (ss.kind === 'ios' && !['user', 'priv'].includes(ss.mode)) run('end'); }
      else if (e.key === 'c' && e.ctrlKey && inp.selectionStart === inp.selectionEnd) { const ss = s.remote || s; if (ss.kind === 'ios' && !['user', 'priv'].includes(ss.mode)) { e.preventDefault(); inp.value = ''; run('end'); } }
      else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); out.textContent = ''; }
    });
    el.addEventListener('mouseup', () => { if (!getSelection().toString()) inp.focus(); });
    t = { el, refresh, write, run, s };
    S.terms.set(d.id, t);
    return t;
  }
  function tabTerm(body, d) {
    body.classList.add('term-wrap');
    const t = getTerm(d);
    t.s.dev = d;
    body.appendChild(t.el);
    const bar = document.createElement('div'); bar.className = 'term-bar';
    const consolePeer = (() => { if (d.ios) return null; const cp = NM.findPort(d, 'RS 232'); const lk = cp && S.sim.linkOf(d.id, cp.name); return lk && devById(lk.peer.dev); })();
    bar.innerHTML = d.ios ? `<span class="muted">Tab doplní · ? nápověda · ↑↓ historie · Ctrl+Z konec konfigurace</span><button class="small" id="tClear">Vyčistit</button>`
      : `<span class="muted">help = seznam příkazů${consolePeer ? ' · konzolový kabel k ' + esc(consolePeer.name) : ''}</span>${consolePeer ? '<button class="small" id="tCon">Terminál (konzole)</button>' : ''}<button class="small" id="tClear">Vyčistit</button>`;
    body.appendChild(bar);
    $('#tClear', bar).onclick = () => { $('.out', t.el).textContent = ''; t.refresh(); };
    const tc = $('#tCon', bar);
    if (tc) tc.onclick = () => {
      const rs = CLI.newIosSession(consolePeer, S.sim);
      rs.onExit = () => { t.s.remote = null; t.write('\n[Konzole odpojena]\n'); t.refresh(); };
      t.s.remote = rs;
      t.write(`\n[Připojeno ke konzoli ${consolePeer.name} přes RS 232 – „exit“ odpojí]\n` + (rs.greeting || ''));
      t.refresh(); $('input', t.el).focus();
    };
    t.refresh();
    setTimeout(() => { const i = $('input', t.el); if (i && !isTyping()) i.focus(); }, 0);
  }

  /* =========================== zálohy (dialog) =========================== */
  async function showBackups() {
    const B = window.Backup;
    const list = await B.list();
    const cloud = S.cowork && S.cowork.roomRef ? await S.cowork.listCloudBackups().catch(() => []) : [];
    const fmt = ts => new Date(ts).toLocaleString('cs-CZ');
    const html = `<p>Projekt se <b>automaticky ukládá</b> do prohlížeče při každé změně a obnoví se i po zavření okna. Navíc vzniká <b>historie verzí</b> (každých ${B.getSetting('snapMin', 5)} min, při otevření a uložení souboru).</p>
      <div class="row"><button type="button" id="bkNow" class="primary">Vytvořit zálohu teď</button>
      ${B.folderSupported ? `<button type="button" id="bkFolder">${B.folder ? 'Změnit složku záloh' : 'Zálohovat i do složky…'}</button>${B.folder ? `<span class="muted">📁 ${esc(B.folder.name)} ${B.folderOk ? '✓' : '(klikni pro povolení)'}</span><button type="button" class="small" id="bkFolderOff">Vypnout</button>` : ''}` : '<span class="muted">Zálohy do složky podporuje Chrome / Edge.</span>'}
      <label class="chk">Interval <select id="bkInt">${[2, 5, 10, 15, 30].map(m => `<option ${B.getSetting('snapMin', 5) === m ? 'selected' : ''} value="${m}">${m} min</option>`).join('')}</select></label></div>
      <h4 style="margin:8px 0 0">Historie v tomto prohlížeči (${list.length})</h4>
      <div class="list">${list.map(e => `<div class="it"><div class="grow"><b>${esc(e.name)}</b> <span class="muted">· ${esc(e.label)}</span><br><small class="muted">${fmt(e.ts)} · ${e.devices} zařízení, ${e.links} kabelů</small></div><button type="button" class="small" data-restore="${e.id}">Obnovit</button><button type="button" class="small" data-dl="${e.id}">Stáhnout</button><button type="button" class="small danger" data-del="${e.id}">✕</button></div>`).join('') || '<div class="it muted">Zatím žádné zálohy.</div>'}</div>
      ${S.cowork && S.cowork.roomRef ? `<h4 style="margin:8px 0 0">Zálohy v cloudu (místnost ${esc(S.cowork.roomId)})</h4><div class="list">${cloud.map(e => `<div class="it"><div class="grow"><b>${esc(e.name)}</b> <span class="muted">· ${esc(e.label)} · ${esc(e.by)}</span><br><small class="muted">${fmt(e.ts)}</small></div><button type="button" class="small" data-crestore="${esc(e.key)}">Obnovit</button></div>`).join('') || '<div class="it muted">Zatím žádné.</div>'}</div>` : ''}`;
    const dlg = ask('Zálohy a historie verzí', html, [['close', 'Zavřít']]);
    const f = $('#dlgForm');
    f.onclick = async e => {
      const t = e.target;
      if (t.id === 'bkNow') {
        const label = 'Ruční záloha';
        await B.snapshot(S.project, label, true);
        if (S.cowork && S.cowork.roomRef) await S.cowork.cloudBackup(S.project, label).catch(err => toast('Cloud záloha selhala: ' + err.message, 'err'));
        toast('Záloha vytvořena', 'ok'); $('#dlg').close(); showBackups();
      } else if (t.id === 'bkFolder') {
        try {
          if (B.folder && !B.folderOk) { await B.ensureFolderPermission(); }
          else { const n = await B.pickFolder(); toast('Zálohy se budou ukládat i do složky ' + n, 'ok'); }
          await B.snapshot(S.project, 'Záloha do složky', true);
          $('#dlg').close(); showBackups();
        } catch (err) { if (err.name !== 'AbortError') toast(err.message, 'err'); }
      } else if (t.id === 'bkFolderOff') { await B.forgetFolder(); $('#dlg').close(); showBackups(); }
      else if (t.dataset.restore) {
        const en = await B.get(+t.dataset.restore);
        await B.snapshot(S.project, 'Před obnovením zálohy', true);
        const commit = begin();
        const o = JSON.parse(en.json);
        Object.assign(S.project, { name: o.name, devices: o.devices, links: o.links, notes: o.notes || [], instructions: o.instructions || S.project.instructions });
        normalize(S.project); rebindSessions(); S.sel.clear(); S.selLink = null;
        commit({ inspector: true });
        $('#dlg').close(); toast('Obnoveno: ' + fmt(en.ts), 'ok');
      } else if (t.dataset.dl) {
        const en = await B.get(+t.dataset.dl);
        download(JSON.stringify({ format: 'nettracer', version: 1, project: JSON.parse(en.json) }), `${en.name}_${new Date(en.ts).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.ntj`, 'application/json');
      } else if (t.dataset.del) { await B.remove(+t.dataset.del); t.closest('.it').remove(); }
      else if (t.dataset.crestore) {
        const en = cloud.find(x => x.key === t.dataset.crestore);
        const o = JSON.parse(en.json);
        const commit = begin();
        Object.assign(S.project, { name: o.name, devices: o.devices, links: o.links, notes: o.notes || [] });
        normalize(S.project); rebindSessions(); S.sel.clear();
        commit({ inspector: true });
        $('#dlg').close(); toast('Obnoveno z cloudu', 'ok');
      }
    };
    f.onchange = e => { if (e.target.id === 'bkInt') B.setSetting('snapMin', +e.target.value); };
    const mine = [f.onclick, f.onchange];
    await dlg;
    if (f.onclick === mine[0]) f.onclick = null;
    if (f.onchange === mine[1]) f.onchange = null;
  }
  // periodické snímky
  setInterval(async () => {
    const B = window.Backup;
    if (!S.project || !S.dirtySinceSnap) return;
    if (Date.now() - (B.lastSnapshotAt || 0) < B.getSetting('snapMin', 5) * 60000) return;
    if (await B.snapshot(S.project, 'Automatická záloha').catch(() => false)) {
      S.dirtySinceSnap = false;
      if (S.cowork && S.cowork.roomRef && Object.keys(S.peers).length === 0 || (S.cowork && S.cowork.roomRef && S.cowork.clientId === hostOf())) S.cowork.cloudBackup(S.project, 'Automatická záloha').catch(() => {});
    }
  }, 30000);
  function hostOf() { // nejmenší clientId provádí cloudové autozálohy, ať se nezdvojují
    return [S.cowork.clientId, ...Object.keys(S.peers)].sort()[0];
  }

  /* =========================== spolupráce =========================== */
  function coworkConfig() {
    const B = window.Backup;
    return window.NETTRACER_FIREBASE || B.getSetting('fbConfig', null) || null;
  }
  function ensureCowork() {
    if (S.cowork) return S.cowork;
    S.cowork = window.Cowork.create({
      name: window.Backup.getSetting('userName', 'Host'),
      hooks: {
        onStatus: (st, msg) => {
          const b = $('#btnCowork');
          b.textContent = st === 'on' ? `● ${S.cowork.roomId}` : st === 'connecting' ? 'Připojuji…' : 'Spolupráce';
          b.classList.toggle('primary', st !== 'on');
          if (st === 'error') toast('Spolupráce: ' + msg, 'err', 6000);
          $('#chatTab').hidden = st !== 'on' && st !== 'connecting';
        },
        onRemote: (coll, op, obj) => {
          const arr = S.project[coll];
          if (op === 'upsert') {
            const i = arr.findIndex(x => x.id === obj.id);
            if (coll === 'devices') normalize({ devices: [obj] });
            if (i >= 0) arr[i] = obj; else arr.push(obj);
          } else {
            const i = arr.findIndex(x => x.id === obj);
            if (i >= 0) arr.splice(i, 1);
            if (coll === 'devices') { S.sel.delete(obj); S.sessions.delete(obj); S.terms.delete(obj); }
            if (coll === 'links' && S.selLink === obj) S.selLink = null;
          }
          rebindSessions();
          S.sim.touch(); S.dirty = true; S.dirtySinceSnap = true;
          scheduleRender();
          clearTimeout(remoteInsT); remoteInsT = setTimeout(() => { refreshInspectorLight(); refreshProblems(); window.Backup.saveCurrent(S.project, S.pktBytes); }, 250);
        },
        onRemoteName: n => { if (S.project.name !== n) { S.project.name = n; updateFileLabel(); } },
        onPresence: peers => { S.peers = peers; renderPresence(); scheduleRender(); },
        onChat: m => {
          const log = $('#chatLog');
          const div = document.createElement('div'); div.className = 'msg';
          div.innerHTML = `<b style="color:${esc(m.color)}">${esc(m.name)}</b><span>${esc(m.text)}</span> <small class="muted">${new Date(m.ts).toLocaleTimeString('cs-CZ')}</small>`;
          log.appendChild(div); log.scrollTop = log.scrollHeight;
          if ($('#bp-chat').hidden && Date.now() - m.ts < 5000 && m.name !== S.cowork.name) toast(`💬 ${m.name}: ${m.text}`, '', 4000);
        }
      }
    });
    return S.cowork;
  }
  let remoteInsT = null;
  function renderPresence() {
    const el = $('#presence');
    const me = S.cowork && S.cowork.roomRef ? [{ name: S.cowork.name + ' (ty)', color: S.cowork.color }] : [];
    el.innerHTML = me.concat(Object.values(S.peers)).map(p => `<div class="av" style="background:${esc(p.color)}" title="${esc(p.name)}">${esc((p.name || '?').slice(0, 2).toUpperCase())}</div>`).join('');
  }
  async function connectWith(cfg) {
    const cw = ensureCowork();
    if (!cw.db) await cw.connect(cfg);
    return cw;
  }
  async function replaceRoomContent() {
    const cw = S.cowork;
    const id = cw.roomId;
    await cw.leave();
    const newId = await cw.createRoom(S.project, S.pktBytes, S.project.source && S.project.source.fileName);
    toast(`Nová místnost ${newId} (původní ${id} zůstala beze změny)`, 'ok', 6000);
    setRoomHash(newId);
  }
  async function leaveRoom() { if (S.cowork) await S.cowork.leave(); S.peers = {}; renderPresence(); render(); setRoomHash(null); }
  function setRoomHash(id) { try { history.replaceState(null, '', id ? '#room=' + id : location.pathname + location.search); } catch (e) { /* file:// */ } }
  async function joinRoom(id) {
    const cw = S.cowork;
    const r = await cw.joinRoom(id);
    await window.Backup.snapshot(S.project, 'Před připojením k místnosti', true).catch(() => {});
    let ctx = null;
    if (r.pktBytes) ctx = await ctxFromPkt(r.pktBytes);
    const keepSessions = false;
    loadProject(r.project, { ctx, pktBytes: r.pktBytes, keepView: keepSessions });
    if (r.pktName && S.project.source) S.project.source.fileName = r.pktName;
    // projekt objekt se vyměnil – cowork musí odkazovat na nový
    cw._project = S.project;
    setRoomHash(cw.roomId);
    renderPresence();
    toast(`Připojeno k místnosti ${cw.roomId}`, 'ok');
  }
  async function showCowork() {
    const B = window.Backup;
    const cfg = coworkConfig();
    const cw = S.cowork;
    if (cw && cw.roomRef) {
      const link = /^https?:/.test(location.protocol) ? location.origin + location.pathname + '#room=' + cw.roomId : null;
      const html = `<p>Jsi připojen do místnosti. Pošli kód ostatním – v Frame-Traceru kliknou na <b>Spolupráce → Připojit</b>.</p>
        <div class="card" style="text-align:center"><div class="muted">Kód místnosti</div><div class="big mono" style="letter-spacing:.15em">${esc(cw.roomId)}</div></div>
        ${link ? `<p>Odkaz: <code>${esc(link)}</code></p>` : ''}
        <h4 style="margin:4px 0 0">Online (${Object.keys(S.peers).length + 1})</h4>
        <div class="list"><div class="it"><span class="dot" style="background:${cw.color}"></span><div class="grow">${esc(cw.name)} (ty)</div></div>${Object.values(S.peers).map(p => `<div class="it"><span class="dot" style="background:${esc(p.color)}"></span><div class="grow">${esc(p.name)}</div></div>`).join('')}</div>`;
      const r = await ask('Spolupráce', html, [['copy', 'Kopírovat kód'], ['leave', 'Odpojit se', 'danger'], ['close', 'Zavřít', 'primary']]);
      if (r.value === 'copy') { navigator.clipboard.writeText(link || cw.roomId); toast('Zkopírováno', 'ok'); }
      if (r.value === 'leave') { await leaveRoom(); toast('Odpojeno ze spolupráce'); }
      return;
    }
    const html = `<p>Spolupráce funguje přes tvůj vlastní <b>Firebase projekt</b> (zdarma, plán Spark). Všichni ve stejné místnosti vidí změny, kurzory a výběr ostatních v reálném čase a mají společný chat a cloudové zálohy.</p>
      <div class="form"><label>Tvoje jméno</label><div class="row" style="flex-wrap:nowrap"><input name="uname" value="${esc(B.getSetting('userName', ''))}" placeholder="např. Tomáš" style="flex:1"><button type="button" id="gSignIn" title="Přihlásit Google účtem – jméno se doplní samo">Přihlásit přes Google</button></div></div>
      <details ${cfg ? '' : 'open'}><summary style="cursor:pointer;margin:6px 0">Firebase konfigurace ${cfg ? '✓ nastavena' : '(nutné nastavit jednou)'}</summary>
      <p style="margin:6px 0">1. Na <code>console.firebase.google.com</code> vytvoř projekt.<br>2. <b>Build → Firestore Database → Create database</b>, pak záložka <b>Rules</b> → vlož obsah souboru <code>firestore.rules</code> ze složky aplikace → <b>Publish</b>.<br>3. <b>Authentication → Sign-in method</b> → zapni <b>Anonymous</b> (volitelně i Google).<br>4. <b>Project settings → Your apps → Web (&lt;/&gt;)</b> → zkopíruj <code>firebaseConfig</code> sem:</p>
      <textarea name="cfg" placeholder="const firebaseConfig = { apiKey: '…', authDomain: '…', databaseURL: 'https://…firebasedatabase.app', projectId: '…', … };">${cfg ? esc(JSON.stringify(cfg, null, 2)) : ''}</textarea>
      <p style="margin-top:6px">Tip: konfiguraci můžeš vložit i do souboru <code>firebase-config.js</code> – pak ji mají všichni, kdo aplikaci dostanou.</p></details>
      <div class="form"><label>Kód místnosti</label><input name="room" placeholder="pro připojení k existující místnosti" class="mono"></div>`;
    const readConf = form => {
      const txt = form.cfg.value.trim();
      if (!txt) return cfg;
      const c = window.Cowork.parseConfig(txt);
      if (!c || !(c.databaseURL || c.projectId)) return null;
      if (JSON.stringify(c) !== JSON.stringify(window.NETTRACER_FIREBASE)) B.setSetting('fbConfig', c);
      return c;
    };
    const dlgP = ask('Spolupráce přes Firebase', html, [['cancel', 'Zrušit'], ['join', 'Připojit k místnosti'], ['create', 'Vytvořit místnost se svým projektem', 'primary']]);
    $('#gSignIn').onclick = async () => {
      const form = $('#dlgForm'), c = readConf(form);
      if (!c) { toast('Nejdřív vlož platnou Firebase konfiguraci.', 'warn'); return; }
      try {
        const cw = await connectWith(c);
        const n = await cw.signInGoogle();
        form.uname.value = n; B.setSetting('userName', n);
        $('#gSignIn').textContent = '✓ ' + n;
      } catch (e) { toast('Google přihlášení: ' + (e.code === 'auth/popup-closed-by-user' ? 'zrušeno' : (e.message || e)), 'err', 6000); }
    };
    const r = await dlgP;
    if (r.value !== 'join' && r.value !== 'create') return;
    const f = r.form;
    const name = f.uname.value.trim() || 'Host';
    B.setSetting('userName', name);
    const conf = readConf(f);
    if (f.cfg.value.trim() && !conf) { toast('Konfigurace neobsahuje projectId ani databaseURL.', 'err', 7000); return; }
    if (!conf) { toast('Nejdřív vlož Firebase konfiguraci.', 'warn'); return; }
    try {
      const cw = await connectWith(conf);
      cw.rename(name);
      if (r.value === 'create') {
        const id = await cw.createRoom(S.project, S.pktBytes, S.project.source && S.project.source.fileName);
        setRoomHash(id); renderPresence();
        toast(`Místnost vytvořena: ${id} – pošli kód ostatním`, 'ok', 7000);
        showCowork();
      } else {
        const id = f.room.value.trim();
        if (!id) { toast('Zadej kód místnosti.', 'warn'); return; }
        await joinRoom(id);
      }
    } catch (e) { console.error(e); toast('Spolupráce: ' + (e.message || e), 'err', 7000); }
  }
  $('#chatForm').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('#chatInput').value.trim();
    if (v && S.cowork) { S.cowork.sendChat(v); $('#chatInput').value = ''; }
  });

  /* =========================== ovládání =========================== */
  const ACTIONS = {
    new: newProject, open: () => $('#fileInput').click(), savePkt, saveNtj, exportXml, undo, redo,
    backups: showBackups, cowork: showCowork,
    zoomIn: () => zoomAt(1.2), zoomOut: () => zoomAt(1 / 1.2), fit: fitView,
    clearPdu: () => { S.pdus = []; S.events = []; renderPdus(); renderEvents(); },
    theme: () => {
      const cur = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = cur; window.Backup.setSetting('theme', cur);
    }
  };
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-act]'); if (a && ACTIONS[a.dataset.act]) { ACTIONS[a.dataset.act](); return; }
    const t = e.target.closest('[data-tool]'); if (t) { setTool(t.dataset.tool); return; }
    const c = e.target.closest('[data-cable]'); if (c) { setTool('cable', c.dataset.cable); return; }
    const m = e.target.closest('[data-mode]');
    if (m) {
      S.mode = m.dataset.mode;
      $$('#modeSeg button').forEach(b => b.classList.toggle('on', b === m));
      $('#speedBox').hidden = S.mode !== 'simulation';
      if (S.mode === 'simulation') showBottom('events');
      return;
    }
    const bt = e.target.closest('[data-btab]'); if (bt) showBottom(bt.dataset.btab);
    if (!e.target.closest('#portMenu') && !e.target.closest('#canvas')) closePortMenu();
  });
  function showBottom(tab) {
    $$('#bottomTabs [data-btab]').forEach(b => b.classList.toggle('on', b.dataset.btab === tab));
    for (const k of ['pdu', 'events', 'problems', 'chat']) $('#bp-' + k).hidden = k !== tab;
    if (tab === 'events') renderEvents();
    if (tab === 'problems') refreshProblems();
    if (tab === 'chat') $('#chatInput').focus();
  }
  $('#optIps').onchange = render; $('#optPorts').onchange = render;
  $('#fileInput').onchange = e => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ''; };
  // drag & drop souborů
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; $('#dropZone').hidden = false; } });
  window.addEventListener('dragleave', e => { if ([...e.dataTransfer.types].includes('Files') && --dragDepth <= 0) { dragDepth = 0; $('#dropZone').hidden = true; } });
  window.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', e => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault(); dragDepth = 0; $('#dropZone').hidden = true;
    openFile(e.dataTransfer.files[0]);
  });
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') { setTool('select'); closePortMenu(); return; }
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); S.ctx ? savePkt() : saveNtj(); return; }
    if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); ACTIONS.open(); return; }
    if (isTyping()) return;
    if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (ctrl && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (ctrl && e.key.toLowerCase() === 'a') { e.preventDefault(); S.sel = new Set(S.project.devices.map(d => d.id)); render(); renderInspector(); return; }
    if (ctrl) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelection(); return; }
    const k = e.key.toLowerCase();
    if (k === 'v') setTool('select'); else if (k === 'c') setTool('cable', 'auto'); else if (k === 'p') setTool('pdu');
    else if (k === 'n') setTool('note'); else if (k === 'd') setTool('delete'); else if (k === 'f') fitView();
    else if (e.key.startsWith('Arrow') && S.sel.size) {
      e.preventDefault();
      const st = e.shiftKey ? 20 : 4, dx = k === 'arrowleft' ? -st : k === 'arrowright' ? st : 0, dy = k === 'arrowup' ? -st : k === 'arrowdown' ? st : 0;
      change(() => { for (const id of S.sel) { const d = devById(id); d.x += dx; d.y += dy; } });
    }
  });
  window.addEventListener('beforeunload', () => { if (S.project) window.Backup.saveCurrent(S.project, S.pktBytes); });
  window.addEventListener('resize', () => renderCursors());

  /* =========================== start =========================== */
  function setupResizer() {
    const insp = $('#inspector'), h = document.createElement('div');
    h.className = 'resizer'; h.title = 'Táhni pro změnu šířky panelu';
    const apply = w => document.documentElement.style.setProperty('--insp-w', Math.max(300, Math.min(innerWidth * 0.6, w)) + 'px');
    const saved = window.Backup.getSetting('inspW', 0); if (saved) apply(saved);
    h.addEventListener('pointerdown', e => {
      e.preventDefault(); h.setPointerCapture(e.pointerId); h.classList.add('on');
      const mv = ev => apply(innerWidth - ev.clientX);
      const up = ev => { h.classList.remove('on'); h.removeEventListener('pointermove', mv); h.removeEventListener('pointerup', up); window.Backup.setSetting('inspW', innerWidth - ev.clientX); renderCursors(); };
      h.addEventListener('pointermove', mv); h.addEventListener('pointerup', up);
    });
    document.body.appendChild(h);
    // držet madlo u levého okraje inspektoru
    const place = () => { const r = insp.getBoundingClientRect(); Object.assign(h.style, { position: 'fixed', left: (r.left - 4) + 'px', top: r.top + 'px', height: r.height + 'px' }); };
    new ResizeObserver(place).observe(insp); window.addEventListener('resize', place); place();
  }

  async function start() {
    $('#svgDefs').innerHTML = window.Icons.defs();
    setupResizer();
    const theme = window.Backup.getSetting('theme', null);
    if (theme) document.documentElement.dataset.theme = theme;
    else if (matchMedia('(prefers-color-scheme: light)').matches) document.documentElement.dataset.theme = 'light';
    buildPalette();
    applyView();
    const saved = await window.Backup.loadCurrent();
    if (saved && saved.project && (saved.project.devices.length || saved.project.notes.length)) {
      const ctx = saved.pktBytes ? await ctxFromPkt(saved.pktBytes) : null;
      loadProject(saved.project, { ctx, pktBytes: saved.pktBytes, dirty: false });
      toast(`Obnoven rozpracovaný projekt „${saved.project.name}“ (${new Date(saved.savedAt).toLocaleString('cs-CZ')})`, 'ok', 4500);
    } else loadProject(emptyProject());
    window.Backup.restoreFolder();
    // připojení z odkazu #room=...
    const m = location.hash.match(/room=([a-z0-9]+)/i);
    if (m && coworkConfig()) {
      try { const cw = await connectWith(coworkConfig()); cw.rename(window.Backup.getSetting('userName', 'Host')); await joinRoom(m[1]); }
      catch (e) { toast('Nepodařilo se připojit k místnosti: ' + e.message, 'err', 6000); }
    }
  }
  start();
})();
