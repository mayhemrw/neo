'use strict';

// The shared verification core (slog-verify.js): the same file NEO,
// slog-check and the verifier page run. Chains written with slog.js's
// Chain, receipts signed by the local test authority (stamp-fakes.js).

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, test } = require('node:test');
const slog = require('../slog.js');
const V = require('../slog-verify.js');
const H = require('../slog-hash.js');
const tsa = require('../stamp-tsa.js');
const ots = require('../stamp-ots.js');
const fakes = require('./stamp-fakes.js');

const KEY = Buffer.alloc(32, 9);
const DEV_A = 'a'.repeat(32);
const DEV_B = 'b'.repeat(32);
const T0 = Date.UTC(2026, 9, 8, 16, 0, 0); // (the test authority's certificates start Oct 7, 22:08 UTC)
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// A chain on one device, entry by entry, in chunks as NEO writes them
function chainOf(dev, { start = T0, step = 1000 } = {}) {
  let clock = start;
  const chain = new slog.Chain({ dev, key: KEY, now: () => (clock += step) });
  const chunks = [];
  let cur = null;
  const c = {
    dev, chain, chunks,
    at: (ms) => { clock = ms; return c; },
    open() {
      const prevChunk = chunks.length ? chunks[chunks.length - 1].name : null;
      cur = { name: slog.chunkName(clock, dev, chunks.length + 1), lines: [] };
      chunks.push(cur);
      return c.add('open', { v: 2, log: 'feedfacefeedface', dev, prevChunk, app: 'test' });
    },
    add(kind, fields = {}, ins = null) {
      const { entry, line } = chain.entry(kind, fields, ins);
      cur.lines.push(line);
      return entry;
    },
    edit(doc, src, ops, ins, more = {}) { return c.add('edit', { doc, src, ops: slog.recordOps(ops, ins), ...more }, ins); },
    base(doc, src, text, more = {}) { return c.add('base', { doc, src, ops: slog.recordOps([[0, 0, text.length]], [text]), ...more }, [text]); },
    close() { return c.add('close', { why: 'close', ms: '0'.repeat(64) }); },
    entries: () => chunks.flatMap((k) => k.lines.map((l) => JSON.parse(l)))
  };
  return c;
}
// a scribes-log folder as the checker takes it
function filesOf(chains, { key = true, words = true, receipts = {}, certs = [] } = {}) {
  const files = { 'log.json': JSON.stringify({ v: 1, logId: 'feedfacefeedface', ...(key ? { key: KEY.toString('base64') } : {}) }) };
  for (const c of chains) {
    for (const k of c.chunks) {
      const lines = words ? k.lines : k.lines.map((l) => { const { x, ...clear } = JSON.parse(l); return JSON.stringify(clear); });
      files[k.name] = lines.join('\n') + '\n';
    }
  }
  for (const [name, lines] of Object.entries(receipts)) files['stamps/' + name] = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  for (const der of certs) files['stamps/certs/' + sha(der) + '.der'] = new Uint8Array(der);
  return files;
}
// a token from the local test authority for `hex`, dated `at`
function tokenFor(hex, at) {
  const req = tsa.request(new Uint8Array(Buffer.from(hex, 'hex')));
  return tsa.parseResponse(new Uint8Array(fakes.tokenFor(req.der, at))).token;
}
const devOf = (res, dev) => res.devices.find((d) => d.dev === dev);
const origins = (d, doc, needle) => {
  const t = d.traced[doc];
  const at = t.text.indexOf(needle);
  assert.ok(at >= 0, `"${needle}" is in ${doc}`);
  return V.originsAt(t, at, needle.length).map(([, o]) => o);
};

const TYPED = 'The lighthouse keeper counted the gulls each dawn.';
const PASTED = 'A paragraph that came from somewhere outside the book.';

