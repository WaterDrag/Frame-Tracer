// node tests/cowork.test.js – simulace 2 klientů nad falešnou Realtime Database
const Cowork = require('../js/cowork.js');
let fail = 0;
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fail++; };
const tick = () => new Promise(r => setTimeout(r, 150));

/* ---------- mini fake RTDB ---------- */
function FakeDB() {
  const data = {};
  const listeners = [];
  const parts = p => p.split('/').filter(Boolean);
  const get = p => parts(p).reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), data);
  const clone = v => v === undefined ? null : JSON.parse(JSON.stringify(v));
  function setAt(p, v) {
    const ks = parts(p); let o = data;
    for (let i = 0; i < ks.length - 1; i++) { if (typeof o[ks[i]] !== 'object' || !o[ks[i]]) o[ks[i]] = {}; o = o[ks[i]]; }
    if (v === null || v === undefined) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = clone(v);
  }
  function snap(key, v) { return { key, val: () => clone(v) }; }
  function fire() {
    setTimeout(() => {
      for (const l of listeners) {
        const cur = get(l.path);
        if (l.ev === 'value') { const j = JSON.stringify(cur ?? null); if (j !== l.last) { l.last = j; l.fn(snap(parts(l.path).pop(), cur)); } continue; }
        const prev = l.prev || {}, now = (cur && typeof cur === 'object') ? clone(cur) : {};
        if (l.ev === 'child_added') for (const k of Object.keys(now)) if (!(k in prev)) l.fn(snap(k, now[k]));
        if (l.ev === 'child_changed') for (const k of Object.keys(now)) if (k in prev && JSON.stringify(prev[k]) !== JSON.stringify(now[k])) l.fn(snap(k, now[k]));
        if (l.ev === 'child_removed') for (const k of Object.keys(prev)) if (!(k in now)) l.fn(snap(k, prev[k]));
        l.prev = now;
      }
    }, 5);
  }
  function ref(path) {
    path = path || '';
    const r = {
      child: c => ref(path + '/' + c),
      set: async v => { setAt(path, v); fire(); },
      update: async u => { for (const [k, v] of Object.entries(u)) setAt(path + '/' + k, v); fire(); },
      remove: async () => { setAt(path, null); fire(); },
      push: async v => { const k = 'k' + Date.now() + Math.random().toString(36).slice(2, 6); setAt(path + '/' + k, v); fire(); },
      once: async () => snap(parts(path).pop(), get(path)),
      on: (ev, fn) => { const l = { path, ev, fn, prev: {}, last: undefined }; listeners.push(l); fire(); },
      off: (ev, fn) => { const i = listeners.findIndex(l => l.fn === fn); if (i >= 0) listeners.splice(i, 1); },
      onDisconnect: () => ({ remove: () => {} }),
      limitToLast: () => r
    };
    return r;
  }
  return { ref, data };
}
const db = FakeDB();
const fakeFb = () => ({ apps: [], initializeApp: () => ({ database: () => db }) });

(async () => {
  const events = { A: [], B: [] };
  const mk = n => Cowork.create({ name: n, firebase: fakeFb(), hooks: { onRemote: (c, op, x) => events[n].push([c, op, x]), onPresence: () => {}, onChat: m => events[n].push(['chat', m.text]) } });
  const A = mk('A'), B = mk('B');
  await A.connect({ databaseURL: 'https://x' }); await B.connect({ databaseURL: 'https://x' });
  const pA = { name: 'Lab', devices: [{ id: 'save-ref-id:123', name: 'R1', x: 1, y: 2 }, { id: 'dev-2', name: 'PC0', x: 5, y: 5 }], links: [{ id: 'l1', a: { dev: 'dev-2' }, b: { dev: 'save-ref-id:123' } }], notes: [] };
  const id = await A.createRoom(pA, new Uint8Array([1, 2, 3]), 'lab.pkt');
  ok(/^[a-z0-9]{10}$/.test(id), 'místnost vytvořena: ' + id);
  const j = await B.joinRoom(id);
  ok(j.project.devices.length === 2 && j.project.links.length === 1, 'B načte projekt z místnosti');
  ok(j.pktBytes && j.pktBytes.join() === '1,2,3', 'B dostane i původní .pkt');
  await tick();
  ok(events.B.length === 0, 'žádné falešné echo po připojení (' + events.B.length + ')');
  // B přesune zařízení
  const pB = j.project;
  pB.devices[0].x = 99; B.push(pB, true); await tick();
  const ev = events.A.find(e => e[0] === 'devices' && e[1] === 'upsert');
  ok(ev && ev[2].x === 99 && ev[2].id === 'save-ref-id:123', 'A dostane změnu pozice od B');
  ok(!events.B.some(e => e[0] === 'devices'), 'B nedostane vlastní echo');
  // A smaže link, přidá zařízení
  pA.links = []; pA.devices.push({ id: 'dev-3', name: 'SW', x: 0, y: 0 });
  A.push(pA, true); await tick();
  ok(events.B.some(e => e[0] === 'links' && e[1] === 'remove' && e[2] === 'l1'), 'B dostane smazání kabelu');
  ok(events.B.some(e => e[0] === 'devices' && e[1] === 'upsert' && e[2].id === 'dev-3'), 'B dostane nové zařízení');
  // chat a zálohy
  A.sendChat('ahoj'); await tick();
  ok(events.B.some(e => e[0] === 'chat' && e[1] === 'ahoj'), 'chat');
  await B.cloudBackup(pB, 'test');
  const bl = await A.listCloudBackups();
  ok(bl.length === 1 && bl[0].label === 'test', 'cloudová záloha');
  ok(Cowork.parseConfig("const firebaseConfig = {\n apiKey: 'AIza', databaseURL: \"https://p-default-rtdb.firebaseio.com\", projectId: 'p' };").databaseURL === 'https://p-default-rtdb.firebaseio.com', 'parsování JS firebaseConfig');
  await A.leave(); await B.leave();
  process.exit(fail ? 1 : 0);
})();
