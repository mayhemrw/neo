// THE SCRIBE'S LOG, CHECKED: everything a checker does with a book's log,
// in plain JavaScript with no Node or Electron APIs, so the same file runs
// in NEO, in scripts/slog-check.js, and inside the standalone verifier page.
//
//   reading      chunks and receipt files, and the files of a scribes-log
//                folder handed in as { name: text or bytes }, archives
//                (slog-zip.js) unpacked into their places
//   the chain    order, numbering, links, commitments (verifyChain)
//   replay       the documents rebuilt from the ops (replay)
//   origins      where every unit of text first came from, across devices
//                (trace, traceAll, composition)
//   manuscript   the text the manuscript hash covers (manuscriptText)
//   receipts     RFC 3161 tokens and OpenTimestamps proofs checked against
//                the chains, the coverage they give, and the clock check
//
// Hashing is synchronous (slog-hash.js) so a chain walk is too; NEO swaps
// in Node's crypto, which is faster and gives the same bytes (useHash).
// Signature checks go through WebCrypto (stamp-tsa.js), so checkLog is
// async. The format is set out in SLOG-FORMAT.md.

'use strict';

(function (exports) {
  const hasRequire = typeof require === 'function';
  const H = hasRequire ? require('./slog-hash.js') : globalThis.SlogHash;
  const TSA = hasRequire ? require('./stamp-tsa.js') : globalThis.StampTsa;
  const OTS = hasRequire ? require('./stamp-ots.js') : globalThis.StampOts;
  const Z = hasRequire ? require('./slog-zip.js') : globalThis.SlogZip;

  const CHUNK_FORMATS = new Set([1, 2, 3]);
  const KINDS = new Set(['open', 'edit', 'base', 'doc', 'on', 'off', 'sleep', 'wake', 'clock', 'close', 'stamp', 'relink']);
  // 20261007T160512Z-7f3a9c2e.slog, with -2, -3… if a name is ever taken
  const CHUNK_RE = /^(\d{8}T\d{6}Z)-([0-9a-f]{8})(?:-([1-9]\d{0,3}))?\.slog$/;
  const RECEIPT_RE = /^(\d{8}T\d{6}Z)-([0-9a-f]{8})(?:-([1-9]\d{0,3}))?\.stamps$/;
  // archive-20261009T181500Z-7f3a9c2e.zip: closed chunks and receipt files
  // merged into one file (by the device named, at the time named)
  const ARCHIVE_RE = /^archive-(\d{8}T\d{6}Z)-([0-9a-f]{8})(?:-([1-9]\d{0,3}))?\.zip$/;
  const isChunkName = (name) => typeof name === 'string' && CHUNK_RE.test(name);
  const isArchiveName = (name) => typeof name === 'string' && ARCHIVE_RE.test(name);
  // what an archive holds, at the paths the files had in the folder
  const isArchivable = (p) => typeof p === 'string' && (isChunkName(p) || (p.startsWith('stamps/') && RECEIPT_RE.test(p.slice(7))));

  /* ------------------------------------------------------------------ */
  /*  Hashing                                                            */
  /* ------------------------------------------------------------------ */

  // Canonical JSON: keys sorted at every level, no spaces, whole numbers
  // only. Anything that hashes an entry, in any language, gets the same bytes.
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

  // The two hashes everything here needs. Plain JavaScript by default;
  // useHash puts faster ones in (they must give the same bytes).
  let hash = {
    sha256hex: (s) => H.toHex(H.sha256(typeof s === 'string' ? H.utf8(s) : s)),
    hmac: (key, s) => H.hmacSha256(key, H.utf8(s))
  };
  function useHash(impl) {
    hash = { ...hash, ...impl };
  }
  const sha256hex = (s) => hash.sha256hex(s);

  // The clear part: the entry without its words (x). What the chain
  // hashes, and all a log shared without the text contains.
  function clearPart(entry) {
    const c = {};
    for (const k of Object.keys(entry)) if (k !== 'x') c[k] = entry[k];
    return c;
  }
  const entryHash = (entry) => sha256hex(canonical(clearPart(entry)));

  // Each entry's salt comes from the book's key and the entry's place in
  // its chain, so one entry's words can be shown (with its salt) without
  // the key to all the others.
  function saltFor(key, dev, n) {
    return hash.hmac(key, dev + ':' + n);
  }
  function commitment(key, dev, n, ins) {
    return sha256hex(H.concat(saltFor(key, dev, n), H.utf8(canonical(ins))));
  }

  // The manuscript's fingerprint: its prose as plain text, in Unicode's
  // composed form, every run of whitespace one space. Unsalted on purpose,
  // so a publisher holding the book can hash it and match the log's last word.
  function normalizeManuscript(text) {
    return String(text).normalize('NFC').replace(/\s+/gu, ' ').trim();
  }
  const manuscriptHash = (text) => sha256hex(normalizeManuscript(text));

  /* ------------------------------------------------------------------ */
  /*  Ops                                                                */
  /* ------------------------------------------------------------------ */

  // Ops are [at, del, ins] (plus a markup list) in UTF-16 units of the
  // document's text, applied in order, each `at` measured after the ops
  // before it. The inserted strings travel separately (an entry's x.ins).

  // Markup inside an insertion, as [offset, length] pairs, so a log with no
  // text can still count the letters that were written
  function markupRanges(s) {
    const out = [];
    for (const m of s.matchAll(/<[^>]*>/g)) out.push([m.index, m[0].length]);
    return out;
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

  // Where each op's inserted string ends up once all the entry's ops are
  // applied, or null for one a later op cuts into
  function insertOffsets(ops) {
    return ops.map((op, i) => {
      let at = op[0];
      const len = op[2];
      for (let j = i + 1; j < ops.length; j++) {
        const [bj, dj, lj] = ops[j];
        if (bj + dj <= at) at += lj - dj;
        else if (bj >= at + len) continue;
        else return null;
      }
      return at;
    });
  }

  /* ------------------------------------------------------------------ */
  /*  One character written two ways                                     */
  /* ------------------------------------------------------------------ */

  const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
  const NBSP_RE = /^&(?:nbsp|#0*160|#x0*a0);/i;

  // A string as the characters it stands for: a JSON document's escapes
  // decoded, and a no-break space however it's written (`&nbsp;`, `&#160;`,
  // `&#xa0;`, the character itself, or its JSON escape) read as a plain
  // space, since Chromium saves the space at the edge of a paste that way;
  // with where each character starts in the raw string (`at`, or null when
  // they're the same)
  function viewOf(raw, json) {
    const escapes = json && raw.indexOf('\\') >= 0;
    if (!escapes && raw.indexOf('\u00a0') < 0 && !/&(?:nbsp|#0*160|#x0*a0);/i.test(raw)) {
      return { raw, text: raw, at: null, json: !!json };
    }
    const chars = [];
    const at = [];
    let i = 0;
    while (i < raw.length) {
      at.push(i);
      const ch = raw.charCodeAt(i);
      if (escapes && ch === 92 && i + 1 < raw.length) {
        const c = raw[i + 1];
        const hex = raw.slice(i + 2, i + 6);
        if (c === 'u' && /^[0-9a-fA-F]{4}$/.test(hex)) {
          const u = parseInt(hex, 16);
          chars.push(u === 0xa0 ? ' ' : String.fromCharCode(u));
          i += 6;
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(ESCAPES, c)) { chars.push(ESCAPES[c]); i += 2; continue; }
      }
      if (ch === 38) {
        const m = NBSP_RE.exec(raw.slice(i, i + 10));
        if (m) { chars.push(' '); i += m[0].length; continue; }
      }
      chars.push(ch === 0xa0 ? ' ' : raw[i]);
      i++;
    }
    at.push(raw.length);
    return { raw, text: chars.join(''), at, json: !!json };
  }
  // one character, however it's written (a no-break space as a space)
  const sameChar = (a, b) => a === b || viewOf(a, true).text === viewOf(b, true).text;

  // A string as its words read, typography aside (a `relink`'s pieces are
  // matched and checked this way): a run of spaces (no-break, tabs and line
  // breaks too) as one space, curly and straight quotes and apostrophes as
  // straight ones, a run of hyphens or dashes as one hyphen, and three or
  // more full stops as an ellipsis. Like viewOf, with where each character
  // starts in the raw string (`at`, always given).
  // (by character code, for speed: the scan reads whole books this way)
  const looseSpace = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 0xa0 || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000;
  const looseDash = (c) => c === 45 || (c >= 0x2010 && c <= 0x2015) || c === 0x2212;
  const looseSq = (c) => c === 39 || c === 0x2018 || c === 0x2019 || c === 0x201a || c === 0x201b || c === 0x2032;
  const looseDq = (c) => c === 34 || c === 0x201c || c === 0x201d || c === 0x201e || c === 0x201f || c === 0x2033;
  function looseOf(raw, json) {
    const v = viewOf(String(raw), json);
    const src = v.text;
    const base = v.at || null;
    const out = [];
    const at = [];
    let i = 0;
    while (i < src.length) {
      const c = src.charCodeAt(i);
      at.push(base ? base[i] : i);
      let j = i + 1;
      let o = c;
      if (looseSpace(c)) {
        while (j < src.length && looseSpace(src.charCodeAt(j))) j++;
        o = 32;
      } else if (looseDash(c)) {
        while (j < src.length && looseDash(src.charCodeAt(j))) j++;
        o = 45;
      } else if (c === 46 && src.charCodeAt(i + 1) === 46 && src.charCodeAt(i + 2) === 46) {
        while (j < src.length && src.charCodeAt(j) === 46) j++;
        o = 0x2026;
      } else if (looseSq(c)) o = 39;
      else if (looseDq(c)) o = 34;
      out.push(o);
      i = j;
    }
    at.push(base ? base[src.length] : src.length);
    let text = '';
    for (let k = 0; k < out.length; k += 8192) text += String.fromCharCode.apply(null, out.slice(k, k + 8192));
    return { raw: String(raw), text, at, json: !!json };
  }
  // two stretches the same, typography aside
  const sameLoose = (a, b, json) => a === b || looseOf(a, json).text === looseOf(b, json).text;

  /* ------------------------------------------------------------------ */
  /*  Reading                                                            */
  /* ------------------------------------------------------------------ */

  // JSON Lines, as chunks and receipt files are written. A last line
  // without its newline is a write a crash cut short: it's set aside, not
  // counted, and not an error.
  function parseLines(text) {
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
  const parseChunk = parseLines;

  const textOf = (v) => (typeof v === 'string' ? v : H.fromUtf8(v));
  const bytesOf = (v) => (typeof v === 'string' ? H.utf8(v) : v);

  // A book's scribes-log folder, handed in as { path: text or bytes } with
  // paths relative to the folder ("log.json", "<chunk>.slog",
  // "stamps/<file>.stamps", "stamps/certs/<sha256>.der"). Chunks are
  // grouped by the device their open entry names. Returns { info, key,
  // logId, chains: [{ dev, chunks }], receipts: [{ file, line }], certs,
  // problems, notes }.
  //
  // Archives (archive-….zip) are unpacked first (expandArchives); with
  // `inflateSync` (Node's zlib.inflateRawSync) readLog does it itself, and
  // checkLog does it in any case. Paths may also be as an export has them
  // (chunks/<chunk>.slog) or under a scribes-log/ folder (logPaths).
  function readLog(files, { inflateSync = null, expanded = null } = {}) {
    files = logPaths(files);
    if (!expanded && Object.keys(files).some(isArchiveName)) {
      expanded = inflateSync ? expandArchivesSync(files, inflateSync)
        : { files: Object.fromEntries(Object.entries(files).filter(([p]) => !isArchiveName(p))), problems: Object.keys(files).filter(isArchiveName).map((p) => p + ': an archive that wasn\'t unpacked'), notes: [], archives: [] };
    }
    if (expanded) files = expanded.files;
    const out = { info: null, key: null, logId: null, chains: [], receipts: [], certs: [], problems: [], notes: [], archives: [] };
    if (expanded) {
      out.problems.push(...expanded.problems);
      out.notes.push(...expanded.notes);
      out.archives = expanded.archives;
    }
    const names = Object.keys(files).sort();
    const base = (p) => p.slice(p.lastIndexOf('/') + 1);
    const infoName = names.find((p) => p === 'log.json');
    if (infoName) {
      try {
        out.info = JSON.parse(textOf(files[infoName]));
        out.logId = typeof out.info.logId === 'string' ? out.info.logId : null;
        if (typeof out.info.key === 'string' && out.info.key) out.key = TSA.base64Decode(out.info.key);
      } catch (err) { out.problems.push('log.json can\'t be read: ' + err.message); }
    } else out.problems.push('no log.json');
    const byDev = new Map();
    for (const p of names) {
      const name = base(p);
      if (isChunkName(name) && !p.includes('/')) {
        const parsed = parseChunk(textOf(files[p]));
        const open = parsed.entries[0];
        const dev = open && open.kind === 'open' && typeof open.dev === 'string' ? open.dev : 'unknown-' + CHUNK_RE.exec(name)[2];
        if (open && out.logId && open.log !== out.logId) out.problems.push(`${name}: belongs to another log (${open.log})`);
        if (!byDev.has(dev)) byDev.set(dev, []);
        byDev.get(dev).push({ name, ...parsed });
      } else if (RECEIPT_RE.test(name) && p.startsWith('stamps/')) {
        const parsed = parseLines(textOf(files[p]));
        for (const pr of parsed.problems) out.problems.push(`${name}: line ${pr.line}: unreadable receipt`);
        if (parsed.partialTail) out.notes.push({ file: name, note: 'last receipt cut short (crash or power loss)' });
        for (const line of parsed.entries) out.receipts.push({ file: name, line });
      } else if (/^stamps\/certs\/[0-9a-f]{64}\.der$/.test(p)) {
        out.certs.push(bytesOf(files[p]));
      }
    }
    out.chains = [...byDev].map(([dev, chunks]) => ({ dev, chunks }));
    return out;
  }

  // Paths as readLog takes them, from a folder dropped whole
  // (scribes-log/…) or an export (chunks/<chunk>.slog beside stamps/)
  function logPaths(files) {
    const keys = Object.keys(files);
    let strip = '';
    const top = keys.length && keys.every((p) => p.includes('/')) ? keys[0].slice(0, keys[0].indexOf('/') + 1) : '';
    if (top && keys.every((p) => p.startsWith(top)) && keys.some((p) => p === top + 'log.json')) strip = top;
    const out = {};
    for (const p of keys) {
      let q = p.slice(strip.length);
      if (q.startsWith('chunks/') && isChunkName(q.slice(7))) q = q.slice(7);
      if (!(q in out)) out[q] = files[p];
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /*  Archives                                                           */
  /* ------------------------------------------------------------------ */

  const sameBytes = (a, b) => H.equal(a, b);
  const startsWith = (long, short) => long.length > short.length && H.equal(long.subarray(0, short.length), short);

  // A log's files with every archive's contents put in their places: the
  // folder's loose files, plus whatever each archive holds that isn't there.
  // The same file in two places must be the same bytes. A closed chunk
  // never changes, so two copies that differ are damage, except a copy
  // that's the start of the other (a sync still under way, or a receipt
  // file another device was still writing): the longer one is taken, and
  // it's noted. unpacked: [{ name, files, problems }] for each archive.
  function mergeArchives(files, unpacked) {
    const out = {};
    const where = {};
    const problems = [];
    const notes = [];
    const archives = [];
    for (const [p, v] of Object.entries(files)) {
      if (isArchiveName(p)) continue;
      out[p] = v;
      where[p] = 'the folder';
    }
    for (const a of unpacked.slice().sort((x, y) => (x.name < y.name ? -1 : 1))) {
      for (const pr of a.problems) problems.push(`${a.name}: ${pr}`);
      let count = 0;
      for (const [p, bytes] of Object.entries(a.files)) {
        if (!isArchivable(p)) { problems.push(`${a.name}: holds ${p}, which isn't part of a log`); continue; }
        count++;
        if (!(p in out)) { out[p] = bytes; where[p] = a.name; continue; }
        const had = bytesOf(out[p]);
        if (sameBytes(had, bytes)) continue;
        if (startsWith(bytes, had)) {
          notes.push({ file: p, note: `a shorter copy in ${where[p]}; the whole one in ${a.name} is used` });
          out[p] = bytes;
          where[p] = a.name;
        } else if (startsWith(had, bytes)) {
          notes.push({ file: p, note: `a shorter copy in ${a.name}; the whole one in ${where[p]} is used` });
        } else problems.push(`${p}: two different copies (${where[p]} and ${a.name})`);
      }
      archives.push({ name: a.name, files: count });
    }
    return { files: out, problems, notes, archives };
  }
  function expandArchivesSync(files, inflateRawSync) {
    const unpacked = [];
    for (const p of Object.keys(files).filter(isArchiveName)) {
      try { unpacked.push({ name: p, ...Z.unzipSync(bytesOf(files[p]), inflateRawSync) }); } catch (err) { unpacked.push({ name: p, files: {}, problems: ['can\'t be read: ' + err.message] }); }
    }
    return mergeArchives(files, unpacked);
  }
  async function expandArchives(files, inflateRaw) {
    files = logPaths(files);
    const unpacked = [];
    for (const p of Object.keys(files).filter(isArchiveName)) {
      try { unpacked.push({ name: p, ...await Z.unzip(bytesOf(files[p]), inflateRaw) }); } catch (err) { unpacked.push({ name: p, files: {}, problems: ['can\'t be read: ' + err.message] }); }
    }
    return mergeArchives(files, unpacked);
  }

  /* ------------------------------------------------------------------ */
  /*  Exports                                                            */
  /* ------------------------------------------------------------------ */

  // The files an export carries beside the log (NEO's README, its own copy
  // of the verifier, and the manifest itself), not listed in the manifest
  const EXPORT_EXTRAS = new Set(['README.txt', 'verifier.html', 'manifest.json']);

  // An unzipped export ({ name: bytes }) as checkLog takes it: { manifest,
  // files, problems }. Every file is checked against the manifest's size
  // and SHA-256; one missing, changed or not listed is a problem. (The
  // chains, receipts and words are checked by checkLog, as for any log.)
  function readExportFiles(unzipped, problems = []) {
    const out = { manifest: null, files: {}, problems: problems.slice() };
    const m = unzipped['manifest.json'];
    if (!m) { out.problems.push('no manifest.json: not an export from NEO'); } else {
      try { out.manifest = JSON.parse(textOf(m)); } catch (err) { out.problems.push('manifest.json can\'t be read: ' + err.message); }
    }
    const man = out.manifest;
    if (man && (man.kind !== 'scribes-log-export' || !Array.isArray(man.files))) {
      out.problems.push('manifest.json isn\'t a Scribe\'s Log export\'s');
    }
    const listed = new Map();
    if (man && Array.isArray(man.files)) for (const f of man.files) if (f && typeof f.path === 'string') listed.set(f.path, f);
    for (const [name, bytes] of Object.entries(unzipped)) {
      if (EXPORT_EXTRAS.has(name)) continue;
      const f = listed.get(name);
      const b = bytesOf(bytes);
      if (!f) { if (man) out.problems.push(name + ': not in the manifest'); } else if (f.size !== b.length || f.sha256 !== sha256hex(b)) out.problems.push(name + ': not the file the manifest lists');
      // chunks and receipt files as text, certificates as bytes
      out.files[name] = /\.der$/.test(name) ? b : (() => { try { return textOf(b); } catch { out.problems.push(name + ': isn\'t UTF-8'); return ''; } })();
    }
    for (const name of listed.keys()) if (!(name in unzipped)) out.problems.push(name + ': in the manifest but not in the export');
    out.files = logPaths(out.files);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /*  Checking a chain                                                   */
  /* ------------------------------------------------------------------ */

  // Chunks of one device in chain order: from the one that starts the
  // chain, each next one is the chunk whose open names it. Names sort by
  // time, but a clock set wrong mustn't reorder a chain, so the links decide.
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
  // key and the words are there, every commitment. Returns the problems
  // found (none means intact) and notes that aren't damage (a session that
  // ended without closing, a write cut short by a crash).
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
      if (!CHUNK_FORMATS.has(open.v)) problems.push({ chunk: c.name, problem: 'unknown format version ' + open.v });
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

  /* ------------------------------------------------------------------ */
  /*  Replay                                                             */
  /* ------------------------------------------------------------------ */

  // One device's chain replayed, entry by entry, into the documents as that
  // device saw them. With the words (x) it rebuilds the text; without them
  // (a log shared with no text) a document's text is null and only its
  // length is known.
  class Replayer {
    constructor(docs = {}) {
      this.text = { ...docs };
      this.length = {};
      for (const id of Object.keys(this.text)) this.length[id] = this.text[id] == null ? 0 : this.text[id].length;
      this.problems = [];
    }
    // Returns the document the entry changed, or null
    step(e) {
      const { text, length } = this;
      const apply = (id, start) => {
        const hasWords = e.x && Array.isArray(e.x.ins);
        length[id] = applyLengths(start === null ? length[id] || 0 : start.length, e.ops);
        if (hasWords && start !== null) text[id] = applyOps(start, e.ops, e.x.ins);
        else if (e.ops.every((op) => op[2] === 0) && start !== null) text[id] = applyOps(start, e.ops, e.ops.map(() => ''));
        else text[id] = null;
      };
      try {
        if (e.kind === 'base') {
          if (length[e.doc]) throw new Error('base over a document that already has text');
          apply(e.doc, '');
          return e.doc;
        }
        if (e.kind === 'edit') {
          if (!(e.doc in length)) throw new Error('edit to a document the log never saw');
          apply(e.doc, text[e.doc]);
          return e.doc;
        }
        if (e.kind === 'doc') {
          if (e.act === 'new') {
            if (length[e.doc]) throw new Error('new document over one that has text');
            text[e.doc] = '';
            length[e.doc] = 0;
          } else if (e.act === 'del') {
            if (!(e.doc in length)) throw new Error('deleting a document the log never saw');
            delete text[e.doc];
            delete length[e.doc];
          }
          return e.doc;
        }
      } catch (err) {
        this.problems.push({ n: e.n, doc: e.doc, problem: err.message });
      }
      return null;
    }
  }

  // Replay one device's chain. `docs` can carry a starting state (a cache);
  // entries at or below `from` are skipped.
  function replay(entries, { docs = {}, from = 0 } = {}) {
    const r = new Replayer(docs);
    for (const e of entries) if (!(e.n <= from)) r.step(e);
    return { docs: r.text, lengths: r.length, problems: r.problems };
  }

  /* ------------------------------------------------------------------ */
  /*  Origins                                                            */
  /* ------------------------------------------------------------------ */

  // Runs of units that share an origin: [[length, origin], …]. A run is
  // never changed in place, so a list can be copied by its array alone.
  //
  // A long document's runs number in the thousands (the report's detailed
  // origins split them by the hour), and each op used to walk them from the
  // start. Writing happens in one place for a while, so the list remembers
  // where the last change was ([index, offset of that run's start], kept
  // aside in `PLACES`) and the next search starts there. Only these four
  // functions change a list, and each leaves its place right; a copy
  // (slice) has none and starts from the front. The results are the same
  // either way.
  const PLACES = new WeakMap();
  function runsSplit(runs, pos) {
    let i = 0;
    let acc = 0;
    const h = PLACES.get(runs);
    if (h && h[0] <= runs.length) {
      i = h[0];
      acc = h[1];
      // back to the first run that starts at or before pos (and before any
      // empty runs at pos, as a walk from the front would find it)
      while (i > 0 && (pos < acc || (pos === acc && runs[i - 1][0] === 0))) { i--; acc -= runs[i][0]; }
    }
    for (; i < runs.length; i++) {
      if (acc === pos) { PLACES.set(runs, [i, acc]); return i; }
      const [len, o] = runs[i];
      if (pos < acc + len) {
        runs.splice(i, 1, [pos - acc, o], [acc + len - pos, o]);
        PLACES.set(runs, [i + 1, pos]);
        return i + 1;
      }
      acc += len;
    }
    if (acc === pos) { PLACES.set(runs, [runs.length, acc]); return runs.length; }
    throw new Error('op out of range');
  }
  function runsCut(runs, at, len) {
    const i = runsSplit(runs, at);
    const j = runsSplit(runs, at + len);
    const out = runs.splice(i, j - i);
    PLACES.set(runs, [i, at]);
    return out;
  }
  function runsSlice(runs, at, len) {
    const copy = runs.slice();
    return runsCut(copy, at, len);
  }
  // (and tidies the place it changed: the run before, what went in and the
  // run after, merged where they share an origin and empty runs dropped.
  // A cut leaves its place to the insert that always follows it, so a
  // list kept this way stays tidy without a pass over the whole of it.)
  function runsInsert(runs, at, add) {
    const i = runsSplit(runs, at);
    runs.splice(i, 0, ...add);
    const a = i > 0 ? i - 1 : 0;
    const start = i > 0 ? at - runs[i - 1][0] : at;
    const end = Math.min(runs.length, i + add.length + 1);
    const out = [];
    for (let k = a; k < end; k++) {
      const r = runs[k];
      if (!r[0]) continue;
      const last = out[out.length - 1];
      if (last && last[1] === r[1]) out[out.length - 1] = [last[0] + r[0], r[1]];
      else out.push(r);
    }
    runs.splice(a, end - a, ...out);
    PLACES.set(runs, [a, start]);
  }
  function runsTidy(runs) {
    const h = PLACES.get(runs);
    let hi = h ? h[0] : -1;
    let nh = null;
    let w = 0;
    let acc = 0;
    let lastStart = 0;
    for (let k = 0; k < runs.length; k++) {
      const r = runs[k];
      if (!r[0]) { if (k === hi) hi++; continue; } // (a place on an empty run moves on to the next)
      if (w && runs[w - 1][1] === r[1]) {
        runs[w - 1] = [runs[w - 1][0] + r[0], r[1]];
        if (k === hi) nh = [w - 1, lastStart];
      } else {
        if (k === hi) nh = [w, acc];
        lastStart = acc;
        runs[w++] = r;
      }
      acc += r[0];
    }
    runs.length = w;
    if (h) PLACES.set(runs, nh || [w, acc]);
    return runs;
  }
  // Where an entry's own words come from, when no `from` piece says otherwise
  function originOf(e) {
    if (e.kind === 'edit' && e.src === 'unlogged' && e.cause === 'off') return 'while off';
    if (e.src === 'editor') return editorOrigin(e.by);
    return typeof e.src === 'string' ? e.src : 'unlogged';
  }
  // An editor's text (a change from a Word review, accepted): "editor", or
  // "editor:Reviewer 1" when the entry says which. Only the book's own
  // numbering is read; anything else is just "editor".
  const EDITOR_BY = /^Reviewer [1-9]\d{0,3}$/;
  function editorOrigin(by) { return typeof by === 'string' && EDITOR_BY.test(by) ? 'editor:' + by : 'editor'; }
  // …and back: the reviewer an origin category names ('' for an editor
  // unnamed), or null when it isn't an editor's
  function editorOf(cat) {
    const c = String(cat || '');
    if (c === 'editor') return '';
    return c.startsWith('editor:') ? c.slice(7) : null;
  }

  // Detailed origins (a Tracer made with `detail`, for the report): each
  // unit's origin is "category|hour|paste|flags", the hour (UTC hours since
  // 1970) the unit was first written in, a paste's own id ("dev8:n:op"),
  // and flags: "m" moved within the book, "r" matched to earlier writing by
  // a `relink`, "g" (with "r") text that reappeared while the log was off or
  // without a label, "t" markup (inside a tag, as the op's markup list says,
  // so it's known without the words). "t" is always last.
  const detailOrigin = (cat, hour, paste, moved, tag, relinked = false, gap = false) =>
    cat + '|' + (hour == null ? '' : hour) + '|' + (paste == null ? '' : paste) + '|' +
    (moved ? 'm' : '') + (relinked ? 'r' : '') + (gap ? 'g' : '') + (tag ? 't' : '');
  function parseOrigin(o) {
    const [cat, hour, paste, flags = ''] = String(o).split('|');
    return {
      cat, hour: hour === undefined || hour === '' ? null : +hour, paste: paste || null,
      moved: flags.includes('m'), relinked: flags.includes('r'), gap: flags.includes('g'), tag: flags.includes('t')
    };
  }
  const originCat = (o) => { const i = o.indexOf('|'); return i < 0 ? o : o.slice(0, i); };
  // the same runs as another category (another book's text), or moved
  function recat(runs, cat, detail) {
    if (!detail) return runs.length ? [[runs.reduce((a, r) => a + r[0], 0), cat]] : [];
    return runsTidy(runs.map(([len, o]) => { const p = parseOrigin(o); return [len, detailOrigin(cat, p.hour, p.paste, p.moved, p.tag, p.relinked, p.gap)]; }));
  }
  function asMoved(runs) {
    return runs.map(([len, o]) => { const p = parseOrigin(o); return p.hour === null && !o.includes('|') ? [len, o] : [len, detailOrigin(p.cat, p.hour, p.paste, true, p.tag, p.relinked, p.gap)]; });
  }
  // …or matched to earlier writing by a relink (and whether it came back in a gap)
  function asRelinked(runs, gap) {
    return runs.map(([len, o]) => { const p = parseOrigin(o); return p.hour === null && !o.includes('|') ? [len, o] : [len, detailOrigin(p.cat, p.hour, p.paste, p.moved, p.tag, true, gap || p.gap)]; });
  }
  // the origin of the nearest unit of prose (not markup) before pos (dir
  // -1) or at or after it (dir 1), or null. Searched from the run around
  // pos (found from the list's last place, as runsSplit does), outwards.
  const isTagOrigin = (o) => o.charCodeAt(o.length - 1) === 116 && o.includes('|'); // ("…|t" or "…|mt")
  function proseNear(runs, pos, dir) {
    let i = 0;
    let acc = 0;
    const h = PLACES.get(runs);
    if (h && h[0] <= runs.length) {
      i = h[0];
      acc = h[1];
      while (i > 0 && pos < acc) { i--; acc -= runs[i][0]; }
    }
    // the first run that ends after pos: every run before it ends at or before pos
    while (i < runs.length && acc + runs[i][0] <= pos) { acc += runs[i][0]; i++; }
    if (dir < 0) {
      let start = acc;
      for (let k = i; k >= 0; k--) {
        if (k < i) start -= runs[k][0];
        if (k < runs.length && start < pos && !isTagOrigin(runs[k][1])) return runs[k][1];
      }
      return null;
    }
    for (let k = i; k < runs.length; k++) if (!isTagOrigin(runs[k][1])) return runs[k][1];
    return null;
  }

  const whole = (v) => Number.isSafeInteger(v) && v >= 0;
  const isDevSource = (s) => !!s && typeof s === 'object' && typeof s.dev === 'string';
  const isGraveSource = (s) => !!s && typeof s === 'object' && !isDevSource(s) && typeof s.log !== 'string' && Number.isSafeInteger(s.n);
  // The labels whose words a `relink` can place: a move whose place wasn't
  // recorded, a paste or drop from outside NEO, and text that reached the
  // disk without a label (changed while the log was off, or unlogged). Text
  // the log saw written (typed, imported, an editor's) is never relinked.
  const RELINKABLE = new Set(['move', 'paste', 'drop', 'unlogged']);
  const isJsonDocName = (doc) => doc === 'book' || doc === 'darlings' || doc === 'stickies';

  // One device's chain replayed keeping, for every unit of every document,
  // where it first came from. Steps one entry at a time, so a chain whose
  // text arrived from another device's can wait for that one to catch up
  // (traceAll). `resolve(dev, n, doc)` gives another device's document as
  // it stood after its entry n: { state } or { error }.
  class Tracer {
    constructor(entries, { dev = null, resolve = null, links = null, detail = false, hooks = null, relinks = null } = {}) {
      this.dev = dev;
      this.detail = detail;         // origins with time, paste ids and markup (detailOrigin)…
      this.full = detail === true;  // …or, with 'moved', only whether text was moved within the book (playback)
      this.movedOnly = detail === 'moved';
      // { step(e, tracer), cut(e, gone), back(e, take, source, from) } (detail only),
      // pre(e, tracer) just before an entry, buried(key, grave) each deletion
      this.hooks = hooks;
      // n → [{ pieces, by: { dev, n } }]: `relink` entries' pieces for this
      // chain's edits, from any device's chain (collectRelinks)
      this.relinks = relinks;
      this.relinkUsed = new Set();
      this.revised = new Set();     // detail only: pastes with words put in or taken out inside them
      this.entries = entries;
      this.resolve = resolve;
      this.links = links;           // n → { dev, n, doc }: text matched to another device's, not recorded
      this.pos = 0;
      this.lastN = 0;
      this.busy = false;
      this.docs = {};
      this.graves = new Map();
      this.problems = [];
      this.snaps = new Map();       // "n|doc" → { text, len, runs }, for other devices
      this.snapWant = new Map();    // n → Set of docs
      this.wanted = new Set();      // "n:op" of deletions a from points at
      for (const e of entries) {
        if (e.kind !== 'edit' || !Array.isArray(e.from)) continue;
        for (const p of e.from) if (Array.isArray(p) && isGraveSource(p[3])) this.wanted.add(p[3].n + ':' + p[3].op);
      }
      if (relinks) {
        for (const list of relinks.values()) {
          for (const r of list) for (const p of r.pieces) if (Array.isArray(p) && isGraveSource(p[3])) this.wanted.add(p[3].n + ':' + p[3].op);
        }
      }
    }

    // The pieces an edit's inserted words take their origins from: its own
    // `from` (or, for text that arrived, the other device's document it was
    // matched to), then the pieces `relink` entries add for it, each only
    // where it fills units nothing before it covers. { pieces, quiet,
    // relinked (the Set of pieces that came from a relink, or null), bad
    // ([{ by, problem }] for relinks that can't apply) }.
    piecesOf(e) {
      let pieces = e.from === undefined ? [] : e.from;
      let quiet = false;
      if (e.kind === 'edit' && e.from === undefined) {
        const l = this._linked(e);
        if (l) { pieces = l; quiet = true; }
      }
      const rel = this.relinks && Number.isSafeInteger(e.n) ? this.relinks.get(e.n) : null;
      if (!rel || !rel.length) return { pieces, quiet, relinked: null, bad: [] };
      const bad = [];
      if (e.kind !== 'edit' || !RELINKABLE.has(e.src)) {
        for (const r of rel) bad.push({ by: r.by, problem: 'relink on text whose origin was recorded' });
        return { pieces, quiet, relinked: null, bad };
      }
      if (!Array.isArray(pieces)) return { pieces, quiet, relinked: null, bad };
      // what's covered already, per op: [[at, end], …]
      const taken = new Map();
      const cover = (op, a, b) => { if (!taken.has(op)) taken.set(op, []); taken.get(op).push([a, b]); };
      const free = (op, a, b) => (taken.get(op) || []).every(([x, y]) => b <= x || a >= y);
      for (const p of pieces) if (Array.isArray(p) && whole(p[0]) && whole(p[1]) && Number.isSafeInteger(p[2])) cover(p[0], p[1], p[1] + p[2]);
      const relinked = new Set();
      const added = [];
      for (const r of rel) {
        if (r.by.dev === this.dev && !(r.by.n > e.n)) { bad.push({ by: r.by, problem: 'relink points ahead of itself' }); continue; }
        for (const p of r.pieces) {
          const ok = Array.isArray(p) && whole(p[0]) && p[0] < e.ops.length && whole(p[1]) && Number.isSafeInteger(p[2]) && p[2] > 0 &&
            p[1] + p[2] <= e.ops[p[0]][2];
          if (!ok) { bad.push({ by: r.by, problem: 'relink piece out of range' }); continue; }
          const s = p[3];
          if (!s || typeof s !== 'object' || isDevSource(s) || typeof s.log === 'string' || !(isGraveSource(s) || typeof s.doc === 'string')) {
            bad.push({ by: r.by, problem: 'relink piece has no source it can use' });
            continue;
          }
          // (a unit already placed keeps its place: never an error, two
          // computers can match the same words)
          if (!free(p[0], p[1], p[1] + p[2])) continue;
          cover(p[0], p[1], p[1] + p[2]);
          relinked.add(p);
          added.push(p);
        }
      }
      if (!added.length) return { pieces, quiet, relinked: null, bad };
      const all = [...pieces, ...added].sort((a, b) => (Array.isArray(a) && Array.isArray(b) ? (a[0] - b[0]) || (a[1] - b[1]) : 0));
      return { pieces: all, quiet, relinked, bad };
    }

    want(n, doc) {
      if (!this.snapWant.has(n)) this.snapWant.set(n, new Set());
      this.snapWant.get(n).add(doc);
    }
    snapshot(n, doc) {
      return this.snaps.get(n + '|' + doc) || null;
    }

    // Entries up to and including n (all of them by default)
    advance(toN = Infinity) {
      this.busy = true;
      try {
        while (this.pos < this.entries.length) {
          const e = this.entries[this.pos];
          if (Number.isSafeInteger(e.n) && e.n > toN) break;
          this.pos++;
          if (this.hooks && this.hooks.pre) this.hooks.pre(e, this);
          this.step(e);
          if (Number.isSafeInteger(e.n)) this.lastN = e.n;
          if (this.hooks && this.hooks.step) this.hooks.step(e, this);
          const docs = this.snapWant.get(e.n);
          if (docs) {
            for (const doc of docs) {
              const d = this.docs[doc];
              if (d) this.snaps.set(e.n + '|' + doc, { text: d.text, len: d.len, runs: d.runs.slice() });
            }
          }
        }
      } finally {
        this.busy = false;
      }
      return this;
    }

    // The text and origins a `from` source names, or { error }
    _source(e, source, i, before) {
      if (typeof source.log === 'string') return null; // another book: handled by the caller
      if (isDevSource(source)) {
        if (source.dev === this.dev) return { error: 'from names its own device' };
        if (!this.resolve) return { error: 'from names a device whose log isn\'t here' };
        const r = this.resolve(source.dev, source.n, source.doc);
        return r.error ? r : r.state;
      }
      if (Number.isSafeInteger(source.n)) {
        if (source.n > e.n || (source.n === e.n && !(source.op <= i))) return { error: 'from points ahead of itself' };
        const g = this.graves.get(source.n + ':' + source.op);
        return g || { error: 'from points at nothing deleted' };
      }
      if (typeof source.doc === 'string') {
        const src = source.doc === e.doc ? before : this.docs[source.doc];
        return src || { error: 'from points at a document that isn\'t there' };
      }
      return { error: 'from piece has no source' };
    }

    // The units an op of this entry inserts, as its own: one run, or with
    // detail, prose and markup apart, each stamped with the hour and paste
    _own(e, i, len, cat) {
      if (!len) return [];
      if (!this.full) return [[len, cat]];
      const hour = Number.isSafeInteger(e.ts) ? Math.floor(e.ts / 3600e3) : '';
      const paste = cat === 'paste' ? (this.dev ? this.dev.slice(0, 8) : '') + ':' + e.n + ':' + i : '';
      const op = e.ops[i];
      const marks = Array.isArray(op[3]) ? op[3] : [];
      const out = [];
      let pos = 0;
      for (const m of marks) {
        if (!Array.isArray(m) || !whole(m[0]) || !(m[1] > 0) || m[0] < pos || m[0] + m[1] > len) continue;
        if (m[0] > pos) out.push([m[0] - pos, detailOrigin(cat, hour, paste, false, false)]);
        out.push([m[1], detailOrigin(cat, hour, paste, false, true)]);
        pos = m[0] + m[1];
      }
      if (pos < len) out.push([len - pos, detailOrigin(cat, hour, paste, false, false)]);
      return runsTidy(out);
    }

    // Pieces for a whole document matched to another device's (links)
    _linked(e, len) {
      const l = this.links && this.links.get(e.n);
      if (!l) return null;
      if (e.kind === 'base') return len ? [[0, 0, len, { dev: l.dev, n: l.n, doc: l.doc, at: 0 }]] : null;
      const offs = insertOffsets(e.ops);
      const out = [];
      e.ops.forEach((op, i) => { if (op[2] && offs[i] !== null) out.push([i, 0, op[2], { dev: l.dev, n: l.n, doc: l.doc, at: offs[i] }]); });
      return out.length ? out : null;
    }

    step(e) {
      const where = { n: e.n, doc: e.doc };
      const { docs, graves, problems } = this;
      if (e.kind !== 'edit' && this.relinks && this.relinks.has(e.n)) {
        this.relinkUsed.add(e.n);
        for (const r of this.relinks.get(e.n)) problems.push({ n: r.by.n, ...(r.by.dev !== this.dev ? { relinkDev: r.by.dev } : {}), of: e.n, problem: 'relink on text whose origin was recorded' });
      }
      try {
        if (e.kind === 'base') {
          if (docs[e.doc] && docs[e.doc].len) throw new Error('base over a document that already has text');
          const len = e.ops.reduce((a, op) => a + op[2], 0);
          const text = e.x && Array.isArray(e.x.ins) ? e.x.ins.join('') : null;
          const runs = this.full ? e.ops.flatMap((op, i) => this._own(e, i, op[2], originOf(e))) : (len ? [[len, originOf(e)]] : []);
          // a copy's base names the book it was copied from; text that
          // arrived from another device names that device's document
          let pieces = e.from;
          let quiet = false;
          if (pieces === undefined) { pieces = this._linked(e, len); quiet = !!pieces; }
          if (pieces) {
            if (!Array.isArray(pieces)) throw new Error('from isn\'t a list');
            let end = 0;
            for (const p of pieces) {
              const bad = (problem) => { if (!quiet) problems.push({ ...where, piece: p, problem }); };
              const ok = Array.isArray(p) && p[0] === 0 && Number.isSafeInteger(p[1]) && p[1] >= end &&
                Number.isSafeInteger(p[2]) && p[2] > 0 && p[1] + p[2] <= len;
              if (!ok) { bad('from piece out of range'); continue; }
              const source = p[3];
              if (source && typeof source.log === 'string') {
                end = p[1] + p[2];
                const was = runsCut(runs, p[1], p[2]);
                runsInsert(runs, p[1], recat(was, 'other book', this.full));
                continue;
              }
              if (!isDevSource(source)) { bad('a base\'s from can only name another book'); continue; }
              const src = this._source(e, source, 0, null);
              if (src.error) { bad(src.error); continue; }
              const take = this._take(p, null, source, src, text, originOf(e), bad);
              if (!take) continue;
              end = p[1] + p[2];
              runsCut(runs, p[1], p[2]);
              runsInsert(runs, p[1], take);
            }
            runsTidy(runs);
          }
          docs[e.doc] = { text, len, runs };
        } else if (e.kind === 'doc') {
          if (e.act === 'new') docs[e.doc] = { text: '', len: 0, runs: [] };
          else if (e.act === 'del') delete docs[e.doc];
        } else if (e.kind === 'edit') {
          const d = docs[e.doc];
          if (!d) throw new Error('edit to a document the log never saw');
          const words = e.x && Array.isArray(e.x.ins) ? e.x.ins : null;
          const got = this.piecesOf(e);
          if (got.bad.length || (this.relinks && this.relinks.has(e.n))) this.relinkUsed.add(e.n);
          for (const b of got.bad) problems.push({ n: b.by.n, ...(b.by.dev !== this.dev ? { relinkDev: b.by.dev } : {}), of: e.n, problem: b.problem });
          const pieces = got.pieces;
          const relinked = got.relinked;
          const quiet = got.quiet;
          if (!Array.isArray(pieces)) throw new Error('from isn\'t a list');
          const before = pieces.some((p) => p && p[3] && p[3].doc === e.doc && !isDevSource(p[3])) ? { text: d.text, len: d.len, runs: d.runs.slice() } : null;
          const own = originOf(e);
          const clean = problems.length;
          let last = [-1, 0];
          e.ops.forEach((op, i) => {
            const [at, del, len] = op;
            if (!(whole(at) && whole(del) && whole(len) && at + del <= d.len)) throw new Error('op out of range');
            if (this.full) {
              // words put in or taken out inside a paste, with its prose on
              // both sides: it's been revised
              const before1 = proseNear(d.runs, at, -1);
              const after1 = proseNear(d.runs, at + del, 1);
              if ((del || len) && before1 && after1) {
                const a = parseOrigin(before1);
                const b = parseOrigin(after1);
                if (a.paste && a.paste === b.paste) this.revised.add(a.paste);
              }
            }
            const gone = runsCut(d.runs, at, del);
            const key = e.n + ':' + i;
            const keep = this.wanted.has(key);
            const tell = del && this.hooks && this.hooks.buried;
            if (keep || tell) {
              const g = { text: d.text === null ? null : d.text.slice(at, at + del), len: del, runs: gone, doc: e.doc, ts: e.ts };
              if (keep) graves.set(key, g);
              if (tell) this.hooks.buried(key, g, e, i);
            }
            if (this.hooks && this.hooks.cut && gone.length) this.hooks.cut(e, gone);
            const put = words ? words[i] : null;
            const add = this._own(e, i, len, own);
            for (const p of pieces) {
              if (!Array.isArray(p) || p[0] !== i) continue;
              const [, pa, pl, source] = p;
              const isRelink = !!(relinked && relinked.has(p));
              const bad = (problem) => { if (!quiet || isRelink) problems.push({ ...where, piece: p, problem: isRelink ? 'relink: ' + problem : problem }); };
              if (!(whole(pa) && Number.isSafeInteger(pl) && pl > 0 && pa + pl <= len)) { bad('from piece out of range'); continue; }
              if (i < last[0] || (i === last[0] && pa < last[1])) { bad('from pieces overlap or are out of order'); continue; }
              last = [i, pa + pl];
              if (!source || typeof source !== 'object') { bad('from piece has no source'); continue; }
              let take;
              if (typeof source.log === 'string') take = recat(runsSlice(add, pa, pl), 'other book', this.full);
              else {
                const src = this._source(e, source, i, before);
                if (src.error) { bad(src.error); continue; }
                const loose = isRelink ? { json: isJsonDocName(e.doc), srcJson: isJsonDocName(isGraveSource(source) ? src.doc : source.doc) } : null;
                take = this._take(p, put, source, src, null, own, bad, loose);
                if (!take) continue;
                if (isRelink) {
                  if (this.full) {
                    take = asRelinked(take, own === 'while off' || own === 'unlogged');
                    if (this.hooks && this.hooks.back) this.hooks.back(e, take, source, src);
                  } else if (this.movedOnly) take = take.map(([l, o]) => [l, detailOrigin(originCat(o), '', '', true, false)]);
                } else if (this.full && !isDevSource(source)) {
                  take = asMoved(take);
                  if (this.hooks && this.hooks.back) this.hooks.back(e, take, source, src);
                } else if (this.movedOnly && !isDevSource(source)) take = take.map(([l, o]) => [l, detailOrigin(originCat(o), '', '', true, false)]);
              }
              runsCut(add, pa, pl);
              runsInsert(add, pa, take);
            }
            runsInsert(d.runs, at, add);
            if (this.detail) d.v = (d.v || 0) + 1;
            if (d.text !== null) d.text = put !== null ? d.text.slice(0, at) + put + d.text.slice(at + del) : (len ? null : d.text.slice(0, at) + d.text.slice(at + del));
            d.len += len - del;
          });
          // (each op's insert tidied its own place: no pass over the whole list)
          if (e.src === 'arrived' && problems.length === clean) this._adopt(pieces, d);
        }
      } catch (err) {
        problems.push({ ...where, problem: err.message });
      }
    }

    // An arrival that leaves a document exactly as another device's stood
    // takes that device's origins whole. Which of two like characters an
    // edit kept and which it put in is only the diff's guess (a sentence
    // moved to just after a full stop can come out as keeping the stop
    // and putting in the sentence's own), so pieces alone can trade one
    // origin for another; the device that made the change knows. Only when
    // every piece names the same entry of the same device, and the lengths
    // (and the words, when they're here) are the same.
    _adopt(pieces, d) {
      let one = null;
      for (const p of pieces) {
        const s = Array.isArray(p) ? p[3] : null;
        if (!isDevSource(s)) return;
        if (one && (s.dev !== one.dev || s.n !== one.n || s.doc !== one.doc)) return;
        one = s;
      }
      if (!one || !this.resolve) return;
      const r = this.resolve(one.dev, one.n, one.doc);
      if (!r || r.error) return;
      const src = r.state;
      if (src.len !== d.len) return;
      if (d.text !== null && src.text != null && d.text !== src.text) return;
      d.runs = src.runs.slice();
    }

    // The origins a piece takes from its source, checked: it must fit
    // inside the text it names and, with the words, be that text. `put` is
    // the op's inserted string (an edit) or the base's whole text.
    // `loose` ({ json, srcJson }, a relink's piece): the two stretches only
    // have to be the same typography aside (looseOf).
    _take(p, put, source, src, baseText, own, bad, loose = null) {
      const [, pa, pl] = p;
      const sl = source.len === undefined ? pl : source.len;
      const sa = source.at;
      if (!(whole(sa) && Number.isSafeInteger(sl) && sl > 0 && sa + sl <= src.len)) { bad('from points past the text it names'); return null; }
      const mineAll = baseText != null ? baseText : put;
      const mine = mineAll != null && typeof mineAll === 'string' ? mineAll.slice(pa, pa + pl) : null;
      const theirs = src.text != null ? src.text.slice(sa, sa + sl) : null;
      const same = mine === null || theirs === null || mine === theirs ||
        (loose ? looseOf(mine, loose.json).text === looseOf(theirs, loose.srcJson).text : sameChar(mine, theirs));
      if (!same) { bad('moved text doesn\'t match where it came from'); return null; }
      const runs = runsSlice(src.runs, sa, sl);
      return sl === pl && (mine === null || theirs === null || mine === theirs)
        ? runs
        : [[pl, runs.length ? runs[0][1] : (this.full ? detailOrigin(own, '', '', false, false) : own)]];
    }
  }

  // Every device's chain traced together: text that arrived from another
  // device (a `from` naming it, or `links`) takes the origins it had there.
  // chains: [{ dev, entries }]. links: Map dev → Map n → { dev, n, doc }.
  // detail and hooks (dev → hooks) as for a Tracer (the report's; detail
  // 'moved' keeps only the category and whether it was moved, playback's).
  // Returns Map dev → { docs: { id: { text, len, runs } }, problems, revised }.
  // Every `relink` entry's pieces, by the chain whose edit they place:
  // { byDev: Map dev → Map n → [{ pieces, by: { dev, n } }], problems:
  // Map dev → [problem] } (problems on the chain the relink is written in).
  // A relink names its edit by `of`, on its own chain, or on the chain of
  // `dev` when it has one. Several relinks for one edit apply in the order
  // their chains are given, then in chain order.
  function collectRelinks(chains) {
    const byDev = new Map();
    const problems = new Map();
    const devs = new Set(chains.map((c) => c.dev));
    for (const c of chains) {
      for (const e of c.entries) {
        if (e.kind !== 'relink') continue;
        const bad = (problem) => {
          if (!problems.has(c.dev)) problems.set(c.dev, []);
          problems.get(c.dev).push({ n: e.n, problem });
        };
        const target = typeof e.dev === 'string' ? e.dev : c.dev;
        if (!Number.isSafeInteger(e.of) || e.of < 1 || !Array.isArray(e.from) || !e.from.length) { bad('relink isn\'t well formed'); continue; }
        if (!devs.has(target)) { bad('relink names a device whose log isn\'t here'); continue; }
        if (target === c.dev && !(e.of < e.n)) { bad('relink points ahead of itself'); continue; }
        if (!byDev.has(target)) byDev.set(target, new Map());
        const m = byDev.get(target);
        if (!m.has(e.of)) m.set(e.of, []);
        m.get(e.of).push({ pieces: e.from, by: { dev: c.dev, n: e.n } });
      }
    }
    return { byDev, problems };
  }
  // …and those whose edit never came: once every chain has been traced
  function orphanRelinks(tracers) {
    for (const t of tracers.values()) {
      if (!t.relinks) continue;
      for (const [n, list] of t.relinks) {
        if (t.relinkUsed.has(n)) continue;
        for (const r of list) t.problems.push({ n: r.by.n, ...(r.by.dev !== t.dev ? { relinkDev: r.by.dev } : {}), of: n, problem: 'relink names an entry that isn\'t there' });
      }
    }
  }

  function traceAll(chains, { links = null, detail = false, hooks = null } = {}) {
    const tracers = new Map();
    const rel = collectRelinks(chains);
    const resolve = (dev, n, doc) => {
      const t = tracers.get(dev);
      if (!t) return { error: 'from names a device whose log isn\'t here' };
      if (t.lastN < n) {
        if (t.busy) return { error: 'from points ahead of itself' };
        t.advance(n);
      }
      const state = t.snapshot(n, doc);
      if (!state) return { error: t.lastN < n ? 'from points at an entry that isn\'t there' : 'from points at a document that isn\'t there' };
      return { state };
    };
    for (const c of chains) {
      const t = new Tracer(c.entries, { dev: c.dev, resolve, links: links && links.get(c.dev), detail, hooks: hooks && hooks(c.dev), relinks: rel.byDev.get(c.dev) || null });
      t.problems.push(...(rel.problems.get(c.dev) || []));
      tracers.set(c.dev, t);
    }
    // what each device's text is wanted at, by the others
    for (const c of chains) {
      for (const e of c.entries) {
        if ((e.kind !== 'edit' && e.kind !== 'base') || !Array.isArray(e.from)) continue;
        for (const p of e.from) {
          const s = Array.isArray(p) ? p[3] : null;
          if (isDevSource(s) && tracers.has(s.dev) && Number.isSafeInteger(s.n)) tracers.get(s.dev).want(s.n, s.doc);
        }
      }
      const l = links && links.get(c.dev);
      if (l) for (const v of l.values()) if (tracers.has(v.dev)) tracers.get(v.dev).want(v.n, v.doc);
    }
    for (const t of tracers.values()) t.advance();
    orphanRelinks(tracers);
    const out = new Map();
    for (const [dev, t] of tracers) out.set(dev, { docs: t.docs, problems: t.problems, revised: t.revised });
    return out;
  }

  // One chain on its own (a `from` naming another device is a problem)
  function trace(entries) {
    const rel = collectRelinks([{ dev: null, entries }]);
    const t = new Tracer(entries, { relinks: rel.byDev.get(null) || null });
    t.problems.push(...(rel.problems.get(null) || []));
    t.advance();
    orphanRelinks(new Map([[null, t]]));
    return { docs: t.docs, problems: t.problems };
  }

  // Text that arrived from another device without a `from` (that device's
  // chunks hadn't synced when it arrived), matched by its words: for each
  // such entry, the first entry of another device's chain after which that
  // document was exactly the same. Needs the words. Returns Map dev → Map
  // n → { dev, n, doc }.
  function matchArrivals(chains) {
    const targets = new Map(); // doc → Map len → [{ dev, n, hash }]
    const all = [];
    for (const c of chains) {
      const r = new Replayer();
      for (const e of c.entries) {
        const doc = r.step(e);
        const arrived = e.src === 'arrived' && e.from === undefined &&
          ((e.kind === 'base' && e.ops.some((op) => op[2])) || (e.kind === 'edit' && e.ops.some((op) => op[2])));
        if (!doc || !arrived) continue;
        const text = r.text[doc];
        if (typeof text !== 'string') continue;
        const t = { dev: c.dev, n: e.n, doc, hash: sha256hex(text), found: null };
        if (!targets.has(doc)) targets.set(doc, new Map());
        const byLen = targets.get(doc);
        if (!byLen.has(text.length)) byLen.set(text.length, []);
        byLen.get(text.length).push(t);
        all.push(t);
      }
    }
    if (!all.length) return new Map();
    for (const c of chains) {
      const r = new Replayer();
      for (const e of c.entries) {
        const doc = r.step(e);
        if (!doc || !targets.has(doc)) continue;
        const text = r.text[doc];
        if (typeof text !== 'string') continue;
        const list = targets.get(doc).get(text.length);
        if (!list) continue;
        let h = null;
        for (const t of list) {
          if (t.dev === c.dev || (t.found && t.found.ts <= e.ts)) continue;
          if (h === null) h = sha256hex(text);
          if (h === t.hash) t.found = { dev: c.dev, n: e.n, doc, ts: e.ts };
        }
      }
    }
    const out = new Map();
    for (const t of all) {
      if (!t.found) continue;
      if (!out.has(t.dev)) out.set(t.dev, new Map());
      out.get(t.dev).set(t.n, { dev: t.found.dev, n: t.found.n, doc: t.doc });
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /*  Documents and the manuscript                                       */
  /* ------------------------------------------------------------------ */

  // A book's documents are its chapters (each by its own id), notes,
  // outline, darlings, stickies and book. A chapter file named like one of
  // the others gets "ch:" in front.
  const AUX_DOCS = ['notes', 'outline'];
  const JSON_DOCS = ['darlings', 'stickies'];
  const NAMED_DOCS = new Set(['book', ...AUX_DOCS, ...JSON_DOCS]);
  const chapterDoc = (id) => (NAMED_DOCS.has(id) ? 'ch:' + id : id);
  function docChapter(doc) {
    if (NAMED_DOCS.has(doc)) return null;
    return doc.startsWith('ch:') && NAMED_DOCS.has(doc.slice(3)) ? doc.slice(3) : doc;
  }

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

  // A chapter's lines, as the manuscript hash sees them (SLOG-FORMAT.md)
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

  // The manuscript as text, read from the documents (each a string)
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

  // Units of a chapter's text that are the writing: outside tags, and
  // outside what the manuscript hash leaves out (scene breaks, unwritten
  // outline sections, placeholder flags, Darlings anchors). 1 for each such
  // unit; a character reference marks only its first unit.
  function proseMask(html) {
    const mask = new Uint8Array(html.length).fill(1);
    const stack = [];
    let skip = 0;
    let last = 0;
    const TAG = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g;
    let m;
    while ((m = TAG.exec(html))) {
      if (skip) mask.fill(0, last, m.index);
      mask.fill(0, m.index, TAG.lastIndex);
      last = TAG.lastIndex;
      const name = m[2].toLowerCase();
      if (!m[1]) {
        if (VOID_TAGS.has(name) || /\/\s*$/.test(m[3])) continue;
        const cls = classesOf(m[3]);
        const out = cls.has('scene-break') || LEFT_OUT.some((c) => cls.has(c));
        stack.push({ name, out });
        if (out) skip++;
        continue;
      }
      let i = stack.length - 1;
      while (i >= 0 && stack[i].name !== name) i--;
      if (i < 0) continue;
      while (stack.length > i) if (stack.pop().out) skip--;
    }
    if (skip) mask.fill(0, last);
    // a character reference is one character of writing, however long it's
    // written (`&nbsp;` counts 1, not 6)
    const REF = /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi;
    while ((m = REF.exec(html))) if (mask[m.index]) mask.fill(0, m.index + 1, REF.lastIndex);
    return mask;
  }

  // What the manuscript is made of: units of its writing (proseMask) in
  // each chapter, in the book's order, counted by where they came from.
  // Needs the words; returns null without them.
  function composition(docs) {
    const book = docs.book && docs.book.text;
    let meta = null;
    try { meta = JSON.parse(book); } catch { /* no book document */ }
    const order = meta && Array.isArray(meta.chapterOrder) ? meta.chapterOrder : Object.keys(docs).filter((d) => docChapter(d) !== null).map(docChapter).sort();
    const kinds = (meta && meta.chapterKinds) || {};
    const out = {};
    for (const id of order) {
      const d = docs[chapterDoc(id)];
      if (!d || kinds[id] === 'contents') continue;
      if (d.text === null) return null;
      const mask = proseMask(d.text);
      let pos = 0;
      for (const [len, origin] of d.runs) {
        let n = 0;
        for (let k = pos; k < pos + len; k++) n += mask[k];
        if (n) out[origin] = (out[origin] || 0) + n;
        pos += len;
      }
    }
    return out;
  }

  // The origins of units at..at+len of a traced document, as [[len, origin], …]
  function originsAt(doc, at, len) {
    return runsTidy(runsSlice(doc.runs, at, len));
  }

  /* ------------------------------------------------------------------ */
  /*  Receipts: outside timestamps checked against the chains            */
  /* ------------------------------------------------------------------ */

  const SKEW = 5 * 60 * 1000;     // a receipt's time and its request's may differ by this much…
  const AHEAD = 2 * 60 * 1000;    // …an entry may be dated after the receipt covering it by this much…
  const JUMP = 2 * 60 * 1000;     // …and the clock may jump this far before it's flagged
  const WAKE_NEAR = 5 * 60 * 1000; // a forward jump this soon after waking is the sleep's

  // what a token check says when it only couldn't be checked (an authority
  // this checker doesn't know), as against one that fails
  const UNCHECKABLE = [/^the signer's certificate isn't in hand$/, /^the chain doesn't reach a trusted root$/, /^no certificate in hand issued /];

  // Each receipt line checked: that it's for the entry it names, and that
  // the token or proof is sound. `chains`: Map dev → { byN: Map n → { entry,
  // hash } }. `anchors`: trusted roots (DER); `certs`: more certificates.
  // `bitcoin(att)`: optional, async, checks a Bitcoin attestation against
  // the block (OTS.checkBlock with a fetch); without it a Bitcoin proof is
  // reported with its block and merkle root, unconfirmed here.
  async function checkReceipts(receipts, chains, { anchors = [], certs = [], bitcoin = null } = {}) {
    const out = [];
    const blocks = new Map();
    for (const { file, line } of receipts) {
      const r = { file, svc: line.svc, dev: line.dev, n: line.n, h: line.h, ts: line.ts, status: 'failed', time: null, problems: [] };
      out.push(r);
      const c = chains.get(line.dev);
      const at = c && c.byN.get(line.n);
      if (!c) r.problems.push('for a device whose log isn\'t here');
      else if (!at) r.problems.push('for an entry its chain doesn\'t have');
      else if (at.hash !== line.h) r.problems.push('for a hash that isn\'t its entry\'s');
      try {
        if (typeof line.tsr === 'string') {
          const token = TSA.base64Decode(line.tsr);
          r.hash = H.toHex(H.sha256(token));
          r.kind = 'rfc3161';
          r.time = TSA.parseToken(token).tst.time;
          if (!(globalThis.crypto && globalThis.crypto.subtle)) {
            // (a page opened somewhere WebCrypto isn't offered: not a secure context)
            r.status = 'unchecked';
            r.problems.push('signatures can\'t be checked here (no WebCrypto)');
            continue;
          }
          const v = await TSA.verify(token, { hash: line.h, anchors, certs });
          r.time = v.time;
          r.signer = v.signer;
          r.chain = v.chain;
          if (v.ok) r.status = 'ok';
          else if (v.problems.every((p) => UNCHECKABLE.some((re) => re.test(p)))) { r.status = 'unchecked'; r.problems.push(...v.problems); }
          else r.problems.push(...v.problems);
        } else if (typeof line.ots === 'string') {
          const bytes = TSA.base64Decode(line.ots);
          r.hash = H.toHex(H.sha256(bytes));
          r.kind = 'ots';
          const proof = OTS.parse(bytes);
          const ck = OTS.check(proof, line.h);
          r.pending = ck.pending;
          r.bitcoin = ck.bitcoin;
          if (!ck.ok) r.problems.push(...(ck.problems.length ? ck.problems : ['the proof has no attestation']));
          else if (ck.bitcoin.length) {
            r.status = 'bitcoin';
            if (bitcoin) {
              for (const att of ck.bitcoin) {
                const k = att.height + ':' + att.msg;
                if (!blocks.has(k)) blocks.set(k, Promise.resolve(bitcoin(att)).catch((err) => ({ ok: false, error: String(err && err.message || err) })));
                const b = await blocks.get(k);
                att.checked = b;
                if (b.ok && (r.time === null || b.time < r.time)) r.time = b.time;
              }
              if (r.time !== null) r.status = 'ok';
              else r.problems.push('the block couldn\'t be checked: ' + (ck.bitcoin[0].checked && ck.bitcoin[0].checked.error));
            }
          } else r.status = 'pending';
        } else {
          r.problems.push('a receipt of a kind this checker doesn\'t know');
          r.status = 'unchecked';
        }
      } catch (err) {
        r.problems.push('unreadable: ' + err.message);
      }
      if (r.status !== 'failed' && r.problems.length && r.status !== 'unchecked') r.status = 'failed';
    }
    return out;
  }

  // The stamp entries in the chains, matched with their receipts: a stamp
  // entry whose receipt is missing is a hole; one that disagrees with it
  // is a problem.
  function matchStampEntries(chainList, results) {
    const byHash = new Map();
    for (const r of results) if (r.hash) byHash.set(r.hash, r);
    const missing = [];
    const problems = [];
    let matched = 0;
    for (const c of chainList) {
      for (const e of c.entries) {
        if (e.kind !== 'stamp') continue;
        const r = byHash.get(e.r);
        if (!r) { missing.push({ dev: c.dev, n: e.n, of: e.of, svc: e.svc }); continue; }
        matched++;
        r.entry = e.n;
        if (r.dev !== c.dev || r.n !== e.of) problems.push({ dev: c.dev, n: e.n, problem: 'stamp entry and its receipt name different entries' });
        else if (e.t !== undefined && r.time !== null && r.kind === 'rfc3161' && e.t !== r.time) problems.push({ dev: c.dev, n: e.n, problem: 'stamp entry\'s time isn\'t its receipt\'s' });
      }
    }
    return { matched, missing, problems };
  }

  // What the receipts that checked show for each chain: the stamped
  // entries in order, each with the earliest time a receipt gives it (a
  // receipt for entry n covers every entry up to n), the stretches between
  // stamps, and the entries after the last one, whose times are only the
  // computer's.
  function coverage(chainList, results) {
    const out = new Map();
    for (const c of chainList) {
      const points = new Map(); // n → { time, svcs }
      for (const r of results) {
        if (r.dev !== c.dev || r.status !== 'ok' || r.time === null || r.problems.length) continue;
        const p = points.get(r.n) || { n: r.n, time: Infinity, svcs: new Set() };
        p.time = Math.min(p.time, r.time);
        p.svcs.add(r.svc);
        points.set(r.n, p);
      }
      // a later receipt for a higher entry can't date an earlier one more
      // tightly than an earlier receipt does: earliest from the end back
      const stamps = [...points.values()].sort((a, b) => a.n - b.n);
      let best = Infinity;
      for (let i = stamps.length - 1; i >= 0; i--) {
        best = Math.min(best, stamps[i].time);
        stamps[i].covers = best;
      }
      // writing time between stamps: each session's own span inside the stretch
      const stretches = [];
      let from = 0;
      const writingIn = (lo, hi) => {
        let ms = 0;
        let edits = 0;
        let start = null;
        let prev = null;
        let firstTs = null;
        let lastTs = null;
        for (const e of c.entries) {
          if (!(e.n > lo && e.n <= hi)) continue;
          if (e.kind === 'open') { if (start !== null) ms += prev - start; start = e.ts; }
          if (start === null) start = e.ts;
          prev = e.ts;
          if (e.kind === 'edit' || e.kind === 'base') edits++;
          if (firstTs === null) firstTs = e.ts;
          lastTs = e.ts;
        }
        if (start !== null) ms += prev - start;
        return { ms: Math.max(0, ms), edits, firstTs, lastTs };
      };
      for (const s of stamps) {
        stretches.push({ from: from + 1, to: s.n, ...writingIn(from, s.n), stampedAt: s.time });
        from = s.n;
      }
      const lastN = c.entries.length ? c.entries[c.entries.length - 1].n : 0;
      // after the last stamp: the stamp entries recording it don't count
      const tailWork = c.entries.filter((e) => e.n > from && e.kind !== 'stamp' && e.kind !== 'open' && e.kind !== 'close');
      const tail = from < lastN && tailWork.length ? { from: from + 1, to: lastN, ...writingIn(from, lastN) } : null;
      const longest = stretches.reduce((a, s) => (!a || s.ms > a.ms ? s : a), null);
      out.set(c.dev, {
        stamps: stamps.map((s) => ({ n: s.n, time: s.time, covers: s.covers, svcs: [...s.svcs].sort() })),
        stretches, longest, tail
      });
    }
    return out;
  }

  // The clock check. In the chains: a backward jump over two minutes (a
  // `clock` entry, or one entry dated that far before the one before it),
  // and a forward jump over two minutes that isn't the computer waking.
  // Against the receipts: a receipt whose time and its request's differ by
  // more than five minutes, and one dated before the entry it covers.
  function clockCheck(chainList, results = []) {
    const flags = [];
    for (const c of chainList) {
      let prev = null;
      let lastWake = null;
      for (const e of c.entries) {
        if (e.kind === 'wake') lastWake = e.ts;
        if (e.kind === 'clock' && Number.isSafeInteger(e.jump)) {
          if (e.jump < -JUMP) flags.push({ dev: c.dev, n: e.n, kind: 'back', ms: -e.jump });
          else if (e.jump > JUMP && !(lastWake !== null && e.ts - lastWake >= 0 && e.ts - lastWake <= WAKE_NEAR)) flags.push({ dev: c.dev, n: e.n, kind: 'forward', ms: e.jump });
        }
        if (prev && Number.isSafeInteger(e.ts) && Number.isSafeInteger(prev.ts) && prev.ts - e.ts > JUMP) {
          flags.push({ dev: c.dev, n: e.n, kind: 'back', ms: prev.ts - e.ts, between: [prev.n, e.n] });
        }
        prev = e;
      }
    }
    for (const r of results) {
      if (r.time === null || r.kind !== 'rfc3161' || r.status !== 'ok') continue;
      if (Number.isSafeInteger(r.ts) && Math.abs(r.time - r.ts) > SKEW) {
        flags.push({ dev: r.dev, n: r.n, kind: 'receipt-skew', ms: r.ts - r.time, svc: r.svc });
      }
      if (r.entryTs !== undefined && r.entryTs - r.time > AHEAD) {
        flags.push({ dev: r.dev, n: r.n, kind: 'receipt-before-entry', ms: r.entryTs - r.time, svc: r.svc });
      }
    }
    return flags;
  }

  /* ------------------------------------------------------------------ */
  /*  A whole log                                                        */
  /* ------------------------------------------------------------------ */

  // Devices as a report names them: Device 1, 2… in order of first entry
  function deviceNames(devices) {
    const order = devices.slice().sort((a, b) => (a.first ?? Infinity) - (b.first ?? Infinity) || (a.dev < b.dev ? -1 : 1));
    const out = new Map();
    order.forEach((d, i) => out.set(d.dev, 'Device ' + (i + 1)));
    return out;
  }

  // Every chain of a log (from readLog) checked, replayed and traced, with
  // no network and nothing async: { ok, logId, problems, notes, devices,
  // newest, words, links }. Each device: { dev, name, ok, problems, notes,
  // chunks, entries, n, head, first, last, kinds, sources, docs, lengths,
  // traced, made, moves, copiedFrom, arrivals }.
  function checkChains(log) {
    const devices = [];
    for (const { dev, chunks } of log.chains) {
      const v = verifyChain(chunks, { key: log.key });
      const byName = new Map(chunks.map((c) => [c.name, c]));
      const entries = v.chunks.flatMap((n) => byName.get(n).entries);
      const r = replay(entries);
      const kinds = {};
      const sources = {};
      let moves = 0;
      const copiedFrom = new Set();
      for (const e of entries) {
        kinds[e.kind] = (kinds[e.kind] || 0) + 1;
        // changes made while the log was switched off are counted on their
        // own: they're expected, where any other unlogged entry is a gap
        const src = e.src === 'unlogged' && e.cause === 'off' ? 'while off' : e.src;
        if (src) sources[src] = (sources[src] || 0) + 1;
        if (!Array.isArray(e.from) || !e.from.length) continue;
        if (e.kind === 'base') { for (const p of e.from) if (p && p[3] && typeof p[3].log === 'string') copiedFrom.add(p[3].log); } else if (!e.from.every((p) => p && isDevSource(p[3]))) moves++;
      }
      devices.push({
        dev, ok: v.ok, problems: [...v.problems, ...r.problems], notes: v.notes, chunks: v.chunks, entries,
        n: v.n, head: v.head, first: entries.length ? entries[0].ts : null, last: entries.length ? entries[entries.length - 1].ts : null,
        kinds, sources, docs: r.docs, lengths: r.lengths, moves, copiedFrom: [...copiedFrom]
      });
    }
    const words = devices.some((d) => d.entries.some((e) => e.x));
    // text that arrived without a recorded `from`, matched by its words
    const links = words && devices.length > 1 ? matchArrivals(devices) : new Map();
    const traced = traceAll(devices, { links });
    const names = deviceNames(devices);
    for (const d of devices) {
      const t = traced.get(d.dev);
      d.name = names.get(d.dev);
      d.traced = t.docs;
      d.problems.push(...t.problems);
      d.made = composition(t.docs);
      d.ok = d.ok && !d.problems.length;
      // where arrived text came from: recorded, matched by its words, or unknown
      const arrivals = { recorded: 0, matched: 0, unlinked: 0, from: {} };
      const l = links.get(d.dev);
      for (const e of d.entries) {
        if (e.src !== 'arrived' || !(e.kind === 'base' || e.kind === 'edit') || !e.ops.some((op) => op[2])) continue;
        const pieces = Array.isArray(e.from) ? e.from.filter((p) => p && isDevSource(p[3])) : [];
        let src = null;
        if (pieces.length) { arrivals.recorded++; src = pieces[0][3].dev; } else if (l && l.has(e.n)) { arrivals.matched++; src = l.get(e.n).dev; } else arrivals.unlinked++;
        if (src) arrivals.from[names.get(src) || src] = (arrivals.from[names.get(src) || src] || 0) + 1;
      }
      d.arrivals = arrivals;
    }
    devices.sort((a, b) => (a.last ?? 0) - (b.last ?? 0));
    const newest = devices.length ? devices[devices.length - 1] : null;
    const problems = log.problems.slice();
    if (!newest) problems.push('no chunks');
    return {
      ok: !problems.length && devices.every((d) => d.ok), logId: log.logId, problems, notes: log.notes.slice(),
      devices, newest, words, links, archives: log.archives || []
    };
  }

  // The whole check: checkChains, then the receipts, their coverage and
  // the clock check. files: as readLog takes them. Options as for
  // checkReceipts (anchors, certs, bitcoin).
  async function checkLog(files, opts = {}) {
    let log = files && files.chains ? files : null;
    if (!log) {
      const paths = logPaths(files);
      log = Object.keys(paths).some(isArchiveName)
        ? readLog(paths, { expanded: opts.inflateSync ? expandArchivesSync(paths, opts.inflateSync) : await expandArchives(paths, opts.inflate) })
        : readLog(paths);
    }
    const res = checkChains(log);
    const chains = new Map();
    for (const d of res.devices) {
      const byN = new Map();
      for (const e of d.entries) {
        let h = null;
        try { h = entryHash(e); } catch { /* reported by the chain check */ }
        byN.set(e.n, { entry: e, hash: h });
      }
      chains.set(d.dev, { byN });
    }
    const results = await checkReceipts(log.receipts, chains, { anchors: opts.anchors || [], certs: [...log.certs, ...(opts.certs || [])], bitcoin: opts.bitcoin || null });
    for (const r of results) {
      const c = chains.get(r.dev);
      const at = c && c.byN.get(r.n);
      if (at) r.entryTs = at.entry.ts;
    }
    const stampEntries = matchStampEntries(res.devices, results);
    const cover = coverage(res.devices, results);
    const clock = clockCheck(res.devices, results);
    const counts = {};
    for (const r of results) {
      const k = r.svc + ' ' + r.status;
      counts[k] = (counts[k] || 0) + 1;
    }
    const receiptProblems = [
      ...results.filter((r) => r.status === 'failed').map((r) => ({ file: r.file, dev: r.dev, n: r.n, svc: r.svc, problem: r.problems.join('; ') })),
      ...stampEntries.missing.map((m) => ({ dev: m.dev, n: m.n, svc: m.svc, problem: `stamp entry for entry ${m.of} has no receipt` })),
      ...stampEntries.problems
    ];
    res.receipts = { results, counts, stampEntries, problems: receiptProblems };
    res.coverage = cover;
    res.clock = clock;
    res.ok = res.ok && !receiptProblems.length;
    return res;
  }

  Object.assign(exports, {
    CHUNK_FORMATS, KINDS, CHUNK_RE, RECEIPT_RE, ARCHIVE_RE, isChunkName, isArchiveName, isArchivable,
    canonical, useHash, sha256hex, clearPart, entryHash, saltFor, commitment, normalizeManuscript, manuscriptHash,
    markupRanges, applyOps, applyLengths, insertOffsets, viewOf, sameChar,
    parseLines, parseChunk, readLog, logPaths, readExportFiles, EXPORT_EXTRAS, mergeArchives, expandArchivesSync, expandArchives, orderChunks, verifyChain, Replayer, replay,
    runsTidy, runsSlice, runsCut, runsInsert, originOf, Tracer, trace, traceAll, matchArrivals, collectRelinks,
    detailOrigin, parseOrigin, originCat, looseOf, sameLoose, RELINKABLE, isJsonDocName,
    AUX_DOCS, JSON_DOCS, chapterDoc, docChapter, decodeEntities, chapterLines, manuscriptText, proseMask, composition, originsAt, editorOf,
    checkReceipts, matchStampEntries, coverage, clockCheck, deviceNames, checkChains, checkLog,
    SKEW, AHEAD, JUMP
  });
})(typeof module !== 'undefined' && module.exports ? module.exports : (globalThis.SlogVerify = {}));