describe('slog-verify: the core on its own', () => {
  test('its plain JavaScript hashing gives the bytes Node\'s does', () => {
    const e = { kind: 'edit', n: 7, prev: 'ab'.repeat(32), ts: T0, doc: 'ch-1', src: 'typed', ops: [[0, 0, 3]] };
    assert.equal(H.toHex(H.sha256(H.utf8(V.canonical(e)))), slog.entryHash(e));
    const salt = H.hmacSha256(new Uint8Array(KEY), H.utf8(DEV_A + ':7'));
    assert.equal(H.toHex(salt), crypto.createHmac('sha256', KEY).update(DEV_A + ':7').digest('hex'));
    const pure = H.toHex(H.sha256(H.concat(salt, H.utf8(V.canonical(['abc'])))));
    assert.equal(pure, slog.commitment(KEY, DEV_A, 7, ['abc']));
  });

  test('runs with no Node at all, as the verifier page will', async () => {
    const a = chainOf(DEV_A);
    a.open();
    a.base('ch-1', 'baseline', `<p>${TYPED}</p>`);
    a.edit('ch-1', 'paste', [[3 + TYPED.length, 0, PASTED.length + 1]], [' ' + PASTED]);
    a.close();
    const files = filesOf([a]);
    // a bare context: no require, no Buffer, no process; WebCrypto and the encoders only
    const ctx = vm.createContext({ crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array, DataView, Promise, console });
    for (const f of ['slog-hash.js', 'slog-zip.js', 'stamp-tsa.js', 'stamp-ots.js', 'slog-verify.js']) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
    }
    ctx.files = files;
    const res = await vm.runInContext('SlogVerify.checkLog(files)', ctx);
    assert.equal(res.ok, true, JSON.stringify(res.problems));
    assert.equal(res.devices.length, 1);
    assert.equal(res.devices[0].name, 'Device 1');
    assert.deepEqual({ ...res.devices[0].made }, { baseline: TYPED.length, paste: PASTED.length + 1 });
  });

  test('where an op\'s insertion ends up once the entry\'s other ops are applied', () => {
    assert.deepEqual(V.insertOffsets([[2, 0, 3], [10, 1, 4]]), [2, 10]);
    // a later op before an earlier one shifts it; one cutting into it loses it
    assert.deepEqual(V.insertOffsets([[10, 0, 3], [2, 2, 5]]), [13, 2]);
    assert.deepEqual(V.insertOffsets([[10, 0, 3], [11, 1, 0]]), [null, 11]);
  });

  test('replays and checks the moved functions the same as before (slog.js re-exports them)', () => {
    for (const f of ['canonical', 'verifyChain', 'replay', 'trace', 'composition', 'proseMask', 'manuscriptText', 'parseChunk', 'viewOf']) {
      assert.equal(slog[f], V[f], f);
    }
  });
});

