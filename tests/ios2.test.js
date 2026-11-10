// node tests/ios2.test.js – ACL, NAT, STP, EtherChannel, port-security, SSH, login local
const NM = require('../js/netmodel.js'), { Sim } = require('../js/sim.js'), CLI = require('../js/cli.js');
let fail = 0;
const ok = (c, m, extra) => { console.log((c ? 'OK   ' : 'FAIL ') + m + (c || !extra ? '' : '\n' + extra)); if (!c) fail++; };
const project = { devices: [], links: [], notes: [] };
const names = new Set();
const add = (model, name) => { const d = NM.createDevice(model, 0, 0, names); d.name = name; if (d.cfg) d.cfg.hostname = name; names.add(name); project.devices.push(d); return d; };
const link = (a, pa, b, pb, cable) => { const l = { id: NM.uid('l'), a: { dev: a.id, port: pa }, b: { dev: b.id, port: pb }, cable: cable || 'straight' }; project.links.push(l); return l; };
const sim = new Sim(project);
const run = (d, cmds) => { const s = CLI.newIosSession(d, sim); let out = ''; for (const c of cmds) { const r = CLI.exec(s, c); out += CLI.prompt(s) + ' ' + c + '\n' + r.out + '\n'; } sim.touch(); return { s, out }; };
const pcRun = (d, cmd) => CLI.execPc(CLI.newPcSession(d, sim), cmd).out;
const setIp = (pc, ip, gw, mask) => { pc.ports[0].ip = ip; pc.ports[0].mask = mask || '255.255.255.0'; pc.gateway = gw; };

const R1 = add('2911', 'R1'), R2 = add('2911', 'ISP'), SW1 = add('2960-24TT', 'SW1'), SW2 = add('2960-24TT', 'SW2'), SW3 = add('2960-24TT', 'SW3');
const PC1 = add('PC-PT', 'PC1'), PC2 = add('PC-PT', 'PC2'), SRV = add('Server-PT', 'SRV');
link(PC1, 'FastEthernet0', SW1, 'FastEthernet0/1');
link(PC2, 'FastEthernet0', SW2, 'FastEthernet0/1');
link(SW1, 'GigabitEthernet0/1', R1, 'GigabitEthernet0/0');
link(R1, 'GigabitEthernet0/1', R2, 'GigabitEthernet0/0', 'cross');
link(R2, 'GigabitEthernet0/1', SRV, 'FastEthernet0', 'cross');
// trojúhelník switchů
link(SW1, 'FastEthernet0/10', SW2, 'FastEthernet0/10', 'cross');
link(SW2, 'FastEthernet0/11', SW3, 'FastEthernet0/11', 'cross');
link(SW3, 'FastEthernet0/12', SW1, 'FastEthernet0/12', 'cross');
setIp(PC1, '192.168.1.10', '192.168.1.1'); setIp(PC2, '192.168.1.11', '192.168.1.1'); setIp(SRV, '8.8.8.8', '8.8.8.1');
run(R1, ['en', 'conf t', 'int g0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shut', 'int g0/1', 'ip address 200.0.0.1 255.255.255.248', 'no shut', 'exit', 'ip route 0.0.0.0 0.0.0.0 200.0.0.2']);
run(R2, ['en', 'conf t', 'int g0/0', 'ip address 200.0.0.2 255.255.255.248', 'no shut', 'int g0/1', 'ip address 8.8.8.1 255.255.255.0', 'no shut']);

/* ---------- STP ---------- */
let out = pcRun(PC1, 'ping 192.168.1.11');
ok(/Received = 4/.test(out), 'ping přes smyčku switchů funguje', out);
const stpAll = [SW1, SW2, SW3].map(d => run(d, ['en', 'show spanning-tree vlan 1']).out).join('\n');
ok((stpAll.match(/Altn BLK/g) || []).length === 1, 'STP blokuje právě jeden port ve smyčce', stpAll);
ok((stpAll.match(/This bridge is the root/g) || []).length === 1, 'právě jeden root bridge');
run(SW3, ['en', 'conf t', 'spanning-tree vlan 1 root primary']);
out = run(SW3, ['en', 'show spanning-tree']).out;
ok(/This bridge is the root/.test(out) && /Priority\s+24577/.test(out), 'root primary -> SW3 je root (24577)', out);
ok(NM.generateConfig(SW3).includes('spanning-tree vlan 1 priority 24576'), 'priorita v running-config');
ok(/Received = 4/.test(pcRun(PC1, 'ping 192.168.1.11')), 'ping funguje i po změně rootu');

