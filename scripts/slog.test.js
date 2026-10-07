'use strict';

// The Scribe's Log core (slog.js): hashing, diffs, the chain, chunks on
// disk, checking and replay. Plain functions, so no Electron here.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');
const slog = require('../slog.js');

// a small seeded random, so a failure can be run again
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const PIECES = ['the ', 'dark ', 'and ', 'she ', 'said, ', '“No.” ', '<p>', '</p>', '<i>', '</i>', 'é', 'é', '😀', ' ', '&nbsp;', 'x', 'q', '\n'];
function words(r, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += PIECES[Math.floor(r() * PIECES.length)];
  return s;
}
// edit a text in a few random places
function mutate(r, s) {
  let out = s;
  const edits = 1 + Math.floor(r() * 4);
  for (let i = 0; i < edits; i++) {
    // on letter boundaries: an emoji is two UTF-16 units and stays whole
    const lowAt = (i) => /[\udc00-\udfff]/.test(out[i] || '');
    let at = Math.floor(r() * (out.length + 1));
    if (lowAt(at)) at--;
    let del = Math.min(out.length - at, Math.floor(r() * 12));
    if (lowAt(at + del)) del++;
    out = out.slice(0, at) + (r() < 0.7 ? words(r, Math.floor(r() * 6)) : '') + out.slice(at + del);
  }
  return out;
}
const hasLoneSurrogate = (s) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

const KEY = Buffer.alloc(32, 7);
const DEV = 'aa11bb22cc33dd44ee55ff6600778899';

// a small book's chain: two sessions, the second a fresh chunk
function sampleChain() {
  let clock = Date.UTC(2026, 9, 7, 16, 0, 0);
  const chain = new slog.Chain({ dev: DEV, key: KEY, now: () => (clock += 1000) });
  const chunks = [];
  let doc = '';
  const session = (prevChunk, steps) => {
    const name = slog.chunkName(clock, DEV, 1 + chunks.length);
    const entries = [chain.entry('open', { v: slog.FORMAT, log: 'log1', dev: DEV, prevChunk, app: 'test' }).entry];
    for (const next of steps) {
      if (doc === '' && entries.length === 1 && !chunks.length) {
        entries.push(chain.entry('doc', { doc: 'ch-1', act: 'new' }).entry);
      }
      const { ops, ins } = slog.diff(doc, next);
      entries.push(chain.entry('edit', { doc: 'ch-1', src: 'typed', dur: 900, ev: 5, ops: slog.recordOps(ops, ins) }, ins).entry);
      doc = next;
    }
    entries.push(chain.entry('close', { why: 'close', ms: slog.manuscriptHash(doc) }).entry);
    chunks.push({ name, entries });
    return name;
  };
  const first = session(null, ['<p>It was</p>', '<p>It was dark.</p>', '<p>It was very dark.</p>']);
  session(first, ['<p>It was very dark.</p><p>She ran.</p>', '<p>It was dark.</p><p>She ran.</p>']);
  return { chunks, doc };
}
const clone = (x) => JSON.parse(JSON.stringify(x));

