/*
 * ptcrypto.js – čtení a zápis souborů Cisco Packet Tracer (.pkt / .pka)
 *
 * Formát (PT 6+):  obfuskace(1) -> Twofish/EAX -> obfuskace(3) -> [4B délka BE + zlib(XML)]
 * Formát (PT ≤5):  XOR obfuskace -> [4B délka BE + zlib(XML)]
 * Klíč/IV pro .pkt/.pka: 16× 0x89 / 16× 0x10.
 *
 * Modul je čistý JS bez závislostí; zlib (inflate/deflate) si dodá prostředí.
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /*  Twofish (pouze šifrování – EAX používá jen směr E_K)               */
  /* ------------------------------------------------------------------ */
  const T = [
    [[0x8,0x1,0x7,0xD,0x6,0xF,0x3,0x2,0x0,0xB,0x5,0x9,0xE,0xC,0xA,0x4],
     [0xE,0xC,0xB,0x8,0x1,0x2,0x3,0x5,0xF,0x4,0xA,0x6,0x7,0x0,0x9,0xD],
     [0xB,0xA,0x5,0xE,0x6,0xD,0x9,0x0,0xC,0x8,0xF,0x3,0x2,0x4,0x7,0x1],
     [0xD,0x7,0xF,0x4,0x1,0x2,0x6,0xE,0x9,0xB,0x3,0x0,0x8,0x5,0xC,0xA]],
    [[0x2,0x8,0xB,0xD,0xF,0x7,0x6,0xE,0x3,0x1,0x9,0x4,0x0,0xA,0xC,0x5],
     [0x1,0xE,0x2,0xB,0x4,0xC,0x3,0x7,0x6,0xD,0xA,0x5,0xF,0x9,0x0,0x8],
     [0x4,0xC,0x7,0x5,0x1,0x6,0x9,0xA,0x0,0xE,0xD,0x8,0x2,0xB,0x3,0xF],
     [0xB,0x9,0x5,0x1,0xC,0x3,0xD,0xE,0x6,0x4,0x7,0xF,0x2,0x0,0x8,0xA]]
  ];
  const ror4 = (x, n) => ((x >>> n) | (x << (4 - n))) & 0xF;
  function makeQ(t) {
    const q = new Uint8Array(256);
    for (let x = 0; x < 256; x++) {
      let a = x >>> 4, b = x & 15;
      let a1 = a ^ b, b1 = (a ^ ror4(b, 1) ^ ((8 * a) & 15));
      let a2 = t[0][a1], b2 = t[1][b1];
      let a3 = a2 ^ b2, b3 = (a2 ^ ror4(b2, 1) ^ ((8 * a2) & 15));
      let a4 = t[2][a3], b4 = t[3][b3];
      q[x] = (b4 << 4) | a4;
    }
    return q;
  }
  const Q0 = makeQ(T[0]), Q1 = makeQ(T[1]);

  function gfMul(a, b, poly) {
    let r = 0;
    while (b) { if (b & 1) r ^= a; a <<= 1; if (a & 0x100) a ^= poly; b >>>= 1; }
    return r;
  }
  const MDS = [[0x01,0xEF,0x5B,0x5B],[0x5B,0xEF,0xEF,0x01],[0xEF,0x5B,0x01,0xEF],[0xEF,0x01,0xEF,0x5B]];
  const RS  = [[0x01,0xA4,0x55,0x87,0x5A,0x58,0xDB,0x9E],[0xA4,0x56,0x82,0xF3,0x1E,0xC6,0x68,0xE5],
               [0x02,0xA1,0xFC,0xC1,0x47,0xAE,0x3D,0x19],[0xA4,0x55,0x87,0x5A,0x58,0xDB,0x9E,0x03]];
  // MDS sloupec j vynásobený bajtem b -> 32bit slovo (little-endian)
  const MDSCOL = [0,1,2,3].map(j => {
    const t = new Uint32Array(256);
    for (let b = 0; b < 256; b++)
      t[b] = (gfMul(MDS[0][j], b, 0x169) | (gfMul(MDS[1][j], b, 0x169) << 8) |
              (gfMul(MDS[2][j], b, 0x169) << 16) | (gfMul(MDS[3][j], b, 0x169) << 24)) >>> 0;
    return t;
  });
  const rol = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
  const ror = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
  const byteOf = (w, i) => (w >>> (8 * i)) & 0xFF;

  // h pro libovolné k (2..4); L = pole 32bit slov
  function qChain(x, j, L) {
    const k = L.length;
    let y = x;
    // pořadí q-boxů dle specifikace
    if (k === 4) y = ([Q1, Q0, Q0, Q1][j][y]) ^ byteOf(L[3], j);
    if (k >= 3) y = ([Q1, Q1, Q0, Q0][j][y]) ^ byteOf(L[2], j);
    const A = [[Q0, Q0, Q1], [Q1, Q0, Q0], [Q0, Q1, Q1], [Q1, Q1, Q0]][j];
    y = A[0][y] ^ byteOf(L[1], j);
    y = A[1][y] ^ byteOf(L[0], j);
    return A[2][y];
  }
  function h(X, L) {
    return (MDSCOL[0][qChain(byteOf(X, 0), 0, L)] ^ MDSCOL[1][qChain(byteOf(X, 1), 1, L)] ^
            MDSCOL[2][qChain(byteOf(X, 2), 2, L)] ^ MDSCOL[3][qChain(byteOf(X, 3), 3, L)]) >>> 0;
  }

  function Twofish(key) {
    const k = key.length / 8;
    const M = [];
    for (let i = 0; i < key.length / 4; i++)
      M.push((key[4*i] | (key[4*i+1] << 8) | (key[4*i+2] << 16) | (key[4*i+3] << 24)) >>> 0);
    const Me = [], Mo = [], S = [];
    for (let i = 0; i < k; i++) {
      Me.push(M[2*i]); Mo.push(M[2*i+1]);
      let s = 0;
      for (let r = 0; r < 4; r++) {
        let v = 0;
        for (let c = 0; c < 8; c++) v ^= gfMul(RS[r][c], key[8*i + c], 0x14D);
        s |= v << (8 * r);
      }
      S.unshift(s >>> 0); // S = (S_{k-1}, ..., S_0)
    }
    const K = new Uint32Array(40);
    const rho = 0x01010101;
    for (let i = 0; i < 20; i++) {
      const A = h(Math.imul(2*i, rho) >>> 0, Me);
      const B = rol(h(Math.imul(2*i+1, rho) >>> 0, Mo), 8);
      K[2*i] = (A + B) >>> 0;
      K[2*i+1] = rol((A + 2*B) >>> 0, 9);
    }
    // klíčově závislé S-boxy (g) předpočítané
    const SB = [0,1,2,3].map(j => {
      const t = new Uint32Array(256);
      for (let x = 0; x < 256; x++) t[x] = MDSCOL[j][qChain(x, j, S)];
      return t;
    });
    const [S0, S1, S2, S3] = SB;
    const g = X => (S0[X & 255] ^ S1[(X >>> 8) & 255] ^ S2[(X >>> 16) & 255] ^ S3[X >>> 24]) >>> 0;

    this.encryptBlock = function (inp, inOff, out, outOff) {
      let R0 = ((inp[inOff] | (inp[inOff+1] << 8) | (inp[inOff+2] << 16) | (inp[inOff+3] << 24)) ^ K[0]) >>> 0;
      let R1 = ((inp[inOff+4] | (inp[inOff+5] << 8) | (inp[inOff+6] << 16) | (inp[inOff+7] << 24)) ^ K[1]) >>> 0;
      let R2 = ((inp[inOff+8] | (inp[inOff+9] << 8) | (inp[inOff+10] << 16) | (inp[inOff+11] << 24)) ^ K[2]) >>> 0;
      let R3 = ((inp[inOff+12] | (inp[inOff+13] << 8) | (inp[inOff+14] << 16) | (inp[inOff+15] << 24)) ^ K[3]) >>> 0;
      for (let r = 0; r < 16; r++) {
        const T0 = g(R0), T1 = g(rol(R1, 8));
        const F0 = (T0 + T1 + K[2*r+8]) >>> 0;
        const F1 = (T0 + 2*T1 + K[2*r+9]) >>> 0;
        const n2 = ror((R2 ^ F0) >>> 0, 1);
        const n3 = (rol(R3, 1) ^ F1) >>> 0;
        R2 = R0; R3 = R1; R0 = n2; R1 = n3;
      }
      const C = [R2 ^ K[4], R3 ^ K[5], R0 ^ K[6], R1 ^ K[7]];
      for (let i = 0; i < 4; i++) {
        const w = C[i] >>> 0;
        out[outOff + 4*i] = w & 255; out[outOff + 4*i+1] = (w >>> 8) & 255;
        out[outOff + 4*i+2] = (w >>> 16) & 255; out[outOff + 4*i+3] = w >>> 24;
      }
    };
  }

  /* ------------------------------------------------------------------ */
  /*  EAX (CTR + OMAC/CMAC), tag 16 B                                    */
  /* ------------------------------------------------------------------ */
  function dbl(b) {
    const o = new Uint8Array(16);
    let carry = 0;
    for (let i = 15; i >= 0; i--) { const v = (b[i] << 1) | carry; o[i] = v & 255; carry = b[i] >>> 7; }
    if (b[0] & 0x80) o[15] ^= 0x87;
    return o;
  }
  function makeCmac(cipher) {
    const L = new Uint8Array(16); cipher.encryptBlock(new Uint8Array(16), 0, L, 0);
    const K1 = dbl(L), K2 = dbl(K1);
    // omac^t(M) = CMAC([t]_16 || M)
    return function omac(t, msg) {
      const total = 16 + msg.length;
      const nBlocks = Math.max(1, Math.ceil(total / 16));
      const lastFull = total % 16 === 0;
      const X = new Uint8Array(16), tmp = new Uint8Array(16);
      const byteAt = i => (i < 16 ? (i === 15 ? t : 0) : msg[i - 16]);
      for (let b = 0; b < nBlocks; b++) {
        const base = b * 16;
        if (b < nBlocks - 1) {
          if (base >= 16) { for (let i = 0; i < 16; i++) X[i] ^= msg[base - 16 + i]; }
          else { for (let i = 0; i < 16; i++) X[i] ^= byteAt(base + i); }
        } else {
          for (let i = 0; i < 16; i++) {
            const p = base + i;
            let v;
            if (p < total) v = byteAt(p); else v = (p === total ? 0x80 : 0);
            X[i] ^= v ^ (lastFull ? K1[i] : K2[i]);
          }
        }
        cipher.encryptBlock(X, 0, tmp, 0); X.set(tmp);
      }
      return X;
    };
  }
  function ctr(cipher, nonceBlock, data) {
    const out = new Uint8Array(data.length);
    const cnt = Uint8Array.from(nonceBlock), ks = new Uint8Array(16);
    for (let off = 0; off < data.length; off += 16) {
      cipher.encryptBlock(cnt, 0, ks, 0);
      const n = Math.min(16, data.length - off);
      for (let i = 0; i < n; i++) out[off + i] = data[off + i] ^ ks[i];
      for (let i = 15; i >= 0; i--) { cnt[i] = (cnt[i] + 1) & 255; if (cnt[i] !== 0) break; }
    }
    return out;
  }
  function eaxEncrypt(key, nonce, plain) {
    const c = new Twofish(key), omac = makeCmac(c);
    const N = omac(0, nonce), H = omac(1, new Uint8Array(0));
    const C = ctr(c, N, plain);
    const Cm = omac(2, C);
    const out = new Uint8Array(C.length + 16);
    out.set(C);
    for (let i = 0; i < 16; i++) out[C.length + i] = N[i] ^ H[i] ^ Cm[i];
    return out;
  }
  function eaxDecrypt(key, nonce, data) {
    if (data.length < 16) throw new Error('Data příliš krátká');
    const c = new Twofish(key), omac = makeCmac(c);
    const C = data.subarray(0, data.length - 16), tag = data.subarray(data.length - 16);
    const N = omac(0, nonce), H = omac(1, new Uint8Array(0)), Cm = omac(2, C);
    let ok = true;
    for (let i = 0; i < 16; i++) if ((N[i] ^ H[i] ^ Cm[i]) !== tag[i]) ok = false;
    return { plain: ctr(c, N, C), tagOk: ok };
  }

  /* ------------------------------------------------------------------ */
  /*  Packet Tracer obálka                                               */
  /* ------------------------------------------------------------------ */
  const PT_KEY = new Uint8Array(16).fill(0x89);
  const PT_IV  = new Uint8Array(16).fill(0x10);

  function unwrapNew(input) {
    const len = input.length;
    const p = new Uint8Array(len);
    for (let i = 0; i < len; i++) p[i] = input[len - 1 - i] ^ ((len - Math.imul(i, len)) & 0xFF);
    const { plain, tagOk } = eaxDecrypt(PT_KEY, PT_IV, p);
    const n = plain.length;
    for (let i = 0; i < n; i++) plain[i] ^= (n - i) & 0xFF;
    return { payload: plain, tagOk };
  }
  function unwrapOld(input) {
    const n = input.length, out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = input[i] ^ ((n - i) & 0xFF);
    return out;
  }
  function wrapNew(payload) {
    const n = payload.length, s3 = new Uint8Array(n);
    for (let i = 0; i < n; i++) s3[i] = payload[i] ^ ((n - i) & 0xFF);
    const enc = eaxEncrypt(PT_KEY, PT_IV, s3);
    const len = enc.length, out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[len - 1 - i] = enc[i] ^ ((len - Math.imul(i, len)) & 0xFF);
    return out;
  }
  // payload = 4B délka (BE) + zlib stream
  function looksLikeZlib(p) {
    if (p.length < 6) return false;
    const cmf = p[4], flg = p[5];
    return (cmf & 0x0F) === 8 && ((cmf << 8) | flg) % 31 === 0;
  }

  /**
   * Dešifruje .pkt/.pka. inflate(Uint8Array zlib) -> Promise<Uint8Array>
   * Vrací { xml, format: 'new'|'old', tagOk }
   */
  async function decode(bytes, inflate) {
    bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const tries = [];
    try { const r = unwrapNew(bytes); tries.push({ payload: r.payload, format: 'new', tagOk: r.tagOk }); } catch (e) { /* ignore */ }
    tries.push({ payload: unwrapOld(bytes), format: 'old', tagOk: null });
    // čisté XML (už dešifrovaný soubor)
    const head = new TextDecoder().decode(bytes.subarray(0, 64)).trim();
    if (head.startsWith('<?xml') || head.startsWith('<PACKETTRACER'))
      return { xml: new TextDecoder().decode(bytes), format: 'xml', tagOk: null };
    for (const t of tries.sort((a, b) => (b.tagOk === true) - (a.tagOk === true))) {
      if (!looksLikeZlib(t.payload)) continue;
      try {
        const raw = await inflate(t.payload.subarray(4));
        return { xml: new TextDecoder('utf-8').decode(raw), format: t.format, tagOk: t.tagOk };
      } catch (e) { /* další pokus */ }
    }
    throw new Error('Soubor se nepodařilo dešifrovat – nejde o platný .pkt/.pka soubor.');
  }

  /** Zašifruje XML do formátu PT 6+. deflate(Uint8Array) -> Promise<Uint8Array zlib> */
  async function encode(xml, deflate) {
    const raw = new TextEncoder().encode(xml);
    const z = await deflate(raw);
    const payload = new Uint8Array(z.length + 4);
    const n = raw.length;
    payload[0] = (n >>> 24) & 255; payload[1] = (n >>> 16) & 255; payload[2] = (n >>> 8) & 255; payload[3] = n & 255;
    payload.set(z, 4);
    return wrapNew(payload);
  }

  const api = { decode, encode, Twofish, eaxEncrypt, eaxDecrypt, _Q0: Q0, _Q1: Q1 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PTCrypto = api;
})(typeof self !== 'undefined' ? self : this);