/* ---------- EtherChannel ---------- */
link(SW1, 'FastEthernet0/23', SW2, 'FastEthernet0/23', 'cross'); link(SW1, 'FastEthernet0/24', SW2, 'FastEthernet0/24', 'cross');
sim.touch();
const blkBefore = [SW1, SW2].map(d => run(d, ['en', 'sh spanning-tree']).out).join('').match(/Fa0\/2[34]\s+Altn BLK/g) || [];
ok(blkBefore.length >= 1, 'paralelní linky bez EtherChannelu: STP část blokuje (' + blkBefore.length + ')');
for (const d of [SW1, SW2]) run(d, ['en', 'conf t', 'int range fa0/23 - 24', 'channel-group 1 mode active', 'int port-channel 1', 'switchport mode trunk']);
out = run(SW1, ['en', 'show etherchannel summary']).out;
ok(/Po1\(SU\)\s+LACP\s+Fa0\/23\(P\) Fa0\/24\(P\)/.test(out), 'show etherchannel summary', out);
const st1 = sim.stp(1).state;
ok(st1.get(SW1.id + '|FastEthernet0/23') === st1.get(SW1.id + '|FastEthernet0/24'), 'členové kanálu mají stejný STP stav');
ok(NM.findPort(SW1, 'FastEthernet0/23').mode === 'trunk' && /interface Port-channel1\n switchport mode trunk/.test(NM.generateConfig(SW1).join('\n')), 'port-channel předá trunk členům');

/* ---------- NAT ---------- */
out = pcRun(PC1, 'ping 8.8.8.8');
ok(/Received = 0/.test(out), 'bez NAT se odpověď nevrátí (ISP nezná 192.168.1.0)', out);
run(R1, ['en', 'conf t', 'access-list 1 permit 192.168.1.0 0.0.0.255', 'ip nat inside source list 1 interface g0/1 overload', 'int g0/0', 'ip nat inside', 'int g0/1', 'ip nat outside']);
out = pcRun(PC1, 'ping 8.8.8.8');
ok(/Received = 4/.test(out), 'PAT (overload): ping do internetu', out);
out = run(R1, ['en', 'show ip nat translations']).out;
ok(/icmp 200\.0\.0\.1\s+192\.168\.1\.10\s+8\.8\.8\.8/.test(out), 'show ip nat translations', out);
run(R1, ['en', 'conf t', 'ip nat inside source static 192.168.1.11 200.0.0.5']);
out = pcRun(SRV, 'ping 200.0.0.5');
ok(/Received = 4/.test(out), 'statický NAT: server pingne vnitřní PC přes veřejnou adresu', out);
ok(/ip nat inside source static 192\.168\.1\.11 200\.0\.0\.5/.test(NM.generateConfig(R1).join('\n')) && / ip nat outside/.test(NM.generateConfig(R1).join('\n')), 'NAT v running-config');