describe('canonical JSON', () => {
  test('sorts keys at every level and drops undefined', () => {
    assert.equal(slog.canonical({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' }, u: undefined }), '{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}');
  });
  test('whole numbers only', () => {
    assert.throws(() => slog.canonical({ a: 1.5 }));
    assert.throws(() => slog.canonical({ a: NaN }));
    assert.equal(slog.canonical(-0), '0');
  });
  test('the entry hash ignores the words', () => {
    const e = { kind: 'edit', n: 1, prev: null, ts: 1, c: 'ab', x: { ins: ['secret'] } };
    assert.equal(slog.entryHash(e), slog.entryHash(slog.clearPart(e)));
  });
});

describe('diff', () => {
  test('rebuilds the new text exactly, across 3,000 random edits', () => {
    const r = rng(1);
    let a = words(r, 200);
    for (let i = 0; i < 3000; i++) {
      const b = mutate(r, a);
      const { ops, ins } = slog.diff(a, b);
      assert.equal(slog.applyOps(a, ops, ins), b, `seed 1, step ${i}`);
      assert.equal(slog.applyLengths(a.length, ops), b.length);
      for (const s of ins) assert.ok(!hasLoneSurrogate(s), 'an inserted string splits an emoji');
      a = b;
    }
  });
  test('no change, no ops', () => {
    assert.deepEqual(slog.diff('same', 'same'), { ops: [], ins: [] });
  });
  test('two edits far apart stay two edits', () => {
    const middle = 'and the long untouched stretch between them goes on for a while, '.repeat(20);
    const a = '<p>It was dark. ' + middle + 'She ran.</p>';
    const b = '<p>It was very dark. ' + middle + 'She ran home.</p>';
    const { ops, ins } = slog.diff(a, b);
    assert.deepEqual(ins, ['very ', ' home']);
    assert.equal(ops.length, 2);
    assert.ok(ops.every((op) => op[1] === 0), 'nothing in between counts as deleted');
  });
  test('one letter added is one letter', () => {
    const { ops, ins } = slog.diff('the cat sat', 'the cats sat');
    assert.deepEqual(ops, [[7, 0, 1]]);
    assert.deepEqual(ins, ['s']);
  });
  test('an emoji is never split', () => {
    const { ins } = slog.diff('a😀b', 'a😃b');
    assert.ok(!ins.some(hasLoneSurrogate));
  });
  test('a rewrite too big to compare word by word is one replacement', () => {
    const r = rng(9);
    const a = words(r, 3000);
    const b = words(r, 3000);
    const { ops, ins } = slog.diff(a, b);
    assert.equal(slog.applyOps(a, ops, ins), b);
  });
  test('markup inside an insertion is listed', () => {
    assert.deepEqual(slog.markupRanges('<p>Hi <i>there</i></p>'), [[0, 3], [6, 3], [14, 4], [18, 4]]);
    const { ops, ins } = slog.diff('<p>A</p>', '<p>A</p><p>B</p>');
    assert.deepEqual(slog.recordOps(ops, ins), [[8, 0, 8, [[0, 3], [4, 4]]]]);
  });
  test('ops that don\'t fit are refused', () => {
    assert.throws(() => slog.applyOps('abc', [[2, 5, 0]], ['']));
    assert.throws(() => slog.applyOps('abc', [[0, 0, 3]], ['ab']));
  });
});

describe('commitments', () => {
  test('the same words commit differently in different entries', () => {
    assert.notEqual(slog.commitment(KEY, DEV, 1, ['the']), slog.commitment(KEY, DEV, 2, ['the']));
    assert.equal(slog.commitment(KEY, DEV, 1, ['the']), slog.commitment(KEY, DEV, 1, ['the']));
  });
  test('a log id and key are fresh every time', () => {
    const a = slog.newLogInfo();
    const b = slog.newLogInfo();
    assert.notEqual(a.key, b.key);
    assert.equal(Buffer.from(a.key, 'base64').length, 32);
    assert.match(slog.newDeviceId(), /^[0-9a-f]{32}$/);
  });
});

describe('manuscript hash', () => {
  test('same book, however its spaces and accents are stored', () => {
    const composed = 'Café  noir.\n\nShe ran. ';
    const decomposed = ' Café noir. She ran.';
    assert.equal(slog.manuscriptHash(composed), slog.manuscriptHash(decomposed));
    assert.notEqual(slog.manuscriptHash('She ran.'), slog.manuscriptHash('She ran!'));
  });
});

describe('chain', () => {
  test('an untouched log checks out, with and without its words', () => {
    const { chunks } = sampleChain();
    const full = slog.verifyChain(chunks, { key: KEY });
    assert.deepEqual(full.problems, []);
    assert.equal(full.ok, true);
    const bare = clone(chunks);
    for (const c of bare) for (const e of c.entries) delete e.x;
    assert.equal(slog.verifyChain(bare).ok, true);
    assert.equal(slog.verifyChain(bare).head, full.head);
  });
  test('changing an old entry breaks the chain', () => {
    const { chunks } = sampleChain();
    const bad = clone(chunks);
    bad[0].entries[2].ts += 60000;
    const v = slog.verifyChain(bad, { key: KEY });
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p) => p.n === 4 && /link/.test(p.problem)), 'the entry after it no longer links');
  });
  test('dropping an entry breaks the chain', () => {
    const { chunks } = sampleChain();
    const bad = clone(chunks);
    bad[0].entries.splice(2, 1);
    assert.equal(slog.verifyChain(bad).ok, false);
  });
  test('changing the words is caught by the commitment', () => {
    const { chunks } = sampleChain();
    const bad = clone(chunks);
    const e = bad[0].entries.find((x) => x.x);
    e.x.ins[0] = e.x.ins[0].replace(/.$/, '!');
    const v = slog.verifyChain(bad, { key: KEY });
    assert.ok(v.problems.some((p) => /commitment/.test(p.problem)));
  });
  test('chunks are ordered by their links, not their names', () => {
    const { chunks } = sampleChain();
    const swapped = clone(chunks).reverse();
    assert.equal(slog.verifyChain(swapped, { key: KEY }).ok, true);
  });
  test('a missing chunk or a fork is reported', () => {
    const { chunks } = sampleChain();
    assert.equal(slog.verifyChain([chunks[1]]).ok, false);
    const fork = clone(chunks);
    fork.push({ ...clone(chunks[1]), name: slog.chunkName(Date.UTC(2026, 9, 8), DEV, 3) });
    assert.ok(slog.verifyChain(fork).problems.some((p) => /fork/.test(p.problem)));
  });
  test('a chunk whose only write was cut short is a note, not damage', () => {
    const { chunks } = sampleChain();
    const withEmpty = [...clone(chunks), { name: slog.chunkName(Date.UTC(2026, 9, 9), DEV), ...slog.parseChunk('{"kind":"op') }];
    const v = slog.verifyChain(withEmpty, { key: KEY });
    assert.equal(v.ok, true);
    assert.ok(v.notes.some((n) => /cut short/.test(n.note)));
  });
  test('the caller can\'t set an entry\'s number, link or time', () => {
    const chain = new slog.Chain({ dev: DEV, key: KEY, now: () => 5 });
    const { entry } = chain.entry('on', { n: 99, prev: 'x', ts: 1, kind: 'close' });
    assert.deepEqual([entry.kind, entry.n, entry.prev, entry.ts], ['on', 1, null, 5]);
  });
  test('a session that never closed is a note, not damage', () => {
    const { chunks } = sampleChain();
    const open = clone(chunks);
    open[1].entries.pop();
    const v = slog.verifyChain(open, { key: KEY });
    assert.equal(v.ok, true);
    assert.ok(v.notes.some((n) => /without closing/.test(n.note)));
  });
});