describe('slog-verify: text from another device', () => {
  // A types and pastes; B's first open finds A's text (arrived)
  function twoDevices({ link }) {
    const a = chainOf(DEV_A);
    a.open();
    a.add('doc', { doc: 'ch-1', act: 'new' });
    const html = `<p>${TYPED}</p>`;
    a.edit('ch-1', 'typed', [[0, 0, html.length]], [html]);
    const withPaste = `<p>${TYPED}</p><p>${PASTED}</p>`;
    const pasted = a.edit('ch-1', 'paste', [[html.length, 0, withPaste.length - html.length]], [withPaste.slice(html.length)]);
    a.close();
    const b = chainOf(DEV_B, { start: T0 + 3600e3 });
    b.open();
    b.base('ch-1', 'arrived', withPaste, link ? { from: [[0, 0, withPaste.length, { dev: DEV_A, n: pasted.n, doc: 'ch-1', at: 0 }]] } : {});
    const more = ' And then the fog came in.';
    const at = withPaste.length - 4;
    b.edit('ch-1', 'typed', [[at, 0, more.length]], [more]);
    b.close();
    return { a, b, more };
  }

  test('a recorded from: the text keeps the origins it had on the device it came from', async () => {
    const { a, b, more } = twoDevices({ link: true });
    const res = await V.checkLog(filesOf([a, b]));
    assert.equal(res.ok, true, JSON.stringify(res.devices.map((d) => d.problems)));
    const d = devOf(res, DEV_B);
    assert.deepEqual(origins(d, 'ch-1', TYPED), ['typed']);
    assert.deepEqual(origins(d, 'ch-1', PASTED), ['paste']);
    assert.deepEqual(origins(d, 'ch-1', more), ['typed']);
    assert.deepEqual(d.arrivals, { recorded: 1, matched: 0, unlinked: 0, from: { 'Device 1': 1 } });
    assert.deepEqual([devOf(res, DEV_A).name, d.name], ['Device 1', 'Device 2']);
  });

  test('…and without the words, its lengths are still checked and its origins still carried', async () => {
    const { a, b } = twoDevices({ link: true });
    const res = await V.checkLog(filesOf([a, b], { key: false, words: false }));
    assert.equal(res.ok, true);
    const d = devOf(res, DEV_B);
    assert.equal(d.made, null); // no words, no manuscript to count…
    const runs = d.traced['ch-1'].runs.map(([, o]) => o);
    assert.ok(runs.includes('paste') && runs.includes('typed') && !runs.includes('arrived'), JSON.stringify(runs)); // …but the origins are there
  });

  test('no from (the other chunks hadn\'t synced): the full log matches it by its words', async () => {
    const { a, b } = twoDevices({ link: false });
    const res = await V.checkLog(filesOf([a, b]));
    assert.equal(res.ok, true);
    const d = devOf(res, DEV_B);
    assert.deepEqual(origins(d, 'ch-1', PASTED), ['paste']);
    assert.deepEqual(d.arrivals, { recorded: 0, matched: 1, unlinked: 0, from: { 'Device 1': 1 } });
    // shared without the words, it stays arrived
    const bare = await V.checkLog(filesOf([a, b], { key: false, words: false }));
    assert.deepEqual(devOf(bare, DEV_B).arrivals, { recorded: 0, matched: 0, unlinked: 1, from: {} });
  });

  test('a from that names text that isn\'t there, or a device that isn\'t, is a problem', async () => {
    const a = chainOf(DEV_A);
    a.open();
    a.base('ch-1', 'typed', '<p>Short.</p>');
    a.close();
    const b = chainOf(DEV_B, { start: T0 + 60e3 });
    b.open();
    b.base('ch-1', 'arrived', '<p>Something else entirely.</p>', { from: [[0, 0, 28, { dev: DEV_A, n: 2, doc: 'ch-1', at: 0 }]] });
    b.base('ch-2', 'arrived', '<p>Hm.</p>', { from: [[0, 0, 9, { dev: 'c'.repeat(32), n: 2, doc: 'ch-2', at: 0 }]] });
    b.close();
    const res = await V.checkLog(filesOf([a, b]));
    assert.equal(res.ok, false);
    assert.deepEqual(devOf(res, DEV_B).problems.map((p) => [p.n, p.problem]), [
      [2, 'from points past the text it names'],
      [3, 'from names a device whose log isn\'t here']
    ]);
  });

  test('text that went back and forth is traced through both chains', async () => {
    const a = chainOf(DEV_A);
    const b = chainOf(DEV_B, { start: T0 + 1000 });
    a.open();
    const one = `<p>${TYPED}</p>`;
    const e1 = a.base('ch-1', 'typed', one);
    b.open();
    b.base('ch-1', 'arrived', one, { from: [[0, 0, one.length, { dev: DEV_A, n: e1.n, doc: 'ch-1', at: 0 }]] });
    const two = one + `<p>${PASTED}</p>`;
    const e2 = b.edit('ch-1', 'paste', [[one.length, 0, two.length - one.length]], [two.slice(one.length)]);
    b.close();
    a.edit('ch-1', 'arrived', [[one.length, 0, two.length - one.length]], [two.slice(one.length)], { from: [[0, 0, two.length - one.length, { dev: DEV_B, n: e2.n, doc: 'ch-1', at: one.length }]] });
    a.close();
    const res = await V.checkLog(filesOf([a, b]));
    assert.equal(res.ok, true, JSON.stringify(res.devices.map((d) => d.problems)));
    const d = devOf(res, DEV_A);
    assert.deepEqual(origins(d, 'ch-1', TYPED), ['typed']);
    assert.deepEqual(origins(d, 'ch-1', PASTED), ['paste']);
  });

  test('an arrival takes the other device\'s origins whole, not the diff\'s guess at which full stop is which', async () => {
    // A types a sentence; B moves it to the end; A's diff of what arrived
    // keeps the moved sentence's stop and puts in the one before it
    const a = chainOf(DEV_A);
    const b = chainOf(DEV_B, { start: T0 + 1000 });
    a.open();
    const start = '<p>Calm.</p><p>End.</p>';
    a.base('ch-1', 'import', start);
    const typed = a.edit('ch-1', 'typed', [[8, 0, 6]], [' Wind.']);
    const was = '<p>Calm. Wind.</p><p>End.</p>';
    b.open();
    b.base('ch-1', 'arrived', was, { from: [[0, 0, was.length, { dev: DEV_A, n: typed.n, doc: 'ch-1', at: 0 }]] });
    const now = '<p>Calm.</p><p>End. Wind.</p>';
    const moved = b.add('edit', { doc: 'ch-1', src: 'move', ops: slog.recordOps([[8, 6, 0], [19, 0, 6]], ['', ' Wind.']), from: [[1, 0, 6, { n: b.chain.n + 1, op: 0, at: 0 }]] }, ['', ' Wind.']);
    b.close();
    const at = now.indexOf('End') + 3; // (A's diff: Calm's stop and " Wind" out, ". Wind" in after End)
    a.edit('ch-1', 'arrived', [[7, 6, 0], [at, 0, 6]], ['', '. Wind'], { from: [[1, 0, 6, { dev: DEV_B, n: moved.n, doc: 'ch-1', at }]] });
    a.close();
    for (const words of [true, false]) {
      const res = await V.checkLog(filesOf([a, b], { key: words, words }));
      const d = devOf(res, DEV_A);
      assert.equal(res.ok, true, JSON.stringify(res.devices.map((x) => x.problems)));
      assert.deepEqual(d.traced['ch-1'].runs, devOf(res, DEV_B).traced['ch-1'].runs, 'A\'s origins are B\'s, ' + (words ? 'with' : 'without') + ' the words');
      if (words) assert.deepEqual([...new Set(origins(d, 'ch-1', ' Wind.'))], ['typed']);
    }
  });
});

