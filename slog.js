'use strict';

// THE SCRIBE'S LOG: a record of how a book was written.
//
// Every change to a book's text becomes an entry in a log kept beside the
// book, in scribes-log/. Each entry carries what happened in the clear
// (which document, where, how much, how it got there, when) and commits to
// the words themselves with a salted hash, so the log can be shared without
// a single word of the book in it and still be checked. Each entry also
// carries the hash of the one before, so an old entry can't be changed or
// dropped without breaking every hash after it.
//
// One chain per device, so two computers writing before a sync never fork
// it. One chunk file per session per device: a closed chunk is never
// written again, which keeps a synced library quiet. The format is set out
// in SLOG-FORMAT.md.
//
// This file is plain functions plus a small append-only writer. It runs in
// the main process (the window never touches the disk) and in node:test.

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');

const FORMAT = 1;
const LOG_DIR = 'scribes-log';
const LOG_INFO = 'log.json';
const KINDS = new Set(['open', 'edit', 'base', 'doc', 'on', 'off', 'sleep', 'wake', 'clock', 'close', 'stamp']);
// 20261007T160512Z-7f3a9c2e.slog, with -2, -3… if a name is ever taken
const CHUNK_RE = /^(\d{8}T\d{6}Z)-([0-9a-f]{8})(?:-([1-9]\d{0,3}))?\.slog$/;

/* ------------------------------------------------------------------ */
/*  Hashing                                                            */
/* ------------------------------------------------------------------ */

// Canonical JSON: keys sorted at every level, no spaces, whole numbers only.
// Anything that hashes an entry, in any language, gets the same bytes.
function canonical(v) {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string': return JSON.stringify(v);
    case 'boolean': return v ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(v)) throw new Error('Scribe\'s Log: not a whole number: ' + v);
      return String(v === 0 ? 0 : v); // -0 is 0
    case 'object':
      if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
      return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
    default:
      throw new Error('Scribe\'s Log: can\'t record a ' + typeof v);
  }
}

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

// The clear part: the entry without its words (x). What the chain hashes,
// and all a log shared without the text contains.
function clearPart(entry) {
  const c = {};
  for (const k of Object.keys(entry)) if (k !== 'x') c[k] = entry[k];
  return c;
}
const entryHash = (entry) => sha256hex(canonical(clearPart(entry)));

// Each entry's salt comes from the book's key and the entry's place in its
// chain. Nothing extra is stored, and one entry's words can be shown later
// (with its salt) without handing over the key to all the others.
function saltFor(key, dev, n) {
  return crypto.createHmac('sha256', key).update(dev + ':' + n).digest();
}
function commitment(key, dev, n, ins) {
  return sha256hex(Buffer.concat([saltFor(key, dev, n), Buffer.from(canonical(ins), 'utf8')]));
}
const keyId = (key) => sha256hex(key).slice(0, 16);

// The manuscript's fingerprint: its prose as plain text, in Unicode's
// composed form, every run of whitespace one space. Unsalted on purpose, so
// a publisher holding the book can hash it and match the log's last word.
function normalizeManuscript(text) {
  return String(text).normalize('NFC').replace(/\s+/gu, ' ').trim();
}
const manuscriptHash = (text) => sha256hex(normalizeManuscript(text));

const newDeviceId = () => crypto.randomBytes(16).toString('hex');
function newLogInfo() {
  return { v: FORMAT, logId: crypto.randomBytes(8).toString('hex'), key: crypto.randomBytes(32).toString('base64') };
}

/* ------------------------------------------------------------------ */
/*  Diff: what changed between two versions of a document              */
/* ------------------------------------------------------------------ */

// Ops are [at, del, ins] in UTF-16 units of the document's saved HTML,
// applied in order, each `at` measured after the ops before it. The
// inserted strings travel separately (an entry's x.ins), one per op.

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

// Tokens for the word-level pass: a tag, a word, or a run of spaces.
const TOKEN_RE = /<[^>]*>|[^\s<]+|\s+|</g;
const MAX_EDITS = 256;      // tokens; past this a burst is one replacement
const SPLIT_FROM = 32;      // a middle shorter than this is one op anyway