describe('replay', () => {
  test('ends in exactly the last text', () => {
    const { chunks, doc } = sampleChain();
    const r = slog.replay(chunks.flatMap((c) => c.entries));
    assert.deepEqual(r.problems, []);
    assert.equal(r.docs['ch-1'], doc);
  });
  test('without the words, lengths still add up', () => {
    const { chunks, doc } = sampleChain();
    const bare = clone(chunks.flatMap((c) => c.entries));
    for (const e of bare) delete e.x;
    const r = slog.replay(bare);
    assert.deepEqual(r.problems, []);
    assert.equal(r.docs['ch-1'], null);
    assert.equal(r.lengths['ch-1'], doc.length);
  });
  test('picks up from a cached state', () => {
    const { chunks, doc } = sampleChain();
    const all = chunks.flatMap((c) => c.entries);
    const cut = 4;
    const head = slog.replay(all.filter((e) => e.n <= cut));
    const rest = slog.replay(all, { docs: head.docs, from: cut });
    assert.equal(rest.docs['ch-1'], doc);
  });
  test('an edit that doesn\'t fit its text is reported', () => {
    const r = slog.replay([{ kind: 'doc', n: 1, doc: 'd', act: 'new' }, { kind: 'edit', n: 2, doc: 'd', ops: [[5, 1, 0]], x: { ins: [''] } }]);
    assert.equal(r.problems.length, 1);
  });
});

