/*
 * cli.js – emulace Cisco IOS CLI a příkazového řádku PC.
 * exec(session, line) -> { out, anim:[výsledky ping pro animaci], changed }
 */
(function (root) {
  'use strict';
  const NM = (typeof module !== 'undefined' && module.exports) ? require('./netmodel.js') : root.NetModel;
  const { IP } = NM;

  const pad = (s, n) => { s = String(s); return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length); };
  const INVALID = "% Invalid input detected at '^' marker.";
  const INCOMPLETE = '% Incomplete command.';

  /** prefixová shoda klíčového slova (IOS zkratky) */
  const is = (tok, kw, min) => !!tok && tok.length >= (min || 1) && kw.startsWith(tok.toLowerCase());

  /* ============================== IOS ============================== */
  function newIosSession(dev, sim) {
    const s = { kind: 'ios', dev, sim, mode: 'user', ifs: [], history: [], pending: null, remote: null };
    const c = dev.cfg;
    let banner = '';
    if (c.bannerMotd) banner = c.bannerMotd + '\n\n';
    s.pending = loginPending(c.lines.con, 'con');
    s.greeting = banner + (s.pending ? 'User Access Verification\n\n' : '');
    return s;
  }

  function prompt(s) {
    if (s.remote) return prompt(s.remote);
    if (s.pending) return s.pending.type === 'user' ? 'Username: ' : s.pending.prompt !== undefined ? s.pending.prompt : (s.pending.type === 'confirm' ? '' : 'Password: ');
    const h = s.dev.cfg.hostname;
    switch (s.mode) {
      case 'user': return h + '>';
      case 'priv': return h + '#';
      case 'config': return h + '(config)#';
      case 'if': return h + (s.ifs.length > 1 ? '(config-if-range)#' : s.ifs[0] && s.ifs[0].includes('.') ? '(config-subif)#' : '(config-if)#');
      case 'line': return h + '(config-line)#';
      case 'vlan': return h + '(config-vlan)#';
      case 'router': return h + '(config-router)#';
      case 'dhcp': return h + '(dhcp-config)#';
      case 'acl': return h + (s.acl && s.acl.type === 'extended' ? '(config-ext-nacl)#' : '(config-std-nacl)#');
    }
    return h + '>';
  }

  function ifaceNames(dev, spec) {
    // "fa0/1 - 5, g0/1" -> seznam plných názvů
    const out = [];
    for (const part of spec.split(',')) {
      const m = part.trim().match(/^([A-Za-z-]+\s*[\d/]*?)(\d+)\s*(?:-\s*(\d+))?$/);
      if (!m) return null;
      const base = m[1].replace(/\s+/g, ''), a = +m[2], b = m[3] ? +m[3] : a;
      for (let i = a; i <= b; i++) {
        const n = NM.expandIf(base + i);
        if (!n) return null;
        out.push(n);
      }
    }
    return out;
  }

  function canConfigIf(dev, name) {
    const t = NM.ifType(name);
    if (!t) return false;
    if (t === 'Loopback' || t === 'Tunnel') return true;
    if (t === 'Port-channel') return dev.kind !== 'router';
    if (t === 'Vlan') return dev.kind !== 'router';
    const base = name.split('.')[0];
    const p = NM.findPort(dev, base);
    if (!p) return false;
    if (name.includes('.')) return dev.kind === 'router' || dev.kind === 'l3switch';
    return true;
  }

  function exec(s, raw) {
    if (s.remote) return execRemote(s, raw);
    const line = raw.replace(/\t/g, ' ');
    const res = { out: '', anim: [], changed: false };
    const o = t => { res.out += (res.out && !res.out.endsWith('\n') ? '\n' : '') + t; };
    if (s.pending) return handlePending(s, line, res);
    const trimmed = line.trim();
    if (!trimmed) return res;
    if (trimmed.endsWith('?')) { o(help(s, trimmed.slice(0, -1))); return res; }
    s.history.push(trimmed);
    let w = trimmed.split(/\s+/);
    // "do" z konfiguračních módů
    if (s.mode !== 'user' && s.mode !== 'priv' && is(w[0], 'do', 2)) {
      const saved = s.mode; s.mode = 'priv';
      const r = exec(s, w.slice(1).join(' '));
      if (s.mode === 'priv' || s.mode === 'user') s.mode = saved;
      return r;
    }
    try {
      switch (s.mode) {
        case 'user': case 'priv': execExec(s, w, o, res); break;
        case 'config': execConfig(s, w, o, res); break;
        case 'if': execIf(s, w, o, res); break;
        case 'line': execLine(s, w, o, res); break;
        case 'vlan': execVlan(s, w, o, res); break;
        case 'router': execRouter(s, w, o, res); break;
        case 'dhcp': execDhcp(s, w, o, res); break;
        case 'acl': execAcl(s, w, o, res); break;
      }
    } catch (e) { o('% Internal error: ' + e.message); }
    if (res.changed) s.sim.touch();
    return res;
  }

  function handlePending(s, line, res) {
    const p = s.pending, c = s.dev.cfg;
    if (p.type === 'login') {
      const L = c.lines[p.line];
      if (line === L.password) { s.pending = null; res.out = ''; }
      else if (++p.tries >= 3) { res.out = '% Bad passwords\n'; p.tries = 0; if (s.onExit) { s.pending = null; s.onExit(); res.out += '\n[Connection closed by foreign host]'; } }
      return res;
    }
    if (p.type === 'enable') {
      const ok = c.enableSecret ? NM.checkSecret(line, c.enableSecret) : line === c.enablePassword;
      if (ok) { s.pending = null; s.mode = 'priv'; }
      else if (++p.tries >= 3) { s.pending = null; res.out = '% Bad secrets\n'; }
      return res;
    }
    if (p.type === 'user') { s.pending = { type: 'userpw', name: line.trim(), line: p.line, tries: p.tries, ssh: false }; return res; }
    if (p.type === 'userpw') {
      const u = c.users.find(x => x.name === p.name);
      const ok = !!u && (u.secret ? NM.checkSecret(line, u.secret) : (u.password !== null && u.password !== '' && u.password === line));
      if (ok) { s.pending = null; if (u.privilege === 15) s.mode = 'priv'; return res; }
      const tries = p.tries + 1;
      if (tries >= 3) {
        s.pending = null; res.out = '% Login invalid\n';
        if (s.onExit) { s.onExit(); res.out += '\n[Connection closed by foreign host]'; } else s.pending = { type: 'user', line: p.line, tries: 0 };
        return res;
      }
      res.out = p.ssh ? '' : '% Login invalid\n';
      s.pending = p.ssh ? { type: 'userpw', name: p.name, line: p.line, tries, ssh: true } : { type: 'user', line: p.line, tries };
      return res;
    }
    if (p.type === 'rsa') { s.pending = null; res.out = p.then(+line.trim() || 512); res.changed = true; s.sim.touch(); return res; }
    if (p.type === 'confirm') {
      s.pending = null;
      if (!line.trim() || /^y/i.test(line.trim())) p.then(res); else res.out = '';
      return res;
    }
    s.pending = null;
    return res;
  }

  /* --------------------------- EXEC / privileged --------------------------- */
  function execExec(s, w, o, res) {
    const d = s.dev, c = d.cfg, priv = s.mode === 'priv';
    const k = w[0].toLowerCase();
    if (is(k, 'enable', 2) && !priv || (priv && k === 'enable')) {
      if (priv) return;
      if (c.enableSecret || c.enablePassword) { s.pending = { type: 'enable', tries: 0 }; return; }
      if (s.onExit) { o('% No password set.'); return; }
      s.mode = 'priv'; return;
    }
    if (is(k, 'disable', 4)) { s.mode = 'user'; return; }
    if (is(k, 'exit', 2) || is(k, 'logout', 4) || k === 'quit') {
      s.mode = 'user';
      if (s.onExit) { s.onExit(); return; }
      const c2 = c.lines.con;
      s.pending = loginPending(c2, 'con');
      o('\n' + d.name + ' con0 is now available\n\nPress RETURN to get started.\n');
      return;
    }
    if (is(k, 'ping', 2)) return doPing(s, w.slice(1), o, res);
    if (is(k, 'traceroute', 3) || k === 'trace') return doTrace(s, w.slice(1), o);
    if (is(k, 'show', 2)) return show(s, w.slice(1), o);
    if (!priv) {
      if (is(k, 'configure', 4)) { o(INVALID); return; }
      o(k.length < 2 ? '% Ambiguous command: "' + w.join(' ') + '"' : '% Unknown command or computer name, or unable to find computer address');
      return;
    }
    if (is(k, 'configure', 4)) {
      if (!w[1] || is(w[1], 'terminal')) { o('Enter configuration commands, one per line.  End with CNTL/Z.'); s.mode = 'config'; return; }
      o(INVALID); return;
    }
    if (is(k, 'copy', 3)) {
      if (w[1] && is(w[1], 'running-config') && w[2] && is(w[2], 'startup-config')) {
        s.pending = { type: 'confirm', then: r => { d.startup = NM.generateConfig(d); r.out = 'Building configuration...\n[OK]'; r.changed = true; } };
        o('Destination filename [startup-config]? '); return;
      }
      if (w[1] && is(w[1], 'startup-config') && w[2] && is(w[2], 'running-config')) {
        if (!d.startup) { o('%% Non-volatile configuration memory invalid or not present'); return; }
        NM.applyConfigLines(d, d.startup); res.changed = true; o(`${d.startup.length * 20} bytes copied in 0.416 secs`); return;
      }
      o(INVALID); return;
    }
    if (is(k, 'write', 2)) {
      if (!w[1] || is(w[1], 'memory')) { d.startup = NM.generateConfig(d); res.changed = true; o('Building configuration...\n[OK]'); return; }
      if (is(w[1], 'erase')) { d.startup = null; res.changed = true; o('Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]\n[OK]\nErase of nvram: complete'); return; }
      o(INVALID); return;
    }
    if (is(k, 'erase', 3)) { d.startup = null; res.changed = true; o('Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]\n[OK]\nErase of nvram: complete'); return; }
    if (is(k, 'reload', 3)) {
      s.pending = { type: 'confirm', then: r => {
        const startup = d.startup;
        const keepPorts = d.ports.map(p => ({ name: p.name, mac: p.mac, media: p.media, hidden: p.hidden, ptType: p.ptType }));
        d.cfg = NM.defaultCfg(d);
        d.ports = keepPorts.filter(p => p.media !== 'virtual' || p.name === 'Vlan1').map(p => NM.newPort(p.name, { mac: p.mac, media: p.media, hidden: p.hidden, ptType: p.ptType, shutdown: d.kind === 'router' || p.name === 'Vlan1' }));
        if (startup) NM.applyConfigLines(d, startup);
        s.sim.clearArp(d);
        s.mode = 'user';
        r.out = '\nSystem Bootstrap, Version 15.1(4)M4, RELEASE SOFTWARE (fc1)\n...\nPress RETURN to get started!';
        r.changed = true;
      } };
      o('Proceed with reload? [confirm]'); return;
    }
    if (is(k, 'clear', 3)) {
      if (w[1] && (is(w[1], 'arp-cache') || is(w[1], 'arp'))) { s.sim.clearArp(d); return; }
      if (w[1] && is(w[1], 'mac')) { s.sim.macTable(d).clear(); return; }
      o(INVALID); return;
    }
    if (is(k, 'telnet', 3)) { o('Trying ' + (w[1] || '') + ' ...'); connectRemote(s, w[1], 'telnet', null, o); return; }
    if (is(k, 'ssh', 2)) { const li = w.indexOf('-l'); connectRemote(s, w[w.length - 1], 'ssh', li > 0 ? w[li + 1] : null, o); return; }
    if (is(k, 'terminal', 4) || is(k, 'clock', 2) || is(k, 'debug', 3) || is(k, 'undebug', 3) || k === 'no') return;
    o(k.length < 2 ? '% Ambiguous command: "' + w.join(' ') + '"' : INVALID);
  }

  function pingTarget(s, w, o) {
    let dst = w[0];
    if (!dst) { o(INCOMPLETE); return null; }
    if (!IP.valid(dst)) {
      // jméno zařízení
      const t = s.sim.p.devices.find(x => (x.cfg ? x.cfg.hostname : x.name).toLowerCase() === dst.toLowerCase() || x.name.toLowerCase() === dst.toLowerCase());
      const ip = t && s.sim.l3Ifaces(t)[0];
      if (!ip) { o('% Unrecognized host or address, or protocol not running.'); return null; }
      dst = ip.ip;
    }
    return dst;
  }
  function doPing(s, w, o, res) {
    const dst = pingTarget(s, w, o); if (!dst) return;
    const ri = w.findIndex(x => is(x, 'repeat', 3));
    const count = ri > 0 ? Math.min(+w[ri + 1] || 5, 50) : 5;
    o(`Type escape sequence to abort.\nSending ${count}, 100-byte ICMP Echos to ${dst}, timeout is 2 seconds:`);
    let line = '', okN = 0, first = null;
    for (let i = 0; i < count; i++) {
      const r = s.sim.ping(s.dev, dst);
      if (i === 0) first = r;
      if (r.ok && i === 0 && r.arpMiss) { line += '.'; continue; }
      if (r.ok) { line += '!'; okN++; }
      else line += r.reason === 'unreachable' || r.reason === 'acl' ? 'U' : '.';
    }
    if (first) res.anim.push({ src: s.dev, dst, result: first });
    o(line);
    o(`Success rate is ${Math.round(okN * 100 / count)} percent (${okN}/${count})${okN ? ', round-trip min/avg/max = 0/1/4 ms' : ''}`);
  }
  function doTrace(s, w, o) {
    const dst = pingTarget(s, w, o); if (!dst) return;
    o(`Type escape sequence to abort.\nTracing the route to ${dst}\n`);
    const t = s.sim.traceroute(s.dev, dst);
    t.hops.forEach((h, i) => o(`  ${String(i + 1).padStart(2)}   ${h.ok ? h.ip + (h.unreachable ? ' !H' : '') + '     1 msec    0 msec    0 msec' : '*         *         *'}`));
  }

  /* ---------------------------------- SHOW ---------------------------------- */
  function show(s, w, o) {
    const d = s.dev, c = d.cfg, sim = s.sim;
    const a = (w[0] || '').toLowerCase(), b = (w[1] || '').toLowerCase();
    if (!a) { o(INCOMPLETE); return; }
    if (is(a, 'access-lists', 2)) return showAcl(s, o);
    if (is(a, 'spanning-tree', 2)) return showStp(s, w.slice(1), o);
    if (is(a, 'port-security', 2)) return showPsec(s, w.slice(1), o);
    if (is(a, 'etherchannel', 2)) return showEther(s, o);
    if (is(a, 'running-config', 3)) {
      if (s.mode === 'user') { o(INVALID); return; }
      const lines = NM.generateConfig(d);
      if (w[1] && is(w[1], 'interface')) {
        const n = NM.expandIf(w.slice(2).join(''));
        const i = lines.indexOf('interface ' + n);
        if (i < 0) { o(INVALID); return; }
        let j = i + 1; while (j < lines.length && lines[j].startsWith(' ')) j++;
        o('Building configuration...\n\nCurrent configuration : 100 bytes\n!\n' + lines.slice(i, j).join('\n') + '\nend'); return;
      }
      o('Building configuration...\n\nCurrent configuration : ' + lines.join('\n').length + ' bytes\n' + lines.join('\n')); return;
    }
    if (is(a, 'startup-config', 3)) {
      if (s.mode === 'user') { o(INVALID); return; }
      o(d.startup ? 'Using ' + d.startup.join('\n').length + ' bytes\n' + d.startup.join('\n') : 'startup-config is not present'); return;
    }
    if (is(a, 'version', 2)) {
      o(`Cisco IOS Software, ${d.model} Software, Version ${c.version || '15.1'}, RELEASE SOFTWARE (fc1)\nTechnical Support: http://www.cisco.com/techsupport\nCopyright (c) 1986-2026 by Cisco Systems, Inc.\n\nROM: System Bootstrap\n\n${c.hostname} uptime is 1 hours, 2 minutes\nSystem image file is "flash:${d.model}.bin"\n\ncisco ${d.model} processor with 491520K/32768K bytes of memory.\n${d.ports.filter(p => !p.virtual && !p.hidden).length} interfaces\nConfiguration register is 0x2102`);
      return;
    }
    if (is(a, 'history', 2)) { o(s.history.slice(-20).map(x => '  ' + x).join('\n')); return; }
    if (is(a, 'clock', 2)) { o('*' + new Date().toUTCString()); return; }
    if (a === 'ip' || is(a, 'ip', 2)) {
      if (is(b, 'interface', 3)) {
        if (w[2] && is(w[2], 'brief')) {
          o(pad('Interface', 23) + pad('IP-Address', 16) + 'OK? Method Status                Protocol');
          for (const p of sortedPorts(d)) {
            const st = sim.ifStatus(d, p);
            o(pad(p.name, 23) + pad(p.ip || 'unassigned', 16) + 'YES ' + pad(p.dhcp ? 'DHCP' : (p.ip ? 'manual' : 'unset'), 7) + pad(st.status, 22) + st.protocol);
          }
          return;
        }
        for (const p of sortedPorts(d)) {
          const st = sim.ifStatus(d, p);
          o(`${p.name} is ${st.status}, line protocol is ${st.protocol}`);
          o(p.ip ? `  Internet address is ${p.ip}/${IP.prefixLen(p.mask)}` : '  Internet protocol processing disabled');
        }
        return;
      }
      if (is(b, 'route', 2)) return showRoute(s, o);
      if (is(b, 'arp', 2)) return showArp(s, o);
      if (is(b, 'protocols', 2)) {
        if (c.rip) o(`Routing Protocol is "rip"\n  Sending updates every 30 seconds\n  Default version control: send version ${c.rip.version}, receive ${c.rip.version === 2 ? '2' : 'any version'}\n  Routing for Networks:\n${c.rip.networks.map(n => '\t' + n).join('\n')}\n  Distance: (default is 120)`);
        for (const x of c.ospf) o(`Routing Protocol is "ospf ${x.pid}"\n  Router ID ${x.routerId || routerId(s)}\n  Routing for Networks:\n${x.networks.map(n => `    ${n.net} ${n.wild} area ${n.area}`).join('\n')}\n  Distance: (default is 110)`);
        for (const x of c.eigrp) o(`Routing Protocol is "eigrp ${x.asn}"\n  Routing for Networks:\n${x.networks.map(n => `     ${n.net}${n.wild ? '/' + IP.prefixLen(IP.wildcardToMask(n.wild)) : ''}`).join('\n')}\n  Distance: internal 90 external 170`);
        return;
      }
      if (is(b, 'dhcp', 2)) {
        o('IP address       Client-ID/              Lease expiration        Type\n                 Hardware address');
        for (const [mac, ip] of sim.leasesOf(d)) o(pad(ip, 17) + pad(mac, 24) + pad('--', 24) + 'Automatic');
        return;
      }
      if (is(b, 'ospf', 2) && w[2] && is(w[2], 'neighbor')) {
        o('\nNeighbor ID     Pri   State           Dead Time   Address         Interface');
        for (const n of neighbors(s, 'ospf')) o(pad(n.rid, 16) + pad('1', 6) + pad('FULL/DR', 16) + pad('00:00:35', 12) + pad(n.ip, 16) + n.iface);
        return;
      }
      if (is(b, 'access-lists', 2)) return showAcl(s, o);
      if (is(b, 'nat', 2)) return showNat(s, o);
      if (is(b, 'ssh', 2)) { o(c.rsaBits ? 'SSH Enabled - version ' + (c.sshVersion === 2 ? '2.0' : '1.99') + '\nAuthentication timeout: 120 secs; Authentication retries: 3' : 'SSH Disabled - version 1.99\n%Please create RSA keys (of at least 768 bits size) to enable SSH v2.\nAuthentication timeout: 120 secs; Authentication retries: 3'); return; }
      o(INVALID); return;
    }
    if (is(a, 'arp', 2)) return showArp(s, o);
    if (is(a, 'vlan', 1)) {
      if (d.kind === 'router') { o(INVALID); return; }
      o('\nVLAN Name                             Status    Ports\n---- -------------------------------- --------- -------------------------------');
      const vl = Object.keys(c.vlans).map(Number).concat([1002, 1003, 1004, 1005]).filter((v, i, arr) => arr.indexOf(v) === i).sort((x, y) => x - y);
      const names = { 1002: 'fddi-default', 1003: 'token-ring-default', 1004: 'fddinet-default', 1005: 'trnet-default' };
      for (const v of vl) {
        const ports = d.ports.filter(p => sim.isSwitchPort(d, p) && !p.hidden && sim.effMode(d, p) === 'access' && (p.vlan || 1) === v).map(p => NM.shortIf(p.name));
        const chunks = []; for (let i = 0; i < ports.length; i += 4) chunks.push(ports.slice(i, i + 4).join(', '));
        o(pad(v, 5) + pad(c.vlans[v] || names[v], 33) + pad(names[v] && !c.vlans[v] ? 'active' : 'active', 10) + (chunks[0] || ''));
        for (const ch of chunks.slice(1)) o(' '.repeat(48) + ch);
      }
      return;
    }
    if (is(a, 'interfaces', 3)) {
      if (is(b, 'trunk', 2)) {
        const tr = d.ports.filter(p => sim.isSwitchPort(d, p) && sim.physUp(d, p) && sim.effMode(d, p) === 'trunk');
        if (!tr.length) return;
        o('Port        Mode         Encapsulation  Status        Native vlan');
        for (const p of tr) o(pad(NM.shortIf(p.name), 12) + pad(p.mode === 'trunk' ? 'on' : 'auto', 13) + pad('802.1q', 15) + pad('trunking', 14) + (p.native || 1));
        o('\nPort        Vlans allowed on trunk');
        for (const p of tr) o(pad(NM.shortIf(p.name), 12) + (p.allowed === 'all' ? '1-1005' : NM.vlanListStr(p.allowed) || 'none'));
        o('\nPort        Vlans allowed and active in management domain');
        for (const p of tr) o(pad(NM.shortIf(p.name), 12) + NM.vlanListStr(Object.keys(c.vlans).map(Number).filter(v => sim.allowed(p, v))));
        return;
      }
      if (is(b, 'status', 2)) {
        o('Port      Name               Status       Vlan       Duplex  Speed Type');
        for (const p of d.ports.filter(x => !x.virtual && !x.hidden)) {
          const st = sim.ifStatus(d, p);
          const vl = sim.isSwitchPort(d, p) ? (sim.effMode(d, p) === 'trunk' ? 'trunk' : String(p.vlan || 1)) : 'routed';
          o(pad(NM.shortIf(p.name), 10) + pad(p.desc.slice(0, 18), 19) + pad(st.up ? 'connected' : p.shutdown ? 'disabled' : 'notconnect', 13) + pad(vl, 11) + pad('auto', 8) + pad('auto', 6) + (/Gig/.test(p.name) ? '10/100/1000BaseTX' : '10/100BaseTX'));
        }
        return;
      }
      const list = b ? [NM.findPort(d, NM.expandIf(w.slice(1).join('')) || '')].filter(Boolean) : sortedPorts(d);
      if (!list.length) { o(INVALID); return; }
      for (const p of list) {
        const st = sim.ifStatus(d, p);
        o(`${p.name} is ${st.status}, line protocol is ${st.protocol}\n  Hardware is ${p.virtual ? 'CPU Interface' : 'Lance'}, address is ${p.mac.toLowerCase()} (bia ${p.mac.toLowerCase()})${p.desc ? '\n  Description: ' + p.desc : ''}${p.ip ? `\n  Internet address is ${p.ip}/${IP.prefixLen(p.mask)}` : ''}\n  MTU 1500 bytes, BW ${/Gig/.test(p.name) ? '1000000' : /Serial/.test(p.name) ? '1544' : '100000'} Kbit, DLY 100 usec,\n     reliability 255/255, txload 1/255, rxload 1/255\n  Encapsulation ${p.encap ? '802.1Q Virtual LAN, Vlan ID ' + p.encap : /Serial/.test(p.name) ? 'HDLC' : 'ARPA'}, loopback not set`);
      }
      return;
    }
    if (is(a, 'mac', 2) || is(a, 'mac-address-table', 4)) {
      if (d.kind === 'router') { o(INVALID); return; }
      o('          Mac Address Table\n-------------------------------------------\n\nVlan    Mac Address       Type        Ports\n----    -----------       --------    -----');
      const rows = [...sim.macTable(d).values()].sort((x, y) => x.vlan - y.vlan);
      for (const r of rows) o(`${pad('   ' + r.vlan, 8)}${pad(r.mac.toLowerCase(), 18)}${pad('DYNAMIC', 12)}${NM.shortIf(r.port)}`);
      return;
    }
    if (is(a, 'cdp', 2)) {
      o('Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge\n                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone\nDevice ID    Local Intrfce   Holdtme    Capability   Platform    Port ID');
      for (const p of d.ports) {
        const lk = sim.linkOf(d.id, p.name); if (!lk || !sim.physUp(d, p)) continue;
        const pd = sim.dev(lk.peer.dev); if (!pd || !pd.ios) continue;
        o(pad(pd.cfg.hostname, 13) + pad(NM.shortIf(p.name), 16) + pad('160', 11) + pad(pd.kind === 'router' ? 'R' : 'S', 13) + pad(pd.model, 12) + NM.shortIf(lk.peer.port));
      }
      return;
    }
    if (is(a, 'users', 2)) { o('    Line       User       Host(s)              Idle       Location\n*  0 con 0                idle                 00:00:00'); return; }
    if (is(a, 'flash', 2)) { o('System flash directory:\nFile  Length   Name/status\n  1   33591768 ' + d.model + '.bin\n[33591768 bytes used, 30424616 available, 64016384 total]'); return; }
    o(INVALID);
  }
  function routerId(s) {
    const ifs = s.sim.l3Ifaces(s.dev);
    const lo = ifs.filter(i => NM.ifType(i.name) === 'Loopback');
    const pool = lo.length ? lo : ifs;
    return pool.length ? pool.map(i => i.ip).sort((x, y) => IP.parse(y) - IP.parse(x))[0] : '0.0.0.0';
  }
  function neighbors(s, proto) {
    const out = [];
    for (const r of s.sim.routes(s.dev)) {
      if (!r.type.startsWith(proto === 'ospf' ? 'O' : 'R') || !r.nh) continue;
      if (out.some(x => x.ip === r.nh)) continue;
      const own = s.sim.p.devices.find(d => s.sim.owns(d, r.nh));
      out.push({ ip: r.nh, iface: r.iface, rid: own ? routerId({ sim: s.sim, dev: own }) : r.nh });
    }
    return out;
  }
  function sortedPorts(d) {
    return d.ports.filter(p => !p.hidden).slice().sort((a, b) => {
      const ka = NM.IF_TYPES.indexOf(NM.ifType(a.name)), kb = NM.IF_TYPES.indexOf(NM.ifType(b.name));
      const va = a.name.includes('Vlan') ? 99 : ka, vb = b.name.includes('Vlan') ? 99 : kb;
      if (va !== vb) return va - vb;
      const na = (a.name.match(/\d+/g) || []).map(Number), nb = (b.name.match(/\d+/g) || []).map(Number);
      for (let i = 0; i < Math.max(na.length, nb.length); i++) if ((na[i] || 0) !== (nb[i] || 0)) return (na[i] || 0) - (nb[i] || 0);
      return 0;
    });
  }
  function showRoute(s, o) {
    const d = s.dev, sim = s.sim;
    o('Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP\n       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area\n       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2\n       E1 - OSPF external type 1, E2 - OSPF external type 2, E - EGP\n       i - IS-IS, L1 - IS-IS level-1, L2 - IS-IS level-2, ia - IS-IS inter area\n       * - candidate default, U - per-user static route, o - ODR\n       P - periodic downloaded static route\n');
    if (!sim.canRoute(d)) {
      o(d.cfg.defaultGateway ? `Default gateway is ${d.cfg.defaultGateway}\n\nHost               Gateway           Last Use    Total Uses  Interface\nICMP redirect cache is empty` : 'Default gateway is not set\n\nHost               Gateway           Last Use    Total Uses  Interface\nICMP redirect cache is empty');
      return;
    }
    const rs = sim.routes(d);
    const def = rs.find(r => r.net === '0.0.0.0' && r.mask === '0.0.0.0');
    o(def ? `Gateway of last resort is ${def.nh || '0.0.0.0'} to network 0.0.0.0\n` : 'Gateway of last resort is not set\n');
    const sorted = rs.slice().sort((a, b) => (IP.parse(a.net) - IP.parse(b.net)) || (IP.prefixLen(a.mask) - IP.prefixLen(b.mask)));
    for (const r of sorted) {
      const pfx = `${r.net}/${IP.prefixLen(r.mask)}`;
      const code = pad(r.type, 8);
      if (r.type === 'C' || r.type === 'L') o(`${code}${pfx} is directly connected, ${r.iface}`);
      else if (r.nh && !r.iface) o(`${code}${pfx} [${r.ad}/${r.metric}] via ${r.nh}`);
      else if (r.nh) o(`${code}${pfx} [${r.ad}/${r.metric}] via ${r.nh}, 00:00:12, ${r.iface}`);
      else o(`${code}${pfx} is directly connected, ${r.iface}`);
    }
  }
  function showArp(s, o) {
    const d = s.dev, sim = s.sim;
    o('Protocol  Address          Age (min)  Hardware Addr   Type   Interface');
    for (const i of sim.l3Ifaces(d)) if (i.phys || i.svi) o(`Internet  ${pad(i.ip, 17)}${pad('-', 11)}${pad(i.mac.toLowerCase(), 16)}ARPA   ${i.name}`);
    for (const [ip, e] of sim.arpTable(d)) o(`Internet  ${pad(ip, 17)}${pad('0', 11)}${pad(e.mac.toLowerCase(), 16)}ARPA   ${e.iface}`);
  }

  /* --------------------------------- CONFIG --------------------------------- */
  function commonExit(s, w) {
    const k = w[0].toLowerCase();
    if (k === 'end' || k === '^z') { s.mode = 'priv'; s.ifs = []; return true; }
    if (is(k, 'exit', 3)) { s.mode = s.mode === 'config' ? 'priv' : 'config'; s.ifs = []; return true; }
    return false;
  }
  function execConfig(s, w, o, res) {
    if (commonExit(s, w)) return;
    const d = s.dev, c = d.cfg;
    let neg = false;
    if (w[0].toLowerCase() === 'no') { neg = true; w = w.slice(1); if (!w.length) { o(INCOMPLETE); return; } }
    const k = w[0].toLowerCase();
    res.changed = true;
    if (is(k, 'hostname', 3)) { if (!w[1] && !neg) { o(INCOMPLETE); return; } c.hostname = neg ? (d.kind === 'router' ? 'Router' : 'Switch') : w[1]; return; }
    if (is(k, 'enable', 2) && w[1]) {
      if (is(w[1], 'secret')) { if (neg) c.enableSecret = null; else { const pw = w[2] === '0' ? w[3] : w[2] === '5' ? null : w.slice(2).join(' '); if (w[2] === '5') c.enableSecret = w[3]; else if (pw) c.enableSecret = NM.makeSecret(pw); else { o(INCOMPLETE); return; } } return; }
      if (is(w[1], 'password')) { c.enablePassword = neg ? null : (w[2] === '0' ? w[3] : w[2] === '7' ? NM.type7dec(w[3]) : w.slice(2).join(' ')); return; }
      o(INVALID); return;
    }
    if (is(k, 'service', 3)) { if (w[1] && is(w[1], 'password-encryption')) c.servicePwdEnc = !neg; return; }
    if (is(k, 'banner', 2)) {
      if (neg) { c.bannerMotd = ''; return; }
      const rest = w.slice(2).join(' ');
      const delim = rest[0];
      const body = rest.slice(1);
      c.bannerMotd = body.includes(delim) ? body.slice(0, body.indexOf(delim)) : body;
      return;
    }
    if (is(k, 'interface', 3)) {
      if (!w[1]) { o(INCOMPLETE); return; }
      let names;
      if (is(w[1], 'range', 1) && w[1].length > 1 && w[1].toLowerCase() === 'range'.slice(0, w[1].length) && w[2]) names = ifaceNames(d, w.slice(2).join(' '));
      else { const n = NM.expandIf(w.slice(1).join('')); names = n ? [n] : null; }
      if (!names || !names.length || !names.every(n => canConfigIf(d, n))) { o(INVALID); return; }
      if (neg) { // no interface X (virtuální)
        for (const n of names) { const p = NM.findPort(d, n); if (p && p.virtual && n !== 'Vlan1') d.ports.splice(d.ports.indexOf(p), 1); }
        return;
      }
      for (const n of names) {
        if (!NM.findPort(d, n)) {
          const p = NM.ensurePort(d, n);
          p.shutdown = false;
          if (NM.ifType(n) === 'Vlan') { p.shutdown = false; if (!c.vlans[+n.slice(4)]) {/* SVI bez VLAN */} }
          if (n.includes('.')) p.virtual = true;
        }
      }
      // normalizuj velikost písmen na existující názvy
      s.ifs = names.map(n => NM.findPort(d, n).name);
      s.mode = 'if'; return;
    }
    if (is(k, 'vlan', 2)) {
      const ids = NM.parseVlanList(w[1] || '');
      if (!ids.length || d.kind === 'router') { o(INVALID); return; }
      if (neg) { for (const v of ids) if (v !== 1) delete c.vlans[v]; return; }
      for (const v of ids) if (!c.vlans[v]) c.vlans[v] = 'VLAN' + String(v).padStart(4, '0');
      s.vlans = ids; s.mode = 'vlan'; return;
    }
    if (is(k, 'ip', 2)) {
      const b = (w[1] || '').toLowerCase();
      if (is(b, 'access-list', 2)) {
        const ty = w[2] && is(w[2], 'standard', 1) ? 'standard' : w[2] && is(w[2], 'extended', 1) ? 'extended' : null;
        if (!ty || !w[3]) { o(INCOMPLETE); return; }
        if (neg) { c.acls = c.acls.filter(x => x.id !== w[3]); return; }
        s.acl = NM.aclEnsure(c, w[3], ty); s.mode = 'acl'; return;
      }
      if (is(b, 'nat', 2)) {
        if (d.kind !== 'router') { o(INVALID); return; }
        const KW = ['inside', 'outside', 'source', 'static', 'list', 'interface', 'pool', 'overload', 'netmask'];
        const tk = w.slice(2).map(x => KW.find(kw => x.length >= 2 && kw.startsWith(x.toLowerCase())) || x);
        if (!NM.natCommand(c, tk, neg)) o(INVALID);
        return;
      }
      if (is(b, 'ssh', 2)) { if (w[2] && is(w[2], 'version', 1)) c.sshVersion = neg ? 0 : (+w[3] || 2); return; }
      if (is(b, 'route', 3)) {
        if (!IP.valid(w[2]) || !IP.maskValid(w[3] || '')) { o(INVALID); return; }
        const r = { net: IP.str(IP.network(w[2], w[3])), mask: w[3] };
        if (IP.valid(w[4])) r.nh = w[4]; else if (w[4]) { const n = NM.expandIf(w[4]); if (!n || !NM.findPort(d, n)) { o(INVALID); return; } r.iface = n; if (IP.valid(w[5])) r.nh = w[5]; } else { o(INCOMPLETE); return; }
        const ad = w.slice(5).find(x => /^\d+$/.test(x)); if (ad) r.ad = +ad;
        const same = x => x.net === r.net && x.mask === r.mask && (x.nh || '') === (r.nh || '') && (x.iface || '') === (r.iface || '');
        c.routes = c.routes.filter(x => !same(x));
        if (!neg) c.routes.push(r);
        return;
      }
      if (is(b, 'default-gateway', 3)) { c.defaultGateway = neg ? '' : (IP.valid(w[2]) ? w[2] : (o(INVALID), c.defaultGateway)); return; }
      if (is(b, 'routing', 3)) { if (d.kind === 'switch') { o(INVALID); return; } c.ipRouting = !neg; return; }
      if (is(b, 'domain-name', 4)) { c.domainName = neg ? '' : (w[2] || ''); return; }
      if (is(b, 'dhcp', 2)) {
        if (w[2] && is(w[2], 'pool')) {
          const name = w.slice(3).join(' ');
          if (!name) { o(INCOMPLETE); return; }
          if (neg) { c.dhcpPools = c.dhcpPools.filter(p => p.name !== name); return; }
          let pool = c.dhcpPools.find(p => p.name === name);
          if (!pool) { pool = { name, network: '', mask: '', router: '', dns: '', domain: '' }; c.dhcpPools.push(pool); }
          s.pool = pool; s.mode = 'dhcp'; return;
        }
        if (w[2] && is(w[2], 'excluded-address')) {
          if (!IP.valid(w[3])) { o(INVALID); return; }
          const pair = [w[3], IP.valid(w[4]) ? w[4] : w[3]];
          c.dhcpExcluded = c.dhcpExcluded.filter(x => !(x[0] === pair[0] && x[1] === pair[1]));
          if (!neg) c.dhcpExcluded.push(pair);
          return;
        }
      }
      if (is(b, 'ssh', 2) || is(b, 'cef', 2) || is(b, 'classless', 2) || is(b, 'name-server', 2)) return;
      o(INVALID); return;
    }
    if (is(k, 'line', 2)) {
      const t = (w[1] || '').toLowerCase();
      if (is(t, 'console', 1)) { s.line = 'con'; s.mode = 'line'; return; }
      if (is(t, 'vty', 1)) { s.line = 'vty'; c.lines.vty.range = w.slice(2).join(' ') || '0 4'; s.mode = 'line'; return; }
      if (is(t, 'aux', 1)) { s.line = 'aux'; c.lines.aux = c.lines.aux || { password: '', login: false, extra: [] }; s.mode = 'line'; return; }
      o(INVALID); return;
    }
    if (is(k, 'router', 3)) {
      const t = (w[1] || '').toLowerCase();
      if (d.kind === 'switch') { o(INVALID); return; }
      if (is(t, 'rip', 1)) { if (neg) { c.rip = null; return; } c.rip = c.rip || { version: 1, networks: [], extra: [] }; s.router = { type: 'rip', ref: c.rip }; s.mode = 'router'; return; }
      if (is(t, 'ospf', 1)) {
        const pid = +w[2]; if (!pid) { o(INCOMPLETE); return; }
        if (neg) { c.ospf = c.ospf.filter(x => x.pid !== pid); return; }
        let x = c.ospf.find(z => z.pid === pid); if (!x) { x = { pid, networks: [], extra: [], routerId: '' }; c.ospf.push(x); }
        s.router = { type: 'ospf', ref: x }; s.mode = 'router'; return;
      }
      if (is(t, 'eigrp', 1)) {
        const asn = +w[2]; if (!asn) { o(INCOMPLETE); return; }
        if (neg) { c.eigrp = c.eigrp.filter(x => x.asn !== asn); return; }
        let x = c.eigrp.find(z => z.asn === asn); if (!x) { x = { asn, networks: [], extra: [] }; c.eigrp.push(x); }
        s.router = { type: 'eigrp', ref: x }; s.mode = 'router'; return;
      }
      o(INVALID); return;
    }
    if (is(k, 'username', 2)) {
      if (!w[1]) { o(INCOMPLETE); return; }
      c.users = c.users.filter(u => u.name !== w[1]);
      if (!neg) {
        const u = { name: w[1], password: '' };
        const pv = w.findIndex(x => /^priv/i.test(x)); if (pv > 1) u.privilege = +w[pv + 1];
        const pi = w.findIndex((x, i) => i > 1 && (/^pass/i.test(x) || /^sec/i.test(x)));
        if (pi > 0) {
          let val = w.slice(pi + 1); if (val[0] === '0' && val.length > 1) val = val.slice(1);
          if (/^sec/i.test(w[pi])) { u.password = null; u.secret = NM.makeSecret(val.join(' ')); } else u.password = val.join(' ');
        }
        u.raw = 'username ' + u.name + (u.privilege ? ' privilege ' + u.privilege : '') + (u.secret ? ' secret 5 ' + u.secret : u.password ? ' password 0 ' + u.password : '');
        c.users.push(u);
      }
      return;
    }
    if (is(k, 'access-list', 2)) {
      const id = w[1];
      if (!id || NM.aclTypeOf(id) === null) { o(INVALID); return; }
      if (neg) { c.acls = c.acls.filter(x => x.id !== id); return; }
      const e = NM.aclParse(NM.aclTypeOf(id), aclTokens(w.slice(2)));
      if (!e) { o(w.length < 4 ? INCOMPLETE : INVALID); return; }
      NM.aclEnsure(c, id).entries.push(e.text);
      return;
    }
    if (is(k, 'spanning-tree', 2)) {
      if (d.kind === 'router') { o(INVALID); return; }
      const a1 = (w[1] || '').toLowerCase();
      if (!a1) { o(INCOMPLETE); return; }
      if (is(a1, 'extend', 1)) return;
      if (is(a1, 'mode', 1)) { c.stpMode = neg ? 'pvst' : (w[2] && w[2].toLowerCase().startsWith('r') ? 'rapid-pvst' : 'pvst'); return; }
      if (is(a1, 'vlan', 1)) {
        const ids = NM.parseVlanList(w[2] || ''); const a3 = (w[3] || '').toLowerCase();
        if (!ids.length || !a3) { o(INCOMPLETE); return; }
        if (is(a3, 'priority', 1)) {
          if (neg) { for (const v of ids) delete c.stp[v]; return; }
          const n = +w[4];
          if (w[4] === undefined || isNaN(n) || n % 4096 || n > 61440) { o('% Bridge Priority must be in increments of 4096.\n% Allowed values are:\n  0     4096  8192  12288 16384 20480 24576 28672\n  32768 36864 40960 45056 49152 53248 57344 61440'); return; }
          for (const v of ids) c.stp[v] = n; return;
        }
        if (is(a3, 'root', 1)) { const pri = w[4] && w[4].toLowerCase().startsWith('s') ? 28672 : 24576; for (const v of ids) { if (neg) delete c.stp[v]; else c.stp[v] = pri; } return; }
        o(INVALID); return;
      }
      const txt = 'spanning-tree ' + w.slice(1).join(' ');
      c.extra = c.extra.filter(x => x !== txt); if (!neg) c.extra.push(txt);
      return;
    }
    if (is(k, 'crypto', 2)) {
      if (w[1] && is(w[1], 'key', 1) && w[2] && is(w[2], 'generate', 1) && w[3] && is(w[3], 'rsa', 1)) {
        if (/^(Router|Switch)$/.test(c.hostname)) { o('% Please define a hostname other than ' + c.hostname + '.'); res.changed = false; return; }
        if (!c.domainName) { o('% Please define a domain-name first.'); res.changed = false; return; }
        const fin = bits => { c.rsaBits = bits; return '% Generating ' + bits + ' bit RSA keys, keys will be non-exportable...[OK]'; };
        const mi = w.findIndex(x => /^mod/i.test(x));
        if (mi > 0 && +w[mi + 1]) { o(fin(+w[mi + 1])); return; }
        o('The name for the keys will be: ' + c.hostname + '.' + c.domainName + '\nChoose the size of the key modulus in the range of 360 to 4096 for your\n  General Purpose Keys. Choosing a key modulus greater than 512 may take\n  a few minutes.\n');
        s.pending = { type: 'rsa', prompt: 'How many bits in the modulus [512]: ', then: fin };
        return;
      }
      if (w[1] && is(w[1], 'key', 1) && w[2] && is(w[2], 'zeroize', 1)) { c.rsaBits = 0; return; }
      res.changed = false; o(INVALID); return;
    }
    if (is(k, 'spanning-tree', 2) || is(k, 'cdp', 2) || is(k, 'crypto', 2) || is(k, 'access-list', 2) || is(k, 'logging', 2) || is(k, 'clock', 2)) {
      // přijmeme, uložíme do extra
      const lineTxt = (neg ? 'no ' : '') + w.join(' ');
      if (/^(spanning-tree mode|spanning-tree extend)/.test(w.join(' '))) return;
      if (neg) c.extra = c.extra.filter(x => x !== w.join(' '));
      else if (!c.extra.includes(lineTxt)) c.extra.push(lineTxt);
      return;
    }
    res.changed = false;
    o(INVALID);
  }

  function execIf(s, w, o, res) {
    const d = s.dev;
    const k0 = w[0].toLowerCase();
    if (is(k0, 'interface', 3)) { s.mode = 'config'; return execConfig(s, w, o, res); }
    if (commonExit(s, w)) return;
    const neg = k0 === 'no';
    const v = neg ? w.slice(1) : w;
    if (!v.length) { o(INCOMPLETE); return; }
    const k = v[0].toLowerCase();
    // normalizace zkratek na plné příkazy
    let full = null;
    if (is(k, 'shutdown', 2)) full = 'shutdown';
    else if (is(k, 'description', 2)) full = 'description ' + v.slice(1).join(' ');
    else if (is(k, 'ip', 2) && v[1] && is(v[1], 'address', 2)) full = 'ip address ' + v.slice(2).join(' ');
    else if (is(k, 'ip', 2) && v[1] && is(v[1], 'helper-address', 2)) full = 'ip helper-address ' + (v[2] || '');
    else if (is(k, 'switchport', 2)) {
      const a = (v[1] || '').toLowerCase(), b = (v[2] || '').toLowerCase();
      if (!a) full = 'switchport';
      else if (is(a, 'mode', 2)) full = 'switchport mode ' + (is(b, 'access', 2) ? 'access' : is(b, 'trunk', 2) ? 'trunk' : is(b, 'dynamic', 2) ? 'dynamic ' + (v[3] && is(v[3], 'desirable') ? 'desirable' : 'auto') : '?');
      else if (is(a, 'access', 2) && is(b, 'vlan', 1)) full = 'switchport access vlan ' + (v[3] || '');
      else if (is(a, 'trunk', 2) && is(b, 'native', 2)) full = 'switchport trunk native vlan ' + (v[4] || '');
      else if (is(a, 'trunk', 2) && is(b, 'allowed', 2)) full = 'switchport trunk allowed vlan ' + v.slice(4).join(' ');
      else if (is(a, 'port-security', 5) || is(a, 'nonegotiate', 2) || is(a, 'voice', 2)) full = 'switchport ' + v.slice(1).join(' ');
      if (full && full.endsWith('?')) { o(INVALID); return; }
      if (d.kind === 'router') { o(INVALID); return; }
    }
    else if (is(k, 'encapsulation', 3)) { if (!v[1] || !/^dot1q$/i.test(v[1])) { o(INVALID); return; } full = 'encapsulation dot1Q ' + v.slice(2).join(' '); }
    else if (is(k, 'clock', 2)) full = 'clock rate ' + (v[2] || '');
    else if (is(k, 'speed', 2) || is(k, 'duplex', 2) || is(k, 'spanning-tree', 2) || is(k, 'cdp', 2) || is(k, 'bandwidth', 2) || is(k, 'ip', 2) && v[1] && (is(v[1], 'ospf', 2) || is(v[1], 'access-group', 2) || is(v[1], 'nat', 2)) || is(k, 'channel-group', 2) || is(k, 'standby', 3))
      full = v.join(' ');
    if (!full) { o(INVALID); return; }
    const norm = normalizeIf(full, neg);
    if (!norm) { o(INVALID); return; }
    full = norm.full;
    if (norm.chan && !neg) {
      if (d.kind === 'router') { o(INVALID); return; }
      const pc = 'Port-channel' + norm.chan;
      if (!NM.findPort(d, pc)) { const np = NM.ensurePort(d, pc); np.virtual = true; np.media = 'virtual'; o('Creating a port-channel interface Port-channel ' + norm.chan); }
    }
    if (full.startsWith('switchport access vlan')) {
      const vid = +v[3];
      if (!vid || vid > 4094) { o(INVALID); return; }
      if (!neg && !d.cfg.vlans[vid]) o(`% Access VLAN does not exist. Creating vlan ${vid}`);
    }
    if (full.startsWith('ip address') && !neg) {
      const ip = v[2], mask = v[3];
      if (ip !== 'dhcp') {
        if (!IP.valid(ip) || !IP.maskValid(mask || '')) { o(INVALID); return; }
        if (!IP.isHostAddr(ip, mask)) { o('Bad mask /' + IP.prefixLen(mask) + ' for address ' + ip); return; }
        // překryv s jiným rozhraním
        const clash = d.ports.find(p => !s.ifs.includes(p.name) && p.ip && (IP.inNet(ip, p.ip, p.mask) || IP.inNet(p.ip, ip, mask)));
        if (clash && d.kind !== 'switch') { o(`% ${IP.str(IP.network(ip, mask))} overlaps with ${clash.name}`); return; }
      }
    }
    res.changed = true;
    for (const n of s.ifs) {
      const p = NM.findPort(d, n);
      const before = p.shutdown;
      if (full === 'shutdown') { s.sim.rt.errdis.delete(d.id + '|' + p.name); if (neg) s.sim.rt.psec.delete(d.id + '|' + p.name); }
      if (norm.direct) {
        if (norm.replace) p.extra = p.extra.filter(x => !norm.replace.test(x));
        if (neg) p.extra = p.extra.filter(x => x !== full);
        else if (!p.extra.includes(full)) p.extra.push(full);
        continue;
      }
      if (/^Port-channel/.test(p.name) && /^switchport/.test(full)) {
        const grp = p.name.replace('Port-channel', '');
        for (const m of d.ports) if ((m.extra || []).some(x => x.startsWith('channel-group ' + grp + ' '))) NM.applyIfLine(d, m, (neg ? 'no ' : '') + full, false);
      }
      const err = NM.applyIfLine(d, p, (neg ? 'no ' : '') + full, false);
      if (err) { o(err); res.changed = false; return; }
      if (full === 'shutdown' && before !== p.shutdown) {
        s.sim.touch();
        const st = s.sim.ifStatus(d, p);
        o(`\n%LINK-5-CHANGED: Interface ${p.name}, changed state to ${p.shutdown ? 'administratively down' : st.up ? 'up' : 'down'}`);
        if (st.up) o(`\n%LINEPROTO-5-UPDOWN: Line protocol on Interface ${p.name}, changed state to up`);
      }
    }
  }

  function execLine(s, w, o, res) {
    if (commonExit(s, w)) return;
    const L = s.dev.cfg.lines[s.line];
    const neg = w[0].toLowerCase() === 'no';
    const v = neg ? w.slice(1) : w;
    const k = (v[0] || '').toLowerCase();
    res.changed = true;
    if (is(k, 'password', 3)) { L.password = neg ? '' : (v[1] === '7' ? NM.type7dec(v[2]) : v[1] === '0' ? v[2] : v.slice(1).join(' ')); if (!neg && !L.password) o(INCOMPLETE); return; }
    if (is(k, 'login', 3)) { L.login = neg ? false : (v[1] && is(v[1], 'local') ? 'local' : true); if (!neg && L.login === true && !L.password && s.line !== 'con') o('% Login disabled on line, until \'password\' is set'); return; }
    if (is(k, 'transport', 2)) {
      const dir = v[1] && is(v[1], 'output', 1) ? 'output' : 'input';
      const what = v.slice(2).map(x => ['ssh', 'telnet', 'all', 'none'].find(y => y.startsWith(x.toLowerCase()))).filter(Boolean);
      L.extra = L.extra.filter(x => !x.startsWith('transport ' + dir));
      if (!neg) { if (!what.length) { o(INCOMPLETE); return; } L.extra.push('transport ' + dir + ' ' + what.join(' ')); }
      return;
    }
    if (is(k, 'access-class', 2)) {
      L.extra = L.extra.filter(x => !x.startsWith('access-class '));
      if (!neg) { if (!v[1]) { o(INCOMPLETE); return; } L.extra.push('access-class ' + v[1] + ' ' + (v[2] && is(v[2], 'out', 1) ? 'out' : 'in')); }
      return;
    }
    if (is(k, 'exec-timeout', 2) || is(k, 'logging', 2) || is(k, 'transport', 2) || is(k, 'history', 2)) {
      const t = v.join(' ').replace(/^log\S*/, 'logging').replace(/^tran\S*/, 'transport').replace(/^exec-t\S*/, 'exec-timeout');
      L.extra = L.extra.filter(x => x.split(' ')[0] !== t.split(' ')[0]); if (!neg) L.extra.push(t); return;
    }
    res.changed = false; o(INVALID);
  }
  function execVlan(s, w, o, res) {
    const k0 = w[0].toLowerCase();
    if (is(k0, 'vlan', 2)) { s.mode = 'config'; return execConfig(s, w, o, res); }
    if (commonExit(s, w)) return;
    if (is(k0, 'name', 2)) { if (!w[1]) { o(INCOMPLETE); return; } for (const v of s.vlans) s.dev.cfg.vlans[v] = w[1]; res.changed = true; return; }
    if (k0 === 'no' && w[1] && is(w[1], 'name')) { for (const v of s.vlans) s.dev.cfg.vlans[v] = 'VLAN' + String(v).padStart(4, '0'); res.changed = true; return; }
    o(INVALID);
  }
  function execRouter(s, w, o, res) {
    if (commonExit(s, w)) return;
    const R = s.router.ref, t = s.router.type;
    const neg = w[0].toLowerCase() === 'no';
    const v = neg ? w.slice(1) : w;
    const k = (v[0] || '').toLowerCase();
    res.changed = true;
    if (is(k, 'network', 3)) {
      if (!IP.valid(v[1])) { o(INVALID); return; }
      if (t === 'rip') {
        const n = IP.str(IP.network(v[1], IP.classfulMask(v[1])));
        R.networks = R.networks.filter(x => x !== n); if (!neg) R.networks.push(n); return;
      }
      if (t === 'ospf') {
        if (!IP.valid(v[2]) || !v[3] || !is(v[3], 'area') || v[4] === undefined) { o(INCOMPLETE); return; }
        R.networks = R.networks.filter(x => !(x.net === v[1] && x.wild === v[2])); if (!neg) R.networks.push({ net: v[1], wild: v[2], area: v[4] }); return;
      }
      R.networks = R.networks.filter(x => x.net !== v[1]); if (!neg) R.networks.push({ net: v[1], wild: IP.valid(v[2]) ? v[2] : '' }); return;
    }
    if (t === 'rip' && is(k, 'version', 2)) { R.version = neg ? 1 : (+v[1] === 2 ? 2 : 1); return; }
    if (t === 'ospf' && is(k, 'router-id', 3)) { R.routerId = neg ? '' : v[1]; return; }
    const txt = v.join(' ')
      .replace(/^pass\S*/, 'passive-interface').replace(/^auto\S*/, 'auto-summary').replace(/^default-i\S*\s+o\S*/, 'default-information originate').replace(/^redis\S*/, 'redistribute');
    if (/^(passive-interface|auto-summary|default-information originate|redistribute|log-adjacency-changes|eigrp|metric)/.test(txt)) {
      const key = txt;
      R.extra = R.extra.filter(x => x !== key && x !== 'no ' + key);
      if (neg && key !== 'auto-summary') return;
      R.extra.push((neg ? 'no ' : '') + key); return;
    }
    res.changed = false; o(INVALID);
  }
  function execDhcp(s, w, o, res) {
    if (commonExit(s, w)) return;
    const P = s.pool; const k = w[0].toLowerCase();
    res.changed = true;
    if (is(k, 'network', 3)) { if (!IP.valid(w[1])) { o(INVALID); return; } P.network = w[1]; P.mask = IP.valid(w[2]) ? w[2] : IP.classfulMask(w[1]); return; }
    if (is(k, 'default-router', 3)) { P.router = w[1] || ''; return; }
    if (is(k, 'dns-server', 3)) { P.dns = w[1] || ''; return; }
    if (is(k, 'domain-name', 3)) { P.domain = w[1] || ''; return; }
    res.changed = false; o(INVALID);
  }

  /* ------------------------ přihlášení / vzdálený přístup ------------------------ */
  function loginPending(L, line) {
    if (L.login === 'local') return { type: 'user', line, tries: 0 };
    if (L.login && L.password) return { type: 'login', line, tries: 0 };
    return null;
  }
  function connectRemote(s, dst, kind, user, o) {
    const sim = s.sim;
    if (!IP.valid(dst || '')) { o('% Bad IP address or host name'); return; }
    const r = sim.ping(s.dev, dst, { proto: 'tcp', dport: kind === 'ssh' ? 22 : 23 });
    const target = r.ok && r.from;
    if (!target || !target.ios || !target.cfg) { o('\n% Connection timed out; remote host not responding'); return; }
    const vty = target.cfg.lines.vty;
    const ti = (vty.extra.find(x => x.startsWith('transport input')) || 'transport input all').split(' ').slice(2);
    const closed = '\n[Connection to ' + dst + ' closed by foreign host]';
    if (!(ti.includes('all') || ti.includes(kind)) || (kind === 'ssh' && !target.cfg.rsaBits)) { o(kind === 'ssh' ? '\n% Connection refused by remote host' : closed); return; }
    const ac = vty.extra.map(x => x.match(/^access-class (\S+) in$/)).find(Boolean);
    if (ac) { const acl = NM.aclFind(target.cfg, ac[1]); if (acl && acl.entries.length && NM.aclMatch(acl, { src: r.fwd.srcSeen, proto: 'ip' }).action !== 'permit') { o('\n% Connection refused by remote host'); return; } }
    const rs = newIosSession(target, sim);
    rs.onExit = () => { s.remote = null; };
    if (kind === 'ssh') {
      if (!user) { o('% Invalid usage: ssh -l uzivatel adresa'); return; }
      rs.pending = { type: 'userpw', name: user, line: 'vty', tries: 0, ssh: true };
    } else {
      rs.pending = loginPending(vty, 'vty');
      if (!rs.pending) { o(closed + '\n% Password required, but none set'); return; }
      o('Open' + (target.cfg.bannerMotd ? '\n' + target.cfg.bannerMotd + '\n' : '') + '\n\nUser Access Verification\n');
    }
    s.remote = rs;
  }

  /* --------------------------------- ACL mód --------------------------------- */
  function aclTokens(t) {
    t = t.slice();
    if (t[0]) { const a = t[0].toLowerCase(); t[0] = is(a, 'permit', 1) ? 'permit' : is(a, 'deny', 1) ? 'deny' : is(a, 'remark', 1) ? 'remark' : a; }
    return t;
  }
  function execAcl(s, w, o, res) {
    const k0 = w[0].toLowerCase();
    if (commonExit(s, w)) return;
    if (is(k0, 'ip', 2) || is(k0, 'interface', 3) || is(k0, 'access-list', 2) || is(k0, 'line', 2) || is(k0, 'router', 3)) { s.mode = 'config'; return execConfig(s, w, o, res); }
    const neg = k0 === 'no'; let t = neg ? w.slice(1) : w;
    if (/^\d+$/.test(t[0] || '')) t = t.slice(1);
    const e = NM.aclParse(s.acl.type, aclTokens(t));
    if (!e) { o(t.length < 2 ? INCOMPLETE : INVALID); return; }
    if (neg) s.acl.entries = s.acl.entries.filter(x => x !== e.text); else s.acl.entries.push(e.text);
    res.changed = true;
  }

  /* --------------------- normalizace příkazů v interface módu --------------------- */
  function normalizeIf(full, neg) {
    const t = full.split(/\s+/), k = t[0].toLowerCase();
    if (k === 'ip' && t[1] && is(t[1], 'access-group', 2)) {
      const dir = t[3] && is(t[3], 'in', 1) ? 'in' : t[3] && is(t[3], 'out', 1) ? 'out' : null;
      if (!t[2] || !dir) return neg && !t[2] ? { full: 'ip access-group', direct: true, replace: /^ip access-group / } : null;
      return { full: 'ip access-group ' + t[2] + ' ' + dir, direct: true, replace: new RegExp('^ip access-group \\S+ ' + dir + '$') };
    }
    if (k === 'ip' && t[1] && is(t[1], 'nat', 2)) {
      const r = t[2] && is(t[2], 'inside', 1) ? 'inside' : t[2] && is(t[2], 'outside', 1) ? 'outside' : null;
      return r ? { full: 'ip nat ' + r, direct: true, replace: /^ip nat (inside|outside)$/ } : null;
    }
    if (is(k, 'channel-group', 2) && k[0] === 'c' && k !== 'cdp') {
      if (neg) return { full: 'channel-group', direct: true, replace: /^channel-group / };
      const n = +t[1]; if (!n) return null;
      const m = t[3] ? ['on', 'active', 'passive', 'desirable', 'auto'].find(x => x.startsWith(t[3].toLowerCase())) : 'on';
      return m ? { full: 'channel-group ' + n + ' mode ' + m, direct: true, replace: /^channel-group /, chan: n } : null;
    }
    if (k === 'switchport' && t[1] && is(t[1], 'port-security', 5)) {
      const a = (t[2] || '').toLowerCase();
      if (!a) return { full: 'switchport port-security', direct: true };
      if (a.startsWith('mac')) {
        if (t[3] && is(t[3], 'sticky', 1)) return { full: 'switchport port-security mac-address sticky' + (t[4] ? ' ' + t[4].toUpperCase() : ''), direct: true };
        return /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i.test(t[3] || '') ? { full: 'switchport port-security mac-address ' + t[3].toUpperCase(), direct: true } : null;
      }
      if (is(a, 'maximum', 2)) return /^\d+$/.test(t[3] || '') || neg ? { full: 'switchport port-security maximum ' + (t[3] || ''), direct: true, replace: /^switchport port-security maximum / } : null;
      if (is(a, 'violation', 1)) { const m = ['shutdown', 'restrict', 'protect'].find(x => x.startsWith((t[3] || '~').toLowerCase())); return m || neg ? { full: 'switchport port-security violation ' + (m || ''), direct: true, replace: /^switchport port-security violation / } : null; }
      return null;
    }
    if (is(k, 'spanning-tree', 2) && k.startsWith('sp')) {
      const a = (t[1] || '').toLowerCase();
      if (a && is(a, 'portfast', 1)) return { full: 'spanning-tree portfast', direct: true };
      if (a && is(a, 'bpduguard', 1)) return { full: 'spanning-tree bpduguard enable', direct: true, replace: /^spanning-tree bpduguard/ };
      return { full: 'spanning-tree ' + t.slice(1).join(' '), direct: true };
    }
    return { full };
  }

  /* ------------------------------- další show ------------------------------- */
  function showAcl(s, o) {
    const d = s.dev;
    for (const a of d.cfg.acls) {
      o((a.type === 'extended' ? 'Extended' : 'Standard') + ' IP access list ' + a.id);
      const hits = s.sim.aclHits(d, a);
      a.entries.forEach((e, i) => o('    ' + (10 * (i + 1)) + ' ' + e + (hits[i] ? ' (' + hits[i] + ' match(es))' : '')));
    }
  }
  function showNat(s, o) {
    const d = s.dev, nat = d.cfg.nat;
    o('Pro  Inside global     Inside local       Outside local      Outside global');
    for (const t of s.sim.natTable(d)) o(pad(t.proto, 5) + pad(t.global, 18) + pad(t.local, 19) + pad(t.remote, 19) + t.remote);
    for (const x of nat.statics) o(pad('---', 5) + pad(x.global, 18) + pad(x.local, 19) + pad('---', 19) + '---');
  }
  function showStp(s, w, o) {
    const d = s.dev, sim = s.sim;
    if (d.kind === 'router') { o(INVALID); return; }
    let vl = Object.keys(d.cfg.vlans).map(Number).sort((x, y) => x - y);
    if (w[0] && is(w[0], 'vlan', 1) && w[1]) vl = vl.filter(v => v === +w[1]);
    if (!vl.length) { o('Spanning tree instance(s) for vlan ' + (w[1] || '') + ' does not exist.'); return; }
    for (const v of vl) {
      const st = sim.stp(v), inf = st.info.get(d.id);
      if (!inf) continue;
      const ports = d.ports.filter(q => sim.isSwitchPort(d, q) && sim.physUp(d, q) && sim.carriesVlan(d, q, v));
      if (!ports.length && vl.length > 1) continue;
      const isRoot = inf.root === d.id;
      o('VLAN' + String(v).padStart(4, '0') + '\n  Spanning tree enabled protocol ' + (d.cfg.stpMode === 'rapid-pvst' ? 'rstp' : 'ieee'));
      o('  Root ID    Priority    ' + inf.rootBid.pr + '\n             Address     ' + inf.rootBid.mac);
      if (isRoot) o('             This bridge is the root');
      else o('             Cost        ' + inf.cost + '\n             Port        ' + (d.ports.findIndex(q => q.name === inf.rootPort) + 1) + '(' + inf.rootPort + ')');
      o('             Hello Time  2 sec  Max Age 20 sec  Forward Delay 15 sec\n');
      o('  Bridge ID  Priority    ' + inf.bid.pr + '  (priority ' + inf.bid.base + ' sys-id-ext ' + v + ')\n             Address     ' + inf.bid.mac + '\n             Hello Time  2 sec  Max Age 20 sec  Forward Delay 15 sec\n             Aging Time  20\n');
      o('Interface        Role Sts Cost      Prio.Nbr Type\n---------------- ---- --- --------- -------- --------------------------------');
      for (const q of ports) {
        const role = st.state.get(d.id + '|' + q.name) || 'desg';
        o(pad(NM.shortIf(q.name), 17) + pad(role === 'root' ? 'Root' : role === 'altn' ? 'Altn' : 'Desg', 5) + pad(role === 'altn' ? 'BLK' : 'FWD', 4) + pad(inf.portCost(q), 10) + pad('128.' + (d.ports.indexOf(q) + 1), 9) + 'P2p');
      }
      o('');
    }
  }
  function psecInfo(s, q) {
    const ex = q.extra || [], st = s.sim.psecState(s.dev, q);
    const mx = ex.map(x => x.match(/^switchport port-security maximum (\d+)/)).find(Boolean);
    const mode = (ex.find(x => /^switchport port-security violation/.test(x)) || 'x shutdown').split(' ').pop();
    return { max: mx ? +mx[1] : 1, st, mode: mode[0].toUpperCase() + mode.slice(1), sticky: ex.filter(x => /mac-address sticky [0-9A-F]/.test(x)).length, err: s.sim.rt.errdis.has(s.dev.id + '|' + q.name) };
  }
  function showPsec(s, w, o) {
    const d = s.dev;
    if (d.kind === 'router') { o(INVALID); return; }
    if (w[0] && is(w[0], 'interface', 1)) {
      const q = NM.findPort(d, NM.expandIf(w.slice(1).join('')) || '');
      if (!q) { o(INVALID); return; }
      const on = (q.extra || []).includes('switchport port-security'), i = psecInfo(s, q);
      o('Port Security              : ' + (on ? 'Enabled' : 'Disabled') + '\nPort Status                : ' + (i.err ? 'Secure-shutdown' : s.sim.physUp(d, q) ? 'Secure-up' : 'Secure-down') +
        '\nViolation Mode             : ' + i.mode + '\nAging Time                 : 0 mins\nAging Type                 : Absolute\nSecureStatic Address Aging : Disabled\nMaximum MAC Addresses      : ' + i.max +
        '\nTotal MAC Addresses        : ' + i.st.macs.size + '\nConfigured MAC Addresses   : 0\nSticky MAC Addresses       : ' + i.sticky + '\nLast Source Address:Vlan   : ' + (i.st.last || '0000.0000.0000') + ':' + (q.vlan || 1) + '\nSecurity Violation Count   : ' + i.st.violations);
      return;
    }
    o('Secure Port MaxSecureAddr CurrentAddr SecurityViolation Security Action\n               (Count)       (Count)        (Count)\n--------------------------------------------------------------------');
    for (const q of d.ports) {
      if (!(q.extra || []).includes('switchport port-security')) continue;
      const i = psecInfo(s, q);
      o(pad('       ' + NM.shortIf(q.name), 20) + pad(i.max, 11) + pad(i.st.macs.size, 18) + pad(i.st.violations, 10) + i.mode);
    }
    o('----------------------------------------------------------------------');
  }
  function showEther(s, o) {
    const d = s.dev, groups = new Map();
    for (const q of d.ports) { const m = (q.extra || []).map(x => x.match(/^channel-group (\d+) mode (\S+)/)).find(Boolean); if (m) { if (!groups.has(m[1])) groups.set(m[1], { mode: m[2], ports: [] }); groups.get(m[1]).ports.push(q); } }
    o('Flags:  D - down        P - in port-channel\n        I - stand-alone s - suspended\n        H - Hot-standby (LACP only)\n        R - Layer3      S - Layer2\n        U - in use      f - failed to allocate aggregator\n        u - unsuitable for bundling\n        w - waiting to be aggregated\n        d - default port\n\n');
    o('Number of channel-groups in use: ' + groups.size + '\nNumber of aggregators:           ' + groups.size + '\n\nGroup  Port-channel  Protocol    Ports\n------+-------------+-----------+----------------------------------------------\n');
    for (const [g, x] of groups) {
      const up = x.ports.filter(q => s.sim.physUp(d, q));
      const proto = x.mode === 'active' || x.mode === 'passive' ? 'LACP' : x.mode === 'on' ? '-' : 'PAgP';
      o(pad(g, 7) + pad('Po' + g + '(S' + (up.length ? 'U' : 'D') + ')', 18) + pad(proto, 7) + x.ports.map(q => NM.shortIf(q.name) + '(' + (s.sim.physUp(d, q) ? 'P' : 'D') + ')').join(' '));
    }
  }

  /* ---------------------------------- nápověda ---------------------------------- */
  const HELP = {
    user: [['enable', 'Turn on privileged commands'], ['exit', 'Exit from the EXEC'], ['ping', 'Send echo messages'], ['show', 'Show running system information'], ['traceroute', 'Trace route to destination']],
    priv: [['clear', 'Reset functions'], ['configure', 'Enter configuration mode'], ['copy', 'Copy from one file to another'], ['disable', 'Turn off privileged commands'], ['erase', 'Erase a filesystem'], ['exit', 'Exit from the EXEC'], ['ping', 'Send echo messages'], ['reload', 'Halt and perform a cold restart'], ['show', 'Show running system information'], ['traceroute', 'Trace route to destination'], ['write', 'Write running configuration to memory']],
    config: [['banner', 'Define a login banner'], ['do', 'To run exec commands in config mode'], ['enable', 'Modify enable password parameters'], ['end', 'Exit from configure mode'], ['exit', 'Exit from configure mode'], ['hostname', 'Set system\'s network name'], ['interface', 'Select an interface to configure'], ['ip', 'Global IP configuration subcommands'], ['line', 'Configure a terminal line'], ['no', 'Negate a command or set its defaults'], ['router', 'Enable a routing process'], ['service', 'Modify use of network based services'], ['username', 'Establish User Name Authentication'], ['vlan', 'Vlan commands']],
    if: [['description', 'Interface specific description'], ['encapsulation', 'Set encapsulation type for an interface'], ['exit', 'Exit from interface configuration mode'], ['ip', 'Interface Internet Protocol config commands'], ['no', 'Negate a command or set its defaults'], ['shutdown', 'Shutdown the selected interface'], ['switchport', 'Set switching mode characteristics'], ['clock', 'Configure serial interface clock']],
    line: [['exit', 'Exit from line configuration mode'], ['login', 'Enable password checking'], ['password', 'Set a password'], ['logging', 'Modify message logging facilities'], ['exec-timeout', 'Set the EXEC timeout'], ['transport', 'Define transport protocols for line']],
    vlan: [['exit', 'Apply changes, bump revision number, and exit mode'], ['name', 'Ascii name of the VLAN']],
    router: [['network', 'Enable routing on an IP network'], ['version', 'Set routing protocol version'], ['passive-interface', 'Suppress routing updates on an interface'], ['default-information', 'Control distribution of default information'], ['router-id', 'router-id for this OSPF process'], ['exit', 'Exit from routing protocol configuration mode']],
    dhcp: [['default-router', 'Default routers'], ['dns-server', 'DNS servers'], ['domain-name', 'Domain name'], ['network', 'Network number and mask'], ['exit', 'Exit from DHCP pool configuration mode']]
  };
  const SHOW_HELP = [['arp', 'ARP table'], ['cdp', 'CDP information'], ['clock', 'Display the system clock'], ['interfaces', 'Interface status and configuration'], ['ip', 'IP information'], ['mac-address-table', 'MAC forwarding table'], ['running-config', 'Current operating configuration'], ['startup-config', 'Contents of startup configuration'], ['version', 'System hardware and software status'], ['vlan', 'VTP VLAN status']];
  function helpList(s, partial) {
    const w = partial.trim() ? partial.trim().split(/\s+/) : [];
    const trailing = /\s$/.test(partial) || !partial;
    const mode = s.mode;
    let list = HELP[mode] || [];
    if (w.length && (is(w[0], 'show', 2) || (is(w[0], 'do', 2) && w[1] && is(w[1], 'show', 2)))) {
      const idx = is(w[0], 'do', 2) ? 2 : 1;
      if (w.length === idx && trailing) return SHOW_HELP;
      if (w.length === idx + 1 && !trailing) return SHOW_HELP.filter(x => x[0].startsWith(w[idx].toLowerCase()));
      if (w.length >= idx + 1 && is(w[idx], 'ip', 2)) return [['interface', 'IP interface status and configuration'], ['route', 'IP routing table'], ['protocols', 'IP routing protocol process parameters'], ['dhcp', 'Show items in the DHCP database'], ['arp', 'IP ARP table']];
      return [];
    }
    if (!w.length) return list;
    if (w.length === 1 && !trailing) return list.filter(x => x[0].startsWith(w[0].toLowerCase()));
    return null;
  }
  function help(s, partial) {
    const l = helpList(s, partial);
    if (l === null) return '  <cr>';
    if (!l.length) return INVALID;
    if (partial && !/\s$/.test(partial) && partial.trim()) return l.map(x => x[0]).join('  ');
    return l.map(([k, d]) => '  ' + pad(k, 14) + d).join('\n');
  }
  function complete(s, partial) {
    const w = partial.split(/\s+/);
    const l = helpList(s, partial);
    if (!l || /\s$/.test(partial)) {
      // doplnění rozhraní
      const last = w[w.length - 1];
      if (w.length >= 2 && is(w[0], 'interface', 3) && last) { const n = NM.expandIf(last); if (n) return w.slice(0, -1).join(' ') + ' ' + n; }
      return partial;
    }
    const m = l.filter(x => x[0].startsWith(w[w.length - 1].toLowerCase()));
    if (m.length === 1) return w.slice(0, -1).concat(m[0][0]).join(' ') + ' ';
    return partial;
  }

  /* ================================ PC ================================ */
  function newPcSession(dev, sim) {
    return { kind: 'pc', dev, sim, history: [], remote: null, greeting: 'Cisco Packet Tracer PC Command Line 1.0\n' };
  }
  function pcPrompt(s) { if (s.remote) return prompt(s.remote); return 'C:\\>'; }
  function nic(dev) { return dev.ports.find(p => !p.hidden && /Ethernet|Wireless/.test(p.name)) || dev.ports[0]; }

  function execPc(s, raw) {
    if (s.remote) return execRemote(s, raw);
    const res = { out: '', anim: [], changed: false };
    const o = t => { res.out += (res.out && !res.out.endsWith('\n') ? '\n' : '') + t; };
    const line = raw.trim();
    if (!line) return res;
    s.history.push(line);
    const w = line.split(/\s+/), k = w[0].toLowerCase();
    const d = s.dev, sim = s.sim, p = nic(d);
    if (k === 'help' || k === '?') {
      o('Available Commands:\n?         Display the list of available commands\narp       Display the arp table\ncls       Clear screen\nexit      Quits the current session\nhelp      Display the list of available commands\nipconfig  Display network configuration\nping      Send echo messages\ntelnet    Telnet client\ntracert   Trace route to destination'); return res;
    }
    if (k === 'cls') { res.clear = true; return res; }
    if (k === 'ipconfig') {
      const a = (w[1] || '').toLowerCase();
      if (a === '/release') { p.ip = ''; p.mask = ''; d.gateway = ''; res.changed = true; o('\n   IP Address......................: 0.0.0.0\n   Subnet Mask.....................: 0.0.0.0\n   Default Gateway.................: 0.0.0.0\n   DNS Server......................: 0.0.0.0'); sim.touch(); return res; }
      if (a === '/renew') {
        p.dhcp = true;
        const r = sim.dhcp(d, p);
        if (r) { p.ip = r.ip; p.mask = r.mask; d.gateway = r.gw || ''; d.dns = r.dns || ''; res.changed = true; sim.touch(); }
        else { o('DHCP request failed. '); return res; }
      }
      const all = a === '/all';
      o(`\n${p.name} Connection:(default port)\n`);
      if (all) o(`   Connection-specific DNS Suffix..: \n   Physical Address................: ${p.mac}\n   DHCP Enabled....................: ${p.dhcp ? 'Yes' : 'No'}`);
      o(`   Link-local IPv6 Address.........: FE80::${p.mac.replace(/\./g, '').slice(4).replace(/(....)/g, '$1:').replace(/:$/, '')}\n   IPv6 Address....................: ::\n   IPv4 Address....................: ${p.ip || '0.0.0.0'}\n   Subnet Mask.....................: ${p.mask || '0.0.0.0'}\n   Default Gateway.................: ::\n                                     ${d.gateway || '0.0.0.0'}`);
      if (all) o(`   DNS Servers.....................: ${d.dns || '0.0.0.0'}`);
      return res;
    }
    if (k === 'ping') {
      const ni = w.findIndex(x => x === '-n');
      const count = ni > 0 ? Math.min(+w[ni + 1] || 4, 50) : 4;
      const dst = w.filter((x, i) => i > 0 && x[0] !== '-' && !(ni > 0 && i === ni + 1))[0];
      if (!dst) { o('Usage: ping [-n count] target'); return res; }
      if (!IP.valid(dst)) { o(`Ping request could not find host ${dst}. Please check the name and try again.`); return res; }
      o(`\nPinging ${dst} with 32 bytes of data:\n`);
      let okN = 0, first = null;
      for (let i = 0; i < count; i++) {
        const r = sim.ping(d, dst);
        if (i === 0) first = r;
        if (r.ok) { okN++; o(`Reply from ${dst}: bytes=32 time<1ms TTL=${r.ttl}`); }
        else if (r.reason === 'unreachable' || r.reason === 'acl') {
          o(`Reply from ${(r.fwd && r.fwd.atIp) || d.gateway}: Destination host unreachable.`);
        }
        else if (r.reason === 'ttl') o(`Reply from ${(sim.l3Ifaces(r.from)[0] || {}).ip}: TTL expired in transit.`);
        else o('Request timed out.');
      }
      if (first) res.anim.push({ src: d, dst, result: first });
      o(`\nPing statistics for ${dst}:\n    Packets: Sent = ${count}, Received = ${okN}, Lost = ${count - okN} (${Math.round((count - okN) * 100 / count)}% loss),`);
      if (okN) o('Approximate round trip times in milli-seconds:\n    Minimum = 0ms, Maximum = 0ms, Average = 0ms');
      return res;
    }
    if (k === 'tracert') {
      const dst = w[1];
      if (!IP.valid(dst)) { o('Usage: tracert target'); return res; }
      o(`\nTracing route to ${dst} over a maximum of 30 hops: \n`);
      const t = sim.traceroute(d, dst);
      t.hops.forEach((h, i) => o(`  ${i + 1}   ${h.ok ? '0 ms      0 ms      0 ms      ' + h.ip : '*         *         *         Request timed out.'}`));
      o('\nTrace complete.');
      return res;
    }
    if (k === 'arp') {
      if ((w[1] || '') === '-d') { sim.clearArp(d); return res; }
      const t = sim.arpTable(d);
      if (!t.size) { o('No ARP Entries Found'); return res; }
      o(`  Internet Address      Physical Address      Type`);
      for (const [ip, e] of t) o(`  ${pad(ip, 22)}${pad(e.mac.toLowerCase(), 22)}dynamic`);
      return res;
    }
    if (k === 'telnet') {
      const dst = w[w.length - 1];
      if (!IP.valid(dst)) { o('Usage: telnet target'); return res; }
      o('Trying ' + dst + ' ...');
      connectRemote(s, dst, 'telnet', null, o);
      return res;
    }
    if (k === 'ssh') {
      const li = w.indexOf('-l'), dst = w[w.length - 1];
      if (li < 0 || !w[li + 1] || !IP.valid(dst)) { o('Usage: SSH -l username target'); return res; }
      connectRemote(s, dst, 'ssh', w[li + 1], o);
      return res;
    }
    if (k === 'exit') return res;
    o('Invalid Command.');
    return res;
  }
  function execRemote(s, raw) { return exec(s.remote, raw); }

  const api = { newIosSession, prompt, exec, help, complete, newPcSession, pcPrompt, execPc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NetCLI = api;
})(typeof self !== 'undefined' ? self : this);
