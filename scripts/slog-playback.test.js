'use strict';

// Playback (slog-playback.js): a chapter's writing played back entry by
// entry. Every frame must be exactly the chapter as the computer that made
// that change had it then (checked against a plain replay of its chain),
// across computers, through checkpoints and seeks, with what came in and
// what went marked, and colored by the checker's own origins.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { describe, test } = require('node:test');
const slog = require('../slog.js');
const V = require('../slog-verify.js');
const P = require('../slog-playback.js');
const F = require('../slog-files.js');

const KEY = Buffer.alloc(32, 5);
const DEV_A = 'a'.repeat(32);
const DEV_B = 'b'.repeat(32);
const T0 = Date.UTC(2026, 9, 8, 16, 0, 0);

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
// A writer at a document: typing, pasting and deleting by text, the log's
// ops worked out from where the text is
function writer(c, doc, text = '') {
  const w = {
    text,
    put(at, s, src = 'typed', more = {}) { const e = c.edit(doc, src, [[at, 0, s.length]], [s], more); w.text = w.text.slice(0, at) + s + w.text.slice(at); return e; },
    type(s, before = '</p>', src = 'typed', more = {}) { const at = w.text.lastIndexOf(before); return w.put(at < 0 ? w.text.length : at, s, src, more); },
    cut(s) { const at = w.text.indexOf(s); assert.ok(at >= 0, s); const e = c.edit(doc, 'typed', [[at, s.length, 0]], ['']); w.text = w.text.slice(0, at) + w.text.slice(at + s.length); return e; },
    swap(a, b, more = {}) { const at = w.text.indexOf(a); assert.ok(at >= 0, a); const e = c.edit(doc, more.src || 'typed', [[at, a.length, b.length]], [b], more); w.text = w.text.slice(0, at) + b + w.text.slice(at + a.length); return e; }
  };
  return w;
}
const chains = (...cs) => cs.map((c) => ({ dev: c.dev, entries: c.entries() }));
// the document on one device's chain after entry n, by a plain replay
function replayed(entries, n, doc) {
  return V.replay(entries.filter((e) => e.n <= n)).docs[doc];
}
// every frame of a playback checked against a plain replay of its own chain
function checkFrames(pb, list, doc) {
  const byDev = new Map(list.map((c) => [c.dev, c.entries]));
  for (let pos = 1; pos <= pb.length; pos++) {
    const f = pb.frame(pos);
    const want = replayed(byDev.get(f.step.dev), f.step.n, doc);
    assert.equal(f.text, want, `frame ${pos} (${f.step.name}, entry ${f.step.n})`);
  }
}

