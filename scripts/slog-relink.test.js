'use strict';

// Origin tracing before an export or a report (slog-relink.js), and the
// `relink` entries it writes, as every checker reads them (slog-verify.js):
// words whose origin the log couldn't place as they were written, matched
// to earlier writing in the book, earliest writing first, typography aside.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');
const slog = require('../slog.js');
const V = require('../slog-verify.js');
const RL = require('../slog-relink.js');
const R = require('../slog-report.js');

const KEY = Buffer.alloc(32, 9);
const DEV_A = 'a'.repeat(32);
const DEV_B = 'b'.repeat(32);
const T0 = Date.UTC(2026, 9, 8, 16, 0, 0);
const HOUR = 3600e3;

// One device's chain, an hour between entries, so each entry is its own hour
function chainOf(dev, { start = T0 } = {}) {
  let clock = start;
  const chain = new slog.Chain({ dev, key: KEY, now: () => (clock += HOUR) });
  const chunks = [];
  let cur = null;
  const docs = {};
  const c = {
    dev, chain, chunks, docs,
    open() {
      const prevChunk = chunks.length ? chunks[chunks.length - 1].name : null;
      cur = { name: slog.chunkName(clock, dev, chunks.length + 1), lines: [] };
      chunks.push(cur);
      return c.add('open', { v: 3, log: 'feedfacefeedface', dev, prevChunk, app: 'test' });
    },
    add(kind, fields = {}, ins = null) {
      const { entry, line } = chain.entry(kind, fields, ins);
      cur.lines.push(line);
      return entry;
    },
    doc(doc) { docs[doc] = ''; return c.add('doc', { doc, act: 'new' }); },
    // the document's text set to `text`, as one edit (the diff NEO uses)
    set(doc, text, src = 'typed', more = {}) {
      const { ops, ins } = slog.diff(docs[doc], text);
      docs[doc] = text;
      return c.add('edit', { doc, src, ops: slog.recordOps(ops, ins), ...more }, ins);
    },
    close() { return c.add('close', { why: 'close', ms: '0'.repeat(64) }); },
    entries: () => chunks.flatMap((k) => k.lines.map((l) => JSON.parse(l)))
  };
  return c;
}
const filesOf = (chains, { words = true } = {}) => {
  const files = { 'log.json': JSON.stringify({ v: 1, logId: 'feedfacefeedface', ...(words ? { key: KEY.toString('base64') } : {}) }) };
  for (const c of chains) {
    for (const k of c.chunks) {
      const lines = words ? k.lines : k.lines.map((l) => { const { x, ...clear } = JSON.parse(l); return JSON.stringify(clear); });
      files[k.name] = lines.join('\n') + '\n';
    }
  }
  return files;
};
const logOf = (chains) => V.readLog(V.logPaths(filesOf(chains)));
// the scan, its finds written into the chain they were made on (`me`)
function scanInto(me, chains) {
  const { relinks, skipped } = RL.scanLog(logOf(chains));
  assert.equal(skipped, null);
  if (!relinks.length) return relinks;
  me.open();
  for (const r of relinks) me.add('relink', r.dev && r.dev !== me.dev ? { of: r.of, dev: r.dev, from: r.from } : { of: r.of, from: r.from });
  me.close();
  return relinks;
}
// each stretch of `needle` in `doc` on device `dev`, by its origin
async function originsOf(chains, dev, doc, needle, { words = true } = {}) {
  const res = await V.checkLog(filesOf(chains, { words }));
  const d = res.devices.find((x) => x.dev === dev);
  assert.deepEqual(d.problems, [], 'no problems');
  const t = d.traced[doc];
  const at = t.text === null ? 0 : t.text.indexOf(needle);
  assert.ok(at >= 0, `"${needle}" is in ${doc}`);
  return [...new Set(V.originsAt(t, at, needle.length).map(([, o]) => o))];
}
const statsOf = async (chains) => R.reportStats(await V.checkLog(filesOf(chains)));

const TYPED = 'The lighthouse keeper counted the gulls each dawn, and wrote the number down.';
const P = (s) => '<p>' + s + '</p>';

