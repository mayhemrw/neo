// End-to-end test for Find and Replace's engine (phase 4, milestone 1), on
// a throwaway library: a book is imported and a word italicized, then the
// find bar's three options (Match case, Whole word, Include chapter
// titles) are pressed and checked, a phrase is found across the italics
// and set apart, chapter titles are found when asked, and Replace and
// Replace All honor the options and leave a phrase that crosses italics
// alone. ⌘Z takes the Replace All back, and the book's log still checks
// with nothing unlogged.
// Run with `npm run test:find` (under xvfb-run without a display).

'use strict';

// (no outside timestamps from a test run: slog-stamp.js would reach the real services)
process.env.NEO_SLOG_STAMPS = process.env.NEO_SLOG_STAMPS || 'off';

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

for (const name of fs.readdirSync(os.tmpdir())) {
  const pid = /^neo-find-test-(\d+)-/.exec(name);
  if (!pid || +pid[1] === process.pid) continue;
  try { process.kill(+pid[1], 0); continue; } catch (err) { if (err.code === 'EPERM') continue; }
  fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `neo-find-test-${process.pid}-`));
app.setPath('userData', path.join(tmp, 'app'));
app.setPath('documents', tmp);
const LIB = path.join(tmp, 'NEO Library');
fs.mkdirSync(LIB);
fs.writeFileSync(path.join(LIB, 'library.json'), JSON.stringify({
  authorName: '', penNames: [], firstRunDone: true, pageTheme: 'night', hintShown: true,
  shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: [] }]
}));
const loadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function (file, opts) {
  return loadFile.call(this, path.resolve(__dirname, '..', file), opts);
};
require('../main.js');
const { checkBook } = require('./slog-check.js');

let wc;
let bookId;
const js = (code) => wc.executeJavaScript(code, true);
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

// what the bar shows after a search for q
async function find(q) {
  await js(`(() => { $('#search-input').value = ${JSON.stringify(q)}; runSearch(); })()`);
  return js(`({
    count: $('#search-count').textContent,
    found: searchState.matches.map((m) => ({ text: m.range.toString(), title: m.title, crosses: m.crosses, ch: book.chapterOrder.indexOf(m.chId) }))
  })`);
}
const press = async (id) => { await js(`$('#${id}').click()`); await tick(60); };
const pressed = () => js(`['find-case', 'find-word', 'find-titles'].map((id) => $('#' + id).getAttribute('aria-pressed'))`);
const bodyText = (ch) => js(`document.querySelectorAll('.chapter-body')[${ch}].innerText`);
const toastText = () => js(`$('#hint').textContent`);