describe('playback: what an entry put in and took out', () => {
  test('one op, several ops, and text put in then taken out by the same entry', () => {
    assert.deepEqual(P.changes(10, [[4, 0, 3]]), { added: [[4, 3]], taken: [] });
    assert.deepEqual(P.changes(10, [[4, 2, 0]]), { added: [], taken: [[4, 2]] });
    assert.deepEqual(P.changes(10, [[4, 2, 5]]), { added: [[4, 5]], taken: [[4, 2]] });
    // an op's place is in the text the ops before it left
    assert.deepEqual(P.changes(10, [[2, 0, 3], [10, 1, 0]]), { added: [[2, 3]], taken: [[7, 1]] });
    // the second op takes out part of what the first put in
    assert.deepEqual(P.changes(10, [[2, 0, 5], [3, 2, 0]]), { added: [[2, 3]], taken: [] });
    // and some of the text around it
    assert.deepEqual(P.changes(10, [[2, 0, 3], [4, 4, 0]]), { added: [[2, 2]], taken: [[2, 3]] });
    assert.deepEqual(P.changes(0, [[0, 0, 4]]), { added: [[0, 4]], taken: [] });
    assert.deepEqual(P.changes(6, [[0, 6, 0]]), { added: [], taken: [[0, 6]] });
    // whatever the ops, put in and kept add up
    for (let i = 0; i < 300; i++) {
      let len = Math.floor(Math.random() * 30);
      const before = len;
      const ops = [];
      for (let k = 0; k < 1 + Math.floor(Math.random() * 4); k++) {
        const at = Math.floor(Math.random() * (len + 1));
        const del = Math.floor(Math.random() * (len - at + 1));
        const ins = Math.floor(Math.random() * 6);
        ops.push([at, del, ins]);
        len += ins - del;
      }
      // the same ops on real text, with each unit numbered
      const units = [...Array(before).keys()];
      let next = -1;
      for (const [at, del, ins] of ops) units.splice(at, del, ...Array.from({ length: ins }, () => next--));
      const ch = P.changes(before, ops);
      const added = [];
      units.forEach((u, i) => { if (u < 0) added.push(i); });
      const taken = [...Array(before).keys()].filter((u) => !units.includes(u));
      assert.deepEqual(ch.added.flatMap(([a, l]) => Array.from({ length: l }, (_, k) => a + k)), added, JSON.stringify(ops));
      assert.deepEqual(ch.taken.flatMap(([a, l]) => Array.from({ length: l }, (_, k) => a + k)), taken, JSON.stringify(ops));
    }
  });

  test('marks fall on the units named, a character reference whole', () => {
    const html = '<p>Fish &amp; chips, <i>then</i> tea.</p>';
    const at = html.indexOf('chips');
    const out = require('../slog-diff.js').viewHtml(html, P.marker([[at, 5]], 'pb-new', null));
    assert.equal(out, '<p>Fish &amp; <span class="pb-new">chips</span>, <i>then</i> tea.</p>');
    const amp = html.indexOf('&amp;');
    const out2 = require('../slog-diff.js').viewHtml(html, P.marker([[amp, 1]], 'pb-gone', null));
    assert.equal(out2, '<p>Fish <span class="pb-gone">&amp;</span> chips, <i>then</i> tea.</p>');
    // without a marker, nothing changes
    assert.equal(require('../slog-diff.js').viewHtml(html), '<p>Fish &amp; chips, <i>then</i> tea.</p>');
  });
});

