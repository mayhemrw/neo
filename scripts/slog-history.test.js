'use strict';

// Versions rebuilt from the Scribe's Log (slog-history.js): every
// chapter's session versions across every computer's chain, each rebuilt
// to exactly the text that was saved then, from checkpoints or from the
// start, and nothing wrong shown when the log is damaged.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');
const slog = require('../slog.js');
const F = require('../slog-files.js');
const { History, chapterWords } = require('../slog-history.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-history-'));
let made = 0;

function setup({ chapters = { 'ch-1': '<p>Hello.</p>' }, titles = {} } = {}) {
  const root = path.join(tmpRoot, String(++made));
  const dir = path.join(root, 'book-a');
  fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
  const meta = { id: 'book-a', title: 'A Book', author: 'Ada', chapterOrder: Object.keys(chapters), chapterTitles: titles };
  fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify(meta, null, 2));
  for (const [id, html] of Object.entries(chapters)) fs.writeFileSync(path.join(dir, 'chapters', id + '.html'), html);
  fs.writeFileSync(path.join(dir, 'notes.html'), '');
  const env = { root, dir, meta, clock: Date.UTC(2026, 9, 8, 16, 0, 0), errors: [], saved: [] };
  env.recorder = (home = 'desk') => new slog.Recorder({
    home: path.join(root, home), app: 'test', now: () => (env.clock += 1000),
    onError: (where, err) => env.errors.push(where + ': ' + err.message)
  });
  env.history = (opts = {}) => new History({ home: path.join(root, 'history'), onError: (w, err) => env.errors.push(w + ': ' + err.message), ...opts });
  return env;
}
// a save through main.js: touch, write, tell; remembered with the chain's
// entry number after it, so a version can be checked against it
function save(rec, env, id, html) {
  rec.touch(env.dir, 'book-a');
  fs.writeFileSync(path.join(env.dir, 'chapters', id + '.html'), html);
  rec.wrote(env.dir, 'book-a', slog.chapterDoc(id), html);
}
function saveMeta(rec, env, meta) {
  rec.beforeMeta(env.dir, 'book-a', meta);
  fs.writeFileSync(path.join(env.dir, 'book.json'), JSON.stringify(meta, null, 2));
  rec.metaWritten(env.dir, 'book-a', meta);
  env.meta = meta;
}
async function session(rec, env, edits) {
  rec.open(env.dir, 'book-a');
  for (const [id, html] of edits) save(rec, env, id, html);
  await rec.close('book-a');
}

