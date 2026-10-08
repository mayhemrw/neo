// Logs for the verifier's tests (verifier.test.js, verifier.e2e.js): a
// small book written into a scribes-log folder the way NEO writes one,
// entry by entry with slog.js's Chain, stamped by the local test authority
// (stamp-fakes.js) and, if asked, an OpenTimestamps proof already in a
// (made-up) Bitcoin block; then exported as NEO exports it (slog-files.js).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const slog = require('../slog.js');
const V = require('../slog-verify.js');
const H = require('../slog-hash.js');
const tsa = require('../stamp-tsa.js');
const ots = require('../stamp-ots.js');
const files = require('../slog-files.js');
const Z = require('../slog-zip.js');
const fakes = require('./stamp-fakes.js');

const KEY = Buffer.alloc(32, 7);
const DEV = 'c'.repeat(32);
const LOG_ID = 'abcdefabcdef0123';
const T0 = Date.UTC(2026, 9, 8, 16, 0, 0); // (the test authority's certificates start Oct 7, 22:08 UTC)
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const TITLE = 'The Harbor Book';
const AUTHOR = 'Ann Writer';
const CHAPTERS = {
  'ch-1': ['The harbor was quiet before the storm.', 'Gulls wheeled over the empty slips.'],
  'ch-2': ['Mara counted the boats twice.', '***', 'One was missing.']
};
const TITLES = { 'ch-1': 'The Quiet', 'ch-2': 'The Count' };
const html = (paras) => paras.map((p) => (p === '***' ? '<p class="scene-break">***</p>' : `<p>${p}</p>`)).join('');
// the lines NEO's .txt export adds: the title page and headings
const ADDED = [TITLE.toUpperCase(), `by ${AUTHOR}`, 'CHAPTER 1 — THE QUIET', 'CHAPTER 2 — THE COUNT', TITLE, AUTHOR, 'Chapter 1 — The Quiet', 'Chapter 2 — The Count'];
const addedHashes = () => [...new Set(ADDED.map((l) => V.sha256hex(V.normalizeManuscript(l))))].sort();

