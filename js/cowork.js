/*
 * cowork.js – spolupráce v reálném čase přes Firebase.
 *
 * Podporuje dvě databáze (vybere se automaticky):
 *   - Cloud Firestore      (výchozí – když konfigurace NEobsahuje databaseURL)
 *   - Realtime Database    (když konfigurace obsahuje databaseURL)
 *
 * Data místnosti:
 *   rooms/{roomId}                      meta { name, created, updated, source, instructions }
 *   rooms/{roomId}/devices/{id}         { j: JSON zařízení, by, ts }
 *   rooms/{roomId}/links/{id}           { j, by, ts }
 *   rooms/{roomId}/notes/{id}           { j, by, ts }
 *   rooms/{roomId}/pkt/...              původní .pkt (base64, po kouscích) – kvůli ukládání do PT formátu
 *   rooms/{roomId}/presence/{clientId}  { name, color, sel, cur, ts }
 *   rooms/{roomId}/chat/{auto}          { name, color, text, ts }
 *   rooms/{roomId}/backups/{auto}       { ts, by, name, label, json }
 *
 * Synchronizuje se po jednotlivých zařízeních/kabelech (při kolizi vyhrává poslední zápis).
 */
(function (root) {
  'use strict';
  const SDK = '10.12.2';
  const COLLS = ['devices', 'links', 'notes'];
  const COLORS = ['#ef4444', '#f59e0b', '#10b981', '#06b6d4', '#8b5cf6', '#ec4899', '#84cc16', '#f97316'];
  const enc = s => String(s).replace(/[.#$\[\]\/%]/g, c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  const dec = s => String(s).replace(/%([0-9a-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const randId = n => { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; let s = ''; const r = (root.crypto && root.crypto.getRandomValues) ? root.crypto.getRandomValues(new Uint8Array(n)) : Array.from({ length: n }, () => Math.floor(Math.random() * 256)); for (let i = 0; i < n; i++) s += a[r[i] % a.length]; return s; };
  const PKT_CHUNK = 700000; // Firestore dokument max. 1 MiB

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if ([...document.scripts].some(s => s.src === src)) return resolve();
      const s = document.createElement('script');
      s.src = src; s.async = false;
      s.onload = () => resolve(); s.onerror = () => reject(new Error('Nepodařilo se načíst ' + src + ' (jsi online?)'));
      document.head.appendChild(s);
    });
  }
  async function loadFirebase(needRtdb) {
    const base = `https://www.gstatic.com/firebasejs/${SDK}/`;
    await loadScript(base + 'firebase-app-compat.js');
    await loadScript(base + 'firebase-auth-compat.js');
    if (needRtdb) await loadScript(base + 'firebase-database-compat.js');
    else await loadScript(base + 'firebase-firestore-compat.js');
    return root.firebase;
  }

  /** Přijme JSON i JS zápis "const firebaseConfig = { apiKey: '...', ... }" */
  function parseConfig(text) {
    if (!text) return null;
    if (typeof text === 'object') return text;
    const t = String(text);
    try { const j = JSON.parse(t); if (j && (j.databaseURL || j.projectId)) return j; } catch (e) { /* JS zápis */ }
    const obj = {};
    const re = /([A-Za-z_]\w*)\s*:\s*(["'`])([^"'`]*)\2/g;
    let m; while ((m = re.exec(t))) obj[m[1]] = m[3];
    return Object.keys(obj).length ? obj : null;
  }
  function withTimeout(p, ms) {
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('Databáze neodpovídá – zkontroluj připojení k internetu a pravidla databáze.')), ms); })])
      .finally(() => clearTimeout(t));
  }
  function friendly(e) {
    const c = e && (e.code || '');
    if (/permission[-_]denied/i.test(c) || /permission/i.test(e && e.message)) return new Error('Databáze odmítla přístup – ve Firebase konzoli zveřejni pravidla ze souboru ' + (e._fs ? 'firestore.rules' : 'database.rules.json') + '.');
    if (/unavailable/i.test(c)) return new Error('Firestore je nedostupný (offline?).');
    if (/not-found/i.test(c)) return new Error('Ve Firebase projektu není vytvořená databáze Firestore.');
    return e instanceof Error ? e : new Error(String(e));
  }

  /* ======================= backend: Cloud Firestore ======================= */
  function firestoreBackend(fs) {
    const room = id => fs.collection('rooms').doc(id);
    const wrap = async p => { try { return await p; } catch (e) { e._fs = true; throw friendly(e); } };
    return {
      kind: 'firestore', pushDelay: 450, cursorEvery: 1500, heartbeat: 60000,
      async createRoom(id, meta, docs, pkt) {
        const ops = [['set', room(id), meta]];
        for (const c of COLLS) for (const [k, v] of Object.entries(docs[c])) ops.push(['set', room(id).collection(c).doc(k), v]);
        if (pkt) {
          const n = Math.ceil(pkt.b64.length / PKT_CHUNK);
          ops.push(['set', room(id).collection('pkt').doc('info'), { name: pkt.name, chunks: n }]);
          for (let i = 0; i < n; i++) ops.push(['set', room(id).collection('pkt').doc('c' + i), { d: pkt.b64.slice(i * PKT_CHUNK, (i + 1) * PKT_CHUNK) }]);
        }
        // první zápis samostatně (ověří práva), zbytek po dávkách
        await wrap(withTimeout(ops[0][1].set(ops[0][2]), 15000));
        await this._batched(ops.slice(1));
      },
      async _batched(ops) {
        let bytes = 0, b = fs.batch(), n = 0;
        const flush = async () => { if (n) await wrap(b.commit()); b = fs.batch(); n = 0; bytes = 0; };
        for (const [op, ref, v] of ops) {
          const sz = v ? JSON.stringify(v).length : 50;
          if (n >= 450 || bytes + sz > 9e6) await flush();
          if (op === 'del') b.delete(ref); else b.set(ref, v);
          n++; bytes += sz;
        }
        await flush();
      },
      async loadRoom(id) {
        const m = await wrap(withTimeout(room(id).get(), 15000));
        if (!m.exists) return null;
        const out = { meta: m.data() };
        for (const c of COLLS) {
          out[c] = {};
          const s = await wrap(room(id).collection(c).get());
          s.forEach(d => { out[c][d.id] = d.data(); });
        }
        const info = await room(id).collection('pkt').doc('info').get().catch(() => null);
        if (info && info.exists) {
          const parts = [];
          for (let i = 0; i < info.data().chunks; i++) { const d = await room(id).collection('pkt').doc('c' + i).get(); parts.push(d.exists ? d.data().d : ''); }
          out.pkt = { b64: parts.join(''), name: info.data().name };
        }
        return out;
      },
      listenColl(id, c, up, rm) {
        return room(id).collection(c).onSnapshot(s => {
          for (const ch of s.docChanges()) { if (ch.type === 'removed') rm(ch.doc.id); else up(ch.doc.id, ch.doc.data()); }
        }, e => console.warn('listen', c, e));
      },
      listenName(id, fn) { return room(id).onSnapshot(d => { if (d.exists && d.data().name) fn(d.data().name); }, () => {}); },
      async writeDiff(id, upd, metaPatch) {
        const ops = [];
        for (const [k, v] of Object.entries(upd)) { const [c, key] = k.split('/'); ops.push([v === null ? 'del' : 'set', room(id).collection(c).doc(key), v]); }
        ops.push(['upd', room(id), metaPatch]);
        const last = ops.pop();
        await this._batched(ops);
        await room(id).set(last[2], { merge: true });
      },
      presenceSet: (id, cid, data) => room(id).collection('presence').doc(cid).set(data),
      presenceUpdate: (id, cid, patch) => room(id).collection('presence').doc(cid).set(patch, { merge: true }),
      presenceRemove: (id, cid) => room(id).collection('presence').doc(cid).delete(),
      presenceOnDisconnect: () => {},
      presenceListen(id, fn) {
        return room(id).collection('presence').onSnapshot(s => { const all = {}; const lim = Date.now() - 150000; s.forEach(d => { const v = d.data(); if ((v.ts || 0) > lim) all[d.id] = v; }); fn(all); }, () => {});
      },
      chatAdd: (id, msg) => room(id).collection('chat').add(msg),
      chatListen(id, fn) {
        return room(id).collection('chat').orderBy('ts').limitToLast(100).onSnapshot(s => { for (const ch of s.docChanges()) if (ch.type === 'added') fn(ch.doc.data()); }, () => {});
      },
      async backupAdd(id, e) {
        await wrap(room(id).collection('backups').add(e));
        const s = await room(id).collection('backups').orderBy('ts').get();
        const docs = s.docs; if (docs.length > 25) { const b = fs.batch(); for (const d of docs.slice(0, docs.length - 25)) b.delete(d.ref); await b.commit(); }
      },
      async backupList(id) { const s = await wrap(room(id).collection('backups').orderBy('ts', 'desc').limit(25).get()); return s.docs.map(d => Object.assign({ key: d.id }, d.data())); },
      async pktSet(id, b64, name) {
        const n = Math.ceil(b64.length / PKT_CHUNK), ops = [['set', room(id).collection('pkt').doc('info'), { name, chunks: n }]];
        for (let i = 0; i < n; i++) ops.push(['set', room(id).collection('pkt').doc('c' + i), { d: b64.slice(i * PKT_CHUNK, (i + 1) * PKT_CHUNK) }]);
        await this._batched(ops);
      }
    };
  }

  /* ======================= backend: Realtime Database ======================= */
  function rtdbBackend(db) {
    const room = id => db.ref('rooms/' + id);
    const wrap = async p => { try { return await p; } catch (e) { throw friendly(e); } };
    const sub = (ref, ev, fn) => { ref.on(ev, fn); return () => ref.off(ev, fn); };
    return {
      kind: 'rtdb', pushDelay: 90, cursorEvery: 80, heartbeat: 0,
      async createRoom(id, meta, docs, pkt) {
        const data = { meta };
        for (const c of COLLS) data[c] = docs[c];
        if (pkt) data.pkt = pkt;
        await wrap(withTimeout(room(id).set(data), 15000));
      },
      async loadRoom(id) {
        const v = (await wrap(withTimeout(room(id).once('value'), 15000))).val();
        if (!v || !v.meta) return null;
        return { meta: v.meta, devices: v.devices || {}, links: v.links || {}, notes: v.notes || {}, pkt: v.pkt || null };
      },
      listenColl(id, c, up, rm) {
        const ref = room(id).child(c);
        const u1 = sub(ref, 'child_added', s => up(s.key, s.val())), u2 = sub(ref, 'child_changed', s => up(s.key, s.val())), u3 = sub(ref, 'child_removed', s => rm(s.key));
        return () => { u1(); u2(); u3(); };
      },
      listenName(id, fn) { return sub(room(id).child('meta/name'), 'value', s => { if (s.val()) fn(s.val()); }); },
      async writeDiff(id, upd, metaPatch) {
        const u = Object.assign({}, upd);
        for (const [k, v] of Object.entries(metaPatch)) u['meta/' + k] = v;
        await wrap(room(id).update(u));
      },
      presenceSet: (id, cid, data) => room(id).child('presence/' + cid).set(data),
      presenceUpdate: (id, cid, patch) => room(id).child('presence/' + cid).update(patch),
      presenceRemove: (id, cid) => room(id).child('presence/' + cid).remove(),
      presenceOnDisconnect: (id, cid) => room(id).child('presence/' + cid).onDisconnect().remove(),
      presenceListen(id, fn) { return sub(room(id).child('presence'), 'value', s => fn(s.val() || {})); },
      chatAdd: (id, msg) => room(id).child('chat').push(msg),
      chatListen(id, fn) { return sub(room(id).child('chat').limitToLast(100), 'child_added', s => fn(s.val())); },
      async backupAdd(id, e) {
        const ref = room(id).child('backups');
        await wrap(ref.push(e));
        const keys = Object.keys((await ref.once('value')).val() || {}).sort();
        if (keys.length > 25) { const u = {}; for (const k of keys.slice(0, keys.length - 25)) u[k] = null; await ref.update(u); }
      },
      async backupList(id) { const v = (await room(id).child('backups').once('value')).val() || {}; return Object.entries(v).map(([k, x]) => Object.assign({ key: k }, x)).sort((a, b) => b.ts - a.ts); },
      pktSet: (id, b64, name) => room(id).child('pkt').set({ b64, name })
    };
  }

  /* ============================== klient ============================== */
  function create(opts) {
    opts = opts || {};
    const hooks = opts.hooks || {};
    const self = {
      state: 'off', roomId: null, clientId: randId(8), name: opts.name || 'Host', color: COLORS[Math.floor(Math.random() * COLORS.length)],
      fb: opts.firebase || null, app: null, be: null, user: null,
      sent: { devices: new Map(), links: new Map(), notes: new Map() },
      peers: {}, _timer: null, _project: null, _curT: 0, _unsubs: [], _hb: null,
      get roomRef() { return this.roomId ? true : null; },
      get backend() { return this.be ? this.be.kind : null; }
    };
    const status = (s, msg) => { self.state = s; hooks.onStatus && hooks.onStatus(s, msg); };

    self.connect = async function (config) {
      status('connecting');
      try {
        const cfg = Object.assign({}, parseConfig(config));
        if (!cfg.projectId && !cfg.databaseURL) throw new Error('Konfigurace neobsahuje projectId.');
        const useRtdb = !!cfg.databaseURL;
        const fb = self.fb || await loadFirebase(useRtdb);
        self.fb = fb;
        const name = 'nettracer-' + (cfg.projectId || 'x');
        self.app = (fb.apps || []).find(a => a.name === name) || fb.initializeApp(cfg, name);
        if (fb.auth && !opts.firebase) {
          if (!/^https?:/.test(root.location ? root.location.protocol : '')) throw new Error('Spolupráce vyžaduje přihlášení, které nefunguje při otevření index.html jako souboru. Spusť aplikaci přes „Spustit Frame-Tracer.bat“ (http://localhost:8080).');
          const auth = self.app.auth();
          await new Promise(r => { const un = auth.onAuthStateChanged(() => { un(); r(); }); });
          if (!auth.currentUser) {
            try { await auth.signInAnonymously(); }
            catch (e) { throw new Error('Anonymní přihlášení selhalo (' + (e.code || e.message) + '). Zapni ve Firebase Authentication poskytovatele „Anonymous“.'); }
          }
          self.user = auth.currentUser;
        }
        self.be = useRtdb ? rtdbBackend(self.app.database()) : firestoreBackend(self.app.firestore());
        status('off');
        return true;
      } catch (e) { status('error', e.message); throw e; }
    };
    // kompatibilita se staršími testy/kódem
    Object.defineProperty(self, 'db', { get() { return self.be; } });

    function docsOf(project) {
      const docs = {};
      for (const c of COLLS) {
        docs[c] = {}; self.sent[c].clear();
        for (const x of project[c] || []) { const j = JSON.stringify(x); docs[c][enc(x.id)] = { j, by: self.clientId, ts: Date.now() }; self.sent[c].set(x.id, j); }
      }
      return docs;
    }
    function projectFrom(v) {
      const p = { version: 1, name: (v.meta && v.meta.name) || 'Sdílený projekt', devices: [], links: [], notes: [], source: (v.meta && v.meta.source) || { kind: 'new' } };
      for (const c of COLLS) for (const e of Object.values(v[c] || {})) {
        if (!e || !e.j) continue;
        try { const x = JSON.parse(e.j); p[c].push(x); self.sent[c].set(x.id, e.j); } catch (er) { /* */ }
      }
      if (v.meta && v.meta.instructions) p.instructions = v.meta.instructions;
      return p;
    }

    /** Vytvoří místnost z aktuálního projektu */
    self.createRoom = async function (project, pktBytes, fileName) {
      const id = randId(10);
      const meta = { name: project.name || 'Projekt', created: Date.now(), updated: Date.now(), source: JSON.parse(JSON.stringify(project.source || { kind: 'new' })), instructions: project.instructions || null };
      const pkt = pktBytes && pktBytes.length < 8.5e6 ? { b64: b64(pktBytes), name: fileName || 'sit.pkt' } : null;
      await self.be.createRoom(id, meta, docsOf(project), pkt);
      await attach(id, project);
      return id;
    };

    /** Připojí se k existující místnosti – vrací { project, pktBytes, pktName } */
    self.joinRoom = async function (id) {
      id = String(id).trim().toLowerCase();
      for (const c of COLLS) self.sent[c].clear();
      const v = await self.be.loadRoom(id);
      if (!v) throw new Error('Místnost „' + id + '“ neexistuje.');
      const project = projectFrom(v);
      await attach(id, project);
      return { project, pktBytes: v.pkt && v.pkt.b64 ? unb64(v.pkt.b64) : null, pktName: v.pkt && v.pkt.name };
    };

    async function attach(id, project) {
      const be = self.be;
      self.roomId = id; self._project = project;
      for (const c of COLLS) {
        self._unsubs.push(be.listenColl(id, c, (key, e) => {
          if (!e || !e.j) return;
          let x; try { x = JSON.parse(e.j); } catch (er) { return; }
          if (self.sent[c].get(x.id) === e.j) return; // vlastní echo / beze změny
          self.sent[c].set(x.id, e.j);
          hooks.onRemote && hooks.onRemote(c, 'upsert', x, e.by);
        }, key => {
          const id2 = dec(key);
          if (!self.sent[c].has(id2)) return;
          self.sent[c].delete(id2);
          hooks.onRemote && hooks.onRemote(c, 'remove', id2);
        }));
      }
      self._unsubs.push(be.listenName(id, n => hooks.onRemoteName && hooks.onRemoteName(n)));
      be.presenceOnDisconnect(id, self.clientId);
      await be.presenceSet(id, self.clientId, { name: self.name, color: self.color, ts: Date.now(), sel: [], cur: null });
      self._unsubs.push(be.presenceListen(id, all => {
        delete all[self.clientId];
        self.peers = all;
        hooks.onPresence && hooks.onPresence(all);
      }));
      self._unsubs.push(be.chatListen(id, m => hooks.onChat && hooks.onChat(m)));
      if (be.heartbeat) self._hb = setInterval(() => be.presenceUpdate(id, self.clientId, { ts: Date.now() }).catch(() => {}), be.heartbeat);
      if (root.addEventListener) root.addEventListener('beforeunload', self._bye = () => { be.presenceRemove(id, self.clientId); });
      status('on');
    }

    /** Odešle lokální změny (diff po položkách) */
    self.push = function (project, immediate) {
      if (!self.roomId) return;
      self._project = project;
      clearTimeout(self._timer);
      if (immediate) return doPush();
      self._timer = setTimeout(doPush, self.be.pushDelay);
    };
    function doPush() {
      const p = self._project; if (!p || !self.roomId) return;
      const upd = {};
      for (const c of COLLS) {
        const cur = new Map((p[c] || []).map(x => [x.id, JSON.stringify(x)]));
        for (const [id, j] of cur) if (self.sent[c].get(id) !== j) { upd[c + '/' + enc(id)] = { j, by: self.clientId, ts: Date.now() }; self.sent[c].set(id, j); }
        for (const id of [...self.sent[c].keys()]) if (!cur.has(id)) { upd[c + '/' + enc(id)] = null; self.sent[c].delete(id); }
      }
      if (!Object.keys(upd).length) return;
      return self.be.writeDiff(self.roomId, upd, { updated: Date.now(), name: p.name || 'Projekt' })
        .catch(e => hooks.onStatus && hooks.onStatus('error', 'Uložení do cloudu selhalo: ' + friendly(e).message));
    }

    self.setPresence = function (patch) {
      if (!self.roomId) return;
      const now = Date.now();
      if (patch.cur) { if (now - self._curT < self.be.cursorEvery) return; self._curT = now; }
      self.be.presenceUpdate(self.roomId, self.clientId, Object.assign({ ts: now }, patch)).catch(() => {});
    };
    /** Přihlášení Google účtem (popup) – vrací zobrazované jméno */
    self.signInGoogle = async function () {
      const fb = self.fb, auth = self.app.auth();
      const prov = new fb.auth.GoogleAuthProvider();
      const cur = auth.currentUser;
      let res;
      try { res = cur && cur.isAnonymous ? await cur.linkWithPopup(prov) : await auth.signInWithPopup(prov); }
      catch (e) {
        if (e.code === 'auth/credential-already-in-use' || e.code === 'auth/email-already-in-use') res = await auth.signInWithCredential(e.credential);
        else throw e;
      }
      self.user = res.user;
      return res.user.displayName || res.user.email || 'Uživatel';
    };
    self.rename = function (n) { self.name = n; if (self.roomId) self.setPresence({ name: n }); };
    self.sendChat = text => self.roomId && self.be.chatAdd(self.roomId, { name: self.name, color: self.color, text: String(text).slice(0, 500), ts: Date.now() });
    self.uploadPkt = (bytes, name) => self.roomId && bytes && bytes.length < 8.5e6 && self.be.pktSet(self.roomId, b64(bytes), name || 'sit.pkt').catch(() => {});

    /* cloudové zálohy */
    self.cloudBackup = async function (project, label) {
      if (!self.roomId) return;
      await self.be.backupAdd(self.roomId, { ts: Date.now(), by: self.name, name: project.name || 'Projekt', label: label || 'Záloha', json: JSON.stringify({ name: project.name, devices: project.devices, links: project.links, notes: project.notes, source: project.source }) });
    };
    self.listCloudBackups = async function () { return self.roomId ? self.be.backupList(self.roomId) : []; };

    self.leave = async function () {
      for (const u of self._unsubs) { try { u(); } catch (e) { /* */ } }
      self._unsubs = [];
      clearInterval(self._hb);
      if (self._bye && root.removeEventListener) root.removeEventListener('beforeunload', self._bye);
      if (self.roomId) { try { await self.be.presenceRemove(self.roomId, self.clientId); } catch (e) { /* */ } }
      self.roomId = null; self.peers = {};
      for (const c of COLLS) self.sent[c].clear();
      status('off');
    };
    return self;
  }

  function b64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let s = ''; const ch = 0x8000;
    for (let i = 0; i < bytes.length; i += ch) s += String.fromCharCode.apply(null, bytes.subarray(i, i + ch));
    return btoa(s);
  }
  function unb64(s) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
    const bin = atob(s); const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  const api = { create, parseConfig, enc, dec, b64, unb64, COLORS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Cowork = api;
})(typeof self !== 'undefined' ? self : this);
