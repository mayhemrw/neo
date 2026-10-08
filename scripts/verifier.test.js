'use strict';

// The standalone verifier's parts that run without a page: reading and
// matching a manuscript (verifier/manuscript.js), sorting and checking
// what's dropped and saying what checked (verifier/check.js), and building
// the page (verifier/build.js). The page itself runs in verifier.e2e.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { describe, test } = require('node:test');
const V = require('../slog-verify.js');
const Z = require('../slog-zip.js');
const M = require('../verifier/manuscript.js');
const C = require('../verifier/check.js');
const B = require('../verifier/build.js');
const F = require('./verifier-fixtures.js');
const fakes = require('./stamp-fakes.js');

const inflate = async (b) => zlib.inflateRawSync(b);
const TRUST = { anchors: [fakes.ROOT], inflate };
const enc = (s) => new TextEncoder().encode(s);
const zipOf = (entries) => Z.zip(Object.entries(entries).map(([name, data]) => ({ name, data })), { deflateRawSync: (b) => zlib.deflateRawSync(b) });
async function checked(log, opts = {}) {
  const s = await C.sortInput(log, { inflate });
  assert.equal(s.logs.length, 1, JSON.stringify(s));
  return C.checkInput(s.logs[0], { ...TRUST, ...opts });
}
const byKey = (items, key) => items.find((i) => i.key === key) || null;

describe('verifier: manuscripts', () => {
  test('a .txt in UTF-8, UTF-8 with a BOM, UTF-16 either way, any line ending', () => {
    const lines = ['First line', 'Second – “quoted”', '', 'Third'];
    const text = lines.join('\r\n');
    assert.deepEqual(M.textLines(enc(text)), lines);
    assert.deepEqual(M.textLines(new Uint8Array([0xef, 0xbb, 0xbf, ...enc(lines.join('\n'))])), lines);
    const le = Buffer.from('﻿' + lines.join('\r'), 'utf16le');
    assert.deepEqual(M.textLines(new Uint8Array(le)), lines);
    const be = Buffer.from(le).swap16();
    be[0] = 0xfe; be[1] = 0xff;
    assert.deepEqual(M.textLines(new Uint8Array(be)), lines);
  });

  test('a .docx: runs joined, breaks split lines, tabs kept; deleted text, field codes and fallback copies left out', () => {
    const xml = '<w:document><w:body>' +
      '<w:p><w:r><w:t>Hel</w:t></w:r><w:r><w:t xml:space="preserve">lo &amp; </w:t></w:r><w:r><w:t>w&#246;rld</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>one</w:t><w:br/><w:t>two</w:t><w:tab/><w:t>three</w:t></w:r></w:p>' +
      '<w:p><w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:t>kept</w:t></w:r></w:p>' +
      '<w:p><w:r><mc:AlternateContent><mc:Choice><w:txbxContent><w:p><w:r><w:t>inside a box</w:t></w:r></w:p></w:txbxContent></mc:Choice><mc:Fallback><w:p><w:r><w:t>inside a box</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent></w:r><w:r><w:t>after</w:t></w:r></w:p>' +
      '<w:p/></w:body></w:document>';
    assert.deepEqual(M.documentXmlLines(xml), ['Hello & wörld', 'one', 'two\tthree', 'kept', 'inside a box', 'after', '']);
  });

  test('a .docx file read from its zip, and a file that isn\'t a manuscript', async () => {
    const r = await M.readManuscript('Book.DOCX', F.bookDocx(), inflate);
    assert.equal(r.kind, 'docx');
    assert.ok(r.lines.includes('Gulls wheeled over the empty slips.'));
    await assert.rejects(M.readManuscript('notes.docx', zipOf({ 'x.txt': 'no' }), inflate), /not a Word document/);
    await assert.rejects(M.readManuscript('book.pdf', enc('%PDF'), inflate), /\.txt or \.docx/);
  });

  test('NEO\'s lines are dropped by their hashes, and only those', () => {
    const log = F.bookLog();
    const lines = M.textLines(enc(F.bookTxt()));
    const r = M.matchManuscript(lines, { hashes: [log.ms], added: F.addedHashes() });
    assert.equal(r.matched, true);
    assert.equal(r.as, 'without NEO\'s lines');
    assert.equal(r.dropped, 4);
    // without the list, the title page and headings are in the way
    assert.equal(M.matchManuscript(lines, { hashes: [log.ms] }).matched, false);
    // the manuscript on its own matches as it is
    const plain = Object.values(F.CHAPTERS).flat().join('\n\n');
    const p = M.matchManuscript(M.textLines(enc(plain)), { hashes: [log.ms], added: F.addedHashes() });
    assert.equal(p.matched, true);
    assert.equal(p.dropped, 0);
    // whitespace and line breaks don't count; a letter does
    assert.equal(M.matchManuscript(M.textLines(enc(plain.replace(/ /g, '  \n'))), { hashes: [log.ms] }).matched, true);
    assert.equal(M.matchManuscript(M.textLines(enc(plain.replace('twice', 'thrice'))), { hashes: [log.ms] }).matched, false);
    assert.equal(M.matchManuscript(lines, { hashes: ['nothex'], added: F.addedHashes() }).matched, false);
  });

  test('with the log\'s words, where a manuscript first differs; a titled part\'s heading noticed', () => {
    const log = F.bookLog();
    const expected = M.expectedLines(log.docs);
    assert.deepEqual(expected, Object.values(F.CHAPTERS).flat());
    const changed = M.textLines(enc(F.bookTxt({ change: ['counted the boats', 'counted the ships'] })));
    const r = M.matchManuscript(changed, { hashes: [log.ms], added: F.addedHashes(), expected });
    assert.equal(r.matched, false);
    assert.equal(r.diff.line, 3);
    assert.match(r.diff.theirs, /ships/);
    assert.match(r.diff.ours, /boats/);
    const longer = M.matchManuscript([...expected, 'An extra paragraph.'], { hashes: [log.ms], expected });
    assert.deepEqual(longer.diff, { line: 6, extra: 1, theirs: 'An extra paragraph.' });
    const shorter = M.matchManuscript(expected.slice(0, 4), { hashes: [log.ms], expected });
    assert.equal(shorter.diff.missing, 1);
    const part = M.matchManuscript(['PART I: THE SEA', ...expected], { hashes: [log.ms], added: [V.sha256hex('PART I')] });
    assert.equal(part.partTitles, 1);
  });
});

