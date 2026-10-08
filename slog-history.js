'use strict';

// VERSIONS, REBUILT FROM THE SCRIBE'S LOG: a chapter's past versions aren't
// stored copies. Each device's chain replays into the documents exactly as
// that device saw them, so "chapter 3 after entry 4,812 of this computer's
// chain" is one replay (slog-verify.js's Replayer).
//
//   index      every chapter's session versions, across every chain: one
//              for each session (chunk) in which that device changed the
//              chapter itself (text that only arrived from another device
//              is that device's session, not this one's)
//   rebuild    the documents as one chain had them after entry n
//
// Checkpoints keep rebuilding quick late in a long book: the documents
// after the last entry of a closed session, gzipped, one at the first
// session end after every CHECKPOINT_EVERY entries of a chain, plus one
// at the newest closed session (the tail, replaced as the chain grows).
// They live on this computer only (Electron's userData/slog/history),
// never in the library: NEO rebuilds them from the log whenever one is
// missing, stale or doesn't match. Nothing here writes to the book.
//
// Node only (the main process and scripts/).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const V = require('./slog-verify.js');
const F = require('./slog-files.js');

V.useHash({
  sha256hex: (data) => crypto.createHash('sha256').update(data).digest('hex'),
  hmac: (key, s) => crypto.createHmac('sha256', key).update(s).digest()
});

const CACHE_V = 1;
const WRONG_ENTRY = 'this version doesn\'t match the book\'s log';
const CHECKPOINT_EVERY = 25000;

