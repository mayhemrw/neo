'use strict';

// THE SCRIBE'S LOG ON DISK: a book's scribes-log/ folder as stored, with
// loose files and archives (archive-….zip, closed chunks and receipt files
// merged into one file) read as one. The Recorder, the stamper, slog-check
// and the exports all list the folder through here, so a chunk that's been
// archived, here or on another computer, is still where they look for it.
//
// Also the two things made from a whole folder: Merge Log into Archive
// (mergeIntoArchive) and the exports for verification (buildExport).
//
// Node only (the main process and scripts/). The checker's side of
// archives is in slog-verify.js; zip files are slog-zip.js.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const V = require('./slog-verify.js');
const Z = require('./slog-zip.js');

const LOG_DIR = 'scribes-log';
const LOG_INFO = 'log.json';
const STAMP_DIR = 'stamps';
const CERT_DIR = 'certs';
const CERT_RE = /^[0-9a-f]{64}\.der$/;

const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const inflateSync = (b) => zlib.inflateRawSync(b);
const deflateSync = (b) => zlib.deflateRawSync(b, { level: 9 });
function utcName(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}
const readdirQuiet = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

/* ------------------------------------------------------------------ */
/*  Archives, read in place                                            */
/* ------------------------------------------------------------------ */

// An archive's central directory, read from the end of the file (the data
// itself is read only when a file is wanted). Kept per path while the
// file's size and time are the same.
const archiveDirs = new Map();
function archiveEntries(file) {
  const st = fs.statSync(file);
  const sig = st.size + ':' + st.mtimeMs;
  const had = archiveDirs.get(file);
  if (had && had.sig === sig) return had.entries;
  const fd = fs.openSync(file, 'r');
  try {
    const tailLen = Math.min(st.size, 22 + 65535);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, st.size - tailLen);
    const end = Z.findEnd(new Uint8Array(tail.buffer, tail.byteOffset, tail.length), st.size - tailLen);
    const cd = Buffer.alloc(end.size);
    fs.readSync(fd, cd, 0, end.size, end.offset);
    const entries = Z.parseCentral(new Uint8Array(cd.buffer, cd.byteOffset, cd.length), end.count).filter((e) => !e.name.endsWith('/'));
    archiveDirs.set(file, { sig, entries });
    if (archiveDirs.size > 64) archiveDirs.delete(archiveDirs.keys().next().value);
    return entries;
  } finally { fs.closeSync(fd); }
}
// one file from an archive, checked against its size and CRC-32
function archiveRead(file, e) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(30);
    fs.readSync(fd, head, 0, 30, e.local);
    const start = Z.dataStart(new Uint8Array(head.buffer, head.byteOffset, 30), e);
    const data = Buffer.alloc(e.csize);
    fs.readSync(fd, data, 0, e.csize, start);
    return Buffer.from(Z.entryBytesSync({ ...e, data }, inflateSync));
  } finally { fs.closeSync(fd); }
}

/* ------------------------------------------------------------------ */
/*  The folder, listed                                                 */
/* ------------------------------------------------------------------ */

// Every file of a book's log: Map of path (as in the folder: "log.json",
// "<chunk>.slog", "stamps/<file>.stamps", "stamps/certs/<sha256>.der") →
// { size, archive (its name, or null when loose), read() → Buffer }.
// A file both loose and archived is listed once, the longer copy (the
// checker looks at both: slog-verify.js mergeArchives). Archives that
// can't be read are listed in `broken`.
function listLog(bookDir) {
  const logDir = path.join(bookDir, LOG_DIR);
  const files = new Map();
  const archives = [];
  const broken = [];
  const loose = (rel) => {
    const file = path.join(logDir, ...rel.split('/'));
    let size;
    try { size = fs.statSync(file).size; } catch { return; }
    files.set(rel, { size, archive: null, file, read: () => fs.readFileSync(file) });
  };
  for (const n of readdirQuiet(logDir)) {
    if (n === LOG_INFO || V.isChunkName(n)) loose(n);
    else if (V.isArchiveName(n)) archives.push(n);
  }
  for (const n of readdirQuiet(path.join(logDir, STAMP_DIR))) if (V.RECEIPT_RE.test(n)) loose(STAMP_DIR + '/' + n);
  for (const n of readdirQuiet(path.join(logDir, STAMP_DIR, CERT_DIR))) if (CERT_RE.test(n)) loose(`${STAMP_DIR}/${CERT_DIR}/${n}`);
  for (const a of archives.sort()) {
    const file = path.join(logDir, a);
    let entries;
    try { entries = archiveEntries(file); } catch (err) { broken.push({ name: a, problem: err.message }); continue; }
    for (const e of entries) {
      if (!V.isArchivable(e.name)) continue;
      const had = files.get(e.name);
      if (had && had.size >= e.usize) continue;
      files.set(e.name, { size: e.usize, archive: a, file, read: () => archiveRead(file, e) });
    }
  }
  return { files, archives: archives.sort(), broken };
}

