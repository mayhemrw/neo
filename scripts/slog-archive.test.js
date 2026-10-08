'use strict';

// Archives and exports: zip files (slog-zip.js), the checker reading
// archives with loose chunks (slog-verify.js), Merge Log into Archive and
// the exports for verification (slog-files.js), and the Recorder and
// stamper carrying on over a folder whose chunks were archived. Books are
// written by a real Recorder; the timestamp services are the local fakes.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const vm = require('node:vm');
const { describe, test } = require('node:test');
const slog = require('../slog.js');
const V = require('../slog-verify.js');
const Z = require('../slog-zip.js');
const F = require('../slog-files.js');
const { Stamper, readReceipts } = require('../slog-stamp.js');
const { checkBook, checkBookFull, checkZip } = require('./slog-check.js');
const { tokenFor, calendarAnswer, ROOT, SIGNER } = require('./stamp-fakes.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-archive-'));
let made = 0;
const inflate = (b) => zlib.inflateRawSync(b);
const deflate = (b) => zlib.deflateRawSync(b);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/* ---- a book, written by a real Recorder ---- */

function answer(status, body) {
  const b = Buffer.from(body);
  return { status, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length), text: async () => b.toString() };
}
function setup() {
  const root = path.join(tmpRoot, String(++made));
  const dir = path.join(root, 'book-a');
  fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify({ id: 'book-a', title: 'A Book', author: 'Ada', chapterOrder: ['ch-1'] }));
  fs.writeFileSync(path.join(dir, 'chapters', 'ch-1.html'), '<p>Hello.</p>');
  const env = { root, dir, clock: Date.UTC(2026, 9, 8, 16, 0, 0), errors: [], text: '<p>Hello.</p>', down: false, calls: [] };
  env.home = (who = 'a') => path.join(root, 'userData-' + who, 'slog');
  env.fetch = async (url, init = {}) => {
    env.calls.push(url);
    if (env.down) throw new Error('fetch failed');
    if (url === 'https://tsa.test/tsr') return answer(200, tokenFor(init.body, env.clock));
    const m = /^https:\/\/(\w)\.pool\.test\/digest$/.exec(url);
    if (m) return answer(200, calendarAnswer(m[1], init.body));
    return answer(404, '');
  };
  env.recorder = (who = 'a') => new slog.Recorder({ home: env.home(who), app: 'test', now: () => env.clock, idleMs: 24 * HOUR, onError: (w, e) => env.errors.push(w + ': ' + e.message) });
  env.stamper = (rec, who = 'a') => new Stamper({
    recorder: rec, fetch: env.fetch, home: env.home(who), now: () => env.clock,
    anchors: [ROOT], certs: [SIGNER], services: [{ svc: 'freetsa', url: 'https://tsa.test/tsr' }],
    calendars: ['https://a.pool.test', 'https://b.pool.test'],
    onError: (w, e) => env.errors.push(w + ': ' + e.message)
  });
  env.type = (rec, words, src = 'typed') => {
    const disk = fs.readFileSync(path.join(dir, 'chapters', 'ch-1.html'), 'utf8');
    env.text = disk.replace(/<\/p>$/, ' ' + words + '</p>');
    rec.observe(dir, 'book-a', 'ch-1', env.text, { src, ev: words.length });
    rec.touch(dir, 'book-a');
    fs.writeFileSync(path.join(dir, 'chapters', 'ch-1.html'), env.text);
    rec.wrote(dir, 'book-a', 'ch-1', env.text);
  };
  env.later = (ms) => { env.clock += ms; };
  // a session: open, a few words, closed
  env.session = async (rec, words) => {
    rec.open(dir, 'book-a');
    for (const w of words) { env.type(rec, w); env.later(MIN); }
    await rec.close('book-a');
  };
  env.logDir = path.join(dir, slog.LOG_DIR);
  env.loose = () => fs.readdirSync(env.logDir).sort();
  return env;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