// Words in a chapter, as the manuscript sees them (scene breaks aren't
// words). Most chapters have nothing the manuscript leaves out, and for
// those the tags are simply dropped, which is many times quicker.
const LEFT_OUT = /class="[^"]*\b(?:ghost|ph-mark|darling-anchor)\b/;
function chapterWords(html) {
  let n = 0;
  if (!LEFT_OUT.test(html)) {
    const text = html.replace(/<p[^>]*\bscene-break\b[^>]*>[\s\S]*?<\/p>/g, ' ').replace(/<br\s*\/?>|<\/p>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&[#\w]+;/g, (m) => (/^&(nbsp|#160|#xa0);$/i.test(m) ? ' ' : 'x'));
    const m = text.match(/\S+/g);
    return m ? m.length : 0;
  }
  for (const line of V.chapterLines(html)) {
    if (line === '***') continue;
    const m = line.match(/\S+/g);
    if (m) n += m.length;
  }
  return n;
}

const isChapter = (doc) => typeof doc === 'string' && V.docChapter(doc) !== null;
const ownSrc = (e) => (e.kind === 'edit' || e.kind === 'base') && e.src !== 'arrived';
const safeJson = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// A chunk list in chain order: each next chunk is the one whose open names
// it, starting from the chunk that starts the chain or, when only some
// chunks were read, the one whose predecessor wasn't (already accounted
// for). Links decide, never names.
function orderFrom(chunks, partial) {
  if (!partial) return V.orderChunks(chunks);
  const problems = [];
  const byPrev = new Map();
  const names = new Set(chunks.map((c) => c.name));
  for (const c of chunks) {
    const open = c.entries[0];
    if (!open || open.kind !== 'open') continue;
    byPrev.set(open.prevChunk || null, c);
  }
  const starts = [...byPrev].filter(([prev]) => prev === null || !names.has(prev));
  if (starts.length > 1) problems.push({ problem: 'the chunks read don\'t make one stretch of the chain' });
  let cur = starts.length ? starts[0][1] : null;
  const ordered = [];
  const seen = new Set();
  while (cur && !seen.has(cur.name)) {
    seen.add(cur.name);
    ordered.push(cur);
    cur = byPrev.get(cur.name);
  }
  for (const c of chunks) if (!seen.has(c.name) && c.entries.length) problems.push({ chunk: c.name, problem: 'not linked into the chain' });
  return { ordered, problems };
}

// A book's log as chains: each device's chunks in chain order, with their
// sizes. Only the chunks are read: all of them, or those `only` names, or
// all but those `skip` names.
function readChains(dir, { skip = null, only = null } = {}) {
  const listing = F.listLog(dir);
  const problems = listing.broken.map((b) => `${b.name}: ${b.problem}`);
  let info = null;
  const infoFile = listing.files.get('log.json');
  if (infoFile) { try { info = JSON.parse(infoFile.read().toString('utf8')); } catch (err) { problems.push('log.json can\'t be read: ' + err.message); } }
  const byDev = new Map();
  for (const name of F.chunkNames(listing)) {
    if ((skip && skip.has(name)) || (only && !only.has(name))) continue;
    const f = listing.files.get(name);
    let text = '';
    try { text = f.read().toString('utf8'); } catch (err) { problems.push(`${name}: can't be read: ${err.message}`); continue; }
    const parsed = V.parseChunk(text);
    const open = parsed.entries[0];
    const dev = open && open.kind === 'open' && typeof open.dev === 'string' ? open.dev : null;
    if (!dev) { if (parsed.entries.length || (parsed.problems || []).length) problems.push(`${name}: doesn't start with an open entry`); continue; }
    if (!byDev.has(dev)) byDev.set(dev, []);
    byDev.get(dev).push({ name, size: f.size, ...parsed });
  }
  const chains = [];
  const partial = !!((skip && skip.size) || only);
  for (const [dev, chunks] of byDev) {
    const { ordered, problems: p } = orderFrom(chunks, partial);
    for (const x of p) problems.push(`${dev.slice(0, 8)}: ${x.chunk ? x.chunk + ': ' : ''}${x.problem}`);
    chains.push({ dev, chunks: ordered });
  }
  return { logId: info && typeof info.logId === 'string' ? info.logId : null, chains, problems, listing };
}

// What the book document says about chapters: titles and order
function bookFacts(text) {
  const meta = safeJson(text);
  if (!meta || typeof meta !== 'object') return null;
  return {
    order: Array.isArray(meta.chapterOrder) ? meta.chapterOrder : [],
    titles: meta.chapterTitles && typeof meta.chapterTitles === 'object' ? meta.chapterTitles : {},
    kinds: meta.chapterKinds && typeof meta.chapterKinds === 'object' ? meta.chapterKinds : {}
  };
}

class History {
  // home: this computer's own folder for checkpoints and the index cache
  // (userData/slog/history). Never inside the library.
  constructor({ home, onError = () => {}, every = CHECKPOINT_EVERY }) {
    this.home = home;
    this.onError = onError;
    this.every = every;
  }

  _dir(logId) { return path.join(this.home, logId); }
  _cacheFile(logId) { return path.join(this._dir(logId), 'index.json'); }

  _saveCheckpoint(logId, dev, n, h, docs) {
    const name = `${dev}-${n}.json.gz`;
    try {
      writeAtomic(path.join(this._dir(logId), name), zlib.gzipSync(JSON.stringify({ v: CACHE_V, dev, n, h, docs })));
      return name;
    } catch (err) { this.onError('checkpoint', err); return null; }
  }
  _loadCheckpoint(logId, dev, cp) {
    if (!cp || !cp.file) return null;
    try {
      const c = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(this._dir(logId), cp.file))).toString('utf8'));
      if (c && c.v === CACHE_V && c.dev === dev && c.n === cp.n && c.h === cp.h && c.docs && typeof c.docs === 'object') return c.docs;
    } catch { /* gone or damaged: rebuilt from the log */ }
    return null;
  }

  _logId(listing) {
    const f = listing.files.get('log.json');
    const info = f ? safeJson(f.read().toString('utf8')) : null;
    return info && typeof info.logId === 'string' && /^[0-9a-f]{16}$/.test(info.logId) ? info.logId : null;
  }
  _readCache(logId) {
    let c = null;
    try { c = JSON.parse(fs.readFileSync(this._cacheFile(logId), 'utf8')); } catch { return null; }
    return c && c.v === CACHE_V && c.logId === logId && c.chains && typeof c.chains === 'object' ? c : null;
  }
  // The cached chains whose closed chunks are all still here, unchanged
  _usable(cache, listing) {
    const out = {};
    if (!cache) return out;
    for (const [dev, c] of Object.entries(cache.chains)) {
      if (c && c.tail && Array.isArray(c.chunks) && c.chunks.every((k) => { const f = listing.files.get(k.name); return f && f.size === k.size; })) out[dev] = c;
    }
    return out;
  }

  // Every chapter's versions. Returns { logId, devices, chapters, problems }:
  // devices [{ dev, name, first, last, n }]; chapters { doc: { id, title,
  // inBook, order, was, versions: [{ dev, chunk, n, start, ts, words,
  // delta, kind, gone, broken }] } }, versions oldest first.
  index(dir) {
    const listing = F.listLog(dir);
    const logId = this._logId(listing);
    if (!logId) return { logId: null, devices: [], chapters: {}, problems: ['no Scribe\'s Log'] };
    const usable = this._usable(this._readCache(logId), listing);
    const skip = new Set(Object.values(usable).flatMap((c) => c.chunks.map((k) => k.name)));
    const log = readChains(dir, { skip });
    const problems = log.problems.slice();
    const devs = new Set([...Object.keys(usable), ...log.chains.map((c) => c.dev)]);
    const chains = {};
    for (const dev of devs) {
      const fresh = log.chains.find((c) => c.dev === dev) || { dev, chunks: [] };
      let out = usable[dev] ? this._chain(logId, fresh, usable[dev]) : null;
      if (!out) {
        // start over from the beginning of that chain
        const whole = usable[dev] ? readChains(dir).chains.find((c) => c.dev === dev) || { dev, chunks: [] } : fresh;
        out = this._chain(logId, whole, null);
      }
      if (out.broken) problems.push(`${dev.slice(0, 8)}: entry ${out.broken.n} doesn't replay (${out.broken.problem}); later versions from that computer can't be rebuilt`);
      chains[dev] = out;
    }
    this._writeCache(logId, chains);
    return this._shape(logId, chains, problems);
  }

  _writeCache(logId, chains) {
    const keep = {};
    for (const [dev, c] of Object.entries(chains)) {
      if (!c.tail) continue;
      keep[dev] = {
        chunks: c.chunks.slice(0, c.closedCount).map(({ name, size, first, last }) => ({ name, size, first, last })),
        versions: c.versions.filter((v) => v.n <= c.tail.n), facts: c.factsAtTail, checkpoints: c.checkpoints, tail: c.tail,
        first: c.first, last: c.lastAtTail, n: c.tail.n
      };
    }
    try { writeAtomic(this._cacheFile(logId), JSON.stringify({ v: CACHE_V, logId, chains: keep })); } catch (err) { this.onError('history cache', err); }
    // checkpoints no chain names any more
    try {
      const named = new Set(Object.values(keep).flatMap((c) => [...c.checkpoints.map((p) => p.file), c.tail.file]));
      for (const f of fs.readdirSync(this._dir(logId))) if (f.endsWith('.json.gz') && !named.has(f)) fs.rmSync(path.join(this._dir(logId), f), { force: true });
    } catch { /* nothing to tidy */ }
  }

  // One chain's sessions replayed: `chain.chunks` are the chunks to read
  // (all of them, or, with `had`, those after its tail). Returns null when
  // `had` can't be resumed from.
  _chain(logId, chain, had) {
    const dev = chain.dev;
    let docs = {};
    if (had) {
      const next = chain.chunks[0];
      if (next && !(next.entries[0] && next.entries[0].prev === had.tail.h)) return null;
      docs = this._loadCheckpoint(logId, dev, had.tail);
      if (!docs) return null;
    }
    const facts = had && had.facts ? JSON.parse(JSON.stringify(had.facts)) : { titles: {}, positions: {}, inBook: [] };
    const out = {
      dev,
      chunks: had ? had.chunks.slice() : [],
      versions: had ? had.versions.slice() : [],
      checkpoints: had ? had.checkpoints.slice() : [],
      closedCount: had ? had.chunks.length : 0,
      tail: had ? had.tail : null,
      factsAtTail: had ? had.facts : null,
      first: had ? had.first : null,
      last: had ? had.last : null,
      lastAtTail: had ? had.last : null,
      n: had ? had.n : 0,
      broken: null,
      facts
    };
    const r = new V.Replayer(docs);
    let lastCp = out.checkpoints.length ? out.checkpoints[out.checkpoints.length - 1].n : 0;
    let lastBook = r.text.book;
    const readFacts = () => {
      if (r.text.book === lastBook) return;
      lastBook = r.text.book;
      const b = bookFacts(lastBook);
      if (!b) return;
      b.order.forEach((id, i) => { facts.positions[id] = { at: i, after: i ? b.order[i - 1] : null }; });
      for (const [id, t] of Object.entries(b.titles)) if (typeof t === 'string' && t.trim()) facts.titles[id] = t;
      facts.inBook = b.order.filter((id) => b.kinds[id] !== 'contents');
    };
    let newTail = null;
    for (const c of chain.chunks) {
      if (!c.entries.length) continue;
      const touched = new Map(); // doc -> what made this session's version: session, import, baseline, copy
      const gone = new Map();    // doc -> { n, ts, text } as it stood before this session deleted it
      const emptied = new Map(); // doc -> { n, ts, text, own } before an edit left it empty
      for (const e of c.entries) {
        if (out.first === null && Number.isFinite(e.ts)) out.first = e.ts;
        const ch = isChapter(e.doc);
        if (ch && e.kind === 'doc' && e.act === 'del') {
          const before = emptied.get(e.doc) || { n: e.n - 1, ts: e.ts, text: r.text[e.doc], own: true };
          if (before.own && before.text) { gone.set(e.doc, before); if (!touched.has(e.doc)) touched.set(e.doc, 'session'); }
        }
        if (ch && e.kind === 'edit' && r.text[e.doc]) emptied.set(e.doc, { n: e.n - 1, ts: e.ts, text: r.text[e.doc], own: ownSrc(e) });
        const nProblems = r.problems.length;
        // (an entry that doesn't replay still made its session a version,
        // one that can't be rebuilt)
        const changed = r.step(e) || (r.problems.length > nProblems && (e.kind === 'edit' || e.kind === 'base') ? e.doc : null);
        if (changed && isChapter(changed) && r.text[changed] !== '') emptied.delete(changed);
        if (changed && isChapter(changed) && ownSrc(e) && !touched.has(changed)) {
          let how = 'session';
          if (e.kind === 'base') how = e.src === 'import' ? 'import' : (Array.isArray(e.from) && e.from.some((p) => p && p[3] && typeof p[3].log === 'string') ? 'copy' : 'baseline');
          touched.set(changed, how);
        }
        if (changed === 'book') readFacts();
        if (r.problems.length && !out.broken) out.broken = { n: r.problems[0].n, problem: r.problems[0].problem };
      }
      const end = c.entries[c.entries.length - 1];
      out.chunks.push({ name: c.name, size: c.size, first: c.entries[0].n, last: end.n });
      for (const [doc, kind] of touched) {
        const g = gone.get(doc);
        if (g && !(doc in r.text)) {
          out.versions.push({ doc, dev, chunk: c.name, n: g.n, start: c.entries[0].ts, ts: g.ts, words: chapterWords(g.text), kind, gone: true, broken: !!out.broken });
          continue;
        }
        const text = r.text[doc];
        const ok = !out.broken && typeof text === 'string';
        out.versions.push({ doc, dev, chunk: c.name, n: end.n, start: c.entries[0].ts, ts: end.ts, words: ok ? chapterWords(text) : null, kind, gone: false, broken: !ok });
      }
      out.last = end.ts;
      out.n = end.n;
      if (end.kind === 'close' && !out.broken) {
        const h = V.entryHash(end);
        if (end.n - lastCp >= this.every) {
          const file = this._saveCheckpoint(logId, dev, end.n, h, r.text);
          if (file) { out.checkpoints.push({ n: end.n, h, chunk: c.name, file }); lastCp = end.n; }
        }
        newTail = { n: end.n, h, chunk: c.name, docs: r.text };
        out.closedCount = out.chunks.length;
        out.factsAtTail = JSON.parse(JSON.stringify(facts));
        out.lastAtTail = end.ts;
      }
    }
    if (newTail) {
      const cp = out.checkpoints.find((p) => p.n === newTail.n);
      const file = cp ? cp.file : this._saveCheckpoint(logId, dev, newTail.n, newTail.h, newTail.docs);
      out.tail = file ? { n: newTail.n, h: newTail.h, chunk: newTail.chunk, file } : null;
      if (!out.tail) out.closedCount = 0;
    }
    return out;
  }

  _shape(logId, chains, problems) {
    const devs = Object.values(chains).filter((c) => c.chunks.length);
    const names = V.deviceNames(devs.map((c) => ({ dev: c.dev, first: c.first })));
    const byTime = devs.slice().sort((a, b) => (a.last ?? 0) - (b.last ?? 0));
    // the chain written last knows the book as it is now
    const now = byTime.length ? byTime[byTime.length - 1].facts : { titles: {}, positions: {}, inBook: [] };
    const titles = {};
    const positions = {};
    for (const c of byTime) {
      Object.assign(titles, c.facts.titles);
      Object.assign(positions, c.facts.positions);
    }
    const chapters = {};
    for (const c of devs) {
      for (const v of c.versions) {
        const id = V.docChapter(v.doc);
        if (!chapters[v.doc]) chapters[v.doc] = { id, title: titles[id] || null, inBook: now.inBook.includes(id), order: now.inBook.indexOf(id), was: positions[id] || null, versions: [] };
        const { doc: _doc, ...rest } = v;
        chapters[v.doc].versions.push(rest);
      }
    }
    for (const ch of Object.values(chapters)) {
      ch.versions.sort((a, b) => a.ts - b.ts || (a.dev < b.dev ? -1 : 1));
      let prev = 0;
      for (const v of ch.versions) {
        v.delta = v.words === null ? null : v.words - prev;
        if (v.words !== null) prev = v.gone ? 0 : v.words;
      }
    }
    return {
      logId,
      devices: devs.map((c) => ({ dev: c.dev, name: names.get(c.dev), first: c.first, last: c.last, n: c.n })),
      chapters,
      problems
    };
  }

  // The documents as one chain had them after entry n, from the newest
  // checkpoint at or before it that still matches the log, or from the
  // chain's start. Returns { docs } or { error }. With `h` (a named
  // version's), entry n must be the one with that hash: a version file
  // that points at another log, or a chain that was rewritten, shows no text.
  rebuild(dir, dev, n, { h = null } = {}) {
    if (!Number.isSafeInteger(n) || n < 1) return { error: 'no such entry' };
    const listing = F.listLog(dir);
    const logId = this._logId(listing);
    if (!logId) return { error: 'no Scribe\'s Log' };
    const had = this._usable(this._readCache(logId), listing)[dev] || null;
    const cps = had ? [...had.checkpoints, had.tail].filter((c) => c && c.n <= n).sort((a, b) => b.n - a.n) : [];
    for (const cp of [...cps, null]) {
      let docs = {};
      let skip = null;
      if (cp) {
        docs = this._loadCheckpoint(logId, dev, cp);
        if (!docs) continue;
        if (cp.n === n) return h && cp.h !== h ? { error: WRONG_ENTRY } : { docs };
        const i = had.chunks.findIndex((k) => k.name === cp.chunk);
        if (i < 0) continue;
        skip = new Set(had.chunks.slice(0, i + 1).map((k) => k.name));
      }
      // the cache knows which chunks hold which entries: read only those
      // needed, unless n is past what it knows
      let only = null;
      if (had && n <= had.n) {
        only = new Set(had.chunks.filter((k) => !(skip && skip.has(k.name)) && k.first <= n).map((k) => k.name));
        skip = null;
      }
      const chain = readChains(dir, { skip, only }).chains.find((c) => c.dev === dev);
      if (!chain) { if (cp) continue; return { error: 'that computer\'s chain isn\'t in this log' }; }
      // the chunk after a checkpoint must carry on from it
      if (cp && !(chain.chunks[0] && chain.chunks[0].entries[0] && chain.chunks[0].entries[0].prev === cp.h)) continue;
      const r = new V.Replayer(docs);
      let reached = cp ? cp.n : 0;
      let last = null;
      for (const c of chain.chunks) {
        if (reached >= n) break;
        for (const e of c.entries) {
          if (e.n <= reached) continue;
          if (e.n > n) break;
          r.step(e);
          reached = e.n;
          last = e;
        }
      }
      if (reached !== n) return { error: `entry ${n} isn't in that computer's chain` };
      if (h && V.entryHash(last) !== h) return { error: WRONG_ENTRY };
      if (r.problems.length) return { error: `entry ${r.problems[0].n} doesn't replay (${r.problems[0].problem})` };
      return { docs: r.text };
    }
    return { error: 'can\'t be rebuilt' };
  }

  // Everything the History window lists for a book: every chapter's
  // versions from the log (index) and from the copies of log-off sessions,
  // oldest first, plus the named versions. Devices keep the report's names;
  // a computer that only made copies or names is numbered after them.
  list(dir) {
    const ix = this.index(dir);
    const problems = ix.logId ? ix.problems.slice() : [];
    const copies = listCopies(dir);
    const named = listNamed(dir);
    const devices = ix.devices.map((d) => ({ ...d }));
    const extra = new Map();
    for (const x of [...copies, ...named]) {
      if (devices.some((d) => d.dev === x.dev)) continue;
      const e = extra.get(x.dev);
      if (!e) extra.set(x.dev, { dev: x.dev, first: x.at, last: x.at, n: null });
      else { e.first = Math.min(e.first, x.at); e.last = Math.max(e.last, x.at); }
    }
    [...extra.values()].sort((a, b) => a.first - b.first || (a.dev < b.dev ? -1 : 1))
      .forEach((d) => devices.push({ ...d, name: 'Device ' + (devices.length + 1) }));
    const chapters = {};
    for (const [doc, ch] of Object.entries(ix.chapters)) chapters[doc] = { ...ch, versions: ch.versions.map((v) => ({ ...v })) };
    const meta = bookFacts(readQuiet(path.join(dir, 'book.json')) || '') || { order: [], titles: {}, kinds: {} };
    const inBook = meta.order.filter((id) => meta.kinds[id] !== 'contents');
    for (const c of copies) {
      if (c.all) continue; // a named version's copy: listed with the named versions
      for (const [id, html] of Object.entries(c.chapters)) {
        const doc = V.chapterDoc(id);
        if (!chapters[doc]) {
          const at = c.order.indexOf(id);
          chapters[doc] = {
            id, title: meta.titles[id] || c.titles[id] || null, inBook: inBook.includes(id), order: inBook.indexOf(id),
            was: at >= 0 ? { at, after: at ? c.order[at - 1] : null } : null, versions: []
          };
        } else if (!chapters[doc].title && c.titles[id]) chapters[doc].title = c.titles[id];
        chapters[doc].versions.push({ dev: c.dev, file: c.file, start: c.at, ts: c.at, words: chapterWords(html), kind: 'saved', gone: c.gone.includes(id), broken: false });
      }
    }
    for (const ch of Object.values(chapters)) {
      ch.versions.sort((a, b) => a.ts - b.ts || (a.dev < b.dev ? -1 : 1));
      let prev = 0;
      for (const v of ch.versions) {
        v.delta = v.words === null ? null : v.words - prev;
        if (v.words !== null) prev = v.gone ? 0 : v.words;
      }
    }
    return { logId: ix.logId, devices, chapters, named, problems };
  }

  // One chapter's text in a version: `ref` is { dev, n, h } (a version
  // from the log), { copy } (a copy file) or { named } (a named version's
  // file). Returns { text } or { error }.
  versionText(dir, ref, id) {
    if (!ref || typeof id !== 'string') return { error: 'no such version' };
    if (ref.named) {
      const v = readNamedFile(dir, ref.named);
      if (!v) return { error: 'that version isn\'t there' };
      ref = v.copy ? { copy: v.copy } : { dev: v.dev, n: v.n, h: v.h };
    }
    if (ref.copy) {
      const c = readCopy(dir, ref.copy);
      if (!c) return { error: 'that version\'s copy can\'t be read' };
      return typeof c.chapters[id] === 'string' ? { text: c.chapters[id] } : { error: 'that chapter didn\'t exist then' };
    }
    if (typeof ref.dev !== 'string' || !Number.isSafeInteger(ref.n)) return { error: 'no such version' };
    return this.text(dir, ref.dev, ref.n, V.chapterDoc(id), { h: ref.h || null });
  }

  // One document after entry n of a chain: { text } or { error }
  text(dir, dev, n, doc, { h = null } = {}) {
    const r = this.rebuild(dir, dev, n, { h });
    if (r.error) return r;
    const t = r.docs[doc];
    if (typeof t !== 'string') return { error: doc in r.docs ? 'the words for this version aren\'t in the log' : 'that chapter didn\'t exist then' };
    return { text: t };
  }
}