// The chunk names of a log, loose and archived, for one device's id
// prefix (or every device's)
function chunkNames(listing, dev8 = null) {
  return [...listing.files.keys()].filter((p) => {
    const m = V.CHUNK_RE.exec(p);
    return m && (dev8 === null || m[2] === dev8);
  }).sort();
}
// Is this path taken in the log, loose or archived?
function logHas(bookDir, rel) {
  return fs.existsSync(path.join(bookDir, LOG_DIR, ...rel.split('/'))) || listLog(bookDir).files.has(rel);
}

// A log's files as the checker takes them ({ path: text or bytes }), with
// the archives handed over whole for it to unpack and compare, so it sees
// everything the folder holds
function loadLog(bookDir) {
  const logDir = path.join(bookDir, LOG_DIR);
  const out = {};
  const take = (rel, bytes) => {
    try {
      const b = fs.readFileSync(path.join(logDir, ...rel.split('/')));
      out[rel] = bytes ? new Uint8Array(b.buffer, b.byteOffset, b.length) : b.toString('utf8');
    } catch { /* gone meanwhile */ }
  };
  for (const n of readdirQuiet(logDir)) {
    if (n === LOG_INFO || V.isChunkName(n)) take(n, false);
    else if (V.isArchiveName(n)) take(n, true);
  }
  for (const n of readdirQuiet(path.join(logDir, STAMP_DIR))) if (V.RECEIPT_RE.test(n)) take(STAMP_DIR + '/' + n, false);
  for (const n of readdirQuiet(path.join(logDir, STAMP_DIR, CERT_DIR))) if (CERT_RE.test(n)) take(`${STAMP_DIR}/${CERT_DIR}/${n}`, true);
  return out;
}

/* ------------------------------------------------------------------ */
/*  Merge Log into Archive                                             */
/* ------------------------------------------------------------------ */

const DAY = 24 * 3600e3;

// What may go into an archive: every closed chunk (any device's: a closed
// chunk never changes), a chunk that never closed once it's a day old
// (NEO quit unexpectedly), and receipt files no one is still writing: this
// computer's that the stamper has closed, another's once a day old. Never
// the session being written, or the archives' own copies of anything.
function archivable(listing, { dev8, active = new Set(), openReceipts = new Set(), now = Date.now() }) {
  const take = [];
  const skipped = [];
  for (const [rel, f] of listing.files) {
    if (f.archive || !V.isArchivable(rel)) continue;
    let mtime = 0;
    try { mtime = fs.statSync(f.file).mtimeMs; } catch { continue; }
    if (V.isChunkName(rel)) {
      if (active.has(rel)) { skipped.push({ file: rel, why: 'being written' }); continue; }
      const parsed = V.parseLines(f.read().toString('utf8'));
      const last = parsed.entries[parsed.entries.length - 1];
      const closed = !parsed.partialTail && !parsed.problems.length && last && last.kind === 'close';
      const old = now - mtime > DAY && (!last || !Number.isFinite(last.ts) || now - last.ts > DAY);
      if (closed || old) take.push(rel); else skipped.push({ file: rel, why: 'not closed yet' });
    } else {
      const name = rel.slice(STAMP_DIR.length + 1);
      const mine = V.RECEIPT_RE.exec(name)[2] === dev8;
      if (mine ? openReceipts.has(name) : now - mtime <= DAY) skipped.push({ file: rel, why: 'still open' });
      else take.push(rel);
    }
  }
  return { take: take.sort(), skipped };
}

