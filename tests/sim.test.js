// node tests/sim.test.js [soubor.pka]
const fs = require('fs'), zlib = require('zlib');
const NM = require('../js/netmodel.js'), { Sim } = require('../js/sim.js'), CLI = require('../js/cli.js');
const PT = require('../js/ptcrypto.js'), F = require('../js/ptformat.js');
let fail = 0;
const ok = (c, m, extra) => { console.log((c ? 'OK   ' : 'FAIL ') + m + (c || !extra ? '' : '\n' + extra)); if (!c) fail++; };

const project = { devices: [], links: [], notes: [] };
const names = new Set();
const add = (model, name) => { const d = NM.createDevice(model, 0, 0, names); d.name = name; if (d.cfg) d.cfg.hostname = name; names.add(name); project.devices.push(d); return d; };
const link = (a, pa, b, pb, cable) => project.links.push({ id: NM.uid('l'), a: { dev: a.id, port: pa }, b: { dev: b.id, port: pb }, cable: cable || 'straight' });
const sim = new Sim(project);
const run = (d, cmds) => {
  const s = CLI.newIosSession(d, sim); let out = '';
  for (const c of cmds) { const r = CLI.exec(s, c); out += CLI.prompt(s) + ' ' + c + '\n' + r.out + '\n'; }
  return { s, out };
};
const pcRun = (d, cmd) => CLI.execPc(CLI.newPcSession(d, sim), cmd).out;

// Topologie: PC1(vlan10) PC2(vlan20) - SW1 - trunk - R1 (router on a stick) - serial - R2 - PC3 ; R2 -> OSPF
const R1 = add('2911', 'R1'), R2 = add('2911', 'R2'), SW1 = add('2960-24TT', 'SW1');
const PC1 = add('PC-PT', 'PC1'), PC2 = add('PC-PT', 'PC2'), PC3 = add('PC-PT', 'PC3'), PC4 = add('PC-PT', 'PC4');
link(PC1, 'FastEthernet0', SW1, 'FastEthernet0/1');
link(PC2, 'FastEthernet0', SW1, 'FastEthernet0/2');
link(PC4, 'FastEthernet0', SW1, 'FastEthernet0/3');
link(SW1, 'GigabitEthernet0/1', R1, 'GigabitEthernet0/0');
link(R1, 'Serial0/0/0', R2, 'Serial0/0/0', 'serial');
link(R2, 'GigabitEthernet0/0', PC3, 'FastEthernet0', 'cross');

const sw = run(SW1, ['en', 'conf t', 'vlan 10', 'name Studenti', 'vlan 20', 'exit', 'int range fa0/1', 'sw mo acc', 'sw acc vl 10', 'int fa0/2', 'switchport mode access', 'switchport access vlan 20',
  'int fa0/3', 'sw acc vl 10', 'int g0/1', 'switchport mode trunk', 'end', 'show vlan brief', 'sh int trunk']);
ok(/10\s+Studenti\s+active\s+Fa0\/1, Fa0\/3/.test(sw.out), 'VLAN 10 se jménem a porty', sw.out);

const r1 = run(R1, ['enable', 'configure terminal', 'hostname R1', 'interface g0/0', 'no shutdown', 'int g0/0.10', 'encapsulation dot1q 10', 'ip address 192.168.10.1 255.255.255.0',
  'int g0/0.20', 'encap dot1Q 20', 'ip add 192.168.20.1 255.255.255.0', 'int s0/0/0', 'ip address 10.0.0.1 255.255.255.252', 'clock rate 64000', 'no sh', 'exit',
  'router ospf 1', 'network 192.168.10.0 0.0.0.255 area 0', 'network 192.168.20.0 0.0.0.255 area 0', 'network 10.0.0.0 0.0.0.3 area 0', 'end',
  'ip dhcp pool X']);