/* ------------------------------------------------------------------ */
/*  Versions kept in the book: named versions and the log-off copies    */
/* ------------------------------------------------------------------ */

// book-x/versions/ holds what the log can't: the versions the writer names
// ("Sent to Maria"), and, for a book with the log switched off, a gzipped
// copy of the chapters each session changed. Every file is written once
// and is small, so a synced library carries them to every computer.
// Nothing that reads a book's documents looks in here, and none of it is
// part of the log: no checker reads it, and it never goes in an export.
//
//   20261008T190312Z-589b9bf7.json      a named version: { v: 1, name, at,
//       dev, auto, n, h } with the log on (that device's chain at entry n,
//       whose hash is h), or { …, copy: "<copy file>" } with it off
//   20261008T201500Z-589b9bf7.json.gz   a copy: { v: 1, at, dev, all,
//       order, titles, chapters: { id: html }, gone: [id] }; `all` when a
//       named version copied the whole book

const VERSIONS_DIR = 'versions';
const NAMED_RE = /^\d{8}T\d{6}Z-[0-9a-f]{8}(?:-\d+)?\.json$/;
const COPY_RE = /^\d{8}T\d{6}Z-[0-9a-f]{8}(?:-\d+)?\.json\.gz$/;
const AUTO = new Set(['restore', 'replace', 'word']);
const NAME_MAX = 120;

