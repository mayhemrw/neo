// Outside timestamps for the Scribe's Log, in the main process. While a
// book is being written, its chain's latest hash goes to FreeTSA (an RFC
// 3161 receipt, back in a second) and the OpenTimestamps calendars (a
// Bitcoin-anchored proof, finished hours later): every 15 minutes if the
// chain has moved, and when a session ends. Only the 32-byte hash leaves
// the computer.
//
// Receipts are kept in the book's scribes-log/stamps/: one JSON Lines file
// per session per device, appended while the session runs and never
// touched once closed (so it syncs once), plus each certificate once in
// stamps/certs/. Each receipt also becomes a `stamp` entry in the chain,
// in the chunk being written or the next one, so a receipt deleted later
// leaves a hole. Finished OpenTimestamps proofs, fetched later, go into a
// new receipt file of their own.
//
// Offline, a book's latest unstamped hash waits (only the latest: a
// timestamp proves when the service saw a hash, so sending older ones
// late adds nothing) and goes when the network's back. Failures back off;
// nothing ever retries in a loop, and nothing here can stop a save.
// The waiting work is kept in userData/slog/stamps.json, this computer's
// own; the receipts themselves are only ever in the book's folder.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const slog = require('./slog.js');
const files = require('./slog-files.js');
const ots = require('./stamp-ots.js');
const tsa = require('./stamp-tsa.js');

const STAMP_DIR = 'stamps';
const CERT_DIR = 'certs';
const { RECEIPT_RE } = require('./slog-verify.js');
const EVERY = 15 * 60 * 1000;         // a moving chain is stamped this often
const TICK = 60 * 1000;
const BACKOFF = [60e3, 5 * 60e3, 15 * 60e3]; // then every 15 minutes
const DRAIN_GAP = 15 * 1000;          // between queued requests, once back online
const CLOSE_AFTER = 60 * 1000;        // a session's receipt file closes this long after its last stamp
const UPGRADE_FIRST = 3 * 3600e3;     // a calendar's proof is asked for after this…
const UPGRADE_EVERY = 4 * 3600e3;     // …then this often…
const UPGRADE_RETRY = 3600e3;         // …(an hour, when the network failed)…
const UPGRADE_FOR = 14 * 24 * 3600e3; // …for this long
const TSA_SERVICES = [{ svc: 'freetsa', url: 'https://freetsa.org/tsr' }];