describe('slog-verify: receipts, coverage and the clock', () => {
  // a session on A: three edits, a stamp of the third, a fourth edit after
  function stamped({ at = null } = {}) {
    const a = chainOf(DEV_A, { step: 60e3 });
    a.open();
    a.base('ch-1', 'baseline', '<p>Start.</p>');
    a.edit('ch-1', 'typed', [[9, 0, 6]], [' More.']);
    const third = a.edit('ch-1', 'typed', [[15, 0, 6]], [' Done.']);
    const h = slog.entryHash(third);
    const when = at === null ? third.ts + 2000 : at;
    const token = tokenFor(h, when);
    const line = { svc: 'freetsa', dev: DEV_A, n: third.n, h, ts: third.ts + 1000, tsr: Buffer.from(token).toString('base64') };
    a.add('stamp', { svc: 'freetsa', of: third.n, t: tsa.parseToken(token).tst.time, r: sha(token) });
    a.edit('ch-1', 'typed', [[21, 0, 6]], [' Next.']);
    a.close();
    return { a, third, line, token };
  }
  const OPTS = { anchors: [fakes.ROOT], certs: [fakes.SIGNER] };

  test('a receipt checks, its stamp entry matches it, and it covers every entry up to its own', async () => {
    const { a, third, line } = stamped();
    const res = await V.checkLog(filesOf([a], { receipts: { '20261007T160300Z-aaaaaaaa.stamps': [line] } }), OPTS);
    assert.equal(res.ok, true, JSON.stringify(res.receipts.problems));
    assert.deepEqual(res.receipts.counts, { 'freetsa ok': 1 });
    assert.deepEqual([res.receipts.stampEntries.matched, res.receipts.stampEntries.missing], [1, []]);
    const cov = res.coverage.get(DEV_A);
    assert.deepEqual(cov.stamps.map((s) => [s.n, s.svcs]), [[third.n, ['freetsa']]]);
    assert.deepEqual([cov.tail.from, cov.tail.edits], [third.n + 1, 1]);
    assert.equal(cov.longest.to, third.n);
    assert.deepEqual(res.clock, []);
  });

  test('a deleted receipt leaves a hole; a receipt for the wrong hash fails', async () => {
    const { a, line } = stamped();
    const gone = await V.checkLog(filesOf([a]), OPTS);
    assert.equal(gone.ok, false);
    assert.deepEqual(gone.receipts.problems.map((p) => p.problem), [`stamp entry for entry ${line.n} has no receipt`]);
    const wrong = await V.checkLog(filesOf([a], { receipts: { 'x.stamps': [], '20261007T160300Z-aaaaaaaa.stamps': [{ ...line, n: line.n - 1 }] } }), OPTS);
    assert.equal(wrong.ok, false);
    assert.ok(wrong.receipts.results[0].problems.includes('for a hash that isn\'t its entry\'s'));
  });

  test('an authority the checker doesn\'t trust is unchecked, not failed', async () => {
    const { a, line } = stamped();
    const res = await V.checkLog(filesOf([a], { receipts: { '20261007T160300Z-aaaaaaaa.stamps': [line] }, certs: [fakes.SIGNER] }));
    assert.deepEqual(res.receipts.counts, { 'freetsa unchecked': 1 });
    assert.equal(res.ok, true);
    assert.equal(res.coverage.get(DEV_A).stamps.length, 0);
  });

  test('the clock: a receipt far from its request, and one dated before its entry', async () => {
    const { a, third, line } = stamped({ at: T0 - 3600e3 });
    const res = await V.checkLog(filesOf([a], { receipts: { '20261007T160300Z-aaaaaaaa.stamps': [line] } }), OPTS);
    assert.deepEqual(res.clock.map((f) => [f.kind, f.n]), [['receipt-skew', third.n], ['receipt-before-entry', third.n]]);
  });

  test('the clock: jumps back, and forward jumps that aren\'t a wake', () => {
    const a = chainOf(DEV_A);
    a.open();
    a.add('clock', { jump: -10 * 60e3 });
    a.add('clock', { jump: 30e3 });
    a.add('clock', { jump: 10 * 60e3 });
    a.add('sleep');
    a.at(T0 + 8 * 3600e3).add('wake');
    a.add('clock', { jump: 8 * 3600e3 });
    a.at(T0 - 3600e3).add('edit', { doc: 'notes', src: 'typed', ops: [] });
    a.close();
    const flags = V.clockCheck([{ dev: DEV_A, entries: a.entries() }]);
    assert.deepEqual(flags.map((f) => [f.n, f.kind]), [[2, 'back'], [4, 'forward'], [8, 'back']]);
  });

  test('a finished OpenTimestamps proof: its block, and the time a block check gives it', async () => {
    const { a, third } = stamped();
    const h = slog.entryHash(third);
    // a proof of the hash: a nonce appended, hashed, attested in block 900000
    const file = { hashOp: 'sha256', digest: new Uint8Array(Buffer.from(h, 'hex')), timestamp: ots.node(new Uint8Array(Buffer.from(h, 'hex'))) };
    const c1 = { op: { tag: 0xf0, arg: new Uint8Array(16).fill(5) }, stamp: ots.node(H.concat(file.digest, new Uint8Array(16).fill(5))) };
    file.timestamp.ops.push(c1);
    const c2 = { op: { tag: 0x08 }, stamp: ots.node(H.sha256(c1.stamp.msg)) };
    c1.stamp.ops.push(c2);
    c2.stamp.attestations.push({ type: 'bitcoin', height: 900000 });
    const proof = Buffer.from(ots.serialize(file)).toString('base64');
    const lines = { '20261007T190000Z-aaaaaaaa.stamps': [{ svc: 'ots', dev: DEV_A, n: third.n, h, ts: third.ts, ots: proof }] };
    const offline = await V.checkLog(filesOf([a], { receipts: lines }), OPTS);
    assert.deepEqual(offline.receipts.counts, { 'ots bitcoin': 1 });
    assert.equal(offline.receipts.results[0].bitcoin[0].height, 900000);
    const asked = [];
    const blockTime = T0 + 5 * 3600e3;
    const online = await V.checkLog(filesOf([a], { receipts: lines }), { ...OPTS, bitcoin: (att) => { asked.push(att.height); return { ok: att.msg === H.toHex(c2.stamp.msg), time: blockTime }; } });
    assert.deepEqual(online.receipts.counts, { 'ots ok': 1 });
    assert.deepEqual(asked, [900000]);
    assert.deepEqual(online.coverage.get(DEV_A).stamps.map((s) => [s.n, s.time]), [[third.n, blockTime]]);
  });
});

