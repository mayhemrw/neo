// End-to-end test for the Scribe's Log. NEO runs on a throwaway library: a
// manuscript comes in through Import, then is written in the way a writer
// does (typed, pasted from outside, copied and pasted back, split with a
// triple Enter, a card moved, a passage sent to Darlings, undone, notes
// typed), and the book is closed and NEO quit. The log is then checked the
// way scripts/slog-check.js does: chains intact, replay equal to the disk,
// every entry labeled. Run with `npm run test:slog` (under xvfb-run on a
// machine without a display).

'use strict';

const { app, BrowserWindow, clipboard } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

for (const name of fs.readdirSync(os.tmpdir())) {
  const pid = /^neo-slog-test-(\d+)-/.exec(name);
  if (!pid || +pid[1] === process.pid) continue;
  try { process.kill(+pid[1], 0); continue; } catch (err) { if (err.code === 'EPERM') continue; }
  fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `neo-slog-test-${process.pid}-`));
app.setPath('userData', path.join(tmp, 'app'));
app.setPath('documents', tmp);
const LIB = path.join(tmp, 'NEO Library');
fs.mkdirSync(LIB);
fs.writeFileSync(path.join(LIB, 'library.json'), JSON.stringify({
  authorName: '', penNames: [], firstRunDone: true, pageTheme: 'night', hintShown: true,
  shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: [] }]
}));
const MANUSCRIPT = path.join(tmp, 'harbor.txt');
fs.writeFileSync(MANUSCRIPT, [
  'The harbor was quiet before the storm.',
  'Gulls wheeled over the empty slips.',
  '***',
  'Mara counted the boats twice.',
  'One was missing.'
].join('\n\n'));

const loadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function (file, opts) {
  return loadFile.call(this, path.resolve(__dirname, '..', file), opts);
};
require('../main.js');
const slog = require('../slog.js');
const { checkBook, report } = require('./slog-check.js');

let wc;
const js = (code) => wc.executeJavaScript(code, true);
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const MOD = process.platform === 'darwin' ? 'meta' : 'control';

async function type(keys, gap = 0) {
  for (const k of keys) {
    const keyCode = k === '\n' ? 'Enter' : k;
    wc.sendInputEvent({ type: 'keyDown', keyCode });
    wc.sendInputEvent({ type: 'char', keyCode: k === '\n' ? '\r' : k });
    wc.sendInputEvent({ type: 'keyUp', keyCode });
    if (gap) await tick(gap);
  }
  await tick(300);
}
async function chord(keyCode, extra = []) {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: [MOD, ...extra] });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: [MOD, ...extra] });
  await tick(300);
}
// the caret in chapter `ch` (by position), paragraph `p`, at its start or end
async function caret(ch, p, end) {
  await js(`(() => {
    const body = document.querySelectorAll('.chapter-body')[${ch}];
    body.focus();
    const para = body.querySelectorAll('p')[${p}];
    const r = document.createRange();
    r.selectNodeContents(para);
    r.collapse(${!end});
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  })()`);
  await tick(100);
}
async function selectWords(ch, p, from, to) {
  await js(`(() => {
    const body = document.querySelectorAll('.chapter-body')[${ch}];
    body.focus();
    const t = body.querySelectorAll('p')[${p}].firstChild;
    const r = document.createRange();
    r.setStart(t, ${from});
    r.setEnd(t, ${to});
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  })()`);
  await tick(100);
}
const pause = () => tick(1400); // a burst ends after a second's quiet