// A version's name as the writer typed it: one line, no control
// characters, not too long. '' when nothing's left.
function cleanName(name) {
  return [...String(name == null ? '' : name).replace(/\s+/g, ' ').trim()]
    .filter((c) => c >= ' ' && c !== '\u007f').join('').slice(0, NAME_MAX).trim();
}

const versionsDir = (bookDir) => path.join(bookDir, VERSIONS_DIR);
const readdirQuiet = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

// A new file in versions/, never over one that's there (another computer's
// sync may have brought one with the same second and device)
function writeOnce(bookDir, dev, at, ext, data) {
  const dir = versionsDir(bookDir);
  fs.mkdirSync(dir, { recursive: true });
  const base = `${F.utcName(at)}-${String(dev).slice(0, 8)}`;
  for (let k = 1; ; k++) {
    const name = base + (k > 1 ? '-' + k : '') + ext;
    const file = path.join(dir, name);
    if (fs.existsSync(file)) continue;
    require('./slog.js').writeWhole(file, data, { keep: true });
    return name;
  }
}

function readNamedFile(bookDir, file) {
  if (!NAMED_RE.test(file)) return null;
  const v = safeJson(readQuiet(path.join(versionsDir(bookDir), file)));
  if (!v || v.v !== 1 || typeof v.name !== 'string' || !Number.isFinite(v.at) || typeof v.dev !== 'string') return null;
  const out = { file, name: v.name, at: v.at, dev: v.dev, auto: AUTO.has(v.auto) ? v.auto : null };
  if (typeof v.copy === 'string' && COPY_RE.test(v.copy)) out.copy = v.copy;
  else if (Number.isSafeInteger(v.n) && v.n > 0 && typeof v.h === 'string' && /^[0-9a-f]{64}$/.test(v.h)) { out.n = v.n; out.h = v.h; } else return null;
  return out;
}
function readQuiet(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }

