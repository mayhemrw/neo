'use strict';

// The Scribe's Log Recorder (slog.js): one book's log as the main process
// keeps it, against real folders. Every test ends by checking the log the
// way scripts/slog-check.js does: chains intact, and the chain written last
// replays to exactly what's on disk.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');
const slog = require('../slog.js');
const { checkBook } = require('./slog-check.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-slog-rec-'));
let made = 0;

// a library folder with one book in it, and a Recorder whose clock we turn
function setup({ book = {}, chapters = { 'ch-1': '<p>Hello.</p>' }, notes = '', home = null } = {}) {
  const root = path.join(tmpRoot, String(++made));
  const dir = path.join(root, 'book-a');
  fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
  const meta = { id: 'book-a', title: 'A Book', author: 'Ada', chapterOrder: Object.keys(chapters), ...book };
  fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify(meta, null, 2));
  for (const [id, html] of Object.entries(chapters)) fs.writeFileSync(path.join(dir, 'chapters', id + '.html'), html);
  if (notes !== null) fs.writeFileSync(path.join(dir, 'notes.html'), notes);
  const env = { root, dir, meta, home: home || path.join(root, 'userData', 'slog'), clock: Date.UTC(2026, 9, 7, 16, 0, 0), errors: [] };
  env.recorder = (opts = {}) => new slog.Recorder({
    home: env.home, app: 'test', now: () => (env.clock += 1000),
    onError: (where, err) => env.errors.push(where + ': ' + err.message), ...opts
  });
  env.write = (id, html) => fs.writeFileSync(path.join(dir, 'chapters', id + '.html'), html);
  env.writeMeta = (m) => fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify(m, null, 2));
  return env;
}
// what a save does through main.js: touch, write, tell
function save(rec, env, id, html) {
  rec.touch(env.dir, 'book-a');
  env.write(id, html);
  rec.wrote(env.dir, 'book-a', slog.chapterDoc(id), html);
}
function entries(env) {
  const logDir = path.join(env.dir, slog.LOG_DIR);
  return fs.readdirSync(logDir).filter(slog.isChunkName).sort()
    .flatMap((n) => slog.parseChunk(fs.readFileSync(path.join(logDir, n), 'utf8')).entries);
}
function assertChecks(env) {
  const res = checkBook(env.dir);
  assert.deepEqual(res.problems, []);
  for (const d of res.devices) assert.deepEqual(d.problems, [], 'chain ' + d.dev);
  assert.deepEqual(res.devices[res.devices.length - 1].differ, [], 'the newest chain replays to the disk');
  assert.equal(res.ok, true);
  return res;
}