ok(/% Invalid input|Invalid/.test(r1.out.split('\n').slice(-3).join('\n')), 'konfigurační příkaz v priv módu je odmítnut');
run(R2, ['en', 'conf t', 'int s0/0/0', 'ip address 10.0.0.2 255.255.255.252', 'no shut', 'int g0/0', 'ip address 172.16.0.1 255.255.0.0', 'no shut', 'exit',
  'router ospf 1', 'network 10.0.0.0 0.0.0.3 area 0', 'network 172.16.0.0 0.0.255.255 area 0', 'end']);

PC1.ports[0].ip = '192.168.10.10'; PC1.ports[0].mask = '255.255.255.0'; PC1.gateway = '192.168.10.1';
PC2.ports[0].ip = '192.168.20.10'; PC2.ports[0].mask = '255.255.255.0'; PC2.gateway = '192.168.20.1';
PC3.ports[0].ip = '172.16.0.10'; PC3.ports[0].mask = '255.255.0.0'; PC3.gateway = '172.16.0.1';
sim.touch();

ok(/Gig0\/1\s+on\s+802\.1q\s+trunking/.test(run(SW1, ['en', 'sh int trunk']).out), 'trunk aktivní (po zapnutí routeru)');
let out = pcRun(PC1, 'ping 192.168.10.1');
ok(/Received = 4/.test(out), 'PC1 -> brána (subinterface)', out);
out = pcRun(PC1, 'ping 192.168.20.10');
ok(/Received = 4/.test(out) && /TTL=127/.test(out), 'inter-VLAN routing PC1 -> PC2 (TTL 127)', out);
out = pcRun(PC1, 'ping 172.16.0.10');
ok(/Received = 4/.test(out) && /TTL=126/.test(out), 'OSPF přes sériovou linku PC1 -> PC3', out);
const rr = run(R2, ['show ip route']).out;
ok(/O\s+192\.168\.10\.0\/24 \[110\/65\] via 10\.0\.0\.1/.test(rr), 'R2 má OSPF trasu s cenou 65', rr);
out = pcRun(PC1, 'tracert 172.16.0.10');
ok(/192\.168\.10\.1[\s\S]*10\.0\.0\.2[\s\S]*172\.16\.0\.10/.test(out), 'tracert ukazuje skoky', out);

// Chyby: shutdown subinterface -> nedostupné
run(R1, ['en', 'conf t', 'int g0/0.20', 'shutdown', 'end']);
out = pcRun(PC1, 'ping 192.168.20.10');
ok(/Received = 0/.test(out), 'po shutdown subrozhraní ping selže', out);
run(R1, ['en', 'conf t', 'int g0/0.20', 'no shutdown', 'end']);

// Špatný kabel
const st = sim.linkState(project.links[5]);
ok(st.up, 'PC-router křížený kabel = up');
project.links[5].cable = 'straight'; sim.touch();
ok(!sim.linkState(project.links[5]).up, 'PC-router přímý kabel = down');
project.links[2].cable = 'cross'; sim.touch();
ok(!sim.linkState(project.links[2]).up, 'PC-switch křížený kabel = down'); project.links[2].cable = 'straight';
project.links[5].cable = 'cross'; sim.touch();

// DHCP na R1 pro VLAN 10
run(R1, ['en', 'conf t', 'ip dhcp excluded-address 192.168.10.1 192.168.10.10', 'ip dhcp pool V10', 'network 192.168.10.0 255.255.255.0', 'default-router 192.168.10.1', 'dns-server 8.8.8.8', 'end']);
out = pcRun(PC4, 'ipconfig /renew');
ok(/192\.168\.10\.11/.test(out) && /192\.168\.10\.1\b/.test(out), 'DHCP přidělí .11 (po vyloučení)', out);
ok(/192\.168\.10\.11/.test(run(R1, ['en', 'show ip dhcp binding']).out), 'show ip dhcp binding');