describe('chunks on disk', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-slog-test-'));
  test('names sort by time and are recognised', () => {
    const name = slog.chunkName(Date.UTC(2026, 9, 7, 16, 5, 12, 345), DEV);
    assert.equal(name, '20261007T160512Z-aa11bb22.slog');
    assert.ok(slog.isChunkName(name));
    assert.ok(slog.isChunkName(slog.chunkName(0, DEV, 2)));
    for (const bad of ['../x.slog', 'a.slog', '20261007T160512Z-aa11bb22.slog/..', '20261007T160512Z-AA11BB22.slog']) assert.ok(!slog.isChunkName(bad), bad);
  });
  test('appends whole lines, in order, even when asked all at once', async () => {
    const file = path.join(tmp, 'order.slog');
    const w = new slog.ChunkWriter(file);
    await Promise.all(Array.from({ length: 200 }, (_, i) => w.append(JSON.stringify({ n: i + 1 }))));
    await w.flush();
    const { entries, partialTail } = slog.parseChunk(fs.readFileSync(file, 'utf8'));
    assert.equal(partialTail, false);
    assert.deepEqual(entries.map((e) => e.n), Array.from({ length: 200 }, (_, i) => i + 1));
    assert.equal(w.size, fs.statSync(file).size);
  });
  test('a line cut short by a crash is set aside', () => {
    const r = slog.parseChunk('{"n":1}\n{"n":2}\n{"n":3,"ki');
    assert.deepEqual(r.entries.map((e) => e.n), [1, 2]);
    assert.equal(r.partialTail, true);
    assert.deepEqual(r.problems, []);
  });
  test('a damaged line is reported, and the rest still read', () => {
    const r = slog.parseChunk('{"n":1}\n#garbage\n{"n":3}\n');
    assert.deepEqual(r.entries.map((e) => e.n), [1, 3]);
    assert.equal(r.problems.length, 1);
  });
  test('a chunk that can\'t be written says so, and stays stopped', async () => {
    const w = new slog.ChunkWriter(path.join(tmp, 'no-such-folder', 'x.slog'));
    await assert.rejects(w.append('{"n":1}'));
    assert.ok(w.broken);
    await assert.rejects(w.append('{"n":2}'));
  });
  test('a chain written to disk reads back and checks out', async () => {
    const { chunks } = sampleChain();
    const read = [];
    for (const c of chunks) {
      const w = new slog.ChunkWriter(path.join(tmp, c.name));
      for (const e of c.entries) w.append(JSON.stringify(e));
      await w.flush();
      read.push({ name: c.name, ...slog.parseChunk(fs.readFileSync(path.join(tmp, c.name), 'utf8')) });
    }
    assert.equal(slog.verifyChain(read, { key: KEY }).ok, true);
  });
});

describe('documents', () => {
  test('the book document leaves out bookkeeping and empty values, keys sorted', () => {
    const meta = { title: 'T', id: 'book-x', author: 'A', lastPosition: { scroll: 1.5 }, modified: 'now', wordCount: 9,
      dailyCounts: { d: 1 }, scribesLog: false, uuid: 'u', coverArt: {}, chapterTitles: {}, subtitle: '', chapterOrder: ['b', 'a'],
      sectionNotes: { z: 1, y: 2 } };
    assert.equal(slog.bookText(meta), JSON.stringify({ author: 'A', chapterOrder: ['b', 'a'], sectionNotes: { y: 2, z: 1 }, title: 'T' }, null, 2));
    assert.equal(slog.bookText({ ...meta, lastPosition: { scroll: 99 } }), slog.bookText(meta));
    assert.equal(slog.bookText(null), null);
  });
  test('an edit to the book says which fields changed', () => {
    const a = slog.bookText({ title: 'T', author: 'A', chapterOrder: ['x'] });
    const b = slog.bookText({ title: 'T', author: 'B', chapterOrder: ['x', 'y'] });
    assert.deepEqual(slog.bookKeys(a, b), ['author', 'chapterOrder']);
  });
  test('named documents and chapters never share a name', () => {
    assert.equal(slog.chapterDoc('ch-1'), 'ch-1');
    assert.equal(slog.chapterDoc('notes'), 'ch:notes');
    assert.equal(slog.docChapter('ch:notes'), 'notes');
    assert.equal(slog.docChapter('notes'), null);
    assert.equal(slog.docOf('aux', 'notes'), 'notes');
    assert.equal(slog.docOf('aux', 'cover'), null);
    assert.equal(slog.docOf('json', 'art'), null);
    assert.equal(slog.docOf('book'), 'book');
  });
});

describe('manuscript text', () => {
  test('paragraphs as lines, with what every export leaves out left out', () => {
    const html = '<p>It was <i>dark</i>&nbsp;&amp; cold.<br>Line two</p><p class="scene-break">***</p>' +
      '<p class="ghost" data-sec-id="s1">An unwritten section</p><p class="scene-break" data-sec-brk="s1"></p>' +
      '<p>Hi <span class="ph-mark" data-sid="1">⚑</span>there<span class="darling-anchor" data-id="x"></span></p>' +
      '<p><br></p><p>&#8220;Quote&#x201D; &lt;tag&gt;</p>';
    assert.deepEqual(slog.chapterLines(html), ['It was dark & cold.\nLine two', '***', 'Hi there', '“Quote” <tag>']);
  });
  test('chapters in the book\'s order, a Contents page left out', () => {
    const docs = {
      book: slog.bookText({ chapterOrder: ['c2', 'toc', 'c1'], chapterKinds: { toc: 'contents' } }),
      c1: '<p>One.</p>', c2: '<p>Two.</p>', toc: '<p>Contents</p>', notes: '<p>not the book</p>'
    };
    assert.equal(slog.manuscriptText(docs), 'Two.\nOne.');
    assert.equal(slog.manuscriptHash(slog.manuscriptText(docs)), slog.manuscriptHash('Two. One.'));
  });
});

