'use strict';

// The stamper (slog-stamp.js) against a real Recorder and folders, with the
// network faked: a time-stamp authority that signs real RFC 3161 tokens
// with the local test key in scripts/fixtures/stamps, and calendars that
// answer with pending proofs (and, later, finished ones). The clock is
// turned by hand.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');
const slog = require('../slog.js');
const ots = require('../stamp-ots.js');
const tsa = require('../stamp-tsa.js');
const H = require('../slog-hash.js');
const { Stamper, readReceipts } = require('../slog-stamp.js');
const { checkBook } = require('./slog-check.js');

const { tokenFor, calendarAnswer, ROOT, SIGNER } = require('./stamp-fakes.js');
const MIN = 60 * 1000;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-stamp-'));
let made = 0;

/* ---- the network ---- */

function answer(status, body) {
  const b = Buffer.from(body);
  return { status, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length), text: async () => b.toString() };
}
// down: true while the network's out. finished: calendars hand out proofs in this block
function network(env) {
  const net = { down: false, finished: null, calls: [], tsaFails: false };
  net.fetch = async (url, init = {}) => {
    net.calls.push((init.method || 'GET') + ' ' + url);
    if (net.down) throw new Error('fetch failed');
    if (url === 'https://tsa.test/tsr') {
      if (net.tsaFails) return answer(503, 'busy');
      return answer(200, tokenFor(init.body, env.clock, { withCerts: net.certsAlways ? true : null }));
    }
    const m = /^https:\/\/(\w)\.pool\.test\/digest$/.exec(url);
    if (m) return answer(200, calendarAnswer(m[1], init.body));
    const u = /^https:\/\/(\w)\.btc\.calendar\.opentimestamps\.org\/timestamp\/([0-9a-f]+)$/.exec(url);
    if (u) {
      if (!net.finished) return answer(404, 'Pending confirmation in Bitcoin blockchain');
      const msg = H.fromHex(u[2]);
      const n = ots.node(msg);
      const c = { op: { tag: 0x08 }, stamp: ots.node(H.sha256(msg)) };
      c.stamp.attestations.push({ type: 'bitcoin', height: net.finished });
      n.ops.push(c);
      return answer(200, ots.serializeTimestamp(n));
    }
    return answer(404, '');
  };
  return net;
}

/* ---- a book, its recorder and its stamper ---- */