describe('Recorder', { concurrency: 1 }, () => {
  test('a book that was there first gets a baseline, once', async () => {
    const env = setup();
    const rec = env.recorder();
    rec.open(env.dir, 'book-a');
    await rec.close('book-a');
    const first = entries(env);
    assert.deepEqual(first.map((e) => e.kind), ['open', 'base', 'base', 'doc', 'close']);
    assert.ok(first.filter((e) => e.kind === 'base').every((e) => e.src === 'baseline'));
    assert.equal(first[0].prevChunk, null);
    // opened again (a new run, same computer): nothing to say, nothing written
    const again = env.recorder();
    again.open(env.dir, 'book-a');
    await again.close('book-a');
    assert.equal(entries(env).length, first.length);
    assert.deepEqual(env.errors, []);
    assertChecks(env);
  });

  test('the window\'s label wins; the save that follows adds nothing', async () => {
    const env = setup();
    const rec = env.recorder();
    rec.open(env.dir, 'book-a');
    rec.observe(env.dir, 'book-a', 'ch-1', '<p>Hello there.</p>', { src: 'typed', dur: 1200, ev: 6 });
    save(rec, env, 'ch-1', '<p>Hello there.</p>');
    rec.observe(env.dir, 'book-a', 'ch-1', '<p>Hello there. Pasted.</p>', { src: 'paste', dur: 0, ev: 1 });
    save(rec, env, 'ch-1', '<p>Hello there. Pasted.</p>');
    await rec.close('book-a');
    const edits = entries(env).filter((e) => e.kind === 'edit');
    assert.deepEqual(edits.map((e) => [e.src, e.ev]), [['typed', 6], ['paste', 1]]);
    assert.deepEqual(edits[0].x.ins, [' there']);
    assertChecks(env);
  });

  test('a save landing after newer words were described adds nothing', async () => {
    const env = setup();
    const rec = env.recorder();
    rec.open(env.dir, 'book-a');
    // the window describes two bursts; the first save is still on its way
    rec.observe(env.dir, 'book-a', 'ch-1', '<p>Hello there.</p>', { src: 'typed', ev: 6 });
    rec.observe(env.dir, 'book-a', 'ch-1', '<p>Hello there, you.</p>', { src: 'typed', ev: 5 });
    save(rec, env, 'ch-1', '<p>Hello there.</p>');
    save(rec, env, 'ch-1', '<p>Hello there, you.</p>');
    // …and one the window never described is still news
    save(rec, env, 'ch-1', '<p>Hello there, you!</p>');
    await rec.close('book-a');
    const edits = entries(env).filter((e) => e.kind === 'edit');
    assert.deepEqual(edits.map((e) => e.src), ['typed', 'typed', 'unlogged']);
    assertChecks(env);
  });

  test('a move\'s leaving half is the writer\'s own edit; the arriving half keeps the label', async () => {
    const env = setup({ chapters: { 'ch-1': '<p>One.</p><p>Two.</p>' } });
    const rec = env.recorder();
    rec.open(env.dir, 'book-a');
    const how = { src: 'move', cause: 'split' };
    rec.observe(env.dir, 'book-a', 'ch-1', '<p>One.</p>', how);
    rec.observe(env.dir, 'book-a', 'ch-2', '<p>Two.</p>', how);
    save(rec, env, 'ch-1', '<p>One.</p>');
    save(rec, env, 'ch-2', '<p>Two.</p>');
    await rec.close('book-a');
    const edits = entries(env).filter((e) => e.kind === 'edit');
    assert.deepEqual(edits.map((e) => [e.doc, e.src, e.cause]), [['ch-1', 'typed', 'split'], ['ch-2', 'move', 'split']]);
    assertChecks(env);
  });

  test('a book.json described from the shelf starts no log for the caret\'s place, and is labeled when it changes', async () => {
    const env = setup();
    const rec = env.recorder();
    assert.equal(rec.observeMeta(env.dir, 'book-a', { ...env.meta, lastPosition: { chapterId: 'ch-1' } }, { src: 'typed' }), false);
    assert.equal(fs.existsSync(path.join(env.dir, slog.LOG_DIR)), false);
    const renamed = { ...env.meta, title: 'A Better Book' };
    assert.equal(rec.observeMeta(env.dir, 'book-a', renamed, { src: 'typed' }), true);
    rec.beforeMeta(env.dir, 'book-a', renamed);
    env.writeMeta(renamed);
    rec.metaWritten(env.dir, 'book-a', renamed);
    await rec.close('book-a');
    const edits = entries(env).filter((e) => e.kind === 'edit' && e.doc === 'book');
    assert.deepEqual(edits.map((e) => [e.src, e.keys]), [['typed', ['title']]]);
    assertChecks(env);
  });

  test('a save nobody described is logged as unlogged', async () => {
    const env = setup();
    const rec = env.recorder();
    save(rec, env, 'ch-1', '<p>Hello, world.</p>');
    save(rec, env, 'ch-2', '<p>New chapter.</p>');
    await rec.close('book-a');
    const e = entries(env);
    assert.deepEqual(e.filter((x) => x.kind === 'edit').map((x) => [x.doc, x.src]), [['ch-1', 'unlogged'], ['ch-2', 'unlogged']]);
    assert.ok(e.some((x) => x.kind === 'doc' && x.doc === 'ch-2' && x.act === 'new'));
    assertChecks(env);
  });

  test('text from another device is logged as arrived, unless the window has words of its own waiting', async () => {
    const env = setup();
    const rec = env.recorder();
    rec.open(env.dir, 'book-a');
    env.write('ch-1', '<p>Hello from the laptop.</p>');
    rec.read(env.dir, 'book-a', 'ch-1', '<p>Hello from the laptop.</p>');
    // the window types, and before its save a newer file arrives
    rec.observe(env.dir, 'book-a', 'ch-1', '<p>Hello from the laptop. More.</p>', { src: 'typed' });
    env.write('ch-1', '<p>Phone text.</p>');
    rec.read(env.dir, 'book-a', 'ch-1', '<p>Phone text.</p>');
    // the window keeps its own text, and the other as a chapter of its own
    save(rec, env, 'ch-1', '<p>Hello from the laptop. More.</p>');
    rec.observe(env.dir, 'book-a', 'ch-twin', '<p>Phone text.</p>', { src: 'arrived' });
    save(rec, env, 'ch-twin', '<p>Phone text.</p>');
    // an empty read never counts as text taken away
    rec.read(env.dir, 'book-a', 'ch-1', '');
    await rec.close('book-a');
    const e = entries(env).filter((x) => x.kind === 'edit' || x.kind === 'base');
    assert.deepEqual(e.map((x) => [x.kind, x.doc, x.src]), [
      ['base', 'book', 'baseline'], ['base', 'ch-1', 'baseline'],
      ['edit', 'ch-1', 'arrived'], ['edit', 'ch-1', 'typed'], ['base', 'ch-twin', 'arrived']
    ]);
    assertChecks(env);
  });

  test('changes made while NEO was closed arrive at the next open', async () => {
    const env = setup({ chapters: { 'ch-1': '<p>One.</p>', 'ch-2': '<p>Two.</p>' } });
    const rec = env.recorder();
    rec.open(env.dir, 'book-a');
    await rec.close('book-a');
    env.write('ch-1', '<p>One, edited elsewhere.</p>');
    fs.unlinkSync(path.join(env.dir, 'chapters', 'ch-2.html'));
    env.writeMeta({ ...env.meta, chapterOrder: ['ch-1'] });
    const later = env.recorder();
    later.open(env.dir, 'book-a');
    await later.close('book-a');
    const e = entries(env);
    const second = e.slice(e.findIndex((x, i) => i > 0 && x.kind === 'open'));
    assert.deepEqual(second.map((x) => [x.kind, x.doc || '', x.src || x.act || '']), [
      // a document gone goes first, then one that shrank, so text that
      // moved is deleted before it turns up elsewhere
      ['open', '', ''], ['edit', 'ch-2', 'arrived'], ['doc', 'ch-2', 'del'],
      ['edit', 'book', 'arrived'], ['edit', 'ch-1', 'arrived'], ['close', '', '']
    ]);
    assert.deepEqual(second[3].keys, ['chapterOrder']);
    const names = fs.readdirSync(path.join(env.dir, slog.LOG_DIR)).filter(slog.isChunkName).sort();
    assert.deepEqual([second[0].prevChunk, names.length], [names[0], 2]);
    assertChecks(env);
  });

  test('a lost cache is rebuilt from the chunks, and the chain carries on', async () => {
    const env = setup();
    let rec = env.recorder();
    save(rec, env, 'ch-1', '<p>Hello, one.</p>');
    await rec.close('book-a');
    for (const f of fs.readdirSync(env.home)) if (f !== 'device.json') fs.unlinkSync(path.join(env.home, f));
    rec = env.recorder();
    save(rec, env, 'ch-1', '<p>Hello, two.</p>');
    await rec.close('book-a');
    const e = entries(env);
    assert.equal(e.filter((x) => x.kind === 'base').length, 2, 'no second baseline');
    assertChecks(env);
  });

  test('after a crash (no close, stale cache) the next session links to the last good line', async () => {
    const env = setup();
    let rec = env.recorder();
    save(rec, env, 'ch-1', '<p>Saved and logged.</p>');
    await rec.close('book-a');
    rec = env.recorder();
    save(rec, env, 'ch-1', '<p>Saved and logged, twice.</p>');
    const s = rec.sessions.get('book-a');
    await s.chunk.writer.flush();
    const crashed = path.join(env.dir, slog.LOG_DIR, s.chunk.name);
    fs.appendFileSync(crashed, '{"kind":"edit","n":99'); // a line the power cut short
    // NEO is gone: no close line, and the cache still says the first session
    rec = env.recorder();
    rec.open(env.dir, 'book-a');
    save(rec, env, 'ch-1', '<p>Saved and logged, three times.</p>');
    await rec.close('book-a');
    const res = assertChecks(env);
    assert.ok(res.devices[0].notes.some((n) => /without closing/.test(n.note)));
    assert.ok(res.devices[0].notes.some((n) => /cut short/.test(n.note)));
  });

  test('switched off, then on: off is noted, and what changed meanwhile is marked', async () => {
    const env = setup();
    const rec = env.recorder();
    rec.open(env.dir, 'book-a');
    rec.observe(env.dir, 'book-a', 'ch-1', '<p>Hello, logged.</p>', { src: 'typed' });
    save(rec, env, 'ch-1', '<p>Hello, logged.</p>');
    const off = { ...env.meta, scribesLog: false };
    rec.beforeMeta(env.dir, 'book-a', off);
    env.writeMeta(off);
    rec.metaWritten(env.dir, 'book-a', off);
    assert.equal(rec.status(env.dir, 'book-a').on, false);
    save(rec, env, 'ch-1', '<p>Hello, not logged.</p>');
    rec.observe(env.dir, 'book-a', 'ch-1', '<p>ignored</p>', { src: 'typed' });
    const on = { ...env.meta };
    rec.beforeMeta(env.dir, 'book-a', on);
    env.writeMeta(on);
    rec.metaWritten(env.dir, 'book-a', on);
    await rec.close('book-a');
    const e = entries(env);
    const kinds = e.map((x) => x.kind);
    assert.ok(kinds.indexOf('off') < kinds.indexOf('on'));
    assert.equal(e[kinds.indexOf('off') + 1].why, 'off', 'switching off closes the chunk');
    const marked = e.filter((x) => x.cause === 'off');
    assert.deepEqual(marked.map((x) => [x.doc, x.src]), [['ch-1', 'unlogged']]);
    assert.ok(!e.some((x) => x.x && x.x.ins.includes('ignored')));
    assertChecks(env);
  });

  test('off and straight back on: closing waits for both chunks\' last lines', async () => {
    const env = setup();
    const rec = env.recorder();
    // the first chunk's disk is slow
    const drain = slog.ChunkWriter.prototype.drain;
    let first = null;
    slog.ChunkWriter.prototype.drain = async function () {
      if (!first) first = this;
      if (this === first) await new Promise((resolve) => setTimeout(resolve, 150));
      return drain.call(this);
    };
    try {
      rec.open(env.dir, 'book-a');
      save(rec, env, 'ch-1', '<p>Hello, logged.</p>');
      const off = { ...env.meta, scribesLog: false };
      rec.beforeMeta(env.dir, 'book-a', off);
      env.writeMeta(off);
      rec.metaWritten(env.dir, 'book-a', off);
      const on = { ...env.meta };
      rec.beforeMeta(env.dir, 'book-a', on);
      env.writeMeta(on);
      rec.metaWritten(env.dir, 'book-a', on);
      await rec.close('book-a');
      assert.equal(rec.busy(), false);
      const kinds = entries(env).map((x) => x.kind);
      assert.deepEqual(kinds.filter((k) => ['open', 'off', 'on', 'close'].includes(k)), ['open', 'off', 'close', 'open', 'on', 'close']);
    } finally {
      slog.ChunkWriter.prototype.drain = drain;
    }
    assertChecks(env);
  });

  test('a book switched off before it was ever logged gets no log at all', () => {
    const env = setup({ book: { scribesLog: false } });
    const rec = env.recorder();
    rec.open(env.dir, 'book-a');
    save(rec, env, 'ch-1', '<p>Private.</p>');
    assert.equal(fs.existsSync(path.join(env.dir, slog.LOG_DIR)), false);
  });

  test('saving the caret\'s place doesn\'t start a log; changing the title does', async () => {
    const env = setup();
    const rec = env.recorder();
    const moved = { ...env.meta, lastPosition: { chapterId: 'ch-1', scroll: 12.5 } };
    rec.beforeMeta(env.dir, 'book-a', moved);
    env.writeMeta(moved);
    rec.metaWritten(env.dir, 'book-a', moved);
    assert.equal(fs.existsSync(path.join(env.dir, slog.LOG_DIR)), false);
    const renamed = { ...moved, title: 'A Better Title' };
    rec.beforeMeta(env.dir, 'book-a', renamed);
    env.writeMeta(renamed);
    rec.metaWritten(env.dir, 'book-a', renamed);
    await rec.close('book-a');
    const edit = entries(env).find((x) => x.kind === 'edit');
    assert.deepEqual([edit.doc, edit.keys], ['book', ['title']]);
    assertChecks(env);
  });

  test('a second computer keeps its own chain', async () => {
    const env = setup();
    const rec = env.recorder();
    save(rec, env, 'ch-1', '<p>Written on the desktop.</p>');
    await rec.close('book-a');
    // the laptop: another installation, same synced folder
    const laptop = new slog.Recorder({ home: path.join(env.root, 'laptop'), now: () => (env.clock += 1000) });
    laptop.open(env.dir, 'book-a');
    save(laptop, env, 'ch-1', '<p>Written on the desktop, then the laptop.</p>');
    await laptop.close('book-a');
    const res = assertChecks(env);
    assert.equal(res.devices.length, 2);
    assert.deepEqual(res.devices[1].sources, { arrived: 2, unlogged: 1 });
    // back on the desktop, the laptop's words arrive
    const desk = env.recorder();
    desk.open(env.dir, 'book-a');
    await desk.close('book-a');
    const arrived = entries(env).filter((x) => x.kind === 'edit' && x.src === 'arrived' && x.doc === 'ch-1');
    assert.equal(arrived.length, 1);
    assert.ok(arrived[0].x.ins.join('').includes('laptop'));
    assertChecks(env);
  });

  test('deleting a chapter deletes its text, then the chapter', async () => {
    const env = setup({ chapters: { 'ch-1': '<p>Keep.</p>', 'ch-2': '<p>Go.</p>' } });
    const rec = env.recorder();
    rec.touch(env.dir, 'book-a');
    fs.unlinkSync(path.join(env.dir, 'chapters', 'ch-2.html'));
    rec.removed(env.dir, 'book-a', 'ch-2');
    await rec.close('book-a');
    const e = entries(env);
    const del = e.findIndex((x) => x.kind === 'doc' && x.act === 'del');
    assert.deepEqual(e[del - 1].ops, [[0, '<p>Go.</p>'.length, 0]]);
    assertChecks(env);
  });

  test('an import ties the new book\'s first text to the file it came from', async () => {
    const env = setup({ chapters: {} });
    const file = path.join(env.root, 'novel.txt');
    fs.writeFileSync(file, 'Chapter 1\n\nIt began.\n');
    const rec = env.recorder();
    const token = rec.rememberImport(slog.fileFacts(file));
    // book:create's scaffold, then the chapters the window writes
    fs.rmSync(env.dir, { recursive: true });
    fs.mkdirSync(path.join(env.dir, 'chapters'), { recursive: true });
    fs.writeFileSync(path.join(env.dir, 'book.json'), JSON.stringify({ id: 'book-a', title: 'Novel', author: 'Ada', chapterOrder: [] }));
    fs.writeFileSync(path.join(env.dir, 'notes.html'), '');
    fs.writeFileSync(path.join(env.dir, 'darlings.json'), '[]');
    fs.writeFileSync(path.join(env.dir, 'stickies.json'), '[]');
    rec.created(env.dir, 'book-a', token);
    save(rec, env, 'ch-9', '<p>It began.</p>');
    await rec.close('book-a');
    const sha = slog.sha256hex(fs.readFileSync(file));
    const bases = entries(env).filter((x) => x.kind === 'base');
    assert.deepEqual(bases.map((x) => [x.doc, x.src, x.file && x.file.sha256]).sort(),
      [['book', 'import', sha], ['ch-9', 'import', sha], ['darlings', 'import', sha], ['stickies', 'import', sha]]);
    assert.ok(entries(env).every((x) => x.kind !== 'edit'), 'nothing in the scaffold is typed');
    assert.ok(!JSON.stringify(entries(env).map(slog.clearPart)).includes('novel'), 'no file name in the clear');
    assertChecks(env);
  });

  test('a new book starts its log with its scaffold', async () => {
    const env = setup({ chapters: {}, notes: '' });
    fs.writeFileSync(path.join(env.dir, 'darlings.json'), '[]');
    const rec = env.recorder();
    rec.created(env.dir, 'book-a', null);
    save(rec, env, 'ch-1', '<p><br></p>');
    await rec.close('book-a');
    const e = entries(env);
    assert.ok(!e.some((x) => x.kind === 'base'), 'nothing in a new book was there before');
    assertChecks(env);
  });

  test('a chunk closes at its size limit and when the writing stops', async () => {
    const env = setup();
    const rec = env.recorder({ maxChunk: 2000, idleMs: 30 });
    rec.open(env.dir, 'book-a');
    let html;
    for (let i = 1; i <= 12; i++) {
      html = '<p>Hello.' + ' More words.'.repeat(i * 3) + '</p>';
      rec.observe(env.dir, 'book-a', 'ch-1', html, { src: 'typed' });
    }
    save(rec, env, 'ch-1', html);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await rec.close('book-a');
    const e = entries(env);
    const whys = e.filter((x) => x.kind === 'close').map((x) => x.why);
    assert.ok(whys.filter((w) => w === 'size').length >= 2, whys.join());
    assert.equal(whys[whys.length - 1], 'idle');
    assertChecks(env);
  });

  test('sleep and wake are noted in a chunk being written, and nowhere else', async () => {
    const env = setup();
    const rec = env.recorder();
    rec.event('sleep');
    rec.open(env.dir, 'book-a');
    rec.event('sleep');
    rec.event('wake');
    rec.event('clock', { jump: -3600000 });
    await rec.close('book-a');
    rec.event('sleep');
    const kinds = entries(env).map((x) => x.kind);
    assert.deepEqual(kinds.filter((k) => ['sleep', 'wake', 'clock'].includes(k)), ['sleep', 'wake', 'clock']);
    assertChecks(env);
  });

  test('when the disk refuses a write, the log catches up later without breaking its chain', async () => {
    const env = setup();
    const rec = env.recorder();
    rec.open(env.dir, 'book-a');
    const s = rec.sessions.get('book-a');
    await s.chunk.writer.flush();
    // the next write fails, as a full or vanished disk would
    const w = s.chunk.writer;
    const realAppend = w.append.bind(w);
    w.append = () => {
      w.broken = new Error('ENOSPC');
      w.append = realAppend;
      return Promise.reject(w.broken);
    };
    rec.observe(env.dir, 'book-a', 'ch-1', '<p>Hello, lost.</p>', { src: 'typed' });
    save(rec, env, 'ch-1', '<p>Hello, lost.</p>');
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(env.errors.some((x) => /ENOSPC/.test(x)));
    env.clock += 60000; // past the wait before trying again
    rec.observe(env.dir, 'book-a', 'ch-1', '<p>Hello, lost, found.</p>', { src: 'typed' });
    save(rec, env, 'ch-1', '<p>Hello, lost, found.</p>');
    await rec.close('book-a');
    const e = entries(env);
    assert.ok(e.some((x) => x.kind === 'edit' && x.src === 'unlogged'), 'the lost change comes back as unlogged');
    assert.ok(e.some((x) => x.kind === 'edit' && x.src === 'typed'));
    assertChecks(env);
  });

  test('the close line\'s manuscript hash is the book on disk', async () => {
    const env = setup({ chapters: { 'ch-1': '<p>One.</p>', 'ch-2': '<p>Two.</p><p class="scene-break">***</p><p>Three.</p>' } });
    const rec = env.recorder();
    rec.open(env.dir, 'book-a');
    await rec.close('book-a');
    const close = entries(env).find((x) => x.kind === 'close');
    assert.equal(close.ms, slog.manuscriptHash('One. Two. *** Three.'));
  });

  test('a log.json from a newer NEO is left alone', () => {
    const env = setup();
    fs.mkdirSync(path.join(env.dir, slog.LOG_DIR));
    fs.writeFileSync(path.join(env.dir, slog.LOG_DIR, slog.LOG_INFO), JSON.stringify({ v: 2, logId: 'x' }));
    const rec = env.recorder();
    rec.open(env.dir, 'book-a');
    save(rec, env, 'ch-1', '<p>Hello?</p>');
    assert.deepEqual(fs.readdirSync(path.join(env.dir, slog.LOG_DIR)), [slog.LOG_INFO]);
    assert.ok(env.errors.some((x) => /log\.json/.test(x)));
  });
});