// Two edits far apart in one burst (typing here, then a click and a word
// there) must not become one replacement of everything between them: that
// would claim the untouched text was retyped. So past the shared start and
// end, the middles are compared word by word (Myers' algorithm, capped).
function diff(a, b) {
  if (a === b) return { ops: [], ins: [] };
  const max = Math.min(a.length, b.length);
  let pre = 0;
  while (pre < max && a.charCodeAt(pre) === b.charCodeAt(pre)) pre++;
  if (pre > 0 && isHigh(a.charCodeAt(pre - 1))) pre--; // never split a surrogate pair
  let suf = 0;
  while (suf < max - pre && a.charCodeAt(a.length - 1 - suf) === b.charCodeAt(b.length - 1 - suf)) suf++;
  if (suf > 0 && isLow(a.charCodeAt(a.length - suf))) suf--;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  let hunks = null;
  if (Math.min(am.length, bm.length) >= SPLIT_FROM) hunks = tokenHunks(am, bm);
  if (!hunks) hunks = [[0, am.length, 0, bm.length]];
  const ops = [];
  const ins = [];
  let delta = pre;
  for (const [a0, a1, b0, b1] of hunks) {
    let gone = am.slice(a0, a1);
    let put = bm.slice(b0, b1);
    let at = a0;
    // tighten to the letters that changed ("cat" → "cats" is one letter)
    let p = 0;
    while (p < gone.length && p < put.length && gone.charCodeAt(p) === put.charCodeAt(p)) p++;
    if (p > 0 && isHigh(gone.charCodeAt(p - 1))) p--;
    let s = 0;
    while (s < gone.length - p && s < put.length - p && gone.charCodeAt(gone.length - 1 - s) === put.charCodeAt(put.length - 1 - s)) s++;
    if (s > 0 && isLow(gone.charCodeAt(gone.length - s))) s--;
    gone = gone.slice(p, gone.length - s);
    put = put.slice(p, put.length - s);
    at += p;
    if (!gone.length && !put.length) continue;
    ops.push([at + delta, gone.length, put.length]);
    ins.push(put);
    delta += put.length - gone.length;
  }
  return { ops, ins };
}

// Myers' O(ND) diff over tokens. Returns [aStart, aEnd, bStart, bEnd] char
// ranges of each changed stretch, or null when the two differ in more than
// MAX_EDITS tokens (then the caller treats the middle as one replacement).
function tokenHunks(am, bm) {
  const ta = am.match(TOKEN_RE) || [];
  const tb = bm.match(TOKEN_RE) || [];
  const N = ta.length;
  const M = tb.length;
  const off = MAX_EDITS + 1;
  const v = new Int32Array(2 * off + 1);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= MAX_EDITS && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && ta[x] === tb[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { found = d; break; }
    }
  }
  if (found < 0) return null;
  // walk back from the end, collecting the matched runs
  const matches = []; // [x, y] of each token that is the same in both
  let x = N;
  let y = M;
  for (let d = found; d > 0; d--) {
    const vp = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && vp[off + k - 1] < vp[off + k + 1])) ? k + 1 : k - 1;
    const px = vp[off + prevK];
    const py = px - prevK;
    while (x > px && y > py) { x--; y--; matches.push([x, y]); }
    x = px;
    y = py;
  }
  while (x > 0 && y > 0) { x--; y--; matches.push([x, y]); }
  matches.reverse();
  // char offsets of every token boundary
  const ca = [0];
  for (const t of ta) ca.push(ca[ca.length - 1] + t.length);
  const cb = [0];
  for (const t of tb) cb.push(cb[cb.length - 1] + t.length);
  const hunks = [];
  let ia = 0;
  let ib = 0;
  for (const [mx, my] of [...matches, [N, M]]) {
    if (mx > ia || my > ib) hunks.push([ca[ia], ca[mx], cb[ib], cb[my]]);
    ia = mx + 1;
    ib = my + 1;
  }
  return hunks;
}

// Markup inside an insertion, as [offset, length] pairs, so a log with no
// text can still count the letters that were written (not the <p> around them).
function markupRanges(s) {
  const out = [];
  for (const m of s.matchAll(/<[^>]*>/g)) out.push([m.index, m[0].length]);
  return out;
}