function setup() {
  const root = path.join(tmpRoot, String(++made));
  const dir = path.join(root, 'book-a');
  fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify({ id: 'book-a', title: 'A', author: 'Ada', chapterOrder: ['ch-1'] }));
  fs.writeFileSync(path.join(dir, 'chapters', 'ch-1.html'), '<p>Hello.</p>');
  const env = { root, dir, home: path.join(root, 'userData', 'slog'), clock: Date.UTC(2026, 9, 8, 16, 0, 0), errors: [], text: '<p>Hello.</p>' };
  env.net = network(env);
  env.recorder = () => new slog.Recorder({ home: env.home, app: 'test', now: () => env.clock, idleMs: 24 * 3600e3, onError: (w, e) => env.errors.push(w + ': ' + e.message) });
  env.stamper = (rec, opts = {}) => new Stamper({
    recorder: rec, fetch: env.net.fetch, home: env.home, now: () => env.clock,
    anchors: [ROOT], certs: [SIGNER], services: [{ svc: 'freetsa', url: 'https://tsa.test/tsr' }],
    calendars: ['https://a.pool.test', 'https://b.pool.test'],
    onError: (w, e) => env.errors.push(w + ': ' + e.message), ...opts
  });
  env.type = (rec, words) => {
    env.text = env.text.replace('</p>', ' ' + words + '</p>');
    rec.observe(dir, 'book-a', 'ch-1', env.text, { src: 'typed', ev: words.length });
    rec.touch(dir, 'book-a');
    fs.writeFileSync(path.join(dir, 'chapters', 'ch-1.html'), env.text);
    rec.wrote(dir, 'book-a', 'ch-1', env.text);
  };
  env.later = (ms) => { env.clock += ms; };
  return env;
}
function entries(env) {
  const logDir = path.join(env.dir, slog.LOG_DIR);
  return fs.readdirSync(logDir).filter(slog.isChunkName).sort()
    .flatMap((n) => slog.parseChunk(fs.readFileSync(path.join(logDir, n), 'utf8')).entries);
}
const hashOf = (e) => slog.entryHash(e);
function assertChecks(env) {
  const res = checkBook(env.dir);
  assert.deepEqual(res.problems, []);
  for (const d of res.devices) assert.deepEqual(d.problems, []);
  assert.equal(res.ok, true);
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const tsaCalls = (env) => env.net.calls.filter((c) => c.includes('tsa.test')).length;

describe('Stamper', { concurrency: 1 }, () => {
  test('a book being written is stamped after 15 minutes, and its receipts check', async () => {
    const env = setup();
    const rec = env.recorder();
    const st = env.stamper(rec);
    rec.open(env.dir, 'book-a');
    env.type(rec, 'The wind rose.');
    await st.tick(); // first sight of the session
    env.later(10 * MIN);
    env.type(rec, 'Rain came.');
    await st.tick();
    assert.equal(env.net.calls.length, 0, 'not yet');
    env.later(6 * MIN);
    const stampedAt = env.clock;
    await st.tick();
    assert.equal(tsaCalls(env), 1);
    assert.equal(env.net.calls.filter((c) => c.includes('pool.test')).length, 2);
    await rec.close('book-a');
    await st.stop();
    // the chain: two stamp entries, for the entry before them
    const all = entries(env);
    const stamps = all.filter((e) => e.kind === 'stamp');
    assert.deepEqual(stamps.slice(0, 2).map((e) => e.svc).sort(), ['freetsa', 'ots']);
    const of = all.find((e) => e.n === stamps[0].of);
    assert.ok(of && of.kind === 'edit');
    const ts = stamps.find((e) => e.svc === 'freetsa');
    assert.equal(ts.t, stampedAt, 'the authority\'s time');
    // the receipt file: one line per receipt, each for that entry's hash
    const receipts = readReceipts(env.dir);
    const tsr = receipts.find((r) => r.line.svc === 'freetsa' && r.line.n === of.n).line;
    const v = await tsa.verify(new Uint8Array(Buffer.from(tsr.tsr, 'base64')), { hash: hashOf(of), anchors: [ROOT], certs: [SIGNER] });
    assert.deepEqual(v.problems, []);
    assert.equal(ts.r, crypto.createHash('sha256').update(Buffer.from(tsr.tsr, 'base64')).digest('hex'));
    const pend = receipts.find((r) => r.line.svc === 'ots' && r.line.n === of.n).line;
    const proof = ots.parse(new Uint8Array(Buffer.from(pend.ots, 'base64')));
    assert.equal(ots.check(proof, hashOf(of)).pending.length, 2);
    // the certificates, once each
    const certs = fs.readdirSync(path.join(env.dir, slog.LOG_DIR, 'stamps', 'certs'));
    assert.equal(certs.length, 2);
    assertChecks(env);
    assert.deepEqual(env.errors, []);
  });

  test('a chain that hasn\'t moved isn\'t stamped again; its own stamp entries don\'t count', async () => {
    const env = setup();
    const rec = env.recorder();
    const st = env.stamper(rec);
    rec.open(env.dir, 'book-a');
    env.type(rec, 'One.');
    await st.tick();
    env.later(16 * MIN);
    await st.tick();
    assert.equal(tsaCalls(env), 1);
    env.later(16 * MIN);
    await st.tick();
    env.later(16 * MIN);
    await st.tick();
    assert.equal(tsaCalls(env), 1, 'nothing written since');
    env.type(rec, 'Two.');
    env.later(16 * MIN);
    await st.tick();
    assert.equal(tsaCalls(env), 2);
    await rec.close('book-a');
    await st.stop();
    assertChecks(env);
  });

  test('a session\'s end is stamped; its stamp entries open the next chunk', async () => {
    const env = setup();
    const rec = env.recorder();
    const st = env.stamper(rec);
    rec.open(env.dir, 'book-a');
    env.type(rec, 'Closing words.');
    await rec.close('book-a');
    await settle();
    await st.tick();
    const close = entries(env).filter((e) => e.kind === 'close').pop();
    assert.equal(tsaCalls(env), 1, 'the close was stamped');
    assert.ok(!entries(env).some((e) => e.kind === 'stamp'), 'no chunk was opened for it');
    // the next session: its chunk opens with the receipts' stamp entries
    env.later(60 * MIN);
    rec.open(env.dir, 'book-a');
    env.type(rec, 'Next day.');
    await rec.close('book-a');
    await settle();
    await st.stop();
    const all = entries(env);
    const open = all.findIndex((e) => e.kind === 'open' && e.n > close.n);
    assert.deepEqual(all.slice(open + 1, open + 3).map((e) => [e.kind, e.of]), [['stamp', close.n], ['stamp', close.n]]);
    assertChecks(env);
  });

  test('offline: only the newest hash waits, and goes when the network\'s back', async () => {
    const env = setup();
    const rec = env.recorder();
    const st = env.stamper(rec);
    rec.open(env.dir, 'book-a');
    env.type(rec, 'One.');
    await st.tick();
    env.net.down = true;
    env.later(16 * MIN);
    await st.tick();
    assert.equal(st.status(rec.heads()[0].logId, rec.device()).waiting, true);
    env.type(rec, 'Two.');
    env.later(16 * MIN);
    await st.tick();
    env.type(rec, 'Three.');
    env.later(16 * MIN);
    await st.tick();
    const tried = env.net.calls.length;
    env.net.down = false;
    env.later(16 * MIN);
    await st.tick();
    await st.tick();
    const head = rec.heads()[0];
    await rec.close('book-a');
    await settle();
    await st.stop();
    assert.ok(env.net.calls.length > tried);
    assert.equal(st.status(head.logId, head.dev).waiting, false);
    const stamped = entries(env).filter((e) => e.kind === 'stamp').map((e) => e.of);
    const typedThree = entries(env).filter((e) => e.kind === 'edit').pop().n;
    assert.ok(stamped.every((n) => n >= typedThree), 'none of the older, unstamped hashes was sent late');
    assertChecks(env);
  });

  test('quitting keeps the last hash for the next start', async () => {
    const env = setup();
    const rec = env.recorder();
    const st = env.stamper(rec);
    rec.open(env.dir, 'book-a');
    env.type(rec, 'Last words.');
    await rec.closeAll('quit');
    await st.stop();
    assert.equal(env.net.calls.length, 0);
    // NEO starts again
    env.later(8 * 3600e3);
    const rec2 = env.recorder();
    const st2 = env.stamper(rec2);
    await st2.tick();
    assert.equal(tsaCalls(env), 1);
    await st2.stop();
    const close = entries(env).filter((e) => e.kind === 'close').pop();
    const lines = readReceipts(env.dir).map((r) => r.line);
    assert.ok(lines.some((l) => l.svc === 'freetsa' && l.n === close.n && l.h === hashOf(close)));
    // its stamp entries wait for the book's next chunk
    rec2.open(env.dir, 'book-a');
    env.type(rec2, 'Another day.');
    await rec2.close('book-a');
    assert.ok(entries(env).some((e) => e.kind === 'stamp' && e.of === close.n));
    assertChecks(env);
  });

  test('a service that fails waits on its own; the other\'s receipt is kept', async () => {
    const env = setup();
    const rec = env.recorder();
    const st = env.stamper(rec);
    rec.open(env.dir, 'book-a');
    env.type(rec, 'Words.');
    await st.tick();
    env.net.tsaFails = true;
    env.later(16 * MIN);
    await st.tick();
    const key = Object.keys(st.state.queue)[0];
    assert.deepEqual(st.state.queue[key].need, ['tsa']);
    env.net.tsaFails = false;
    env.later(16 * MIN);
    await st.tick();
    await st.tick();
    assert.deepEqual(st.state.queue, {});
    await rec.close('book-a');
    await settle();
    await st.stop();
    const svcs = entries(env).filter((e) => e.kind === 'stamp').map((e) => e.svc);
    assert.ok(svcs.filter((s) => s === 'ots').length >= 1 && svcs.filter((s) => s === 'freetsa').length >= 1);
    assertChecks(env);
  });

  test('a signing key NEO hasn\'t seen: asked again with its certificate, which is kept', async () => {
    const env = setup();
    const rec = env.recorder();
    const st = env.stamper(rec, { certs: [] });
    rec.open(env.dir, 'book-a');
    env.type(rec, 'Words.');
    await rec.close('book-a');
    await settle();
    await st.tick();
    await st.stop();
    assert.equal(tsaCalls(env), 2, 'once without, once with certificates');
    assert.equal(st.certs.length, 1);
    const certs = fs.readdirSync(path.join(env.dir, slog.LOG_DIR, 'stamps', 'certs')).sort();
    assert.deepEqual(certs, [crypto.createHash('sha256').update(ROOT).digest('hex') + '.der', crypto.createHash('sha256').update(SIGNER).digest('hex') + '.der'].sort());
    assert.deepEqual(env.errors, []);
  });

  test('finished proofs are fetched hours later into a receipt file of their own', async () => {
    const env = setup();
    const rec = env.recorder();
    const st = env.stamper(rec);
    rec.open(env.dir, 'book-a');
    env.type(rec, 'Anchored words.');
    await rec.close('book-a');
    await settle();
    await st.tick();
    const before = fs.readdirSync(path.join(env.dir, slog.LOG_DIR, 'stamps')).filter((f) => f.endsWith('.stamps'));
    env.later(2 * 3600e3);
    await st.tick();
    assert.ok(!env.net.calls.some((c) => c.includes('/timestamp/')), 'not asked before three hours');
    env.later(1.5 * 3600e3);
    await st.tick();
    assert.equal(st.state.pending.length, 1, 'still pending at the calendars');
    env.net.finished = 917000;
    env.later(4 * 3600e3);
    await st.tick();
    assert.equal(st.state.pending.length, 0);
    await st.stop();
    const after = fs.readdirSync(path.join(env.dir, slog.LOG_DIR, 'stamps')).filter((f) => f.endsWith('.stamps'));
    assert.equal(after.length, before.length + 1);
    const close = entries(env).filter((e) => e.kind === 'close').pop();
    const done = readReceipts(env.dir).filter((r) => r.line.svc === 'ots' && r.line.n === close.n).map((r) => ots.check(ots.parse(new Uint8Array(Buffer.from(r.line.ots, 'base64'))), hashOf(close)));
    assert.equal(done.length, 2, 'the pending proof and the finished one');
    assert.deepEqual(done[1].bitcoin.map((b) => b.height), [917000, 917000]);
  });

  test('a receipt that doesn\'t verify is kept, and said so', async () => {
    const env = setup();
    env.clock = Date.UTC(2020, 0, 1); // before the test authority's certificates
    const rec = env.recorder();
    const st = env.stamper(rec);
    rec.open(env.dir, 'book-a');
    env.type(rec, 'Words.');
    await rec.close('book-a');
    await settle();
    await st.tick();
    await st.stop();
    assert.ok(env.errors.some((e) => /didn't verify: "Test TSA p256" wasn't valid at the token's time/.test(e)));
    assert.ok(readReceipts(env.dir).some((r) => r.line.svc === 'freetsa'));
  });

  test('a half-written last receipt line is set aside when read', () => {
    const env = setup();
    const dir = path.join(env.dir, slog.LOG_DIR, 'stamps');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '20261007T160000Z-0123abcd.stamps'), '{"svc":"ots","n":1}\n{"svc":"free');
    assert.deepEqual(readReceipts(env.dir).map((r) => r.line), [{ svc: 'ots', n: 1 }]);
  });
});
