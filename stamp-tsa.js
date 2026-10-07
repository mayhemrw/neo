// RFC 3161 timestamps for the Scribe's Log: building a request, reading a
// time-stamp authority's answer, and checking a token: that it's for the
// hash it claims, signed by the certificate it names, and that certificate
// chained to a root NEO trusts. No dependencies: a small DER reader is
// below, signatures go through WebCrypto (crypto.subtle, in Node, Electron
// and browsers alike), and the network through a `fetch` the caller passes.
// FreeTSA is the service NEO uses; any RFC 3161 service checks the same way.
//
// Not checked: revocation (CRLs and OCSP). A token's worth rests on the
// authority's key having been sound when it signed; NEO keeps each token's
// certificates so it can still be checked after they expire.

'use strict';

(function (exports) {
  const H = typeof require === 'function' ? require('./slog-hash.js') : globalThis.SlogHash;

  /* ---------------- DER ---------------- */

  // One element at `pos`: { tag (first byte), cls, cons, num, start, hlen,
  // len, cs (content start), end }
  function read(b, pos = 0, limit = b.length) {
    if (pos + 2 > limit) throw new Error('DER: ends too soon');
    const tag = b[pos];
    let i = pos + 1;
    let num = tag & 0x1f;
    if (num === 0x1f) {
      num = 0;
      for (let k = 0; ; k++) {
        if (i >= limit || k > 3) throw new Error('DER: bad tag');
        const c = b[i++];
        num = num * 128 + (c & 0x7f);
        if (!(c & 0x80)) break;
      }
    }
    if (i >= limit) throw new Error('DER: ends too soon');
    let len = b[i++];
    if (len === 0x80) throw new Error('DER: indefinite length');
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n > 4 || i + n > limit) throw new Error('DER: bad length');
      len = 0;
      for (let k = 0; k < n; k++) len = len * 256 + b[i++];
    }
    if (i + len > limit) throw new Error('DER: element runs past its container');
    return { tag, cls: tag >> 6, cons: !!(tag & 0x20), num, start: pos, hlen: i - pos, len, cs: i, end: i + len };
  }
  function kids(b, el) {
    const out = [];
    for (let p = el.cs; p < el.end;) { const k = read(b, p, el.end); out.push(k); p = k.end; }
    return out;
  }
  const raw = (b, el) => b.slice(el.start, el.end);
  const body = (b, el) => b.slice(el.cs, el.end);
  function expect(el, tag, what) {
    if (el.tag !== tag) throw new Error(`${what}: expected tag 0x${tag.toString(16)}, found 0x${el.tag.toString(16)}`);
    return el;
  }
  function oid(b, el) {
    expect(el, 0x06, 'OID');
    const parts = [];
    let v = 0;
    for (let i = el.cs; i < el.end; i++) {
      v = v * 128 + (b[i] & 0x7f);
      if (!(b[i] & 0x80)) {
        if (!parts.length) parts.push(v < 80 ? Math.floor(v / 40) : 2, v < 80 ? v % 40 : v - 80);
        else parts.push(v);
        v = 0;
      }
    }
    return parts.join('.');
  }
  function int(b, el) {
    expect(el, 0x02, 'INTEGER');
    let v = 0;
    for (let i = el.cs; i < el.end; i++) v = v * 256 + b[i];
    if (el.len && b[el.cs] & 0x80) v -= Math.pow(256, el.len);
    return v;
  }
  function time(b, el) {
    const s = String.fromCharCode(...body(b, el));
    let m;
    if (el.tag === 0x17 && (m = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(s))) {
      const y = +m[1] < 50 ? 2000 + +m[1] : 1900 + +m[1];
      return Date.UTC(y, m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    }
    if (el.tag === 0x18 && (m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(?:\.(\d+))?Z$/.exec(s))) {
      const ms = m[7] ? Math.floor(+('0.' + m[7]) * 1000) : 0;
      return Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
    }
    throw new Error('DER: a time it can\'t read: ' + s);
  }
  function algId(b, el) {
    const k = kids(b, expect(el, 0x30, 'AlgorithmIdentifier'));
    return { oid: oid(b, k[0]), params: k[1] ? raw(b, k[1]) : null, paramEl: k[1] || null };
  }

  // writing, only what a request needs
  function lenBytes(n) {
    if (n < 0x80) return [n];
    const out = [];
    while (n) { out.unshift(n & 0xff); n = Math.floor(n / 256); }
    return [0x80 | out.length, ...out];
  }
  function tlv(tag, content) {
    return H.concat(Uint8Array.from([tag, ...lenBytes(content.length)]), content);
  }
  function oidBytes(dotted) {
    const p = dotted.split('.').map(Number);
    const out = [40 * p[0] + p[1]];
    for (const v of p.slice(2)) {
      const enc = [v & 0x7f];
      for (let x = Math.floor(v / 128); x; x = Math.floor(x / 128)) enc.unshift((x & 0x7f) | 0x80);
      out.push(...enc);
    }
    return tlv(0x06, Uint8Array.from(out));
  }
  function uintBytes(bytes) {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    const v = bytes.slice(i);
    return tlv(0x02, v[0] & 0x80 ? H.concat(Uint8Array.of(0), v) : v);
  }

  /* ---------------- names and numbers ---------------- */

  const OID = {
    sha1: '1.3.14.3.2.26', sha256: '2.16.840.1.101.3.4.2.1', sha384: '2.16.840.1.101.3.4.2.2', sha512: '2.16.840.1.101.3.4.2.3',
    rsa: '1.2.840.113549.1.1.1', rsaSha1: '1.2.840.113549.1.1.5', rsaSha256: '1.2.840.113549.1.1.11', rsaSha384: '1.2.840.113549.1.1.12', rsaSha512: '1.2.840.113549.1.1.13',
    ec: '1.2.840.10045.2.1', ecSha256: '1.2.840.10045.4.3.2', ecSha384: '1.2.840.10045.4.3.3', ecSha512: '1.2.840.10045.4.3.4',
    p256: '1.2.840.10045.3.1.7', p384: '1.3.132.0.34', p521: '1.3.132.0.35', ed25519: '1.3.101.112',
    signedData: '1.2.840.113549.1.7.2', tstInfo: '1.2.840.113549.1.9.16.1.4',
    contentType: '1.2.840.113549.1.9.3', messageDigest: '1.2.840.113549.1.9.4',
    signingCert: '1.2.840.113549.1.9.16.2.12', signingCertV2: '1.2.840.113549.1.9.16.2.47',
    basicConstraints: '2.5.29.19', keyUsage: '2.5.29.15', extKeyUsage: '2.5.29.37', ski: '2.5.29.14', aki: '2.5.29.35',
    timeStamping: '1.3.6.1.5.5.7.3.8', cn: '2.5.4.3'
  };
  const HASH_OF = { [OID.sha1]: 'SHA-1', [OID.sha256]: 'SHA-256', [OID.sha384]: 'SHA-384', [OID.sha512]: 'SHA-512' };
  const SIG = {
    [OID.rsaSha1]: { kind: 'rsa', hash: 'SHA-1' }, [OID.rsaSha256]: { kind: 'rsa', hash: 'SHA-256' },
    [OID.rsaSha384]: { kind: 'rsa', hash: 'SHA-384' }, [OID.rsaSha512]: { kind: 'rsa', hash: 'SHA-512' },
    [OID.ecSha256]: { kind: 'ec', hash: 'SHA-256' }, [OID.ecSha384]: { kind: 'ec', hash: 'SHA-384' }, [OID.ecSha512]: { kind: 'ec', hash: 'SHA-512' },
    [OID.ed25519]: { kind: 'ed25519' }
  };
  const CURVE = { [OID.p256]: ['P-256', 32], [OID.p384]: ['P-384', 48], [OID.p521]: ['P-521', 66] };

  /* ---------------- certificates ---------------- */

  function parseCert(der) {
    const b = der;
    const top = read(b);
    if (top.end !== b.length) throw new Error('certificate has bytes left over');
    const [tbsEl, sigAlgEl, sigEl] = kids(b, expect(top, 0x30, 'Certificate'));
    const t = kids(b, expect(tbsEl, 0x30, 'TBSCertificate'));
    let i = 0;
    if (t[0].tag === 0xa0) i++;
    const serial = body(b, expect(t[i++], 0x02, 'serial'));
    i++; // signature algorithm (repeated below)
    const issuer = raw(b, expect(t[i++], 0x30, 'issuer'));
    const [nb, na] = kids(b, expect(t[i++], 0x30, 'validity'));
    const subjectEl = expect(t[i++], 0x30, 'subject');
    const spkiEl = expect(t[i++], 0x30, 'subjectPublicKeyInfo');
    const [keyAlgEl] = kids(b, spkiEl);
    const keyAlg = algId(b, keyAlgEl);
    const cert = {
      der, tbs: raw(b, tbsEl), sigAlg: algId(b, sigAlgEl).oid, sig: bitString(b, sigEl),
      serial, issuer, subject: raw(b, subjectEl), notBefore: time(b, nb), notAfter: time(b, na),
      spki: raw(b, spkiEl), keyAlg: keyAlg.oid, curve: keyAlg.paramEl && keyAlg.paramEl.tag === 0x06 ? oid(b, keyAlg.paramEl) : null,
      ca: false, keyUsage: null, eku: null, ekuCritical: false, ski: null, aki: null, cn: commonName(b, subjectEl)
    };
    for (; i < t.length; i++) {
      if (t[i].tag !== 0xa3) continue;
      const [exts] = kids(b, t[i]);
      for (const ext of kids(b, exts)) {
        const k = kids(b, ext);
        const id = oid(b, k[0]);
        const critical = k.length === 3 && k[1].tag === 0x01 && b[k[1].cs] !== 0;
        const val = k[k.length - 1];
        const inner = read(b, val.cs, val.end);
        if (id === OID.basicConstraints) {
          const bc = kids(b, inner);
          cert.ca = !!(bc[0] && bc[0].tag === 0x01 && b[bc[0].cs]);
        } else if (id === OID.keyUsage) {
          const bits = bitString(b, inner);
          cert.keyUsage = { digitalSignature: !!(bits[0] & 0x80), keyCertSign: !!(bits[0] & 0x04) };
        } else if (id === OID.extKeyUsage) {
          cert.eku = kids(b, inner).map((x) => oid(b, x));
          cert.ekuCritical = critical;
        } else if (id === OID.ski) cert.ski = H.toHex(body(b, inner));
        else if (id === OID.aki) {
          const k0 = kids(b, inner).find((x) => x.tag === 0x80);
          if (k0) cert.aki = H.toHex(body(b, k0));
        }
      }
    }
    return cert;
  }
  function bitString(b, el) {
    expect(el, 0x03, 'BIT STRING');
    return b.slice(el.cs + 1, el.end);
  }
  function commonName(b, nameEl) {
    for (const rdn of kids(b, nameEl)) {
      for (const atv of kids(b, rdn)) {
        const [t, v] = kids(b, atv);
        if (oid(b, t) === OID.cn) { try { return H.fromUtf8(body(b, v)); } catch { return null; } }
      }
    }
    return null;
  }
  function pemToDer(pem) {
    const m = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(pem);
    if (!m) throw new Error('no certificate in that text');
    return base64Decode(m[1].replace(/\s+/g, ''));
  }

  /* ---------------- signatures ---------------- */

  const subtle = () => globalThis.crypto.subtle;
  async function digest(hash, data) {
    return new Uint8Array(await subtle().digest(hash, data));
  }
  // ECDSA signatures in DER (r, s) to the fixed-width r‖s WebCrypto takes
  function ecRaw(sig, size) {
    const seq = read(sig);
    const [r, s] = kids(sig, expect(seq, 0x30, 'ECDSA signature'));
    const fix = (el) => {
      let v = body(sig, expect(el, 0x02, 'ECDSA r/s'));
      while (v.length > size && v[0] === 0) v = v.slice(1);
      if (v.length > size) throw new Error('ECDSA value too long');
      const out = new Uint8Array(size);
      out.set(v, size - v.length);
      return out;
    };
    return H.concat(fix(r), fix(s));
  }
  // Does `sig` over `data` verify with the key in `cert`? `alg` names the
  // signature algorithm; `hashOid` is for a signer that names only RSA and
  // the hash separately (as CMS allows).
  async function verifySig(cert, alg, data, sig, hashOid = null) {
    let s = SIG[alg];
    if (!s && alg === OID.rsa && HASH_OF[hashOid]) s = { kind: 'rsa', hash: HASH_OF[hashOid] };
    if (!s) throw new Error('signature algorithm ' + alg + ' isn\'t supported');
    if (s.kind === 'rsa') {
      if (cert.keyAlg !== OID.rsa) throw new Error('an RSA signature from a key that isn\'t RSA');
      const key = await subtle().importKey('spki', cert.spki, { name: 'RSASSA-PKCS1-v1_5', hash: s.hash }, false, ['verify']);
      return subtle().verify('RSASSA-PKCS1-v1_5', key, sig, data);
    }
    if (s.kind === 'ec') {
      const c = CURVE[cert.curve];
      if (cert.keyAlg !== OID.ec || !c) throw new Error('an ECDSA signature from a key on a curve that isn\'t supported');
      const key = await subtle().importKey('spki', cert.spki, { name: 'ECDSA', namedCurve: c[0] }, false, ['verify']);
      return subtle().verify({ name: 'ECDSA', hash: s.hash }, key, ecRaw(sig, c[1]), data);
    }
    if (cert.keyAlg !== OID.ed25519) throw new Error('an Ed25519 signature from a key that isn\'t Ed25519');
    const key = await subtle().importKey('spki', cert.spki, { name: 'Ed25519' }, false, ['verify']);
    return subtle().verify({ name: 'Ed25519' }, key, sig, data);
  }

  /* ---------------- requests and answers ---------------- */

  // A TimeStampReq for a SHA-256 hash (32 bytes) with a random nonce.
  // certReq asks the authority to put its certificate in the token.
  function request(hash, { nonce = null, certReq = false } = {}) {
    if (!(hash instanceof Uint8Array) || hash.length !== 32) throw new Error('a timestamp request is for a 32-byte SHA-256 hash');
    const n = nonce || randomBytes(8);
    const imprint = tlv(0x30, H.concat(tlv(0x30, H.concat(oidBytes(OID.sha256), Uint8Array.of(0x05, 0x00))), tlv(0x04, hash)));
    const parts = [Uint8Array.of(0x02, 0x01, 0x01), imprint, uintBytes(n)];
    if (certReq) parts.push(Uint8Array.of(0x01, 0x01, 0xff));
    return { der: tlv(0x30, H.concat(...parts)), nonce: H.toHex(stripZeros(n)) };
  }
  const stripZeros = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; return b.slice(i); };

  const STATUS = ['granted', 'grantedWithMods', 'rejection', 'waiting', 'revocationWarning', 'revocationNotification'];
  // A TimeStampResp: { status, granted, text, token (bytes or null) }
  function parseResponse(der) {
    const top = read(der);
    if (top.end !== der.length) throw new Error('answer has bytes left over');
    const k = kids(der, expect(top, 0x30, 'TimeStampResp'));
    const si = kids(der, expect(k[0], 0x30, 'PKIStatusInfo'));
    const code = int(der, si[0]);
    let text = null;
    if (si[1] && si[1].tag === 0x30) {
      try { text = kids(der, si[1]).map((x) => H.fromUtf8(body(der, x))).join(' '); } catch { /* not text */ }
    }
    return { status: STATUS[code] || 'status ' + code, granted: code === 0 || code === 1, text, token: k[1] ? raw(der, k[1]) : null };
  }

  // A token (ContentInfo holding SignedData holding TSTInfo), read but not
  // checked: { tst: { policy, hashAlg, hash, serial, time, accuracy, nonce,
  // ordering }, certs: [der], signer: { … } }
  function parseToken(token) {
    const b = token;
    const top = read(b);
    if (top.end !== b.length) throw new Error('token has bytes left over');
    const ci = kids(b, expect(top, 0x30, 'ContentInfo'));
    if (oid(b, ci[0]) !== OID.signedData) throw new Error('token isn\'t signed data');
    const [sdEl] = kids(b, expect(ci[1], 0xa0, 'content'));
    const sd = kids(b, expect(sdEl, 0x30, 'SignedData'));
    let i = 1; // version
    i++; // digestAlgorithms
    const eci = kids(b, expect(sd[i++], 0x30, 'EncapsulatedContentInfo'));
    if (oid(b, eci[0]) !== OID.tstInfo) throw new Error('token doesn\'t hold a TSTInfo');
    const [octet] = kids(b, expect(eci[1], 0xa0, 'eContent'));
    const eContent = body(b, expect(octet, 0x04, 'eContent'));
    const certs = [];
    if (sd[i] && sd[i].tag === 0xa0) { for (const c of kids(b, sd[i])) if (c.tag === 0x30) certs.push(raw(b, c)); i++; }
    if (sd[i] && sd[i].tag === 0xa1) i++; // CRLs
    const sis = kids(b, expect(sd[i], 0x31, 'SignerInfos'));
    if (sis.length !== 1) throw new Error('token should have one signer');
    return { tst: parseTst(eContent), eContent, certs, signer: parseSigner(b, sis[0]) };
  }
  function parseTst(b) {
    const top = read(b);
    const k = kids(b, expect(top, 0x30, 'TSTInfo'));
    const imp = kids(b, expect(k[2], 0x30, 'MessageImprint'));
    const tst = {
      version: int(b, k[0]), policy: oid(b, k[1]), hashAlg: algId(b, imp[0]).oid, hash: H.toHex(body(b, expect(imp[1], 0x04, 'hashedMessage'))),
      serial: H.toHex(body(b, expect(k[3], 0x02, 'serialNumber'))), time: time(b, expect(k[4], 0x18, 'genTime')),
      accuracy: null, ordering: false, nonce: null
    };
    for (const el of k.slice(5)) {
      if (el.tag === 0x30) {
        let ms = 0;
        for (const a of kids(b, el)) {
          const v = a.tag === 0x02 ? int(b, a) : (() => { let x = 0; for (let j = a.cs; j < a.end; j++) x = x * 256 + b[j]; return x; })();
          if (a.tag === 0x02) ms += v * 1000;
          else if (a.tag === 0x80) ms += v;
          else if (a.tag === 0x81) ms += v / 1000;
        }
        tst.accuracy = ms;
      } else if (el.tag === 0x01) tst.ordering = b[el.cs] !== 0;
      else if (el.tag === 0x02) tst.nonce = H.toHex(stripZeros(body(b, el)));
    }
    return tst;
  }
  function parseSigner(b, el) {
    const k = kids(b, expect(el, 0x30, 'SignerInfo'));
    let i = 1;
    const sidEl = k[i++];
    let sid;
    if (sidEl.tag === 0x30) {
      const [iss, ser] = kids(b, sidEl);
      sid = { issuer: raw(b, iss), serial: body(b, ser) };
    } else if (sidEl.tag === 0x80) sid = { ski: H.toHex(body(b, sidEl)) };
    else throw new Error('signer identifier it can\'t read');
    const digestAlg = algId(b, k[i++]).oid;
    let signedAttrs = null;
    const attrs = {};
    if (k[i].tag === 0xa0) {
      // signed over as a SET: the [0] IMPLICIT tag put back to 0x31
      signedAttrs = raw(b, k[i]);
      signedAttrs[0] = 0x31;
      for (const a of kids(b, k[i])) {
        const [t, set] = kids(b, a);
        attrs[oid(b, t)] = kids(b, set).map((v) => ({ el: v, der: raw(b, v) }));
      }
      i++;
    }
    const sigAlg = algId(b, k[i++]).oid;
    const sig = body(b, expect(k[i++], 0x04, 'signature'));
    return { sid, digestAlg, signedAttrs, attrs, sigAlg, sig, b };
  }

  /* ---------------- checking ---------------- */

  // Checks a token. `hash`: the 32 bytes (or hex) it should be for.
  // `anchors`: trusted root certificates (DER). `certs`: more certificates
  // to build the chain from (the token's own are used too). `nonce`: the
  // request's, when the answer has just arrived. Returns { ok, time,
  // problems, chain: [{ cn, sha256 }], signer, tst }.
  async function verify(token, { hash = null, anchors = [], certs = [], nonce = null } = {}) {
    const problems = [];
    let parsed;
    try { parsed = parseToken(token); } catch (err) { return { ok: false, time: null, problems: ['unreadable token: ' + err.message], chain: [] }; }
    const { tst, eContent, signer } = parsed;
    const out = { ok: false, time: tst.time, problems, chain: [], tst, signer: null };
    const want = hash == null ? null : (typeof hash === 'string' ? hash.toLowerCase() : H.toHex(hash));
    if (tst.hashAlg !== OID.sha256) problems.push('the token\'s hash isn\'t SHA-256');
    if (want && tst.hash !== want) problems.push('the token is for a different hash');
    if (nonce != null && tst.nonce !== nonce) problems.push('the token\'s nonce isn\'t the request\'s');

    // the signer's certificate
    const load = (list) => {
      const got = [];
      for (const d of list) {
        try { got.push(parseCert(d)); } catch (err) { problems.push('a certificate it can\'t read: ' + err.message); }
      }
      return got;
    };
    const trusted = load(anchors);
    const pool = [...load([...parsed.certs, ...certs]), ...trusted];
    const sid = signer.sid;
    const signerCert = pool.find((c) => sid.ski ? c.ski === sid.ski : H.equal(c.issuer, sid.issuer) && H.equal(stripZeros(c.serial), stripZeros(sid.serial)));
    if (!signerCert) { problems.push('the signer\'s certificate isn\'t in hand'); return out; }
    out.signer = signerCert.cn;

    // the signed attributes
    if (!signer.signedAttrs) problems.push('the token has no signed attributes');
    else {
      const ct = signer.attrs[OID.contentType];
      if (!ct || oid(signer.b, ct[0].el) !== OID.tstInfo) problems.push('the signed content type isn\'t TSTInfo');
      const md = signer.attrs[OID.messageDigest];
      const hashName = HASH_OF[signer.digestAlg];
      if (!hashName) problems.push('the signer\'s hash isn\'t supported');
      else if (!md || !H.equal(body(signer.b, md[0].el), await digest(hashName, eContent))) problems.push('the signed digest doesn\'t match the timestamp');
      // the certificate the signature names (ESS signing-certificate)
      const v1 = signer.attrs[OID.signingCert];
      const v2 = signer.attrs[OID.signingCertV2];
      if (!v1 && !v2) problems.push('the token doesn\'t name its signing certificate');
      else {
        const b = signer.b;
        const certsSeq = kids(b, (v2 || v1)[0].el)[0];
        const first = kids(b, certsSeq)[0];
        const f = kids(b, first);
        let alg = 'SHA-1';
        let hashEl = f[0];
        if (v2) {
          alg = 'SHA-256';
          if (f[0].tag === 0x30) { alg = HASH_OF[algId(b, f[0]).oid] || null; hashEl = f[1]; }
        }
        if (!alg) problems.push('the signing certificate\'s hash isn\'t supported');
        else if (!H.equal(body(b, hashEl), await digest(alg, signerCert.der))) problems.push('the token names a different signing certificate');
      }
      try {
        if (!(await verifySig(signerCert, signer.sigAlg, signer.signedAttrs, signer.sig, signer.digestAlg))) problems.push('the signature doesn\'t verify');
      } catch (err) { problems.push(err.message); }
    }

    // the signer's certificate itself
    const at = tst.time;
    if (!(signerCert.eku && signerCert.eku.length === 1 && signerCert.eku[0] === OID.timeStamping && signerCert.ekuCritical)) {
      problems.push('the signing certificate isn\'t for timestamping only');
    }

    // the chain, up to a trusted root
    let cert = signerCert;
    for (let depth = 0; ; depth++) {
      out.chain.push({ cn: cert.cn, sha256: H.toHex(H.sha256(cert.der)) });
      if (at < cert.notBefore || at > cert.notAfter) problems.push(`"${cert.cn}" wasn't valid at the token's time`);
      if (trusted.some((a) => H.equal(a.der, cert.der))) { out.anchored = true; break; }
      if (depth >= 6) { problems.push('the chain is too long'); break; }
      const issuer = pool.find((c) => c !== cert && H.equal(c.subject, cert.issuer) && (!cert.aki || !c.ski || c.ski === cert.aki));
      if (!issuer) { problems.push(`no certificate in hand issued "${cert.cn}"`); break; }
      if (!issuer.ca) problems.push(`"${issuer.cn}" isn't a certificate authority`);
      if (issuer.keyUsage && !issuer.keyUsage.keyCertSign) problems.push(`"${issuer.cn}" may not sign certificates`);
      try {
        if (!(await verifySig(issuer, cert.sigAlg, cert.tbs, cert.sig))) problems.push(`"${cert.cn}"'s certificate signature doesn't verify`);
      } catch (err) { problems.push(err.message); }
      cert = issuer;
    }
    if (!out.anchored) problems.push('the chain doesn\'t reach a trusted root');
    out.ok = !problems.length;
    return out;
  }

  /* ---------------- asking ---------------- */

  // Asks the authority at `url` to timestamp `hash`. Returns { token, tst,
  // nonce } with the answer read and matched to the request (hash, nonce),
  // not yet verified; throws when the authority won't.
  async function stamp(fetch, url, hash, { certReq = false, timeout = 15000 } = {}) {
    const req = request(hash, { certReq });
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), timeout) : null;
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/timestamp-query' }, body: req.der, ...(ctl ? { signal: ctl.signal } : {}) });
    } finally { if (t) clearTimeout(t); }
    if (res.status !== 200) throw new Error('timestamp service answered ' + res.status);
    const der = new Uint8Array(await res.arrayBuffer());
    if (der.length > 65536) throw new Error('timestamp answer too long');
    const r = parseResponse(der);
    if (!r.granted || !r.token) throw new Error('timestamp refused: ' + r.status + (r.text ? ' (' + r.text + ')' : ''));
    const { tst } = parseToken(r.token);
    if (tst.hash !== H.toHex(hash)) throw new Error('timestamp is for a different hash');
    if (tst.nonce !== req.nonce) throw new Error('timestamp\'s nonce isn\'t the request\'s');
    return { token: r.token, tst, nonce: req.nonce };
  }

  /* ---------------- odds and ends ---------------- */

  function randomBytes(n) {
    const out = new Uint8Array(n);
    globalThis.crypto.getRandomValues(out);
    return out;
  }
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function base64Decode(s) {
    const clean = s.replace(/=+$/, '');
    const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
    let bits = 0, acc = 0, j = 0;
    for (const ch of clean) {
      const v = B64.indexOf(ch);
      if (v < 0) throw new Error('not base64');
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) { bits -= 8; out[j++] = (acc >> bits) & 0xff; }
    }
    return out.slice(0, j);
  }
  function base64Encode(b) {
    let s = '';
    for (let i = 0; i < b.length; i += 3) {
      const n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0);
      s += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
    }
    return s;
  }

  Object.assign(exports, {
    request, parseResponse, parseToken, parseCert, verify, stamp, pemToDer, base64Decode, base64Encode,
    der: { read, kids, oid, time }, OID
  });
})(typeof module !== 'undefined' && module.exports ? module.exports : (globalThis.StampTsa = {}));