// Ops as they're recorded: [at, del, ins] plus the markup list when there is any
function recordOps(ops, ins) {
  return ops.map((op, i) => {
    const marks = markupRanges(ins[i]);
    return marks.length ? [op[0], op[1], op[2], marks] : [op[0], op[1], op[2]];
  });
}

// Apply recorded ops to a document's text. Throws on ops that don't fit,
// which is how a replay finds a log that doesn't match its text.
function applyOps(text, ops, ins) {
  let s = text;
  ops.forEach((op, i) => {
    const [at, del, len] = op;
    const put = ins ? ins[i] : '';
    if (!(at >= 0 && del >= 0 && at + del <= s.length)) throw new Error('op out of range');
    if (put.length !== len) throw new Error('inserted text is not the recorded length');
    s = s.slice(0, at) + put + s.slice(at + del);
  });
  return s;
}
// The same, counting lengths only (a log shared without its text)
function applyLengths(length, ops) {
  let n = length;
  for (const [at, del, len] of ops) {
    if (!(at >= 0 && del >= 0 && at + del <= n)) throw new Error('op out of range');
    n += len - del;
  }
  return n;
}

/* ------------------------------------------------------------------ */
/*  Chain: numbering, linking and committing entries                   */
/* ------------------------------------------------------------------ */

// One device's chain. `n` and `head` are where it stands: the number and
// hash of its last entry (0 and null before the first).
class Chain {
  constructor({ dev, key, n = 0, head = null, now = Date.now }) {
    this.dev = dev;
    this.key = key;
    this.n = n;
    this.head = head;
    this.now = now;
  }

  // An entry, linked to the one before. `ins` is the words it adds, one
  // string per op (or a base's whole text); they're committed with this
  // entry's own salt and kept in x, which never leaves the computer unless
  // the writer exports the full replay.
  entry(kind, fields = {}, ins = null) {
    if (!KINDS.has(kind)) throw new Error('Scribe\'s Log: unknown entry kind ' + kind);
    const n = this.n + 1;
    const e = { ...fields, kind, n, prev: this.head, ts: Math.round(this.now()) }; // the chain sets these, never the caller
    if (ins && ins.some((s) => s.length)) {
      e.c = commitment(this.key, this.dev, n, ins);
      e.x = { ins };
    }
    const hash = entryHash(e);
    this.n = n;
    this.head = hash;
    return { entry: e, hash, line: JSON.stringify(e) };
  }
}

/* ------------------------------------------------------------------ */
/*  Chunks on disk                                                     */
/* ------------------------------------------------------------------ */

