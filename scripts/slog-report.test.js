'use strict';

// The verification report (slog-report.js): the numbers it draws from a
// checked log, with the words and without, and the page it makes at each
// privacy setting. Chains written with slog.js's Chain, as in
// slog-verify.test.js.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, test } = require('node:test');
const slog = require('../slog.js');
const V = require('../slog-verify.js');
const R = require('../slog-report.js');
const tsa = require('../stamp-tsa.js');
const fakes = require('./stamp-fakes.js');

const KEY = Buffer.alloc(32, 9);
const DEV_A = 'a'.repeat(32);
const DEV_B = 'b'.repeat(32);
const T0 = Date.UTC(2026, 9, 8, 16, 0, 0); // a Thursday; the test authority's certificates start Oct 7
const MIN = 60e3;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

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
      return c.add('open', { v: 2, log: 'feedfacefeedface', dev, prevChunk, app: '1.4.3+slog1' });
    },
    add(kind, fields = {}, ins = null) {
      const { entry, line } = chain.entry(kind, fields, ins);
      cur.lines.push(line);
      return entry;
    },
    edit(doc, src, ops, ins, more = {}) { return c.add('edit', { doc, src, ops: slog.recordOps(ops, ins), ...more }, ins); },
    base(doc, src, text, more = {}) { return c.add('base', { doc, src, ops: slog.recordOps([[0, 0, text.length]], [text]), ...more }, [text]); },
    close() { return c.add('close', { why: 'close', ms: '0'.repeat(64) }); }
  };
  return c;
}
function filesOf(chains, { words = true, receipts = {}, certs = [] } = {}) {
  const files = { 'log.json': JSON.stringify({ v: 1, logId: 'feedfacefeedface', ...(words ? { key: KEY.toString('base64') } : {}) }) };
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
async function statsOf(chains, opts = {}, more = {}) {
  const res = await V.checkLog(filesOf(chains, opts), more.check || {});
  assert.equal(res.ok, true, JSON.stringify([res.problems, res.devices.map((d) => d.problems)]));
  return { res, st: R.reportStats(res, more) };
}

const P1 = '<p>The lighthouse keeper counted the gulls each dawn.</p>';
const PASTE = '<p>A paragraph that came from somewhere outside the book.</p>';
const prose = (html) => html.replace(/<[^>]*>/g, '').length;
const BOOK = (order, more = {}) => JSON.stringify({ chapterOrder: order, chapterTitles: more.titles || {}, chapterKinds: more.kinds || {}, title: 'T' }, null, 2);

describe('slog-report: where the text came from', () => {
  test('counts with the words are the checker\'s, and the same without them for plain prose', async () => {
    const a = chainOf(DEV_A);
    a.open();
    a.base('book', 'baseline', BOOK(['ch-1']));
    a.add('doc', { doc: 'ch-1', act: 'new' });
    a.edit('ch-1', 'typed', [[0, 0, P1.length]], [P1]);
    a.edit('ch-1', 'paste', [[P1.length, 0, PASTE.length]], [PASTE]);
    a.close();
    const { res, st } = await statsOf([a]);
    assert.deepEqual(st.counts, { ...res.newest.made });
    assert.deepEqual(st.counts, { typed: prose(P1), paste: prose(PASTE) });
    assert.equal(st.total, prose(P1) + prose(PASTE));
    const bare = await statsOf([a], { words: false });
    assert.equal(bare.res.newest.made, null, 'the checker alone can\'t count without the words');
    assert.deepEqual(bare.st.counts, st.counts, 'the report can, from the ops\' markup lists');
    assert.equal(bare.st.words, false);
  });

  test('a paste with words put in or taken out inside it is "then revised"; at its edges it isn\'t', async () => {
    const a = chainOf(DEV_A);
    a.open();
    a.add('doc', { doc: 'ch-1', act: 'new' });
    a.add('doc', { doc: 'ch-2', act: 'new' });
    a.edit('ch-1', 'paste', [[0, 0, PASTE.length]], [PASTE]);
    a.edit('ch-2', 'paste', [[0, 0, PASTE.length]], [PASTE]);
    // ch-1: a word typed into the middle; ch-2: words typed after the end
    const mid = PASTE.indexOf('somewhere');
    a.edit('ch-1', 'typed', [[mid, 0, 4]], ['far ']);
    a.edit('ch-2', 'typed', [[PASTE.length - 4, 0, 5]], [' Yes.']);
    a.close();
    const { st } = await statsOf([a]);
    assert.deepEqual(st.counts, { 'paste revised': prose(PASTE), paste: prose(PASTE), typed: 9 });
    const ch = Object.fromEntries(st.chapters.map((c) => [c.doc, c.counts]));
    assert.deepEqual(ch['ch-1'], { 'paste revised': prose(PASTE), typed: 4 });
    assert.deepEqual(ch['ch-2'], { paste: prose(PASTE), typed: 5 });
    // a word deleted from inside counts too, and works without the words
    const b = chainOf(DEV_A);
    b.open();
    b.add('doc', { doc: 'ch-1', act: 'new' });
    b.edit('ch-1', 'paste', [[0, 0, PASTE.length]], [PASTE]);
    b.edit('ch-1', 'typed', [[PASTE.indexOf(' outside'), 8, 0]], ['']);
    b.close();
    for (const words of [true, false]) {
      const { st: s2 } = await statsOf([b], { words });
      assert.deepEqual(s2.counts, { 'paste revised': prose(PASTE) - 8 }, 'words ' + words);
      assert.equal(s2.deleted, 8);
    }
  });

  test('moved text keeps its origin and isn\'t a deletion; text sent to Darlings is, until it\'s back', async () => {
    const a = chainOf(DEV_A);
    a.open();
    a.add('doc', { doc: 'ch-1', act: 'new' });
    a.add('doc', { doc: 'ch-2', act: 'new' });
    a.edit('ch-1', 'typed', [[0, 0, P1.length]], [P1]);
    a.edit('ch-1', 'paste', [[P1.length, 0, PASTE.length]], [PASTE]);
    // the pasted paragraph moved to the front of the chapter in one entry
    a.edit('ch-1', 'move', [[P1.length, PASTE.length, 0], [0, 0, PASTE.length]], ['', PASTE], { from: [[1, 0, PASTE.length, { doc: 'ch-1', at: P1.length }]] });
    // …then carried to ch-2: inserted there first, deleted here after
    a.edit('ch-2', 'move', [[0, 0, PASTE.length]], [PASTE], { from: [[0, 0, PASTE.length, { doc: 'ch-1', at: 0 }]] });
    a.edit('ch-1', 'move', [[0, PASTE.length, 0]], ['']);
    a.close();
    const { st } = await statsOf([a]);
    assert.deepEqual(st.counts, { typed: prose(P1), paste: prose(PASTE) });
    assert.equal(st.moved, prose(PASTE));
    assert.equal(st.deleted, 0, 'moves aren\'t deletions');
    // to Darlings: a deletion; brought back: not
    const b = chainOf(DEV_A);
    b.open();
    b.add('doc', { doc: 'ch-1', act: 'new' });
    b.edit('ch-1', 'typed', [[0, 0, P1.length]], [P1]);
    b.edit('ch-1', 'paste', [[P1.length, 0, PASTE.length]], [PASTE]);
    const out = b.edit('ch-1', 'move', [[P1.length, PASTE.length, 0]], ['']);
    b.base('darlings', 'baseline', '[]');
    const j = JSON.stringify(PASTE);
    b.edit('darlings', 'move', [[1, 0, j.length]], [j], { from: [[0, 1, PASTE.length, { n: out.n, op: 0, at: 0 }]] });
    b.close();
    const sent = await statsOf([b]);
    assert.equal(sent.st.deleted, prose(PASTE));
    assert.deepEqual(sent.st.counts, { typed: prose(P1) });
    b.open();
    b.edit('darlings', 'move', [[1, j.length, 0]], ['']);
    b.edit('ch-1', 'move', [[P1.length, 0, PASTE.length]], [PASTE], { from: [[0, 0, PASTE.length, { n: out.n, op: 0, at: 0 }]] });
    b.close();
    const back = await statsOf([b]);
    assert.equal(back.st.deleted, 0);
    assert.deepEqual(back.st.counts, { typed: prose(P1), paste: prose(PASTE) });
  });

  test('chapters in the book\'s order with their titles, contents pages left out; by the manifest without the words', async () => {
    const a = chainOf(DEV_A);
    a.open();
    for (const id of ['ch-1', 'ch-2', 'ch-3', 'ch-x']) a.add('doc', { doc: id, act: 'new' });
    a.edit('ch-1', 'typed', [[0, 0, P1.length]], [P1]);
    a.edit('ch-2', 'typed', [[0, 0, P1.length]], [P1]);
    a.edit('ch-3', 'typed', [[0, 0, P1.length]], [P1]);
    a.edit('ch-x', 'typed', [[0, 0, P1.length]], [P1]); // a chapter file the book no longer lists
    a.base('book', 'baseline', BOOK(['ch-2', 'ch-3', 'ch-1'], { titles: { 'ch-2': 'Prologue' }, kinds: { 'ch-3': 'contents' } }));
    a.close();
    const { st } = await statsOf([a]);
    assert.deepEqual(st.chapters.map((c) => [c.doc, c.title, c.index]), [['ch-2', 'Prologue', 1], ['ch-1', null, 2]]);
    assert.equal(st.total, 2 * prose(P1));
    const bare = await statsOf([a], { words: false }, { manifest: { chapters: ['ch-2', 'ch-1'] } });
    assert.deepEqual(bare.st.chapters.map((c) => c.doc), ['ch-2', 'ch-1']);
    assert.equal(bare.st.total, 2 * prose(P1));
    const guessed = await statsOf([a], { words: false });
    assert.deepEqual(guessed.st.chapters.map((c) => c.doc), ['ch-1', 'ch-2', 'ch-3', 'ch-x'], 'in the order the log met them');
  });
});

describe('slog-report: time', () => {
  // three sessions over two days and a month boundary
  function written() {
    const a = chainOf(DEV_A, { start: Date.UTC(2026, 9, 30, 15, 0, 0) });
    a.open();
    a.add('doc', { doc: 'ch-1', act: 'new' });
    let text = '';
    const type = (s, dur = 1500) => { a.edit('ch-1', 'typed', [[text.length, 0, s.length]], [s], { dur, ev: s.length }); text += s; };
    type(P1);
    a.at(Date.UTC(2026, 9, 30, 15, 5, 0));
    type('<p>Two.</p>');
    a.at(Date.UTC(2026, 9, 30, 15, 40, 0)); // after a pause of over 10 minutes
    type('<p>Three.</p>');
    a.close();
    a.at(Date.UTC(2026, 10, 2, 9, 0, 0));
    a.open();
    a.edit('ch-1', 'typed', [[3, 4, 0]], ['']); // "The " deleted, in November
    a.close();
    // a session that only received another device's text isn't writing
    a.at(Date.UTC(2026, 10, 3, 9, 0, 0));
    a.open();
    a.edit('ch-1', 'arrived', [[text.length - 8, 0, 4]], ['!!!!']);
    a.close();
    return a;
  }

  test('sessions, writing time with long pauses left out, samples at every close, revision by month', async () => {
    const { st } = await statsOf([written()]);
    assert.equal(st.sessions.length, 2);
    const [s1, s2] = st.sessions;
    // 15:00:03 to 15:05:02.5, then 15:40:01 to 15:40:02.5
    assert.equal(s1.active, 5 * MIN - 2000 + 1500 + 1500);
    assert.equal(s1.added, prose(P1) + prose('<p>Two.</p>') + prose('<p>Three.</p>'));
    assert.equal(s2.removed, 4);
    assert.equal(st.samples.length, 3);
    const all = prose(P1) + 10;
    assert.deepEqual(st.samples.map((p) => p.total), [all, all - 4, all - 4 + 4], 'the arrived text counts in the manuscript, not as writing');
    assert.equal(st.deleted, 4);
    assert.deepEqual(Object.values(st.deletedByHour), [4]);
    assert.equal(+Object.keys(st.deletedByHour)[0], Math.floor(Date.UTC(2026, 10, 2, 9, 0, 1) / 3600e3));
  });

  test('the page at each privacy setting shows times no finer than it should', async () => {
    const { st } = await statsOf([written()]);
    const tz = 'America/Los_Angeles';
    const exact = R.renderReport(st, { privacy: 'exact', tz, generated: T0 });
    const dates = R.renderReport(st, { privacy: 'dates', tz, generated: T0 });
    const weeks = R.renderReport(st, { privacy: 'weeks', tz, generated: T0 });
    // 15:00 UTC on Oct 30 is 8:00 AM in Los Angeles
    assert.match(exact, /Oct 30, 2026, 8:00\s?AM/);
    assert.match(exact, /Times are shown exactly, in America\/Los_Angeles/);
    for (const html of [dates, weeks]) {
      assert.doesNotMatch(html.replace(/<script>[\s\S]*?<\/script>/g, ''), /\d:\d\d\s?[AP]M/, 'no time of day');
    }
    assert.match(dates, /Oct 30, 2026/);
    assert.match(weeks, /week of Oct 26, 2026/);
    assert.match(weeks, /week of Nov 2, 2026/);
    assert.doesNotMatch(weeks, /Oct 30, 2026|Nov 3, 2026/, 'no single days');
    for (const html of [exact, dates, weeks]) {
      assert.doesNotMatch(html, /prove[sd]? (you|that you) wrote/i);
      assert.match(html, /<svg/);
    }
  });
});

describe('slog-report: the page', () => {
  test('escapes the book\'s own words and runs in a bare context, as the verifier will', async () => {
    const a = chainOf(DEV_A);
    a.open();
    a.add('doc', { doc: 'ch-1', act: 'new' });
    a.edit('ch-1', 'typed', [[0, 0, P1.length]], [P1]);
    a.base('book', 'baseline', BOOK(['ch-1'], { titles: { 'ch-1': '<img src=x onerror=alert(1)>' } }));
    a.close();
    const files = filesOf([a]);
    const ctx = vm.createContext({ crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array, DataView, Promise, console, Intl, Date, Math, JSON });
    for (const f of ['slog-hash.js', 'slog-zip.js', 'stamp-tsa.js', 'stamp-ots.js', 'slog-verify.js', 'slog-report.js']) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
    }
    ctx.files = files;
    const html = await vm.runInContext(`SlogVerify.checkLog(files).then((res) => SlogReport.renderReport(SlogReport.reportStats(res, { meta: { title: 'A <b>Book</b>', author: 'Pen & Name' } }), { privacy: 'dates', tz: 'UTC' }))`, ctx);
    assert.match(html, /A &lt;b&gt;Book&lt;\/b&gt;/);
    assert.match(html, /by Pen &amp; Name/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /<img/);
    assert.equal((html.match(/<script>/g) || []).length, 1, 'only the page\'s own hover script');
  });

  test('timestamps: what\'s stamped, what\'s left to the computer\'s clock, and clock flags', async () => {
    const a = chainOf(DEV_A);
    a.open();
    a.add('doc', { doc: 'ch-1', act: 'new' });
    const e = a.edit('ch-1', 'typed', [[0, 0, P1.length]], [P1]);
    const h = slog.entryHash(e);
    const req = tsa.request(new Uint8Array(Buffer.from(h, 'hex')));
    const token = tsa.parseResponse(new Uint8Array(fakes.tokenFor(req.der, e.ts + 2000))).token;
    a.add('stamp', { svc: 'freetsa', of: e.n, t: tsa.parseToken(token).tst.time, r: sha(token) });
    a.add('clock', { jump: -10 * MIN });
    a.edit('ch-1', 'typed', [[P1.length, 0, 11]], ['<p>Two.</p>']);
    a.close();
    const line = { svc: 'freetsa', dev: DEV_A, n: e.n, h, ts: e.ts + 1000, tsr: Buffer.from(token).toString('base64') };
    const res = await V.checkLog(filesOf([a], { receipts: { '20261008T160000Z-aaaaaaaa.stamps': [line] } }), { anchors: [fakes.ROOT], certs: [fakes.SIGNER] });
    const st = R.reportStats(res);
    assert.equal(st.receipts.total, 1);
    assert.deepEqual(st.receipts.bySvc, { freetsa: { ok: 1 } });
    assert.equal(st.receipts.stamped, 1);
    assert.equal(st.receipts.tails.length, 1, 'the writing after it is dated by the computer only');
    assert.equal(st.flags.clock.length, 1);
    assert.equal(st.flags.clock[0].kind, 'back');
    const html = R.renderReport(st, { privacy: 'exact', tz: 'UTC' });
    assert.match(html, /FreeTSA: 1 checked/);
    assert.match(html, /dated only by the computer&#39;s clock/);
    assert.match(html, /the clock went back 10 min/);
  });

  test('two devices: text that arrived is traced, and its deletions counted once', async () => {
    const a = chainOf(DEV_A);
    a.open();
    a.add('doc', { doc: 'ch-1', act: 'new' });
    const t1 = a.edit('ch-1', 'typed', [[0, 0, P1.length]], [P1]);
    a.close();
    const b = chainOf(DEV_B, { start: T0 + 3600e3 });
    b.open();
    b.base('ch-1', 'arrived', P1, { from: [[0, 0, P1.length, { dev: DEV_A, n: t1.n, doc: 'ch-1', at: 0 }]] });
    b.edit('ch-1', 'typed', [[3, 4, 0]], ['']);
    b.close();
    const a2 = a.at(T0 + 2 * 3600e3);
    a2.open();
    a2.edit('ch-1', 'arrived', [[3, 4, 0]], ['']);
    a2.close();
    const { st } = await statsOf([a, b]);
    assert.deepEqual(st.counts, { typed: prose(P1) - 4 });
    assert.equal(st.deleted, 4, 'B\'s deletion, not again when it arrived on A');
    assert.deepEqual(st.devices.map((d) => d.name), ['Device 1', 'Device 2']);
    assert.equal(st.sessions.length, 2);
  });
});
