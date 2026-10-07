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
// This file is plain functions, a small append-only writer, and the
// Recorder that keeps each book's log. It runs in the main process (the
// window never touches the disk) and in node:test.

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const FORMAT = 1;
const LOG_DIR = 'scribes-log';
const LOG_INFO = 'log.json';
const KINDS = new Set(['open', 'edit', 'base', 'doc', 'on', 'off', 'sleep', 'wake', 'clock', 'close', 'stamp']);
// 20261007T160512Z-7f3a9c2e.slog, with -2, -3… if a name is ever taken
const CHUNK_RE = /^(\d{8}T\d{6}Z)-([0-9a-f]{8})(?:-([1-9]\d{0,3}))?\.slog$/;
// what Windows says while something else has a file open for a moment
const BUSY = ['EPERM', 'EACCES', 'EBUSY'];

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
    // the chain sets these four, never the caller; they lead each line so it reads easily
    const e = { kind, n, prev: this.head, ts: Math.round(this.now()) };
    for (const k of Object.keys(fields)) if (!(k in e) && k !== 'c' && k !== 'x') e[k] = fields[k];
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
// so nothing is left glued to half an entry, and the writer is `broken`
// from then on: the lines queued behind it would link to entries that never
// reached the disk. The caller starts a fresh chunk.
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
        fh = await openSoon(this.file);
        for (let off = 0; off < buf.length;) {
          const { bytesWritten } = await fh.write(buf, off, buf.length - off);
          if (!(bytesWritten > 0)) throw Object.assign(new Error('Short write: ' + this.file), { code: 'EIO' });
          off += bytesWritten;
        }
        await fh.sync();
        this.size += buf.length;
        for (const b of batch) b.resolve();
      } catch (err) {
        try { if (fh) await fh.truncate(this.size); } catch { /* a reader sets the half line aside */ }
        this.broken = err;
        for (const b of batch) b.reject(err);
      } finally {
        if (fh) await fh.close().catch(() => {});
      }
    }
  }
}

// The same patience for opening a chunk that a sync client is reading
async function openSoon(file) {
  for (let wait = 5; ; wait *= 2) {
    try { return await fsp.open(file, 'a'); } catch (err) {
      if (process.platform !== 'win32' || wait > 640 || !BUSY.includes(err.code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, wait));
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

/* ------------------------------------------------------------------ */
/*  Documents: what the log calls each file, and its text              */
/* ------------------------------------------------------------------ */

// A book's documents are its chapters (each by its own id), notes.html,
// outline.html, darlings.json, stickies.json and book.json. Other files in
// the folder (covers, art.json) aren't writing and aren't logged.
const AUX_DOCS = ['notes', 'outline'];
const JSON_DOCS = ['darlings', 'stickies'];
const NAMED_DOCS = new Set(['book', ...AUX_DOCS, ...JSON_DOCS]);

// A chapter's document is its id. A chapter file named like one of the
// others (only ever a folder edited by hand) gets "ch:" in front.
const chapterDoc = (id) => (NAMED_DOCS.has(id) ? 'ch:' + id : id);
function docChapter(doc) {
  if (NAMED_DOCS.has(doc)) return null;
  return doc.startsWith('ch:') && NAMED_DOCS.has(doc.slice(3)) ? doc.slice(3) : doc;
}
// the document behind a main-process read or write, or null when it isn't logged
function docOf(kind, name) {
  if (kind === 'book') return 'book';
  if (typeof name !== 'string' || !name) return null;
  if (kind === 'chapter') return chapterDoc(name);
  if (kind === 'aux') return AUX_DOCS.includes(name) ? name : null;
  if (kind === 'json') return JSON_DOCS.includes(name) ? name : null;
  return null;
}

// book.json fields that change on their own (where the caret was, word
// counts, when it was saved) or that aren't the writing (covers, the
// export id, the folder's own name, this log's switch). The rest is the
// book's metadata: title, author, chapter order and titles, notes on
// sections and scenes.
const BOOK_SKIP = new Set(['id', 'lastPosition', 'modified', 'wordCount', 'dailyCounts', 'scribesLog',
  'uuid', 'coverArt', 'coverImage', 'coverMode', 'coverSeed']);

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
    return o;
  }
  return v;
}

// The book document: book.json without the fields above, without empty
// values (NEO fills in `chapterTitles: {}` and the like after opening; the
// same book either way), keys sorted, two-space indents.
function bookText(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const c = {};
  for (const k of Object.keys(meta).sort()) {
    if (BOOK_SKIP.has(k)) continue;
    const v = meta[k];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'object' && Object.keys(v).length === 0) continue;
    c[k] = sortKeys(v);
  }
  return JSON.stringify(c, null, 2);
}
// Darlings and comments: the list as NEO writes the file
const jsonText = (data) => (data === undefined ? null : JSON.stringify(data, null, 2));