// enable secret + login
run(SW1, ['en', 'conf t', 'enable secret class', 'line con 0', 'password cisco', 'login', 'end']);
const s2 = CLI.newIosSession(SW1, sim);
ok(!!s2.pending, 'konzole chce heslo');
CLI.exec(s2, 'cisco'); CLI.exec(s2, 'enable'); CLI.exec(s2, 'class');
ok(CLI.prompt(s2) === 'SW1#', 'přihlášení + enable secret funguje');
const cfg = NM.generateConfig(SW1).join('\n');
ok(/enable secret 5 \$1\$/.test(cfg) && /line con 0\n password cisco\n login/.test(cfg), 'running-config obsahuje secret a line con', cfg);
// SVI + default gateway na switchi
run(SW1, ['cisco', 'en', 'class', 'conf t', 'int vlan 10', 'ip address 192.168.10.2 255.255.255.0', 'no shut', 'exit', 'ip default-gateway 192.168.10.1', 'end']);
out = pcRun(PC3, 'ping 192.168.10.2');
ok(/Received = 4/.test(out), 'ping na SVI switche přes 2 routery', out);
out = run(SW1, ['cisco', 'en', 'class', 'show ip int brief']).out;
ok(/Vlan10\s+192\.168\.10\.2\s+YES manual up\s+up/.test(out), 'show ip int brief', out);
out = run(SW1, ['cisco', 'en', 'class', 'sh mac address-table']).out;
ok(/DYNAMIC\s+Fa0\/1/.test(out), 'MAC tabulka se učí', out);
// RIP varianta
run(R1, ['en', 'conf t', 'no router ospf 1', 'router rip', 'version 2', 'network 192.168.10.0', 'network 192.168.20.0', 'network 10.0.0.0', 'end']);
run(R2, ['en', 'conf t', 'no router ospf 1', 'router rip', 'version 2', 'network 10.0.0.0', 'network 172.16.0.0', 'end']);
out = pcRun(PC2, 'ping 172.16.0.10');
ok(/Received = 4/.test(out), 'RIP v2 směrování', out);
ok(/R\s+172\.16\.0\.0\/16 \[120\/1\]/.test(run(R1, ['en', 'sh ip route']).out), 'RIP trasa v tabulce');
// telnet
run(R1, ['en', 'conf t', 'line vty 0 4', 'password tel', 'login', 'end']);
const pcs = CLI.newPcSession(PC1, sim);
CLI.execPc(pcs, 'telnet 192.168.10.1');
CLI.execPc(pcs, 'tel');
ok(CLI.pcPrompt(pcs) === 'R1>', 'telnet z PC na router', CLI.pcPrompt(pcs));
CLI.execPc(pcs, 'exit');
ok(CLI.pcPrompt(pcs) === 'C:\\>', 'exit z telnetu');

(async () => {
  for (const f of process.argv.slice(2)) {
    const { xml } = await PT.decode(fs.readFileSync(f), async b => zlib.inflateSync(b));
    const { project: p } = F.importXml(xml, 'x');
    const s = new Sim(p);
    const pcs = p.devices.filter(d => d.kind === 'pc' && d.ports[0].ip);
    console.log('     ' + f.split(/[\\/]/).pop() + ':');
    for (const a of pcs) for (const b of pcs) if (a !== b && a.ports[0].mask && b.ports[0].mask && NM.IP.sameNet(a.ports[0].ip, b.ports[0].ip, a.ports[0].mask)) {
      const r = s.ping(a, b.ports[0].ip);
      console.log(`       ${a.name} (${a.ports[0].ip}) -> ${b.name} (${b.ports[0].ip}): ${r.ok ? 'OK' : 'FAIL ' + r.reason}`);
    }
    for (const l of p.links) { const st = s.linkState(l); if (!st.up) console.log('       link down:', l.a.port, l.b.port, st.reason); }
  }
  process.exit(fail ? 1 : 0);
})();