/* ---------- ACL ---------- */
run(R1, ['en', 'conf t', 'access-list 100 deny icmp host 192.168.1.10 any', 'access-list 100 permit ip any any', 'int g0/0', 'ip access-group 100 in']);
out = pcRun(PC1, 'ping 8.8.8.8');
ok(/Destination host unreachable/.test(out) && /Received = 0/.test(out), 'ACL blokuje PC1', out);
ok(/Received = 4/.test(pcRun(PC2, 'ping 8.8.8.8')), 'ACL pustí PC2');
out = run(R1, ['en', 'show access-lists']).out;
ok(/Extended IP access list 100\n\s+10 deny icmp host 192\.168\.1\.10 any \(4 match/.test(out), 'show access-lists s počítadlem', out);
run(R1, ['en', 'conf t', 'ip access-list extended WEB', 'permit tcp any any eq 80', 'deny ip any any', 'exit', 'int g0/0', 'ip access-group WEB in']);
ok(!/access-group 100/.test(NM.generateConfig(R1).join('\n')) && /ip access-group WEB in/.test(NM.generateConfig(R1).join('\n')), 'nový access-group nahradí starý');
ok(/Received = 0/.test(pcRun(PC2, 'ping 8.8.8.8')), 'pojmenovaný ACL: jen TCP 80, ping neprojde');
run(R1, ['en', 'conf t', 'int g0/0', 'no ip access-group WEB in']);
ok(/Received = 4/.test(pcRun(PC2, 'ping 8.8.8.8')), 'po odebrání ACL ping projde');
// round-trip konfigurace
const copy = NM.createDevice('2911', 0, 0, new Set()); NM.applyConfigLines(copy, NM.generateConfig(R1));
ok(NM.generateConfig(copy).join('\n') === NM.generateConfig(R1).join('\n'), 'running-config jde načíst zpět beze změny');

/* ---------- SSH / login local ---------- */
out = run(R1, ['en', 'conf t', 'crypto key generate rsa']).out;
ok(/define a domain-name first/.test(out), 'crypto key vyžaduje domain-name', out);
const r = run(R1, ['en', 'conf t', 'ip domain-name skola.cz', 'crypto key generate rsa', '1024', 'username admin secret tajne', 'ip ssh version 2', 'line vty 0 4', 'transport input ssh', 'login local']);
ok(/Generating 1024 bit RSA keys/.test(r.out) && R1.cfg.rsaBits === 1024, 'vygenerování RSA klíče', r.out);
const pcs = CLI.newPcSession(PC2, sim);
out = CLI.execPc(pcs, 'telnet 192.168.1.1').out;
ok(/closed by foreign host/.test(out) && CLI.pcPrompt(pcs) === 'C:\\>', 'telnet je odmítnut (transport input ssh)', out);
CLI.execPc(pcs, 'ssh -l admin 192.168.1.1');
ok(CLI.pcPrompt(pcs) === 'Password: ', 'ssh se ptá na heslo');
CLI.execPc(pcs, 'spatne'); CLI.execPc(pcs, 'tajne');
ok(CLI.pcPrompt(pcs) === 'R1>', 'ssh přihlášení lokálním uživatelem', CLI.pcPrompt(pcs));
CLI.execPc(pcs, 'exit');
ok(CLI.pcPrompt(pcs) === 'C:\\>', 'odhlášení ze ssh');
run(SW1, ['en', 'conf t', 'username student password skola', 'line con 0', 'login local']);
const cs = CLI.newIosSession(SW1, sim);
ok(CLI.prompt(cs) === 'Username: ', 'konzole s login local chce jméno');
CLI.exec(cs, 'student'); CLI.exec(cs, 'skola');
ok(CLI.prompt(cs) === 'SW1>', 'přihlášení jménem a heslem na konzoli', CLI.prompt(cs));

/* ---------- port-security ---------- */
run(SW1, ['student', 'skola', 'en', 'conf t', 'int fa0/1', 'switchport mode access', 'switchport port-security', 'switchport port-security maximum 1', 'switchport port-security violation shutdown']);
ok(/Received = 4/.test(pcRun(PC1, 'ping 192.168.1.11')), 'port-security: první MAC projde');
PC1.ports[0].mac = '00AA.BBCC.DDEE'; sim.touch();
out = pcRun(PC1, 'ping 192.168.1.11');
ok(/Received = 0/.test(out), 'port-security: cizí MAC je zahozena', out);
out = run(SW1, ['student', 'skola', 'en', 'show port-security interface fa0/1', 'show ip int brief']).out;
ok(/Secure-shutdown/.test(out) && /Security Violation Count\s+: 1/.test(out) && /FastEthernet0\/1\s+unassigned\s+YES unset\s+err-disabled/.test(out), 'port je err-disabled', out);
run(SW1, ['student', 'skola', 'en', 'conf t', 'int fa0/1', 'shutdown', 'no shutdown']);
ok(/Received = 4/.test(pcRun(PC1, 'ping 192.168.1.11')), 'shutdown / no shutdown port obnoví');

process.exit(fail ? 1 : 0);