async function main() {
  await app.whenReady();
  let failed = 0;
  let bookDir = null;
  try {
    let win;
    while (!(win = BrowserWindow.getAllWindows()[0])) await tick(50);
    wc = win.webContents;
    while (!(await js(`typeof library !== 'undefined' && !!library`).catch(() => false))) await tick(50);
    await tick(300);
    const bookId = await js(`(async () => {
      document.getElementById('firstrun').hidden = true;
      const results = await window.neo.importFiles([${JSON.stringify(MANUSCRIPT)}]);
      await addImportedBooks(results, library.shelves[0]);
      const ids = library.shelves[0].bookIds;
      await openBook(ids[ids.length - 1]);
      return book.id;
    })()`);
    bookDir = path.join(LIB, bookId);
    await tick(500);
    win.focus();

    // typed
    await caret(0, 0, true);
    await type(' The wind rose.', 30);
    await pause();
    // pasted from outside NEO
    clipboard.writeText('A line from somewhere else entirely.');
    await caret(0, 1, true);
    wc.paste();
    await tick(300);
    await pause();
    // copied in NEO and pasted back: a move
    await selectWords(0, 1, 0, 'Gulls wheeled'.length);
    wc.copy();
    await tick(200);
    await caret(0, 4, true);
    await type(' ');
    wc.paste();
    await tick(300);
    await pause();
    // native undo of some typing
    await caret(0, 3, true);
    await type(' Three times.', 30);
    await pause();
    wc.undo();
    await tick(300);
    await pause();
    // a triple Enter at the start of a paragraph: a new chapter from there
    await caret(0, 3, false);
    await type('\n\n\n', 60);
    await pause();
    assert.equal(await js('book.chapterOrder.length'), 2, 'the triple Enter made a second chapter');
    // a card moved: the first chapter's first section to the end of the second
    await js(`moveSection(book.chapterOrder[0], 0, { ch: book.chapterOrder[1], before: null })`);
    await tick(300);
    await pause();
    // a passage to Darlings (⌘⇧D)
    await selectWords(1, 0, 0, 'Mara counted'.length);
    await chord('D', ['shift']);
    await tick(500);
    await pause();
    // …and NEO's own undo puts it back
    await js(`structuralUndo()`);
    await tick(500);
    await pause();
    // notes
    await js(`switchTab('notes')`);
    await tick(500);
    await js(`document.getElementById('aux-editor').focus()`);
    await type('Find the missing boat.', 30);
    await pause();
    await js(`switchTab('manuscript')`);
    await tick(300);
    // another device changed the second chapter while this one left it alone
    const [ch1, ch2] = await js('book.chapterOrder');
    const other = path.join(bookDir, 'chapters', ch2 + '.html');
    fs.writeFileSync(other, fs.readFileSync(other, 'utf8').replace('</p>', ' Written elsewhere.</p>'));
    await js('refreshFromDisk()');
    await tick(500);
    assert.match(await js(`chapterHTML[${JSON.stringify(ch2)}]`), /Written elsewhere/);
    // …and the first while words typed here weren't saved yet: both kept
    await caret(0, 0, true);
    await type(' Here.');
    const first = path.join(bookDir, 'chapters', ch1 + '.html');
    fs.writeFileSync(first, fs.readFileSync(first, 'utf8').replace('</p>', ' There.</p>'));
    await js('refreshFromDisk()');
    await tick(800);
    assert.equal(await js('book.chapterOrder.length'), 3, 'the other device\'s version became a chapter of its own');
    await pause();
    // switched off and on from the File menu: what changed meanwhile is marked
    await js('slogToggle({ type: \'scribesLog\', bookId: book.id, on: false })');
    await caret(1, 0, true);
    await type(' Off the record.');
    await pause();
    await js('slogToggle({ type: \'scribesLog\', bookId: book.id, on: true })');
    await tick(300);
    await caret(1, 0, true);
    await type(' Back on.');
    await pause();
    // closing the book ends its chunk
    await js(`backToShelf()`);
    await tick(1500);
  } catch (err) {
    failed++;
    console.error(err);
  }

  try {
    const res = checkBook(bookDir);
    console.log(report(bookDir, res));
    const logDir = path.join(bookDir, slog.LOG_DIR);
    const entries = fs.readdirSync(logDir).filter(slog.isChunkName).sort()
      .flatMap((n) => slog.parseChunk(fs.readFileSync(path.join(logDir, n), 'utf8')).entries);
    const edits = entries.filter((e) => e.kind === 'edit' || e.kind === 'base');
    for (const e of edits) console.log(`  ${e.kind} ${e.doc} ${e.src}${e.cause ? '/' + e.cause : ''}${e.ev ? ' ev ' + e.ev : ''}  ${JSON.stringify(e.x ? e.x.ins.map((s) => s.slice(0, 50)) : e.ops)}`);
    const checks = [
      ['the log is intact and ends in what\'s on disk', () => assert.equal(res.ok, true)],
      ['nothing is unlogged (but what changed while the log was off)', () => assert.deepEqual(edits.filter((e) => e.src === 'unlogged' && e.cause !== 'off').map((e) => e.doc), [])],
      ['words from another device arrived', () => assert.ok(edits.some((e) => e.kind === 'edit' && e.src === 'arrived' && e.x.ins.join('').includes('Written elsewhere')))],
      ['the other device\'s version kept beside this one arrived too', () => assert.ok(edits.some((e) => e.kind === 'base' && e.src === 'arrived' && e.x.ins[0].includes('There.')))],
      ['words typed while the log was off are marked', () => assert.ok(edits.some((e) => e.cause === 'off' && e.x && e.x.ins.join('').includes('Off the record.')))],
      ['…and the log notes it was off, then on', () => assert.deepEqual(entries.filter((e) => e.kind === 'off' || e.kind === 'on').map((e) => e.kind), ['off', 'on'])],
      ['typing after it came back on is typed', () => assert.ok(edits.some((e) => e.src === 'typed' && e.x && e.x.ins.join('').includes('Back on.')))],
      ['the book came in as an import', () => assert.ok(edits.some((e) => e.kind === 'base' && e.src === 'import' && e.file))],
      ['typing is typed, in bursts', () => assert.ok(edits.some((e) => e.src === 'typed' && e.ev > 3 && e.x && e.x.ins.join('').includes('The wind rose.')))],
      ['a paste from outside is a paste', () => assert.ok(edits.some((e) => e.src === 'paste' && e.x.ins.join('').includes('somewhere else')))],
      ['NEO\'s own words pasted back are a move', () => assert.ok(edits.some((e) => e.src === 'move' && !e.cause && e.x.ins.join('').includes('Gulls wheeled')))],
      ['an undo is labeled', () => assert.ok(edits.some((e) => e.cause === 'undo'))],
      ['the split is labeled', () => assert.ok(edits.some((e) => e.src === 'move' && e.cause === 'split'))],
      ['the card move is labeled', () => assert.ok(edits.some((e) => e.src === 'move' && e.cause === 'outline'))],
      ['Darlings are labeled', () => assert.ok(edits.some((e) => e.doc === 'darlings' && e.src === 'move' && e.cause === 'darling'))],
      ['notes are typed', () => assert.ok(edits.some((e) => e.doc === 'notes' && e.src === 'typed'))],
      ['the chunk closed when the book did', () => assert.ok(entries.some((e) => e.kind === 'close' && e.why === 'close'))]
    ];
    for (const [name, fn] of checks) {
      try { fn(); console.log('ok   ' + name); } catch (err) {
        failed++;
        console.log('FAIL ' + name + '\n     ' + String(err.message).replace(/\n/g, '\n     '));
      }
    }
    console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  } catch (err) {
    failed++;
    console.error(err);
  } finally {
    app.exit(failed ? 1 : 0);
  }
}
main();
