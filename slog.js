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
const V = require('./slog-verify.js');
const F = require('./slog-files.js');

const FORMAT = 1;          // log.json's version
const CHUNK_FORMAT = 2;    // a chunk's (its open line's v); 2 adds stamp entries, and 1 still reads
const LOG_DIR = 'scribes-log';
const LOG_INFO = 'log.json';
// what Windows says while something else has a file open for a moment
const BUSY = ['EPERM', 'EACCES', 'EBUSY'];

/* ------------------------------------------------------------------ */
/*  Hashing                                                            */
/* ------------------------------------------------------------------ */

// Hashing is the checker's (slog-verify.js), with Node's crypto put in:
// the same bytes as its plain JavaScript, faster.
const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
V.useHash({ sha256hex, hmac: (key, s) => crypto.createHmac('sha256', key).update(s).digest() });
const { canonical, clearPart, entryHash, saltFor, commitment, normalizeManuscript, manuscriptHash } = V;
const keyId = (key) => sha256hex(key).slice(0, 16);

const newDeviceId = () => crypto.randomBytes(16).toString('hex');
function newLogInfo() {
  return { v: FORMAT, logId: crypto.randomBytes(8).toString('hex'), key: crypto.randomBytes(32).toString('base64') };
}

/* ------------------------------------------------------------------ */
/*  Diff: what changed between two versions of a document              */
/* ------------------------------------------------------------------ */

// Ops are [at, del, ins] in UTF-16 units of the document's saved HTML,
// applied in order, each `at` measured after the ops before it. The
// inserted strings travel separately (an entry's x.ins), one per op. The
// diff itself is slog-diff.js's, shared with the History window: past the
// shared start and end, two versions are compared word by word (Myers'
// algorithm, capped), so two edits far apart in one burst never become one
// replacement of everything between them.
const { diff, tokenHunks } = require('./slog-diff.js');

const { markupRanges, applyOps, applyLengths } = V;

// Ops as they're recorded: [at, del, ins] plus the markup list when there is any
function recordOps(ops, ins) {
  return ops.map((op, i) => {
    const marks = markupRanges(ins[i]);
    return marks.length ? [op[0], op[1], op[2], marks] : [op[0], op[1], op[2]];
  });
}

/* ------------------------------------------------------------------ */
/*  Where moved text came from                                         */
/* ------------------------------------------------------------------ */

// Text that turns up again keeps the origin it had. Deleted and brought
// back (an undo, a cut pasted back, a passage sent to Darlings and
// restored), carried from one chapter to another (a split, a card moved),
// or copied from elsewhere in the book: its edit says where it was, in
// `from`, and a checker carries the origin across. So pasting words from
// outside, deleting them and undoing the delete still leaves them pasted.
//
// Matches are exact and hold at least MOVE_MIN units of text outside tags,
// so a common phrase typed again isn't taken for a move. When the window
// says words were moved (a paste of NEO's own clipboard, an undo, one of
// NEO's tools), a shorter insertion found whole counts too, and so does a
// recent deletion found whole inside it (a short passage sent to Darlings
// arrives wrapped in the list's JSON). `from` is a list
// of pieces, [op, at, len, source]: units at..at+len of op `op`'s inserted
// string came from `source`, which is one of
//   { n, op, at }   text deleted by op `op` of entry `n` in this chain
//   { doc, at }     text in a document as it stood just before this entry
//   { log }         text from another NEO book
// with `len` in the source when its length differs (one character written
// two ways, like `\"` in a JSON document and `"` in a chapter).

const MOVE_MIN = 20;
const GRAM = 12;           // the index's keys are this long…
const STEP = 8;            // …and taken every STEP units, so any match of GRAM + STEP - 1 or more is found
const HITS = 48;           // places looked at per key, newest first
const GRAVE_MAX = 4 * 1024 * 1024; // units of deleted text kept to match against, per book…
const GRAVE_COUNT = 20000;         // …in at most this many deletions
const RECENT = 8;                  // deletions looked for whole in a move, however short…
const RECENT_MIN = 4;              // …down to this many units of text
const isJsonDoc = (doc) => doc === 'book' || doc === 'darlings' || doc === 'stickies';
const { viewOf } = V;
const rawAt = (v, k) => (v.at ? v.at[k] : k);

