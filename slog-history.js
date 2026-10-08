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
  // chain's start. Returns { docs } or { error }.
  rebuild(dir, dev, n) {
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
        if (cp.n === n) return { docs };
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
      for (const c of chain.chunks) {
        if (reached >= n) break;
        for (const e of c.entries) {
          if (e.n <= reached) continue;
          if (e.n > n) break;
          r.step(e);
          reached = e.n;
        }
      }
      if (reached !== n) return { error: `entry ${n} isn't in that computer's chain` };
      if (r.problems.length) return { error: `entry ${r.problems[0].n} doesn't replay (${r.problems[0].problem})` };
      return { docs: r.text };
    }
    return { error: 'can\'t be rebuilt' };
  }

  // One document after entry n of a chain: { text } or { error }
  text(dir, dev, n, doc) {
    const r = this.rebuild(dir, dev, n);
    if (r.error) return r;
    const t = r.docs[doc];
    if (typeof t !== 'string') return { error: doc in r.docs ? 'the words for this version aren\'t in the log' : 'that chapter didn\'t exist then' };
    return { text: t };
  }
}

module.exports = { History, readChains, chapterWords, bookFacts, CHECKPOINT_EVERY };