// Every named version of a book, oldest first. Files that aren't one
// (a half-written .tmp, a sync service's stand-in) are passed over.
function listNamed(bookDir) {
  const out = [];
  for (const f of readdirQuiet(versionsDir(bookDir))) {
    const v = readNamedFile(bookDir, f);
    if (v) out.push(v);
  }
  return out.sort(byWhen);
}
// oldest first; files made the same second by one computer in the order made
const fileK = (f) => { const m = /^\d{8}T\d{6}Z-[0-9a-f]{8}-(\d+)\./.exec(f); return m ? +m[1] : 1; };
const byWhen = (a, b) => a.at - b.at || fileK(a.file) - fileK(b.file) || (a.file < b.file ? -1 : 1);

// A copy file, read whole: { file, at, dev, all, order, titles, chapters, gone }
function readCopy(bookDir, file) {
  if (!COPY_RE.test(file)) return null;
  let c;
  try { c = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(versionsDir(bookDir), file))).toString('utf8')); } catch { return null; }
  if (!c || c.v !== 1 || !Number.isFinite(c.at) || typeof c.dev !== 'string' || !c.chapters || typeof c.chapters !== 'object') return null;
  const chapters = {};
  for (const [id, html] of Object.entries(c.chapters)) if (typeof html === 'string') chapters[id] = html;
  return {
    file, at: c.at, dev: c.dev, all: c.all === true, chapters,
    order: Array.isArray(c.order) ? c.order.filter((x) => typeof x === 'string') : [],
    titles: c.titles && typeof c.titles === 'object' ? c.titles : {},
    gone: Array.isArray(c.gone) ? c.gone.filter((id) => typeof id === 'string' && id in chapters) : []
  };
}
// Every copy, oldest first
function listCopies(bookDir) {
  const out = [];
  for (const f of readdirQuiet(versionsDir(bookDir))) {
    const c = readCopy(bookDir, f);
    if (c) out.push(c);
  }
  return out.sort(byWhen);
}

