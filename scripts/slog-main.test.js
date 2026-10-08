'use strict';

// The Scribe's Log as main.js wires it: the real handlers, loaded the way
// scripts/filesystem.test.js loads them (Electron replaced, a temporary
// library and userData), driven the way the window drives them.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { describe, test } = require('node:test');
const slog = require('../slog.js');
const { checkBook, checkZip } = require('./slog-check.js');
const F = require('../slog-files.js');

const root = path.join(__dirname, '..');
const localRequire = createRequire(path.join(root, 'main.js'));
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-slog-user-'));

let saveAs = null; // where a save dialog "chooses", or null to cancel
let offered = null; // the name the last save dialog offered
function loadMain() {
  const handlers = new Map();
  const sent = [];
  const electron = {
    app: {
      commandLine: { appendSwitch() {} },
      getPath: (name) => (name === 'userData' ? userData : os.tmpdir()),
      getVersion: () => '1.4.2',
      getLocale: () => 'en',
      requestSingleInstanceLock: () => true,
      whenReady: () => ({ then() {} }),
      on() {}
    },
    ipcMain: { on() {}, handle: (name, fn) => handlers.set(name, fn) },
    BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
    Menu: { buildFromTemplate: (items) => items, setApplicationMenu() {} },
    dialog: { showSaveDialog: async (_w, o) => { offered = path.basename(o.defaultPath); return saveAs ? { canceled: false, filePath: saveAs } : { canceled: true }; } },
    utilityProcess: { fork: () => ({ on() {}, postMessage() {} }) },
    screen: {}
  };
  const context = vm.createContext({
    require: (name) => name === 'electron' ? electron : localRequire(name),
    __dirname: root,
    process: { platform: process.platform, on() {} },
    console,
    libraryRoot: os.tmpdir()
  });
  vm.runInContext(source, context, { filename: path.join(root, 'main.js') });
  return {
    context,
    sent,
    call: (name, ...args) => handlers.get(name)(null, ...args),
    get: (expr) => vm.runInContext(expr, context),
    pointAt(dir) {
      context.libraryRoot = dir;
      vm.runInContext('LIBRARY_DIR = libraryRoot; LIBRARY_FILE = require("path").join(libraryRoot, "library.json");', context);
    }
  };
}

const main = loadMain();
function tempLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-slog-lib-'));
  main.pointAt(dir);
  return dir;
}
function entries(bookDir) {
  const logDir = path.join(bookDir, slog.LOG_DIR);
  return fs.readdirSync(logDir).filter(slog.isChunkName).sort()
    .flatMap((n) => slog.parseChunk(fs.readFileSync(path.join(logDir, n), 'utf8')).entries);
}
function assertChecks(bookDir) {
  const res = checkBook(bookDir);
  assert.deepEqual(res.problems, []);
  for (const d of res.devices) assert.deepEqual(d.problems, []);
  assert.deepEqual(res.devices[res.devices.length - 1].differ, []);
  assert.equal(res.ok, true);
  return res;
}
const errorLog = (lib) => { try { return fs.readFileSync(path.join(lib, 'neo-errors.log'), 'utf8'); } catch { return ''; } };