// Merges a book's closed chunks and receipt files into one new archive,
// byte for byte (deflated), with every older archive's files in it too.
// The new archive is read back and every file compared before anything is
// removed; a failure removes only the new archive. Returns { archive,
// files, removed, skipped } or throws with a sentence.
function mergeIntoArchive(bookDir, { dev, active = new Set(), openReceipts = new Set(), now = Date.now } = {}) {
  const logDir = path.join(bookDir, LOG_DIR);
  const listing = listLog(bookDir);
  if (listing.broken.length) throw new Error(`${listing.broken[0].name} can't be read (${listing.broken[0].problem}), so nothing was merged`);
  const at = now();
  const dev8 = dev.slice(0, 8);
  const { take, skipped } = archivable(listing, { dev8, active, openReceipts, now: at });
  // the older archives' files, all of them, and the loose ones joining them
  const want = new Map();
  for (const a of listing.archives) {
    const file = path.join(logDir, a);
    for (const e of archiveEntries(file)) {
      if (!V.isArchivable(e.name)) continue;
      const bytes = archiveRead(file, e);
      const had = want.get(e.name);
      if (had && !had.equals(bytes)) {
        // the longer, when one is the start of the other (as the checker reads them)
        if (bytes.length > had.length && bytes.subarray(0, had.length).equals(had)) want.set(e.name, bytes);
        else if (!(had.length > bytes.length && had.subarray(0, bytes.length).equals(bytes))) throw new Error(`${e.name} is in two archives with different contents, so nothing was merged`);
      } else if (!had) want.set(e.name, bytes);
    }
  }
  const fromFolder = [];
  for (const rel of take) {
    const bytes = listing.files.get(rel).read();
    const had = want.get(rel);
    if (had && !had.equals(bytes)) {
      if (had.length > bytes.length && had.subarray(0, bytes.length).equals(bytes)) { fromFolder.push(rel); continue; }
      if (!(bytes.length > had.length && bytes.subarray(0, had.length).equals(had))) throw new Error(`${rel} differs from its copy in an archive, so nothing was merged`);
    }
    want.set(rel, bytes);
    fromFolder.push(rel);
  }
  if (!fromFolder.length && listing.archives.length <= 1) return { archive: listing.archives[0] || null, files: want.size, removed: [], skipped };
  const names = [...want.keys()].sort();
  let name;
  for (let k = 1; ; k++) {
    name = `archive-${utcName(at)}-${dev8}${k > 1 ? '-' + k : ''}.zip`;
    if (!fs.existsSync(path.join(logDir, name))) break;
  }
  const file = path.join(logDir, name);
  const bytes = Z.zip(names.map((n) => ({ name: n, data: want.get(n) })), { deflateRawSync: deflateSync, time: at });
  const tmp = file + '.tmp';
  try {
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    // read back from the disk, every file against what went in
    archiveDirs.delete(file);
    const back = Z.unzipSync(new Uint8Array(fs.readFileSync(file)), inflateSync);
    if (back.problems.length) throw new Error(back.problems[0]);
    const got = Object.keys(back.files).sort();
    if (got.length !== names.length || got.some((n, i) => n !== names[i])) throw new Error('the archive doesn\'t hold the files it should');
    for (const n of names) if (!Buffer.from(back.files[n]).equals(want.get(n))) throw new Error(n + ' didn\'t read back the same');
  } catch (err) {
    for (const f of [tmp, file]) { try { fs.unlinkSync(f); } catch { /* not there */ } }
    throw new Error('the archive didn\'t check out (' + err.message + '), so nothing was removed');
  }
  // only now: the loose files it replaces, and the older archives
  const removed = [];
  for (const rel of [...fromFolder, ...listing.archives]) {
    try { fs.unlinkSync(path.join(logDir, ...rel.split('/'))); removed.push(rel); } catch { /* already gone (another computer's sync) */ }
  }
  return { archive: name, files: names.length, removed, skipped };
}