// The chapters a copy holds and what book.json said about them then
function writeCopy(bookDir, { dev, at, all = false, chapters, gone = [], meta = null }) {
  const order = meta && Array.isArray(meta.chapterOrder) ? meta.chapterOrder.filter((x) => typeof x === 'string') : [];
  const titles = {};
  const t = meta && meta.chapterTitles && typeof meta.chapterTitles === 'object' ? meta.chapterTitles : {};
  for (const id of Object.keys(chapters)) if (typeof t[id] === 'string' && t[id].trim()) titles[id] = t[id];
  const data = zlib.gzipSync(JSON.stringify({ v: 1, at, dev, all: !!all, order, titles, chapters, gone }));
  return writeOnce(bookDir, dev, at, '.json.gz', data);
}

// A named version, written once. `head` is { dev, n, h } with the log on;
// `copy` the file holding the book's chapters with it off.
function writeNamed(bookDir, { name, auto = null, at, dev, head = null, copy = null }) {
  const v = { v: 1, name: cleanName(name), at, dev, auto: AUTO.has(auto) ? auto : null };
  if (!v.name) throw new Error('a version needs a name');
  if (head) Object.assign(v, { n: head.n, h: head.h });
  else if (copy) v.copy = copy;
  else throw new Error('a version needs the log or a copy');
  const file = writeOnce(bookDir, dev, at, '.json', JSON.stringify(v, null, 2) + '\n');
  return readNamedFile(bookDir, file);
}