describe('verifier: what was dropped', () => {
  test('an export zip, a zip with its folder inside, an unzipped export, a book folder, loose files, an archive', async () => {
    const log = F.bookLog();
    const ex = await F.exportOf(log);
    let s = await C.sortInput([{ name: 'Book - Scribe\'s Log (no text).zip', bytes: ex }, { name: 'book.txt', bytes: enc('x') }], { inflate });
    assert.equal(s.logs[0].kind, 'export');
    assert.deepEqual(s.manuscripts.map((m) => m.name), ['book.txt']);
    // re-zipped with a folder around it
    const un = (await Z.unzip(ex, inflate)).files;
    const nested = zipOf(Object.fromEntries(Object.entries(un).map(([k, v]) => ['Book/' + k, v])));
    s = await C.sortInput([{ name: 'again.zip', bytes: nested }], { inflate });
    assert.equal(s.logs[0].kind, 'export');
    assert.ok(s.logs[0].files['manifest.json']);
    // unzipped by the computer, dropped as a folder: its README isn't a manuscript, its .DS_Store not a stray
    s = await C.sortInput([...Object.entries(un).map(([k, v]) => ({ name: 'Book/' + k, bytes: v })), { name: 'Book/.DS_Store', bytes: enc('x') }], { inflate });
    assert.equal(s.logs[0].kind, 'export');
    assert.deepEqual(s.manuscripts, []);
    assert.deepEqual(s.ignored, []);
    // a whole book folder: the log in it, the chapters left alone
    const folder = Object.entries(log.files).map(([k, v]) => ({ name: 'book-harbor/scribes-log/' + k, bytes: typeof v === 'string' ? enc(v) : v }));
    s = await C.sortInput([...folder, { name: 'book-harbor/chapters/ch-1.html', bytes: enc('<p>x</p>') }, { name: 'book-harbor/book.json', bytes: enc('{}') }], { inflate });
    assert.equal(s.logs.length, 1);
    assert.equal(s.logs[0].kind, 'folder');
    assert.equal(s.logs[0].label, 'book-harbor/scribes-log');
    assert.ok(Object.keys(s.logs[0].files).every((k) => k === 'log.json' || V.isChunkName(k) || k.startsWith('stamps/')));
    // the files dropped one by one: receipts and certificates put in their places
    s = await C.sortInput(Object.entries(log.files).map(([k, v]) => ({ name: path.basename(k), bytes: typeof v === 'string' ? enc(v) : v })), { inflate });
    assert.equal(s.logs.length, 1);
    assert.ok(Object.keys(s.logs[0].files).some((k) => /^stamps\/[^/]+\.stamps$/.test(k)));
    assert.ok(Object.keys(s.logs[0].files).some((k) => /^stamps\/certs\/[0-9a-f]{64}\.der$/.test(k)));
    const ck = await C.checkInput(s.logs[0], TRUST);
    assert.equal(ck.res.ok, true, JSON.stringify(ck.res.problems));
    // anything else is left aside, by name
    s = await C.sortInput([{ name: 'photo.jpg', bytes: enc('x') }, { name: 'other.zip', bytes: zipOf({ 'a.txt': 'x' }) }, { name: 'broken.zip', bytes: enc('nope') }], { inflate });
    assert.deepEqual(s.logs, []);
    assert.equal(s.ignored.length, 3);
  });

  test('an archive and its log.json, as Merge Log into Archive leaves them', async () => {
    const log = F.bookLog();
    const names = Object.keys(log.files).filter((k) => k !== 'log.json' && !k.startsWith('stamps/certs/'));
    const archive = zipOf(Object.fromEntries(names.map((k) => [k, log.files[k]])));
    const items = [{ name: 'archive-20261009T181500Z-cccccccc.zip', bytes: archive }, { name: 'log.json', bytes: enc(log.files['log.json']) }];
    const ck = await checked(items);
    assert.equal(ck.kind, 'archive');
    assert.equal(ck.res.ok, true, JSON.stringify(ck.res.problems));
    assert.equal(ck.stats.archives.length, 1);
    const items2 = C.summarize(ck);
    assert.match(byKey(items2, 'chains').lines.join(' '), /Read with 1 archive/);
  });
});