describe('playback: one computer', () => {
  function oneBook() {
    const a = chainOf(DEV_A);
    a.open();
    const ch = writer(a, 'ch-1');
    a.add('doc', { doc: 'ch-1', act: 'new' });
    ch.put(0, '<p>The harbor was quiet.</p>');
    ch.type(' Gulls wheeled.');
    ch.put(ch.text.length, '<p>A paragraph that came from somewhere outside the book.</p>', 'paste');
    a.close();
    a.at(T0 + 3 * 3600e3).open();
    ch.cut(' Gulls wheeled.');
    ch.type(' Gulls &amp; terns wheeled, <i>slowly</i>.', '</p><p>A');
    ch.swap('somewhere outside', 'a stranger’s letter');
    a.close();
    return { a, ch };
  }

  test('a step for every change to the chapter, each frame exactly the chapter then', () => {
    const { a, ch } = oneBook();
    const list = chains(a);
    const pb = P.build(list, 'ch-1');
    assert.equal(pb.length, 6);
    assert.equal(pb.words, true);
    assert.deepEqual(pb.problems, []);
    assert.deepEqual(pb.steps.map((s) => s.src), ['typed', 'typed', 'paste', 'typed', 'typed', 'typed']);
    assert.deepEqual(pb.steps.map((s) => s.newSession), [true, false, false, true, false, false]);
    assert.equal(pb.steps[0].name, 'Device 1');
    checkFrames(pb, list, 'ch-1');
    assert.equal(pb.frame(pb.length).text, ch.text);
    // before the first change, the chapter isn't there
    const start = pb.frame(0);
    assert.equal(start.absent, true);
    assert.equal(start.html, '');
  });

  test('what a step put in is marked, what it took out shows going', () => {
    const { a } = oneBook();
    const pb = P.build(chains(a), 'ch-1');
    const typed = pb.frame(2);
    assert.match(typed.html, /<span class="pb-new"> Gulls wheeled\.<\/span>/);
    assert.equal(typed.goneHtml, null);
    assert.equal(typed.added, true);
    assert.equal(typed.words, 6);
    const cut = pb.frame(4);
    assert.equal(cut.added, false);
    assert.match(cut.goneHtml, /<span class="pb-gone"> Gulls wheeled\.<\/span>/);
    assert.doesNotMatch(cut.html, /pb-new|pb-gone/);
    assert.equal(P.stepLabel(cut.step, cut.added, (s) => s), 'Taken out');
    // a character reference and italics come through as clean markup
    const more = pb.frame(5);
    assert.match(more.html, /<span class="pb-new"> Gulls &amp; terns wheeled, <\/span><span class="pb-new"><i>slowly<\/i><\/span><span class="pb-new">\.<\/span>/);
    // a swap: the old words go, the new ones come
    const swap = pb.frame(6);
    assert.match(swap.goneHtml, /<span class="pb-gone">somewhere outside<\/span>/);
    assert.match(swap.html, /<span class="pb-new">a stranger’s letter<\/span>/);
  });

  test('colored by the checker\'s origins: a paste stays a paste through an edit inside it', () => {
    const { a } = oneBook();
    const pb = P.build(chains(a), 'ch-1');
    const last = pb.frame(pb.length, { origins: true });
    assert.match(last.html, /<span class="pb-o-pasted">A paragraph that came from <\/span>/);
    assert.match(last.html, /<span class="pb-new pb-o-typed">a stranger’s letter<\/span>/);
    assert.match(last.html, /^<p><span class="pb-o-typed">The harbor was quiet\. Gulls &amp; terns wheeled, <\/span><span class="pb-o-typed"><i>slowly<\/i><\/span>/);
    // and the counts agree with the checker's composition
    const traced = V.traceAll(chains(a)).get(DEV_A).docs['ch-1'];
    const made = V.composition({ 'ch-1': traced });
    assert.ok(made.paste > 0 && made.typed > 0);
  });

  test('nothing from the saved HTML runs: only clean markup comes out', () => {
    const a = chainOf(DEV_A);
    a.open();
    const ch = writer(a, 'ch-1');
    a.add('doc', { doc: 'ch-1', act: 'new' });
    ch.put(0, '<p onclick="x()">Hi <img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:y()">there</a>.</p>', 'paste');
    a.close();
    const f = P.build(chains(a), 'ch-1').frame(1, { origins: true });
    assert.doesNotMatch(f.html, /onclick|onerror|<img|<script|<a |javascript:/);
    assert.match(f.html, /^<p><span class="pb-new pb-o-pasted">Hi alert\(2\)there\.<\/span><\/p>$/);
  });

  test('a long chapter: frames found from the text kept every 64 changes, in any order', () => {
    const a = chainOf(DEV_A, { step: 700 });
    a.open();
    const ch = writer(a, 'ch-1');
    a.add('doc', { doc: 'ch-1', act: 'new' });
    ch.put(0, '<p>Start.</p>');
    let seed = 7;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const WORDS = ['salt', 'rope', 'tide', 'gull', 'mast', 'keel', 'fog', 'oar'];
    for (let i = 0; i < 400; i++) {
      if (i % 90 === 89) { a.close(); a.at(T0 + (i + 1) * 3600e3).open(); }
      const r = rnd(10);
      if (r < 6) ch.type(' ' + WORDS[rnd(8)]);
      else if (r < 8) {
        const m = / [a-z]+/.exec(ch.text.slice(rnd(Math.max(1, ch.text.length - 20))));
        if (m) ch.cut(m[0]); else ch.type(' ' + WORDS[rnd(8)]);
      } else ch.put(ch.text.length, '<p>New ' + WORDS[rnd(8)] + '.</p>');
    }
    a.close();
    const list = chains(a);
    const pb = P.build(list, 'ch-1');
    assert.equal(pb.length, 401);
    assert.ok(pb.lanes.get(DEV_A).whole.size >= 6);
    const entries = list[0].entries;
    for (const pos of [401, 3, 250, 64, 65, 1, 400, 129, 128, 300, 2, 199]) {
      const f = pb.frame(pos);
      assert.equal(f.text, replayed(entries, f.step.n, 'ch-1'), 'frame ' + pos);
    }
    checkFrames(pb, list, 'ch-1');
  });

  test('a chapter taken out of the book and restored under its own id', () => {
    const a = chainOf(DEV_A);
    a.open();
    const ch = writer(a, 'ch-1');
    a.add('doc', { doc: 'ch-1', act: 'new' });
    const del = ch.put(0, '<p>Gone for a while.</p>');
    ch.cut('<p>Gone for a while.</p>');
    a.add('doc', { doc: 'ch-1', act: 'del' });
    a.close();
    a.open();
    a.add('doc', { doc: 'ch-1', act: 'new' });
    ch.put(0, '<p>Gone for a while.</p>', 'move', { cause: 'restore', from: [[0, 0, '<p>Gone for a while.</p>'.length, { n: del.n + 1, op: 0, at: 0 }]] });
    a.close();
    const list = chains(a);
    const pb = P.build(list, 'ch-1');
    assert.equal(pb.length, 3);
    checkFrames(pb, list, 'ch-1');
    const back = pb.frame(3, { origins: true });
    assert.equal(P.stepLabel(back.step, back.added, (s) => s), 'Restored from a version');
    // restored text keeps its origin (typed, moved back)
    assert.match(back.html, /pb-o-moved/);
    assert.deepEqual(pb.problems, []);
  });

  test('a log shared without its words has nothing to play', () => {
    const { a } = oneBook();
    const bare = chains(a).map((c) => ({ dev: c.dev, entries: c.entries.map(({ x, ...clear }) => clear) }));
    const pb = P.build(bare, 'ch-1');
    assert.equal(pb.words, false);
    assert.equal(pb.length, 6);
    const f = pb.frame(3);
    assert.equal(f.blind, true);
    assert.equal(f.html, '');
  });
});