// Moved text, followed: each test writes the way the window describes it,
// then traces the log and checks where the words in the end came from.
describe('Moves and the graveyard', { concurrency: 1 }, () => {
  const PASTED = 'A sentence the writer found somewhere else entirely.';
  const OWN = 'Words the writer typed here, slowly, one by one.';
  // the newest chain, traced
  function traced(env) {
    const res = assertChecks(env);
    return res.devices[res.devices.length - 1];
  }
  // where each stretch of `needle` in document `doc` came from
  function origins(dev, doc, needle) {
    const d = dev.traced[doc];
    const at = d.text.indexOf(needle);
    assert.ok(at >= 0, `"${needle}" is in ${doc}`);
    return slog.originsAt(d, at, needle.length).map(([, o]) => o);
  }
  const observe = (rec, env, doc, text, how) => rec.observe(env.dir, 'book-a', doc, text, how);

  test('pasted, deleted, undone: still pasted', async () => {
    const env = setup({ chapters: { 'ch-1': '<p>Start.</p>' } });
    const rec = env.recorder();
    rec.open(env.dir, 'book-a');
    observe(rec, env, 'ch-1', `<p>Start. ${OWN}</p>`, { src: 'typed', ev: 40 });
    observe(rec, env, 'ch-1', `<p>Start. ${OWN} ${PASTED}</p>`, { src: 'paste', ev: 1 });
    observe(rec, env, 'ch-1', `<p>Start. ${OWN}</p>`, { src: 'typed', ev: 1 });
    observe(rec, env, 'ch-1', `<p>Start. ${OWN} ${PASTED}</p>`, { src: 'move', cause: 'undo', ev: 1 });
    save(rec, env, 'ch-1', `<p>Start. ${OWN} ${PASTED}</p>`);
    await rec.close('book-a');
    const edits = entries(env).filter((e) => e.kind === 'edit');
    const undo = edits[edits.length - 1];
    assert.equal(undo.cause, 'undo');
    assert.deepEqual(undo.from, [[0, 0, PASTED.length + 1, { n: edits[2].n, op: 0, at: 0 }]]);
    const dev = traced(env);
    assert.deepEqual(origins(dev, 'ch-1', PASTED), ['paste']);
    assert.deepEqual(origins(dev, 'ch-1', OWN), ['typed']);
    assert.equal(dev.made.paste, PASTED.length + 1);
    assert.equal(dev.made.move, undefined, 'nothing moved is left untraced');
  });

  test('cut and pasted back: the paste points at the cut', async () => {
    const env = setup({ chapters: { 'ch-1': `<p>${OWN}</p><p>Second.</p>` } });
    const rec = env.recorder();
    rec.open(env.dir, 'book-a');
    observe(rec, env, 'ch-1', '<p></p><p>Second.</p>', { src: 'typed' });
    observe(rec, env, 'ch-1', `<p></p><p>Second. ${OWN}</p>`, { src: 'move' });
    save(rec, env, 'ch-1', `<p></p><p>Second. ${OWN}</p>`);
    await rec.close('book-a');
    const edits = entries(env).filter((e) => e.kind === 'edit');
    assert.equal(edits[1].from[0][3].n, edits[0].n);
    assert.deepEqual(origins(traced(env), 'ch-1', OWN), ['baseline']);
  });

  test('cut with a plain space, pasted back with a no-break one: traced in full', async () => {
    // Chromium saves the space at the edge of a paste as &nbsp;
    const env = setup({ chapters: { 'ch-1': `<p>Start. ${OWN}</p><p>Second.</p>` } });
    const rec = env.recorder();
    rec.open(env.dir, 'book-a');
    observe(rec, env, 'ch-1', '<p>Start.</p><p>Second.</p>', { src: 'typed' });
    observe(rec, env, 'ch-1', `<p>Start.</p><p>Second.&nbsp;${OWN}</p>`, { src: 'move' });
    save(rec, env, 'ch-1', `<p>Start.</p><p>Second.&nbsp;${OWN}</p>`);
    await rec.close('book-a');
    const edits = entries(env).filter((e) => e.kind === 'edit');
    assert.deepEqual(edits[1].from, [
      [0, 0, 6, { n: edits[0].n, op: 0, at: 0, len: 1 }],
      [0, 6, OWN.length, { n: edits[0].n, op: 0, at: 1 }]
    ]);
    const dev = traced(env);
    assert.deepEqual(dev.made, { baseline: 'Start.'.length + 'Second.'.length + 1 + OWN.length }, 'the space counts once, and nothing is left untraced');
  });

  test('copied and pasted: the paste points at the text still there', async () => {
    const env = setup({ chapters: { 'ch-1': `<p>${OWN}</p>`, 'ch-2': '<p>Two.</p>' } });
    const rec = env.recorder();
    rec.open(env.dir, 'book-a');
    // the same words were deleted once, too: a copy is looked for in the
    // book first, so a match as long there wins
    observe(rec, env, 'ch-2', `<p>Two.</p><p>${OWN}</p>`, { src: 'typed' });
    observe(rec, env, 'ch-2', '<p>Two.</p>', { src: 'typed' });
    observe(rec, env, 'ch-2', `<p>Two. ${OWN}</p>`, { src: 'move', copy: true });
    save(rec, env, 'ch-2', `<p>Two. ${OWN}</p>`);
    await rec.close('book-a');
    const edit = entries(env).filter((e) => e.kind === 'edit').pop();
    assert.deepEqual(edit.from, [[0, 1, OWN.length, { doc: 'ch-1', at: 3 }]]);
    const dev = traced(env);
    assert.deepEqual(origins(dev, 'ch-2', OWN), ['baseline']);
  });

  test('a split traces the new chapter to the old, whichever arrives first', async () => {
    for (const newFirst of [false, true]) {
      const env = setup({ chapters: { 'ch-1': `<p>One.</p><p>${PASTED}</p><p>${OWN}</p>` }, book: { chapterOrder: ['ch-1', 'ch-2'] } });
      const rec = env.recorder();
      rec.open(env.dir, 'book-a');
      const how = { src: 'move', cause: 'split' };
      const moved = `<p>${PASTED}</p><p>${OWN}</p>`;
      if (newFirst) observe(rec, env, 'ch-2', moved, how);
      observe(rec, env, 'ch-1', '<p>One.</p>', how);
      if (!newFirst) observe(rec, env, 'ch-2', moved, how);
      save(rec, env, 'ch-1', '<p>One.</p>');
      save(rec, env, 'ch-2', moved);
      await rec.close('book-a');
      const arriving = entries(env).find((e) => e.kind === 'edit' && e.doc === 'ch-2');
      assert.deepEqual(arriving.from, [[0, 0, moved.length, newFirst ? { doc: 'ch-1', at: 11 } : { n: arriving.n - 2, op: 0, at: 0 }]]);
      const dev = traced(env);
      assert.deepEqual(dev.made, { baseline: 'One.'.length + PASTED.length + OWN.length });
    }
  });

  test('to Darlings and back: escapes in JSON are followed, origins kept', async () => {
    const quoted = `<p class="talk">"${PASTED}" she said, "and ${OWN}"</p>`;
    const env = setup({ chapters: { 'ch-1': `<p>Kept.</p>${quoted}` } });
    const rec = env.recorder();
    rec.open(env.dir, 'book-a');
    const how = { src: 'move', cause: 'darling' };
    const darling = slog.jsonText([{ id: 'd-1', html: quoted, text: `"${PASTED}" she said, "and ${OWN}"` }]);
    rec.observe(env.dir, 'book-a', 'darlings', darling, how);
    observe(rec, env, 'ch-1', '<p>Kept.</p>', how);
    // …and restored
    rec.observe(env.dir, 'book-a', 'darlings', '[]', how);
    observe(rec, env, 'ch-1', `<p>Kept.</p>${quoted}`, how);
    save(rec, env, 'ch-1', `<p>Kept.</p>${quoted}`);
    fs.writeFileSync(path.join(env.dir, 'darlings.json'), '[]');
    await rec.close('book-a');
    const edits = entries(env).filter((e) => e.kind === 'edit');
    const toDarlings = edits.find((e) => e.doc === 'darlings' && e.from);
    assert.ok(toDarlings.from.some((p) => p[3].len === 1 && p[2] === 2), 'an escaped quote is a piece of its own');
    const dev = traced(env);
    assert.deepEqual(dev.made, { baseline: 'Kept.'.length + quoted.replace(/<[^>]*>/g, '').length });
  });

  test('a burst rewritten as one replacement keeps the origins of what it didn\'t change', async () => {
    const words = Array.from({ length: 300 }, (_, i) => 'word' + i);
    const tail = PASTED + ' ' + OWN;
    const before = `<p>${words.join(' ')} ${tail} end</p>`;
    const after = `<p>${words.map((w) => w.toUpperCase()).join(' ')} ${tail} END</p>`;
    const env = setup({ chapters: { 'ch-1': '<p>x</p>' } });
    const rec = env.recorder();
    rec.open(env.dir, 'book-a');
    observe(rec, env, 'ch-1', before, { src: 'paste' });
    observe(rec, env, 'ch-1', after, { src: 'typed', ev: 900 });
    save(rec, env, 'ch-1', after);
    await rec.close('book-a');
    const last = entries(env).filter((e) => e.kind === 'edit').pop();
    assert.equal(last.ops.length, 1, 'past the word-level diff\'s reach: one replacement');
    assert.ok(last.from.some((p) => p[3].n === last.n && p[3].op === 0), 'pointing at its own deletion');
    assert.deepEqual(origins(traced(env), 'ch-1', tail), ['paste']);
  });

  test('a short phrase typed again isn\'t a move', async () => {
    const env = setup({ chapters: { 'ch-1': '<p>She said no.</p>' } });
    const rec = env.recorder();
    rec.open(env.dir, 'book-a');
    observe(rec, env, 'ch-1', '<p></p>', { src: 'typed' });
    observe(rec, env, 'ch-1', '<p>She said no.</p>', { src: 'typed' });
    save(rec, env, 'ch-1', '<p>She said no.</p>');
    await rec.close('book-a');
    assert.ok(entries(env).every((e) => e.from === undefined));
  });

  test('copied from another open book: the paste names that book\'s log', async () => {
    const env = setup({ chapters: { 'ch-1': '<p>A.</p>' } });
    const other = path.join(env.root, 'book-b');
    fs.mkdirSync(path.join(other, 'chapters'), { recursive: true });
    fs.writeFileSync(path.join(other, 'book.json'), JSON.stringify({ id: 'book-b', title: 'B', chapterOrder: ['ch-9'] }));
    fs.writeFileSync(path.join(other, 'chapters', 'ch-9.html'), `<p>${PASTED}</p>`);
    const rec = env.recorder();
    rec.open(other, 'book-b');
    await rec.close('book-b');
    rec.open(env.dir, 'book-a');
    observe(rec, env, 'ch-1', `<p>A. ${PASTED}</p>`, { src: 'move', book: 'book-b' });
    save(rec, env, 'ch-1', `<p>A. ${PASTED}</p>`);
    await rec.close('book-a');
    const logB = JSON.parse(fs.readFileSync(path.join(other, slog.LOG_DIR, slog.LOG_INFO), 'utf8')).logId;
    const edit = entries(env).find((e) => e.kind === 'edit');
    assert.deepEqual(edit.from, [[0, 1, PASTED.length, { log: logB }]]);
    assert.deepEqual(origins(traced(env), 'ch-1', PASTED), ['other book']);
  });

  test('a copy\'s base names the book it came from; a checker holds it to that', () => {
    const key = Buffer.alloc(32, 7);
    const chain = new slog.Chain({ dev: 'b'.repeat(32), key, now: () => 1 });
    const e = [];
    const add = (kind, fields, ins) => e.push(chain.entry(kind, fields, ins).entry);
    const html = `<p>${OWN}</p>`;
    add('base', { doc: 'ch-1', src: 'baseline', ops: [[0, 0, html.length]], from: [[0, 0, html.length, { log: 'orig-log' }]] }, [html]);
    add('base', { doc: 'ch-2', src: 'baseline', ops: [[0, 0, html.length]], from: [[0, 0, html.length, { doc: 'ch-1', at: 0 }]] }, [html]);
    add('base', { doc: 'ch-3', src: 'baseline', ops: [[0, 0, 5]], from: [[0, 2, 9, { log: 'orig-log' }]] }, ['Short']);
    const t = slog.trace(e);
    assert.deepEqual(t.docs['ch-1'].runs, [[html.length, 'other book']]);
    assert.deepEqual(t.docs['ch-2'].runs, [[html.length, 'baseline']]);
    assert.deepEqual(t.problems.map((p) => [p.n, p.problem]), [
      [2, 'a base\'s from can only name another book'],
      [3, 'from piece out of range']
    ]);
  });

  test('a checker catches a from that lies', () => {
    const key = Buffer.alloc(32, 7);
    const chain = new slog.Chain({ dev: 'a'.repeat(32), key, now: () => 1 });
    const e = [];
    const add = (kind, fields, ins) => e.push(chain.entry(kind, fields, ins).entry);
    add('base', { doc: 'ch-1', src: 'paste', ops: [[0, 0, PASTED.length]] }, [PASTED]);
    add('edit', { doc: 'ch-1', src: 'typed', ops: [[0, PASTED.length, 0]] });
    add('edit', { doc: 'ch-1', src: 'typed', ops: [[0, 0, OWN.length]], from: [[0, 0, OWN.length, { n: 2, op: 0, at: 0 }]] }, [OWN]);
    add('edit', { doc: 'ch-1', src: 'typed', ops: [[0, 0, 5]], from: [[0, 0, 5, { n: 9, op: 0, at: 0 }]] }, ['Ahead']);
    const t = slog.trace(e);
    assert.deepEqual(t.problems.map((p) => [p.n, p.problem]), [
      [3, 'moved text doesn\'t match where it came from'],
      [4, 'from points ahead of itself']
    ]);
    // without the words, lengths are still checked and origins still carried
    const bare = e.map(({ x, ...clear }) => clear);
    assert.deepEqual(slog.trace(bare).problems.map((p) => p.n), [4]);
    assert.deepEqual(slog.trace(bare).docs['ch-1'].runs, [[5, 'typed'], [OWN.length, 'paste']]);
  });
});