// Which fields of the book document an edit changed, so a log without its
// words still shows that the author's name changed (not what to)
function bookKeys(before, after) {
  const parse = (t) => { try { const v = JSON.parse(t); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
  const a = parse(before);
  const b = parse(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

// The manuscript as text, read from the documents themselves so anyone
// replaying a log gets the same result: each chapter in the book's order
// (a Contents page left out), each <p> one line, a scene break "***". What
// NEO keeps out of every export stays out here too: an unwritten outline
// section (a ghost paragraph and the break planted for it), placeholder
// flags and Darlings anchors.
const VOID_TAGS = new Set(['br', 'img', 'hr', 'wbr', 'input', 'col', 'area', 'embed', 'source', 'track', 'meta', 'link', 'base', 'param']);
const LEFT_OUT = ['ghost', 'ph-mark', 'darling-anchor'];
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: '\u00a0' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}
function attrOf(attrs, name) {
  const m = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3]) : null;
}
const classesOf = (attrs) => new Set((attrOf(attrs, 'class') || '').split(/\s+/).filter(Boolean));

function chapterLines(html) {
  const src = String(html || '');
  const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;
  // the breaks planted for unwritten sections
  const ghosts = new Set();
  for (const m of src.matchAll(TAG)) {
    if (m[2] && !m[1] && m[2].toLowerCase() === 'p' && classesOf(m[3]).has('ghost')) {
      const id = attrOf(m[3], 'data-sec-id');
      if (id !== null) ghosts.add(id);
    }
  }
  const lines = [];
  const stack = []; // open elements: { name, out }
  let out = 0;      // how many of them are left out
  let para = null;
  const endPara = () => {
    if (!para) return;
    if (!para.out) {
      if (para.brk) lines.push('***');
      else if (para.text.trim()) lines.push(para.text.trim());
    }
    para = null;
  };
  for (const m of src.matchAll(TAG)) {
    const tok = m[0];
    if (tok.startsWith('<!--')) continue;
    if (!m[2]) { if (para && !out) para.text += decodeEntities(tok); continue; }
    const name = m[2].toLowerCase();
    if (!m[1]) {
      const cls = classesOf(m[3]);
      if (name === 'p') {
        endPara(); // a <p> left open ends where the next begins
        while (stack.length) if (stack.pop().out) out--;
        const brk = cls.has('scene-break');
        para = { text: '', brk, out: (brk && ghosts.has(attrOf(m[3], 'data-sec-brk'))) || cls.has('ghost') };
        stack.push({ name, out: false });
        continue;
      }
      if (VOID_TAGS.has(name) || /\/\s*$/.test(m[3])) {
        if (name === 'br' && para && !out) para.text += '\n';
        continue;
      }
      const left = LEFT_OUT.some((c) => cls.has(c));
      stack.push({ name, out: left });
      if (left) out++;
      continue;
    }
    // a closing tag closes back to its own opening tag, if it has one
    let i = stack.length - 1;
    while (i >= 0 && stack[i].name !== name) i--;
    if (i < 0) continue;
    while (stack.length > i) if (stack.pop().out) out--;
    if (name === 'p') endPara();
  }
  endPara();
  return lines;
}

function manuscriptText(docs) {
  let meta = null;
  try { meta = JSON.parse(docs.book); } catch { /* no book document */ }
  const order = meta && Array.isArray(meta.chapterOrder)
    ? meta.chapterOrder
    : Object.keys(docs).filter((d) => docChapter(d) !== null).map(docChapter).sort();
  const kinds = (meta && meta.chapterKinds) || {};
  const lines = [];
  for (const id of order) {
    if (kinds[id] === 'contents') continue;
    const html = docs[chapterDoc(id)];
    if (typeof html === 'string') lines.push(...chapterLines(html));
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/*  Small file helpers                                                 */
/* ------------------------------------------------------------------ */

function readQuiet(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
function parseQuiet(text) {
  if (typeof text !== 'string') return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}
function sizeOf(file) {
  try { return fs.statSync(file).size; } catch { return -1; }
}
// Beside, pushed to the disk, then swapped in. With keep, a file that's
// already there wins (log.json is made once, and a synced copy may arrive
// first): false says so.
function writeWhole(file, text, { keep = false } = {}) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (keep && fs.existsSync(file)) {
    try { fs.unlinkSync(tmp); } catch { /* left beside it, harmless */ }
    return false;
  }
  renameSoon(tmp, file);
  return true;
}
// Windows refuses a rename while anything has the file open for a moment
// (antivirus, the indexer, a sync client): wait a beat and try again
function renameSoon(from, to) {
  for (let wait = 5; ; wait *= 2) {
    try { return fs.renameSync(from, to); } catch (err) {
      if (process.platform !== 'win32' || wait > 320 || !BUSY.includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
}

// The documents of a book folder as they stand on disk. `held` names the
// ones a sync service is still holding back (iCloud's .name.icloud) or that
// can't be read whole right now: not there isn't the same as deleted.
function readBookDocs(dir) {
  const docs = {};
  const held = new Set();
  const rawMeta = readQuiet(path.join(dir, 'book.json'));
  const meta = parseQuiet(rawMeta);
  const book = bookText(meta);
  if (book !== null) docs.book = book;
  else held.add('book');
  let files = [];
  try { files = fs.readdirSync(path.join(dir, 'chapters')); } catch { /* none yet */ }
  const ids = files.filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5));
  for (const f of files) {
    const m = /^\.(.+)\.html\.icloud$/.exec(f);
    if (m) held.add(chapterDoc(m[1]));
  }
  const order = meta && Array.isArray(meta.chapterOrder) ? meta.chapterOrder.filter((id) => ids.includes(id)) : [];
  for (const id of [...new Set(order), ...ids.filter((id) => !order.includes(id)).sort()]) {
    const t = readQuiet(path.join(dir, 'chapters', id + '.html'));
    if (t === null) held.add(chapterDoc(id));
    else docs[chapterDoc(id)] = t;
  }
  for (const name of AUX_DOCS) {
    const t = readQuiet(path.join(dir, name + '.html'));
    if (t !== null) docs[name] = t;
  }
  for (const name of JSON_DOCS) {
    const raw = readQuiet(path.join(dir, name + '.json'));
    if (raw === null) continue;
    const v = parseQuiet(raw);
    if (v === undefined) held.add(name);
    else docs[name] = jsonText(v);
  }
  return { docs, held };
}

// What an import entry says about the file it came from: when it was last
// changed and its fingerprint. Never its name.
function fileFacts(file) {
  const st = fs.statSync(file);
  return { mtime: Math.round(st.mtimeMs), sha256: sha256hex(fs.readFileSync(file)) };
}

// How far the wall clock moved against the steady one between two looks,
// when it's more than a minute either way (otherwise 0)
function clockJump(wall0, mono0, wall1, mono1, limit = 60000) {
  const jump = Math.round((wall1 - wall0) - (mono1 - mono0));
  return Math.abs(jump) > limit ? jump : 0;
}

/* ------------------------------------------------------------------ */
/*  The Recorder: each book's log, kept by the main process            */
/* ------------------------------------------------------------------ */

// The window says how text changed; the main process sees every file a book
// reads and writes. The Recorder keeps the log's own copy of each document
// (`docs`), turns each change into an entry, and squares the log with the
// disk whenever it finds text it didn't record, so the log always ends in
// exactly what's on disk. It never blocks a save: entries go to the disk on
// their own queue, and a failure is reported and caught up later.
//
// A session is one book as this device has it open. Its chunk (one file of
// entries) starts with the first entry and closes when the book closes, NEO
// quits, the writing stops for half an hour, the log is switched off, or the
// chunk reaches 8 MB. `disk` is each document as this process last read or
// wrote it; it's how a change that arrived from another device is told apart
// from words the window has observed but not yet saved.

const IDLE_MS = 30 * 60 * 1000;
const MAX_CHUNK = 8 * 1024 * 1024;
const IMPORT_MS = 2 * 60 * 1000;   // how long a new imported book's first writes count as the import
const RETRY_MS = 30 * 1000;        // after a write fails, how long before the log tries the disk again
const WINDOW_SRC = new Set(['typed', 'paste', 'drop', 'move', 'import', 'arrived']);
const CAUSES = new Set(['undo', 'redo', 'replace', 'outline', 'split', 'join', 'spell', 'darling', 'placeholder']);

const wholeAtLeast = (v, min) => Number.isSafeInteger(v) && v >= min;
function cleanFrom(f) {
  if (!f || typeof f !== 'object') return undefined;
  if (wholeAtLeast(f.n, 1) && wholeAtLeast(f.op, 0) && wholeAtLeast(f.off, 0)) return { n: f.n, op: f.op, off: f.off };
  if (typeof f.doc === 'string' && f.doc && f.doc.length <= 200 && wholeAtLeast(f.at, 0)) return { doc: f.doc, at: f.at };
  if (typeof f.log === 'string' && /^[0-9a-f]{16}$/.test(f.log)) return { log: f.log };
  return undefined;
}
// A label from the window, cut down to what the format allows
function cleanLabel(label) {
  const l = label && typeof label === 'object' ? label : {};
  const how = { src: WINDOW_SRC.has(l.src) ? l.src : 'unlogged' };
  if (CAUSES.has(l.cause)) how.cause = l.cause;
  if (wholeAtLeast(l.dur, 0)) how.dur = l.dur;
  if (wholeAtLeast(l.ev, 0)) how.ev = l.ev;
  if (how.src === 'move') {
    const from = cleanFrom(l.from);
    if (from) how.from = from;
  }
  return how;
}

function validInfo(v) {
  return !!v && v.v === FORMAT && typeof v.logId === 'string' && /^[0-9a-f]{16}$/.test(v.logId) &&
    typeof v.key === 'string' && Buffer.from(v.key, 'base64').length === 32;
}

class Recorder {
  // home: this computer's own folder for the log (Electron's userData/slog):
  // the device id and each book's cached state. Never inside the library.
  constructor({ home, app = '', now = Date.now, onError = () => {}, onChange = () => {}, idleMs = IDLE_MS, maxChunk = MAX_CHUNK }) {
    this.home = home;
    this.idleMs = idleMs;
    this.maxChunk = maxChunk;
    this.app = String(app);
    this.now = now;
    this.onError = onError;
    this.onChange = onChange;
    this.sessions = new Map();
    this.imports = new Map();
    this.dev = null;
  }

  // 128 random bits, made once per installation
  device() {
    if (this.dev) return this.dev;
    const file = path.join(this.home, 'device.json');
    const have = parseQuiet(readQuiet(file));
    if (have && typeof have.dev === 'string' && /^[0-9a-f]{32}$/.test(have.dev)) return (this.dev = have.dev);
    fs.mkdirSync(this.home, { recursive: true });
    const dev = newDeviceId();
    writeWhole(file, JSON.stringify({ dev }, null, 2) + '\n');
    return (this.dev = dev);
  }

  /* ---- what main.js calls ---- */

  // The writer opened the book in NEO
  open(dir, bookId) {
    this.session(dir, bookId, { start: true });
    return this.status(dir, bookId);
  }

  // About to write one of the book's documents: the log squares itself
  // with the disk first, so the write that follows is the only change.
  touch(dir, bookId) {
    return this.session(dir, bookId, { start: true });
  }

  // About to write book.json. Saving the caret's place (or a cover) in a
  // book that has no log yet doesn't start one; changing the book does.
  beforeMeta(dir, bookId, meta) {
    if (this.sessions.has(bookId)) return;
    if (fs.existsSync(path.join(dir, LOG_DIR, LOG_INFO))) { this.session(dir, bookId, { start: true }); return; }
    if (meta && meta.scribesLog === false) return;
    const old = parseQuiet(readQuiet(path.join(dir, 'book.json')));
    if (old && old.scribesLog !== false && bookText(old) === bookText(meta)) return;
    this.session(dir, bookId, { start: true });
  }

  // A document reached the disk from this device. Text the window already
  // described matches and adds nothing; anything else is logged as it is.
  wrote(dir, bookId, doc, text) {
    const s = this.sessions.get(bookId);
    if (!s || s.dir !== dir || !s.on || !s.info || doc == null || typeof text !== 'string') return;
    const importing = s.imported && this.now() < s.importUntil;
    if (!importing) s.imported = null;
    this._put(s, doc, text, importing ? { base: 'import', src: 'import', file: s.imported } : { src: 'unlogged' });
    s.disk[doc] = text;
  }

  // A document was read. Text on disk that this process didn't put there
  // came from another device. When the window has words of its own not yet
  // saved, the two meet in the window (adopted, or kept as a chapter of its
  // own) and are logged when it writes; nothing is decided here.
  read(dir, bookId, doc, text) {
    const s = this.sessions.get(bookId);
    if (!s || s.dir !== dir || !s.on || !s.info || doc == null || typeof text !== 'string' || text === '') return;
    if (s.disk[doc] === text) return;
    const inStep = s.docs[doc] === s.disk[doc];
    s.disk[doc] = text;
    if (inStep) this._put(s, doc, text, s.docs[doc] === undefined ? { base: 'arrived', src: 'arrived' } : { src: 'arrived' });
  }

  // A chapter file was deleted by this device
  removed(dir, bookId, doc) {
    const s = this.sessions.get(bookId);
    if (!s || s.dir !== dir || !s.on || !s.info || doc == null) return;
    this._remove(s, doc, { src: 'unlogged' });
  }

  // The window says how a document changed: its text now, and how it got
  // that way (typed, pasted, moved…). Returns whether it was taken.
  observe(dir, bookId, doc, text, label) {
    const s = this.session(dir, bookId, { start: true });
    if (!s.on || !s.info || doc == null || typeof text !== 'string') return false;
    const how = cleanLabel(label);
    if (how.src !== 'import') s.imported = null;
    if (s.docs[doc] === undefined && (how.src === 'import' || how.src === 'arrived')) {
      how.base = how.src;
      if (how.src === 'import' && s.imported) how.file = s.imported;
    }
    this._put(s, doc, text, how);
    return true;
  }

  // A file was read in for import. The token travels with the parsed book
  // to book:create, which ties the new book's first text to this file.
  rememberImport(facts) {
    const at = this.now();
    for (const [k, v] of this.imports) if (at - v.at > 10 * 60 * 1000) this.imports.delete(k);
    const token = crypto.randomBytes(8).toString('hex');
    this.imports.set(token, { facts, at });
    return token;
  }

  // book:create made a new book folder
  created(dir, bookId, token) {
    const imp = typeof token === 'string' ? this.imports.get(token) : null;
    if (imp) this.imports.delete(token);
    const s = this.session(dir, bookId, { start: true, mode: imp ? 'import' : 'new', file: imp ? imp.facts : null });
    if (imp && s.info) {
      s.imported = imp.facts;
      s.importUntil = this.now() + IMPORT_MS;
    }
  }

  // book.json was written: the book document, and the log's switch
  metaWritten(dir, bookId, meta) {
    const s = this.sessions.get(bookId);
    if (!s || s.dir !== dir || !meta || typeof meta !== 'object') return;
    const on = meta.scribesLog !== false;
    if (s.on && !on) {
      if (s.info) {
        this.wrote(dir, bookId, 'book', bookText(meta));
        this._append(s, 'off', {});
        this._close(s, 'off');
      }
      s.on = false;
      this.onChange(bookId);
      return;
    }
    if (!s.on && on) {
      s.on = true;
      if (!s.info) {
        if (!s.unreadable) this._attach(s, this._makeInfo(s.dir), 'baseline');
      } else {
        this._append(s, 'on', {});
        this._reconcile(s, 'off');
      }
      this.onChange(bookId);
      return;
    }
    if (s.on) this.wrote(dir, bookId, 'book', bookText(meta));
  }

  // sleep, wake, clock: noted in every chunk being written
  event(kind, fields = {}) {
    for (const s of this.sessions.values()) if (s.on && s.info && s.chunk) this._append(s, kind, fields);
  }

  status(dir, bookId) {
    const s = this.sessions.get(bookId);
    if (s && s.dir === dir) return { on: s.on, logging: !!s.info, n: s.chain ? s.chain.n : 0, chunk: s.chunk ? s.chunk.name : null };
    const meta = parseQuiet(readQuiet(path.join(dir, 'book.json')));
    return { on: !(meta && meta.scribesLog === false), logging: fs.existsSync(path.join(dir, LOG_DIR, LOG_INFO)), n: null, chunk: null };
  }

  // The book closed: its chunk ends. Resolves once the last line is down.
  close(bookId, why = 'close') {
    const s = this.sessions.get(bookId);
    return s ? this._close(s, why) : Promise.resolve();
  }
  // …and the session is let go (the book's folder is going away)
  drop(bookId, why = 'close') {
    const s = this.sessions.get(bookId);
    if (!s) return Promise.resolve();
    this.sessions.delete(bookId);
    return this._close(s, why);
  }
  closeAll(why = 'quit') {
    return Promise.all([...this.sessions.values()].map((s) => this._close(s, why))).then(() => {});
  }
  busy() {
    return [...this.sessions.values()].some((s) => s.chunk || s.closing);
  }

  /* ---- sessions ---- */

  session(dir, bookId, { start = false, mode = null, file = null } = {}) {
    let s = this.sessions.get(bookId);
    if (s && s.dir !== dir) { this.drop(bookId); s = null; }
    if (!s) {
      const meta = parseQuiet(readQuiet(path.join(dir, 'book.json')));
      s = {
        bookId, dir, on: !(meta && meta.scribesLog === false),
        info: null, key: null, unreadable: false, chain: null, docs: {}, disk: {},
        chunk: null, last: null, count: 0, failed: 0, idle: null, closing: null, saved: 0,
        imported: null, importUntil: 0
      };
      this.sessions.set(bookId, s);
      const raw = readQuiet(path.join(dir, LOG_DIR, LOG_INFO));
      if (raw !== null) {
        const info = parseQuiet(raw);
        if (validInfo(info)) this._attach(s, info, 'arrived');
        else {
          // a log.json this version can't read: leave the log alone
          s.unreadable = true;
          this.onError('log.json', new Error(bookId + ': unreadable or from a newer NEO; this book isn\'t logged'));
        }
      }
    }
    if (start && s.on && !s.info && !s.unreadable) this._attach(s, this._makeInfo(dir), mode || 'baseline', file);
    return s;
  }

  _makeInfo(dir) {
    const logDir = path.join(dir, LOG_DIR);
    fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, LOG_INFO);
    const info = newLogInfo();
    if (writeWhole(file, JSON.stringify(info, null, 2) + '\n', { keep: true })) return info;
    const there = parseQuiet(readQuiet(file));
    if (validInfo(there)) return there;
    throw new Error('Scribe\'s Log: can\'t read ' + file);
  }

  // A log for the book is now in hand: pick up this device's chain where it
  // left off, and (when logging) square it with the disk.
  _attach(s, info, mode, file = null) {
    s.info = info;
    s.key = Buffer.from(info.key, 'base64');
    const st = this._chainState(s, true);
    s.chain = new Chain({ dev: this.device(), key: s.key, n: st.n, head: st.head, now: this.now });
    s.last = st.last;
    s.count = st.count;
    s.saved = st.n;
    s.docs = { ...st.docs };
    s.disk = { ...st.docs };
    if (s.on) this._reconcile(s, mode, file);
  }

  _cacheFile(s) {
    return path.join(this.home, `${s.info.logId}-${sha256hex(s.bookId).slice(0, 8)}.json`);
  }

  // Where this device's chain stands: from the cache when it matches the
  // chunks on disk exactly, otherwise by reading and replaying them.
  _chainState(s, useCache) {
    const dev = this.device();
    const logDir = path.join(s.dir, LOG_DIR);
    let names = [];
    try {
      names = fs.readdirSync(logDir).filter((f) => {
        const m = CHUNK_RE.exec(f);
        return m && m[2] === dev.slice(0, 8);
      });
    } catch { /* no chunks yet */ }
    if (useCache) {
      const c = parseQuiet(readQuiet(this._cacheFile(s)));
      if (c && c.v === 1 && c.dev === dev && c.logId === s.info.logId && c.bookId === s.bookId &&
          c.count === names.length && Number.isSafeInteger(c.n) && c.docs && typeof c.docs === 'object' &&
          (c.count === 0 ? c.n === 0 : names.includes(c.last) && sizeOf(path.join(logDir, c.last)) === c.size)) {
        return { n: c.n, head: c.head, last: c.last, count: c.count, docs: c.docs };
      }
    }
    const chunks = [];
    for (const name of names) {
      const parsed = parseChunk(readQuiet(path.join(logDir, name)) || '');
      const open = parsed.entries[0];
      if (open && open.dev !== dev) continue; // another device whose id starts the same way
      chunks.push({ name, ...parsed });
    }
    const v = verifyChain(chunks, { key: s.key });
    if (!v.ok) this.onError('check', new Error(`${s.bookId}: this device's chain has ${v.problems.length} problem(s); first: ${JSON.stringify(v.problems[0])}`));
    const byName = new Map(chunks.map((c) => [c.name, c]));
    const r = replay(v.chunks.flatMap((name) => byName.get(name).entries));
    if (r.problems.length) this.onError('replay', new Error(`${s.bookId}: ${r.problems.length} entr(ies) didn't replay; first: ${JSON.stringify(r.problems[0])}`));
    const docs = {};
    for (const [id, t] of Object.entries(r.docs)) if (typeof t === 'string') docs[id] = t;
    return { n: v.n, head: v.head, last: v.chunks[v.chunks.length - 1] || null, count: names.length, docs };
  }

  // Log whatever on disk differs from the log's copy
  _reconcile(s, mode, file = null) {
    const { docs, held } = readBookDocs(s.dir);
    this._sync(s, docs, mode, held, file);
    for (const [doc, t] of Object.entries(docs)) s.disk[doc] = t;
  }

  // Bring the log's copy to `target`, entry by entry
  _sync(s, target, mode, held = new Set(), file = null) {
    for (const [doc, text] of Object.entries(target)) {
      if (s.docs[doc] !== text) this._put(s, doc, text, this._how(mode, doc, s.docs[doc] === undefined, file));
    }
    for (const doc of Object.keys(s.docs)) {
      if (doc in target || held.has(doc) || docChapter(doc) === null) continue;
      this._remove(s, doc, this._how(mode, doc, false, file));
    }
  }

  _how(mode, doc, isNew, file) {
    switch (mode) {
      case 'baseline': return isNew ? { base: 'baseline', src: 'arrived' } : { src: 'arrived' };
      case 'arrived': return isNew ? { base: 'arrived', src: 'arrived' } : { src: 'arrived' };
      case 'off': return { src: 'unlogged', cause: 'off' };
      case 'new': return { src: 'typed' };
      case 'import': return doc === 'book' && isNew ? { base: 'import', src: 'import', file } : { src: 'typed' };
      default: return { src: 'unlogged' };
    }
  }

  // One document to new text: a base, or a new document and an edit
  _put(s, doc, text, how) {
    const old = s.docs[doc];
    if (old === text) return;
    if (old === undefined) {
      if (how.base && text) {
        const fields = { doc, src: how.base, ops: recordOps([[0, 0, text.length]], [text]) };
        if (how.base === 'import' && how.file) fields.file = { mtime: how.file.mtime, sha256: how.file.sha256 };
        this._append(s, 'base', fields, [text]);
        s.docs[doc] = text;
        return;
      }
      this._append(s, 'doc', { doc, act: 'new' });
      s.docs[doc] = '';
      if (!text) return;
    }
    const before = s.docs[doc];
    const { ops, ins } = diff(before, text);
    const fields = { doc, src: how.src || 'unlogged', ops: recordOps(ops, ins) };
    for (const k of ['cause', 'from', 'dur', 'ev']) if (how[k] !== undefined) fields[k] = how[k];
    if (doc === 'book') {
      const keys = bookKeys(before, text);
      if (keys.length) fields.keys = keys;
    }
    this._append(s, 'edit', fields, ins);
    s.docs[doc] = text;
  }

  // A document gone: its text deleted (so a later move can point at it),
  // then the document itself
  _remove(s, doc, how) {
    const old = s.docs[doc];
    if (old === undefined) return;
    if (old) {
      const fields = { doc, src: how.src || 'unlogged', ops: [[0, old.length, 0]] };
      if (how.cause) fields.cause = how.cause;
      this._append(s, 'edit', fields);
    }
    this._append(s, 'doc', { doc, act: 'del' });
    delete s.docs[doc];
    delete s.disk[doc];
  }

  /* ---- chunks ---- */

  _append(s, kind, fields, ins = null) {
    if (!s.info) return null;
    if (s.failed) {
      // the disk refused a write: the chain on disk is behind the one in
      // memory. A little later, pick it up from the disk and log what
      // happened meanwhile as unlogged.
      if (this.now() - s.failed < RETRY_MS || !this._recover(s)) return null;
    }
    try {
      if (!s.chunk) this._open(s);
      return this._write(s, kind, fields, ins);
    } catch (err) {
      this._failed(s, s.chunk, err);
      return null;
    }
  }

  _open(s) {
    const dev = this.device();
    const logDir = path.join(s.dir, LOG_DIR);
    fs.mkdirSync(logDir, { recursive: true });
    let name;
    for (let k = 1; ; k++) {
      name = chunkName(this.now(), dev, k);
      if (name !== s.last && !fs.existsSync(path.join(logDir, name))) break;
    }
    const prevChunk = s.last;
    s.chunk = { name, writer: new ChunkWriter(path.join(logDir, name)), bytes: 0, failed: false };
    s.last = name;
    s.count += 1;
    this._write(s, 'open', { v: FORMAT, log: s.info.logId, dev, prevChunk, app: this.app });
  }

  _write(s, kind, fields, ins = null) {
    const chunk = s.chunk;
    const { entry, line } = s.chain.entry(kind, fields, ins);
    chunk.bytes += Buffer.byteLength(line, 'utf8') + 1;
    chunk.writer.append(line).catch((err) => this._failed(s, chunk, err));
    if (kind !== 'close') {
      this._idle(s);
      if (chunk.bytes >= this.maxChunk) this._close(s, 'size');
    }
    return entry;
  }

  _failed(s, chunk, err) {
    if (chunk) {
      if (chunk.failed) return;
      chunk.failed = true;
      if (s.chunk === chunk) s.chunk = null;
    }
    clearTimeout(s.idle);
    this.onError('write', err);
    s.failed = this.now();
  }

  _recover(s) {
    s.failed = 0;
    s.chunk = null;
    let st;
    try { st = this._chainState(s, false); } catch (err) {
      this.onError('recover', err);
      s.failed = this.now();
      return false;
    }
    s.chain = new Chain({ dev: this.device(), key: s.key, n: st.n, head: st.head, now: this.now });
    s.last = st.last;
    s.count = st.count;
    const want = s.docs;
    s.docs = { ...st.docs };
    this._sync(s, want, 'unlogged');
    return !s.failed;
  }

  _idle(s) {
    clearTimeout(s.idle);
    s.idle = setTimeout(() => { this._close(s, 'idle'); }, this.idleMs);
    if (s.idle.unref) s.idle.unref();
  }

  // The chunk's last line: why it ended, and the manuscript's fingerprint.
  // Once it's on disk, the session's state is cached for next time.
  _close(s, why) {
    clearTimeout(s.idle);
    s.idle = null;
    const chunk = s.chunk;
    if (!chunk) return s.closing || Promise.resolve();
    this._write(s, 'close', { why, ms: manuscriptHash(manuscriptText(s.docs)) });
    s.chunk = null;
    const snap = {
      v: 1, bookId: s.bookId, logId: s.info.logId, dev: this.device(),
      n: s.chain.n, head: s.chain.head, last: chunk.name, count: s.count, size: chunk.bytes, docs: { ...s.docs }
    };
    const done = chunk.writer.flush().then(() => {
      if (chunk.writer.broken || chunk.failed || chunk.writer.size !== snap.size || snap.n < s.saved) return;
      s.saved = snap.n;
      try {
        fs.mkdirSync(this.home, { recursive: true });
        writeWhole(this._cacheFile(s), JSON.stringify(snap));
      } catch (err) { this.onError('cache', err); }
    }).finally(() => { if (s.closing === done) s.closing = null; });
    s.closing = done;
    return done;
  }
}

module.exports = {
  FORMAT, LOG_DIR, LOG_INFO, KINDS, CHUNK_RE,
  canonical, sha256hex, clearPart, entryHash, saltFor, commitment, keyId,
  normalizeManuscript, manuscriptHash, newDeviceId, newLogInfo,
  diff, markupRanges, recordOps, applyOps, applyLengths,
  Chain, chunkName, isChunkName, ChunkWriter, parseChunk,
  orderChunks, verifyChain, replay,
  AUX_DOCS, JSON_DOCS, chapterDoc, docChapter, docOf, bookText, jsonText, bookKeys,
  chapterLines, manuscriptText, readBookDocs, fileFacts, clockJump, cleanLabel,
  Recorder, IDLE_MS, MAX_CHUNK
};