/* ------------------------------------------------------------------ */
/*  Exports for verification                                           */
/* ------------------------------------------------------------------ */

// A chunk without its words: every line with `x` taken off. The entry
// hashes cover only the clear part, so the chain still checks. A line
// that can't be read can't be cleared of words, so it's replaced by a line
// that says so (still unreadable to a checker: the damage stays visible),
// and a last line a crash cut short is left off.
function withoutWords(text) {
  const lines = String(text).split('\n');
  lines.pop();
  return lines.map((raw) => {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) return line;
    let e;
    try { e = JSON.parse(line); } catch { e = null; }
    if (!e || typeof e !== 'object' || Array.isArray(e)) return '! unreadable line, left out of this export';
    delete e.x;
    return JSON.stringify(e);
  }).map((l) => l + '\n').join('');
}

// The files of an export. kind: 'clear' (no text) or 'full'. info: the
// book's log.json; files: the folder's (loadLog, archives unpacked by the
// checker's own rules); meta: { title, author, app, exported, manuscript,
// added, chapters, stamped, readme, verifier }. Returns { entries: [{ name, data }],
// manifest, result } with the log checked as it goes out.
async function buildExport(bookDir, { kind, meta, anchors = [], certs = [] }) {
  const raw = loadLog(bookDir);
  const ex = V.expandArchivesSync(raw, inflateSync);
  const info = JSON.parse(String(raw[LOG_INFO] ? Buffer.from(raw[LOG_INFO]) : '{}'));
  const entries = [];
  const logInfo = kind === 'full' ? info : { v: info.v, logId: info.logId };
  entries.push({ name: LOG_INFO, data: JSON.stringify(logInfo, null, 2) + '\n' });
  for (const p of Object.keys(ex.files).sort()) {
    if (p === LOG_INFO) continue;
    const v = ex.files[p];
    if (V.isChunkName(p)) {
      const text = typeof v === 'string' ? v : Buffer.from(v).toString('utf8');
      entries.push({ name: 'chunks/' + p, data: kind === 'full' ? Buffer.from(typeof v === 'string' ? Buffer.from(v, 'utf8') : v) : withoutWords(text) });
    } else if (p.startsWith(STAMP_DIR + '/')) {
      entries.push({ name: p, data: typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v) });
    }
  }
  const files = entries.map((e) => {
    const b = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : e.data;
    return { path: e.name, size: b.length, sha256: sha256hex(b) };
  });
  // the log as it goes out, checked the way the verifier will check it
  const asSent = {};
  for (const e of entries) asSent[e.name] = typeof e.data === 'string' ? e.data : new Uint8Array(e.data);
  const result = await V.checkLog(asSent, { anchors, certs });
  const manifest = {
    kind: 'scribes-log-export',
    format: 1,
    text: kind === 'full' ? 'full' : 'none',
    exported: meta.exported,
    app: meta.app,
    title: meta.title,
    author: meta.author,
    logId: info.logId || null,
    devices: result.devices.length,
    manuscript: { hash: meta.manuscript || null, added: meta.added || [] },
    chapters: Array.isArray(meta.chapters) ? meta.chapters : [],
    stamped: meta.stamped || null,
    intact: result.ok,
    files
  };
  const out = [
    { name: 'README.txt', data: meta.readme },
    { name: 'verifier.html', data: meta.verifier },
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) + '\n' },
    ...entries
  ];
  return { entries: out, manifest, result };
}

// An export as the verifier reads it: { manifest, files (as readLog takes
// them), problems }, every file checked against the manifest
async function readExport(bytes, { inflate } = {}) {
  const z = inflate ? await Z.unzip(bytes, inflate) : Z.unzipSync(bytes, inflateSync);
  return V.readExportFiles(z.files, z.problems);
}

module.exports = {
  LOG_DIR, LOG_INFO, STAMP_DIR, CERT_DIR, utcName,
  listLog, chunkNames, logHas, loadLog, archiveEntries, archiveRead,
  archivable, mergeIntoArchive, withoutWords, buildExport, readExport, DAY
};
