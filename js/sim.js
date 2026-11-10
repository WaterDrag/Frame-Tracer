/*
 * sim.js – simulace sítě: L1 (kabely), L2 (VLAN, trunky, MAC tabulky),
 * L3 (směrování, statické trasy, RIP/OSPF/EIGRP), ARP, DHCP, ICMP.
 */
(function (root) {
  'use strict';
  const NM = (typeof module !== 'undefined' && module.exports) ? require('./netmodel.js') : root.NetModel;
  const { IP } = NM;

  const SWITCHLIKE = new Set(['switch', 'l3switch', 'hub', 'ap']);
  const DCE_SIDE = new Set(['switch', 'l3switch', 'hub', 'ap']); // "hub/switch" strana pro pravidlo kabelů

  class Sim {
    constructor(project) { this.setProject(project); }
    setProject(project) {
      this.p = project;
      this.rt = { arp: new Map(), mac: new Map(), leases: new Map(), aclHits: new Map(), nat: new Map(), psec: new Map(), errdis: new Set() };
      this.touch();
    }
    touch() { this._idx = null; this._dyn = null; this._stp = null; }

    /* ----------------------------- indexy ----------------------------- */
    index() {
      if (this._idx) return this._idx;
      const dev = new Map(this.p.devices.map(d => [d.id, d]));
      const plink = new Map();
      for (const l of this.p.links) {
        plink.set(l.a.dev + '|' + l.a.port, { link: l, peer: l.b });
        plink.set(l.b.dev + '|' + l.b.port, { link: l, peer: l.a });
      }
      this._idx = { dev, plink };
      return this._idx;
    }
    dev(id) { return this.index().dev.get(id); }
    linkOf(devId, portName) { return this.index().plink.get(devId + '|' + portName) || null; }
    portOf(devId, portName) { const d = this.dev(devId); return d ? NM.findPort(d, portName) : null; }

    /* ------------------------------- L1 ------------------------------- */
    /** Stav kabelu: { up, reason } */
    linkState(l) {
      const da = this.dev(l.a.dev), db = this.dev(l.b.dev);
      if (!da || !db) return { up: false, reason: 'chybí zařízení' };
      const pa = NM.findPort(da, l.a.port), pb = NM.findPort(db, l.b.port);
      if (!pa || !pb) return { up: false, reason: 'chybí port' };
      if (l.cable === 'console') return { up: true, console: true, reason: 'konzolový kabel' };
      if (da.power === false || db.power === false) return { up: false, reason: 'zařízení je vypnuté' };
      if (this.rt.errdis.has(l.a.dev + '|' + pa.name) || this.rt.errdis.has(l.b.dev + '|' + pb.name)) return { up: false, reason: 'port je err-disabled (porušení port-security) – oprav příčinu a dej shutdown / no shutdown' };
      if (pa.shutdown || pb.shutdown) return { up: false, reason: 'port je administrativně vypnutý (shutdown)' };
      const sa = pa.media === 'serial', sb = pb.media === 'serial';
      if (l.cable === 'serial' || sa || sb) {
        if (!(sa && sb && l.cable === 'serial')) return { up: false, reason: 'sériový kabel patří mezi sériové porty' };
        return { up: true };
      }
      if (l.cable === 'fiber' && (pa.media !== 'fiber' || pb.media !== 'fiber')) return { up: false, reason: 'optika vyžaduje optické porty' };
      if (l.cable !== 'fiber' && (pa.media === 'fiber' || pb.media === 'fiber')) return { up: false, reason: 'optický port vyžaduje optický kabel' };
      if (l.cable === 'straight' || l.cable === 'cross') {
        const like = DCE_SIDE.has(da.kind) === DCE_SIDE.has(db.kind);
        // auto-MDIX: gigabitové porty mezi dvěma switchi
        const autoMdix = DCE_SIDE.has(da.kind) && DCE_SIDE.has(db.kind) && (/^GigabitEthernet|^TenGig/.test(pa.name) || /^GigabitEthernet|^TenGig/.test(pb.name));
        if (!autoMdix && like && l.cable === 'straight') return { up: false, reason: 'stejné typy zařízení potřebují křížený kabel' };
        if (!autoMdix && !like && l.cable === 'cross') return { up: false, reason: 'různé typy zařízení potřebují přímý kabel' };
      }
      return { up: true };
    }
    /** Fyzický port je "up/up"? */
    physUp(d, p) {
      if (!p || d.power === false) return false;
      if (p.shutdown || this.rt.errdis.has(d.id + '|' + p.name)) return false;
      const lk = this.linkOf(d.id, p.name);
      if (!lk) return false;
      const st = this.linkState(lk.link);
      return st.up && !st.console;
    }
    /** Provozní stav rozhraní (včetně virtuálních) -> { status, protocol } jako v IOS */
    ifStatus(d, p) {
      if (p.shutdown) return { status: 'administratively down', protocol: 'down', up: false };
      if (this.rt.errdis.has(d.id + '|' + p.name)) return { status: 'err-disabled', protocol: 'down', up: false };
      if (d.power === false) return { status: 'down', protocol: 'down', up: false };
      const t = NM.ifType(p.name);
      if (t === 'Loopback') return { status: 'up', protocol: 'up', up: true };
      if (p.name.includes('.')) {
        const parent = NM.findPort(d, p.name.split('.')[0]);
        const up = parent && !parent.shutdown && this.physUp(d, parent);
        return { status: parent && parent.shutdown ? 'administratively down' : up ? 'up' : 'down', protocol: up ? 'up' : 'down', up };
      }
      if (t === 'Vlan') {
        const v = +p.name.slice(4);
        if (!d.cfg || !d.cfg.vlans[v]) return { status: 'up', protocol: 'down', up: false };
        const any = d.ports.some(q => !q.virtual && !q.noSwitchport && this.physUp(d, q) && this.carriesVlan(d, q, v));
        return { status: 'up', protocol: any ? 'up' : 'down', up: any };
      }
      const up = this.physUp(d, p);
      return { status: up ? 'up' : 'down', protocol: up ? 'up' : 'down', up };
    }

    /* ------------------------------- L2 ------------------------------- */
    /** Efektivní režim switchportu: access / trunk (řeší DTP dynamic auto/desirable) */
    effMode(d, p) {
      if (p.mode === 'access' || p.mode === 'trunk') return p.mode;
      const lk = this.linkOf(d.id, p.name);
      if (!lk) return 'access';
      const pd = this.dev(lk.peer.dev), pp = pd && NM.findPort(pd, lk.peer.port);
      if (!pd || !pp || !(pd.kind === 'switch' || pd.kind === 'l3switch') || pp.noSwitchport) return 'access';
      const mine = p.dynamicMode === 'desirable' ? 'desirable' : 'auto';
      const peer = pp.mode === 'trunk' ? 'on' : pp.mode === 'access' ? 'off' : (pp.dynamicMode === 'desirable' ? 'desirable' : 'auto');
      if (peer === 'on' || peer === 'desirable') return 'trunk';
      if (mine === 'desirable' && peer === 'auto') return 'trunk';
      return 'access';
    }
    allowed(p, v) { return p.allowed === 'all' ? true : p.allowed.includes(v); }
    carriesVlan(d, p, v) {
      const m = this.effMode(d, p);
      return m === 'access' ? (p.vlan || 1) === v : this.allowed(p, v);
    }
    isSwitchPort(d, p) {
      return (d.kind === 'switch' || d.kind === 'l3switch' || d.kind === 'ap') && !p.virtual && !p.noSwitchport;
    }

    /** L3 rozhraní zařízení */
    l3Ifaces(d, includeDown) {
      const out = [];
      if (d.power === false) return out;
      for (const p of d.ports) {
        if (p.hidden && !p.ip) continue;
        if (!p.ip || !p.mask) continue;
        if (this.isSwitchPort(d, p)) continue;
        const st = NM.HOST_KINDS.has(d.kind) ? { up: !p.shutdown && this.physUp(d, p) } : this.ifStatus(d, p);
        if (!st.up && !includeDown) continue;
        const t = NM.ifType(p.name);
        const it = { dev: d, port: p, name: p.name, ip: p.ip, mask: p.mask, mac: p.mac, up: st.up, phys: null, tag: null, svi: null };
        if (t === 'Vlan') it.svi = +p.name.slice(4);
        else if (t === 'Loopback') { /* bez L2 */ }
        else if (p.name.includes('.')) { it.phys = p.name.split('.')[0]; it.tag = p.encapNative ? null : p.encap; if (!p.encap) continue; }
        else it.phys = p.name;
        out.push(it);
      }
      return out;
    }

    /**
     * L2 doručení z L3 rozhraní – vrací seznam koncových L3 rozhraní,
     * kam se rámec (broadcast) dostane, včetně cesty.
     */
    l2Flood(src) {
      const res = [];
      const seen = new Set();
      const queue = [];
      const startPath = [{ dev: src.dev.id, out: src.phys || (src.svi ? 'Vlan' + src.svi : null) }];
      const emitOutPort = (d, portName, tag, path) => {
        const lk = this.linkOf(d.id, portName);
        if (!lk) return;
        const p = NM.findPort(d, portName);
        if (!this.physUp(d, p)) return;
        queue.push({ dev: this.dev(lk.peer.dev), port: lk.peer.port, tag, path });
      };
      const switchForward = (d, inPort, v, path) => {
        const key = d.id + '#' + v;
        if (seen.has(key)) return;
        seen.add(key);
        for (const q of d.ports) {
          if (q.name === inPort || q.virtual || !this.isSwitchPort(d, q)) continue;
          if (!this.physUp(d, q) || !this.carriesVlan(d, q, v)) continue;
          if (this.stpBlocked(d, q, v)) continue;
          const m = this.effMode(d, q);
          const tag = m === 'access' ? null : (v === (q.native || 1) ? null : v);
          emitOutPort(d, q.name, tag, path.concat({ dev: d.id, in: inPort, out: q.name, vlan: v }));
        }
        // SVI
        const svi = NM.findPort(d, 'Vlan' + v);
        if (svi && svi.ip && inPort !== 'Vlan' + v) {
          const it = this.l3Ifaces(d).find(i => i.svi === v);
          if (it && it !== src) res.push({ iface: it, path: path.concat({ dev: d.id, in: inPort, out: 'Vlan' + v, vlan: v }) });
        }
      };
      if (src.svi) switchForward(src.dev, 'Vlan' + src.svi, src.svi, []);
      else if (src.phys) emitOutPort(src.dev, src.phys, src.tag, startPath);
      else return res;

      let guard = 0;
      while (queue.length && guard++ < 5000) {
        const { dev: d, port: pn, tag, path } = queue.shift();
        if (!d || d.power === false) continue;
        const p = NM.findPort(d, pn);
        if (!p) continue;
        if (d.kind === 'hub') {
          const key = d.id + '#hub';
          if (seen.has(key)) continue; seen.add(key);
          for (const q of d.ports) if (q.name !== pn) emitOutPort(d, q.name, tag, path.concat({ dev: d.id, in: pn, out: q.name }));
          continue;
        }
        if (this.isSwitchPort(d, p)) {
          const m = this.effMode(d, p);
          let v;
          if (m === 'access') { if (tag !== null && tag !== undefined) continue; v = p.vlan || 1; }
          else { v = tag === null || tag === undefined ? (p.native || 1) : tag; if (!this.allowed(p, v)) continue; }
          if (!d.cfg || !d.cfg.vlans[v]) continue; // VLAN neexistuje -> port neaktivní
          if (this.stpBlocked(d, p, v)) continue;
          if (src.mac && !this.psecAllow(d, p, src.mac)) continue;
          switchForward(d, pn, v, path);
          continue;
        }
        // koncové zařízení / routovaný port
        const cands = this.l3Ifaces(d).filter(i => i.phys === pn && ((i.tag ?? null) === (tag ?? null)));
        for (const it of cands) if (it !== src) res.push({ iface: it, path: path.concat({ dev: d.id, in: pn }) });
        if (!cands.length) res.push({ iface: null, dev: d, port: pn, path: path.concat({ dev: d.id, in: pn }) });
      }
      return res;
    }

    /* ------------------------------- L3 ------------------------------- */
    canRoute(d) {
      if (d.power === false) return false;
      if (d.kind === 'router' || d.kind === 'cloud') return true;
      if (d.kind === 'l3switch') return !!(d.cfg && d.cfg.ipRouting);
      return false;
    }
    /** Routovací tabulka zařízení (pole záznamů) */
    routes(d) {
      const rs = [];
      const ifs = this.l3Ifaces(d);
      for (const i of ifs) {
        rs.push({ type: 'C', net: IP.str(IP.network(i.ip, i.mask)), mask: i.mask, iface: i.name, ad: 0, metric: 0 });
        if (d.ios) rs.push({ type: 'L', net: i.ip, mask: '255.255.255.255', iface: i.name, ad: 0, metric: 0 });
      }
      if (!d.ios) {
        if (d.gateway && IP.valid(d.gateway)) rs.push({ type: 'S*', net: '0.0.0.0', mask: '0.0.0.0', nh: d.gateway, ad: 1, metric: 0 });
        return rs;
      }
      if (!this.canRoute(d)) {
        const gw = d.cfg.defaultGateway;
        if (gw && IP.valid(gw)) rs.push({ type: 'S*', net: '0.0.0.0', mask: '0.0.0.0', nh: gw, ad: 1, metric: 0, gw: true });
        return rs;
      }
      for (const r of d.cfg.routes) {
        if (!IP.valid(r.net) || !IP.maskValid(r.mask)) continue;
        const e = { type: r.net === '0.0.0.0' && r.mask === '0.0.0.0' ? 'S*' : 'S', net: IP.str(IP.network(r.net, r.mask)), mask: r.mask, nh: r.nh, iface: r.iface, ad: r.ad || 1, metric: 0 };
        if (e.iface) { const p = NM.findPort(d, e.iface); if (!p || !this.ifStatus(d, p).up) continue; }
        else if (!this.lookupConnected(ifs, r.nh) && !rs.some(x => x.type !== 'L' && IP.inNet(r.nh, x.net, x.mask))) continue;
        rs.push(e);
      }
      const dyn = this.dynamic().get(d.id) || [];
      for (const r of dyn) {
        // nepřebíjej lepší (nižší AD) trasu na stejný prefix
        const same = rs.find(x => x.net === r.net && x.mask === r.mask);
        if (same && same.ad <= r.ad) continue;
        if (same) rs.splice(rs.indexOf(same), 1);
        rs.push(r);
      }
      return rs;
    }
    lookupConnected(ifs, ip) { return ifs.find(i => IP.valid(ip) && IP.sameNet(i.ip, ip, i.mask)) || null; }
    lookup(d, dst, table) {
      const rs = (table || this.routes(d)).filter(r => r.type !== 'L');
      let best = null;
      for (const r of rs) {
        if (!IP.inNet(dst, r.net, r.mask)) continue;
        const len = IP.prefixLen(r.mask);
        if (!best || len > best.len || (len === best.len && (r.ad < best.r.ad || (r.ad === best.r.ad && r.metric < best.r.metric)))) best = { r, len };
      }
      return best ? best.r : null;
    }
    /** -> { iface, nh } nebo null */
    resolve(d, dst, depth) {
      depth = depth || 0;
      if (depth > 6) return null;
      const ifs = this.l3Ifaces(d);
      const r = this.lookup(d, dst);
      if (!r) return null;
      if (r.type === 'C') { const i = ifs.find(x => x.name === r.iface); return i ? { iface: i, nh: dst, route: r } : null; }
      if (r.iface && !r.nh) { const i = ifs.find(x => x.name === r.iface); return i ? { iface: i, nh: dst, route: r } : null; }
      if (r.iface && r.nh) { const i = ifs.find(x => x.name === r.iface); return i ? { iface: i, nh: r.nh, route: r } : null; }
      const via = this.resolve(d, r.nh, depth + 1);
      return via ? { iface: via.iface, nh: via.nh === r.nh ? r.nh : via.nh, route: r } : null;
    }
    owns(d, ip) { return this.l3Ifaces(d).find(i => i.ip === ip) || null; }

    /* -------------------------- dynamické směrování -------------------------- */
    dynamic() {
      if (this._dyn) return this._dyn;
      const out = new Map();
      this._dyn = out; // zabrání rekurzi (routes() -> dynamic())
      const routers = this.p.devices.filter(d => d.ios && d.cfg && this.canRoute(d));
      const protos = [
        { key: 'eigrp', ad: 90, code: 'D', on: d => d.cfg.eigrp.length > 0,
          match: (d, i) => d.cfg.eigrp.some(e => e.networks.some(n => n.wild ? IP.inNet(i.ip, n.net, IP.wildcardToMask(n.wild)) : IP.inNet(i.ip, n.net, IP.classfulMask(n.net)))) },
        { key: 'ospf', ad: 110, code: 'O', on: d => d.cfg.ospf.length > 0,
          match: (d, i) => d.cfg.ospf.some(o => o.networks.some(n => IP.inNet(i.ip, n.net, IP.wildcardToMask(n.wild)))) },
        { key: 'rip', ad: 120, code: 'R', on: d => !!d.cfg.rip,
          match: (d, i) => d.cfg.rip.networks.some(n => IP.inNet(i.ip, n, IP.classfulMask(n))) }
      ];
      const cost = (proto, i) => {
        if (proto.key === 'rip') return 1;
        const t = NM.ifType(i.name);
        const base = t === 'Serial' ? 64 : t === 'Ethernet' ? 10 : 1;
        return proto.key === 'eigrp' ? base * 256 + 2560 : base;
      };
      const defaultOrig = (proto, d) => {
        const ex = proto.key === 'rip' ? d.cfg.rip.extra : proto.key === 'ospf' ? d.cfg.ospf.flatMap(o => o.extra) : d.cfg.eigrp.flatMap(e => e.extra);
        return ex.some(x => /^default-information originate/.test(x)) && d.cfg.routes.some(r => r.net === '0.0.0.0' && r.mask === '0.0.0.0');
      };
      for (const proto of protos) {
        const parts = routers.filter(proto.on);
        if (!parts.length) continue;
        const active = new Map(parts.map(d => [d.id, this.l3Ifaces(d).filter(i => proto.match(d, i))]));
        // sousedé
        const nbr = new Map(parts.map(d => [d.id, []]));
        for (const d of parts) for (const i of active.get(d.id)) {
          if (!i.phys && !i.svi) continue;
          for (const e of this.l2Flood(i)) {
            if (!e.iface) continue;
            const o = e.iface.dev;
            if (o === d || !active.has(o.id) || !active.get(o.id).some(x => x.name === e.iface.name)) continue;
            if (!IP.sameNet(i.ip, e.iface.ip, i.mask)) continue;
            nbr.get(d.id).push({ dev: o, via: i, nh: e.iface.ip });
          }
        }
        // distance-vector
        const tab = new Map(parts.map(d => {
          const m = new Map();
          for (const i of active.get(d.id)) m.set(IP.str(IP.network(i.ip, i.mask)) + '/' + i.mask, { metric: proto.key === 'rip' ? 0 : cost(proto, i), own: true });
          if (defaultOrig(proto, d)) m.set('0.0.0.0/0.0.0.0', { metric: 0, own: true, ext: true });
          return [d.id, m];
        }));
        for (let it = 0; it < 32; it++) {
          let changed = false;
          for (const d of parts) {
            const mine = tab.get(d.id);
            for (const n of nbr.get(d.id)) {
              for (const [pfx, e] of tab.get(n.dev.id)) {
                if (e.nh && e.nhDev === d.id) continue; // split horizon
                const m = e.metric + cost(proto, n.via);
                if (proto.key === 'rip' && m > 15) continue;
                const cur = mine.get(pfx);
                if (!cur || (!cur.own && m < cur.metric)) { mine.set(pfx, { metric: m, nh: n.nh, iface: n.via.name, nhDev: n.dev.id, ext: e.ext }); changed = true; }
              }
            }
          }
          if (!changed) break;
        }
        for (const d of parts) {
          const list = out.get(d.id) || [];
          for (const [pfx, e] of tab.get(d.id)) {
            if (e.own) continue;
            const [net, mask] = pfx.split('/');
            const ex = list.find(r => r.net === net && r.mask === mask);
            if (ex && ex.ad <= proto.ad) continue;
            if (ex) list.splice(list.indexOf(ex), 1);
            list.push({ type: proto.code + (net === '0.0.0.0' && mask === '0.0.0.0' ? '*' : '') + (e.ext && proto.key === 'ospf' ? ' E2' : ''), net, mask, nh: e.nh, iface: e.iface, ad: proto.ad, metric: e.metric });
          }
          out.set(d.id, list);
        }
      }
      return out;
    }

    /* --------------------------------- ARP / MAC -------------------------------- */
    arpTable(d) { if (!this.rt.arp.has(d.id)) this.rt.arp.set(d.id, new Map()); return this.rt.arp.get(d.id); }
    macTable(d) { if (!this.rt.mac.has(d.id)) this.rt.mac.set(d.id, new Map()); return this.rt.mac.get(d.id); }
    learn(fromIf, toIf, path, nhIp) {
      if (toIf) {
        this.arpTable(fromIf.dev).set(nhIp || toIf.ip, { mac: toIf.mac, iface: fromIf.name });
        this.arpTable(toIf.dev).set(fromIf.ip, { mac: fromIf.mac, iface: toIf.name });
      }
      for (const h of path) {
        const d = this.dev(h.dev);
        if (d && (d.kind === 'switch' || d.kind === 'l3switch') && h.in && h.vlan) {
          this.macTable(d).set(h.vlan + '|' + fromIf.mac, { vlan: h.vlan, mac: fromIf.mac, port: h.in });
          if (toIf && h.out && !h.out.startsWith('Vlan')) this.macTable(d).set(h.vlan + '|' + toIf.mac, { vlan: h.vlan, mac: toIf.mac, port: h.out });
        }
      }
    }
    clearArp(d) { this.arpTable(d).clear(); }

    /* ------------------------------ STP ------------------------------ */
    /** Spanning tree pro VLAN v -> { state: Map("dev|port" -> root|desg|altn), info: Map(devId -> {...}) } */
    stp(v) {
      if (!this._stp) this._stp = new Map();
      if (this._stp.has(v)) return this._stp.get(v);
      const state = new Map(), info = new Map(), out = { state, info };
      this._stp.set(v, out);
      const sws = this.p.devices.filter(d => (d.kind === 'switch' || d.kind === 'l3switch') && d.power !== false && d.cfg && d.cfg.vlans[v]);
      const swSet = new Set(sws.map(d => d.id));
      const bidCache = new Map();
      const bid = d => {
        if (bidCache.has(d.id)) return bidCache.get(d.id);
        const base = d.cfg.stp && d.cfg.stp[v] !== undefined ? d.cfg.stp[v] : 32768;
        const mac = (d.ports.find(q => !q.virtual && !q.hidden) || { mac: 'FFFF.FFFF.FFFF' }).mac.toUpperCase();
        const b = { base, pr: base + v, mac, key: String(base + v).padStart(6, '0') + mac };
        bidCache.set(d.id, b); return b;
      };
      const cost = q => (/^TenGig/.test(q.name) ? 2 : /^Gigabit/.test(q.name) ? 4 : /^Fast/.test(q.name) ? 19 : 100);
      const chan = q => { const m = (q.extra || []).map(x => x.match(/^channel-group (\d+)/)).find(Boolean); return m ? m[1] : null; };
      const cmp = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; };
      const adj = new Map(sws.map(d => [d.id, []]));
      const bundles = new Map();
      for (const l of this.p.links) {
        if (!swSet.has(l.a.dev) || !swSet.has(l.b.dev)) continue;
        const da = this.dev(l.a.dev), db = this.dev(l.b.dev), pa = NM.findPort(da, l.a.port), pb = NM.findPort(db, l.b.port);
        if (!pa || !pb || !this.isSwitchPort(da, pa) || !this.isSwitchPort(db, pb)) continue;
        if (!this.physUp(da, pa) || !this.carriesVlan(da, pa, v) || !this.carriesVlan(db, pb, v)) continue;
        const ca = chan(pa), cb = chan(pb), ka = da.id + '|' + pa.name, kb = db.id + '|' + pb.name;
        if (ca && cb) {
          const k1 = [da.id, ca, db.id, cb].join('#'), k2 = [db.id, cb, da.id, ca].join('#');
          const b = bundles.get(k1) || bundles.get(k2);
          if (b) { b.members.push([ka, b.rep[da.id]], [kb, b.rep[db.id]]); continue; }
          bundles.set(k1, { rep: { [da.id]: ka, [db.id]: kb }, members: [] });
        }
        const c = ca && cb ? Math.max(1, Math.floor(cost(pa) / 2)) : cost(pa);
        adj.get(da.id).push({ port: pa, other: db, oport: pb, cost: c });
        adj.get(db.id).push({ port: pb, other: da, oport: pa, cost: ca && cb ? c : cost(pb) });
      }
      const done = new Set();
      for (const s0 of sws) {
        if (done.has(s0.id)) continue;
        const comp = [], st = [s0]; done.add(s0.id);
        while (st.length) { const d = st.pop(); comp.push(d); for (const e of adj.get(d.id)) if (!done.has(e.other.id)) { done.add(e.other.id); st.push(e.other); } }
        const root = comp.reduce((a, b) => (bid(a).key <= bid(b).key ? a : b));
        const dist = new Map(comp.map(d => [d.id, Infinity])); dist.set(root.id, 0);
        for (let i = 0; i < comp.length; i++) for (const d of comp) for (const e of adj.get(d.id)) { const nd = dist.get(e.other.id) + e.cost; if (nd < dist.get(d.id)) dist.set(d.id, nd); }
        for (const d of comp) {
          let rp = null;
          if (d !== root) for (const e of adj.get(d.id)) {
            const cand = [dist.get(e.other.id) + e.cost, bid(e.other).key, e.other.ports.indexOf(e.oport), d.ports.indexOf(e.port)];
            if (!rp || cmp(cand, rp.cand) < 0) rp = { e, cand };
          }
          info.set(d.id, { root: root.id, rootBid: bid(root), bid: bid(d), cost: dist.get(d.id), rootPort: rp ? rp.e.port.name : null, portCost: cost });
          for (const e of adj.get(d.id)) {
            const key = d.id + '|' + e.port.name;
            if (rp && rp.e === e) { state.set(key, 'root'); continue; }
            const mine = [dist.get(d.id), bid(d).key], theirs = [dist.get(e.other.id), bid(e.other).key];
            state.set(key, cmp(mine, theirs) < 0 ? 'desg' : 'altn');
          }
        }
      }
      for (const b of bundles.values()) for (const [k, repKey] of b.members) state.set(k, state.get(repKey) || 'desg');
      return out;
    }
    stpBlocked(d, p, v) { return this.stp(v).state.get(d.id + '|' + p.name) === 'altn'; }
    /** je port blokovaný STP v některé VLAN, kterou nese? (pro oranžovou kontrolku) */
    stpBlockedAny(d, p) {
      if (!d.cfg || !this.isSwitchPort(d, p)) return false;
      const vl = this.effMode(d, p) === 'access' ? [p.vlan || 1] : Object.keys(d.cfg.vlans).map(Number).filter(v => this.allowed(p, v));
      return vl.length > 0 && vl.every(v => this.stpBlocked(d, p, v));
    }

    /* --------------------------- port-security --------------------------- */
    psecState(d, p) {
      const key = d.id + '|' + p.name;
      if (!this.rt.psec.has(key)) this.rt.psec.set(key, { macs: new Set(), violations: 0, last: '' });
      return this.rt.psec.get(key);
    }
    psecAllow(d, p, mac) {
      const ex = p.extra || [];
      if (!ex.includes('switchport port-security') || this.effMode(d, p) !== 'access') return true;
      const mx = ex.map(x => x.match(/^switchport port-security maximum (\d+)/)).find(Boolean);
      const max = mx ? +mx[1] : 1;
      const st = this.psecState(d, p);
      for (const x of ex) { const m = x.match(/^switchport port-security mac-address (?:sticky )?([0-9a-fA-F.]{14})$/); if (m) st.macs.add(m[1].toUpperCase()); }
      const M = mac.toUpperCase();
      if (st.macs.has(M)) { st.last = M; return true; }
      if (st.macs.size < max) {
        st.macs.add(M); st.last = M;
        if (ex.includes('switchport port-security mac-address sticky')) { p.extra.push('switchport port-security mac-address sticky ' + M); this._violated = true; }
        return true;
      }
      st.violations++; st.last = M;
      const mode = (ex.find(x => /^switchport port-security violation/.test(x)) || 'x shutdown').split(' ').pop();
      if (mode === 'shutdown') { this.rt.errdis.add(d.id + '|' + p.name); this._violated = true; }
      return false;
    }

    /* ----------------------------- ACL / NAT ----------------------------- */
    ifaceAcl(port, dir) {
      const m = (port.extra || []).map(x => x.match(/^ip access-group (\S+) (in|out)$/)).find(m => m && m[2] === dir);
      return m ? m[1] : null;
    }
    aclPass(d, port, dir, pkt) {
      if (!d.cfg || !port) return true;
      const id = this.ifaceAcl(port, dir); if (!id) return true;
      const acl = NM.aclFind(d.cfg, id); if (!acl || !acl.entries.length) return true;
      const r = NM.aclMatch(acl, pkt);
      if (r.index >= 0) { const h = this.aclHits(d, acl); h[r.index] = (h[r.index] || 0) + 1; }
      return r.action === 'permit';
    }
    aclHits(d, acl) { const k = d.id + '|' + acl.id; if (!this.rt.aclHits.has(k)) this.rt.aclHits.set(k, {}); return this.rt.aclHits.get(k); }
    natRole(port) { const e = (port && port.extra) || []; return e.includes('ip nat inside') ? 'inside' : e.includes('ip nat outside') ? 'outside' : null; }
    natTable(d) { if (!this.rt.nat.has(d.id)) this.rt.nat.set(d.id, []); return this.rt.nat.get(d.id); }
    natGlobals(d) {
      if (!d.cfg || !d.cfg.nat) return [];
      return d.cfg.nat.statics.map(x => x.global).concat(this.natTable(d).map(t => t.global));
    }
    natOutbound(d, pkt) {
      const nat = d.cfg && d.cfg.nat; if (!nat) return null;
      const st = nat.statics.find(x => x.local === pkt.src);
      if (st) return st.global;
      const tab = this.natTable(d);
      for (const dy of nat.dynamics) {
        const acl = NM.aclFind(d.cfg, dy.acl);
        if (!acl || NM.aclMatch(acl, { src: pkt.src, dst: pkt.dst, proto: 'ip' }).action !== 'permit') continue;
        let g = null;
        if (dy.iface) { const q = NM.findPort(d, dy.iface); g = q && q.ip; }
        else if (dy.pool) {
          const pool = nat.pools.find(x => x.name === dy.pool); if (!pool) continue;
          const mine = tab.find(t => t.local === pkt.src && t.pool === dy.pool);
          if (mine) g = mine.global;
          else if (dy.overload) g = pool.start;
          else { const used = new Set(tab.filter(t => t.pool === dy.pool).map(t => t.global)); for (let a = IP.parse(pool.start); a <= IP.parse(pool.end); a++) if (!used.has(IP.str(a))) { g = IP.str(a); break; } }
        }
        if (!g) continue;
        if (!tab.some(t => t.local === pkt.src && t.global === g && t.remote === pkt.dst && t.proto === pkt.proto))
          tab.push({ local: pkt.src, global: g, remote: pkt.dst, proto: pkt.proto, pool: dy.pool || null, overload: !!dy.overload });
        if (tab.length > 200) tab.shift();
        return g;
      }
      return null;
    }
    natInbound(d, pkt) {
      const nat = d.cfg && d.cfg.nat; if (!nat) return null;
      const st = nat.statics.find(x => x.global === pkt.dst);
      if (st) return st.local;
      const tab = this.natTable(d);
      const t = tab.find(x => x.global === pkt.dst && x.remote === pkt.src && x.proto === pkt.proto) || tab.find(x => x.global === pkt.dst && x.pool && !x.overload);
      return t ? t.local : null;
    }

    /* --------------------------------- IP průchod -------------------------------- */
    /**
     * Pošle IP paket ze zařízení src na dst.
     * Vrací { ok, reason, at, atIp, hops, segments, trace, ttl, srcSeen, dstSeen, dstDev }
     * trace = seznam L3 skoků (pro krokovou simulaci).
     */
    forward(src, dst, opts) {
      opts = opts || {};
      let ttl = opts.ttl || (src.ios ? 255 : 128);
      const segments = [], hops = [], trace = [];
      const pkt = { src: opts.srcIp || null, dst, proto: opts.proto || 'icmp', sport: opts.sport || null, dport: opts.dport || null, icmp: opts.icmp || 'echo' };
      let cur = src, inIf = null, arpMiss = false;
      const res = o => Object.assign({ segments, hops, trace, srcIp: pkt.src, srcSeen: pkt.src, dstSeen: pkt.dst, ttl, arpMiss, proto: pkt.proto }, o);
      if (!IP.valid(dst)) return res({ ok: false, reason: 'badip' });
      for (let step = 0; step < 32; step++) {
        if (cur !== src && inIf) {
          if (this.natRole(inIf.port) === 'outside') { const l = this.natInbound(cur, pkt); if (l) { trace.push({ note: true, dev: cur.id, text: 'NAT: cílová adresa ' + pkt.dst + ' → ' + l }); pkt.dst = l; } }
          if (!this.aclPass(cur, inIf.port, 'in', pkt)) return res({ ok: false, reason: 'acl', at: cur, atIp: inIf.ip, acl: this.ifaceAcl(inIf.port, 'in') + ' in na ' + inIf.name });
        }
        const own = this.owns(cur, pkt.dst);
        if (own) { if (!pkt.src) pkt.src = own.ip; return res({ ok: true, at: cur, dstDev: cur }); }
        if (cur !== src) {
          if (!this.canRoute(cur)) return res({ ok: false, reason: 'drop', at: cur });
          ttl--;
          if (ttl <= 0) return res({ ok: false, reason: 'ttl', at: cur, atIp: inIf && inIf.ip });
        }
        const r = this.resolve(cur, pkt.dst);
        if (!r) return res({ ok: false, reason: cur === src ? 'noroute-src' : 'unreachable', at: cur, atIp: inIf ? inIf.ip : null });
        if (!pkt.src) pkt.src = r.iface.ip;
        if (cur !== src && inIf) {
          if (this.natRole(inIf.port) === 'inside' && this.natRole(r.iface.port) === 'outside') { const g = this.natOutbound(cur, pkt); if (g) { trace.push({ note: true, dev: cur.id, text: 'NAT: zdrojová adresa ' + pkt.src + ' → ' + g }); pkt.src = g; } }
          if (!this.aclPass(cur, r.iface.port, 'out', pkt)) return res({ ok: false, reason: 'acl', at: cur, atIp: inIf.ip, acl: this.ifaceAcl(r.iface.port, 'out') + ' out na ' + r.iface.name });
        }
        const ends = this.l2Flood(r.iface);
        const hit = ends.find(e => e.iface && (e.iface.ip === r.nh || (this.natRole(e.iface.port) === 'outside' && this.natGlobals(e.iface.dev).includes(r.nh))));
        if (!hit) return res({ ok: false, reason: 'arp', at: cur, nh: r.nh, atIp: inIf ? inIf.ip : null, arpFrom: { dev: cur.id, out: r.iface.name, mac: r.iface.mac, ip: r.iface.ip }, flood: ends.map(e => e.path) });
        const miss = !this.arpTable(cur).has(r.nh);
        if (miss && step === 0) arpMiss = true;
        this.learn(r.iface, hit.iface, hit.path, r.nh);
        segments.push(hit.path);
        hops.push({ dev: hit.iface.dev, ip: hit.iface.ip, ingress: hit.iface });
        trace.push({ from: cur.id, to: hit.iface.dev.id, out: r.iface.name, inName: hit.iface.name, srcMac: r.iface.mac, dstMac: hit.iface.mac, nh: r.nh, path: hit.path, ttl, src: pkt.src, dst: pkt.dst, arp: miss, route: r.route, outIp: r.iface.ip });
        inIf = hit.iface; cur = hit.iface.dev;
      }
      return res({ ok: false, reason: 'loop', at: cur });
    }

    /** ICMP echo (nebo TCP spojení přes opts.proto/dport): { ok, reason, fwd, back, ttl, from } */
    ping(src, dst, opts) {
      opts = opts || {};
      const fwd = this.forward(src, dst, opts);
      let out;
      if (!fwd.ok) out = { ok: false, reason: fwd.reason, fwd, from: fwd.at };
      else {
        const back = this.forward(fwd.dstDev, fwd.srcSeen, { srcIp: fwd.dstSeen, icmp: 'reply', proto: opts.proto, sport: opts.dport, dport: opts.sport });
        if (!back.ok || back.dstDev !== src) out = { ok: false, reason: 'noreply', fwd, back, from: back.at };
        else out = { ok: true, fwd, back, ttl: back.ttl, from: fwd.dstDev, arpMiss: fwd.arpMiss };
      }
      if (this._violated) { this._violated = false; this.touch(); }
      return out;
    }

    /** traceroute: [{ ip, ok }] */
    traceroute(src, dst) {
      const fwd = this.forward(src, dst);
      const first = fwd.trace.find(t => t.src);
      const origSrc = first ? first.src : fwd.srcIp;
      const res = [];
      for (const h of fwd.hops) {
        const back = origSrc ? this.forward(h.dev, origSrc, {}) : { ok: false };
        res.push({ ip: h.ip, ok: back.ok, dev: h.dev });
      }
      if (!fwd.ok) {
        if (fwd.reason === 'unreachable' || fwd.reason === 'acl') res.push({ ip: fwd.atIp || '*', ok: !!fwd.atIp, unreachable: true });
        for (let i = 0; i < 3; i++) res.push({ ip: '*', ok: false });
      }
      return { hops: res, ok: fwd.ok, fwd };
    }

    /* ------------------------------------ DHCP ----------------------------------- */
    dhcp(d, p) {
      const fake = { dev: d, port: p, name: p.name, ip: '0.0.0.0', mask: '0.0.0.0', mac: p.mac, phys: p.name, tag: null };
      if (!this.physUp(d, p)) return null;
      const ends = this.l2Flood(fake);
      const tryServer = (srv, giaddr, giMask) => {
        if (srv.ios && srv.cfg) {
          const pool = srv.cfg.dhcpPools.find(pl => pl.network && IP.inNet(giaddr, pl.network, pl.mask));
          if (!pool) return null;
          const ip = this.allocate(srv, p.mac, pool.network, pool.mask, srv.cfg.dhcpExcluded);
          return ip ? { ip, mask: pool.mask, gw: pool.router, dns: pool.dns, server: srv } : null;
        }
        if (srv.services && srv.services.dhcp.enabled) {
          const pool = srv.services.dhcp.pools.find(pl => pl.start && IP.inNet(giaddr, pl.start, pl.mask || giMask));
          if (!pool) return null;
          const ip = this.allocate(srv, p.mac, IP.str(IP.network(pool.start, pool.mask)), pool.mask, [], pool.start, pool.max);
          return ip ? { ip, mask: pool.mask, gw: pool.gateway, dns: pool.dns, server: srv } : null;
        }
        return null;
      };
      for (const e of ends) {
        if (!e.iface) continue;
        const srv = e.iface.dev;
        const r = tryServer(srv, e.iface.ip, e.iface.mask);
        if (r) return Object.assign(r, { path: e.path });
        // relay
        if (e.iface.port.helper) {
          const fw = this.forward(srv, e.iface.port.helper);
          if (fw.ok) { const r2 = tryServer(fw.dstDev, e.iface.ip, e.iface.mask); if (r2) return Object.assign(r2, { path: e.path }); }
        }
      }
      return null;
    }
    allocate(srv, mac, net, mask, excluded, start, max) {
      if (!this.rt.leases.has(srv.id)) this.rt.leases.set(srv.id, new Map());
      const leases = this.rt.leases.get(srv.id);
      if (leases.has(mac)) return leases.get(mac);
      const used = new Set(leases.values());
      for (const d of this.p.devices) for (const q of d.ports) if (q.ip) used.add(q.ip);
      const n0 = IP.parse(net), bc = IP.broadcast(net, mask);
      let a = start ? IP.parse(start) : n0 + 1, count = 0;
      for (; a < bc; a++) {
        const s = IP.str(a);
        if (used.has(s)) continue;
        if (excluded.some(([x, y]) => a >= IP.parse(x) && a <= IP.parse(y || x))) continue;
        if (max && ++count > max) return null;
        leases.set(mac, s);
        return s;
      }
      return null;
    }
    leasesOf(srv) { return this.rt.leases.get(srv.id) || new Map(); }

    /* --------------------------------- souhrny --------------------------------- */
    /** body cesty (ID zařízení) pro animaci ze segmentů */
    static flatten(segments) {
      const ids = [];
      for (const seg of segments) for (const h of seg) if (ids[ids.length - 1] !== h.dev) ids.push(h.dev);
      return ids;
    }
  }

  const api = { Sim };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NetSim = api;
})(typeof self !== 'undefined' ? self : this);