// Phase 3's rule: a version restored (the whole chapter, or a passage copied
// out of it) keeps the origins its words had. Written the way NEO does it:
// main.js hands the Recorder what this computer's chain deleted since the
// version (slog-history.js's restoreSource), and the window describes the
// chapter as a restore. Each restore runs in a fresh Recorder, as after a
// restart, so only the log itself can say where the words were. Then the
// log is checked as slog-check does, with its words and without them: the
// same origins either way.
describe('Restored text keeps its origin', { concurrency: 1 }, () => {
  const os = require('node:os');
  const zlib = require('node:zlib');
  const F = require('../slog-files.js');
  const { History } = require('../slog-history.js');
  const { checkBook, loadLog } = require('./slog-check.js');
  const OWN = 'The writer typed this opening line in the book herself.';
  const PASTED = 'A sentence the writer found somewhere else entirely, and pasted.';
  const REVISED = PASTED.replace('somewhere', 'anywhere');
  const TYPED = 'Then a line she typed at the desk, slowly, and kept for a while.';
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-restore-'));
  let made = 0;

  function setup(chapters) {
    const root = path.join(tmpRoot, String(++made));
    const dir = path.join(root, 'book-a');
    fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify({ id: 'book-a', title: 'A Book', author: 'Ada', chapterOrder: Object.keys(chapters) }, null, 2));
    for (const [id, html] of Object.entries(chapters)) fs.writeFileSync(path.join(dir, 'chapters', id + '.html'), html);
    const env = { root, dir, clock: T0, errors: [] };
    env.recorder = (home = 'desk') => new slog.Recorder({
      home: path.join(root, home), app: 'test', now: () => (env.clock += 1000),
      onError: (where, err) => env.errors.push(where + ': ' + err.message)
    });
    env.history = (home = 'desk') => new History({ home: path.join(root, home, 'history'), onError: (w, err) => env.errors.push(w + ': ' + err.message) });
    return env;
  }
  // the window describes a chapter, then main.js saves it
  function put(rec, env, id, html, how) {
    rec.observe(env.dir, 'book-a', slog.chapterDoc(id), html, how);
    rec.touch(env.dir, 'book-a');
    fs.writeFileSync(path.join(env.dir, 'chapters', id + '.html'), html);
    rec.wrote(env.dir, 'book-a', slog.chapterDoc(id), html);
  }
  async function session(rec, env, edits) {
    rec.open(env.dir, 'book-a');
    for (const [id, html, how] of edits) put(rec, env, id, html, how);
    await rec.close('book-a');
  }
  // one chapter's session versions on one computer's chain
  const versionsOf = (env, id, home = 'desk') => env.history(home).index(env.dir).chapters[slog.chapterDoc(id)].versions;
  // what the History window does: main gets the log ready (history:restore),
  // then the chapter is described as a restore and saved
  async function restore(env, ref, id, { home = 'desk', at = null, html = null } = {}) {
    const rec = env.recorder(home);
    rec.open(env.dir, 'book-a');
    await rec.head(env.dir, 'book-a');
    const got = env.history(home).restoreSource(env.dir, ref, id, { me: rec.device(), at });
    assert.equal(got.error, undefined);
    rec.restoring(env.dir, 'book-a', got.dels);
    put(rec, env, id, html === null ? got.text : html(got.text), { src: 'move', cause: 'restore' });
    await rec.close('book-a');
    return { rec, got };
  }
  // the log checked with its words (where each passage came from) and
  // without them (the same runs of origins, from lengths alone)
  function checked(env) {
    const full = checkBook(env.dir);
    assert.deepEqual(full.problems, []);
    for (const d of full.devices) assert.deepEqual(d.problems, [], 'chain ' + d.dev);
    const raw = loadLog(env.dir);
    const bare = {};
    for (const [name, v] of Object.entries(raw)) {
      if (V.isChunkName(name)) bare[name] = F.withoutWords(v);
      else if (name === 'log.json') { const info = JSON.parse(v); delete info.key; bare[name] = JSON.stringify(info); } else bare[name] = v;
    }
    const clear = V.checkChains(V.readLog(bare, { inflateSync: zlib.inflateSync }));
    assert.deepEqual(clear.problems, []);
    for (const d of full.devices) {
      const c = clear.devices.find((x) => x.dev === d.dev);
      assert.deepEqual(c.problems, [], 'chain ' + d.dev + ' without the words');
      for (const doc of Object.keys(d.traced)) assert.deepEqual(c.traced[doc].runs, d.traced[doc].runs, doc + ' without the words');
    }
    return full;
  }
  const whereFrom = (d, doc, needle) => {
    const t = d.traced[slog.chapterDoc(doc)];
    const at = t.text.indexOf(needle);
    assert.ok(at >= 0, `"${needle}" is in ${doc}`);
    return [...new Set(V.originsAt(t, at, needle.length).map(([, o]) => o))];
  };
  const restores = (env) => {
    const logDir = path.join(env.dir, slog.LOG_DIR);
    return fs.readdirSync(logDir).filter(slog.isChunkName).flatMap((n) => slog.parseChunk(fs.readFileSync(path.join(logDir, n), 'utf8')).entries)
      .filter((e) => e.kind === 'edit' && e.cause === 'restore');
  };

  test('pasted, revised, deleted, restored: still pasted', async () => {
    const env = setup({ 'ch-1': `<p>${OWN}</p>` });
    await session(env.recorder(), env, []);
    await session(env.recorder(), env, [['ch-1', `<p>${OWN}</p><p>${PASTED}</p>`, { src: 'paste' }]]);
    await session(env.recorder(), env, [['ch-1', `<p>${OWN}</p><p>${REVISED}</p>`, { src: 'typed' }]]);
    await session(env.recorder(), env, [['ch-1', `<p>${OWN}</p>`, { src: 'typed' }]]);
    const v = versionsOf(env, 'ch-1')[1];
    const { got } = await restore(env, { dev: v.dev, n: v.n }, 'ch-1');
    assert.equal(got.text, `<p>${OWN}</p><p>${PASTED}</p>`);
    // the restore points at the deletions in earlier sessions
    const [r] = restores(env);
    assert.equal(r.src, 'move');
    assert.ok(r.from.length >= 2 && r.from.every((p) => p[3].n < r.n && p[3].n > v.n));
    const d = checked(env).devices[0];
    assert.deepEqual(whereFrom(d, 'ch-1', PASTED), ['paste']);
    assert.deepEqual(whereFrom(d, 'ch-1', OWN), ['baseline']);
    assert.equal(d.made.move, undefined, 'nothing restored is left without its origin');
    assert.equal(d.made.typed, undefined, 'and none of it counts as typed');
    assert.deepEqual(env.errors, []);
  });

  test('typed, revised, deleted, restored: still typed, not pasted', async () => {
    const env = setup({ 'ch-1': `<p>${OWN}</p>` });
    await session(env.recorder(), env, []);
    await session(env.recorder(), env, [['ch-1', `<p>${OWN}</p><p>${TYPED}</p>`, { src: 'typed' }]]);
    await session(env.recorder(), env, [['ch-1', `<p>${OWN}</p><p>${TYPED.replace('slowly', 'quickly')}</p>`, { src: 'typed' }]]);
    await session(env.recorder(), env, [['ch-1', `<p>${OWN}</p>`, { src: 'typed' }]]);
    const v = versionsOf(env, 'ch-1')[1];
    await restore(env, { dev: v.dev, n: v.n }, 'ch-1');
    const d = checked(env).devices[0];
    assert.deepEqual(whereFrom(d, 'ch-1', TYPED), ['typed']);
    assert.equal(d.made.move, undefined);
    assert.equal(d.made.paste, undefined);
  });

  test('moved from another chapter, then deleted: restored, it keeps the origin it moved with', async () => {
    const env = setup({ 'ch-1': `<p>${OWN}</p>`, 'ch-2': '<p>Second.</p>' });
    await session(env.recorder(), env, []);
    await session(env.recorder(), env, [['ch-2', `<p>Second.</p><p>${PASTED}</p>`, { src: 'paste' }]]);
    // cut from chapter 2, pasted into chapter 1
    await session(env.recorder(), env, [
      ['ch-2', '<p>Second.</p>', { src: 'typed' }],
      ['ch-1', `<p>${OWN}</p><p>${PASTED}</p>`, { src: 'move' }]
    ]);
    await session(env.recorder(), env, [['ch-1', `<p>${OWN}</p><p>${REVISED}</p>`, { src: 'typed' }]]);
    await session(env.recorder(), env, [['ch-1', `<p>${OWN}</p>`, { src: 'typed' }]]);
    const v = versionsOf(env, 'ch-1').find((x) => x.words > 10 && x.kind === 'session');
    await restore(env, { dev: v.dev, n: v.n }, 'ch-1');
    const d = checked(env).devices[0];
    assert.deepEqual(whereFrom(d, 'ch-1', PASTED), ['paste']);
    assert.equal(d.made.move, undefined);
  });

  test('a passage copied out of a version and pasted in: the same as a restore', async () => {
    const env = setup({ 'ch-1': `<p>${OWN}</p>` });
    await session(env.recorder(), env, []);
    await session(env.recorder(), env, [['ch-1', `<p>${OWN}</p><p>${PASTED}</p><p>${TYPED}</p>`, { src: 'paste' }]]);
    await session(env.recorder(), env, [['ch-1', `<p>${OWN}</p>`, { src: 'typed' }]]);
    const v = versionsOf(env, 'ch-1')[1];
    // only the pasted paragraph, put in after the first
    await restore(env, { dev: v.dev, n: v.n }, 'ch-1', { html: () => `<p>${OWN}</p><p>${PASTED}</p>` });
    const d = checked(env).devices[0];
    assert.deepEqual(whereFrom(d, 'ch-1', PASTED), ['paste']);
    assert.equal(d.made.move, undefined);
  });

  test('text from another computer, deleted there, restored here: the other computer\'s origins', async () => {
    const env = setup({ 'ch-1': `<p>${OWN}</p>` });
    // the desktop types and pastes; the laptop sees it arrive
    await session(env.recorder('desk'), env, [
      ['ch-1', `<p>${OWN}</p><p>${TYPED}</p>`, { src: 'typed' }],
      ['ch-1', `<p>${OWN}</p><p>${TYPED}</p><p>${PASTED}</p>`, { src: 'paste' }]
    ]);
    await session(env.recorder('laptop'), env, []);
    // the desktop revises and then deletes both; the deletions arrive on the laptop
    await session(env.recorder('desk'), env, [['ch-1', `<p>${OWN}</p><p>${TYPED}</p><p>${REVISED}</p>`, { src: 'typed' }]]);
    await session(env.recorder('laptop'), env, []);
    await session(env.recorder('desk'), env, [['ch-1', `<p>${OWN}</p>`, { src: 'typed' }]]);
    await session(env.recorder('laptop'), env, []);
    // the laptop restores the desktop's version: found by its time
    const desk = env.recorder('desk').device();
    // (the desktop's first session began its log, so its version is that one)
    const v = versionsOf(env, 'ch-1', 'laptop').find((x) => x.dev === desk);
    assert.equal(env.history('laptop').versionText(env.dir, { dev: v.dev, n: v.n }, 'ch-1').text, `<p>${OWN}</p><p>${TYPED}</p><p>${PASTED}</p>`);
    env.clock += 60000;
    const { rec } = await restore(env, { dev: v.dev, n: v.n }, 'ch-1', { home: 'laptop', at: v.ts });
    const res = checked(env);
    const lap = res.devices.find((d) => d.dev === rec.device());
    assert.deepEqual(whereFrom(lap, 'ch-1', PASTED), ['paste']);
    assert.deepEqual(whereFrom(lap, 'ch-1', TYPED), ['typed']);
    assert.equal(lap.made.move, undefined);
    assert.deepEqual(res.devices[res.devices.length - 1].differ, [], 'the newest chain replays to the disk');
  });

  test('without the deletions handed over, a restore says it was moved and claims no origin', async () => {
    const env = setup({ 'ch-1': `<p>${OWN}</p>` });
    await session(env.recorder(), env, []);
    await session(env.recorder(), env, [['ch-1', `<p>${OWN}</p><p>${PASTED}</p>`, { src: 'paste' }]]);
    await session(env.recorder(), env, [['ch-1', `<p>${OWN}</p>`, { src: 'typed' }]]);
    const rec = env.recorder();
    rec.open(env.dir, 'book-a');
    put(rec, env, 'ch-1', `<p>${OWN}</p><p>${PASTED}</p>`, { src: 'move', cause: 'restore' });
    await rec.close('book-a');
    const d = checked(env).devices[0];
    // (never typed: the label is the window's, and the log owns up to not knowing)
    assert.deepEqual(whereFrom(d, 'ch-1', PASTED), ['move']);
    assert.equal(d.made.typed, undefined);
  });
});