describe('the scan: words placed by earlier writing', () => {
  test('typed, cut, pasted back from Word with curly quotes and single spaces: typed', async () => {
    const a = chainOf(DEV_A);
    a.open();
    a.doc('ch-1');
    const said = '"Seventeen," she said.  Then she slept.';
    a.set('ch-1', P(TYPED + ' ' + said));
    a.set('ch-1', '');
    a.close();
    a.open();
    const back = TYPED + ' “Seventeen,” she said. Then she slept.';
    a.set('ch-1', P(back), 'paste');
    a.close();
    assert.deepEqual(await originsOf([a], DEV_A, 'ch-1', back), ['paste']);
    const found = scanInto(a, [a]);
    assert.equal(found.length, 1);
    assert.deepEqual(await originsOf([a], DEV_A, 'ch-1', back), ['typed']);
    // a log without its words checks the same pieces by their lengths
    assert.deepEqual(await originsOf([a], DEV_A, 'ch-1', back.slice(0, 20), { words: false }), ['typed']);
    // and the report counts them as typed, and as matched
    const s = await statsOf([a]);
    assert.equal(s.counts.paste || 0, 0);
    assert.ok(s.relinked >= back.length - 2);
    assert.equal(s.gap, 0);
  });

  test('a short stretch beside words the Recorder placed is filled from the same match', async () => {
    const a = chainOf(DEV_A);
    a.open();
    a.doc('ch-1');
    const plain = '"Seventeen gulls today," said the keeper, and closed the ledger.';
    a.set('ch-1', P(plain));
    const cut = a.set('ch-1', '');
    // pasted back with curly quotes; the Recorder's exact match found only
    // the stretch between them
    const curly = '\u201cSeventeen gulls today,\u201d said the keeper, and closed the ledger.';
    const mid = 'Seventeen gulls today,';
    const at = P(curly).indexOf(mid);
    a.set('ch-1', P(curly), 'paste', { from: [[0, at, mid.length, { n: cut.n, op: 0, at: P(plain).indexOf(mid) }]] });
    a.close();
    assert.deepEqual(await originsOf([a], DEV_A, 'ch-1', '\u201cSeventeen'), ['paste', 'typed']);
    scanInto(a, [a]);
    assert.deepEqual(await originsOf([a], DEV_A, 'ch-1', curly), ['typed']);
  });

  test('a paste nothing in the book holds stays pasted, and nothing is written', () => {
    const a = chainOf(DEV_A);
    a.open();
    a.doc('ch-1');
    a.set('ch-1', P(TYPED));
    a.set('ch-1', P(TYPED + ' A paragraph that came from somewhere outside the book entirely.'), 'paste');
    a.close();
    assert.deepEqual(RL.scanLog(logOf([a])).relinks, []);
  });

  test('a paste that matches an earlier paste gains nothing: nothing is written', () => {
    const a = chainOf(DEV_A);
    a.open();
    a.doc('ch-1');
    const outside = 'A paragraph that came from somewhere outside the book entirely.';
    a.set('ch-1', P(outside), 'paste');
    a.set('ch-1', '');
    a.set('ch-1', P(outside), 'paste');
    a.close();
    assert.deepEqual(RL.scanLog(logOf([a])).relinks, []);
  });

  test('a paste is never placed by writing that came after it', async () => {
    const a = chainOf(DEV_A);
    a.open();
    a.doc('ch-1');
    a.doc('notes');
    a.set('ch-1', P(TYPED), 'paste');
    a.set('notes', P(TYPED));
    a.close();
    assert.deepEqual(RL.scanLog(logOf([a])).relinks, []);
    assert.deepEqual(await originsOf([a], DEV_A, 'ch-1', TYPED), ['paste']);
  });

  test('typed in Notes, then changed in the chapter while the log was off: typed, and the gap stays visible', async () => {
    const a = chainOf(DEV_A);
    a.open();
    a.doc('ch-1');
    a.doc('notes');
    a.set('notes', P(TYPED));
    a.set('ch-1', P('Chapter one begins.'));
    a.add('off');
    a.close();
    a.open();
    a.add('on');
    a.set('ch-1', P('Chapter one begins.') + P(TYPED), 'unlogged', { cause: 'off' });
    a.close();
    assert.deepEqual(await originsOf([a], DEV_A, 'ch-1', TYPED), ['while off']);
    scanInto(a, [a]);
    assert.deepEqual(await originsOf([a], DEV_A, 'ch-1', TYPED), ['typed']);
    const s = await statsOf([a]);
    assert.equal(s.counts['while off'] || 0, 0);
    assert.equal(s.gap, TYPED.length);
  });

  test('a move whose place wasn\'t recorded, its words cut in an earlier session: typed', async () => {
    const a = chainOf(DEV_A);
    a.open();
    a.doc('ch-1');
    a.doc('ch-2');
    a.set('ch-1', P(TYPED));
    a.set('ch-1', '');
    a.close();
    a.open();
    a.set('ch-2', P(TYPED), 'move');
    a.close();
    assert.deepEqual(await originsOf([a], DEV_A, 'ch-2', TYPED), ['move']);
    scanInto(a, [a]);
    assert.deepEqual(await originsOf([a], DEV_A, 'ch-2', TYPED), ['typed']);
  });

  test('an editor\'s changes in a pasted version: the writer\'s stretches typed, the changed words pasted', async () => {
    const a = chainOf(DEV_A);
    a.open();
    a.doc('ch-1');
    const one = 'The lighthouse keeper counted the gulls each dawn without fail';
    const two = 'and wrote the number down in a ledger bound in green cloth';
    a.set('ch-1', P(one + ', ' + two + '.'));
    a.set('ch-1', '');
    const edited = one + '; then, carefully, ' + two + '.';
    a.set('ch-1', P(edited), 'paste');
    a.close();
    scanInto(a, [a]);
    assert.deepEqual(await originsOf([a], DEV_A, 'ch-1', one), ['typed']);
    assert.deepEqual(await originsOf([a], DEV_A, 'ch-1', 'then, carefully'), ['paste']);
    assert.deepEqual(await originsOf([a], DEV_A, 'ch-1', two), ['typed']);
  });

  test('a stretch under 20 characters between an editor\'s changes stays pasted', async () => {
    const a = chainOf(DEV_A);
    a.open();
    a.doc('ch-1');
    a.set('ch-1', P('Ann waved, Bob nodded, Cal left, Dee sat.'));
    a.set('ch-1', '');
    a.set('ch-1', P('Ann waved, Bob nods, Cal goes, Dee sat.'), 'paste');
    a.close();
    assert.deepEqual(RL.scanLog(logOf([a])).relinks, []);
  });

  test('earliest wins: words matching an earlier paste and later typing are pasted', async () => {
    const a = chainOf(DEV_A);
    a.open();
    a.doc('ch-1');
    a.doc('notes');
    a.doc('ch-2');
    a.set('notes', P(TYPED), 'paste');
    a.set('ch-2', P(TYPED + ' And more.'));
    a.set('ch-1', P(TYPED), 'unlogged');
    a.close();
    const { relinks } = RL.scanLog(logOf([a]));
    assert.equal(relinks.length, 1);
    assert.ok(relinks[0].from.every((p) => p[3].doc === 'notes'), 'placed by the earlier paste');
    scanInto(a, [a]);
    assert.deepEqual(await originsOf([a], DEV_A, 'ch-1', TYPED), ['paste']);
  });

  test('a second scan finds nothing new', () => {
    const a = chainOf(DEV_A);
    a.open();
    a.doc('ch-1');
    a.set('ch-1', P(TYPED));
    a.set('ch-1', '');
    a.set('ch-1', P(TYPED), 'paste');
    a.close();
    assert.equal(scanInto(a, [a]).length, 1);
    assert.deepEqual(RL.scanLog(logOf([a])).relinks, []);
  });

  test('another computer\'s paste, placed by text that arrived from this one', async () => {
    const a = chainOf(DEV_A);
    const b = chainOf(DEV_B, { start: T0 + 30 * 60e3 });
    a.open();
    a.doc('ch-1');
    const w = a.set('ch-1', P(TYPED));
    a.close();
    b.open();
    b.add('base', { doc: 'ch-1', src: 'arrived', ops: slog.recordOps([[0, 0, P(TYPED).length]], [P(TYPED)]), from: [[0, 0, P(TYPED).length, { dev: DEV_A, n: w.n, doc: 'ch-1', at: 0 }]] }, [P(TYPED)]);
    b.docs['ch-1'] = P(TYPED);
    b.doc('ch-2');
    b.set('ch-2', P(TYPED), 'paste');
    b.close();
    const { relinks } = RL.scanLog(logOf([a, b]));
    assert.equal(relinks.length, 1);
    assert.equal(relinks[0].dev, DEV_B);
    // written on A's chain, naming B's edit
    scanInto(a, [a, b]);
    assert.deepEqual(await originsOf([a, b], DEV_B, 'ch-2', TYPED), ['typed']);
  });
});