// Two computers on one synced folder: text one wrote that turns up on the
// other is traced back to the chain that wrote it.
describe('Text from another device', { concurrency: 1 }, () => {
  const TYPED = 'The desktop typed this, carefully, word by word.';
  const PASTED = 'And this the desktop pasted from somewhere outside.';
  const ON_LAPTOP = 'Then the laptop added a line of its own.';
  const laptopOf = (env) => new slog.Recorder({ home: path.join(env.root, 'laptop'), app: 'test', now: () => (env.clock += 1000), onError: (w, err) => env.errors.push(w + ': ' + err.message) });
  const deviceOf = (rec) => rec.device();
  function origins(d, doc, needle) {
    const t = d.traced[doc];
    const at = t.text.indexOf(needle);
    assert.ok(at >= 0, `"${needle}" is in ${doc}`);
    return slog.originsAt(t, at, needle.length).map(([, o]) => o);
  }
  // the desktop types a chapter and pastes into it
  async function desktopWrites(env) {
    const desk = env.recorder();
    desk.open(env.dir, 'book-a');
    const one = `<p>${TYPED}</p>`;
    desk.observe(env.dir, 'book-a', 'ch-1', one, { src: 'typed' });
    save(desk, env, 'ch-1', one);
    const two = one + `<p>${PASTED}</p>`;
    desk.observe(env.dir, 'book-a', 'ch-1', two, { src: 'paste' });
    save(desk, env, 'ch-1', two);
    await desk.close('book-a');
    return { desk, two };
  }

  test('the second computer\'s first look names the chain its text came from', async () => {
    const env = setup({ chapters: { 'ch-1': '' } });
    const { desk, two } = await desktopWrites(env);
    const laptop = laptopOf(env);
    laptop.open(env.dir, 'book-a');
    const three = two + `<p>${ON_LAPTOP}</p>`;
    laptop.observe(env.dir, 'book-a', 'ch-1', three, { src: 'typed' });
    save(laptop, env, 'ch-1', three);
    await laptop.close('book-a');
    const mine = entries(env).filter((e) => e.kind === 'base' && e.src === 'arrived' && e.doc === 'ch-1');
    assert.equal(mine.length, 1);
    assert.deepEqual(mine[0].from.map((p) => [p[3].dev, p[3].doc, p[3].at]), [[deviceOf(desk), 'ch-1', 0]]);
    let res = assertChecks(env);
    const lap = res.devices.find((d) => d.dev === deviceOf(laptop));
    assert.deepEqual(origins(lap, 'ch-1', TYPED), ['typed']);
    assert.deepEqual(origins(lap, 'ch-1', PASTED), ['paste']);
    assert.deepEqual(origins(lap, 'ch-1', ON_LAPTOP), ['typed']);
    assert.equal(lap.arrivals.unlinked, 0);
    // back on the desktop, the laptop's line arrives, named the same way
    const desk2 = env.recorder();
    desk2.open(env.dir, 'book-a');
    await desk2.close('book-a');
    const back = entries(env).filter((e) => e.kind === 'edit' && e.src === 'arrived' && e.doc === 'ch-1');
    assert.equal(back.length, 1);
    assert.deepEqual(back[0].from.map((p) => p[3].dev), [deviceOf(laptop)]);
    res = assertChecks(env);
    const d = res.devices.find((x) => x.dev === deviceOf(desk));
    assert.deepEqual(origins(d, 'ch-1', ON_LAPTOP), ['typed']);
    assert.deepEqual(origins(d, 'ch-1', PASTED), ['paste']);
    assert.deepEqual(env.errors, []);
  });

  test('when the other chain hadn\'t synced yet, the checker matches the text by its words', async () => {
    const env = setup({ chapters: { 'ch-1': '' } });
    const { desk } = await desktopWrites(env);
    // the laptop sees the chapters before the desktop's chunks reach it
    const logDir = path.join(env.dir, slog.LOG_DIR);
    const away = path.join(env.root, 'not-synced-yet');
    fs.mkdirSync(away);
    const theirs = fs.readdirSync(logDir).filter(slog.isChunkName);
    for (const n of theirs) fs.renameSync(path.join(logDir, n), path.join(away, n));
    const laptop = laptopOf(env);
    laptop.open(env.dir, 'book-a');
    await laptop.close('book-a');
    for (const n of theirs) fs.renameSync(path.join(away, n), path.join(logDir, n));
    const base = entries(env).find((e) => e.kind === 'base' && e.src === 'arrived' && e.doc === 'ch-1');
    assert.equal(base.from, undefined);
    const res = assertChecks(env);
    const lap = res.devices.find((d) => d.dev === deviceOf(laptop));
    assert.deepEqual(origins(lap, 'ch-1', PASTED), ['paste']);
    // (the chapter and the book document; the notes are empty)
    assert.deepEqual([lap.arrivals.recorded, lap.arrivals.matched, lap.arrivals.unlinked], [0, 2, 0]);
    assert.deepEqual(lap.arrivals.from, { [res.devices.find((d) => d.dev === deviceOf(desk)).name]: 2 });
  });
});