describe('labels and clocks', () => {
  test('a label from the window is cut down to what the format allows', () => {
    assert.deepEqual(slog.cleanLabel({ src: 'typed', dur: 900, ev: 4, cause: 'undo', extra: 'x' }), { src: 'typed', cause: 'undo', dur: 900, ev: 4 });
    assert.deepEqual(slog.cleanLabel({ src: 'baseline' }), { src: 'unlogged' });
    // where moved text came from is the log's to work out, not the window's
    assert.deepEqual(slog.cleanLabel({ src: 'move', from: { n: 3, op: 0, at: 2 } }), { src: 'move' });
    assert.deepEqual(slog.cleanLabel({ src: 'move', book: 'book-b-1', cause: 'split' }), { src: 'move', cause: 'split', book: 'book-b-1' });
    assert.deepEqual(slog.cleanLabel({ src: 'typed', book: 'book-b-1', dur: 1.5 }), { src: 'typed' });
    assert.deepEqual(slog.cleanLabel({ src: 'move', book: '../x/y' }), { src: 'move' });
    assert.deepEqual(slog.cleanLabel({ src: 'move', copy: true }), { src: 'move', copy: true });
    assert.deepEqual(slog.cleanLabel({ src: 'paste', copy: true }), { src: 'paste' });
    assert.deepEqual(slog.cleanLabel(null), { src: 'unlogged' });
  });
  test('a clock jump is the wall clock against the steady one', () => {
    assert.equal(slog.clockJump(0, 0, 60000, 60000), 0);
    assert.equal(slog.clockJump(0, 0, 3660000, 60000), 3600000);
    assert.equal(slog.clockJump(0, 0, -100000, 60000), -160000);
  });
});