describe('playback: two computers', () => {
  // A writes; B finds it (arrived) and writes on; A finds B's and writes on
  function twoComputers() {
    const a = chainOf(DEV_A);
    a.open();
    const wa = writer(a, 'ch-1');
    a.add('doc', { doc: 'ch-1', act: 'new' });
    wa.put(0, '<p>Written on the desk.</p>');
    const pasted = wa.put(wa.text.length, '<p>A passage pasted in from a letter.</p>', 'paste');
    a.close();

    const b = chainOf(DEV_B, { start: T0 + 3600e3 });
    b.open();
    const wb = writer(b, 'ch-1', wa.text);
    b.base('ch-1', 'arrived', wa.text, { from: [[0, 0, wa.text.length, { dev: DEV_A, n: pasted.n, doc: 'ch-1', at: 0 }]] });
    wb.type(' And on the laptop.', '</p><p>A');
    const bLast = wb.put(wb.text.indexOf('letter.'), 'long ');
    b.close();

    const c = a.at(T0 + 2 * 3600e3);
    c.open();
    const at = wa.text.indexOf('</p><p>A');
    const add = ' And on the laptop.';
    a.edit('ch-1', 'arrived', [[at, 0, add.length]], [add], { from: [[0, 0, add.length, { dev: DEV_B, n: bLast.n, doc: 'ch-1', at }]] });
    wa.text = wa.text.slice(0, at) + add + wa.text.slice(at);
    const lAt = wa.text.indexOf('letter.');
    a.edit('ch-1', 'arrived', [[lAt, 0, 5]], ['long '], { from: [[0, 0, 5, { dev: DEV_B, n: bLast.n, doc: 'ch-1', at: lAt }]] });
    wa.text = wa.text.slice(0, lAt) + 'long ' + wa.text.slice(lAt);
    assert.equal(wa.text, wb.text);
    wa.type(' Back at the desk.', '</p><p>A');
    a.close();
    return { a, b };
  }

  test('both computers\' steps merged by time; what only arrived is the other\'s step', () => {
    const { a, b } = twoComputers();
    const list = chains(a, b);
    const pb = P.build(list, 'ch-1');
    assert.deepEqual(pb.problems, []);
    assert.deepEqual(pb.steps.map((s) => s.name + ' ' + s.src), ['Device 1 typed', 'Device 1 paste', 'Device 2 typed', 'Device 2 typed', 'Device 1 typed']);
    assert.deepEqual(pb.steps.map((s) => s.newSession), [true, false, true, false, true]);
    for (let i = 1; i < pb.length; i++) assert.ok(pb.steps[i].ts >= pb.steps[i - 1].ts);
    checkFrames(pb, list, 'ch-1');
    // the paste keeps its origin on the other computer, revised there
    const onB = pb.frame(4, { origins: true });
    assert.match(onB.html, /<span class="pb-o-pasted">A passage pasted in from a <\/span><span class="pb-new pb-o-typed">long <\/span>/);
    // and back on the first, through text that arrived
    const last = pb.frame(5, { origins: true });
    assert.match(last.html, /<span class="pb-o-typed">long <\/span><span class="pb-o-pasted">letter\.<\/span>/);
  });

  test('the light trace playback uses agrees with the checker\'s, unit by unit', () => {
    const { a, b } = twoComputers();
    // and a book with a paste cut and put back (an undo)
    const c = chainOf('c'.repeat(32));
    c.open();
    const w = writer(c, 'ch-1');
    c.add('doc', { doc: 'ch-1', act: 'new' });
    w.put(0, '<p>Typed first, then more typed words.</p>');
    const back = '<p>Pasted from somewhere else entirely.</p>';
    w.put(w.text.length, back, 'paste');
    const gone = w.cut(back);
    w.put(0, back, 'move', { cause: 'undo', from: [[0, 0, back.length, { n: gone.n, op: 0, at: 0 }]] });
    c.close();
    const units = (runs, f) => runs.flatMap(([len, o]) => Array(len).fill(f(o)));
    const isMoved = (o) => V.parseOrigin(o).moved;
    let sawMoved = false;
    for (const r of [chains(a, b), chains(c)]) {
      const plain = V.traceAll(r);
      const moved = V.traceAll(r, { detail: 'moved' });
      const full = V.traceAll(r, { detail: true });
      for (const { dev } of r) {
        for (const doc of Object.keys(plain.get(dev).docs)) {
          const m = moved.get(dev).docs[doc].runs;
          assert.deepEqual(units(m, V.originCat), units(plain.get(dev).docs[doc].runs, (o) => o), dev + ' ' + doc + ': categories');
          assert.deepEqual(units(m, isMoved), units(full.get(dev).docs[doc].runs, isMoved), dev + ' ' + doc + ': moved');
          if (units(m, isMoved).some(Boolean)) sawMoved = true;
        }
      }
    }
    assert.ok(sawMoved, 'the moved text was seen');
    const pb = P.build(chains(c), 'ch-1');
    assert.match(pb.frame(pb.length, { origins: true }).html, /^<p><span class="pb-new pb-o-pasted">Pasted from somewhere else entirely\.<\/span><\/p>/);
  });

  test('from a version to a version: only the steps between, starting from that version', () => {
    const { a, b } = twoComputers();
    const list = chains(a, b);
    const all = P.build(list, 'ch-1');
    const s2 = all.steps[2];
    const s4 = all.steps[4];
    const pb = P.build(list, 'ch-1', { from: { dev: all.steps[1].dev, n: all.steps[1].n }, to: { dev: s4.dev, n: s4.n } });
    assert.deepEqual(pb.steps.map((s) => s.n + s.dev), [s2.n + s2.dev, all.steps[3].n + all.steps[3].dev, s4.n + s4.dev]);
    assert.equal(pb.frame(0).text, all.frame(2).text);
    assert.equal(pb.frame(pb.length).text, all.frame(5).text);
    // from a session's close, which isn't a step itself
    const closeN = list[0].entries.find((e) => e.kind === 'close').n;
    const fromClose = P.build(list, 'ch-1', { from: { dev: DEV_A, n: closeN } });
    assert.equal(fromClose.length, 3);
    assert.equal(fromClose.frame(0).text, all.frame(2).text);
    // names a caller gives are used
    const named = P.build(list, 'ch-1', { names: new Map([[DEV_B, 'This computer'], [DEV_A, 'Device 2']]) });
    assert.deepEqual(named.steps.map((s) => s.name), ['Device 2', 'Device 2', 'This computer', 'This computer', 'Device 2']);
  });
});