// How many units before each position are outside tags. In HTML (`html`),
// a stretch that starts inside a tag, as an edit's inserted string can
// (` class="scene-break">***`), starts with markup up to its first `>`: in
// a chapter's HTML a `>` in the words is always written `&gt;`. (A JSON
// document's text can hold a plain `>`, so there it's counted as before.)
function textBefore(s, html = false) {
  const out = new Uint32Array(s.length + 1);
  let inTag = false;
  if (html) {
    const gt = s.indexOf('>');
    const lt = s.indexOf('<');
    inTag = gt >= 0 && (lt < 0 || gt < lt);
  }
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 60) inTag = true;
    out[i + 1] = out[i] + (inTag ? 0 : 1);
    if (c === 62) inTag = false;
  }
  return out;
}

// Texts to find moved words in, indexed by GRAM-long keys every STEP units.
// A record is { view, ref }; a dropped one stays in the index, skipped,
// until the dead outweigh the living and it's rebuilt.
class Sources {
  constructor() {
    this.index = new Map();
    this.recs = new Set();
    this.size = 0;
    this.dead = 0;
  }
  add(rec) {
    rec.dead = false;
    this.recs.add(rec);
    const t = rec.view.text;
    for (let p = 0; p + GRAM <= t.length; p += STEP) {
      const g = t.slice(p, p + GRAM);
      const list = this.index.get(g);
      if (list) list.push(rec, p);
      else this.index.set(g, [rec, p]);
    }
    this.size += t.length;
    return rec;
  }
  drop(rec) {
    if (!rec || !this.recs.delete(rec)) return;
    rec.dead = true;
    this.size -= rec.view.text.length;
    this.dead += rec.view.text.length;
    if (this.dead > Math.max(this.size, 65536)) this.rebuild();
  }
  rebuild() {
    const recs = [...this.recs];
    this.index = new Map();
    this.recs = new Set();
    this.size = 0;
    this.dead = 0;
    for (const r of recs) this.add(r);
  }
  clear() {
    for (const r of this.recs) r.dead = true;
    this.index = new Map();
    this.recs = new Set();
    this.size = 0;
    this.dead = 0;
  }
}

// Text deleted this session, oldest let go first past GRAVE_MAX
class Graveyard extends Sources {
  constructor(max = GRAVE_MAX) {
    super();
    this.max = max;
    this.queue = [];
  }
  bury(rec) {
    if (!rec.view.text.length) return;
    this.add(rec);
    this.queue.push(rec);
    while ((this.size > this.max || this.queue.length > GRAVE_COUNT) && this.queue.length > 1) this.drop(this.queue.shift());
  }
  *records() {
    for (let i = this.queue.length - 1; i >= 0; i--) if (!this.queue[i].dead) yield this.queue[i];
  }
  clear() {
    super.clear();
    this.queue = [];
  }
}

// Every document of a book as it stands, kept indexed (refreshed only when
// asked, and only the documents that changed)
class LiveDocs extends Sources {
  constructor() {
    super();
    this.byDoc = new Map();
  }
  refresh(docs) {
    for (const [doc, rec] of this.byDoc) {
      if (docs[doc] === rec.view.raw) continue;
      this.drop(rec);
      this.byDoc.delete(doc);
    }
    for (const [doc, text] of Object.entries(docs)) {
      if (this.byDoc.has(doc) || typeof text !== 'string' || !text) continue;
      this.byDoc.set(doc, this.add({ view: viewOf(text, isJsonDoc(doc)), ref: { doc } }));
    }
  }
  clear() {
    super.clear();
    this.byDoc = new Map();
  }
  records() {
    return this.byDoc.values();
  }
}

// A short insertion the window says was moved, found whole: the newest
// deletion that holds it, or else a document that does
function findWhole(view, pools) {
  const t = view.text;
  const vis = textBefore(t, !view.json);
  if (!vis[t.length]) return [];
  for (const pool of pools) {
    for (const rec of pool.src.records()) {
      const at = rec.view.text.indexOf(t);
      if (at >= 0) return [{ at: 0, len: t.length, rec, src: at, pool }];
    }
  }
  return [];
}