// Renaming rewrites that one small file; nothing else changes
function renameNamed(bookDir, file, name) {
  const v = readNamedFile(bookDir, file);
  if (!v) throw new Error('that version isn\'t there');
  const clean = cleanName(name);
  if (!clean) throw new Error('a version needs a name');
  const raw = safeJson(readQuiet(path.join(versionsDir(bookDir), file)));
  raw.name = clean;
  require('./slog.js').writeWhole(path.join(versionsDir(bookDir), file), JSON.stringify(raw, null, 2) + '\n');
  return { ...v, name: clean };
}

// Deleting a named version removes its file (and the copy only it names).
// The words are still in the log, or in the other copies.
function deleteNamed(bookDir, file) {
  const v = readNamedFile(bookDir, file);
  if (!v) return false;
  fs.rmSync(path.join(versionsDir(bookDir), file), { force: true });
  if (v.copy && !listNamed(bookDir).some((o) => o.copy === v.copy)) {
    const c = readCopy(bookDir, v.copy);
    if (c && c.all) fs.rmSync(path.join(versionsDir(bookDir), v.copy), { force: true });
  }
  return true;
}

// Each chapter's newest text across every session's copy (any
// computer's), for the chapters asked about: what a session's copy is
// compared against. (A named version's copy of the whole book doesn't
// count: each session's own versions stay complete without it.)
function newestCopied(bookDir, ids) {
  const want = new Set(ids);
  const out = {};
  for (const c of listCopies(bookDir).reverse()) {
    if (c.all) continue;
    for (const id of [...want]) {
      if (id in c.chapters) { out[id] = c.gone.includes(id) ? null : c.chapters[id]; want.delete(id); }
    }
    if (!want.size) break;
  }
  return out;
}