const b64 = (b) => Buffer.from(b).toString('base64');
const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const bookKey = (logId, dev) => logId + ':' + dev;
function utcName(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

class Stamper {
  // recorder: the slog.Recorder whose chains are stamped. fetch: the network
  // (Electron's net.fetch). home: userData/slog. anchors: trusted root
  // certificates (DER); certs: certificates kept for checking (FreeTSA's
  // signing certificate).
  constructor({
    recorder, fetch, home, anchors = [], certs = [], now = Date.now,
    services = TSA_SERVICES, calendars = ots.AGGREGATORS, every = EVERY,
    onError = () => {}, onChange = () => {}
  }) {
    this.recorder = recorder;
    this.fetch = fetch;
    this.home = home;
    this.anchors = anchors;
    this.certs = certs.slice();
    this.now = now;
    this.services = services;
    this.calendars = calendars;
    this.every = every;
    this.onError = onError;
    this.onChange = onChange;
    this.files = new Map();     // bookKey → the open receipt file
    this.kept = new Map();      // bookKey → { n, tsa, ots }: the receipts in hand for the newest entry stamped
    this.sending = new Map();   // bookKey → a send in progress
    this.backoff = 0;           // index into BACKOFF; failures in a row
    this.retryAt = 0;
    this.drainAt = 0;
    this.upgrading = null;
    this.timer = null;
    this.state = this._load();
    recorder.watcher = this;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((err) => this.onError('stamp', err)), TICK);
    if (this.timer.unref) this.timer.unref();
    setTimeout(() => this.tick().catch((err) => this.onError('stamp', err)), 5000).unref?.();
  }

  // Quitting: no new requests. Stamps already on their way (a session's
  // last hash, sent as NEO quits) get up to `wait` ms to come back; open
  // receipt files finish their writes. Anything still unsent waits in
  // stamps.json for the next start.
  async stop({ wait = 2500 } = {}) {
    clearInterval(this.timer);
    this.timer = null;
    const inFlight = [...this.sending.values()].map((p) => p.catch(() => {}));
    if (inFlight.length) {
      let timer;
      await Promise.race([Promise.all(inFlight), new Promise((resolve) => { timer = setTimeout(resolve, wait); })]);
      clearTimeout(timer);
    }
    this.stopped = true;
    this._save();
    await Promise.all([...this.files.values()].map((f) => f.writer.flush()));
  }

  /* ---- told by the recorder ---- */

  // a chunk opened: stamp entries waiting for this book go in now
  opened(b) {
    const key = bookKey(b.logId, b.dev);
    const waiting = this.state.entries[key];
    if (!waiting || !waiting.length) return;
    const left = [];
    for (const fields of waiting) if (!this.recorder.stamped(b.dir, b.bookId, b.logId, fields)) left.push(fields);
    if (left.length) this.state.entries[key] = left;
    else delete this.state.entries[key];
    this._save();
  }

  // a chunk closed: its last hash is stamped, quitting included (stop()
  // gives it a moment). It's queued first, so a quit that cuts the request
  // off loses nothing: it goes at the next start.
  closed(b) {
    const head = { dir: b.dir, bookId: b.bookId, logId: b.logId, dev: b.dev, n: b.n, head: b.head };
    this._queue(head);
    this._save();
    if (this.stopped) return;
    this._send(head).catch((err) => this.onError('stamp', err));
  }

  /* ---- the clock ---- */

  async tick() {
    if (this.stopped) return;
    const at = this.now();
    // chains being written that have moved since their last stamp
    for (const h of this.recorder.heads()) {
      const key = bookKey(h.logId, h.dev);
      const last = this.state.stamped[key];
      if (last && h.n <= last.n + (last.own || 0)) continue;
      if (last && at - last.at < this.every) continue;
      if (!last && !this.state.started[key]) { this.state.started[key] = at; continue; } // a session's first stamp comes after its first stretch
      if (!last && at - this.state.started[key] < this.every) continue;
      if (this.sending.has(key)) continue;
      await this._send(h).catch((err) => this.onError('stamp', err));
    }
    // what waited for the network, one request at a time
    if (at >= this.retryAt && at >= this.drainAt) {
      const [key] = Object.keys(this.state.queue);
      if (key && !this.sending.has(key)) {
        this.drainAt = at + DRAIN_GAP;
        await this._send(this.state.queue[key], this.state.queue[key].need).catch((err) => this.onError('stamp', err));
      }
    }
    // receipt files whose sessions are done
    for (const [key, f] of this.files) {
      if (f.closeAt && at >= f.closeAt && !this.sending.has(key)) this._closeFile(key);
    }
    if (!this.upgrading) {
      this.upgrading = this._upgrade().catch((err) => this.onError('upgrade', err)).finally(() => { this.upgrading = null; });
      await this.upgrading;
    }
  }

  // What the File menu shows for a book: { last (ms) or null, waiting }
  status(logId, dev) {
    const key = bookKey(logId, dev);
    const s = this.state.stamped[key];
    return { last: s ? s.at : null, waiting: !!this.state.queue[key] };
  }

  // The receipt files this computer is still writing for a book (Merge Log
  // into Archive leaves them be)
  openReceipts(dir) {
    const out = new Set();
    for (const f of this.files.values()) if (f.dir === dir) out.add(f.name);
    return out;
  }

  // An export's last stamp: the head `h` ({ dir, bookId, logId, dev, n,
  // head }) stamped by an RFC 3161 service, waiting up to `wait` ms for it.
  // A stamp already on its way is waited for; one waiting for the network
  // is tried now; a head already stamped returns at once. Resolves to
  // { tsa, ots }: whether a receipt of each kind for entry n is in hand, its
  // receipt file written out.
  async settle(h, { wait = 30000 } = {}) {
    const key = bookKey(h.logId, h.dev);
    const have = () => this.kept.get(key) || { n: 0, tsa: false, ots: false };
    const got = () => { const k = have(); return k.n === h.n ? { tsa: k.tsa, ots: k.ots } : { tsa: false, ots: false }; };
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(resolve, wait); });
    try {
      const work = (async () => {
        const inFlight = this.sending.get(key);
        if (inFlight) await inFlight.catch(() => {});
        if (got().tsa) return;
        // read back: a stamp from before NEO was last started
        const there = readReceipts(h.dir).filter((r) => r.line && r.line.dev === h.dev && r.line.n === h.n && r.line.h === h.head);
        if (there.length) {
          this.kept.set(key, { n: h.n, tsa: there.some((r) => r.line.svc !== 'ots'), ots: there.some((r) => r.line.svc === 'ots') });
          if (got().tsa) return;
        }
        if (this.stopped) return;
        const q = this.state.queue[key];
        await this._send(q && q.n === h.n ? q : h, q && q.n === h.n ? q.need : (got().ots ? ['tsa'] : null)).catch((err) => this.onError('stamp', err));
      })();
      await Promise.race([work, late]);
    } finally { clearTimeout(timer); }
    const f = this.files.get(key);
    if (f) await f.writer.flush().catch(() => {});
    return got();
  }

  /* ---- sending ---- */

  // Stamps one head with every service (or those in `need`). A service that
  // fails leaves the head queued for it, and the network backs off.
  async _send(h, need = null) {
    const key = bookKey(h.logId, h.dev);
    const prior = this.sending.get(key);
    if (prior) await prior.catch(() => {});
    const job = this._sendNow(h, need);
    this.sending.set(key, job);
    try { return await job; } finally { if (this.sending.get(key) === job) this.sending.delete(key); }
  }

  async _sendNow(h, need) {
    const key = bookKey(h.logId, h.dev);
    const hash = Buffer.from(h.head, 'hex');
    const sent = this.now();
    const want = need || ['tsa', 'ots'];
    // what this send stamps; the stamp entries it writes are counted on it
    // (own), so they alone don't count as the chain moving
    const prev = this.state.stamped[key];
    this.state.stamped[key] = { n: h.n, at: sent, own: 0 };
    const tasks = [];
    if (want.includes('tsa')) tasks.push(this._tsa(h, hash, sent).then((ok) => ({ part: 'tsa', ok })));
    if (want.includes('ots')) tasks.push(this._ots(h, hash, sent).then((ok) => ({ part: 'ots', ok })));
    const done = await Promise.all(tasks);
    const failed = done.filter((d) => !d.ok).map((d) => d.part);
    const queued = this.state.queue[key];
    if (failed.length) {
      // only the newest head waits; a newer one already waiting stays
      if (!queued || queued.n <= h.n) this.state.queue[key] = { ...h, need: failed };
      this.backoff = Math.min(this.backoff + 1, BACKOFF.length);
      this.retryAt = this.now() + BACKOFF[Math.min(this.backoff - 1, BACKOFF.length - 1)];
    } else {
      if (queued && queued.n <= h.n) delete this.state.queue[key];
      this.backoff = 0;
      this.retryAt = 0;
    }
    if (!done.some((d) => d.ok)) {
      if (prev) this.state.stamped[key] = prev;
      else delete this.state.stamped[key];
    } else this.state.stamped[key].at = this.now();
    this._save();
    this.onChange(h.bookId);
    return !failed.length;
  }

  async _tsa(h, hash, sent) {
    let ok = false;
    for (const s of this.services) {
      try {
        let got = await tsa.stamp(this.fetch, s.url, hash);
        let v = await tsa.verify(got.token, { hash, anchors: this.anchors, certs: this.certs, nonce: got.nonce });
        if (v.problems.includes('the signer\'s certificate isn\'t in hand')) {
          // a key NEO hasn't seen: ask once more, with its certificates
          got = await tsa.stamp(this.fetch, s.url, hash, { certReq: true });
          v = await tsa.verify(got.token, { hash, anchors: this.anchors, certs: this.certs, nonce: got.nonce });
          for (const c of tsa.parseToken(got.token).certs) if (!this.certs.some((k) => Buffer.from(k).equals(Buffer.from(c)))) this.certs.push(c);
        }
        if (!v.ok) this.onError('stamp', new Error(`${s.svc} receipt for ${h.bookId} #${h.n} didn't verify: ${v.problems.join('; ')}`));
        this._keep(h, { svc: s.svc, dev: h.dev, n: h.n, h: h.head, ts: sent, tsr: b64(got.token) },
          { svc: s.svc, of: h.n, t: got.tst.time, r: sha256hex(got.token) }, v);
        ok = true;
      } catch (err) {
        this.onError('stamp', new Error(`${s.svc}: ${err.message}`));
      }
    }
    return ok;
  }

  async _ots(h, hash, sent) {
    const res = await ots.stamp(this.fetch, new Uint8Array(hash), { calendars: this.calendars });
    if (!res.file) {
      this.onError('stamp', new Error('calendars: ' + res.failed.map((f) => f.url + ' ' + f.error).join('; ')));
      return false;
    }
    const proof = ots.serialize(res.file);
    this._keep(h, { svc: 'ots', dev: h.dev, n: h.n, h: h.head, ts: sent, ots: b64(proof) },
      { svc: 'ots', of: h.n, r: sha256hex(proof) });
    this.state.pending.push({ dir: h.dir, bookId: h.bookId, logId: h.logId, dev: h.dev, n: h.n, h: h.head, ots: b64(proof), since: sent, next: sent + UPGRADE_FIRST });
    return true;
  }

  // A receipt: its line in the session's receipt file, its stamp entry in
  // the chain (or kept for the next chunk)
  _keep(h, line, entry, verified = null) {
    const key = bookKey(h.logId, h.dev);
    this._receiptFile(h).writer.append(JSON.stringify(line)).catch((err) => this.onError('receipt', err));
    if (verified && verified.signer) this._keepCerts(h);
    const k = this.kept.get(key);
    const mark = k && k.n === h.n ? k : { n: h.n, tsa: false, ots: false };
    mark[line.svc === 'ots' ? 'ots' : 'tsa'] = true;
    this.kept.set(key, mark);
    const written = this.recorder.stamped(h.dir, h.bookId, h.logId, entry);
    if (written) {
      const s = this.state.stamped[key];
      if (s && s.n === h.n) s.own += 1;
    } else {
      (this.state.entries[key] || (this.state.entries[key] = [])).push(entry);
    }
  }

  // The open receipt file of a book on this device, made when first needed.
  // It closes a minute after its session ends.
  _receiptFile(h) {
    const key = bookKey(h.logId, h.dev);
    let f = this.files.get(key);
    if (f) {
      const open = this.recorder.heads().some((x) => bookKey(x.logId, x.dev) === key);
      f.closeAt = open ? 0 : this.now() + CLOSE_AFTER;
      return f;
    }
    const dir = path.join(h.dir, slog.LOG_DIR, STAMP_DIR);
    fs.mkdirSync(dir, { recursive: true });
    let name;
    for (let k = 1; ; k++) {
      name = `${utcName(this.now())}-${h.dev.slice(0, 8)}${k > 1 ? '-' + k : ''}.stamps`;
      if (!files.logHas(h.dir, STAMP_DIR + '/' + name)) break;
    }
    f = { name, dir: h.dir, writer: new slog.ChunkWriter(path.join(dir, name)), closeAt: 0 };
    const open = this.recorder.heads().some((x) => bookKey(x.logId, x.dev) === key);
    if (!open) f.closeAt = this.now() + CLOSE_AFTER;
    this.files.set(key, f);
    return f;
  }
  _closeFile(key) {
    const f = this.files.get(key);
    if (!f) return;
    this.files.delete(key);
    f.writer.flush().catch(() => {});
  }

  // The certificates a receipt is checked with, each once, in stamps/certs/
  _keepCerts(h) {
    const dir = path.join(h.dir, slog.LOG_DIR, STAMP_DIR, CERT_DIR);
    for (const c of [...this.certs, ...this.anchors]) {
      const file = path.join(dir, sha256hex(c) + '.der');
      if (fs.existsSync(file)) continue;
      try {
        fs.mkdirSync(dir, { recursive: true });
        slog.writeWhole(file, Buffer.from(c), { keep: true });
      } catch (err) { this.onError('certs', err); }
    }
  }

  // Only the newest head per book waits
  _queue(h) {
    const key = bookKey(h.logId, h.dev);
    const q = this.state.queue[key];
    if (!q || q.n <= h.n) this.state.queue[key] = { ...h, need: ['tsa', 'ots'] };
  }

  /* ---- finished OpenTimestamps proofs ---- */

  async _upgrade() {
    const at = this.now();
    const due = this.state.pending.filter((p) => p.next <= at);
    if (!due.length) return;
    const finished = new Map(); // dir|bookKey → lines
    for (const p of due) {
      if (this.stopped) break;
      if (at - p.since > UPGRADE_FOR || !fs.existsSync(path.join(p.dir, slog.LOG_DIR))) { this._dropPending(p); continue; }
      let file;
      try { file = ots.parse(new Uint8Array(Buffer.from(p.ots, 'base64'))); } catch (err) { this.onError('upgrade', err); this._dropPending(p); continue; }
      const up = await ots.upgrade(this.fetch, file);
      if (up.upgraded.length) {
        const proof = ots.serialize(up.file);
        const k = bookKey(p.logId, p.dev);
        if (!finished.has(k)) finished.set(k, { p, lines: [] });
        finished.get(k).lines.push(JSON.stringify({ svc: 'ots', dev: p.dev, n: p.n, h: p.h, ts: p.since, ots: b64(proof) }));
        this._dropPending(p);
      } else {
        p.next = this.now() + (up.failed.length && !up.waiting.length ? UPGRADE_RETRY : UPGRADE_EVERY);
      }
    }
    // each book's finished proofs: one new receipt file, written whole
    for (const { p, lines } of finished.values()) {
      try {
        const dir = path.join(p.dir, slog.LOG_DIR, STAMP_DIR);
        fs.mkdirSync(dir, { recursive: true });
        let name;
        for (let k = 1; ; k++) {
          name = `${utcName(this.now())}-${p.dev.slice(0, 8)}${k > 1 ? '-' + k : ''}.stamps`;
          if (!files.logHas(p.dir, STAMP_DIR + '/' + name)) break;
        }
        slog.writeWhole(path.join(dir, name), lines.join('\n') + '\n', { keep: true });
      } catch (err) {
        this.onError('upgrade', err);
      }
    }
    this._save();
  }
  _dropPending(p) {
    const i = this.state.pending.indexOf(p);
    if (i >= 0) this.state.pending.splice(i, 1);
  }

  /* ---- this computer's own record of what's waiting ---- */

  _file() { return path.join(this.home, 'stamps.json'); }
  _load() {
    const empty = { v: 1, queue: {}, entries: {}, pending: [], stamped: {}, started: {} };
    try {
      const s = JSON.parse(fs.readFileSync(this._file(), 'utf8'));
      if (!s || s.v !== 1) return empty;
      return { ...empty, ...s, started: {} };
    } catch { return empty; }
  }
  _save() {
    try {
      fs.mkdirSync(this.home, { recursive: true });
      const { started, ...keep } = this.state;
      slog.writeWhole(this._file(), JSON.stringify(keep));
    } catch (err) { this.onError('stamps.json', err); }
  }
}

// A book's receipts, read back: [{ file, line }] in file order. A last line
// without its newline (a write cut short) is set aside, as in a chunk.
// (Loose or merged into an archive.)
function readReceipts(bookDir) {
  const listing = files.listLog(bookDir);
  const out = [];
  const names = [...listing.files.keys()].filter((p) => p.startsWith(STAMP_DIR + '/') && RECEIPT_RE.test(p.slice(STAMP_DIR.length + 1))).sort();
  for (const rel of names) {
    const file = rel.slice(STAMP_DIR.length + 1);
    const text = listing.files.get(rel).read().toString('utf8');
    const lines = text.split('\n');
    lines.pop(); // after the last newline: nothing, or a half line
    for (const l of lines) {
      try { out.push({ file, line: JSON.parse(l) }); } catch { out.push({ file, line: null }); }
    }
  }
  return out;
}

module.exports = { Stamper, readReceipts, STAMP_DIR, CERT_DIR, RECEIPT_RE, EVERY, TSA_SERVICES };