describe('relink entries, checked', () => {
  // a chain with a typed paragraph cut, then pasted back: entry numbers known
  function roundTrip() {
    const a = chainOf(DEV_A);
    a.open();
    a.doc('ch-1');
    const typed = a.set('ch-1', P(TYPED));
    const cut = a.set('ch-1', '');
    const paste = a.set('ch-1', P(TYPED), 'paste');
    return { a, typed, cut, paste, len: P(TYPED).length };
  }
  const problemsOf = async (chains, dev = DEV_A) => (await V.checkLog(filesOf(chains))).devices.find((d) => d.dev === dev).problems.map((p) => p.problem);

  test('a relink on typed text is a problem: recorded origins are never changed', async () => {
    const { a, typed, cut, len } = roundTrip();
    a.add('relink', { of: typed.n, from: [[0, 0, len, { n: cut.n, op: 0, at: 0 }]] });
    a.close();
    assert.ok((await problemsOf([a])).includes('relink on text whose origin was recorded'));
  });

  test('a relink can\'t point at itself or later', async () => {
    const { a, cut, len } = roundTrip();
    const r = a.add('relink', { of: 99, from: [[0, 0, len, { n: cut.n, op: 0, at: 0 }]] });
    a.close();
    assert.ok((await problemsOf([a])).includes('relink points ahead of itself'), 'of ' + r.of);
  });

  test('a relink whose words don\'t match where it says they came from is a problem (with the words)', async () => {
    const { a, paste } = roundTrip();
    a.doc('notes');
    a.set('notes', P('Something else entirely, written later in the notes.'));
    a.add('relink', { of: paste.n, from: [[0, 3, 20, { doc: 'ch-1', at: 0 }]] });
    a.close();
    const problems = await problemsOf([a]);
    assert.ok(problems.some((p) => /^relink: /.test(p)), problems.join('; '));
  });

  test('pieces over units already placed are passed over, quietly', async () => {
    const { a, paste, cut, len } = roundTrip();
    a.add('relink', { of: paste.n, from: [[0, 0, len, { n: cut.n, op: 0, at: 0 }]] });
    a.add('relink', { of: paste.n, from: [[0, 0, len, { n: cut.n, op: 0, at: 0 }]] });
    a.close();
    assert.deepEqual(await problemsOf([a]), []);
    assert.deepEqual(await originsOf([a], DEV_A, 'ch-1', TYPED), ['typed']);
  });

  test('a relink naming an entry the chain doesn\'t have is a problem', async () => {
    const a = chainOf(DEV_A);
    a.open();
    a.doc('ch-1');
    a.set('ch-1', P(TYPED));
    a.add('relink', { dev: DEV_B, of: 3, from: [[0, 0, 5, { doc: 'ch-1', at: 0 }]] });
    a.close();
    assert.ok((await problemsOf([a])).includes('relink names a device whose log isn\'t here'));
  });

  test('older chunk formats still read, and v3 is accepted', async () => {
    const { a, paste, cut, len } = roundTrip();
    a.add('relink', { of: paste.n, from: [[0, 0, len, { n: cut.n, op: 0, at: 0 }]] });
    a.close();
    const res = await V.checkLog(filesOf([a]));
    assert.equal(res.ok, true);
  });
});