const CH1 = [
  'Colour ran off the walls. The colour was gone.',
  'She came back to the old house at dusk.',
  'The cat scattered the other cats. A cat watched.',
  "I don't know, said Don. Don't ask.",
  'Café lights; the cafés were shut.'
];
const CH2 = [
  'The mill wheel was still.',
  'Nobody had seen the colour of its water since the old house burned.'
];
const notes = {};
// NEO_TEST_SHOTS=<folder>: pictures of the window along the way, to look at
async function shot(name) {
  if (!process.env.NEO_TEST_SHOTS) return;
  const img = await wc.capturePage();
  fs.writeFileSync(path.join(process.env.NEO_TEST_SHOTS, name + '.png'), img.toPNG());
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('the bar has its three options, off to start, with names to read aloud', async () => {
  await js(`openSearch()`);
  await tick(100);
  assert.deepEqual(await pressed(), ['false', 'false', 'false']);
  const labels = await js(`['find-case', 'find-word', 'find-titles'].map((id) => $('#' + id).getAttribute('aria-label'))`);
  assert.deepEqual(labels, ['Match case', 'Whole word', 'Include chapter titles']);
  assert.equal(await js(`$('#find-titles').hidden`), false, 'titles shown in the manuscript');
});

test('any case at first; Match case narrows it, and is kept for this computer', async () => {
  let r = await find('colour');
  assert.equal(r.found.length, 3);
  assert.equal(r.count, '3 found');
  await press('find-case');
  assert.deepEqual(await pressed(), ['true', 'false', 'false']);
  r = await js(`({ n: searchState.matches.length, kept: JSON.parse(localStorage.getItem('neo-device-look')).findCase })`);
  assert.equal(r.n, 2, 'the search ran again with Match case');
  assert.equal(r.kept, true);
  r = await find('Colour');
  assert.deepEqual(r.found.map((m) => m.text), ['Colour']);
  await press('find-case');
  assert.equal((await find('colour')).found.length, 3);
});

test('Whole word: not inside a longer word, nor in half of "don\'t"', async () => {
  assert.equal((await find('cat')).found.length, 4); // cat, sCATtered, cats, cat
  await press('find-word');
  assert.deepEqual(await pressed(), ['false', 'true', 'false']);
  assert.equal(await js(`searchState.matches.length`), 2);
  assert.deepEqual((await find('don')).found.map((m) => m.text), ['Don']);
  assert.deepEqual((await find('café')).found.map((m) => m.text), ['Café']);
  await press('find-word');
});

test('a phrase across italics is found, and set apart as crossing formatting', async () => {
  const r = await find('the old house');
  assert.deepEqual(r.found.map((m) => [m.text, m.ch, m.crosses]), [['the old house', 0, true], ['the old house', 1, false]]);
  // all in one style, it doesn't cross anything
  const plain = await find('back to the');
  assert.equal(plain.found[0].crosses, false);
  const inside = await find('old');
  assert.ok(inside.found.some((m) => m.ch === 0 && m.crosses === false));
  // the highlight covers the whole phrase
  await find('the old house');
  await js(`gotoMatch(0)`);
  await shot('across-italics');
  assert.equal(await js(`[...CSS.highlights.get('neo-search-current')][0].toString()`), 'the old house');
});

test('a phrase never runs across a paragraph break', async () => {
  assert.equal((await find('gone. She')).found.length, 0);
  assert.equal((await find('gone.She')).found.length, 0);
});

test('Include chapter titles: found when asked, first in its chapter', async () => {
  assert.equal((await find('mill')).found.filter((m) => m.title).length, 0);
  await press('find-titles');
  assert.deepEqual(await pressed(), ['false', 'false', 'true']);
  const r = await find('mill');
  assert.deepEqual(r.found.map((m) => [m.text, m.title, m.ch]), [['Mill', true, 1], ['mill', false, 1]]);
  // a Replace on a title waits for the list (milestone 3)
  await js(`gotoMatch(0); $('#replace-input').value = 'Forge'; replaceCurrent()`);
  await tick(100);
  assert.match(await toastText(), /Chapter titles can be found, not replaced/);
  assert.equal(await js(`book.chapterTitles[book.chapterOrder[1]]`), 'The Old Mill');
  await press('find-titles');
});

test('the titles option is only for the manuscript', async () => {
  await js(`closeSearch(); switchTab('notes')`);
  await tick(300);
  await js(`openSearch()`);
  await tick(100);
  assert.equal(await js(`$('#find-titles').hidden`), true);
  await js(`closeSearch(); switchTab('manuscript')`);
  await tick(300);
  await js(`openSearch()`);
  await tick(100);
  assert.equal(await js(`$('#find-titles').hidden`), false);
});

test('Replace leaves a phrase across italics for the writer, and replaces a plain one', async () => {
  await find('the old house');
  await js(`gotoMatch(0); $('#replace-input').value = 'the new home'; replaceCurrent()`);
  await tick(100);
  assert.match(await toastText(), /crosses italics or bold/);
  assert.ok((await bodyText(0)).includes('the old house'));
  await find('dusk');
  await js(`gotoMatch(0); $('#replace-input').value = 'dawn'; replaceCurrent()`);
  await tick(200);
  assert.ok((await bodyText(0)).includes('at dawn.'));
});

test('Replace All honors Match case and Whole word, and leaves what crosses italics', async () => {
  await press('find-case');
  await press('find-word');
  await find('cat');
  await js(`$('#replace-input').value = 'dog'; replaceAllMatches()`);
  await tick(300);
  const one = await bodyText(0);
  assert.ok(one.includes('The dog scattered the other cats. A dog watched.'), one);
  assert.match(await toastText(), /^2 replaced across the whole book/);
  await press('find-case');
  await press('find-word');
  // across chapters: the plain one replaced, the one across italics left alone
  const before = { one: await bodyText(0), two: await bodyText(1), titles: await js(`JSON.stringify(book.chapterTitles)`) };
  notes.before = before;
  const r = await find('the old house');
  assert.deepEqual(r.found.map((m) => [m.ch, m.crosses]), [[0, true], [1, false]]);
  await js(`$('#replace-input').value = 'the new home'; replaceAllMatches()`);
  await tick(300);
  const toast = await toastText();
  assert.match(toast, /^1 replaced across the whole book/);
  assert.match(toast, /1 left: they cross italics or bold\./);
  assert.ok((await bodyText(0)).includes('to the old house'), 'the phrase across italics kept as it was');
  assert.ok((await bodyText(1)).includes('since the new home burned.'));
  assert.equal(await js(`JSON.stringify(book.chapterTitles)`), before.titles, 'titles untouched');
  // the italic word is still italic
  assert.equal(await js(`document.querySelectorAll('.chapter-body')[0].querySelector('i, em').textContent`), 'old');
  // and the search runs again: the one left is all there is
  assert.deepEqual((await find('the old house')).found.map((m) => m.crosses), [true]);
});

test('Replace All across a paragraph split into several text nodes', async () => {
  await js(`(() => {
    const p = document.querySelectorAll('.chapter-body')[1].querySelector('p');
    p.firstChild.splitText(9); // "The mill " | "wheel was still."
  })()`);
  await find('mill wheel');
  assert.equal(await js(`searchState.matches[0].crosses`), false);
  await js(`$('#replace-input').value = 'water wheel'; replaceAllMatches()`);
  await tick(300);
  assert.ok((await bodyText(1)).startsWith('The water wheel was still.'), await bodyText(1));
});

test('⌘Z takes a Replace All back', async () => {
  await js(`structuralUndo()`);
  await tick(500);
  await js(`structuralUndo()`);
  await tick(500);
  assert.equal(await bodyText(0), notes.before.one);
  assert.equal(await bodyText(1), notes.before.two);
});

test('the log: replacements logged, nothing unlogged, and it checks', async () => {
  await js(`closeSearch(); slogSaveAll()`);
  await tick(500);
  await js(`backToShelf()`);
  await tick(1000);
  const res = checkBook(path.join(LIB, bookId));
  assert.deepEqual(res.problems, []);
  for (const d of res.devices) assert.deepEqual(d.problems, []);
  assert.equal(res.ok, true);
  const d = res.devices[res.devices.length - 1];
  assert.equal(d.sources.unlogged || 0, 0, 'nothing unlogged');
  assert.ok(d.chainEntries.some((e) => e.kind === 'edit' && e.cause === 'replace'), 'a replace in the log');
  let errors = '';
  try { errors = fs.readFileSync(path.join(LIB, 'neo-errors.log'), 'utf8'); } catch { /* none */ }
  assert.equal(errors, '');
});

async function main() {
  await app.whenReady();
  let failed = 0;
  try {
    let win;
    while (!(win = BrowserWindow.getAllWindows()[0])) await tick(50);
    wc = win.webContents;
    while (!(await js(`typeof library !== 'undefined' && !!library`).catch(() => false))) await tick(50);
    await tick(300);
    const md = path.join(tmp, 'house.md');
    fs.writeFileSync(md, ['# The House', ...CH1, '# The Old Mill', ...CH2].join('\n\n'));
    bookId = await js(`(async () => {
      document.getElementById('firstrun').hidden = true;
      const results = await window.neo.importFiles([${JSON.stringify(md)}]);
      await addImportedBooks(results, library.shelves[0]);
      const ids = library.shelves[0].bookIds;
      await openBook(ids[ids.length - 1]);
      return book.id;
    })()`);
    await tick(600);
    win.focus();
    // "old" in "the old house" italicized, the way the writer would
    await js(`(() => {
      const body = document.querySelectorAll('.chapter-body')[0];
      body.focus();
      const p = body.querySelectorAll('p')[1];
      const at = p.firstChild.data.indexOf('old');
      const r = document.createRange();
      r.setStart(p.firstChild, at);
      r.setEnd(p.firstChild, at + 3);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      document.execCommand('italic');
    })()`);
    await tick(1400);
    for (const t of tests) {
      try {
        await t.fn();
        console.log('ok   ' + t.name);
      } catch (err) {
        failed++;
        console.log('FAIL ' + t.name + '\n     ' + String(err.stack || err.message).replace(/\n/g, '\n     '));
      }
    }
    console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  } catch (err) {
    failed++;
    console.error(err);
  } finally {
    app.exit(failed ? 1 : 0);
  }
}
main();