describe('verifier: checking and saying so', () => {
  test('an export that checks: every item, the verdict, the Bitcoin block waiting to be looked up', async () => {
    const log = F.bookLog({ bitcoin: 900123 });
    const ck = await checked([{ name: 'x.zip', bytes: await F.exportOf(log) }]);
    let items = C.summarize(ck);
    assert.deepEqual(items.map((i) => [i.key, i.status]), [['files', 'ok'], ['chains', 'ok'], ['stamps', 'ok'], ['bitcoin', 'warn'], ['clock', 'ok'], ['manuscript', 'info']]);
    assert.equal(C.verdict(items), 'warn');
    const blocks = C.bitcoinBlocks(ck);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].height, 900123);
    assert.equal(blocks[0].root, C.rootAsShown(log.block.msg));
    assert.match(byKey(items, 'bitcoin').lines.join(' '), new RegExp('Block 900123: merkle root ' + blocks[0].root));
    // looked up: the block holds the root
    const again = async (bitcoin) => C.summarize(await C.checkInput((await C.sortInput([{ name: 'x.zip', bytes: await F.exportOf(log) }], { inflate })).logs[0], { ...TRUST, bitcoin }));
    items = await again(async (att) => ({ ok: att.msg === log.block.msg, time: log.last.ts + 3 * 3600e3 }));
    assert.equal(byKey(items, 'bitcoin').status, 'ok');
    assert.match(byKey(items, 'bitcoin').lines.join(' '), /matches the block/);
    assert.equal(C.verdict(items), 'ok');
    // a block that doesn't hold it fails; an explorer out of reach only couldn't check
    assert.equal(byKey(await again(async () => ({ ok: false, error: 'the block\'s merkle root isn\'t the one attested' })), 'bitcoin').status, 'bad');
    assert.equal(byKey(await again(async () => ({ ok: false, error: 'Failed to fetch' })), 'bitcoin').status, 'warn');
  });

  test('a matched and an unmatched manuscript, from the export with the text', async () => {
    const log = F.bookLog();
    const ck = await checked([{ name: 'x.zip', bytes: await F.exportOf(log, { kind: 'full' }) }]);
    const good = await C.matchFile(ck, { name: 'Book.txt', bytes: enc(F.bookTxt()) }, { inflate });
    const docx = await C.matchFile(ck, { name: 'Book.docx', bytes: F.bookDocx() }, { inflate });
    const bad = await C.matchFile(ck, { name: 'Changed.txt', bytes: enc(F.bookTxt({ change: ['empty slips', 'empty berths'] })) }, { inflate });
    const broken = await C.matchFile(ck, { name: 'Broken.docx', bytes: enc('not a zip') }, { inflate });
    const items = C.summarize(ck, { matches: [good, docx, bad, broken] });
    assert.equal(byKey(items, 'ms-Book.txt').status, 'ok');
    assert.equal(byKey(items, 'ms-Book.docx').status, 'ok');
    assert.equal(byKey(items, 'ms-Changed.txt').status, 'bad');
    assert.match(byKey(items, 'ms-Changed.txt').lines.join(' '), /first differ at line 2: the file has ".*berths.*", the log ".*slips/);
    assert.equal(byKey(items, 'ms-Broken.docx').status, 'bad');
    assert.equal(byKey(items, 'manuscript'), null);
    assert.equal(C.verdict(items), 'bad');
  });

  test('tampering: a changed file, a changed entry with the manifest made to agree, a deleted receipt', async () => {
    const log = F.bookLog();
    const un = (await Z.unzip(await F.exportOf(log), inflate)).files;
    const chunk = Object.keys(un).find((k) => k.startsWith('chunks/'));
    // one byte of a chunk changed
    const changed = { ...un, [chunk]: enc(new TextDecoder().decode(un[chunk]).replace('"ts":', '"ts": ')) };
    let ck = await checked([{ name: 'x.zip', bytes: zipOf(changed) }]);
    let items = C.summarize(ck);
    assert.equal(byKey(items, 'files').status, 'bad');
    assert.match(byKey(items, 'files').lines.join(' '), /not the file the manifest lists/);
    // an entry changed and the manifest rewritten to match: the chain catches it
    const text = new TextDecoder().decode(un[chunk]).split('\n');
    const e = JSON.parse(text[2]);
    e.ts += 3600e3;
    text[2] = JSON.stringify(e);
    const forged = enc(text.join('\n'));
    const man = JSON.parse(new TextDecoder().decode(un['manifest.json']));
    const f = man.files.find((x) => x.path === chunk);
    f.size = forged.length;
    f.sha256 = V.sha256hex(forged);
    ck = await checked([{ name: 'x.zip', bytes: zipOf({ ...un, [chunk]: forged, 'manifest.json': JSON.stringify(man) }) }]);
    items = C.summarize(ck);
    assert.equal(byKey(items, 'files').status, 'ok');
    assert.equal(byKey(items, 'chains').status, 'bad');
    assert.equal(C.verdict(items), 'bad');
    // a receipt file taken out (and out of the manifest): the stamp entries say it existed
    const receipts = Object.keys(un).filter((k) => /^stamps\/[^/]+\.stamps$/.test(k));
    const without = Object.fromEntries(Object.entries(un).filter(([k]) => !receipts.includes(k)));
    const man2 = JSON.parse(new TextDecoder().decode(un['manifest.json']));
    man2.files = man2.files.filter((x) => !receipts.includes(x.path));
    without['manifest.json'] = JSON.stringify(man2);
    ck = await checked([{ name: 'x.zip', bytes: zipOf(without) }]);
    items = C.summarize(ck);
    assert.equal(byKey(items, 'files').status, 'ok');
    assert.equal(byKey(items, 'stamps').status, 'bad');
    assert.match(byKey(items, 'stamps').lines.join(' '), /1 whose receipt is missing/);
  });

  test('an authority the verifier doesn\'t carry: its receipts couldn\'t be checked, which isn\'t damage', async () => {
    const log = F.bookLog();
    const s = await C.sortInput([{ name: 'x.zip', bytes: await F.exportOf(log) }], { inflate });
    const ck = await C.checkInput(s.logs[0], { inflate }); // no anchors at all
    const items = C.summarize(ck);
    assert.equal(byKey(items, 'stamps').status, 'warn');
    assert.match(byKey(items, 'stamps').lines.join(' '), /authority this verifier doesn't trust/);
    assert.equal(byKey(items, 'chains').status, 'ok');
    assert.equal(C.verdict(items), 'warn');
  });

  test('a log from before NEO stamped (v1): it checks, and says it has no outside timestamps', async () => {
    const log = F.bookLog({ v: 1 });
    const ck = await checked(Object.entries(log.files).map(([k, v]) => ({ name: 'scribes-log/' + k, bytes: typeof v === 'string' ? enc(v) : v })));
    assert.equal(ck.kind, 'folder');
    const items = C.summarize(ck);
    assert.equal(byKey(items, 'chains').status, 'ok');
    assert.match(byKey(items, 'chains').lines.join(' '), /every word matches the seal/);
    assert.equal(byKey(items, 'stamps').status, 'warn');
    // a folder has no manifest: a NEO .txt can't drop its headings, and says why
    const mt = await C.matchFile(ck, { name: 'Book.txt', bytes: enc(F.bookTxt()) });
    const it = byKey(C.summarize(ck, { matches: [mt] }), 'ms-Book.txt');
    assert.equal(it.status, 'bad');
    assert.match(it.lines.join(' '), /check it against the export rather than a folder/);
    // …and the bare manuscript matches the folder
    const plain = await C.matchFile(ck, { name: 'Plain.txt', bytes: enc(Object.values(F.CHAPTERS).flat().join('\n')) });
    assert.equal(plain.matched, true);
  });
});