describe('History', { concurrency: 1 }, () => {
  test('one version per session per chapter, each rebuilt exactly', async () => {
    const env = setup({ chapters: { 'ch-1': '<p>Hello.</p>', 'ch-2': '<p>Second.</p>' }, titles: { 'ch-2': 'The Middle' } });
    const rec = env.recorder();
    await session(rec, env, []);                                                  // the baseline
    await session(rec, env, [['ch-1', '<p>Hello there.</p>'], ['ch-1', '<p>Hello there, you.</p>']]);
    await session(rec, env, [['ch-2', '<p>Second, longer now.</p>']]);
    await session(rec, env, [['ch-1', '<p>Hello there, you. A new line.</p><p>And more.</p>']]);
    const h = env.history();
    const ix = h.index(env.dir);
    assert.deepEqual(ix.problems, []);
    assert.equal(ix.devices.length, 1);
    assert.equal(ix.devices[0].name, 'Device 1');
    const ch1 = ix.chapters['ch-1'];
    assert.equal(ch1.inBook, true);
    assert.equal(ch1.order, 0);
    assert.deepEqual(ch1.versions.map((v) => [v.kind, v.words, v.delta]), [['baseline', 1, 1], ['session', 3, 2], ['session', 8, 5]]);
    assert.deepEqual(ix.chapters['ch-2'].versions.map((v) => [v.kind, v.words]), [['baseline', 1], ['session', 3]]);
    assert.equal(ix.chapters['ch-2'].title, 'The Middle');
    const texts = ch1.versions.map((v) => h.text(env.dir, v.dev, v.n, 'ch-1').text);
    assert.deepEqual(texts, ['<p>Hello.</p>', '<p>Hello there, you.</p>', '<p>Hello there, you. A new line.</p><p>And more.</p>']);
    // a session that didn't touch a chapter made no version of it
    assert.ok(ch1.versions.every((v) => v.ts > 0 && v.start <= v.ts));
    assert.deepEqual(env.errors, []);
  });

  test('a version is the chapter at the session\'s end, not partway', async () => {
    const env = setup();
    const rec = env.recorder();
    await session(rec, env, [['ch-1', '<p>One.</p>'], ['ch-1', '<p>One. Two.</p>'], ['ch-1', '<p>One. Two. Three.</p>']]);
    const h = env.history();
    const v = h.index(env.dir).chapters['ch-1'].versions;
    assert.equal(v.length, 1, 'the baseline and the writing were one session');
    assert.equal(h.text(env.dir, v[0].dev, v[0].n, 'ch-1').text, '<p>One. Two. Three.</p>');
  });

  test('text that only arrived is the other computer\'s version, not this one\'s', async () => {
    const env = setup();
    const desk = env.recorder('desk');
    await session(desk, env, [['ch-1', '<p>From the desk.</p>']]);
    const laptop = env.recorder('laptop');
    await session(laptop, env, [['ch-1', '<p>From the desk, then the laptop.</p>']]);
    // back on the desk: the laptop's words arrive, and the desk writes on
    await session(desk, env, []);
    await session(desk, env, [['ch-1', '<p>From the desk, then the laptop, then the desk.</p>']]);
    const h = env.history();
    const ix = h.index(env.dir);
    assert.deepEqual(ix.problems, []);
    assert.equal(ix.devices.length, 2);
    const v = ix.chapters['ch-1'].versions;
    const deskDev = ix.devices.find((d) => d.name === 'Device 1').dev;
    const lapDev = ix.devices.find((d) => d.name === 'Device 2').dev;
    assert.deepEqual(v.map((x) => x.dev), [deskDev, lapDev, deskDev], 'no version for the session that only saw the laptop\'s words');
    assert.deepEqual(v.map((x) => h.text(env.dir, x.dev, x.n, 'ch-1').text),
      ['<p>From the desk.</p>', '<p>From the desk, then the laptop.</p>', '<p>From the desk, then the laptop, then the desk.</p>']);
    assert.deepEqual(env.errors, []);
  });

  test('a deleted chapter keeps its versions, the last as it stood before it went', async () => {
    const env = setup({ chapters: { 'ch-1': '<p>Keep.</p>', 'ch-2': '<p>Going soon.</p>' }, titles: { 'ch-2': 'Doomed' } });
    const rec = env.recorder();
    await session(rec, env, [['ch-2', '<p>Going soon, after this.</p>']]);
    rec.open(env.dir, 'book-a');
    saveMeta(rec, env, { ...env.meta, chapterOrder: ['ch-1'], chapterTitles: {} });
    rec.touch(env.dir, 'book-a');
    fs.unlinkSync(path.join(env.dir, 'chapters', 'ch-2.html'));
    rec.removed(env.dir, 'book-a', 'ch-2');
    await rec.close('book-a');
    const h = env.history();
    const ch2 = h.index(env.dir).chapters['ch-2'];
    assert.equal(ch2.inBook, false);
    assert.equal(ch2.title, 'Doomed', 'the title it last had');
    assert.deepEqual(ch2.was, { at: 1, after: 'ch-1' });
    const last = ch2.versions[ch2.versions.length - 1];
    assert.equal(last.gone, true);
    assert.equal(h.text(env.dir, last.dev, last.n, 'ch-2').text, '<p>Going soon, after this.</p>');
  });

  test('a second look reads only the sessions since, from the tail checkpoint', async () => {
    const env = setup();
    const rec = env.recorder();
    await session(rec, env, [['ch-1', '<p>One.</p>']]);
    await session(rec, env, [['ch-1', '<p>One. Two.</p>']]);
    const h = env.history();
    const first = h.index(env.dir);
    await session(rec, env, [['ch-1', '<p>One. Two. Three.</p>']]);
    // the earlier chunks aren't read again: make them unreadable as text
    // without changing their size, and the index still comes out right
    const reads = [];
    const orig = F.listLog;
    F.listLog = (dir) => {
      const l = orig(dir);
      for (const [name, f] of l.files) { const read = f.read; f.read = () => { reads.push(name); return read(); }; }
      return l;
    };
    try {
      const second = h.index(env.dir);
      assert.equal(second.chapters['ch-1'].versions.length, first.chapters['ch-1'].versions.length + 1);
      const chunkReads = reads.filter(slog.isChunkName);
      assert.equal(chunkReads.length, 1, 'only the new session\'s chunk: ' + chunkReads.join(', '));
    } finally { F.listLog = orig; }
    const fresh = env.history({ home: path.join(env.root, 'history-2') }).index(env.dir);
    const again = h.index(env.dir);
    assert.deepEqual(again.chapters, fresh.chapters, 'the same as building it from nothing');
  });

  test('a missing or wrong checkpoint is rebuilt from the log', async () => {
    const env = setup();
    const rec = env.recorder();
    for (let i = 1; i <= 6; i++) await session(rec, env, [['ch-1', `<p>${'Word '.repeat(i).trim()}.</p>`]]);
    const h = env.history({ every: 5 });
    const ix = h.index(env.dir);
    const logId = ix.logId;
    const cpDir = path.join(env.root, 'history', logId);
    const files = fs.readdirSync(cpDir).filter((f) => f.endsWith('.json.gz'));
    assert.ok(files.length >= 2, 'periodic checkpoints and the tail: ' + files.join(', '));
    const want = ix.chapters['ch-1'].versions.map((v) => h.text(env.dir, v.dev, v.n, 'ch-1').text);
    assert.deepEqual(want.map((t) => chapterWords(t)), ix.chapters['ch-1'].versions.map((v) => v.words));
    // every checkpoint gone: the same texts, from the start
    for (const f of files) fs.rmSync(path.join(cpDir, f));
    assert.deepEqual(ix.chapters['ch-1'].versions.map((v) => h.text(env.dir, v.dev, v.n, 'ch-1').text), want);
    // a checkpoint with the wrong documents in it under the right name is
    // caught by its own record of the entry it follows
    h.index(env.dir);
    const cache = JSON.parse(fs.readFileSync(path.join(cpDir, 'index.json'), 'utf8'));
    const chain = Object.values(cache.chains)[0];
    chain.tail.h = '0'.repeat(64);
    fs.writeFileSync(path.join(cpDir, 'index.json'), JSON.stringify(cache));
    assert.deepEqual(ix.chapters['ch-1'].versions.map((v) => h.text(env.dir, v.dev, v.n, 'ch-1').text), want);
    assert.deepEqual(h.index(env.dir).chapters, ix.chapters);
  });

  test('a damaged session: earlier versions rebuild, later ones say they can\'t', async () => {
    const env = setup();
    const rec = env.recorder();
    await session(rec, env, [['ch-1', '<p>One.</p>']]);
    await session(rec, env, [['ch-1', '<p>One. Two.</p>']]);
    await session(rec, env, [['ch-1', '<p>One. Two. Three.</p>']]);
    const logDir = path.join(env.dir, slog.LOG_DIR);
    const names = fs.readdirSync(logDir).filter(slog.isChunkName).sort();
    // the middle session's edit loses its words
    const mid = path.join(logDir, names[1]);
    const lines = fs.readFileSync(mid, 'utf8').split('\n');
    const i = lines.findIndex((l) => l.includes('"kind":"edit"'));
    const e = JSON.parse(lines[i]);
    e.ops = [[999, 5, 0]];
    lines[i] = JSON.stringify(e);
    fs.writeFileSync(mid, lines.join('\n'));
    const h = env.history();
    const ix = h.index(env.dir);
    assert.equal(ix.problems.length, 1);
    assert.match(ix.problems[0], /doesn't replay/);
    const v = ix.chapters['ch-1'].versions;
    assert.deepEqual(v.map((x) => x.broken), [false, true, true]);
    assert.equal(h.text(env.dir, v[0].dev, v[0].n, 'ch-1').text, '<p>One.</p>');
    assert.match(h.text(env.dir, v[2].dev, v[2].n, 'ch-1').error, /doesn't replay/);
  });

  test('archived sessions read the same as loose ones', async () => {
    const env = setup();
    const rec = env.recorder();
    await session(rec, env, [['ch-1', '<p>One.</p>']]);
    await session(rec, env, [['ch-1', '<p>One. Two.</p>']]);
    const before = env.history({ home: path.join(env.root, 'h1') }).index(env.dir);
    const dev = before.devices[0].dev;
    F.mergeIntoArchive(env.dir, { dev, now: () => env.clock + 1000 });
    assert.ok(fs.readdirSync(path.join(env.dir, slog.LOG_DIR)).some((n) => n.startsWith('archive-')));
    const h = env.history({ home: path.join(env.root, 'h2') });
    const after = h.index(env.dir);
    assert.deepEqual(after.chapters, before.chapters);
    const v = after.chapters['ch-1'].versions;
    assert.equal(h.text(env.dir, v[1].dev, v[1].n, 'ch-1').text, '<p>One. Two.</p>');
  });

  test('rebuilding works with no index yet, and past what the index knows', async () => {
    const env = setup();
    const rec = env.recorder();
    for (let i = 1; i <= 4; i++) await session(rec, env, [['ch-1', `<p>${'Step '.repeat(i).trim()}.</p>`]]);
    const h = env.history({ every: 3 });
    const fresh = env.history({ home: path.join(env.root, 'never-indexed') });
    const ix = h.index(env.dir);
    const v = ix.chapters['ch-1'].versions;
    for (const x of v) assert.equal(fresh.text(env.dir, x.dev, x.n, 'ch-1').text, h.text(env.dir, x.dev, x.n, 'ch-1').text);
    await session(rec, env, [['ch-1', '<p>Step step step step step.</p>']]);
    const dev = v[0].dev;
    const head = slog.parseChunk(fs.readFileSync(path.join(env.dir, slog.LOG_DIR, fs.readdirSync(path.join(env.dir, slog.LOG_DIR)).filter(slog.isChunkName).sort().pop()), 'utf8')).entries.pop().n;
    assert.equal(h.text(env.dir, dev, head, 'ch-1').text, '<p>Step step step step step.</p>', 'a session the index hasn\'t seen');
    assert.match(h.text(env.dir, dev, head + 5, 'ch-1').error, /isn't in that computer's chain/);
  });

  test('a book with no log says so', () => {
    const env = setup();
    const ix = env.history().index(env.dir);
    assert.equal(ix.logId, null);
    assert.deepEqual(ix.chapters, {});
    assert.match(env.history().rebuild(env.dir, 'x', 1).error, /no Scribe's Log/);
  });
});