// The stretches of an inserted string (a view) found in the sources, left
// to right: [{ at, len, rec, src, pool }] in the view's characters. Pools
// are looked in by priority; a longer match wins.
function findMoved(view, pools) {
  const t = view.text;
  const vis = textBefore(t, !view.json);
  const out = [];
  let floor = 0;
  // the longest match through position p, reaching back as far as `floor`
  const matchAt = (p) => {
    const g = t.slice(p, p + GRAM);
    let best = null;
    for (let k = 0; k < pools.length; k++) {
      const list = pools[k].src.index.get(g);
      if (!list) continue;
      let looked = 0;
      for (let h = list.length - 2; h >= 0 && looked < HITS; h -= 2) {
        const rec = list[h];
        if (rec.dead) continue;
        looked++;
        const sp = list[h + 1];
        const s = rec.view.text;
        let b = 0;
        while (p - b > floor && sp - b > 0 && t.charCodeAt(p - b - 1) === s.charCodeAt(sp - b - 1)) b++;
        let f = GRAM;
        while (p + f < t.length && sp + f < s.length && t.charCodeAt(p + f) === s.charCodeAt(sp + f)) f++;
        if (!best || b + f > best.len) best = { at: p - b, len: b + f, rec, src: sp - b, pool: pools[k] };
      }
    }
    return best && vis[best.at + best.len] - vis[best.at] >= MOVE_MIN ? best : null;
  };
  let p = 0;
  while (p + GRAM <= t.length) {
    let best = matchAt(p);
    if (!best) { p++; continue; }
    // A source's keys are taken every STEP units, so the first key found
    // can belong to a shorter match that starts later (words deleted twice:
    // a passage cut and undone, then moved whole). The next few positions
    // are looked at too, and the match reaching furthest back wins (then
    // the longest), so the words before it aren't left without an origin.
    for (let q = p + 1; q < p + STEP && q + GRAM <= t.length; q++) {
      const m = matchAt(q);
      if (m && (m.at < best.at || (m.at === best.at && m.len > best.len))) best = m;
    }
    out.push(best);
    floor = p = best.at + best.len;
  }
  return out;
}

// A match in characters, as pieces of raw units: [at, len, srcAt, srcLen].
// Stretches written the same way on both sides are one piece; a character
// written two ways (an escape or a no-break space on one side only) is a
// piece of its own.
function rawPieces(tv, sv, at, len, sAt) {
  if (!tv.at && !sv.at) return [[at, len, sAt, len]];
  const out = [];
  let run = null;
  for (let k = 0; k < len; k++) {
    const t0 = rawAt(tv, at + k);
    const t1 = rawAt(tv, at + k + 1);
    const s0 = rawAt(sv, sAt + k);
    const s1 = rawAt(sv, sAt + k + 1);
    const same = t1 - t0 === s1 - s0 && tv.raw.slice(t0, t1) === sv.raw.slice(s0, s1);
    if (same && run && run.same && run.p[0] + run.p[1] === t0 && run.p[2] + run.p[3] === s0) {
      run.p[1] += t1 - t0;
      run.p[3] += s1 - s0;
      continue;
    }
    run = { same, p: [t0, t1 - t0, s0, s1 - s0] };
    out.push(run.p);
  }
  return out;
}

