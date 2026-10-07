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
      ['open', '', ''], ['edit', 'book', 'arrived'], ['edit', 'ch-1', 'arrived'],
      ['edit', 'ch-2', 'arrived'], ['doc', 'ch-2', 'del'], ['close', '', '']
    ]);
    assert.deepEqual(second[1].keys, ['chapterOrder']);
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
    rec.created(env.dir, 'book-a', token);
    save(rec, env, 'ch-9', '<p>It began.</p>');
    await rec.close('book-a');
    const sha = slog.sha256hex(fs.readFileSync(file));
    const bases = entries(env).filter((x) => x.kind === 'base');
    assert.deepEqual(bases.map((x) => [x.doc, x.src, x.file && x.file.sha256]), [['book', 'import', sha], ['ch-9', 'import', sha]]);
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
