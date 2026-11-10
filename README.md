# Frame-Tracer

Webový simulátor sítí, který **otevírá a ukládá soubory Cisco Packet Traceru (.pkt / .pka)**.
Běží celý v prohlížeči, nic se nikam neposílá (kromě volitelné spolupráce přes Firebase).

## Spuštění
- dvojklik na **`Spustit Frame-Tracer.bat`** (spustí lokální server na http://localhost:8080 – potřebuje Node.js),
- nebo prostě otevři **`index.html`** v Chrome / Edge.

## Co umí
- **Otevře .pkt i .pka** (PT 5 – 9; dešifrování Twofish/EAX + zlib přímo v prohlížeči), včetně zadání aktivity.
- **Uloží zpět do .pkt/.pka** – upraví původní soubor, takže vše, co Frame-Tracer nezná, v něm zůstane.
  Nová zařízení se do .pkt uloží jen tehdy, když už v souboru je zařízení stejného modelu (experimentální).
- Vlastní formát projektu **.ntj** (uloží vše, i nové sítě postavené od nuly).
- Editor topologie: přetahování zařízení, automatický kabel (sám vybere typ i porty), kontrolky linek,
  výběr obdélníkem (Shift), zoom, poznámky, zpět/znovu.
- **Cisco IOS CLI** (zkratky, Tab, `?`): VLAN, access/trunk (včetně DTP auto), router-on-a-stick,
  SVI, statické trasy, **RIP / OSPF / EIGRP**, DHCP pooly, hesla (enable secret MD5, typ 7), banner,
  `show run / ip int br / vlan br / ip route / int trunk / mac address-table / arp / cdp nei`, `copy run start`, `reload`…
- **PC**: IP nastavení, DHCP, příkazový řádek (`ping`, `tracert`, `ipconfig`, `arp -a`, `telnet`), konzolový kabel.
- **Simulace**: ping s animací paketu, seznam PDU, režim Simulace s výpisem skoků.
- **Diagnostika**: duplicitní IP, špatná brána, nefunkční kabely (a proč), chybějící VLAN, nesoulad native VLAN…

## Zálohování
- Každá změna se **automaticky ukládá** do prohlížeče (IndexedDB) a po zavření/pádu se obnoví.
- **Historie verzí** (tlačítko *Zálohy*): snímek každých 5 min (nastavitelné), při otevření/uložení souboru
  a ručně; lze obnovit nebo stáhnout jako .ntj. Uchovává se posledních 60 verzí.
- **Záloha do složky** (Chrome/Edge): každý snímek se zapíše i jako .ntj do zvolené složky na disku
  (např. do OneDrive / Google Drive složky = záloha i mimo počítač).
- Při spolupráci se zálohy ukládají i **do cloudu** (posledních 25 v místnosti).

## Spolupráce přes Firebase
Projekt `nettracer-f274b` je už nastavený v `firebase-config.js`. Pro nový projekt:
1. https://console.firebase.google.com → **Add project** (stačí bezplatný plán Spark).
2. **Build → Firestore Database → Create database**, záložka **Rules** → vlož obsah `firestore.rules` → **Publish**.
3. **Authentication → Sign-in method** → zapni **Anonymous** (a volitelně **Google**).
4. **Project settings → Your apps → Web (`</>`)** → zkopíruj `firebaseConfig` do `firebase-config.js`.
5. Spusť přes **Spustit Frame-Tracer.bat** (přihlášení nefunguje z `file://`) → **Spolupráce → Vytvořit místnost**.
   Ostatní dají *Spolupráce → Připojit* a zadají kód místnosti.

(Funguje i Realtime Database – stačí do konfigurace přidat `databaseURL`.)
Na Firestore je zápis kurzoru omezený na 1× za 1,5 s a přesuny se posílají dávkově, aby se nevyčerpal
bezplatný limit (20 000 zápisů denně).

Synchronizuje se po jednotlivých zařízeních a kabelech, takže víc lidí může pracovat současně.
Vidíte navzájem kurzory, výběr, je tu chat a cloudové zálohy.
**Bezpečnost:** kdo zná kód místnosti (10 znaků), může ji číst i upravovat – kód sdílej jen se svým týmem.

Volitelně můžeš aplikaci nahrát na Firebase Hosting (`firebase deploy`, konfigurace je v `firebase.json`)
a sdílet ji odkazem `…/#room=KOD`.

## Testy
```
node tests/crypto.test.js soubor.pka   # šifrování .pkt/.pka
node tests/format.test.js soubor.pka   # import/export XML
node tests/sim.test.js                 # simulace + CLI (24 scénářů)
node tests/cowork.test.js              # synchronizace spolupráce (falešná databáze)
```
