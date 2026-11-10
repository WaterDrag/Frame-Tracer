/*
 * netmodel.js – datový model sítě, katalog zařízení, IP utility,
 * parser a generátor IOS konfigurace, hesla (MD5-crypt, typ 7).
 */
(function (root) {
  'use strict';

  /* ------------------------------ IP ------------------------------ */
  const IP = {
    parse(s) {
      if (typeof s !== 'string') return null;
      const m = s.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (!m) return null;
      const p = m.slice(1).map(Number);
      if (p.some(x => x > 255)) return null;
      return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
    },
    str(n) { return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'); },
    valid(s) { return IP.parse(s) !== null; },
    maskValid(s) {
      const n = IP.parse(s); if (n === null) return false;
      const inv = (~n) >>> 0; return ((inv + 1) & inv) === 0;
    },
    prefixLen(mask) { let n = IP.parse(mask) >>> 0, c = 0; while (n & 0x80000000) { c++; n = (n << 1) >>> 0; } return c; },
    maskFromLen(len) { return IP.str(len === 0 ? 0 : (0xFFFFFFFF << (32 - len)) >>> 0); },
    network(ip, mask) { return (IP.parse(ip) & IP.parse(mask)) >>> 0; },
    sameNet(a, b, mask) { return IP.network(a, mask) === IP.network(b, mask); },
    inNet(ip, net, mask) { const m = IP.parse(mask); return ((IP.parse(ip) & m) >>> 0) === ((IP.parse(net) & m) >>> 0); },
    broadcast(ip, mask) { return (IP.network(ip, mask) | (~IP.parse(mask) >>> 0)) >>> 0; },
    classfulMask(ip) {
      const f = IP.parse(ip) >>> 24;
      return f < 128 ? '255.0.0.0' : f < 192 ? '255.255.0.0' : '255.255.255.0';
    },
    isHostAddr(ip, mask) {
      const n = IP.parse(ip), net = IP.network(ip, mask), bc = IP.broadcast(ip, mask);
      if (IP.prefixLen(mask) >= 31) return true;
      return n !== net && n !== bc;
    },
    wildcardToMask(w) { return IP.str((~IP.parse(w)) >>> 0); }
  };

  /* ----------------------- názvy rozhraní ------------------------- */
  const IF_TYPES = ['Ethernet', 'FastEthernet', 'GigabitEthernet', 'TenGigabitEthernet', 'Serial', 'Vlan', 'Loopback', 'Tunnel', 'Port-channel'];
  const IF_SHORT = { Ethernet: 'Et', FastEthernet: 'Fa', GigabitEthernet: 'Gig', TenGigabitEthernet: 'Te', Serial: 'Se', Vlan: 'Vlan', Loopback: 'Lo', Tunnel: 'Tu', 'Port-channel': 'Po' };

  /** "g0/0.10" -> "GigabitEthernet0/0.10", null když neplatné */
  function expandIf(str) {
    if (!str) return null;
    const m = String(str).trim().match(/^([A-Za-z-]+)\s*(\d[\d/.:]*)$/);
    if (!m) return null;
    const pre = m[1].toLowerCase();
    let hit = IF_TYPES.find(t => t.toLowerCase() === pre);
    if (!hit) {
      const pref = { e: 'Ethernet', et: 'Ethernet', f: 'FastEthernet', fa: 'FastEthernet', g: 'GigabitEthernet', gi: 'GigabitEthernet', gig: 'GigabitEthernet', t: 'TenGigabitEthernet', te: 'TenGigabitEthernet', s: 'Serial', se: 'Serial', v: 'Vlan', vl: 'Vlan', l: 'Loopback', lo: 'Loopback', tu: 'Tunnel', po: 'Port-channel', p: 'Port-channel' };
      hit = pref[pre] || IF_TYPES.find(t => t.toLowerCase().startsWith(pre));
    }
    return hit ? hit + m[2] : null;
  }
  function shortIf(name) {
    const m = String(name).match(/^([A-Za-z-]+)(.*)$/);
    if (!m || !IF_SHORT[m[1]]) return name;
    return IF_SHORT[m[1]] + m[2];
  }
  function ifType(name) { const m = String(name).match(/^([A-Za-z-]+)/); return m ? m[1] : ''; }

  /* --------------------------- katalog ---------------------------- */
  const range = (pre, a, b) => { const r = []; for (let i = a; i <= b; i++) r.push(pre + i); return r; };
  const CATALOG = {
    '2911':   { kind: 'router', ptType: 'Router', label: 'Router 2911', ios: true,
                ports: [...range('GigabitEthernet0/', 0, 2), 'Serial0/0/0', 'Serial0/0/1'] },
    '1941':   { kind: 'router', ptType: 'Router', label: 'Router 1941', ios: true,
                ports: ['GigabitEthernet0/0', 'GigabitEthernet0/1', 'Serial0/0/0', 'Serial0/0/1'] },
    '4331':   { kind: 'router', ptType: 'Router', label: 'Router ISR4331', ios: true,
                ports: ['GigabitEthernet0/0/0', 'GigabitEthernet0/0/1', 'GigabitEthernet0/0/2'] },
    '2960-24TT': { kind: 'switch', ptType: 'Switch', label: 'Switch 2960', ios: true,
                ports: [...range('FastEthernet0/', 1, 24), 'GigabitEthernet0/1', 'GigabitEthernet0/2'] },
    '3560-24PS': { kind: 'l3switch', ptType: 'MultiLayerSwitch', label: 'L3 Switch 3560', ios: true,
                ports: [...range('FastEthernet0/', 1, 24), 'GigabitEthernet0/1', 'GigabitEthernet0/2'] },
    'PC-PT':     { kind: 'pc', ptType: 'Pc', label: 'PC', ports: ['FastEthernet0'] },
    'Laptop-PT': { kind: 'laptop', ptType: 'Laptop', label: 'Laptop', ports: ['FastEthernet0'] },
    'Server-PT': { kind: 'server', ptType: 'Server', label: 'Server', ports: ['FastEthernet0'] },
    'Printer-PT':{ kind: 'printer', ptType: 'Printer', label: 'Tiskárna', ports: ['FastEthernet0'] },
    'Hub-PT':    { kind: 'hub', ptType: 'Hub', label: 'Hub', ports: range('Port', 0, 5) },
    'Cloud-PT':  { kind: 'cloud', ptType: 'Cloud', label: 'Cloud / ISP', ports: range('Ethernet', 6, 7) }
  };
  const KIND_BY_PTTYPE = {
    Router: 'router', Switch: 'switch', MultiLayerSwitch: 'l3switch', Pc: 'pc', Laptop: 'laptop', Server: 'server',
    Printer: 'printer', Hub: 'hub', Cloud: 'cloud', TabletPC: 'laptop', SmartPhone: 'laptop', AccessPoint: 'ap',
    WirelessRouter: 'router', HomeRouter: 'router', Repeater: 'hub', Bridge: 'switch', CableModem: 'other', DslModem: 'other',
    IpPhone: 'pc', 'Home VoIP': 'pc', Firewall: 'router', ASA: 'router', WirelessLanController: 'other', Sniffer: 'pc'
  };
  const HOST_KINDS = new Set(['pc', 'laptop', 'server', 'printer']);
  const IOS_KINDS = new Set(['router', 'switch', 'l3switch']);

  let uidCounter = 0;
  const uid = p => (p || 'id') + '-' + Date.now().toString(36) + '-' + (uidCounter++).toString(36) + Math.random().toString(36).slice(2, 6);
  function randomMac() {
    const b = [0x00, ...Array.from({ length: 5 }, () => Math.floor(Math.random() * 256))];
    const h = b.map(x => x.toString(16).padStart(2, '0').toUpperCase());
    return `${h[0]}${h[1]}.${h[2]}${h[3]}.${h[4]}${h[5]}`;
  }
  function mediaOf(name) {
    const t = ifType(name);
    if (t === 'Serial') return 'serial';
    if (t === 'Vlan' || t === 'Loopback' || t === 'Tunnel' || t === 'Port-channel' || name.includes('.')) return 'virtual';
    if (/^Port\d/.test(name) || /Ethernet/.test(t)) return 'copper';
    return 'other';
  }
  function newPort(name, extra) {
    return Object.assign({
      name, media: mediaOf(name), mac: randomMac(), ip: '', mask: '', shutdown: false, desc: '',
      mode: 'dynamic', vlan: 1, native: 1, allowed: 'all', encap: null, dhcp: false,
      noSwitchport: false, extra: [], virtual: mediaOf(name) === 'virtual', hidden: false,
      clockRate: null, helper: ''
    }, extra || {});
  }
  function defaultCfg(dev) {
    return {
      hostname: dev.kind === 'router' ? 'Router' : 'Switch',
      enableSecret: null, enablePassword: null, servicePwdEnc: false, bannerMotd: '',
      defaultGateway: '', ipRouting: false, domainName: '',
      vlans: { 1: 'default' }, routes: [], rip: null, ospf: [], eigrp: [],
      lines: { con: { password: '', login: false, extra: [] }, vty: { password: '', login: false, extra: [], range: '0 4' } },
      dhcpPools: [], dhcpExcluded: [], users: [], extra: [], version: dev.kind === 'router' ? '15.1' : '15.0'
    };
  }
  function createDevice(model, x, y, existingNames) {
    const c = CATALOG[model];
    const dev = { id: uid('dev'), kind: c.kind, ptType: c.ptType, model, name: '', x, y, ports: [], gateway: '', dns: '', power: true };
    let base = c.kind === 'router' ? 'Router' : c.kind === 'switch' ? 'Switch' : c.kind === 'l3switch' ? 'MLSwitch' : c.label.replace(/[^A-Za-z]/g, '');
    let i = 0; while (existingNames.has(base + i)) i++;
    dev.name = base + i;
    dev.ports = c.ports.map(n => newPort(n, { shutdown: c.kind === 'router' && mediaOf(n) !== 'virtual' }));
    if (c.ios) {
      dev.ios = true;
      dev.cfg = defaultCfg(dev);
      if (c.kind !== 'router') dev.ports.push(newPort('Vlan1', { shutdown: true }));
    }
    if (HOST_KINDS.has(c.kind)) dev.services = defaultServices(c.kind);
    return dev;
  }
  function defaultServices(kind) {
    return { dhcp: { enabled: false, pools: [{ name: 'serverPool', gateway: '', dns: '', start: '', mask: '255.255.255.0', max: 100 }] },
             dns: { enabled: false, records: [] }, http: { enabled: kind === 'server' } };
  }

  /* ----------------------- MD5 / MD5-crypt ------------------------ */
  function md5(bytes) {
    const K = new Uint32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    const len = bytes.length, nBlk = ((len + 8) >> 6) + 1, w = new Uint32Array(nBlk * 16);
    for (let i = 0; i < len; i++) w[i >> 2] |= bytes[i] << ((i % 4) * 8);
    w[len >> 2] |= 0x80 << ((len % 4) * 8);
    w[nBlk * 16 - 2] = (len * 8) >>> 0; w[nBlk * 16 - 1] = Math.floor(len / 0x20000000);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let o = 0; o < w.length; o += 16) {
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        const s = S[(i >> 4) * 4 + (i % 4)];
        const tmp = D; D = C; C = B;
        const x = (A + F + K[i] + w[o + g]) >>> 0;
        B = (B + ((x << s) | (x >>> (32 - s)))) >>> 0; A = tmp;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    const out = new Uint8Array(16);
    [a0, b0, c0, d0].forEach((v, i) => { for (let j = 0; j < 4; j++) out[i * 4 + j] = (v >>> (8 * j)) & 255; });
    return out;
  }
  const enc = s => new TextEncoder().encode(s);
  const cat = (...arrs) => { const n = arrs.reduce((a, b) => a + b.length, 0), o = new Uint8Array(n); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
  function md5crypt(pw, salt) {
    const P = enc(pw), Sa = enc(salt.slice(0, 8)), magic = enc('$1$');
    const alt = md5(cat(P, Sa, P));
    const parts = [P, magic, Sa];
    for (let i = P.length; i > 0; i -= 16) parts.push(alt.subarray(0, Math.min(16, i)));
    for (let i = P.length; i; i >>= 1) parts.push(i & 1 ? new Uint8Array(1) : P.subarray(0, 1));
    let fin = md5(cat(...parts));
    for (let i = 0; i < 1000; i++) {
      const c = [];
      c.push(i & 1 ? P : fin);
      if (i % 3) c.push(Sa);
      if (i % 7) c.push(P);
      c.push(i & 1 ? fin : P);
      fin = md5(cat(...c));
    }
    const it = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const to64 = (v, n) => { let s = ''; while (n--) { s += it[v & 0x3f]; v >>= 6; } return s; };
    const f = fin;
    const h = to64((f[0] << 16) | (f[6] << 8) | f[12], 4) + to64((f[1] << 16) | (f[7] << 8) | f[13], 4) +
              to64((f[2] << 16) | (f[8] << 8) | f[14], 4) + to64((f[3] << 16) | (f[9] << 8) | f[15], 4) +
              to64((f[4] << 16) | (f[10] << 8) | f[5], 4) + to64(f[11], 2);
    return '$1$' + salt.slice(0, 8) + '$' + h;
  }
  function makeSecret(pw) {
    const it = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    let salt = ''; for (let i = 0; i < 4; i++) salt += it[Math.floor(Math.random() * 64)];
    return md5crypt(pw, salt);
  }
  function checkSecret(pw, hash) {
    const m = String(hash).match(/^\$1\$([^$]*)\$/);
    return m ? md5crypt(pw, m[1]) === hash : pw === hash;
  }
  const XLAT = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87';
  function type7enc(pw) {
    const seed = Math.floor(Math.random() * 16);
    let s = String(seed).padStart(2, '0');
    for (let i = 0; i < pw.length; i++) s += (pw.charCodeAt(i) ^ XLAT.charCodeAt((seed + i) % XLAT.length)).toString(16).toUpperCase().padStart(2, '0');
    return s;
  }
  function type7dec(h) {
    const seed = parseInt(h.slice(0, 2), 10); let s = '';
    for (let i = 2, j = 0; i < h.length; i += 2, j++) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16) ^ XLAT.charCodeAt((seed + j) % XLAT.length));
    return s;
  }
  /** heslo z IOS řádku "password 7 0822455D0A16" / "password cisco" -> čistý text */
  function readPw(tokens) {
    if (tokens[0] === '7' && tokens[1]) return type7dec(tokens[1]);
    if (tokens[0] === '0' && tokens[1]) return tokens.slice(1).join(' ');
    return tokens.join(' ');
  }

  /* ------------------------- parser konfigu ------------------------ */
  function parseVlanList(s) {
    if (!s) return [];
    const out = [];
    for (const part of s.split(',')) {
      const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
      if (!m) continue;
      const a = +m[1], b = m[2] ? +m[2] : a;
      for (let i = a; i <= b && i <= 4094; i++) out.push(i);
    }
    return out;
  }
  function vlanListStr(list) {
    const s = [...new Set(list)].sort((a, b) => a - b), r = [];
    for (let i = 0; i < s.length; i++) {
      let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
      r.push(j > i ? `${s[i]}-${s[j]}` : String(s[i])); i = j;
    }
    return r.join(',');
  }

  function findPort(dev, name) { return dev.ports.find(p => p.name.toLowerCase() === String(name).toLowerCase()) || null; }
  function ensurePort(dev, name) {
    let p = findPort(dev, name);
    if (!p) {
      p = newPort(name, { shutdown: false });
      if (ifType(name) === 'Vlan' || ifType(name) === 'Loopback' || name.includes('.')) p.virtual = true;
      dev.ports.push(p);
    }
    return p;
  }

  /** Aplikuje řádky running-config na zařízení (při importu). */
  function applyConfigLines(dev, lines) {
    const cfg = dev.cfg;
    // výchozí: porty "neviděné" v konfigu mají default hodnoty (router: shutdown v konfigu explicitně)
    const blocks = [];
    let cur = null;
    for (const raw of lines) {
      const line = raw.replace(/\r/g, '');
      if (!line.trim() || line.trim() === '!') { cur = null; continue; }
      if (/^\s/.test(line) && cur) cur.sub.push(line.trim());
      else { cur = { head: line.trim(), sub: [] }; blocks.push(cur); }
    }
    const isRouter = dev.kind === 'router';
    // porty, které v configu jsou, nastavíme podle něj; router fyzické porty bez "no shutdown" = shutdown
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi], t = b.head.split(/\s+/), k = t[0];
      if (k === 'banner' && t[1] === 'motd') {
        // banner motd ^C text ^C (může být víceřádkový)
        const rest = b.head.slice(b.head.indexOf('motd') + 4).trim();
        const delim = rest.startsWith('^C') ? '^C' : rest[0];
        let body = rest.slice(delim.length);
        let txt = [];
        if (body.includes(delim)) txt.push(body.slice(0, body.indexOf(delim)));
        else {
          txt.push(body);
          for (const s of b.sub) { if (s.includes(delim)) { txt.push(s.slice(0, s.indexOf(delim))); break; } txt.push(s); }
          while (bi + 1 < blocks.length && !txt.join('\n').includes('\u0000')) {
            const nb = blocks[bi + 1];
            if (nb.head.includes(delim)) { txt.push(nb.head.slice(0, nb.head.indexOf(delim))); bi++; break; }
            if (/^(line|end|interface|router|ip|hostname|no)\b/.test(nb.head)) break;
            txt.push(nb.head, ...nb.sub); bi++;
          }
        }
        cfg.bannerMotd = txt.join('\n').trim();
        continue;
      }
      if (['version', 'end', 'spanning-tree', 'boot-start-marker', 'boot-end-marker', 'license', 'ip cef', 'no ipv6 cef'].includes(k)) continue;
      if (k === 'service' && t[1] === 'password-encryption') { cfg.servicePwdEnc = true; continue; }
      if (k === 'no' && t[1] === 'service') { if (t[2] === 'password-encryption') cfg.servicePwdEnc = false; continue; }
      if (k === 'service') continue;
      if (k === 'hostname') { cfg.hostname = t.slice(1).join(' '); continue; }
      if (k === 'enable' && t[1] === 'secret') { cfg.enableSecret = t[2] === '5' ? t[3] : makeSecret(t.slice(2).join(' ')); continue; }
      if (k === 'enable' && t[1] === 'password') { cfg.enablePassword = readPw(t.slice(2)); continue; }
      if (k === 'username') {
        const name = t[1]; const pi = t.indexOf('password') >= 0 ? t.indexOf('password') : t.indexOf('secret');
        cfg.users.push({ name, raw: b.head, password: pi > 0 ? (t[pi] === 'secret' ? null : readPw(t.slice(pi + 1))) : '' });
        continue;
      }
      if (k === 'ip' && t[1] === 'domain-name') { cfg.domainName = t[2] || ''; continue; }
      if (k === 'ip' && t[1] === 'routing') { cfg.ipRouting = true; continue; }
      if (k === 'no' && t[1] === 'ip' && t[2] === 'routing') { cfg.ipRouting = false; continue; }
      if (k === 'ip' && t[1] === 'default-gateway') { cfg.defaultGateway = t[2] || ''; continue; }
      if (k === 'ip' && t[1] === 'classless') continue;
      if (k === 'ip' && t[1] === 'flow-export') continue;
      if (k === 'ip' && t[1] === 'route') {
        const r = { net: t[2], mask: t[3] };
        if (IP.valid(t[4])) r.nh = t[4]; else { r.iface = expandIf(t[4]) || t[4]; if (IP.valid(t[5])) r.nh = t[5]; }
        const ad = t.find((x, i) => i > 4 && /^\d+$/.test(x)); if (ad) r.ad = +ad;
        cfg.routes.push(r); continue;
      }
      if (k === 'ip' && t[1] === 'dhcp' && t[2] === 'excluded-address') { cfg.dhcpExcluded.push([t[3], t[4] || t[3]]); continue; }
      if (k === 'ip' && t[1] === 'dhcp' && t[2] === 'pool') {
        const pool = { name: t.slice(3).join(' '), network: '', mask: '', router: '', dns: '', domain: '' };
        for (const s of b.sub) {
          const u = s.split(/\s+/);
          if (u[0] === 'network') { pool.network = u[1]; pool.mask = u[2] || IP.classfulMask(u[1]); }
          else if (u[0] === 'default-router') pool.router = u[1];
          else if (u[0] === 'dns-server') pool.dns = u[1];
          else if (u[0] === 'domain-name') pool.domain = u[1];
        }
        cfg.dhcpPools.push(pool); continue;
      }
      if (k === 'vlan' && /^\d/.test(t[1] || '')) {
        for (const v of parseVlanList(t[1])) {
          cfg.vlans[v] = cfg.vlans[v] || ('VLAN' + String(v).padStart(4, '0'));
          const nm = b.sub.find(s => s.startsWith('name '));
          if (nm) cfg.vlans[v] = nm.slice(5).trim();
        }
        continue;
      }
      if (k === 'interface') {
        const name = expandIf(t.slice(1).join('')) || t.slice(1).join(' ');
        const p = ensurePort(dev, name);
        // výchozí stav dle typu (router fyzický port: shutdown, pokud není "no shutdown")
        if (isRouter && !p.virtual) p.shutdown = false;
        p.shutdown = false;
        p.extra = [];
        for (const s of b.sub) applyIfLine(dev, p, s, true);
        continue;
      }
      if (k === 'router') {
        if (t[1] === 'rip') {
          cfg.rip = { version: 1, networks: [], extra: [] };
          for (const s of b.sub) {
            const u = s.split(/\s+/);
            if (u[0] === 'version') cfg.rip.version = +u[1];
            else if (u[0] === 'network') cfg.rip.networks.push(u[1]);
            else cfg.rip.extra.push(s);
          }
        } else if (t[1] === 'ospf') {
          const o = { pid: +t[2] || 1, networks: [], extra: [], routerId: '' };
          for (const s of b.sub) {
            const u = s.split(/\s+/);
            if (u[0] === 'network') o.networks.push({ net: u[1], wild: u[2], area: u[4] || '0' });
            else if (u[0] === 'router-id') o.routerId = u[1];
            else o.extra.push(s);
          }
          cfg.ospf.push(o);
        } else if (t[1] === 'eigrp') {
          const e = { asn: +t[2] || 1, networks: [], extra: [] };
          for (const s of b.sub) {
            const u = s.split(/\s+/);
            if (u[0] === 'network') e.networks.push({ net: u[1], wild: u[2] || '' });
            else e.extra.push(s);
          }
          cfg.eigrp.push(e);
        } else cfg.extra.push(b.head, ...b.sub.map(s => ' ' + s));
        continue;
      }
      if (k === 'line') {
        const which = t[1] === 'con' ? 'con' : t[1] === 'vty' ? 'vty' : null;
        if (!which) { cfg.extra.push(b.head, ...b.sub.map(s => ' ' + s)); continue; }
        const L = cfg.lines[which];
        if (which === 'vty') { L.range = t.slice(2).join(' '); if (cfg.lines.vty2 === undefined && L._seen) { /* druhý blok vty */ } L._seen = true; }
        for (const s of b.sub) {
          const u = s.split(/\s+/);
          if (u[0] === 'password') L.password = readPw(u.slice(1));
          else if (u[0] === 'login' && !u[1]) L.login = true;
          else if (u[0] === 'login' && u[1] === 'local') L.login = 'local';
          else if (!L.extra.includes(s)) L.extra.push(s);
        }
        continue;
      }
      // neznámý globální blok – zachováme
      cfg.extra.push(b.head, ...b.sub.map(s => ' ' + s));
    }
    for (const L of Object.values(cfg.lines)) delete L._seen;
  }

  /** Jeden řádek v interface módu. fromImport = true -> neřešíme chyby. Vrací chybovou hlášku nebo ''. */
  function applyIfLine(dev, p, s, fromImport) {
    const u = s.trim().split(/\s+/);
    const neg = u[0] === 'no';
    const v = neg ? u.slice(1) : u;
    const k = v[0];
    if (k === 'shutdown') { p.shutdown = !neg; return ''; }
    if (k === 'description') { p.desc = neg ? '' : v.slice(1).join(' '); return ''; }
    if (k === 'ip' && v[1] === 'address') {
      if (neg) { p.ip = ''; p.mask = ''; p.dhcp = false; return ''; }
      if (v[2] === 'dhcp') { p.dhcp = true; p.ip = ''; return ''; }
      if (!IP.valid(v[2]) || !IP.maskValid(v[3] || '')) return '% Invalid input detected at \'^\' marker.';
      p.ip = v[2]; p.mask = v[3]; p.dhcp = false; return '';
    }
    if (k === 'ip' && v[1] === 'helper-address') { p.helper = neg ? '' : v[2]; return ''; }
    if (k === 'switchport') {
      if (!v[1]) { p.noSwitchport = neg; return ''; }
      if (v[1] === 'mode') { p.mode = neg ? 'dynamic' : (v[2] === 'access' ? 'access' : v[2] === 'trunk' ? 'trunk' : 'dynamic'); if (v[2] === 'dynamic') p.dynamicMode = v[3] || 'auto'; return ''; }
      if (v[1] === 'access' && v[2] === 'vlan') { p.vlan = neg ? 1 : (+v[3] || 1); if (!neg && dev.cfg && !dev.cfg.vlans[p.vlan]) dev.cfg.vlans[p.vlan] = 'VLAN' + String(p.vlan).padStart(4, '0'); return ''; }
      if (v[1] === 'trunk' && v[2] === 'native') { p.native = neg ? 1 : (+v[4] || 1); return ''; }
      if (v[1] === 'trunk' && v[2] === 'allowed') {
        if (neg) { p.allowed = 'all'; return ''; }
        const spec = v[4];
        if (spec === 'all') p.allowed = 'all';
        else if (spec === 'add') p.allowed = p.allowed === 'all' ? 'all' : [...new Set([...p.allowed, ...parseVlanList(v[5])])];
        else if (spec === 'remove') { const base = p.allowed === 'all' ? parseVlanList('1-4094') : p.allowed; const rm = new Set(parseVlanList(v[5])); p.allowed = base.filter(x => !rm.has(x)); }
        else if (spec === 'none') p.allowed = [];
        else if (spec === 'except') { const rm = new Set(parseVlanList(v[5])); p.allowed = parseVlanList('1-4094').filter(x => !rm.has(x)); }
        else p.allowed = parseVlanList(spec);
        return '';
      }
      p.extra.push(s.trim()); return '';
    }
    if (k === 'encapsulation' && /^dot1q$/i.test(v[1] || '')) { p.encap = neg ? null : (+v[2] || null); p.encapNative = v[3] === 'native'; return ''; }
    if (k === 'clock' && v[1] === 'rate') { p.clockRate = neg ? null : v[2]; return ''; }
    if (!neg || !p.extra.includes(v.join(' '))) {
      if (neg) p.extra = p.extra.filter(x => x !== v.join(' '));
      else if (!p.extra.includes(s.trim())) p.extra.push(s.trim());
    } else p.extra = p.extra.filter(x => x !== v.join(' '));
    return '';
  }

  /* ----------------------- generátor konfigu ----------------------- */
  function portSortKey(p) {
    const order = ['FastEthernet', 'GigabitEthernet', 'TenGigabitEthernet', 'Ethernet', 'Serial', 'Loopback', 'Tunnel', 'Port-channel', 'Vlan'];
    const t = ifType(p.name); const nums = (p.name.match(/\d+/g) || []).map(Number);
    return [order.indexOf(t) < 0 ? 50 : order.indexOf(t), ...nums];
  }
  function cmpKeys(a, b) { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; }

  function pwOut(cfg, pw) { return cfg.servicePwdEnc ? '7 ' + type7enc(pw) : pw; }

  function generateConfig(dev) {
    const c = dev.cfg, L = [];
    const isSw = dev.kind === 'switch' || dev.kind === 'l3switch';
    L.push('!', `version ${c.version || '15.1'}`, 'no service timestamps log datetime msec', 'no service timestamps debug datetime msec');
    L.push(c.servicePwdEnc ? 'service password-encryption' : 'no service password-encryption', '!', `hostname ${c.hostname}`, '!');
    if (c.enableSecret) L.push(`enable secret 5 ${c.enableSecret}`);
    if (c.enablePassword) L.push(`enable password ${pwOut(c, c.enablePassword)}`);
    if (c.enableSecret || c.enablePassword) L.push('!');
    for (const [a, b] of c.dhcpExcluded) L.push(`ip dhcp excluded-address ${a}${b && b !== a ? ' ' + b : ''}`);
    for (const p of c.dhcpPools) {
      L.push('!', `ip dhcp pool ${p.name}`);
      if (p.network) L.push(` network ${p.network} ${p.mask}`);
      if (p.router) L.push(` default-router ${p.router}`);
      if (p.dns) L.push(` dns-server ${p.dns}`);
      if (p.domain) L.push(` domain-name ${p.domain}`);
    }
    if (c.dhcpPools.length || c.dhcpExcluded.length) L.push('!');
    if (dev.kind === 'l3switch' && c.ipRouting) L.push('ip routing', '!');
    if (dev.kind === 'router') L.push('ip cef', 'no ipv6 cef', '!');
    for (const u of c.users) L.push(u.raw || `username ${u.name} password ${pwOut(c, u.password || '')}`);
    if (c.domainName) L.push(`ip domain-name ${c.domainName}`);
    if (isSw) L.push('!', 'spanning-tree mode pvst', 'spanning-tree extend system-id');
    if (isSw) {
      const vl = Object.keys(c.vlans).map(Number).filter(v => v !== 1 && !(v >= 1002 && v <= 1005)).sort((a, b) => a - b);
      for (const v of vl) { L.push('!', `vlan ${v}`); if (c.vlans[v] !== 'VLAN' + String(v).padStart(4, '0')) L.push(` name ${c.vlans[v]}`); }
    }
    const ports = dev.ports.filter(p => p.media !== 'other' || p.ip).slice().sort((a, b) => cmpKeys(portSortKey(a), portSortKey(b)));
    for (const p of ports) {
      if (p.hidden) continue;
      L.push('!', `interface ${p.name}`);
      if (p.desc) L.push(` description ${p.desc}`);
      const isSwPort = isSw && !p.virtual && !p.noSwitchport;
      if (isSw && !p.virtual && p.noSwitchport) L.push(' no switchport');
      if (p.encap) L.push(` encapsulation dot1Q ${p.encap}${p.encapNative ? ' native' : ''}`);
      if (isSwPort) {
        if (p.vlan && p.vlan !== 1) L.push(` switchport access vlan ${p.vlan}`);
        if (p.native && p.native !== 1) L.push(` switchport trunk native vlan ${p.native}`);
        if (p.allowed !== 'all') L.push(` switchport trunk allowed vlan ${p.allowed.length ? vlanListStr(p.allowed) : 'none'}`);
        if (p.mode === 'access') L.push(' switchport mode access');
        else if (p.mode === 'trunk') L.push(' switchport mode trunk');
        else if (p.dynamicMode === 'desirable') L.push(' switchport mode dynamic desirable');
      }
      for (const e of p.extra) L.push(' ' + e);
      if (!isSwPort) {
        if (p.dhcp) L.push(' ip address dhcp');
        else if (p.ip) L.push(` ip address ${p.ip} ${p.mask}`);
        else L.push(' no ip address');
        if (p.helper) L.push(` ip helper-address ${p.helper}`);
      }
      if (p.clockRate) L.push(` clock rate ${p.clockRate}`);
      if (p.shutdown) L.push(' shutdown');
    }
    if (c.rip) {
      L.push('!', 'router rip'); if (c.rip.version === 2) L.push(' version 2');
      for (const n of c.rip.networks) L.push(` network ${n}`); for (const e of c.rip.extra) L.push(' ' + e);
    }
    for (const o of c.ospf) {
      L.push('!', `router ospf ${o.pid}`); if (o.routerId) L.push(` router-id ${o.routerId}`);
      for (const e of o.extra) L.push(' ' + e);
      for (const n of o.networks) L.push(` network ${n.net} ${n.wild} area ${n.area}`);
    }
    for (const e of c.eigrp) {
      L.push('!', `router eigrp ${e.asn}`); for (const x of e.extra) L.push(' ' + x);
      for (const n of e.networks) L.push(` network ${n.net}${n.wild ? ' ' + n.wild : ''}`);
    }
    L.push('!');
    if (c.defaultGateway) L.push(`ip default-gateway ${c.defaultGateway}`);
    L.push('ip classless');
    for (const r of c.routes) L.push(`ip route ${r.net} ${r.mask} ${[r.iface, r.nh].filter(Boolean).join(' ')}${r.ad ? ' ' + r.ad : ''}`);
    L.push('!', 'ip flow-export version 9', '!');
    if (c.extra.length) { L.push(...c.extra, '!'); }
    if (c.bannerMotd) { L.push(`banner motd ^C${c.bannerMotd}^C`, '!'); }
    L.push('!', '!', '!', 'line con 0');
    pushLine(L, c, c.lines.con);
    if (dev.kind === 'router') L.push('!', 'line aux 0');
    L.push('!', `line vty ${c.lines.vty.range || '0 4'}`);
    pushLine(L, c, c.lines.vty);
    L.push('!', '!', '!', 'end');
    return L;
  }
  function pushLine(L, c, line) {
    if (line.password) L.push(` password ${pwOut(c, line.password)}`);
    if (line.login === 'local') L.push(' login local'); else if (line.login) L.push(' login');
    for (const e of line.extra) L.push(' ' + e);
  }

  const api = {
    IP, expandIf, shortIf, ifType, CATALOG, KIND_BY_PTTYPE, HOST_KINDS, IOS_KINDS, uid, randomMac, mediaOf, newPort,
    defaultCfg, createDevice, defaultServices, md5, md5crypt, makeSecret, checkSecret, type7enc, type7dec,
    parseVlanList, vlanListStr, findPort, ensurePort, applyConfigLines, applyIfLine, generateConfig, IF_TYPES
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NetModel = api;
})(typeof self !== 'undefined' ? self : this);