describe('the Recorder writes relinks', () => {
  test('into the chunk being written, naming another device only when it isn\'t this one', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-relink-home-'));
    const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-relink-lib-'));
    const dir = path.join(lib, 'book-x');
    fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify({ id: 'x', title: 'X', chapterOrder: ['c1'] }));
    try {
      // cut in one run of NEO…
      const first = new slog.Recorder({ home, app: 'test' });
      first.open(dir, 'x');
      first.observe(dir, 'x', 'c1', P(TYPED), { src: 'typed' });
      first.observe(dir, 'x', 'c1', '', { src: 'typed' });
      await first.close('x');
      // …pasted back from outside in the next, so nothing remembers the cut
      const rec = new slog.Recorder({ home, app: 'test' });
      rec.open(dir, 'x');
      rec.observe(dir, 'x', 'c1', P(TYPED), { src: 'paste' });
      await rec.head(dir, 'x');
      const st = rec.status(dir, 'x');
      // (as main.js asks it: in the History helper, which reads the folder)
      const asked = require('../slog-history-worker.js').reply({ id: 1, type: 'scan', home: path.join(home, 'history'), dir, budget: 45000 });
      assert.equal(asked.ok, true, asked.error);
      const { relinks, cut } = asked.value;
      assert.equal(cut, false);
      assert.equal(relinks.length, 1);
      assert.equal(rec.relink(dir, 'x', relinks), 1);
      // a relink pointing past the chain isn't written
      assert.equal(rec.relink(dir, 'x', [{ of: st.n + 50, from: relinks[0].from }]), 0);
      await rec.close('x');
      const res = await V.checkLog(require('../slog-files.js').loadLog(dir));
      assert.equal(res.ok, true, JSON.stringify(res.devices.map((d) => d.problems)));
      const d = res.devices[0];
      assert.equal(d.kinds.relink, 1);
      const open = d.entries.find((e) => e.kind === 'open');
      assert.equal(open.v, 3);
      const t = d.traced[slog.chapterDoc('c1')];
      assert.deepEqual([...new Set(V.originsAt(t, t.text.indexOf(TYPED), TYPED.length).map(([, o]) => o))], ['typed']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(lib, { recursive: true, force: true });
    }
  });
});

describe('looseOf: typography aside', () => {
  test('quotes, dashes, spaces and ellipses read alike; the raw places are kept', () => {
    const a = V.looseOf('“Wait—no.”  She’s gone…');
    const b = V.looseOf('"Wait--no." She\'s gone...');
    assert.equal(a.text, b.text);
    assert.equal(a.at.length, a.text.length + 1);
    assert.equal(b.at[b.at.length - 1], '"Wait--no." She\'s gone...'.length);
    assert.equal(V.sameLoose('a  b', 'a b'), true);
    assert.equal(V.sameLoose('one word', 'another word'), false);
  });
});