describe('playback: a log NEO\'s own Recorder wrote, on two computers', () => {
  test('every frame is the chapter as that computer saved it, and the paste stays a paste', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-playback-'));
    const dir = path.join(root, 'book-a');
    fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
    const meta = { id: 'book-a', title: 'A Book', author: 'Ada', chapterOrder: ['ch-1'] };
    fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify(meta, null, 2));
    fs.writeFileSync(path.join(dir, 'chapters', 'ch-1.html'), '<p>Begun.</p>');
    let clock = T0;
    const errors = [];
    const recorder = (home) => new slog.Recorder({ home: path.join(root, home), app: 'test', now: () => (clock += 1000), onError: (w, err) => errors.push(w + ': ' + err.message) });
    // a save through main.js, the window having said how the text changed
    const saved = [];
    const write = (rec, html, label) => {
      if (label) rec.observe(dir, 'book-a', 'ch-1', html, label);
      rec.touch(dir, 'book-a');
      fs.writeFileSync(path.join(dir, 'chapters', 'ch-1.html'), html);
      rec.wrote(dir, 'book-a', 'ch-1', html);
      saved.push(html);
    };
    const desk = recorder('desk');
    desk.open(dir, 'book-a');
    write(desk, '<p>Begun. Then typed on.</p>', { src: 'typed' });
    write(desk, '<p>Begun. Then typed on.</p><p>Words from a letter, pasted.</p>', { src: 'paste' });
    await desk.close('book-a');
    clock += 3600e3;
    const laptop = recorder('laptop');
    laptop.open(dir, 'book-a');
    write(laptop, '<p>Begun. Then typed on, on the laptop.</p><p>Words from a letter, pasted.</p>', { src: 'typed' });
    write(laptop, '<p>Begun. Then typed on, on the laptop.</p><p>Words from a long letter, pasted.</p>', { src: 'typed' });
    await laptop.close('book-a');
    clock += 3600e3;
    desk.open(dir, 'book-a');
    // the desk reads the laptop's words from the disk before writing on
    desk.read(dir, 'book-a', 'ch-1', fs.readFileSync(path.join(dir, 'chapters', 'ch-1.html'), 'utf8'));
    write(desk, '<p>Begun. Then typed on, on the laptop.</p><p>Words from a long letter, pasted. Back at the desk.</p>', { src: 'typed' });
    await desk.close('book-a');
    assert.deepEqual(errors, []);

    const res = await V.checkLog(F.loadLog(dir));
    assert.equal(res.ok, true, JSON.stringify(res.problems));
    const pb = P.build(res.devices, 'ch-1', { links: res.links });
    assert.deepEqual(pb.problems, []);
    assert.deepEqual(pb.steps.map((s) => s.name), ['Device 1', 'Device 1', 'Device 1', 'Device 2', 'Device 2', 'Device 1']);
    assert.equal(pb.steps[0].src, 'baseline');
    // each frame is exactly a save, in order (the baseline first)
    assert.deepEqual(Array.from({ length: pb.length }, (_, i) => pb.frame(i + 1).text), ['<p>Begun.</p>', ...saved]);
    const last = pb.frame(pb.length, { origins: true });
    // (the laptop's diff took "long " as "ong l" inserted after the "l" of "letter": the log's own choice)
    assert.match(last.html, /<span class="pb-o-pasted">Words from a l<\/span><span class="pb-o-typed">ong l<\/span><span class="pb-o-pasted">etter, pasted\.<\/span><span class="pb-new pb-o-typed"> Back at the desk\.<\/span>/);
    assert.match(last.html, /<span class="pb-o-typed"> Then typed on, on the laptop\.<\/span>/, 'the laptop\'s words arrived before the desk\'s step, so aren\'t marked new');
    assert.match(last.html, /^<p><span class="pb-o-imported">Begun\.<\/span>/);
  });
});

