// OpenTimestamps for the Scribe's Log: the standard .ots proof format, the
// calendar protocol (submit a digest, ask later for the finished proof),
// and checking a proof up to the Bitcoin block it names. No dependencies:
// hashing comes from slog-hash.js, and the network from a `fetch` the
// caller passes in (Electron's net.fetch in NEO, the browser's in the
// verifier, a fake in tests), so this file runs anywhere.
//
// A proof is a tree. Each node holds a message (bytes); an operation on it
// (append, prepend, sha256…) leads to a child node, and an attestation on a
// node says "this message was committed to here": pending at a calendar, or
// in a Bitcoin block's merkle root. Serialization follows python-
// opentimestamps exactly (same ordering), so a proof written here reads the
// same in `ots info` and byte for byte after a round trip.

'use strict';

(function (exports) {
  const H = typeof require === 'function' ? require('./slog-hash.js') : globalThis.SlogHash;

  const MAGIC = new Uint8Array([0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00,
    0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94]);
  const VERSION = 1;
  const PENDING = '83dfe30d2ef90c8e';
  const BITCOIN = '0588960d73d71901';
  const LITECOIN = '06869a0d73d71b45';
  // limits as in python-opentimestamps, so a hostile proof can't run away
  const MAX_MSG = 4096;
  const MAX_PAYLOAD = 8192;
  const MAX_URI = 1000;
  const MAX_DEPTH = 256;
  const MAX_RESPONSE = 10000;

  const OPS = {
    0xf0: { name: 'append', arg: true, run: (m, a) => H.concat(m, a) },
    0xf1: { name: 'prepend', arg: true, run: (m, a) => H.concat(a, m) },
    0xf2: { name: 'reverse', run: (m) => m.slice().reverse() },
    0xf3: { name: 'hexlify', run: (m) => H.utf8(H.toHex(m)), maxIn: MAX_MSG / 2 },
    0x02: { name: 'sha1', run: (m) => H.sha1(m), digest: 20 },
    0x03: { name: 'ripemd160', run: (m) => H.ripemd160(m), digest: 20 },
    0x08: { name: 'sha256', run: (m) => H.sha256(m), digest: 32 },
    0x67: { name: 'keccak256', run: null, digest: 32 } // read and written, never evaluated
  };
  const TAG_OF = Object.fromEntries(Object.entries(OPS).map(([t, o]) => [o.name, +t]));

  // ---- bytes in, bytes out ----

  class Reader {
    constructor(b) { this.b = b; this.i = 0; }
    byte() {
      if (this.i >= this.b.length) throw new Error('proof ends too soon');
      return this.b[this.i++];
    }
    bytes(n) {
      if (this.i + n > this.b.length) throw new Error('proof ends too soon');
      const out = this.b.slice(this.i, this.i + n);
      this.i += n;
      return out;
    }
    varuint() {
      let v = 0;
      let mul = 1;
      for (let k = 0; k < 8; k++) {
        const c = this.byte();
        v += (c & 0x7f) * mul;
        if (!(c & 0x80)) return v;
        mul *= 128;
      }
      throw new Error('number too long');
    }
    varbytes(max, min = 0) {
      const n = this.varuint();
      if (n > max) throw new Error('field too long');
      if (n < min) throw new Error('field too short');
      return this.bytes(n);
    }
  }
  class Writer {
    constructor() { this.parts = []; }
    byte(c) { this.parts.push(Uint8Array.of(c)); }
    bytes(b) { this.parts.push(b); }
    varuint(v) {
      const out = [];
      do { let c = v % 128; v = Math.floor(v / 128); if (v) c |= 0x80; out.push(c); } while (v);
      this.parts.push(Uint8Array.from(out));
    }
    varbytes(b) { this.varuint(b.length); this.bytes(b); }
    done() { return H.concat(...this.parts); }
  }

  // ---- the tree ----

  function node(msg) {
    return { msg, attestations: [], ops: [] };
  }
  function opRun(op, msg) {
    const def = OPS[op.tag];
    if (!def || !def.run) return null;
    if (msg.length > (def.maxIn || MAX_MSG)) throw new Error('message too long for ' + def.name);
    const out = def.run(msg, op.arg);
    if (out.length > MAX_MSG) throw new Error(def.name + ' result too long');
    return out;
  }
  const opKey = (op) => op.tag.toString(16) + ':' + (op.arg ? H.toHex(op.arg) : '');
  const attKey = (a) => a.type === 'pending' ? 'p:' + a.uri : a.type === 'bitcoin' ? 'b:' + a.height : a.type === 'litecoin' ? 'l:' + a.height : 'u:' + a.tag + ':' + H.toHex(a.payload);

  // The child reached by `op` (made if new); a branch whose result can't
  // be worked out (keccak256) keeps a null message
  function child(n, op) {
    const k = opKey(op);
    let hit = n.ops.find((x) => opKey(x.op) === k);
    if (!hit) {
      const msg = n.msg ? opRun(op, n.msg) : null;
      hit = { op, stamp: node(msg) };
      n.ops.push(hit);
    }
    return hit.stamp;
  }
  function attest(n, att) {
    if (!n.attestations.some((a) => attKey(a) === attKey(att))) n.attestations.push(att);
  }
  // everything in `b` added to `a` (the same message)
  function merge(a, b) {
    if (a.msg && b.msg && !H.equal(a.msg, b.msg)) throw new Error('can\'t merge proofs of different messages');
    for (const att of b.attestations) attest(a, att);
    for (const { op, stamp } of b.ops) merge(child(a, op), stamp);
    return a;
  }

  // ---- reading ----

  function readAttestation(r) {
    const tag = H.toHex(r.bytes(8));
    const payload = r.varbytes(MAX_PAYLOAD);
    const p = new Reader(payload);
    let att;
    if (tag === PENDING) {
      const raw = p.varbytes(MAX_URI);
      const uri = H.fromUtf8(raw);
      if (!/^[A-Za-z0-9.\-_/:]+$/.test(uri)) throw new Error('calendar address has characters it shouldn\'t');
      att = { type: 'pending', uri };
    } else if (tag === BITCOIN || tag === LITECOIN) {
      att = { type: tag === BITCOIN ? 'bitcoin' : 'litecoin', height: p.varuint() };
    } else {
      return { type: 'unknown', tag, payload };
    }
    if (p.i !== payload.length) throw new Error('attestation has bytes left over');
    return att;
  }
  function readOp(r, tag) {
    const def = OPS[tag];
    if (!def) throw new Error('unknown operation 0x' + tag.toString(16));
    return def.arg ? { tag, arg: r.varbytes(MAX_MSG, 1) } : { tag };
  }
  function readTimestamp(r, msg, depth = MAX_DEPTH) {
    if (!depth) throw new Error('proof nests too deep');
    const n = node(msg);
    const one = (tag) => {
      if (tag === 0x00) attest(n, readAttestation(r));
      else {
        const op = readOp(r, tag);
        const c = child(n, op);
        merge(c, readTimestamp(r, c.msg, depth - 1));
      }
    };
    let tag = r.byte();
    while (tag === 0xff) {
      one(r.byte());
      tag = r.byte();
    }
    one(tag);
    return n;
  }
  // A whole .ots file: { hashOp, digest, timestamp }
  function parse(bytes) {
    const r = new Reader(bytes);
    if (!H.equal(r.bytes(MAGIC.length), MAGIC)) throw new Error('not an OpenTimestamps proof');
    const v = r.varuint();
    if (v !== VERSION) throw new Error('OpenTimestamps proof version ' + v + ' isn\'t supported');
    const tag = r.byte();
    const def = OPS[tag];
    if (!def || !def.digest) throw new Error('proof starts with an unknown hash');
    const digest = r.bytes(def.digest);
    const timestamp = readTimestamp(r, digest);
    if (r.i !== bytes.length) throw new Error('proof has bytes left over');
    return { hashOp: def.name, digest, timestamp };
  }
  // A calendar's answer: a bare timestamp of `msg`
  function parseTimestamp(bytes, msg) {
    const r = new Reader(bytes);
    const t = readTimestamp(r, msg);
    if (r.i !== bytes.length) throw new Error('timestamp has bytes left over');
    return t;
  }

  // ---- writing (python-opentimestamps' order) ----

  const ATT_TAG = { pending: PENDING, bitcoin: BITCOIN, litecoin: LITECOIN };
  function attCompare(a, b) {
    const ta = a.tag || ATT_TAG[a.type];
    const tb = b.tag || ATT_TAG[b.type];
    if (ta !== tb) return H.compare(H.fromHex(ta), H.fromHex(tb));
    if (a.type === 'pending') return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0;
    if (a.type === 'bitcoin' || a.type === 'litecoin') return a.height - b.height;
    return H.compare(a.payload, b.payload);
  }
  function opCompare(a, b) {
    if (a.op.tag !== b.op.tag) return a.op.tag - b.op.tag;
    if (!a.op.arg) return 0;
    return H.compare(a.op.arg, b.op.arg);
  }
  function writeAttestation(w, a) {
    const p = new Writer();
    if (a.type === 'pending') p.varbytes(H.utf8(a.uri));
    else if (a.type === 'bitcoin' || a.type === 'litecoin') p.varuint(a.height);
    else p.bytes(a.payload);
    w.bytes(H.fromHex(a.tag || ATT_TAG[a.type]));
    w.varbytes(p.done());
  }
  function writeOp(w, op) {
    w.byte(op.tag);
    if (OPS[op.tag].arg) w.varbytes(op.arg);
  }
  function writeTimestamp(w, n) {
    if (!n.attestations.length && !n.ops.length) throw new Error('an empty timestamp can\'t be written');
    const atts = n.attestations.slice().sort(attCompare);
    for (const a of atts.slice(0, -1)) { w.byte(0xff); w.byte(0x00); writeAttestation(w, a); }
    if (!n.ops.length) { w.byte(0x00); writeAttestation(w, atts[atts.length - 1]); return; }
    if (atts.length) { w.byte(0xff); w.byte(0x00); writeAttestation(w, atts[atts.length - 1]); }
    const ops = n.ops.slice().sort(opCompare);
    ops.forEach((x, i) => {
      if (i < ops.length - 1) w.byte(0xff);
      writeOp(w, x.op);
      writeTimestamp(w, x.stamp);
    });
  }
  function serialize(file) {
    const w = new Writer();
    w.bytes(MAGIC);
    w.varuint(VERSION);
    w.byte(TAG_OF[file.hashOp || 'sha256']);
    w.bytes(file.digest);
    writeTimestamp(w, file.timestamp);
    return w.done();
  }
  function serializeTimestamp(n) {
    const w = new Writer();
    writeTimestamp(w, n);
    return w.done();
  }

  // ---- walking ----

  // Every attestation with the message it attests to and the ops that led
  // there: [{ att, msg, path: [op…] }]
  function attestations(n, path = [], out = []) {
    for (const att of n.attestations) out.push({ att, msg: n.msg, path });
    for (const { op, stamp } of n.ops) attestations(stamp, path.concat([op]), out);
    return out;
  }

  // What a proof shows, without the network: whether it's for `digest`
  // (bytes or hex), the calendars still to answer, and the blocks it names
  // with the merkle root each must have. A Bitcoin attestation's message is
  // the root as the block header holds it; `root` is that in the reversed
  // hex block explorers show.
  function check(file, digest) {
    const problems = [];
    const want = typeof digest === 'string' ? H.fromHex(digest) : digest;
    if (want && !H.equal(file.digest, want)) problems.push('the proof is for a different hash');
    const out = { ok: false, pending: [], bitcoin: [], other: [], problems };
    for (const { att, msg } of attestations(file.timestamp)) {
      if (att.type === 'pending') out.pending.push(att.uri);
      else if (att.type === 'bitcoin') {
        if (!msg) problems.push('a Bitcoin attestation behind an operation that can\'t be checked');
        else if (msg.length !== 32) problems.push('a Bitcoin attestation on a message that isn\'t 32 bytes');
        else out.bitcoin.push({ height: att.height, msg: H.toHex(msg), root: H.toHex(msg.slice().reverse()) });
      } else out.other.push(att.type === 'unknown' ? 'unknown ' + att.tag : att.type + ' ' + att.height);
    }
    out.pending = [...new Set(out.pending)];
    out.ok = !problems.length && (out.pending.length > 0 || out.bitcoin.length > 0);
    return out;
  }

  // ---- calendars ----

  const AGGREGATORS = [
    'https://a.pool.opentimestamps.org',
    'https://b.pool.opentimestamps.org',
    'https://a.pool.eternitywall.com',
    'https://ots.btc.catallaxy.com'
  ];
  // Calendars a pending attestation may send NEO to (python-opentimestamps'
  // default whitelist): a proof can't point it anywhere else
  const CALENDARS = ['.calendar.opentimestamps.org', '.calendar.eternitywall.com', '.calendar.catallaxy.com'];
  function allowedCalendar(uri) {
    let u;
    try { u = new URL(uri); } catch { return false; }
    return u.protocol === 'https:' && !u.port && !u.username && !u.password && (u.pathname === '/' || u.pathname === '') &&
      CALENDARS.some((s) => u.hostname.endsWith(s) && u.hostname.length > s.length);
  }
  const HEADERS = { Accept: 'application/vnd.opentimestamps.v1', 'User-Agent': 'NEO Scribe\'s Log' };

  async function readBody(res) {
    const b = new Uint8Array(await res.arrayBuffer());
    if (b.length > MAX_RESPONSE) throw new Error('calendar answer too long');
    return b;
  }
  function withTimeout(fetch, url, init, ms) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), ms) : null;
    return fetch(url, ctl ? { ...init, signal: ctl.signal } : init).finally(() => t && clearTimeout(t));
  }

  // A new proof of `digest` (32 bytes): the digest, a random 16-byte nonce
  // appended and hashed (so a calendar learns nothing it could link), sent to
  // the calendars. Done once `min` have answered. Returns { file, answered,
  // failed: [{ url, error }] }; `file` is null when too few answered.
  async function stamp(fetch, digest, { calendars = AGGREGATORS, min = 2, timeout = 15000, nonce = null } = {}) {
    if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new Error('a stamp is of a 32-byte hash');
    const file = { hashOp: 'sha256', digest, timestamp: node(digest) };
    const salt = nonce || randomBytes(16);
    const commit = child(child(file.timestamp, { tag: 0xf0, arg: salt }), { tag: 0x08 });
    const answered = [];
    const failed = [];
    await Promise.all(calendars.map(async (url) => {
      try {
        const res = await withTimeout(fetch, url.replace(/\/$/, '') + '/digest', { method: 'POST', headers: HEADERS, body: commit.msg }, timeout);
        if (res.status !== 200) throw new Error('calendar answered ' + res.status);
        merge(commit, parseTimestamp(await readBody(res), commit.msg));
        answered.push(url);
      } catch (err) {
        failed.push({ url, error: String(err && err.message || err) });
      }
    }));
    return { file: answered.length >= min ? file : null, answered, failed };
  }

  // Asks each calendar still pending for the finished proof and adds what
  // comes back. Returns { file, upgraded: [uri], waiting: [uri], failed:
  // [{ uri, error }] }. A pending attestation stays in the proof (as
  // python-opentimestamps leaves it); a finished one stands on its own.
  async function upgrade(fetch, file, { timeout = 15000 } = {}) {
    const upgraded = [];
    const waiting = [];
    const failed = [];
    const asks = [];
    const visit = (n) => {
      for (const att of n.attestations) if (att.type === 'pending') asks.push({ n, uri: att.uri });
      for (const { stamp } of n.ops) visit(stamp);
    };
    visit(file.timestamp);
    for (const { n, uri } of asks) {
      if (!n.msg) continue;
      if (!allowedCalendar(uri)) { failed.push({ uri, error: 'not a known calendar' }); continue; }
      try {
        const res = await withTimeout(fetch, uri.replace(/\/$/, '') + '/timestamp/' + H.toHex(n.msg), { headers: HEADERS }, timeout);
        if (res.status === 404) { waiting.push(uri); continue; }
        if (res.status !== 200) throw new Error('calendar answered ' + res.status);
        const t = parseTimestamp(await readBody(res), n.msg);
        if (!attestations(t).some(({ att }) => att.type === 'bitcoin')) { waiting.push(uri); continue; }
        merge(n, t);
        upgraded.push(uri);
      } catch (err) {
        failed.push({ uri, error: String(err && err.message || err) });
      }
    }
    return { file, upgraded, waiting, failed };
  }

  // ---- Bitcoin ----

  // Block explorers that serve the Esplora API (block-height, header)
  const EXPLORERS = ['https://mempool.space/api', 'https://blockstream.info/api'];

  // Checks a Bitcoin attestation from check() against the block at its
  // height, as a public explorer reports it: the header must hash to the
  // block's id and hold the attested merkle root. Returns { ok, time (ms,
  // the block's own timestamp), block, source } or { ok: false, error }.
  async function checkBlock(fetch, att, { explorers = EXPLORERS, timeout = 15000 } = {}) {
    let last = 'no explorer answered';
    for (const base of explorers) {
      try {
        const h = await withTimeout(fetch, `${base}/block-height/${att.height}`, {}, timeout);
        if (h.status !== 200) throw new Error('explorer answered ' + h.status);
        const block = (await h.text()).trim();
        if (!/^[0-9a-f]{64}$/.test(block)) throw new Error('explorer gave no block id');
        const r = await withTimeout(fetch, `${base}/block/${block}/header`, {}, timeout);
        if (r.status !== 200) throw new Error('explorer answered ' + r.status);
        const res = headerMatches((await r.text()).trim(), block, att);
        if (res.ok) return { ...res, source: base };
        return { ok: false, error: res.error, source: base };
      } catch (err) {
        last = String(err && err.message || err);
      }
    }
    return { ok: false, error: last };
  }
  // The arithmetic of checkBlock, for a header and block id in hand
  function headerMatches(headerHex, block, att) {
    const hdr = H.fromHex(headerHex);
    if (hdr.length !== 80) return { ok: false, error: 'a block header is 80 bytes' };
    const id = H.toHex(H.sha256(H.sha256(hdr)).reverse());
    if (id !== block) return { ok: false, error: 'the header isn\'t the block\'s' };
    if (H.toHex(hdr.slice(36, 68)) !== att.msg) return { ok: false, error: 'the block\'s merkle root isn\'t the one attested' };
    const time = new DataView(hdr.buffer, hdr.byteOffset).getUint32(68, true) * 1000;
    return { ok: true, time, block };
  }

  function randomBytes(n) {
    const out = new Uint8Array(n);
    globalThis.crypto.getRandomValues(out);
    return out;
  }

  Object.assign(exports, {
    parse, parseTimestamp, serialize, serializeTimestamp, merge, attestations, check,
    stamp, upgrade, checkBlock, headerMatches, allowedCalendar, node,
    AGGREGATORS, EXPLORERS, MAGIC
  });
})(typeof module !== 'undefined' && module.exports ? module.exports : (globalThis.StampOts = {}));