function chunkName(date, dev, k = 1) {
  const stamp = new Date(date).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${dev.slice(0, 8)}${k > 1 ? '-' + k : ''}.slog`;
}
const isChunkName = (name) => typeof name === 'string' && CHUNK_RE.test(name);

// Append-only, one write at a time, every write pushed to the disk before
// it counts. A write that fails part-way is cut back to the last whole line,
// so the next one never lands glued to half an entry; if even that fails the
// writer is `broken` and the caller starts a fresh chunk.
class ChunkWriter {
  constructor(file) {
    this.file = file;
    this.size = 0;
    this.pending = [];
    this.running = null;
    this.broken = null;
  }

  append(line) {
    if (this.broken) return Promise.reject(this.broken);
    return new Promise((resolve, reject) => {
      this.pending.push({ line, resolve, reject });
      if (!this.running) this.running = this.drain().finally(() => { this.running = null; });
    });
  }

  // resolves once everything handed to append has been written (or failed)
  async flush() {
    while (this.running) await this.running.catch(() => {});
  }

  async drain() {
    while (this.pending.length) {
      const batch = this.pending.splice(0);
      if (this.broken) { for (const b of batch) b.reject(this.broken); continue; }
      const buf = Buffer.from(batch.map((b) => b.line + '\n').join(''), 'utf8');
      let fh = null;
      try {
        fh = await fsp.open(this.file, 'a');
        for (let off = 0; off < buf.length;) {
          const { bytesWritten } = await fh.write(buf, off, buf.length - off);
          if (!(bytesWritten > 0)) throw Object.assign(new Error('Short write: ' + this.file), { code: 'EIO' });
          off += bytesWritten;
        }
        await fh.sync();
        this.size += buf.length;
        for (const b of batch) b.resolve();
      } catch (err) {
        try { if (fh) await fh.truncate(this.size); } catch (cut) { this.broken = cut; }
        if (!fh) this.broken = err;
        for (const b of batch) b.reject(err);
      } finally {
        if (fh) await fh.close().catch(() => {});
      }
    }
  }
}

// A chunk's text, read back. A last line without its newline is a write a
// crash cut short: it's set aside, not counted, and not an error.
function parseChunk(text) {
  const lines = String(text).split('\n');
  const tail = lines.pop();
  const entries = [];
  const problems = [];
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) return;
    let e;
    try { e = JSON.parse(line); } catch { e = null; }
    if (!e || typeof e !== 'object' || Array.isArray(e)) problems.push({ line: i + 1, problem: 'unreadable line' });
    else entries.push(e);
  });
  return { entries, partialTail: tail !== '', problems };
}

/* ------------------------------------------------------------------ */
/*  Checking a chain                                                   */
/* ------------------------------------------------------------------ */

// Chunks of one device in chain order: from the one that starts the chain,
// each next one is the chunk whose open names it. Names sort by time, but
// a clock set wrong mustn't reorder a chain, so the links decide.
function orderChunks(chunks) {
  const problems = [];
  const byPrev = new Map();
  for (const c of chunks) {
    if (!c.entries.length && !(c.problems || []).length) continue; // a first write a crash cut short: nothing to link
    const open = c.entries[0];
    const prev = open && open.kind === 'open' ? (open.prevChunk || null) : undefined;
    if (prev === undefined) { problems.push({ chunk: c.name, problem: 'doesn\'t start with an open entry' }); continue; }
    if (byPrev.has(prev)) problems.push({ chunk: c.name, problem: 'chain forks: two chunks follow ' + (prev || 'the start') });
    else byPrev.set(prev, c);
  }
  const ordered = [];
  const seen = new Set();
  let cur = byPrev.get(null);
  if (!cur && chunks.length) problems.push({ problem: 'no chunk starts the chain' });
  while (cur && !seen.has(cur.name)) {
    seen.add(cur.name);
    ordered.push(cur);
    cur = byPrev.get(cur.name);
  }
  for (const c of chunks) {
    if (!c.entries.length && !(c.problems || []).length) continue;
    if (!seen.has(c.name) && !problems.some((p) => p.chunk === c.name)) problems.push({ chunk: c.name, problem: 'not linked into the chain' });
  }
  return { ordered, problems };
}

// Check one device's chain: numbering, links, chunk headers and, when the
// key and the words are there, every commitment. Returns the problems found
// (none means intact) and notes that aren't damage (a session that ended
// without closing, a write cut short by a crash).
function verifyChain(chunks, { key = null } = {}) {
  const { ordered, problems } = orderChunks(chunks);
  const notes = [];
  let n = 0;
  let head = null;
  let dev = null;
  for (const c of chunks) {
    if (!c.entries.length && !(c.problems || []).length) notes.push({ chunk: c.name, note: 'empty: the session\'s first write was cut short' });
  }
  for (const c of ordered) {
    if (c.partialTail) notes.push({ chunk: c.name, note: 'last write cut short (crash or power loss)' });
    for (const p of c.problems || []) problems.push({ chunk: c.name, ...p });
    const open = c.entries[0];
    if (open.v !== FORMAT) problems.push({ chunk: c.name, problem: 'unknown format version ' + open.v });
    if (dev === null) dev = open.dev;
    else if (open.dev !== dev) problems.push({ chunk: c.name, problem: 'device changes mid-chain' });
    const m = CHUNK_RE.exec(c.name);
    if (m && open.dev && m[2] !== String(open.dev).slice(0, 8)) problems.push({ chunk: c.name, problem: 'file name doesn\'t match its device' });
    c.entries.forEach((e, i) => {
      const where = { chunk: c.name, n: e.n };
      if (!KINDS.has(e.kind)) problems.push({ ...where, problem: 'unknown entry kind ' + e.kind });
      if (i > 0 && e.kind === 'open') problems.push({ ...where, problem: 'open entry in mid-chunk' });
      if (e.n !== n + 1) problems.push({ ...where, problem: `numbering jumps from ${n} to ${e.n}` });
      if (e.prev !== head) problems.push({ ...where, problem: 'link to the entry before is broken' });
      let ok = true;
      try { head = entryHash(e); } catch (err) { ok = false; problems.push({ ...where, problem: 'can\'t be hashed: ' + err.message }); }
      if (!ok) head = null;
      n = typeof e.n === 'number' ? e.n : n + 1;
      if (key && e.x && Array.isArray(e.x.ins)) {
        if (e.c !== commitment(key, dev, e.n, e.x.ins)) problems.push({ ...where, problem: 'words don\'t match their commitment' });
        if (Array.isArray(e.ops)) {
          e.ops.forEach((op, j) => {
            const s = e.x.ins[j];
            if (typeof s !== 'string' || s.length !== op[2]) problems.push({ ...where, problem: 'words don\'t match the recorded length' });
            else if (canonical(markupRanges(s)) !== canonical(op[3] || [])) problems.push({ ...where, problem: 'markup list doesn\'t match the words' });
          });
        }
      } else if (e.x) problems.push({ ...where, problem: 'malformed words' });
    });
    const last = c.entries[c.entries.length - 1];
    if (!last || last.kind !== 'close') notes.push({ chunk: c.name, note: 'session ended without closing' });
  }
  return { ok: problems.length === 0, problems, notes, dev, n, head, chunks: ordered.map((c) => c.name) };
}

// Replay one device's chain into the documents as that device last saw
// them. With the words (x) it rebuilds the text; without them (a log shared
// with no text) a document's text is null and only its length is known.
// `docs` can carry a starting state (a cache); entries at or below `from`
// are skipped.
function replay(entries, { docs = {}, from = 0 } = {}) {
  const text = { ...docs };
  const length = {};
  for (const id of Object.keys(text)) length[id] = text[id] == null ? 0 : text[id].length;
  const problems = [];
  const apply = (id, start, e) => {
    const hasWords = e.x && Array.isArray(e.x.ins);
    length[id] = applyLengths(start === null ? length[id] || 0 : start.length, e.ops);
    if (hasWords && start !== null) text[id] = applyOps(start, e.ops, e.x.ins);
    else if (e.ops.every((op) => op[2] === 0) && start !== null) text[id] = applyOps(start, e.ops, e.ops.map(() => ''));
    else text[id] = null;
  };
  for (const e of entries) {
    if (e.n <= from) continue;
    const where = { n: e.n, doc: e.doc };
    try {
      if (e.kind === 'base') {
        if (length[e.doc]) throw new Error('base over a document that already has text');
        apply(e.doc, '', e);
      } else if (e.kind === 'edit') {
        if (!(e.doc in length)) throw new Error('edit to a document the log never saw');
        apply(e.doc, text[e.doc], e);
      } else if (e.kind === 'doc') {
        if (e.act === 'new') {
          if (length[e.doc]) throw new Error('new document over one that has text');
          text[e.doc] = '';
          length[e.doc] = 0;
        } else if (e.act === 'del') {
          if (!(e.doc in length)) throw new Error('deleting a document the log never saw');
          delete text[e.doc];
          delete length[e.doc];
        }
      }
    } catch (err) {
      problems.push({ ...where, problem: err.message });
    }
  }
  return { docs: text, lengths: length, problems };
}

module.exports = {
  FORMAT, LOG_DIR, LOG_INFO, KINDS, CHUNK_RE,
  canonical, sha256hex, clearPart, entryHash, saltFor, commitment, keyId,
  normalizeManuscript, manuscriptHash, newDeviceId, newLogInfo,
  diff, markupRanges, recordOps, applyOps, applyLengths,
  Chain, chunkName, isChunkName, ChunkWriter, parseChunk,
  orderChunks, verifyChain, replay
};
