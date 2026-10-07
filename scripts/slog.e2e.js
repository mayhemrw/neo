// End-to-end test for the Scribe's Log. NEO runs on a throwaway library: a
// manuscript comes in through Import, then is written in the way a writer
// does (typed, pasted from outside, copied and pasted back, split with a
// triple Enter, a card moved, a passage sent to Darlings, undone, notes
// typed, a paste deleted and brought back, a cut pasted elsewhere), and the
// book is closed and NEO quit. The log is then checked the way
// scripts/slog-check.js does: chains intact, replay equal to the disk,
// every entry labeled, every move traced to where its words were. Run with `npm run test:slog` (under xvfb-run on a
// machine without a display).

'use strict';

const { app, BrowserWindow, clipboard, ipcMain } = require('electron');
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
// select `needle` where it sits in one text node of chapter `ch`
async function selectText(ch, needle) {
  const found = await js(`(() => {
    const body = document.querySelectorAll('.chapter-body')[${ch}];
    body.focus();
    const walk = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let t; (t = walk.nextNode());) {
      const i = t.data.indexOf(${JSON.stringify(needle)});
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(t, i);
      r.setEnd(t, i + ${needle.length});
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      return true;
    }
    return false;
  })()`);
  assert.ok(found, 'found "' + needle + '" to select');
  await tick(100);
}
async function key(keyCode) {
  wc.sendInputEvent({ type: 'keyDown', keyCode });
  wc.sendInputEvent({ type: 'keyUp', keyCode });
  await tick(200);
}
const pause = () => tick(1400); // a burst ends after a second's quiet
const BORROWED = 'Borrowed words that are not the writer\'s own.';
const GULLS = 'Gulls wheeled over the empty slips.';
const HARBOR = 'The harbor was quiet before the storm.';
const DEDICATION = 'For the harbor folk, who counted the boats.';
const notes = {}; // what the run saw along the way, for the checks

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
    await selectWords(0, 1, 0, GULLS.length);
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
    // pasted from outside, deleted, and brought back with ⌘Z: still a paste
    clipboard.writeText(BORROWED);
    await caret(0, 0, true);
    await type(' ');
    wc.paste();
    await tick(300);
    await pause();
    await selectText(0, BORROWED);
    await key('Backspace');
    await pause();
    wc.undo();
    await tick(300);
    await pause();
    // cut in NEO and pasted somewhere else: a move from what the cut deleted
    await selectText(0, HARBOR);
    wc.cut();
    await tick(300);
    await pause();
    await caret(0, 4, true);
    await type(' ');
    wc.paste();
    await tick(300);
    await pause();
    // a cut across two paragraphs, taken back with ⌘Z: the engine wraps the
    // joined words in style spans, which the page keeps (for ⌘Z) and the
    // file never gets
    await js(`(() => {
      const body = document.querySelectorAll('.chapter-body')[0];
      body.focus();
      const ps = body.querySelectorAll('p');
      const r = document.createRange();
      r.setStart(ps[3].firstChild, 5);
      r.setEnd(ps[4].firstChild, 4);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    })()`);
    await tick(100);
    const beforeCut = await js('chapterHTML[book.chapterOrder[0]]');
    wc.cut();
    await tick(300);
    notes.cutPage = await js(`document.querySelectorAll('.chapter-body')[0].innerHTML`);
    notes.cutSaved = await js('chapterHTML[book.chapterOrder[0]]');
    await pause();
    wc.undo();
    await tick(300);
    notes.cutUndone = (await js('chapterHTML[book.chapterOrder[0]]')) === beforeCut;
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
    // a section with words set aside on a loose card, then dragged back
    const seg = await js(`(() => {
      for (const ch of book.chapterOrder) {
        const segs = chapterSegments(ch);
        if (segs.length < 2) continue;
        for (let i = segs.length - 1; i >= 0; i--) if (segs[i].words && !segs[i].flag) return { ch, i };
      }
      return null;
    })()`);
    assert.ok(seg, 'a chapter with a section to set aside');
    notes.looseWords = await js(`chapterSegments(${JSON.stringify(seg.ch)})[${seg.i}].first`);
    await js(`sectionToLoose(${JSON.stringify(seg.ch)}, ${seg.i})`);
    await tick(800);
    await pause();
    const card = await js(`(book.looseCards || []).find((c) => c.html) || null`);
    assert.ok(card, 'the words went onto a loose card');
    await js(`looseToSection(${JSON.stringify(card.id)}, { ch: ${JSON.stringify(seg.ch)}, before: null })`);
    await tick(800);
    await pause();
    assert.ok(!(await js(`(book.looseCards || []).some((c) => c.html)`)), 'the card\'s words went back in');
    // …then the same section deleted from its card's menu (to Darlings), and ⌘Z
    const last = await js(`chapterSegments(${JSON.stringify(seg.ch)}).length - 1`);
    await js(`deleteSectionToDarlings(${JSON.stringify(seg.ch)}, ${last})`);
    await tick(800);
    await pause();
    await js(`structuralUndo()`);
    await tick(800);
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
    // a dedication typed in the Paperback for KDP dialog becomes a page
    // (the pages themselves aren't set: that's the print tests' business)
    ipcMain.removeHandler('print:paperback');
    ipcMain.handle('print:paperback', () => null);
    await js(`(() => { printPaperback(); })()`);
    while (!(await js(`!!document.getElementById('pm-dedication')`))) await tick(50);
    await js(`(() => {
      document.getElementById('pm-dedication').value = ${JSON.stringify(DEDICATION)};
      document.querySelector('.print-modal .m-ok').click();
    })()`);
    while (await js(`!!printPaperback.busy || !!document.getElementById('pm-dedication')`)) await tick(50);
    await tick(800);
    assert.ok(await js(`book.chapterOrder.some((c) => chapterKind(c) === 'dedication')`), 'the dedication is a page');
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
    const dev = res.devices[res.devices.length - 1];
    // where the words of `needle` came from, wherever in the book it ended up
    const originsOf = (needle) => {
      for (const d of Object.values(dev.traced)) {
        const at = d.text === null ? -1 : d.text.indexOf(needle);
        if (at >= 0) return slog.originsAt(d, at, needle.length).map(([, o]) => o);
      }
      return null;
    };
    const logDir = path.join(bookDir, slog.LOG_DIR);
    const entries = fs.readdirSync(logDir).filter(slog.isChunkName).sort()
      .flatMap((n) => slog.parseChunk(fs.readFileSync(path.join(logDir, n), 'utf8')).entries);
    const edits = entries.filter((e) => e.kind === 'edit' || e.kind === 'base');
    for (const e of edits) console.log(`  ${e.n} ${e.kind} ${e.doc} ${e.src}${e.cause ? '/' + e.cause : ''}${e.ev ? ' ev ' + e.ev : ''}${e.from ? ' from ' + JSON.stringify(e.from.map((p) => p[3].n || p[3].doc || 'log')) : ''}  ${JSON.stringify(e.x ? e.x.ins.map((s) => s.slice(0, 50)) : e.ops)}`);
    // the stretches of text whose move wasn't traced, to say which failed
    const untraced = () => Object.entries(dev.traced).flatMap(([doc, d]) => {
      let at = 0;
      const out = [];
      for (const [len, o] of d.runs) {
        if (o === 'move') out.push(doc + ': ' + JSON.stringify(d.text.slice(at, at + len)));
        at += len;
      }
      return out;
    }).join('\n');
    const moves = (cause) => edits.filter((e) => e.src === 'move' && e.cause === cause && e.x);
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
      ['NEO\'s own words pasted back are a move from where they still are', () => assert.ok(edits.some((e) => e.src === 'move' && !e.cause && e.x.ins.join('').includes(GULLS) && e.from && e.from.some((p) => p[3].doc)))],
      ['a cut pasted elsewhere is a move from what the cut deleted', () => assert.ok(edits.some((e) => e.src === 'move' && !e.cause && e.x.ins.join('').includes(HARBOR) && e.from && e.from.some((p) => p[3].n)))],
      ['pasted, deleted and undone is still pasted', () => assert.deepEqual(originsOf(BORROWED), ['paste'])],
      ['…and the undo says where the words were', () => assert.ok(edits.some((e) => e.cause === 'undo' && e.x && e.x.ins.join('').includes(BORROWED) && e.from))],
      ['the split, the card move and Darlings say where their words were', () => {
        for (const cause of ['split', 'outline', 'darling']) assert.ok(moves(cause).length && moves(cause).some((e) => e.from), cause);
      }],
      ['nothing moved in the manuscript is untraced', () => assert.equal((dev.made || {}).move || 0, 0, untraced())],
      ['the manuscript\'s words came from import, typing, pasting and another device', () => assert.deepEqual(Object.keys(dev.made).sort(), ['arrived', 'import', 'paste', 'typed', 'while off'])],
      ['an undo is labeled', () => assert.ok(edits.some((e) => e.cause === 'undo'))],
      ['the split is labeled', () => assert.ok(edits.some((e) => e.src === 'move' && e.cause === 'split'))],
      ['the card move is labeled', () => assert.ok(edits.some((e) => e.src === 'move' && e.cause === 'outline'))],
      ['Darlings are labeled', () => assert.ok(edits.some((e) => e.doc === 'darlings' && e.src === 'move' && e.cause === 'darling'))],
      ['notes are typed', () => assert.ok(edits.some((e) => e.doc === 'notes' && e.src === 'typed'))],
      ['the chunk closed when the book did', () => assert.ok(entries.some((e) => e.kind === 'close' && e.why === 'close'))],
      ['a cut across paragraphs: the page keeps the engine\'s spans for ⌘Z, the file never has them', () => {
        assert.match(notes.cutPage, /<span style=/, 'the engine wrapped the joined words (if not, this check tests nothing)');
        assert.doesNotMatch(notes.cutSaved, /<span/);
        assert.equal(notes.cutUndone, true, '⌘Z put both paragraphs back as they were');
        for (const f of fs.readdirSync(path.join(bookDir, 'chapters'))) assert.doesNotMatch(fs.readFileSync(path.join(bookDir, 'chapters', f), 'utf8'), /<span(?! class="ph-mark")/, f);
      }],
      ['a section\'s words onto a loose card and back are moves', () => {
        const out = edits.find((e) => e.doc === 'book' && e.src === 'move' && e.cause === 'outline' && e.x && e.x.ins.join('').includes(notes.looseWords.slice(0, 20)));
        assert.ok(out && out.from, 'into book.json, from the chapter');
        const back = edits.find((e) => e.n > out.n && /^ch-/.test(e.doc) && e.src === 'move' && e.cause === 'outline' && e.x && e.x.ins.join('').includes(notes.looseWords.slice(0, 20)));
        assert.ok(back && back.from, 'back into the chapter, from the card');
      }],
      ['a section deleted to Darlings is a move there', () => assert.ok(edits.some((e) => e.doc === 'darlings' && e.src === 'move' && e.cause === 'darling' && e.from && e.x.ins.join('').includes(notes.looseWords.slice(0, 20))))],
      ['a dedication typed in the paperback dialog is typed', () => assert.ok(edits.some((e) => /^ch-/.test(e.doc) && e.src === 'typed' && e.x && e.x.ins.join('').includes(DEDICATION)))]
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