describe('moved text', () => {
  const LONG = 'twenty-some letters of plain prose here';
  test('a JSON document is read as the characters its escapes stand for', () => {
    const v = slog.viewOf('a\\"b\\n\\u00e9c', true);
    assert.equal(v.text, 'a"b\né' + 'c');
    assert.deepEqual(v.at, [0, 1, 3, 4, 6, 12, 13]);
    assert.equal(slog.viewOf('a\\"b', false).text, 'a\\"b');
  });
  test('a no-break space, however it\'s written, is read as a plain space', () => {
    const v = slog.viewOf('a&nbsp;b&#160;c&#xA0;d\u00a0e', false);
    assert.equal(v.text, 'a b c d e');
    assert.deepEqual(v.at, [0, 1, 7, 8, 14, 15, 21, 22, 23, 24]);
    assert.equal(slog.viewOf('x\\u00a0y', true).text, 'x y');
    assert.equal(slog.viewOf('a&amp;b', false).at, null, 'other references are left as they are');
    assert.deepEqual(slog.rawPieces(slog.viewOf('so&nbsp;far', false), slog.viewOf('so far', false), 0, 6, 0),
      [[0, 2, 0, 2], [2, 6, 2, 1], [8, 3, 3, 3]]);
  });
  test('a match is cut into pieces where one side writes a character differently', () => {
    const t = slog.viewOf('say \\"hi\\" now', true);
    const s = slog.viewOf('say "hi" now', false);
    assert.equal(t.text, s.text);
    assert.deepEqual(slog.rawPieces(t, s, 0, t.text.length, 0), [
      [0, 4, 0, 4], [4, 2, 4, 1], [6, 2, 5, 2], [8, 2, 7, 1], [10, 4, 8, 4]
    ]);
    // written the same way on both sides, an escape is just more of the run
    assert.deepEqual(slog.rawPieces(t, t, 0, t.text.length, 0), [[0, 14, 0, 14]]);
  });
  test('deleted text is found again inside a longer insertion; a short phrase isn\'t', () => {
    const g = new slog.Graveyard();
    g.bury({ view: slog.viewOf('<p>' + LONG + '</p>', false), ref: { n: 4, op: 1 } });
    g.bury({ view: slog.viewOf('<p>she said no</p>', false), ref: { n: 5, op: 0 } });
    const pools = [{ src: g }];
    assert.deepEqual(slog.movedPieces(0, 'Then ' + LONG + ', she said no.', false, pools),
      [[0, 5, LONG.length, { n: 4, op: 1, at: 3 }]]);
    // only markup in common isn't a move
    assert.deepEqual(slog.movedPieces(0, '<p class="scene-break">***</p><p>Hi</p>', false, pools), []);
    // told it was moved, the short one is found whole
    assert.deepEqual(slog.movedPieces(0, 'she said no', false, pools, { moved: true }), [[0, 0, 11, { n: 5, op: 0, at: 3 }]]);
  });
  test('a stretch that starts inside a tag counts that tag as markup', () => {
    // a scene break deleted, then typed again: the diff's strings start
    // partway into its <p> (21 units of attributes, 3 of writing)
    const brk = ' class="scene-break">***</p><p';
    const g = new slog.Graveyard();
    g.bury({ view: slog.viewOf(brk, false), ref: { n: 7, op: 0 } });
    assert.deepEqual(slog.movedPieces(0, brk, false, [{ src: g }]), []);
    assert.deepEqual(slog.movedPieces(0, 'ene-break">***</p><p>Again', false, [{ src: g }]), []);
    // words after it still count, so a real move that starts that way is found
    const words = brk + '>' + LONG;
    g.bury({ view: slog.viewOf(words, false), ref: { n: 8, op: 0 } });
    assert.deepEqual(slog.movedPieces(0, words, false, [{ src: g }]), [[0, 0, words.length, { n: 8, op: 0, at: 0 }]]);
    // in a JSON document a plain > can be part of the words, so there it counts
    const note = 'a sticky note of thirty letters > yes';
    const j = new slog.Graveyard();
    j.bury({ view: slog.viewOf(note, true), ref: { n: 9, op: 0 } });
    assert.equal(slog.movedPieces(0, note, true, [{ src: j }]).length, 1);
    assert.equal(slog.movedPieces(0, note, false, [{ src: j }]).length, 0, 'read as HTML, all but " yes" would be a tag');
  });
  test('a match that reaches further back wins over the first key found', () => {
    // words cut and undone (an older, shorter deletion), then moved whole
    // (a newer deletion whose keys sit two units later)
    const words = 'Mara counted the boats twice, and then once more.';
    const g = new slog.Graveyard();
    g.bury({ view: slog.viewOf(words.slice(5), false), ref: { n: 1, op: 0 } });
    g.bury({ view: slog.viewOf('xy' + words, false), ref: { n: 2, op: 0 } });
    assert.deepEqual(slog.movedPieces(0, words, false, [{ src: g }]), [[0, 0, words.length, { n: 2, op: 0, at: 2 }]]);
  });
  test('the newest deletion wins a tie, and a dropped one is forgotten', () => {
    const g = new slog.Graveyard();
    const old = g.add({ view: slog.viewOf(LONG, false), ref: { n: 1, op: 0 } });
    g.bury({ view: slog.viewOf(LONG, false), ref: { n: 2, op: 0 } });
    assert.equal(slog.movedPieces(0, LONG, false, [{ src: g }])[0][3].n, 2);
    g.clear();
    assert.ok(old.dead);
    assert.deepEqual(slog.movedPieces(0, LONG, false, [{ src: g }]), []);
  });
  test('the graveyard lets the oldest go past its size', () => {
    const g = new slog.Graveyard(100);
    for (let n = 1; n <= 10; n++) g.bury({ view: slog.viewOf(LONG + n, false), ref: { n, op: 0 } });
    assert.ok(g.size <= 100);
    assert.deepEqual([...g.records()].map((r) => r.ref.n), [10, 9]);
  });
  test('the manuscript\'s writing leaves out tags, scene breaks and what NEO keeps out of exports', () => {
    const html = '<p>Ab <i>cd</i></p><p class="scene-break">***</p><p>e<span class="ph-mark">[x]</span>f</p>';
    const mask = slog.proseMask(html);
    const kept = [...html].filter((_, i) => mask[i]).join('');
    assert.equal(kept, 'Ab cdef');
  });
  test('a character reference is one character of the writing', () => {
    const html = '<p>A&nbsp;b &amp; c&#8212;d&#x2014;e&nonsense f</p>';
    const mask = slog.proseMask(html);
    assert.equal(mask.reduce((a, b) => a + b, 0), 'A b & c—d—e&nonsense f'.length);
  });
});