// The book's .txt as NEO's export lays it out
function bookTxt({ change = null } = {}) {
  let out = `${TITLE.toUpperCase()}\nby ${AUTHOR}\n\n\n`;
  Object.entries(CHAPTERS).forEach(([id, paras], i) => {
    out += `CHAPTER ${i + 1} — ${TITLES[id].toUpperCase()}\n\n`;
    for (const p of paras) out += p === '***' ? '\n***\n\n' : p + '\n\n';
    out += '\n';
  });
  return change ? out.replace(change[0], change[1]) : out;
}
// …and its .docx: the paragraphs as Word has them, a line break inside
// the title page's, a tab, and a deleted word under tracked changes
function bookDocx() {
  const p = (inner) => `<w:p><w:pPr><w:pStyle w:val="BodyText"/></w:pPr>${inner}</w:p>`;
  const r = (text) => `<w:r><w:t xml:space="preserve">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r>`;
  let body = p(r(TITLE)) + p(r(AUTHOR) + '<w:r><w:br/></w:r>');
  Object.entries(CHAPTERS).forEach(([id, paras], i) => {
    body += p(r(`Chapter ${i + 1} — ${TITLES[id]}`)) + '<w:p/>';
    for (const para of paras) {
      // a word split across runs, and a deletion that isn't text any more
      if (para.startsWith('Gulls')) body += p(r('Gulls wheeled ') + '<w:del><w:r><w:delText>slowly </w:delText></w:r></w:del>' + r('over the empty slips.'));
      else body += p(r(para));
    }
  });
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`;
  return Z.zip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: 'word/document.xml', data: xml }
  ], { deflateRawSync: (b) => zlib.deflateRawSync(b) });
}

// A token from the test authority for `hex`, dated `at`
function tokenFor(hex, at) {
  const req = tsa.request(new Uint8Array(Buffer.from(hex, 'hex')));
  return tsa.parseResponse(new Uint8Array(fakes.tokenFor(req.der, at))).token;
}
// An OpenTimestamps proof of `hex` in block `height`; returns { proof
// (base64), msg (the merkle root the block must hold, hex) }
function otsProof(hex, height) {
  const digest = new Uint8Array(Buffer.from(hex, 'hex'));
  const file = { hashOp: 'sha256', digest, timestamp: ots.node(digest) };
  const c1 = { op: { tag: 0xf0, arg: new Uint8Array(16).fill(3) }, stamp: ots.node(H.concat(digest, new Uint8Array(16).fill(3))) };
  file.timestamp.ops.push(c1);
  const c2 = { op: { tag: 0x08 }, stamp: ots.node(H.sha256(c1.stamp.msg)) };
  c1.stamp.ops.push(c2);
  c2.stamp.attestations.push({ type: 'bitcoin', height });
  return { proof: Buffer.from(ots.serialize(file)).toString('base64'), msg: H.toHex(c2.stamp.msg) };
}
// A block header holding `msg` as its merkle root, dated `time` (ms): {
// id, header } as an explorer serves them
function blockFor(msg, time) {
  const hdr = Buffer.alloc(80);
  hdr.writeUInt32LE(0x20000000, 0);
  Buffer.from(msg, 'hex').copy(hdr, 36);
  hdr.writeUInt32LE(Math.floor(time / 1000), 68);
  const id = Buffer.from(crypto.createHash('sha256').update(crypto.createHash('sha256').update(hdr).digest()).digest()).reverse().toString('hex');
  return { id, header: hdr.toString('hex') };
}

// The book's scribes-log folder ({ path: text or bytes }), and what it
// ends on. opts: { v (1: written before NEO stamped, no stamps), stamps
// (FreeTSA receipts for each close), bitcoin (a block height for the
// last close's OpenTimestamps proof) }
function bookLog({ v = 2, stamps = true, bitcoin = null } = {}) {
  let clock = T0;
  const chain = new slog.Chain({ dev: DEV, key: KEY, now: () => (clock += 20000) });
  const chunks = [];
  let cur = null;
  const add = (kind, fields = {}, ins = null) => { const { entry, line } = chain.entry(kind, fields, ins); cur.lines.push(line); return entry; };
  const docs = {};
  const open = () => {
    cur = { name: slog.chunkName(clock, DEV, chunks.length + 1), lines: [] };
    add('open', { v, log: LOG_ID, dev: DEV, prevChunk: chunks.length ? chunks[chunks.length - 1].name : null, app: '1.4.5' });
    chunks.push(cur);
  };
  const base = (doc, src, text) => { docs[doc] = text; return add('base', { doc, src, ops: slog.recordOps([[0, 0, text.length]], [text]) }, [text]); };
  const type = (doc, at, text) => { docs[doc] = docs[doc].slice(0, at) + text + docs[doc].slice(at); return add('edit', { doc, src: 'typed', ops: slog.recordOps([[at, 0, text.length]], [text]) }, [text]); };
  const close = () => add('close', { why: 'close', ms: V.manuscriptHash(V.manuscriptText(docs)) });
  const receipts = [];
  const stampClose = (e) => {
    if (!stamps || v < 2) return null;
    const h = slog.entryHash(e);
    const token = tokenFor(h, e.ts + 1500);
    receipts.push({ svc: 'freetsa', dev: DEV, n: e.n, h, ts: e.ts, tsr: Buffer.from(token).toString('base64') });
    // the stamp entry NEO writes into the next chunk
    return { svc: 'freetsa', of: e.n, t: tsa.parseToken(token).tst.time, r: sha(token) };
  };

  // session 1: the book, its first chapter typed
  open();
  base('book', 'baseline', JSON.stringify({ title: TITLE, author: AUTHOR, chapterOrder: ['ch-1', 'ch-2'], chapterTitles: TITLES }));
  base('ch-1', 'import', html([CHAPTERS['ch-1'][0]]));
  type('ch-1', docs['ch-1'].length, `<p>${CHAPTERS['ch-1'][1]}</p>`);
  const c1 = close();
  const st1 = stampClose(c1);
  // session 2: the second chapter
  clock += 3600e3;
  open();
  if (st1) add('stamp', st1);
  base('ch-2', 'import', html(CHAPTERS['ch-2'].slice(0, 2)));
  type('ch-2', docs['ch-2'].length, `<p>${CHAPTERS['ch-2'][2]}</p>`);
  const c2 = close();
  stampClose(c2);
  let block = null;
  if (bitcoin && stamps && v >= 2) {
    const h = slog.entryHash(c2);
    const p = otsProof(h, bitcoin);
    receipts.push({ svc: 'ots', dev: DEV, n: c2.n, h, ts: c2.ts, ots: p.proof });
    block = { height: bitcoin, msg: p.msg, ...blockFor(p.msg, c2.ts + 3 * 3600e3) };
  }
  const out = { 'log.json': JSON.stringify({ v: 1, logId: LOG_ID, key: KEY.toString('base64') }) };
  for (const k of chunks) out[k.name] = k.lines.join('\n') + '\n';
  if (receipts.length) {
    out['stamps/' + slog.chunkName(c2.ts, DEV, 1).replace(/\.slog$/, '.stamps')] = receipts.map((l) => JSON.stringify(l)).join('\n') + '\n';
    out['stamps/certs/' + sha(fakes.SIGNER) + '.der'] = new Uint8Array(fakes.SIGNER);
  }
  return { files: out, ms: V.manuscriptHash(V.manuscriptText(docs)), last: c2, block, docs };
}

// The folder on disk, under a book folder: { dir (the book's), log (its scribes-log) }
function writeBook(log, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-verifier-book-'))) {
  const logDir = path.join(dir, 'scribes-log');
  for (const [p, v] of Object.entries(log.files)) {
    fs.mkdirSync(path.dirname(path.join(logDir, p)), { recursive: true });
    fs.writeFileSync(path.join(logDir, p), typeof v === 'string' ? v : Buffer.from(v));
  }
  return { dir, log: logDir };
}

// An export of it, as NEO makes one: the zip's bytes. kind: 'clear' or 'full'
async function exportOf(log, { kind = 'clear', verifier = '<!doctype html><title>verifier</title>' } = {}) {
  const { dir } = writeBook(log);
  const meta = {
    exported: log.last.ts + 60e3, app: '1.4.5', title: TITLE, author: AUTHOR, manuscript: log.ms, added: addedHashes(),
    chapters: ['ch-1', 'ch-2'], stamped: { dev: DEV, n: log.last.n, tsa: true, ots: !!log.block }, readme: 'README', verifier
  };
  const built = await files.buildExport(dir, { kind, meta, anchors: [fakes.ROOT], certs: [fakes.SIGNER] });
  fs.rmSync(dir, { recursive: true, force: true });
  return Z.zip(built.entries, { deflateRawSync: (b) => zlib.deflateRawSync(b), time: meta.exported });
}

module.exports = { KEY, DEV, LOG_ID, T0, TITLE, AUTHOR, CHAPTERS, ADDED, addedHashes, bookTxt, bookDocx, tokenFor, otsProof, blockFor, bookLog, writeBook, exportOf };