// LOG-OFF SESSIONS: with the Scribe's Log switched off for a book, nothing
// records its versions, so main.js says which chapters were saved and which
// deleted, and at the session's end (the book closed, NEO quit, half an
// hour with no saves: the same rules as a chunk) the chapters that differ
// from their newest copy on any computer are copied, once, into versions/.
class SessionCopies {
  constructor({ dev, now = Date.now, idleMs = 30 * 60 * 1000, onError = () => {}, readMeta = null }) {
    this.dev = dev; // () => this computer's device id
    this.now = now;
    this.idleMs = idleMs;
    this.onError = onError;
    this.readMeta = readMeta || ((dir) => safeJson(readQuiet(path.join(dir, 'book.json'))));
    this.books = new Map();
  }
  _book(dir, bookId) {
    let b = this.books.get(bookId);
    if (b && b.dir !== dir) { this.end(bookId); b = null; }
    if (!b) { b = { dir, saved: new Set(), gone: new Map(), timer: null }; this.books.set(bookId, b); }
    clearTimeout(b.timer);
    b.timer = setTimeout(() => this.end(bookId), this.idleMs);
    if (b.timer.unref) b.timer.unref();
    return b;
  }
  // a chapter of a log-off book reached the disk
  saved(dir, bookId, id) {
    const b = this._book(dir, bookId);
    b.saved.add(id);
    b.gone.delete(id);
  }
  // …or is about to be deleted: its last words are kept for the copy
  deleting(dir, bookId, id, html) {
    const b = this._book(dir, bookId);
    if (typeof html === 'string' && html) b.gone.set(id, html);
    b.saved.delete(id);
  }
  open(bookId) { return this.books.has(bookId); }
  // The session ends: its copy is written (or nothing, when nothing
  // changed). Returns the copy's file name, or null.
  end(bookId) {
    const b = this.books.get(bookId);
    if (!b) return null;
    this.books.delete(bookId);
    clearTimeout(b.timer);
    try {
      const now = {};
      for (const id of b.saved) {
        const html = readQuiet(path.join(b.dir, 'chapters', id + '.html'));
        if (html !== null) now[id] = html;
      }
      const ids = [...Object.keys(now), ...b.gone.keys()];
      if (!ids.length) return null;
      const had = newestCopied(b.dir, ids);
      const chapters = {};
      for (const [id, html] of Object.entries(now)) if (had[id] !== html) chapters[id] = html;
      const gone = [];
      for (const [id, html] of b.gone) if (had[id] !== null) { chapters[id] = html; gone.push(id); }
      if (!Object.keys(chapters).length) return null;
      return writeCopy(b.dir, { dev: this.dev(), at: this.now(), chapters, gone, meta: this.readMeta(b.dir) });
    } catch (err) {
      this.onError('versions', err);
      return null;
    }
  }
  // the book's folder is going away: nothing to copy into
  drop(bookId) {
    const b = this.books.get(bookId);
    if (b) { clearTimeout(b.timer); this.books.delete(bookId); }
  }
  endAll() {
    for (const bookId of [...this.books.keys()]) this.end(bookId);
  }
}

// The whole book's chapters, for a named version while the log is off
function copyWholeBook(bookDir, { dev, at }) {
  const meta = safeJson(readQuiet(path.join(bookDir, 'book.json')));
  const chapters = {};
  for (const f of readdirQuiet(path.join(bookDir, 'chapters'))) {
    if (!f.endsWith('.html')) continue;
    const html = readQuiet(path.join(bookDir, 'chapters', f));
    if (html !== null) chapters[f.slice(0, -5)] = html;
  }
  return writeCopy(bookDir, { dev, at, all: true, chapters, meta });
}

module.exports = {
  History, readChains, chapterWords, bookFacts, CHECKPOINT_EVERY,
  VERSIONS_DIR, cleanName, listNamed, readNamedFile, listCopies, readCopy, writeCopy, writeNamed, renameNamed, deleteNamed,
  newestCopied, copyWholeBook, SessionCopies
};
