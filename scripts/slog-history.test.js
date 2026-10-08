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
const H = require('../slog-history.js');
const { History, chapterWords } = H;

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

  test('playback for the window: the chapter\'s changes on every computer, from a version or its start', async () => {
    const env = setup();
    const desk = env.recorder('desk');
    await session(desk, env, [['ch-1', '<p>From the desk.</p>']]);
    const laptop = env.recorder('laptop');
    await session(laptop, env, [['ch-1', '<p>From the desk, then the laptop.</p>']]);
    // the desk reads the laptop's words (NEO's refresh from disk), then writes on
    desk.open(env.dir, 'book-a');
    desk.read(env.dir, 'book-a', 'ch-1', fs.readFileSync(path.join(env.dir, 'chapters', 'ch-1.html'), 'utf8'));
    save(desk, env, 'ch-1', '<p>From the desk, then the laptop, then the desk.</p>');
    await desk.close('book-a');
    const h = env.history();
    const P = require('../slog-playback.js');
    const all = P.Playback.fromData(h.playback(env.dir, 'ch-1'));
    assert.deepEqual(all.problems, []);
    assert.deepEqual(Array.from({ length: all.length }, (_, i) => all.frame(i + 1).text),
      ['<p>Hello.</p>', '<p>From the desk.</p>', '<p>From the desk, then the laptop.</p>', '<p>From the desk, then the laptop, then the desk.</p>']);
    assert.deepEqual(all.steps.map((s) => s.name), ['Device 1', 'Device 1', 'Device 2', 'Device 1']);
    // from the laptop's version: only the desk's last change after it
    const v = h.index(env.dir).chapters['ch-1'].versions;
    const lap = v.find((x) => x.dev !== v[0].dev);
    const later = P.Playback.fromData(h.playback(env.dir, 'ch-1', { from: { dev: lap.dev, n: lap.n } }));
    assert.equal(later.length, 1);
    assert.equal(later.frame(0).text, '<p>From the desk, then the laptop.</p>');
    assert.match(later.frame(1).html, /<span class="pb-new">, then the desk<\/span>/);
    // a book with no log has nothing to play
    fs.rmSync(path.join(env.dir, 'scribes-log'), { recursive: true });
    assert.match(h.playback(env.dir, 'ch-1').error, /no Scribe's Log/);
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

  test('with a session still open (the book open in NEO), every earlier version rebuilds exactly', async () => {
    const env = setup();
    const rec = env.recorder();
    await session(rec, env, [['ch-1', '<p>Draft one.</p>']]);
    await session(rec, env, [['ch-1', '<p>Draft two.</p>']]);
    rec.open(env.dir, 'book-a');
    save(rec, env, 'ch-1', '<p>Draft three, still being written.</p>');
    await rec.head(env.dir, 'book-a');
    // the History window looks while the open session goes on, twice
    for (let look = 0; look < 2; look++) {
      const h = env.history();
      const v = h.index(env.dir).chapters['ch-1'].versions;
      assert.deepEqual(v.map((x) => h.text(env.dir, x.dev, x.n, 'ch-1').text),
        ['<p>Draft one.</p>', '<p>Draft two.</p>', '<p>Draft three, still being written.</p>'], 'look ' + look);
      save(rec, env, 'ch-1', '<p>Draft three, still being written.</p><p>More.</p>');
      await rec.head(env.dir, 'book-a');
      assert.equal(h.text(env.dir, v[1].dev, v[1].n, 'ch-1').text, '<p>Draft two.</p>');
      save(rec, env, 'ch-1', '<p>Draft three, still being written.</p>');
      await rec.head(env.dir, 'book-a');
    }
    await rec.close('book-a');
    assert.deepEqual(env.errors, []);
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

// The book's versions/ folder: named versions (from the log, or from a copy
// of the book with it off) and the copies log-off sessions leave behind.
describe('Versions in the book', { concurrency: 1 }, () => {
  const DEV_A = 'a'.repeat(32);
  const DEV_B = 'b'.repeat(32);
  const vdir = (env) => path.join(env.dir, H.VERSIONS_DIR);
  const write = (env, id, html) => fs.writeFileSync(path.join(env.dir, 'chapters', id + '.html'), html);

  test('names are one clean line; each file is written once', () => {
    const env = setup();
    assert.equal(H.cleanName('  Sent\tto\n Maria\u0007 '), 'Sent to Maria');
    assert.equal(H.cleanName('x'.repeat(500)).length, 120);
    assert.equal(H.cleanName(' \n '), '');
    const at = Date.UTC(2026, 9, 8, 19, 3, 12);
    const head = { dev: DEV_A, n: 4, h: 'c'.repeat(64) };
    const a = H.writeNamed(env.dir, { name: 'Sent to Maria', at, dev: DEV_A, head });
    const b = H.writeNamed(env.dir, { name: 'Same second', at, dev: DEV_A, head, auto: 'restore' });
    assert.equal(a.file, '20261008T190312Z-aaaaaaaa.json');
    assert.equal(b.file, '20261008T190312Z-aaaaaaaa-2.json');
    assert.deepEqual({ ...a }, { file: a.file, name: 'Sent to Maria', at, dev: DEV_A, auto: null, n: 4, h: head.h });
    assert.equal(b.auto, 'restore');
    assert.throws(() => H.writeNamed(env.dir, { name: '  ', at, dev: DEV_A, head }), /needs a name/);
    // what isn't a named version is passed over: half-written, a sync
    // service's conflict copy, someone else's file, nonsense
    fs.writeFileSync(path.join(vdir(env), '20261008T190312Z-aaaaaaaa.json.tmp'), '{');
    fs.writeFileSync(path.join(vdir(env), '20261008T190312Z-aaaaaaaa (1).json'), fs.readFileSync(path.join(vdir(env), a.file)));
    fs.writeFileSync(path.join(vdir(env), 'notes.json'), '{}');
    fs.writeFileSync(path.join(vdir(env), '20261008T200000Z-aaaaaaaa.json'), '{"v":1,"name":"no head","at":1,"dev":"x"}');
    assert.deepEqual(H.listNamed(env.dir).map((v) => v.name), ['Sent to Maria', 'Same second']);
    // renaming rewrites that file only; deleting removes it
    const r = H.renameNamed(env.dir, a.file, ' For the agent ');
    assert.equal(r.name, 'For the agent');
    assert.equal(JSON.parse(fs.readFileSync(path.join(vdir(env), a.file), 'utf8')).n, 4);
    assert.throws(() => H.renameNamed(env.dir, '../book.json', 'x'), /isn't there/);
    assert.equal(H.deleteNamed(env.dir, b.file), true);
    assert.equal(H.deleteNamed(env.dir, b.file), false);
    assert.deepEqual(H.listNamed(env.dir).map((v) => v.name), ['For the agent']);
  });

  test('a named version from the log is the book where the chain stood', async () => {
    const env = setup({ chapters: { 'ch-1': '<p>First.</p>' } });
    const rec = env.recorder();
    rec.open(env.dir, 'book-a');
    save(rec, env, 'ch-1', '<p>First, then second.</p>');
    const head = await rec.head(env.dir, 'book-a');
    assert.equal(head.dev, rec.device());
    const named = H.writeNamed(env.dir, { name: 'Sent to Maria', at: env.clock, dev: head.dev, head });
    save(rec, env, 'ch-1', '<p>Rewritten after.</p>');
    await rec.close('book-a');
    const h = env.history();
    assert.equal(h.versionText(env.dir, { named: named.file }, 'ch-1').text, '<p>First, then second.</p>');
    assert.match(h.versionText(env.dir, { named: named.file }, 'ch-9').error, /didn't exist then/);
    // the same from a checkpoint at exactly that entry
    const cp = env.history({ home: path.join(env.root, 'other'), every: 1 });
    cp.index(env.dir);
    assert.equal(cp.versionText(env.dir, { named: named.file }, 'ch-1').text, '<p>First, then second.</p>');
    // a version file pointing at the wrong entry shows nothing
    const file = path.join(vdir(env), named.file);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...raw, h: 'f'.repeat(64) }));
    assert.match(h.versionText(env.dir, { named: named.file }, 'ch-1').error, /doesn't match the book's log/);
    fs.writeFileSync(file, JSON.stringify({ ...raw, n: raw.n + 50 }));
    assert.match(h.versionText(env.dir, { named: named.file }, 'ch-1').error, /isn't in that computer's chain/);
    // nothing in versions/ is a document of the book, or part of its log
    assert.ok(!Object.keys(slog.readBookDocs(env.dir).docs).some((d) => /version/.test(d)));
    assert.deepEqual(h.index(env.dir).problems, []);
    assert.deepEqual(env.errors, []);
  });

  test('with the log off: no head, and a session copies only what changed', async () => {
    const env = setup({ chapters: { 'ch-1': '<p>One.</p>', 'ch-2': '<p>Two.</p>', 'ch-3': '<p>Three.</p>' }, titles: { 'ch-2': 'Middle' } });
    saveMeta(env.recorder(), env, { ...env.meta, scribesLog: false });
    const rec = env.recorder();
    assert.equal(await rec.head(env.dir, 'book-a'), null);
    let clock = Date.UTC(2026, 9, 8, 20, 15, 0);
    const copies = new H.SessionCopies({ dev: () => DEV_A, now: () => (clock += 60000) });
    // a session: two chapters saved, one of them back to what it was
    write(env, 'ch-1', '<p>One, longer.</p>');
    copies.saved(env.dir, 'book-a', 'ch-1');
    copies.saved(env.dir, 'book-a', 'ch-2');
    const first = copies.end('book-a');
    assert.match(first, /^\d{8}T\d{6}Z-aaaaaaaa\.json\.gz$/);
    let c = H.readCopy(env.dir, first);
    assert.deepEqual(Object.keys(c.chapters).sort(), ['ch-1', 'ch-2'], 'nothing copied before: both are new');
    assert.deepEqual(c.titles, { 'ch-2': 'Middle' });
    assert.deepEqual(c.order, ['ch-1', 'ch-2', 'ch-3']);
    assert.equal(copies.end('book-a'), null, 'one copy per session');
    // a session that saved without changing anything copies nothing
    copies.saved(env.dir, 'book-a', 'ch-1');
    assert.equal(copies.end('book-a'), null);
    // another computer's newer copy counts: only what differs from it goes
    write(env, 'ch-2', '<p>Two, from the laptop.</p>');
    H.writeCopy(env.dir, { dev: DEV_B, at: (clock += 60000), chapters: { 'ch-2': '<p>Two, from the laptop.</p>' }, meta: env.meta });
    write(env, 'ch-1', '<p>One, longer still.</p>');
    copies.saved(env.dir, 'book-a', 'ch-1');
    copies.saved(env.dir, 'book-a', 'ch-2');
    // a deleted chapter keeps its last words, marked gone
    copies.deleting(env.dir, 'book-a', 'ch-3', '<p>Three, last words.</p>');
    fs.rmSync(path.join(env.dir, 'chapters', 'ch-3.html'));
    const third = copies.end('book-a');
    c = H.readCopy(env.dir, third);
    assert.deepEqual(c.chapters, { 'ch-1': '<p>One, longer still.</p>', 'ch-3': '<p>Three, last words.</p>' });
    assert.deepEqual(c.gone, ['ch-3']);
    // gone stays gone: deleting it again copies nothing more
    copies.deleting(env.dir, 'book-a', 'ch-3', '<p>Three, last words.</p>');
    assert.equal(copies.end('book-a'), null);
    // the list: every chapter's copies as versions, with words and change
    const h = env.history();
    const list = h.list(env.dir);
    assert.equal(list.logId, null);
    assert.deepEqual(list.problems, []);
    assert.deepEqual(list.devices.map((d) => [d.dev, d.name]), [[DEV_A, 'Device 1'], [DEV_B, 'Device 2']]);
    assert.deepEqual(list.chapters['ch-1'].versions.map((v) => [v.kind, v.words, v.delta, v.dev]), [['saved', 2, 2, DEV_A], ['saved', 3, 1, DEV_A]]);
    assert.deepEqual(list.chapters['ch-2'].versions.map((v) => [v.words, v.dev]), [[1, DEV_A], [4, DEV_B]]);
    assert.equal(list.chapters['ch-2'].title, 'Middle');
    const ch3 = list.chapters['ch-3'];
    assert.equal(ch3.versions[0].gone, true);
    assert.deepEqual(ch3.was, { at: 2, after: 'ch-2' });
    assert.equal(h.versionText(env.dir, { copy: ch3.versions[0].file }, 'ch-3').text, '<p>Three, last words.</p>');
    assert.match(h.versionText(env.dir, { copy: first }, 'ch-3').error, /didn't exist then/);
  });

  test('a session left idle ends on its own; a dropped book copies nothing', async () => {
    const env = setup();
    const copies = new H.SessionCopies({ dev: () => DEV_A, idleMs: 20 });
    write(env, 'ch-1', '<p>Hello again.</p>');
    copies.saved(env.dir, 'book-a', 'ch-1');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(copies.open('book-a'), false);
    assert.equal(H.listCopies(env.dir).length, 1);
    write(env, 'ch-1', '<p>Hello once more.</p>');
    copies.saved(env.dir, 'book-a', 'ch-1');
    copies.drop('book-a');
    copies.endAll();
    assert.equal(H.listCopies(env.dir).length, 1);
  });

  test('a named version with the log off copies the whole book, kept apart from session versions', () => {
    const env = setup({ chapters: { 'ch-1': '<p>One.</p>', 'ch-2': '<p>Two.</p>' } });
    const at = Date.UTC(2026, 9, 8, 21, 0, 0);
    const copy = H.copyWholeBook(env.dir, { dev: DEV_A, at });
    const named = H.writeNamed(env.dir, { name: 'Before the big rewrite', at, dev: DEV_A, copy });
    assert.equal(named.copy, copy);
    assert.equal(H.readCopy(env.dir, copy).all, true);
    const h = env.history();
    assert.equal(h.versionText(env.dir, { named: named.file }, 'ch-2').text, '<p>Two.</p>');
    const list = h.list(env.dir);
    assert.deepEqual(list.chapters, {}, 'the whole-book copy is the named version, not a session of every chapter');
    assert.deepEqual(list.named.map((v) => v.name), ['Before the big rewrite']);
    // deleting the version takes its copy with it
    H.deleteNamed(env.dir, named.file);
    assert.deepEqual(fs.readdirSync(vdir(env)), []);
  });

  test('a book whose log was off for a while: log versions and copies in one list', async () => {
    const env = setup({ chapters: { 'ch-1': '<p>Logged.</p>' } });
    const rec = env.recorder();
    await session(rec, env, [['ch-1', '<p>Logged, then more.</p>']]);
    saveMeta(rec, env, { ...env.meta, scribesLog: false });
    const copies = new H.SessionCopies({ dev: () => rec.device(), now: () => (env.clock += 1000) });
    write(env, 'ch-1', '<p>Written with the log off, at length.</p>');
    copies.saved(env.dir, 'book-a', 'ch-1');
    copies.end('book-a');
    const meta = { ...env.meta };
    delete meta.scribesLog;
    saveMeta(rec, env, meta);
    await session(rec, env, [['ch-1', '<p>Logged again.</p>']]);
    const list = env.history().list(env.dir);
    assert.deepEqual(list.problems, []);
    assert.equal(list.devices.length, 1, 'the copies\' computer is the log\'s own');
    const v = list.chapters['ch-1'].versions;
    assert.deepEqual(v.map((x) => [x.kind, x.words]), [['baseline', 3], ['saved', 7], ['session', 2]]);
    assert.ok(v.every((x, i) => !i || v[i - 1].ts <= x.ts));
    assert.deepEqual(env.errors, []);
  });

  test('a restore\'s source: the version\'s text, and what this computer deleted since it', async () => {
    const LONG = 'A paragraph long enough to be found again, word for word.';
    const OTHER = 'Something else entirely, never in that version at all.';
    const env = setup({ chapters: { 'ch-1': `<p>${LONG}</p>`, 'ch-2': `<p>${OTHER}</p>` } });
    const rec = env.recorder();
    await session(rec, env, []);
    await session(rec, env, [['ch-1', `<p>${LONG}</p><p>Two.</p>`]]);
    rec.open(env.dir, 'book-a');
    const head = await rec.head(env.dir, 'book-a');
    const named = H.writeNamed(env.dir, { name: 'Midway', at: env.clock, dev: rec.device(), head });
    save(rec, env, 'ch-1', '<p>Two.</p>');
    save(rec, env, 'ch-2', '<p>Gone.</p>');
    await rec.close('book-a');
    const h = env.history();
    const v = h.index(env.dir).chapters['ch-1'].versions;
    const me = rec.device();
    // this computer's version: deletions after its own entry, oldest first;
    // the other chapter's (no words in common) and the version's own are left out
    const got = h.restoreSource(env.dir, { dev: me, n: v[1].n }, 'ch-1', { me });
    assert.equal(got.text, `<p>${LONG}</p><p>Two.</p>`);
    assert.ok(got.dels.length >= 1 && got.dels.every((d) => d.n > v[1].n && typeof d.op === 'number' && d.json === false));
    assert.ok(got.dels.some((d) => d.text.includes(LONG)));
    assert.ok(!got.dels.some((d) => d.text.includes('else entirely')));
    assert.ok(got.dels.every((d, i) => !i || got.dels[i - 1].n <= d.n));
    // from the start of the chain, the baseline's own text is in what was deleted too
    assert.equal(h.restoreSource(env.dir, { dev: me, n: v[0].n }, 'ch-1', { me }).dels.length, got.dels.length);
    // a named version: from its entry
    const byName = h.restoreSource(env.dir, { named: named.file }, 'ch-1', { me });
    assert.equal(byName.text, `<p>${LONG}</p><p>Two.</p>`);
    assert.ok(byName.dels.length && byName.dels.every((d) => d.n > head.n));
    // another computer's version: this chain's sessions ended by its time
    const other = h.restoreSource(env.dir, { dev: me, n: v[1].n }, 'ch-1', { me: 'f'.repeat(32), at: v[1].ts });
    assert.deepEqual(other.dels, [], 'a chain this log doesn\'t have deleted nothing');
    // with the log off, the text alone
    assert.deepEqual(h.restoreSource(env.dir, { dev: me, n: v[1].n }, 'ch-1', { me, logged: false }), { text: got.text, dels: [] });
    assert.ok(h.restoreSource(env.dir, { dev: me, n: v[1].n }, 'no-such', { me }).error);
    assert.deepEqual(env.errors, []);
  });

  test('a recorder handed a restore\'s deletions points the restored words at them', async () => {
    const LONG = 'A paragraph long enough to be found again, word for word.';
    const env = setup({ chapters: { 'ch-1': `<p>${LONG}</p>` } });
    await session(env.recorder(), env, []);
    await session(env.recorder(), env, [['ch-1', '<p>Short now.</p>']]);
    const v = env.history().index(env.dir).chapters['ch-1'].versions[0];
    const rec = env.recorder();
    rec.open(env.dir, 'book-a');
    await rec.head(env.dir, 'book-a');
    const got = env.history().restoreSource(env.dir, { dev: v.dev, n: v.n }, 'ch-1', { me: rec.device() });
    assert.equal(rec.restoring(env.dir, 'book-a', got.dels), got.dels.length);
    assert.equal(rec.restoring(env.dir, 'book-a', got.dels), 0, 'each deletion once');
    assert.equal(rec.restoring(env.dir, 'book-b', got.dels), 0, 'only the book it\'s for');
    rec.observe(env.dir, 'book-a', 'ch-1', got.text, { src: 'move', cause: 'restore' });
    save(rec, env, 'ch-1', got.text);
    await rec.close('book-a');
    const logDir = path.join(env.dir, slog.LOG_DIR);
    const all = F.chunkNames(F.listLog(env.dir)).flatMap((n) => slog.parseChunk(fs.readFileSync(path.join(logDir, n), 'utf8')).entries);
    const r = all.find((e) => e.kind === 'edit' && e.cause === 'restore');
    assert.equal(r.src, 'move');
    assert.ok(r.from.some((p) => p[3].n === got.dels[0].n && p[3].op === got.dels[0].op));
    assert.deepEqual(env.errors, []);
  });
});