describe('playback: timing', () => {
  function timed() {
    const a = chainOf(DEV_A);
    a.open();
    const ch = writer(a, 'ch-1');
    a.add('doc', { doc: 'ch-1', act: 'new' });
    a.at(T0);
    ch.put(0, '<p>One.</p>');
    a.at(T0 + 2000);
    ch.type(' Two.');
    a.at(T0 + 62000);
    ch.type(' Three.');
    a.close();
    a.at(T0 + 86400e3).open();
    ch.type(' Four.');
    a.close();
    return a;
  }

  test('real gaps at a speed; pauses and new sessions shortened when skipping', () => {
    const pb = P.build(chains(timed()), 'ch-1');
    // (each entry is a second after the clock was set)
    // (each entry is dated a second after the clock was set: gaps of 2 s,
    // 60 s, and a day less 61 s)
    assert.deepEqual([...pb.delays({ speed: 1, skip: false })], [0, 0, 2000, 60000, 86339000]);
    assert.deepEqual([...pb.delays({ speed: 10, skip: false })], [0, 0, 200, 6000, 8633900]);
    assert.deepEqual([...pb.delays({ speed: 10, skip: true })], [0, 0, 200, P.PAUSE_SHOWN, P.SESSION_SHOWN]);
    assert.deepEqual([...pb.delays({ speed: 600, skip: true })].map((x) => Math.round(x * 100) / 100), [0, 0, 3.33, P.PAUSE_SHOWN, P.SESSION_SHOWN]);
    const opts = { speed: 10, skip: true };
    const times = pb.times(opts);
    assert.deepEqual([...times], [0, 0, 200, 700, 2200]);
    assert.equal(pb.positionAt(0, opts), 1);
    assert.equal(pb.positionAt(199, opts), 1);
    assert.equal(pb.positionAt(200, opts), 2);
    assert.equal(pb.positionAt(1000, opts), 3);
    assert.equal(pb.positionAt(1e9, opts), 4);
  });
});

describe('playback: in a page with no Node', () => {
  test('runs from the plain files, as the verifier and the window load them', () => {
    const a = chainOf(DEV_A);
    a.open();
    const ch = writer(a, 'ch-1');
    a.add('doc', { doc: 'ch-1', act: 'new' });
    ch.put(0, '<p>Plain and simple.</p>');
    ch.type(' Still.');
    a.close();
    const ctx = vm.createContext({ crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array, DataView, Promise, console });
    for (const f of ['slog-hash.js', 'slog-zip.js', 'stamp-tsa.js', 'stamp-ots.js', 'slog-verify.js', 'slog-diff.js', 'slog-playback.js']) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
    }
    ctx.list = chains(a);
    const out = vm.runInContext('const pb = SlogPlayback.build(list, "ch-1"); [pb.length, pb.frame(2, { origins: true }).html]', ctx);
    assert.equal(out[0], 2);
    assert.equal(out[1], '<p><span class="pb-o-typed">Plain and simple.</span><span class="pb-new pb-o-typed"> Still.</span></p>');
  });
});