function assertChecks(dir) {
  const res = checkBook(dir);
  assert.deepEqual(res.problems, []);
  for (const d of res.devices) assert.deepEqual(d.problems, []);
  assert.deepEqual(res.devices[res.devices.length - 1].differ, []);
  assert.equal(res.ok, true);
  return res;
}
// mtimes a day and more back, as if the files had sat a while
function age(file, ms) {
  const t = (Date.now() - ms) / 1000;
  fs.utimesSync(file, t, t);
}

describe('slog-zip', () => {
  test('writes zips the standard way and reads them back, deflated or stored', async () => {
    const files = [
      { name: '20261008T160000Z-aaaaaaaa.slog', data: '{"kind":"open"}\n'.repeat(50) },
      { name: 'stamps/x.stamps', data: new Uint8Array([1, 2, 3]) },
      { name: 'é ü.txt', data: 'ü' }
    ];
    const z = Z.zip(files, { deflateRawSync: deflate });
    const back = Z.unzipSync(z, inflate);
    assert.deepEqual(back.problems, []);
    assert.deepEqual(Object.keys(back.files), files.map((f) => f.name));
    assert.equal(Buffer.from(back.files[files[0].name]).toString(), files[0].data);
    // the browser's way (DecompressionStream), as the verifier will
    const asy = await Z.unzip(z);
    assert.deepEqual(Object.keys(asy.files), Object.keys(back.files));
    assert.deepEqual([...asy.files['stamps/x.stamps']], [1, 2, 3]);
    // the first is deflated, the tiny ones stored
    const { entries } = Z.parseZip(z);
    assert.deepEqual(entries.map((e) => e.method), [8, 0, 0]);
    // and zip from another tool: Node's own deflate without our writer
    // isn't a zip, but Python's zipfile is the reference used by hand (see
    // the M4 notes); here a stored zip with a comment after the directory
    const withComment = Buffer.concat([Buffer.from(z.subarray(0, z.length - 2)), Buffer.from([5, 0]), Buffer.from('hello')]);
    assert.deepEqual(Object.keys(Z.unzipSync(withComment, inflate).files), Object.keys(back.files));
  });

  test('a changed byte, a name that climbs out, or a name twice is caught', () => {
    const z = Z.zip([{ name: 'aa/x.slog', data: 'some text that will be deflated, some text that will be deflated, again and again' }], { deflateRawSync: deflate });
    // a byte of the data changed: the CRC-32 or the inflater says so
    const bad = Buffer.from(z);
    const { entries } = Z.parseZip(z);
    const at = entries[0].data.byteOffset + 3;
    bad[at] ^= 0x40;
    const r = (() => { try { return Z.unzipSync(new Uint8Array(bad), inflate); } catch (err) { return { problems: [err.message] }; } })();
    assert.equal(r.problems.length, 1);
    // ../ in a name, in the central directory
    const climb = Buffer.from(z).toString('latin1').split('aa/x.slog').join('../x.slog');
    assert.throws(() => Z.unzipSync(new Uint8Array(Buffer.from(climb, 'latin1')), inflate), /unsafe name/);
    assert.throws(() => Z.zip([{ name: '/etc/x', data: '' }]), /not a name/);
    assert.throws(() => Z.zip([{ name: 'a', data: '' }, { name: 'a', data: '' }]), /twice/);
    assert.throws(() => Z.unzipSync(new Uint8Array([1, 2, 3]), inflate), /not a zip/);
    assert.equal(Z.crc32(Buffer.from('123456789')), 0xcbf43926);
  });
});