// The last few deletions, each found whole where nothing else was
function findRecent(view, found, pool) {
  const t = view.text;
  const out = found.slice();
  const free = (a, b) => out.every((m) => b <= m.at || a >= m.at + m.len);
  let k = 0;
  for (const rec of pool.src.records()) {
    if (k++ >= RECENT) break;
    const s = rec.view.text;
    const vis = textBefore(s, !rec.view.json);
    if (vis[s.length] < RECENT_MIN) continue;
    for (let i = t.indexOf(s); i >= 0; i = t.indexOf(s, i + 1)) {
      if (free(i, i + s.length)) out.push({ at: i, len: s.length, rec, src: 0, pool });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// The `from` pieces for one op's inserted string, looking in `pools` in
// order. `moved`: the window says these words were moved, so shorter ones
// count (above); `recent`: the graveyard whose last deletions those are
// (none for a copy, which deleted nothing).
function movedPieces(op, ins, json, pools, { moved = false, recent = null } = {}) {
  const tv = viewOf(ins, json);
  const out = [];
  let found = findMoved(tv, pools);
  if (!found.length && moved && tv.text.length < MOVE_MIN * 4) found = findWhole(tv, pools);
  if (moved && recent) found = findRecent(tv, found, recent);
  for (const m of found) {
    if (m.pool.as) {
      // another book: where in it isn't recorded, only that it came from it
      const a = rawAt(tv, m.at);
      out.push([op, a, rawAt(tv, m.at + m.len) - a, { ...m.pool.as }]);
      continue;
    }
    for (const [a, l, sa, sl] of rawPieces(tv, m.rec.view, m.at, m.len, m.src)) {
      const source = { ...m.rec.ref, at: sa };
      if (sl !== l) source.len = sl;
      out.push([op, a, l, source]);
    }
  }
  return out;
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

/* ------------------------------------------------------------------ */
/*  Checking: chunks read back, chains checked, replayed and traced    */
/* ------------------------------------------------------------------ */

// All in slog-verify.js, shared with slog-check and the verifier page
const {
  CHUNK_RE, KINDS, isChunkName, parseChunk, orderChunks, verifyChain, replay, trace, proseMask, composition, originsAt,
  AUX_DOCS, JSON_DOCS, chapterDoc, docChapter, chapterLines, manuscriptText
} = V;

/* ------------------------------------------------------------------ */
/*  Documents: what the log calls each file, and its text              */
/* ------------------------------------------------------------------ */

// A book's documents are its chapters (each by its own id), notes.html,
// outline.html, darlings.json, stickies.json and book.json (slog-verify.js
// names them). Other files in the folder (covers, art.json) aren't writing
// and aren't logged.
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
const OBSERVED_KEEP = 16;          // described-but-unsaved versions kept per document, for saves landing late
const WINDOW_SRC = new Set(['typed', 'paste', 'drop', 'move', 'import', 'arrived']);
const CAUSES = new Set(['undo', 'redo', 'replace', 'outline', 'split', 'join', 'spell', 'darling', 'placeholder']);

const wholeAtLeast = (v, min) => Number.isSafeInteger(v) && v >= min;
// A label from the window, cut down to what the format allows. Where moved
// text came from is the log's to work out; the window can only say that it
// came from another book it had open (`book`) or was copied rather than cut
// (`copy`), neither of which goes in the log.
function cleanLabel(label) {
  const l = label && typeof label === 'object' ? label : {};
  const how = { src: WINDOW_SRC.has(l.src) ? l.src : 'unlogged' };
  if (CAUSES.has(l.cause)) how.cause = l.cause;
  if (wholeAtLeast(l.dur, 0)) how.dur = l.dur;
  if (wholeAtLeast(l.ev, 0)) how.ev = l.ev;
  if (how.src === 'move' && typeof l.book === 'string' && /^[\w.-]{1,200}$/.test(l.book)) how.book = l.book;
  if (how.src === 'move' && l.copy === true) how.copy = true;
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
    // told when a chunk opens or closes (the stamper, slog-stamp.js)
    this.watcher = null;
  }

  _tell(what, s, extra) {
    if (!this.watcher || typeof this.watcher[what] !== 'function') return;
    try {
      this.watcher[what]({ dir: s.dir, bookId: s.bookId, logId: s.info.logId, dev: this.device(), ...extra });
    } catch (err) { this.onError('watcher', err); }
  }

  // An outside timestamp's receipt arrived: a stamp entry, in the chunk
  // being written. Returns the entry, or null when no chunk of that book's
  // log is open on this device (the caller keeps it for the next one).
  stamped(dir, bookId, logId, fields) {
    const s = this.sessions.get(bookId);
    if (!s || s.dir !== dir || !s.on || !s.info || s.info.logId !== logId || !s.chunk || s.failed) return null;
    try {
      return this._write(s, 'stamp', fields);
    } catch (err) {
      this._failed(s, s.chunk, err);
      return null;
    }
  }
  // Where each open chunk's chain stands: [{ dir, bookId, logId, dev, n, head }]
  heads() {
    const out = [];
    for (const s of this.sessions.values()) {
      if (s.on && s.info && s.chunk && !s.failed) out.push({ dir: s.dir, bookId: s.bookId, logId: s.info.logId, dev: this.device(), n: s.chain.n, head: s.chain.head });
    }
    return out;
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
    // The window observes as it goes and saves a moment later, one write at
    // a time per document, so a save can land after newer words were
    // described. That text is already in the log: only the disk is behind.
    const back = s.observed[doc];
    if (back) {
      const at = back.lastIndexOf(text);
      if (text === s.docs[doc]) delete s.observed[doc];
      else if (at >= 0) back.splice(0, at + 1);
      if (text === s.docs[doc] || at >= 0) { s.disk[doc] = text; return; }
    }
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
    const before = s.docs[doc];
    this._put(s, doc, text, how);
    // described, not yet saved: kept until a save of it (or a newer one) lands
    if (before !== text && typeof before === 'string' && before !== s.disk[doc]) {
      const back = s.observed[doc] || (s.observed[doc] = []);
      back.push(before);
      if (back.length > OBSERVED_KEEP) back.shift();
    }
    return true;
  }

  // The window says how a book.json it's about to save got that way. Like
  // the save itself (beforeMeta), a change to the caret's place or a cover
  // in a book with no log doesn't start one.
  observeMeta(dir, bookId, meta, label) {
    if (!meta || typeof meta !== 'object') return false;
    this.beforeMeta(dir, bookId, meta);
    const s = this.sessions.get(bookId);
    if (!s || s.dir !== dir) return false;
    return this.observe(dir, bookId, 'book', bookText(meta), label);
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

  // book:duplicate made a copy of the book in `fromDir`. When the original
  // has a log, the copy's starts now, its words a baseline that names the
  // original's log; the chunk closes straight away. (Without one, the copy
  // starts a log of its own the first time it's opened, as any book does.)
  copied(dir, bookId, fromDir) {
    const orig = parseQuiet(readQuiet(path.join(fromDir, LOG_DIR, LOG_INFO)));
    if (!validInfo(orig) || fs.existsSync(path.join(dir, LOG_DIR, LOG_INFO))) return Promise.resolve();
    const s = this.session(dir, bookId, { start: true, mode: 'copy', file: orig.logId });
    if (!s.on || !s.info) return Promise.resolve();
    return this.close(bookId);
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
    if (s && s.dir === dir) return { on: s.on, logging: !!s.info, n: s.chain ? s.chain.n : 0, chunk: s.chunk ? s.chunk.name : null, logId: s.info ? s.info.logId : null, dev: this.device() };
    const meta = parseQuiet(readQuiet(path.join(dir, 'book.json')));
    return { on: !(meta && meta.scribesLog === false), logging: fs.existsSync(path.join(dir, LOG_DIR, LOG_INFO)), n: null, chunk: null };
  }

  // Before an export: the session's chunk ends (the next entry starts a new
  // one), so every file of the log is closed or written out. Resolves, once
  // it's on disk, to where this device's chain stands: { dir, bookId,
  // logId, dev, n, head, ms (the manuscript's hash as the log has it),
  // chunk (the chunk just closed, or null) }, or null for a book with no log.
  async finish(dir, bookId) {
    const s = this.session(dir, bookId);
    if (!s.info) return null;
    if (!s.chain) return null;
    const chunk = s.chunk ? s.chunk.name : null;
    await this._close(s, 'close');
    return {
      dir: s.dir, bookId, logId: s.info.logId, dev: this.device(), n: s.chain.n, head: s.chain.head,
      ms: manuscriptHash(manuscriptText(s.docs)), chunk
    };
  }
  // Where this device's chain stands for a book, once everything logged so
  // far is on disk: { dev, n, h } for a named version (slog-history.js),
  // or null when the book isn't being logged. The log squares itself with
  // the disk first, as before a save.
  async head(dir, bookId) {
    const s = this.session(dir, bookId, { start: true });
    if (!s.on || !s.info || !s.chain || !s.chain.n || s.failed) return null;
    const n = s.chain.n;
    const h = s.chain.head;
    const chunk = s.chunk;
    if (chunk) {
      await chunk.writer.flush();
      if (chunk.writer.broken || chunk.failed) return null;
    } else if (s.closing) await Promise.resolve(s.closing).catch(() => {});
    return { dev: this.device(), n, h };
  }
  // The chunk this device is writing for a book, if one's open
  activeChunk(bookId) {
    const s = this.sessions.get(bookId);
    return s && s.chunk ? s.chunk.name : null;
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
        imported: null, importUntil: 0, observed: {}, others: null,
        graves: new Graveyard(), live: new LiveDocs()
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
    s.graves.clear();
    s.live.clear();
    if (s.on) this._reconcile(s, mode, file);
  }

  _cacheFile(s) {
    return path.join(this.home, `${s.info.logId}-${sha256hex(s.bookId).slice(0, 8)}.json`);
  }

  // Where this device's chain stands: from the cache when it matches the
  // chunks on disk exactly, otherwise by reading and replaying them.
  _chainState(s, useCache) {
    const dev = this.device();
    // (loose or merged into an archive, here or on another computer)
    const listing = F.listLog(s.dir);
    for (const b of listing.broken) this.onError('archive', new Error(`${s.bookId}: ${b.name}: ${b.problem}`));
    const names = F.chunkNames(listing, dev.slice(0, 8));
    if (useCache) {
      const c = parseQuiet(readQuiet(this._cacheFile(s)));
      if (c && c.v === 1 && c.dev === dev && c.logId === s.info.logId && c.bookId === s.bookId &&
          c.count === names.length && Number.isSafeInteger(c.n) && c.docs && typeof c.docs === 'object' &&
          (c.count === 0 ? c.n === 0 : names.includes(c.last) && listing.files.get(c.last).size === c.size)) {
        return { n: c.n, head: c.head, last: c.last, count: c.count, docs: c.docs };
      }
    }
    const chunks = [];
    for (const name of names) {
      let text = '';
      try { text = listing.files.get(name).read().toString('utf8'); } catch (err) { this.onError('read', err); }
      const parsed = parseChunk(text);
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

  // Bring the log's copy to `target`, entry by entry: documents gone first,
  // then those that shrank (most first), then the rest in order, so text
  // that moved is deleted before it turns up somewhere else and can be
  // traced to where it was
  _sync(s, target, mode, held = new Set(), file = null) {
    for (const doc of Object.keys(s.docs)) {
      if (doc in target || held.has(doc) || docChapter(doc) === null) continue;
      this._remove(s, doc, this._how(mode, doc, false, file));
    }
    const grow = (doc) => Math.min(0, target[doc].length - (s.docs[doc] || '').length);
    const changed = Object.keys(target).filter((doc) => s.docs[doc] !== target[doc]);
    changed.sort((a, b) => grow(a) - grow(b));
    for (const doc of changed) this._put(s, doc, target[doc], this._how(mode, doc, s.docs[doc] === undefined, file));
  }

  _how(mode, doc, isNew, file) {
    switch (mode) {
      case 'baseline': return isNew ? { base: 'baseline', src: 'arrived' } : { src: 'arrived' };
      case 'arrived': return isNew ? { base: 'arrived', src: 'arrived' } : { src: 'arrived' };
      case 'off': return { src: 'unlogged', cause: 'off' };
      case 'new': return { src: 'typed' };
      // a copy of a book (Duplicate): its text came from the original, whose
      // log is named (`file` is that log's id)
      case 'copy': return isNew ? { base: 'baseline', src: 'arrived', copyOf: file } : { src: 'arrived' };
      // everything book:create laid down for an import is the import's (book.json,
      // and the empty Darlings and stickies lists)
      case 'import': return isNew ? { base: 'import', src: 'import', file } : { src: 'typed' };
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
        if (how.copyOf) fields.from = [[0, 0, text.length, { log: how.copyOf }]];
        else if (how.base === 'arrived') {
          const there = this._arrivedFrom(s, doc, text);
          if (there) fields.from = [[0, 0, text.length, { dev: there.dev, n: there.n, doc, at: 0 }]];
        }
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
    for (const k of ['cause', 'dur', 'ev']) if (how[k] !== undefined) fields[k] = how[k];
    // a move's other half, the text leaving: nothing came from anywhere
    if (fields.src === 'move' && !ins.some((t) => t)) fields.src = 'typed';
    if (this._ready(s)) {
      let from = this._moved(s, doc, before, ops, ins, how, s.chain.n + 1);
      // text from another device: where it stands in that device's chain,
      // when its chunks are here already
      if (fields.src === 'arrived' && ins.some((t) => t)) {
        const there = this._arrivedFrom(s, doc, text);
        if (there) {
          const offs = V.insertOffsets(ops);
          const pieces = [];
          ops.forEach((op, i) => { if (op[2] && offs[i] !== null) pieces.push([i, 0, op[2], { dev: there.dev, n: there.n, doc, at: offs[i] }]); });
          if (pieces.length) from = pieces;
        }
      }
      if (from.length) fields.from = from;
    }
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
      if (this._ready(s)) this._moved(s, doc, old, fields.ops, [''], how, s.chain.n + 1);
      this._append(s, 'edit', fields);
    }
    this._append(s, 'doc', { doc, act: 'del' });
    delete s.docs[doc];
    delete s.disk[doc];
    delete s.observed[doc];
  }

  // Where an edit's inserted words were before, as `from` pieces, for the
  // edit about to be entry `n`. Each op's deleted text joins the graveyard
  // as it goes (an op's own insertion can come from its deletion: a
  // stretch rewritten with most of it unchanged). Words the window says
  // were moved within NEO are also looked for in the book as it stands, and
  // in another book they were copied from.
  _moved(s, doc, before, ops, ins, how, n) {
    const json = isJsonDoc(doc);
    const graves = { src: s.graves };
    const pools = [graves];
    const moved = how.src === 'move';
    if (moved && ins.some((t) => t.length)) {
      s.live.refresh(s.docs);
      // a copy is looked for in the book first; anything else in what was deleted
      if (how.copy) pools.unshift({ src: s.live });
      else pools.push({ src: s.live });
      const o = how.book && how.book !== s.bookId ? this.sessions.get(how.book) : null;
      if (o && o.info) {
        o.live.refresh(o.docs);
        pools.push({ src: o.graves, as: { log: o.info.logId } }, { src: o.live, as: { log: o.info.logId } });
      }
    }
    const from = [];
    let cur = before;
    ops.forEach(([at, del, len], i) => {
      if (del) s.graves.bury({ view: viewOf(cur.slice(at, at + del), json), ref: { n, op: i } });
      if (len) from.push(...movedPieces(i, ins[i], json, pools, { moved, recent: how.copy ? null : graves }));
      cur = cur.slice(0, at) + ins[i] + cur.slice(at + del);
    });
    return from;
  }

  // Text that arrived from another device: the entry of that device's
  // chain after which the document stood exactly so ({ dev, n }), or null
  // when no other device's chunks here end that way (not synced yet; a
  // checker matches those by their words later).
  _arrivedFrom(s, doc, text) {
    try {
      for (const [dev, st] of this._others(s)) {
        if (st.docs[doc] === text && st.last[doc]) return { dev, n: st.last[doc] };
      }
    } catch (err) { this.onError('arrived', err); }
    return null;
  }

  // The other devices' chains as the folder has them: each one's documents
  // as it last saw them, and the entry that last changed each. Read again
  // only when their chunks change, and then only from where they were.
  _others(s) {
    const mine = this.device().slice(0, 8);
    const listing = F.listLog(s.dir);
    const names = F.chunkNames(listing).filter((n) => CHUNK_RE.exec(n)[2] !== mine);
    const sizes = names.map((n) => listing.files.get(n).size);
    const sig = names.map((n, i) => n + ':' + sizes[i]).join('|');
    const readName = (name) => { try { return listing.files.get(name).read().toString('utf8'); } catch { return ''; } };
    const had = s.others;
    if (had && had.sig === sig) return had.devs;
    const files = new Map();
    const byDev = new Map();
    names.forEach((name, i) => {
      const old = had && had.files.get(name);
      const parsed = old && old.size === sizes[i] ? old.parsed : parseChunk(readName(name));
      files.set(name, { size: sizes[i], parsed });
      const open = parsed.entries[0];
      if (!open || open.kind !== 'open' || typeof open.dev !== 'string' || open.dev === this.device()) return;
      if (!byDev.has(open.dev)) byDev.set(open.dev, []);
      byDev.get(open.dev).push({ name, ...parsed });
    });
    const devs = new Map();
    for (const [dev, chunks] of byDev) {
      const entries = orderChunks(chunks).ordered.flatMap((c) => c.entries);
      if (!entries.length) continue;
      // carry on from where this device's chain was last read, if it still leads there
      const before = had && had.devs.get(dev);
      const at = before ? entries[before.n - 1] : null;
      const resume = at && at.n === before.n && entryHash(at) === before.head;
      const r = new V.Replayer(resume ? before.docs : {});
      const last = resume ? { ...before.last } : {};
      for (const e of entries) {
        if (resume && e.n <= before.n) continue;
        const doc = r.step(e);
        if (doc) last[doc] = e.n;
      }
      const end = entries[entries.length - 1];
      devs.set(dev, { n: end.n, head: entryHash(end), docs: r.text, last });
    }
    s.others = { sig, files, devs };
    return devs;
  }

  /* ---- chunks ---- */

  // Ready to write: a chunk open (the chain's next number is the entry's)
  _ready(s) {
    if (!s.info) return false;
    if (s.failed) {
      // the disk refused a write: the chain on disk is behind the one in
      // memory. A little later, pick it up from the disk and log what
      // happened meanwhile as unlogged.
      if (this.now() - s.failed < RETRY_MS || !this._recover(s)) return false;
    }
    try {
      if (!s.chunk) this._open(s);
      return true;
    } catch (err) {
      this._failed(s, s.chunk, err);
      return false;
    }
  }

  _append(s, kind, fields, ins = null) {
    if (!this._ready(s)) return null;
    try {
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
    // (a name an archive holds is taken too)
    const taken = F.listLog(s.dir).files;
    let name;
    for (let k = 1; ; k++) {
      name = chunkName(this.now(), dev, k);
      if (name !== s.last && !taken.has(name) && !fs.existsSync(path.join(logDir, name))) break;
    }
    const prevChunk = s.last;
    s.chunk = { name, writer: new ChunkWriter(path.join(logDir, name)), bytes: 0, failed: false };
    s.last = name;
    s.count += 1;
    this._write(s, 'open', { v: CHUNK_FORMAT, log: s.info.logId, dev, prevChunk, app: this.app });
    this._tell('opened', s);
  }

  _write(s, kind, fields, ins = null) {
    const chunk = s.chunk;
    const { entry, line } = s.chain.entry(kind, fields, ins);
    chunk.bytes += Buffer.byteLength(line, 'utf8') + 1;
    chunk.writer.append(line).catch((err) => this._failed(s, chunk, err));
    // (an outside timestamp arriving isn't writing: it doesn't keep the session open)
    if (kind !== 'close' && kind !== 'stamp') {
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
    // entry numbers past the disk's will be given out again
    s.graves.clear();
  }

  _recover(s) {
    s.failed = 0;
    s.chunk = null;
    s.graves.clear();
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
    this._tell('closed', s, { why, n: s.chain.n, head: s.chain.head });
    const snap = {
      v: 1, bookId: s.bookId, logId: s.info.logId, dev: this.device(),
      n: s.chain.n, head: s.chain.head, last: chunk.name, count: s.count, size: chunk.bytes, docs: { ...s.docs }
    };
    // (after any chunk still closing: switching off, then on, leaves the
    // first chunk's last lines on their way while the next one is written,
    // and quitting or closing waits for both)
    const before = s.closing;
    const done = Promise.resolve(before).catch(() => {}).then(() => chunk.writer.flush()).then(() => {
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
  FORMAT, CHUNK_FORMAT, LOG_DIR, LOG_INFO, KINDS, CHUNK_RE, writeWhole,
  canonical, sha256hex, clearPart, entryHash, saltFor, commitment, keyId,
  normalizeManuscript, manuscriptHash, newDeviceId, newLogInfo,
  diff, tokenHunks, markupRanges, recordOps, applyOps, applyLengths,
  Chain, chunkName, isChunkName, ChunkWriter, parseChunk,
  orderChunks, verifyChain, replay,
  AUX_DOCS, JSON_DOCS, chapterDoc, docChapter, docOf, bookText, jsonText, bookKeys,
  chapterLines, manuscriptText, readBookDocs, fileFacts, clockJump, cleanLabel,
  MOVE_MIN, viewOf, Sources, Graveyard, LiveDocs, findMoved, rawPieces, movedPieces, proseMask,
  trace, composition, originsAt,
  Recorder, IDLE_MS, MAX_CHUNK
};