describe('verifier: the page', () => {
  const html = B.buildVerifier({ version: '9.9.9', built: 'test' });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

  test('one self-contained file: no outside scripts, styles, fonts or images; nothing but the explorers allowed out', () => {
    assert.doesNotMatch(html, /<script[^>]+src=|<link\b|@import|url\(\s*['"]?https?:/i);
    assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src https:\/\/mempool\.space https:\/\/blockstream\.info;/);
    assert.match(html, /From NEO 9\.9\.9/);
    assert.ok(!html.includes('{{') && !html.includes('<!--MODULES-->') && !html.includes('<!--CAN SHOW-->'));
    assert.match(html, /It can&#39;t show that a person pressed the keys|It can't show that a person pressed the keys/);
    assert.equal(scripts.length, B.MODULES.length + 1);
  });

  test('each script ends where it should, parses, and carries FreeTSA as its only authority', () => {
    // nothing inside a script that would end it or confuse the HTML parser
    for (const js of scripts) assert.doesNotMatch(js, /<\/script|<script|<!--/i);
    for (const js of scripts) new vm.Script(js); // eslint-disable-line no-new
    const cfg = JSON.parse(scripts[0].match(/VERIFIER_CONFIG = (\{[\s\S]*\});/)[1]);
    assert.equal(cfg.anchors.length, 1);
    assert.match(cfg.anchors[0], /BEGIN CERTIFICATE/);
    assert.equal(cfg.anchors[0], fs.readFileSync(path.join(__dirname, '..', 'certs', 'freetsa-root.pem'), 'utf8').trim());
    assert.equal(cfg.version, '9.9.9');
  });

  test('\\x3C stands in for "<" wherever it would break the page, and means the same', () => {
    const src = 'const a = "</script>"; const b = /<!--x-->/; const c = `<script>`;';
    const safe = B.scriptSafe(src);
    assert.doesNotMatch(safe, /<\/script|<script|<!--/i);
    const ctx = vm.createContext({});
    vm.runInContext(safe + ' this.out = [a, b.source, c];', ctx);
    assert.deepEqual([...ctx.out], ['</script>', '\\x3C!--x-->', '<script>']);
    assert.ok(new RegExp(ctx.out[1]).test('<!--x-->'));
  });

  test('the checker\'s scripts run in a bare context, as the page runs them, and check a log', async () => {
    const ctx = vm.createContext({ crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array, DataView, Promise, console, Intl, DecompressionStream, Blob, Response });
    for (const js of scripts.slice(0, -1)) vm.runInContext(js, ctx); // all but page.js, which wants a document
    const log = F.bookLog();
    ctx.items = [{ name: 'x.zip', bytes: await F.exportOf(log) }];
    ctx.anchors = [fakes.ROOT];
    const out = await vm.runInContext(`(async () => {
      const s = await SlogVerifier.sortInput(items);
      const ck = await SlogVerifier.checkInput(s.logs[0], { anchors });
      return { verdict: SlogVerifier.verdict(SlogVerifier.summarize(ck)), ok: ck.res.ok, report: SlogReport.renderReport(ck.stats, { privacy: 'weeks' }).length };
    })()`, ctx);
    assert.equal(out.ok, true);
    assert.equal(out.verdict, 'ok');
    assert.ok(out.report > 5000);
  });
});
