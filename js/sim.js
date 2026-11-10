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
      this.rt = { arp: new Map(), mac: new Map(), leases: new Map() };
      this.touch();
    }
    touch() { this._idx = null; this._dyn = null; }

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
      if (p.shutdown) return false;
      const lk = this.linkOf(d.id, p.name);
      if (!lk) return false;
      const st = this.linkState(lk.link);
      return st.up && !st.console;
    }
    /** Provozní stav rozhraní (včetně virtuálních) -> { status, protocol } jako v IOS */
    ifStatus(d, p) {
      if (p.shutdown) return { status: 'administratively down', protocol: 'down', up: false };
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
    learn(fromIf, toIf, path) {
      if (toIf) {
        this.arpTable(fromIf.dev).set(toIf.ip, { mac: toIf.mac, iface: fromIf.name });
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

    /* --------------------------------- IP průchod -------------------------------- */
    /**
     * Pošle IP paket ze zařízení src na dst.
     * Vrací { ok, reason, at, hops:[iface na vstupu do každého L3 skoku], segments:[[{dev,...}]], ttl, srcIp, dstDev }
     */
    forward(src, dst, opts) {
      opts = opts || {};
      let ttl = opts.ttl || (src.ios ? 255 : 128);
      const segments = [], hops = [];
      let cur = src, srcIp = opts.srcIp || null, arpMiss = false;
      if (!IP.valid(dst)) return { ok: false, reason: 'badip', segments, hops };
      for (let step = 0; step < 32; step++) {
        const own = this.owns(cur, dst);
        if (own) {
          if (!srcIp) srcIp = own.ip;
          return { ok: true, at: cur, ttl, segments, hops, srcIp, dstDev: cur, arpMiss };
        }
        if (cur !== src) {
          if (!this.canRoute(cur)) return { ok: false, reason: 'drop', at: cur, segments, hops, srcIp };
          ttl--;
          if (ttl <= 0) return { ok: false, reason: 'ttl', at: cur, segments, hops, srcIp, arpMiss };
        }
        const r = this.resolve(cur, dst);
        if (!r) return { ok: false, reason: cur === src ? 'noroute-src' : 'unreachable', at: cur, atIp: hops.length ? hops[hops.length - 1].ip : null, segments, hops, srcIp, arpMiss };
        if (!srcIp) srcIp = r.iface.ip;
        const ends = this.l2Flood(r.iface);
        const hit = ends.find(e => e.iface && e.iface.ip === r.nh);
        if (!hit) {
          // posbírej kus cesty pro animaci (kam se rámec dostal)
          return { ok: false, reason: 'arp', at: cur, segments, hops, srcIp, nh: r.nh, arpMiss };
        }
        if (!this.arpTable(cur).has(r.nh)) arpMiss = arpMiss || step === 0;
        this.learn(r.iface, hit.iface, hit.path);
        segments.push(hit.path);
        hops.push({ dev: hit.iface.dev, ip: hit.iface.ip, ingress: hit.iface });
        if (opts.maxHops && hops.length >= opts.maxHops && hit.iface.dev.ip !== dst) {
          if (!this.owns(hit.iface.dev, dst)) return { ok: false, reason: 'ttl', at: hit.iface.dev, segments, hops, srcIp, arpMiss };
        }
        cur = hit.iface.dev;
      }
      return { ok: false, reason: 'loop', at: cur, segments, hops, srcIp };
    }

    /** ICMP echo: { ok, reason, fwd, back, ttl, from } */
    ping(src, dst) {
      const fwd = this.forward(src, dst);
      if (!fwd.ok) return { ok: false, reason: fwd.reason, fwd, from: fwd.at };
      const back = this.forward(fwd.dstDev, fwd.srcIp, {});
      if (!back.ok) return { ok: false, reason: 'noreply', fwd, back, from: back.at };
      return { ok: true, fwd, back, ttl: back.ttl, from: fwd.dstDev, arpMiss: fwd.arpMiss };
    }

    /** traceroute: [{ ip, ok }] */
    traceroute(src, dst) {
      const fwd = this.forward(src, dst);
      const res = [];
      for (const h of fwd.hops) {
        const back = this.forward(h.dev, fwd.srcIp || '0.0.0.0', {});
        res.push({ ip: h.ip, ok: back.ok, dev: h.dev });
      }
      if (!fwd.ok) {
        if (fwd.reason === 'unreachable') res.push({ ip: fwd.at && this.l3Ifaces(fwd.at)[0] ? this.l3Ifaces(fwd.at)[0].ip : '*', ok: true, unreachable: true });
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