describe('the checker reads archives with the loose files', () => {
  async function written() {
    const env = setup();
    const rec = env.recorder();
    await env.session(rec, ['One.', 'Two.']);
    env.later(HOUR);
    await env.session(rec, ['Three.']);
    return env;
  }

  test('an archive of a log checks the same as the loose files, read either way', async () => {
    const env = await written();
    const loose = F.loadLog(env.dir);
    const want = V.checkChains(V.readLog(loose));
    const chunks = Object.keys(loose).filter(V.isChunkName);
    const arch = Z.zip(chunks.map((n) => ({ name: n, data: loose[n] })), { deflateRawSync: deflate });
    const files = { 'log.json': loose['log.json'], 'archive-20261008T200000Z-aaaaaaaa.zip': arch };
    const sync = V.checkChains(V.readLog(files, { inflateSync: inflate }));
    assert.equal(sync.ok, true, JSON.stringify(sync.problems));
    assert.deepEqual(sync.devices.map((d) => [d.n, d.head, d.made]), want.devices.map((d) => [d.n, d.head, d.made]));
    assert.deepEqual(sync.archives, [{ name: 'archive-20261008T200000Z-aaaaaaaa.zip', files: chunks.length }]);
    const asy = await V.checkLog(files);
    assert.equal(asy.ok, true);
    assert.deepEqual(asy.devices.map((d) => d.head), want.devices.map((d) => d.head));
    // without a way to unpack it, readLog says so rather than reading nothing quietly
    const no = V.readLog(files);
    assert.ok(no.problems.some((p) => /wasn't unpacked/.test(p)));
  });

  test('the same file loose and archived: one copy, a shorter copy noted, a different copy damage', async () => {
    const env = await written();
    const loose = F.loadLog(env.dir);
    const [first, second] = Object.keys(loose).filter(V.isChunkName).sort();
    const arch = (data) => Z.zip([{ name: first, data }, { name: second, data: loose[second] }], { deflateRawSync: deflate });
    // the same bytes in both: fine
    let res = V.readLog({ ...loose, 'archive-20261008T200000Z-aaaaaaaa.zip': arch(loose[first]) }, { inflateSync: inflate });
    assert.deepEqual(res.problems, []);
    assert.equal(res.chains[0].chunks.length, 2);
    // the loose copy cut short (a sync still bringing it): the whole one is used, and noted
    const cut = loose[first].slice(0, loose[first].indexOf('\n') + 1);
    res = V.readLog({ ...loose, [first]: cut, 'archive-20261008T200000Z-aaaaaaaa.zip': arch(loose[first]) }, { inflateSync: inflate });
    assert.deepEqual(res.problems, []);
    assert.ok(res.notes.some((n) => n.file === first && /shorter copy in the folder/.test(n.note)));
    assert.equal(V.checkChains(res).ok, true);
    // a copy that differs: damage, named
    const changed = loose[first].replace('One.', 'Uno.');
    assert.notEqual(changed, loose[first]);
    res = V.readLog({ ...loose, 'archive-20261008T200000Z-aaaaaaaa.zip': arch(changed) }, { inflateSync: inflate });
    assert.ok(res.problems.some((p) => p.includes(first) && /two different copies/.test(p)), JSON.stringify(res.problems));
    // a file that isn't the log's, and an archive that won't open
    const odd = Z.zip([{ name: 'notes.txt', data: 'hi' }]);
    res = V.readLog({ ...loose, 'archive-20261008T200000Z-aaaaaaaa.zip': odd, 'archive-20261008T210000Z-aaaaaaaa.zip': new Uint8Array([1, 2]) }, { inflateSync: inflate });
    assert.ok(res.problems.some((p) => /notes\.txt, which isn't part of a log/.test(p)));
    assert.ok(res.problems.some((p) => /210000Z.*can't be read/.test(p)));
  });

  test('paths as an export has them, or under a dropped scribes-log folder', async () => {
    const env = await written();
    const loose = F.loadLog(env.dir);
    const asExport = {};
    const asFolder = {};
    for (const [p, v] of Object.entries(loose)) {
      asExport[V.isChunkName(p) ? 'chunks/' + p : p] = v;
      asFolder['scribes-log/' + p] = v;
    }
    const want = V.checkChains(V.readLog(loose)).devices[0].head;
    assert.equal(V.checkChains(V.readLog(asExport)).devices[0].head, want);
    assert.equal(V.checkChains(V.readLog(asFolder)).devices[0].head, want);
  });

  test('runs in a bare context with only what a browser has', async () => {
    const env = await written();
    const loose = F.loadLog(env.dir);
    const chunks = Object.keys(loose).filter(V.isChunkName);
    const files = { 'log.json': loose['log.json'], 'archive-20261008T200000Z-aaaaaaaa.zip': Z.zip(chunks.map((n) => ({ name: n, data: loose[n] })), { deflateRawSync: deflate }) };
    const ctx = vm.createContext({ crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array, DataView, Promise, console, Blob, Response, DecompressionStream });
    for (const f of ['slog-hash.js', 'slog-zip.js', 'stamp-tsa.js', 'stamp-ots.js', 'slog-verify.js']) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
    }
    ctx.files = files;
    const res = await vm.runInContext('SlogVerify.checkLog(files)', ctx);
    assert.equal(res.ok, true, JSON.stringify(res.problems));
    assert.equal(res.devices[0].head, V.checkChains(V.readLog(loose)).devices[0].head);
  });
});

describe('Merge Log into Archive', { concurrency: 1 }, () => {
  test('closed sessions and receipt files go into one archive; the open session stays; NEO carries on', async () => {
    const env = setup();
    const rec = env.recorder();
    const st = env.stamper(rec);
    await env.session(rec, ['One.', 'Two.']);
    await flush();
    await st.tick();
    env.later(2 * MIN); // the session's receipt file closes a minute after its stamp
    await st.tick();
    env.later(HOUR);
    await env.session(rec, ['Three.']);
    await flush();
    env.later(HOUR);
    rec.open(env.dir, 'book-a');
    env.type(rec, 'Four.'); // being written
    await flush();
    const before = assertChecks(env.dir);
    const head = before.devices[0].head;
    const looseChunks = env.loose().filter(V.isChunkName);
    assert.equal(looseChunks.length, 3);
    const active = rec.activeChunk('book-a');
    assert.ok(active && looseChunks.includes(active));
    const res = F.mergeIntoArchive(env.dir, { dev: rec.device(), active: new Set([active]), openReceipts: st.openReceipts(env.dir), now: () => env.clock });
    assert.match(res.archive, /^archive-\d{8}T\d{6}Z-[0-9a-f]{8}\.zip$/);
    // in the archive: the two closed chunks and the closed receipt file; left: the open chunk, the open receipt file
    assert.deepEqual(env.loose().filter(V.isChunkName), [active]);
    assert.ok(env.loose().includes(res.archive));
    const archived = F.archiveEntries(path.join(env.logDir, res.archive)).map((e) => e.name);
    assert.deepEqual(archived.filter(V.isChunkName), looseChunks.filter((n) => n !== active));
    assert.ok(archived.some((n) => n.startsWith('stamps/')));
    for (const n of st.openReceipts(env.dir)) assert.ok(fs.existsSync(path.join(env.logDir, 'stamps', n)), n + ' left as it was');
    assert.ok(res.skipped.some((s) => s.file === active && s.why === 'being written'));
    // byte for byte: what's in the archive is what was on disk
    const listing = F.listLog(env.dir);
    for (const n of archived) assert.equal(listing.files.get(n).archive, res.archive);
    // the check reads it as before
    const after = assertChecks(env.dir);
    assert.equal(after.devices[0].head, head);
    assert.deepEqual(after.devices[0].made, before.devices[0].made);
    // writing goes on in the same chunk, then a new session, then NEO starts afresh
    env.type(rec, 'Five.');
    await rec.close('book-a');
    env.later(HOUR);
    const fresh = env.recorder();
    await env.session(fresh, ['Six.']);
    const res2 = assertChecks(env.dir);
    assert.equal(res2.devices[0].chunks, 4);
    assert.deepEqual(env.errors, []);
    // a second merge takes the older archive's files with it, and removes it
    const again = F.mergeIntoArchive(env.dir, { dev: rec.device(), now: () => env.clock + 10e3 });
    assert.notEqual(again.archive, res.archive);
    assert.ok(!env.loose().includes(res.archive));
    assert.deepEqual(env.loose().filter((n) => V.isChunkName(n) || V.isArchiveName(n)), [again.archive]);
    const inside = F.archiveEntries(path.join(env.logDir, again.archive)).map((e) => e.name);
    for (const n of archived) assert.ok(inside.includes(n), n);
    assertChecks(env.dir);
    await st.stop();
    // the whole check, receipts included, reads them in the archive
    const full = await checkBookFull(env.dir);
    assert.ok(full.receipts.results.length >= 2);
    assert.ok(full.receipts.results.every((r) => r.status !== 'failed'), JSON.stringify(full.receipts.problems));
    assert.equal(full.receipts.stampEntries.missing.length, 0);
    // and the stamper's readReceipts
    assert.ok(readReceipts(env.dir).length >= 2);
  });

  test('another computer\'s chunks: closed ones taken, an unclosed one only once it\'s a day old', async () => {
    const env = setup();
    const a = env.recorder('a');
    await env.session(a, ['One.']);
    env.later(HOUR);
    // a second computer: its first session never closed (it crashed), another is closed
    const b = env.recorder('b');
    b.open(env.dir, 'book-a');
    env.type(b, 'From B.');
    await flush();
    const crashed = b.activeChunk('book-a');
    b.sessions.clear(); // gone without a close
    env.later(HOUR);
    const b2 = env.recorder('b');
    await env.session(b2, ['B again.']);
    let res = F.mergeIntoArchive(env.dir, { dev: a.device(), now: () => env.clock });
    assert.ok(res.skipped.some((s) => s.file === crashed && s.why === 'not closed yet'));
    assert.ok(env.loose().includes(crashed));
    assertChecks(env.dir);
    // a day later, the unclosed chunk goes too
    age(path.join(env.logDir, crashed), 25 * HOUR);
    res = F.mergeIntoArchive(env.dir, { dev: a.device(), now: () => env.clock + 25 * HOUR });
    assert.ok(!env.loose().includes(crashed));
    assert.deepEqual(env.loose().filter(V.isChunkName), []);
    const r = assertChecks(env.dir);
    assert.equal(r.devices.length, 2);
    // and the other computer carries on over its archived chunks, its cache intact
    env.later(26 * HOUR);
    const b3 = env.recorder('b');
    await env.session(b3, ['B once more.']);
    const after = assertChecks(env.dir);
    const devB = after.devices.find((d) => d.dev === b3.device());
    assert.equal(devB.chunks, 3);
    assert.deepEqual(env.errors, []);
  });

  test('a merge that doesn\'t check out leaves everything as it was', async () => {
    const env = setup();
    const rec = env.recorder();
    await env.session(rec, ['One.']);
    env.later(HOUR);
    await env.session(rec, ['Two.']);
    const before = env.loose();
    const real = Z.unzipSync;
    Z.unzipSync = (bytes, inf) => {
      const r = real(bytes, inf);
      const first = Object.keys(r.files)[0];
      r.files[first] = new Uint8Array([...r.files[first], 0x20]);
      return r;
    };
    try {
      assert.throws(() => F.mergeIntoArchive(env.dir, { dev: rec.device(), now: () => env.clock }), /didn't check out.*nothing was removed/);
    } finally { Z.unzipSync = real; }
    assert.deepEqual(env.loose(), before);
    assertChecks(env.dir);
    // nothing new to merge: nothing written
    F.mergeIntoArchive(env.dir, { dev: rec.device(), now: () => env.clock });
    const once = env.loose();
    const res = F.mergeIntoArchive(env.dir, { dev: rec.device(), now: () => env.clock + 5000 });
    assert.deepEqual(res.removed, []);
    assert.deepEqual(env.loose(), once);
  });
});

describe('Exports for verification', { concurrency: 1 }, () => {
  async function book() {
    const env = setup();
    const rec = env.recorder();
    const st = env.stamper(rec);
    await env.session(rec, ['The tide went out.', 'Gulls.']);
    await flush();
    env.later(HOUR);
    rec.open(env.dir, 'book-a');
    env.type(rec, 'A paragraph pasted from somewhere else entirely.', 'paste');
    env.later(MIN);
    return { env, rec, st };
  }
  const meta = (head, stamped) => ({
    exported: Date.UTC(2026, 9, 8, 19, 0, 0), app: '1.4.3', title: 'A Book', author: 'Ada',
    manuscript: head.ms, added: [sha('A BOOK')], stamped, readme: 'readme', verifier: '<!doctype html>'
  });

  test('both kinds check as they go out, and again read back; the no-text one has no words and no key', async () => {
    const { env, rec, st } = await book();
    const head = await rec.finish(env.dir, 'book-a');
    assert.equal(rec.activeChunk('book-a'), null);
    const stamped = await st.settle(head, { wait: 5000 });
    assert.deepEqual(stamped, { tsa: true, ots: true });
    // already stamped: settled at once, no new request
    const calls = env.calls.length;
    assert.deepEqual(await st.settle(head, { wait: 5000 }), { tsa: true, ots: true });
    assert.equal(env.calls.length, calls);
    const out = {};
    for (const kind of ['clear', 'full']) {
      const built = await F.buildExport(env.dir, { kind, meta: meta(head, { dev: head.dev, n: head.n, ...stamped }), anchors: [ROOT], certs: [SIGNER] });
      assert.equal(built.result.ok, true, JSON.stringify(built.result.problems));
      const bytes = Z.zip(built.entries, { deflateRawSync: deflate });
      const back = await F.readExport(bytes);
      assert.deepEqual(back.problems, []);
      const res = await V.checkLog(back.files, { anchors: [ROOT], certs: [SIGNER] });
      assert.equal(res.ok, true, JSON.stringify(res.problems));
      out[kind] = { built, back, res, bytes };
    }
    const { clear, full } = out;
    // the same chains, the same origins, with words or without
    assert.deepEqual(clear.res.devices.map((d) => [d.n, d.head]), full.res.devices.map((d) => [d.n, d.head]));
    assert.ok(full.res.devices[0].made.paste > 0);
    // (without the words there's no manuscript to count by origin yet: the
    // report, milestone 5, counts it from lengths)
    assert.equal(clear.res.devices[0].made, null);
    assert.equal(clear.res.words, false);
    assert.equal(full.res.words, true);
    // the no-text export: no `x` anywhere, no key, not a word of the book
    const clearText = Object.values(clear.back.files).filter((v) => typeof v === 'string').join('\n');
    assert.ok(!clearText.includes('tide') && !clearText.includes('"x"'));
    assert.equal(JSON.parse(clear.back.files['log.json']).key, undefined);
    assert.ok(JSON.parse(full.back.files['log.json']).key);
    // the receipts made it, and the end is stamped
    assert.ok(clear.res.receipts.results.some((r) => r.n === head.n && r.status === 'ok' && r.svc === 'freetsa'), JSON.stringify(clear.res.receipts.counts));
    const cov = clear.res.coverage.get(head.dev);
    assert.equal(cov.tail, null, 'nothing after the last stamp');
    // the manifest: what, who, the manuscript's fingerprint, every file's hash
    const m = clear.built.manifest;
    assert.equal(m.kind, 'scribes-log-export');
    assert.equal(m.text, 'none');
    assert.equal(full.built.manifest.text, 'full');
    assert.equal(m.manuscript.hash, V.manuscriptHash(V.manuscriptText(full.res.newest.docs)));
    assert.deepEqual(m.manuscript.added, [sha('A BOOK')]);
    assert.equal(m.intact, true);
    const names = clear.built.entries.map((e) => e.name);
    assert.deepEqual(names.slice(0, 4), ['README.txt', 'verifier.html', 'manifest.json', 'log.json']);
    assert.ok(names.some((n) => /^chunks\/.*\.slog$/.test(n)) && names.some((n) => /^stamps\/.*\.stamps$/.test(n)) && names.some((n) => /^stamps\/certs\/[0-9a-f]{64}\.der$/.test(n)));
    assert.equal(m.files.length, names.length - 3);
    // slog-check reads an export too
    const file = path.join(env.root, 'export.zip');
    fs.writeFileSync(file, clear.bytes);
    const checked = await checkZip(file);
    assert.equal(checked.manifest.title, 'A Book');
    await st.stop();
  });

  test('a file changed, added or taken out of an export is caught', async () => {
    const { env, rec } = await book();
    const head = await rec.finish(env.dir, 'book-a');
    const built = await F.buildExport(env.dir, { kind: 'clear', meta: meta(head, null) });
    const edit = (fn) => {
      const entries = built.entries.map((e) => ({ ...e }));
      fn(entries);
      return F.readExport(Z.zip(entries, { deflateRawSync: deflate }));
    };
    let r = await edit((es) => { const c = es.find((e) => e.name.startsWith('chunks/') && String(e.data).includes('"src":"paste"')); c.data = String(c.data).replace('"src":"paste"', '"src":"typed"'); });
    assert.ok(r.problems.some((p) => /not the file the manifest lists/.test(p)));
    r = await edit((es) => es.push({ name: 'chunks/20261009T000000Z-cccccccc.slog', data: '' }));
    assert.ok(r.problems.some((p) => /not in the manifest/.test(p)));
    r = await edit((es) => es.splice(es.findIndex((e) => e.name.startsWith('chunks/')), 1));
    assert.ok(r.problems.some((p) => /in the manifest but not in the export/.test(p)));
    // the README and the verifier may be anything (they're NEO's, not the log's)
    r = await edit((es) => { es[0].data = 'changed'; });
    assert.deepEqual(r.problems, []);
  });

  test('archived chunks are exported unpacked, and a line that can\'t be read stays unreadable', async () => {
    const { env, rec } = await book();
    await rec.finish(env.dir, 'book-a');
    F.mergeIntoArchive(env.dir, { dev: rec.device(), now: () => env.clock });
    assert.deepEqual(env.loose().filter(V.isChunkName), []);
    const built = await F.buildExport(env.dir, { kind: 'clear', meta: meta({ ms: null }, null) });
    assert.equal(built.entries.filter((e) => e.name.startsWith('chunks/')).length, 2);
    assert.ok(!built.entries.some((e) => V.isArchiveName(e.name)));
    assert.equal(built.result.ok, true);
    const cleared = F.withoutWords('{"kind":"edit","x":{"ins":["secret"]}}\n{broken secret\n{"kind":"cut sh');
    assert.equal(cleared, '{"kind":"edit"}\n! unreadable line, left out of this export\n');
    assert.ok(!cleared.includes('secret'));
  });

  test('offline at export: the end waits, and the export says so', async () => {
    const { env, rec, st } = await book();
    env.down = true;
    const head = await rec.finish(env.dir, 'book-a');
    const got = await st.settle(head, { wait: 2000 });
    assert.deepEqual(got, { tsa: false, ots: false });
    assert.ok(st.status(head.logId, head.dev).waiting, 'queued for the network');
    // back online: settled on asking, the queued head sent
    env.down = false;
    st.retryAt = 0;
    assert.deepEqual(await st.settle(head, { wait: 5000 }), { tsa: true, ots: true });
    await st.stop();
  });
});
