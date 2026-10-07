'use strict';

// Fakes of the outside timestamp services, for tests: a time-stamp
// authority that signs real RFC 3161 tokens with the local test key in
// fixtures/stamps (a key nothing else trusts), and OpenTimestamps calendars
// that answer with pending proofs. Used by slog-stamp.test.js, and by
// slog.e2e.js behind a local HTTP server.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ots = require('../stamp-ots.js');
const tsa = require('../stamp-tsa.js');
const H = require('../slog-hash.js');

const FIX = path.join(__dirname, 'fixtures', 'stamps');
const ROOT_PEM = path.join(FIX, 'local-p256-root.pem');
const SIGNER_PEM = path.join(FIX, 'local-p256-signer.pem');
const ROOT = tsa.pemToDer(fs.readFileSync(ROOT_PEM, 'utf8'));
const SIGNER = tsa.pemToDer(fs.readFileSync(SIGNER_PEM, 'utf8'));
const KEY = crypto.createPrivateKey(fs.readFileSync(path.join(FIX, 'local-p256-signer.key'), 'utf8'));

// ---- a time-stamp authority, in a few lines of DER ----

function tlv(tag, ...parts) {
  const body = Buffer.concat(parts.map((p) => Buffer.from(p)));
  const n = body.length;
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return Buffer.concat([Buffer.from([tag, ...len]), body]);
}
function oid(dotted) {
  const p = dotted.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) {
    const enc = [v & 0x7f];
    for (let x = v >> 7; x; x >>= 7) enc.unshift((x & 0x7f) | 0x80);
    out.push(...enc);
  }
  return tlv(0x06, Buffer.from(out));
}
const int = (b) => tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const SHA256 = tlv(0x30, oid(tsa.OID.sha256), Buffer.from([5, 0]));
// a TimeStampResp for a request, signed with the test key; withCerts puts
// the signing certificate in the token
function tokenFor(reqDer, at, { withCerts = null } = {}) {
  const { read, kids } = tsa.der;
  const req = new Uint8Array(reqDer);
  const k = kids(req, read(req));
  const imp = kids(req, k[1]);
  const hash = Buffer.from(req.slice(imp[1].cs, imp[1].end));
  const nonce = k[2] && k[2].tag === 0x02 ? Buffer.from(req.slice(k[2].cs, k[2].end)) : null;
  const certReq = k.some((x) => x.tag === 0x01);
  const when = new Date(at).toISOString().replace(/[-:T]/g, '').replace(/\.\d+Z$/, 'Z');
  const tst = tlv(0x30, int(Buffer.from([1])), oid('1.2.3.4.1'), tlv(0x30, SHA256, tlv(0x04, hash)),
    int(crypto.randomBytes(8)), tlv(0x18, Buffer.from(when)), ...(nonce ? [tlv(0x02, nonce)] : []));
  const cert = tsa.parseCert(SIGNER);
  const attrs = [
    tlv(0x30, oid(tsa.OID.contentType), tlv(0x31, oid(tsa.OID.tstInfo))),
    tlv(0x30, oid(tsa.OID.messageDigest), tlv(0x31, tlv(0x04, crypto.createHash('sha256').update(tst).digest()))),
    tlv(0x30, oid(tsa.OID.signingCertV2), tlv(0x31, tlv(0x30, tlv(0x30, tlv(0x30, tlv(0x04, crypto.createHash('sha256').update(SIGNER).digest()))))))
  ];
  const signed = tlv(0x31, ...attrs);
  const sig = crypto.sign('sha256', signed, { key: KEY, dsaEncoding: 'der' });
  const signer = tlv(0x30, int(Buffer.from([1])), tlv(0x30, Buffer.from(cert.issuer), int(Buffer.from(cert.serial))), SHA256,
    tlv(0xa0, ...attrs), tlv(0x30, oid(tsa.OID.ecSha256)), tlv(0x04, sig));
  const include = withCerts === null ? certReq : withCerts;
  const sd = tlv(0x30, int(Buffer.from([3])), tlv(0x31, SHA256), tlv(0x30, oid(tsa.OID.tstInfo), tlv(0xa0, tlv(0x04, tst))),
    ...(include ? [tlv(0xa0, SIGNER)] : []), tlv(0x31, signer));
  return tlv(0x30, tlv(0x30, int(Buffer.from([0]))), tlv(0x30, oid(tsa.OID.signedData), tlv(0xa0, sd)));
}


// A calendar named `name` answering a submitted digest: a pending proof
function calendarAnswer(name, body) {
  const msg = new Uint8Array(body);
  const n = ots.node(msg);
  const c = { op: { tag: 0xf0, arg: H.utf8(name) }, stamp: ots.node(H.concat(msg, H.utf8(name))) };
  c.stamp.attestations.push({ type: 'pending', uri: `https://${name}.btc.calendar.opentimestamps.org` });
  n.ops.push(c);
  return Buffer.from(ots.serializeTimestamp(n));
}

module.exports = { tokenFor, calendarAnswer, ROOT, SIGNER, ROOT_PEM, SIGNER_PEM };