describe('Scribe\'s Log in main.js', { concurrency: 1 }, () => {
  test('a new book, written the way the window writes it', async () => {
    const lib = tempLibrary();
    const book = main.call('book:create', { title: 'Wool', author: 'Hugh' });
    const dir = path.join(lib, book.id);
    assert.ok(fs.existsSync(path.join(dir, slog.LOG_DIR, slog.LOG_INFO)));
    const st = main.call('slog:open', book.id);
    assert.equal(st.on, true);
    // the window describes each burst, then saves
    main.call('slog:observe', book.id, 'chapter', 'ch-1', '<p>Jules</p>', { src: 'typed', dur: 800, ev: 5 });
    main.call('chapter:write', book.id, 'ch-1', '<p>Jules</p>');
    main.call('slog:observe', book.id, 'chapter', 'ch-1', '<p>Jules climbed.</p>', { src: 'typed', dur: 900, ev: 9 });
    main.call('chapter:write', book.id, 'ch-1', '<p>Jules climbed.</p>', '<p>Jules</p>');
    main.call('slog:observe', book.id, 'aux', 'notes', '<p>a note</p>', { src: 'paste', dur: 0, ev: 1 });
    main.call('aux:write', book.id, 'notes', '<p>a note</p>');
    main.call('json:write', book.id, 'darlings', [{ id: 'd1', html: '<p>cut line</p>' }]);
    main.call('aux:write', book.id, 'scratch', '<p>not a logged document</p>');
    // the caret's place is bookkeeping; the chapter order isn't
    const meta = main.call('book:readMeta', book.id);
    main.call('book:writeMeta', book.id, { ...meta, lastPosition: { chapterId: 'ch-1', scroll: 3.5 } });
    main.call('book:writeMeta', book.id, { ...meta, chapterOrder: ['ch-1'], author: 'Hugh Howey' });
    await main.call('slog:event', book.id, { type: 'close' });
    const e = entries(dir);
    const edits = e.filter((x) => x.kind === 'edit');
    assert.deepEqual(edits.map((x) => [x.doc, x.src]), [
      ['book', 'typed'], ['darlings', 'typed'], ['stickies', 'typed'],
      ['ch-1', 'typed'], ['ch-1', 'typed'], ['notes', 'paste'], ['darlings', 'unlogged'], ['book', 'unlogged']
    ]);
    assert.deepEqual(edits[edits.length - 1].keys, ['author', 'chapterOrder']);
    assert.ok(!e.some((x) => x.doc === 'scratch'));
    assert.equal(e[0].app, '1.4.2+slog1');
    assert.equal(errorLog(lib), '');
    assertChecks(dir);
  });

  test('a book from before the log: nothing until it\'s opened or changed', async () => {
    const lib = tempLibrary();
    const book = main.call('book:create', { title: 'Old' });
    const dir = path.join(lib, book.id);
    // as if made by an older NEO (the log let go first, as book:delete
    // does: removing the folder while book:create's lines were still being
    // written failed now and then with ENOTEMPTY)
    await main.get('slogRecorder').drop(book.id);
    fs.rmSync(path.join(dir, slog.LOG_DIR), { recursive: true });
    fs.writeFileSync(path.join(dir, 'chapters', 'ch-a.html'), '<p>Written long ago.</p>');
    const meta = main.call('book:readMeta', book.id);
    main.call('chapter:read', book.id, 'ch-a');
    main.call('book:writeMeta', book.id, { ...meta, lastPosition: { chapterId: 'ch-a' } });
    assert.equal(fs.existsSync(path.join(dir, slog.LOG_DIR)), false);
    main.call('slog:open', book.id);
    await main.call('slog:event', book.id, { type: 'close' });
    const bases = entries(dir).filter((x) => x.kind === 'base');
    assert.deepEqual(bases.map((x) => [x.doc, x.src]), [['book', 'baseline'], ['ch-a', 'baseline'], ['darlings', 'baseline'], ['stickies', 'baseline']]);
    assertChecks(dir);
  });

  test('a file changed by another device is logged as arrived when it\'s read', async () => {
    const lib = tempLibrary();
    const book = main.call('book:create', { title: 'Synced' });
    const dir = path.join(lib, book.id);
    main.call('slog:open', book.id);
    main.call('chapter:write', book.id, 'ch-1', '<p>Desk.</p>');
    fs.writeFileSync(path.join(dir, 'chapters', 'ch-1.html'), '<p>Desk. Phone.</p>');
    fs.writeFileSync(path.join(dir, 'stickies.json'), JSON.stringify([{ id: 's1', text: 'from the phone' }]));
    assert.equal(main.call('chapter:read', book.id, 'ch-1'), '<p>Desk. Phone.</p>');
    main.call('json:read', book.id, 'stickies', []);
    // a save that would lose the other device's words is refused, and the
    // text that refused it is what the log now knows the file holds
    fs.writeFileSync(path.join(dir, 'chapters', 'ch-1.html'), '<p>Desk. Phone. More phone.</p>');
    const r = main.call('chapter:write', book.id, 'ch-1', '<p>Desk. Phone. Desk again.</p>', '<p>Desk. Phone.</p>');
    assert.ok(r.conflict);
    await main.call('slog:event', book.id, { type: 'close' });
    const arrived = entries(dir).filter((x) => x.src === 'arrived');
    assert.deepEqual(arrived.map((x) => x.doc), ['ch-1', 'stickies', 'ch-1']);
    assertChecks(dir);
  });

  test('switching the log off and on through book.json', async () => {
    const lib = tempLibrary();
    const book = main.call('book:create', { title: 'Private' });
    const dir = path.join(lib, book.id);
    main.call('slog:open', book.id);
    let meta = main.call('book:readMeta', book.id);
    main.call('book:writeMeta', book.id, { ...meta, scribesLog: false });
    assert.equal(main.call('slog:status', book.id).on, false);
    main.call('chapter:write', book.id, 'ch-1', '<p>Off the record.</p>');
    meta = main.call('book:readMeta', book.id);
    delete meta.scribesLog;
    main.call('book:writeMeta', book.id, meta);
    assert.equal(main.call('slog:status', book.id).on, true);
    await main.call('slog:event', book.id, { type: 'close' });
    const kinds = entries(dir).map((x) => x.kind);
    assert.ok(kinds.includes('off') && kinds.includes('on'));
    assert.ok(entries(dir).some((x) => x.doc === 'ch-1' && x.cause === 'off'));
    assertChecks(dir);
  });

  test('an imported file is named only by its fingerprint', async () => {
    const lib = tempLibrary();
    const src = path.join(lib, 'My Secret Title.txt');
    fs.writeFileSync(src, 'Chapter One\n\nIt began in the dark.\n\nChapter Two\n\nIt went on.\n');
    const [parsed] = await main.call('import:files', [src]);
    assert.match(parsed.slogImport, /^[0-9a-f]{16}$/);
    const book = main.call('book:create', { title: parsed.title || parsed.name, author: 'Ada', slogImport: parsed.slogImport });
    assert.equal('slogImport' in book, false);
    assert.equal('slogImport' in JSON.parse(fs.readFileSync(path.join(lib, book.id, 'book.json'), 'utf8')), false);
    const dir = path.join(lib, book.id);
    main.call('chapter:write', book.id, 'ch-1', '<p>It began in the dark.</p>');
    main.call('chapter:write', book.id, 'ch-2', '<p>It went on.</p>');
    await main.get('slogRecorder').close(book.id);
    const bases = entries(dir).filter((x) => x.kind === 'base');
    const sha = slog.sha256hex(fs.readFileSync(src));
    assert.deepEqual(bases.map((x) => [x.doc, x.src, x.file.sha256]).sort(),
      [['book', 'import', sha], ['ch-1', 'import', sha], ['ch-2', 'import', sha], ['darlings', 'import', sha], ['stickies', 'import', sha]]);
    const clear = JSON.stringify(entries(dir).map(slog.clearPart));
    assert.ok(!clear.includes('Secret') && !clear.includes('Title'), 'nothing of the file name in the clear');
    assertChecks(dir);
  });

  test('deleting a chapter, and the menu follows the open book', async () => {
    const lib = tempLibrary();
    const book = main.call('book:create', { title: 'Menu' });
    const dir = path.join(lib, book.id);
    main.call('chapter:write', book.id, 'ch-1', '<p>One.</p>');
    main.call('chapter:write', book.id, 'ch-2', '<p>Two.</p>');
    main.call('slog:open', book.id);
    assert.deepEqual({ ...main.get('slogMenu') }, { bookId: book.id, on: true });
    main.call('chapter:delete', book.id, 'ch-2');
    await main.call('slog:event', book.id, { type: 'close' });
    assert.equal(main.get('slogMenu').bookId, null);
    assert.ok(entries(dir).some((x) => x.kind === 'doc' && x.doc === 'ch-2' && x.act === 'del'));
    assertChecks(dir);
  });

  test('a duplicated book starts a log of its own; the original\'s is left as it was', async () => {
    const lib = tempLibrary();
    const book = main.call('book:create', { title: 'Twin' });
    const dir = path.join(lib, book.id);
    main.call('slog:open', book.id);
    main.call('slog:observe', book.id, 'chapter', 'ch-1', '<p>Only once.</p>', { src: 'typed', dur: 500, ev: 4 });
    main.call('chapter:write', book.id, 'ch-1', '<p>Only once.</p>');
    await main.call('slog:event', book.id, { type: 'close' });
    const before = fs.readdirSync(path.join(dir, slog.LOG_DIR)).sort();
    const copy = await main.call('book:duplicate', book.id, 'Twin (copy)');
    const copyDir = path.join(lib, copy.id);
    assert.equal(fs.readFileSync(path.join(copyDir, 'chapters', 'ch-1.html'), 'utf8'), '<p>Only once.</p>');
    assert.deepEqual(fs.readdirSync(path.join(dir, slog.LOG_DIR)).sort(), before);
    // the copy's log starts at once: its words a baseline naming the
    // original's log, in a log with its own id; none of the original's chunks
    await main.get('slogRecorder').close(copy.id);
    const origLog = entries(dir)[0].log;
    let e = entries(copyDir);
    assert.notEqual(e[0].log, origLog);
    assert.ok(e.every((x) => x.kind !== 'open' || x.log === e[0].log));
    const base = e.find((x) => x.kind === 'base' && x.doc === 'ch-1');
    assert.equal(base.src, 'baseline');
    assert.deepEqual(base.from, [[0, 0, '<p>Only once.</p>'.length, { log: origLog }]]);
    // opened later, nothing more is logged
    const n = e.length;
    main.call('slog:open', copy.id);
    await main.call('slog:event', copy.id, { type: 'close' });
    e = entries(copyDir);
    assert.equal(e.filter((x) => x.kind === 'base' || x.kind === 'edit').length, e.slice(0, n).filter((x) => x.kind === 'base' || x.kind === 'edit').length);
    assertChecks(dir);
    assertChecks(copyDir);
  });

  test('Export for Verification and Merge Log into Archive, from the File menu', async () => {
    const lib = tempLibrary();
    const book = main.call('book:create', { title: 'Tide: A/B "Book"' });
    const dir = path.join(lib, book.id);
    main.call('slog:open', book.id);
    main.call('slog:observe', book.id, 'chapter', 'ch-1', '<p>The tide went out.</p>', { src: 'typed', dur: 500, ev: 18 });
    main.call('chapter:write', book.id, 'ch-1', '<p>The tide went out.</p>');
    await main.call('slog:event', book.id, { type: 'close' });
    main.call('slog:open', book.id);
    main.call('slog:observe', book.id, 'chapter', 'ch-1', '<p>The tide went out. It came back.</p>', { src: 'typed', dur: 500, ev: 14 });
    main.call('chapter:write', book.id, 'ch-1', '<p>The tide went out. It came back.</p>');
    // cancelled at the save dialog: nothing written, the session's chunk closed all the same
    saveAs = null;
    assert.equal(await main.call('slog:export', book.id, { kind: 'clear', added: [] }), null);
    assert.equal(main.get('slogRecorder').activeChunk(book.id), null);
    // offered under the book's title and today's date, so exports don't overwrite each other
    const today = main.get('slogDay()');
    assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(offered, `Tide AB Book - Scribe's Log (no text) ${today}.zip`);
    // saved, without the text
    const out = path.join(lib, 'export.zip');
    saveAs = out;
    const added = ['a'.repeat(64), 'not a hash'];
    const res = await main.call('slog:export', book.id, { kind: 'clear', added });
    assert.equal(res.path, out);
    assert.equal(res.stamped, false); // no stamper here
    assert.equal(res.intact, true);
    const checked = await checkZip(out);
    assert.equal(checked.ok, true, JSON.stringify(checked.problems));
    assert.equal(checked.manifest.title, 'Tide: A/B "Book"');
    assert.equal(checked.manifest.text, 'none');
    assert.deepEqual(checked.manifest.manuscript.added, ['a'.repeat(64)]);
    assert.equal(checked.manifest.manuscript.hash, slog.manuscriptHash('The tide went out. It came back.'));
    const z = await F.readExport(new Uint8Array(fs.readFileSync(out)));
    assert.ok(!JSON.stringify(z.files).includes('tide'));
    const readme = Buffer.from(require('../slog-zip.js').unzipSync(new Uint8Array(fs.readFileSync(out)), require('zlib').inflateRawSync).files['README.txt']).toString();
    assert.match(readme, /can't show that a person pressed the keys/);
    assert.match(readme, /isn't covered by an outside timestamp yet/);
    // with the text
    saveAs = path.join(lib, 'full.zip');
    const full = await main.call('slog:export', book.id, { kind: 'full', added: [] });
    assert.equal(offered, `Tide AB Book - Scribe's Log (with text) ${today}.zip`);
    // the report: dated too, and its privacy level named unless it's dates only
    saveAs = path.join(lib, 'report.html');
    const rep = await main.call('slog:report', book.id, { privacy: 'weeks' });
    assert.equal(rep.path, saveAs);
    assert.equal(offered, `Tide AB Book - Scribe's Log report ${today} (weeks only).html`);
    assert.match(fs.readFileSync(rep.path, 'utf8'), /<title>Scribe&#39;s Log report: Tide: A\/B &quot;Book&quot;, \w+ \d+, \d{4}<\/title>/);
    saveAs = null;
    await main.call('slog:report', book.id, { privacy: 'dates' });
    assert.equal(offered, `Tide AB Book - Scribe's Log report ${today}.html`);
    await main.call('slog:report', book.id, { privacy: 'exact' });
    assert.equal(offered, `Tide AB Book - Scribe's Log report ${today} (exact times).html`);
    const fz = await checkZip(full.path);
    assert.equal(fz.ok, true);
    assert.equal(fz.words, true);
    assert.equal(fz.manifest.text, 'full');
    // merged: both closed sessions into an archive, and it still checks
    const merged = await main.call('slog:archive', book.id);
    assert.equal(merged.error, undefined);
    assert.ok(merged.merged >= 2, JSON.stringify(merged));
    assert.ok(fs.readdirSync(path.join(dir, slog.LOG_DIR)).some((f) => /^archive-.*\.zip$/.test(f)));
    assertChecks(dir);
    // writing goes on after the merge
    main.call('slog:open', book.id);
    main.call('slog:observe', book.id, 'chapter', 'ch-1', '<p>The tide went out. It came back. Again.</p>', { src: 'typed', dur: 500, ev: 7 });
    main.call('chapter:write', book.id, 'ch-1', '<p>The tide went out. It came back. Again.</p>');
    await main.call('slog:event', book.id, { type: 'close' });
    assertChecks(dir);
    // a book with no log
    fs.mkdirSync(path.join(lib, 'book-unlogged-x'));
    assert.ok((await main.call('slog:archive', 'book-unlogged-x')).error);
    assert.ok((await main.call('slog:export', 'book-unlogged-x', { kind: 'clear' })).error);
    saveAs = null;
  });

  test('names from the window still pass libName', () => {
    tempLibrary();
    const book = main.call('book:create', { title: 'Safe' });
    assert.throws(() => main.call('slog:observe', book.id, 'chapter', '../escape', '<p>x</p>', { src: 'typed' }), /Invalid library name/);
    assert.throws(() => main.call('slog:open', '..'), /Invalid library name/);
    assert.equal(main.call('slog:observe', book.id, 'aux', 'cover', '<p>x</p>', { src: 'typed' }), false);
  });

  test('the device id and caches stay in userData, out of the library', async () => {
    const lib = tempLibrary();
    const book = main.call('book:create', { title: 'Where' });
    main.call('chapter:write', book.id, 'ch-1', '<p>x</p>');
    await main.get('slogRecorder').closeAll('quit');
    const home = path.join(userData, 'slog');
    assert.ok(fs.existsSync(path.join(home, 'device.json')));
    assert.ok(fs.readdirSync(home).some((f) => f.endsWith('.json') && f !== 'device.json'));
    const inBook = fs.readdirSync(path.join(lib, book.id, slog.LOG_DIR));
    assert.ok(inBook.every((f) => f === slog.LOG_INFO || slog.isChunkName(f)), inBook.join());
  });
});
