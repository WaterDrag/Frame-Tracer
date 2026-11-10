/*
 * storage.js – zálohování:
 *  - automatické ukládání rozpracovaného projektu (IndexedDB) – obnoví se po zavření prohlížeče
 *  - historie verzí (snímky každých pár minut + ruční), max. 60
 *  - volitelně záloha do složky na disku (File System Access API, Chrome/Edge)
 */
(function (root) {
  'use strict';
  const DB_NAME = 'nettracer', DB_VER = 1, MAX_HISTORY = 60;
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VER); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('history')) d.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  async function kvGet(key) { const d = await db(); return reqP(d.transaction('kv').objectStore('kv').get(key)); }
  async function kvSet(key, val) { const d = await db(); return reqP(d.transaction('kv', 'readwrite').objectStore('kv').put(val, key)); }
  async function kvDel(key) { const d = await db(); return reqP(d.transaction('kv', 'readwrite').objectStore('kv').delete(key)); }

  /** Serializace projektu (bez runtime dat) */
  function serialize(project) {
    return JSON.stringify(project, (k, v) => (k.startsWith('_') ? undefined : v));
  }

  const Backup = {
    available: typeof indexedDB !== 'undefined',
    lastSnapshotJson: null,
    lastSnapshotAt: 0,
    folder: null,          // FileSystemDirectoryHandle
    folderOk: false,

    /** Uloží aktuální stav (volá se po každé změně, s debounce) */
    async saveCurrent(project, pktBytes) {
      if (!this.available) return;
      try {
        await kvSet('current', { json: serialize(project), savedAt: Date.now() });
        if (pktBytes !== undefined) await kvSet('currentPkt', pktBytes || null);
      } catch (e) { console.warn('Autosave selhal', e); }
    },
    async loadCurrent() {
      if (!this.available) return null;
      try {
        const cur = await kvGet('current');
        if (!cur) return null;
        const pkt = await kvGet('currentPkt');
        return { project: JSON.parse(cur.json), savedAt: cur.savedAt, pktBytes: pkt || null };
      } catch (e) { console.warn(e); return null; }
    },
    async clearCurrent() { try { await kvDel('current'); await kvDel('currentPkt'); } catch (e) { /* */ } },

    /** Snímek do historie; vrací true, když se uložil */
    async snapshot(project, label, force) {
      if (!this.available) return false;
      const json = serialize(project);
      if (!force && json === this.lastSnapshotJson) return false;
      this.lastSnapshotJson = json;
      this.lastSnapshotAt = Date.now();
      const entry = { ts: Date.now(), name: project.name || 'projekt', label: label || 'Automatická záloha',
        devices: project.devices.length, links: project.links.length, json };
      const d = await db();
      await reqP(d.transaction('history', 'readwrite').objectStore('history').add(entry));
      // ořez historie
      const all = await this.list();
      if (all.length > MAX_HISTORY) {
        const t = d.transaction('history', 'readwrite').objectStore('history');
        for (const e of all.slice(MAX_HISTORY)) t.delete(e.id);
      }
      if (this.folder) this.writeToFolder(entry).catch(() => {});
      return true;
    },
    async list() {
      if (!this.available) return [];
      const d = await db();
      const all = await reqP(d.transaction('history').objectStore('history').getAll());
      return all.sort((a, b) => b.ts - a.ts);
    },
    async get(id) { const d = await db(); return reqP(d.transaction('history').objectStore('history').get(id)); },
    async remove(id) { const d = await db(); return reqP(d.transaction('history', 'readwrite').objectStore('history').delete(id)); },

    /* ---------- záloha do složky na disku ---------- */
    folderSupported: typeof root.showDirectoryPicker === 'function',
    async pickFolder() {
      const h = await root.showDirectoryPicker({ id: 'nettracer-backup', mode: 'readwrite' });
      this.folder = h; this.folderOk = true;
      await kvSet('backupFolder', h);
      return h.name;
    },
    async restoreFolder() {
      if (!this.folderSupported) return null;
      try {
        const h = await kvGet('backupFolder');
        if (!h) return null;
        this.folder = h;
        this.folderOk = (await h.queryPermission({ mode: 'readwrite' })) === 'granted';
        return h.name;
      } catch (e) { return null; }
    },
    async ensureFolderPermission() {
      if (!this.folder) return false;
      if ((await this.folder.queryPermission({ mode: 'readwrite' })) === 'granted') return (this.folderOk = true);
      return (this.folderOk = (await this.folder.requestPermission({ mode: 'readwrite' })) === 'granted');
    },
    async forgetFolder() { this.folder = null; this.folderOk = false; await kvDel('backupFolder'); },
    async writeToFolder(entry) {
      if (!this.folder || !this.folderOk) return;
      const dt = new Date(entry.ts);
      const stamp = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}_${String(dt.getHours()).padStart(2, '0')}${String(dt.getMinutes()).padStart(2, '0')}${String(dt.getSeconds()).padStart(2, '0')}`;
      const safe = (entry.name || 'projekt').replace(/[^\w\-áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ ]+/g, '_').slice(0, 60);
      const fh = await this.folder.getFileHandle(`${safe}_${stamp}.ntj`, { create: true });
      const w = await fh.createWritable();
      await w.write(JSON.stringify({ format: 'nettracer', version: 1, project: JSON.parse(entry.json) }));
      await w.close();
    },

    /* ---------- nastavení ---------- */
    getSetting(key, def) { try { const v = localStorage.getItem('nt.' + key); return v === null ? def : JSON.parse(v); } catch (e) { return def; } },
    setSetting(key, val) { try { localStorage.setItem('nt.' + key, JSON.stringify(val)); } catch (e) { /* */ } },
    serialize
  };
  root.Backup = Backup;
})(this);
