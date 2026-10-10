// End-to-end test for View → Chapter History… (⌘⇧H), on a throwaway
// library: a book is imported, written over three sessions (a word
// changed, a version named, a chapter deleted), and the History window is
// opened from the menu. Its list, Read, Compare (with the chapter now and
// with another version, folds and all), the chapters no longer in the
// book, renaming and deleting a named version, the keyboard and the
// shortcuts sheet are checked; then a chapter is restored (and ⌘Z undoes
// it), a passage is copied out of a version and pasted in, and the deleted
// chapter is put back. The book's log still checks after, and the restored
// words keep the origins they had.
// Run with `npm run test:history` (under xvfb-run without a display).

'use strict';

// (no outside timestamps from a test run: slog-stamp.js would reach the real services)
process.env.NEO_SLOG_STAMPS = process.env.NEO_SLOG_STAMPS || 'off';

const { app, BrowserWindow, Menu } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

for (const name of fs.readdirSync(os.tmpdir())) {
  const pid = /^neo-history-test-(\d+)-/.exec(name);
  if (!pid || +pid[1] === process.pid) continue;
  try { process.kill(+pid[1], 0); continue; } catch (err) { if (err.code === 'EPERM') continue; }
  fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `neo-history-test-${process.pid}-`));
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
const H = require('../slog-history.js');

let wc;
let bookId;
let ids;
const js = (code) => wc.executeJavaScript(code, true);
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const pause = () => tick(1400); // a burst ends after a second's quiet
async function until(what, code, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await js(code).catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error('waited for ' + what);
    await tick(60);
  }
}
async function type(keys) {
  for (const k of keys) {
    const keyCode = k === '\n' ? 'Enter' : k;
    wc.sendInputEvent({ type: 'keyDown', keyCode });
    wc.sendInputEvent({ type: 'char', keyCode: k === '\n' ? '\r' : k });
    wc.sendInputEvent({ type: 'keyUp', keyCode });
    await tick(15);
  }
  await tick(300);
}
async function key(keyCode, modifiers = []) {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await tick(200);
}
// the caret at the end of paragraph p of chapter ch (by position)
async function caretEnd(ch, p) {
  await js(`(() => {
    const body = document.querySelectorAll('.chapter-body')[${ch}];
    body.focus();
    const r = document.createRange();
    r.selectNodeContents(body.querySelectorAll('p')[${p}]);
    r.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  })()`);
  await tick(100);
}
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
  assert.ok(found, 'found "' + needle + '"');
  await tick(100);
}
async function reopen() {
  await js(`backToShelf()`);
  await tick(800);
  await js(`openBook(${JSON.stringify(bookId)})`);
  await tick(800);
}
function menuItem(top, label) {
  const m = Menu.getApplicationMenu().items.find((x) => x.label === top);
  return m.submenu.items.find((x) => x.label === label);
}
const hv = (sel) => `document.querySelector('#chapter-history ${sel}')`;
const items = () => js(`[...document.querySelectorAll('#chapter-history .hv-item')].map((el) => ({
  key: el.dataset.key, sel: el.getAttribute('aria-selected') === 'true',
  when: el.querySelector('.hv-when').textContent, name: (el.querySelector('.hv-vname') || {}).textContent || null,
  kind: (el.querySelector('.hv-kind') || {}).textContent || null, meta: el.querySelector('.hv-meta').textContent
}))`);
const pageText = () => js(`${hv('.hv-page')}.innerText`);
const pageHtml = () => js(`${hv('.hv-page')}.innerHTML`);
async function pick(i) {
  await js(`document.querySelectorAll('#chapter-history .hv-item')[${i}].click()`);
  await until('the version shown', `!${hv('.hv-page')}.classList.contains('loading') && ${hv('.hv-page')}.innerHTML.length > 0`);
  await tick(150);
}
async function mode(m) {
  await js(`${hv(`[data-mode="${m}"]`)}.click()`);
  await until('the page', `!${hv('.hv-page')}.classList.contains('loading')`);
  await tick(200);
}

const PARAS = [
  'The harbor was quiet before the storm.',
  'Gulls wheeled over the empty slips.',
  'Mara counted the boats twice.',
  'The tide was turning, slow and gray.',
  'Ropes creaked against the pilings.',
  'Somewhere a bell rang once.',
  'Nets hung drying on the wall.',
  'A dog barked down the quay.',
  'The light was going fast.',
  'One was missing.',
  'She went to find her father.'
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

test('View → Chapter History… is there, ⌘⇧H, and opens on the chapter with the caret', async () => {
  const item = menuItem('View', 'Chapter History…');
  assert.ok(item, 'the menu item');
  assert.equal(item.accelerator, 'CmdOrCtrl+Shift+H');
  assert.equal(item.enabled, true);
  await caretEnd(0, 1);
  item.click();
  await until('the History window', `!!document.querySelector('#chapter-history .hv-item')`);
  await tick(300);
  assert.equal(await js(`${hv('.hv-chapter')}.value`), ids[0]);
  // pressed again, it doesn't stack a second window
  item.click();
  await tick(300);
  assert.equal(await js(`document.querySelectorAll('.modal-backdrop:not([hidden])').length`), 1);
});

test('the list: newest first, this session, the named version, the earlier session, the import', async () => {
  const list = await items();
  notes.list = list;
  assert.deepEqual(list.map((x) => [x.name, x.kind]), [
    [null, 'This session, so far'],
    ['Midway', 'Named version'],
    [null, null],
    [null, 'Imported']
  ]);
  assert.ok(list[0].sel, 'the newest is selected');
  assert.ok(list.every((x) => /This computer/.test(x.meta)), list.map((x) => x.meta).join(' | '));
  const words = PARAS.join(' ').split(/\s+/).length;
  assert.match(list[3].meta, new RegExp(words + ' words'));
});

test('Read shows a version as prose, built fresh', async () => {
  await pick(3);
  assert.equal((await pageText()).replace(/\s+/g, ' ').trim(), PARAS.join(' '));
  await pick(1);
  const named = await pageText();
  await shot('read-named');
  assert.ok(named.includes('The wind rose.'), 'the named version has the earlier session\'s words');
  assert.ok(named.includes('counted the boats twice'), 'and not this session\'s change');
  assert.ok(!named.includes('Later still.'));
});

test('Compare with the chapter now: struck through, underlined, folded, counted', async () => {
  await pick(3); // the import
  await mode('compare');
  assert.equal(await js(`${hv('.hv-against')}.value`), 'now');
  const html = await pageHtml();
  assert.ok(html.includes('<ins> The wind rose.</ins>'), html.slice(0, 400));
  assert.ok(html.includes('counted the boats <del>twice</del><ins>three times</ins>.'), html);
  assert.ok(html.includes('<ins> Later still.</ins>'));
  assert.ok(html.includes('class="hv-fold"'), 'unchanged paragraphs folded');
  assert.match(await js(`${hv('.hv-summary')}.textContent`), /7 words added, 1 taken out/);
  await shot('compare-now');
  // a fold opens to its paragraphs
  await js(`${hv('.hv-fold')}.click()`);
  await tick(100);
  assert.equal(await js(`document.querySelectorAll('#chapter-history .hv-fold').length`), 0);
  assert.ok((await pageText()).includes('Ropes creaked against the pilings.'));
});

test('Compare with another version', async () => {
  const named = notes.list[1].key;
  await js(`(() => { const s = ${hv('.hv-against')}; s.value = ${JSON.stringify(named)}; s.dispatchEvent(new Event('change')); })()`);
  await until('the page', `!${hv('.hv-page')}.classList.contains('loading')`);
  await tick(200);
  const html = await pageHtml();
  assert.ok(html.includes('<ins> The wind rose.</ins>'));
  assert.ok(!html.includes('three times'), 'the named version is before that change');
  assert.match(await js(`${hv('.hv-summary')}.textContent`), /to “Midway”/);
  await mode('view');
});

test('the arrow keys walk the list; keys never reach the page underneath', async () => {
  await js(`document.querySelector('#chapter-history .hv-item[aria-selected="true"]').focus()`);
  const before = (await items()).findIndex((x) => x.sel);
  await key('Up');
  await tick(200);
  assert.equal((await items()).findIndex((x) => x.sel), before - 1);
  const chapter = await js(`chapterHTML[${JSON.stringify(ids[0])}]`);
  await type('zz');
  await key('Backspace');
  assert.equal(await js(`chapterHTML[${JSON.stringify(ids[0])}]`), chapter);
});

test('a chapter no longer in the book: listed apart, read, compared with the version before', async () => {
  const groups = await js(`[...${hv('.hv-chapter')}.querySelectorAll('optgroup')].map((g) => [g.label, [...g.children].map((o) => o.value)])`);
  assert.equal(groups.length, 2);
  assert.equal(groups[1][0], 'Chapters no longer in the book');
  assert.deepEqual(groups[1][1], [ids[2]]);
  assert.ok(!groups[0][1].includes(ids[2]));
  await js(`(() => { const s = ${hv('.hv-chapter')}; s.value = ${JSON.stringify(ids[2])}; s.dispatchEvent(new Event('change')); })()`);
  await until('its versions', `document.querySelectorAll('#chapter-history .hv-item').length > 0`);
  const list = await items();
  assert.deepEqual(list.map((x) => x.kind), ['Last version before it was deleted', 'Named version', null, 'Imported']);
  await pick(0);
  const text = await pageText();
  assert.ok(text.includes('The lighthouse kept its watch, and more'), text);
  await mode('compare');
  assert.notEqual(await js(`${hv('.hv-against')}.value`), 'now');
  assert.equal(await js(`[...${hv('.hv-against')}.options].some((o) => o.value === 'now')`), false);
  // (the version before is the named one, the same words: it says so)
  assert.equal(await js(`${hv('.hv-against')}.value`), list[1].key);
  assert.match(await js(`${hv('.hv-summary')}.textContent`), /The words are the same/);
  const imported = (await items())[3].key;
  await js(`(() => { const s = ${hv('.hv-against')}; s.value = ${JSON.stringify(imported)}; s.dispatchEvent(new Event('change')); })()`);
  await until('the page', `!${hv('.hv-page')}.classList.contains('loading')`);
  await tick(200);
  assert.ok((await pageHtml()).includes('<ins>, and more</ins>'), await pageHtml());
  await shot('deleted-chapter');
  await mode('view');
});

test('a named version renamed, then deleted, from the window', async () => {
  await js(`(() => { const s = ${hv('.hv-chapter')}; s.value = ${JSON.stringify(ids[0])}; s.dispatchEvent(new Event('change')); })()`);
  await tick(300);
  await pick(1);
  assert.equal(await js(`${hv('.hv-named-tools')}.hidden`), false);
  await js(`${hv('.hv-rename')}.click()`);
  await until('the name box', `!!document.querySelector('.modal-backdrop:not(#chapter-history) input')`);
  await js(`document.querySelector('.modal-backdrop:not(#chapter-history) input').select()`);
  await type('Sent to Maria\n');
  await until('the new name', `[...document.querySelectorAll('#chapter-history .hv-vname')].some((n) => n.textContent === 'Sent to Maria')`);
  const dir = path.join(LIB, bookId);
  const named = H.listNamed(dir);
  assert.deepEqual(named.map((v) => v.name), ['Sent to Maria']);
  assert.ok(await js(`!!document.querySelector('#chapter-history')`));
  await js(`${hv('.hv-delete')}.click()`);
  await until('the question', `!!document.querySelector('.modal-backdrop:not(#chapter-history) .fr-choice.danger')`);
  await js(`document.querySelector('.modal-backdrop:not(#chapter-history) .fr-choice.danger').click()`);
  await until('it gone', `![...document.querySelectorAll('#chapter-history .hv-vname')].length`);
  assert.deepEqual(H.listNamed(dir), []);
  assert.equal((await items()).length, 3);
});

const pb = (sel) => hv('.hv-player ' + sel);
test('Play: the chapter written again from a version, stepped, played through, colored by origin', async () => {
  const list = await items();
  await pick(list.findIndex((x) => x.kind === 'Imported'));
  await js(`${hv('[data-mode="play"]')}.click()`);
  await until('the player', `!!${pb('.pb')} && !!${pb('.pb-status')}.textContent`);
  assert.equal(await js(`${hv('.hv-page')}.hidden`), true, 'Read\'s page steps aside');
  assert.equal(await js(`${hv('.hv-restore')}.hidden && ${hv('.hv-copy')}.hidden`), true);
  assert.match(await js(`${hv('.hv-play-note')}.textContent`), /^From .+ to now: each change as the computer that made it had the chapter/);
  const total = Number(await js(`${pb('.pb')}.querySelectorAll('.pb-scrub').length && /(\\d+) steps/.exec(${pb('.pb-status')}.textContent)[1]`));
  assert.ok(total >= 3, 'the later sessions\' changes: ' + total);
  // where it starts is the version itself
  assert.equal((await js(`${pb('.pb-page')}.innerText`)).replace(/\s+/g, ' ').trim(), PARAS.join(' '));
  // the keys are the player's while it has the focus (and never reach the page underneath)
  const chapter = await js(`chapterHTML[${JSON.stringify(ids[0])}]`);
  await js(`${pb('.pb-play')}.focus()`);
  await key('Right');
  assert.equal(await js(`${pb('.pb')}.dataset.pos`), '1');
  assert.match(await js(`${pb('.pb-status')}.textContent`), new RegExp(`This computer · Typed · \\d+ words · Step 1 of ${total}$`));
  assert.ok(await js(`!!${pb('.pb-new')}`), 'what came in is marked');
  await key('End');
  assert.equal(await js(`${pb('.pb')}.dataset.pos`), String(total));
  const end = await js(`${pb('.pb-page')}.innerText`);
  assert.ok(end.includes('three times') && end.includes('Later still.'), end);
  await key('Left');
  assert.equal(await js(`${pb('.pb')}.dataset.pos`), String(total - 1));
  await type('zz');
  assert.equal(await js(`chapterHTML[${JSON.stringify(ids[0])}]`), chapter);
  // colored by origin: the import, and what was typed since
  await js(`${pb('.pb-origins input')}.click()`);
  await tick(150);
  assert.equal(await js(`${pb('.pb-legend')}.hidden`), false);
  assert.ok(await js(`!!${pb('.pb-o-imported')} && !!${pb('.pb-o-typed')}`));
  await shot('play-colored');
  // played through at 600×, from the start, to the end, where it stops
  await key('Home');
  await js(`(() => { const s = ${pb('.pb-speed')}; s.value = '600'; s.dispatchEvent(new Event('change')); })()`);
  await js(`${pb('.pb-play')}.click()`);
  assert.equal(await js(`${pb('.pb')}.classList.contains('pb-playing')`), true);
  await until('played to the end', `!${pb('.pb')}.classList.contains('pb-playing')`, 30000);
  assert.equal(await js(`${pb('.pb')}.dataset.pos`), String(total));
  // the newest version plays the chapter from its start
  await pick(0);
  await until('the player', `!!${pb('.pb-status')} && /steps/.test(${pb('.pb-status')}.textContent)`);
  assert.match(await js(`${hv('.hv-play-note')}.textContent`), /^From the chapter’s start to now/);
  assert.equal(await js(`${pb('.pb-page')}.innerText`).then((x) => /hasn't been started yet/.test(x)), true);
  // back to Read: the player's gone, the page is back
  await mode('view');
  assert.equal(await js(`!!document.querySelector('#chapter-history .pb')`), false);
  assert.equal(await js(`${hv('.hv-page')}.hidden`), false);
});

test('Esc closes it and the caret goes back where it was', async () => {
  await key('Escape');
  await tick(200);
  assert.equal(await js(`!!document.querySelector('#chapter-history')`), false);
  assert.equal(await js(`!!document.activeElement.closest('.chapter-body')`), true);
  assert.equal(await js(`currentTab`), 'manuscript');
  assert.ok(await js(`!!book`), 'the book is still open');
});

test('the shortcuts sheet lists ⌘⇧H', async () => {
  await js(`showHelp()`);
  await tick(200);
  const row = await js(`[...document.querySelectorAll('#keyboard-shortcuts .shortcut-row')].map((r) => r.innerText).find((t) => /Chapter history/.test(t)) || ''`);
  assert.match(row, process.platform === 'darwin' ? /⌘⇧H/ : /Ctrl\+Shift\+H/);
  await key('Escape');
});

// the History window opened from the menu, on chapter `id`, its versions listed
async function openHistory(id) {
  menuItem('View', 'Chapter History…').click();
  await until('the History window', `!!document.querySelector('#chapter-history .hv-item')`);
  if (id && (await js(`${hv('.hv-chapter')}.value`)) !== id) {
    await js(`(() => { const s = ${hv('.hv-chapter')}; s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change')); })()`);
    await until('its versions', `document.querySelectorAll('#chapter-history .hv-item').length > 0`);
  }
  await tick(300);
}
const restoreReady = () => until('Restore enabled', `!${hv('.hv-restore')}.hidden && !${hv('.hv-restore')}.disabled`);
const MOD = process.platform === 'darwin' ? 'meta' : 'control';

test('Restore This Version: the chapter goes back, a version of it named first', async () => {
  await caretEnd(0, 0);
  notes.before = await js(`chapterHTML[${JSON.stringify(ids[0])}]`);
  await openHistory(ids[0]);
  const list = await items();
  await pick(list.length - 1); // the import
  await restoreReady();
  assert.equal(await js(`${hv('.hv-restore')}.textContent`), 'Restore This Version');
  await shot('restore-button');
  await js(`${hv('.hv-restore')}.click()`);
  await until('the window closed', `!document.querySelector('#chapter-history')`);
  await until('the chapter put back', `!chapterHTML[${JSON.stringify(ids[0])}].includes('three times')`);
  const now = await js(`chapterHTML[${JSON.stringify(ids[0])}]`);
  assert.ok(now.includes('counted the boats twice') && !now.includes('The wind rose.') && !now.includes('Later still.'), now);
  assert.match(await js(`document.querySelector('#hint').textContent`), /is back to .*The text it replaced is the version “Before restoring Chapter 1/);
  const named = H.listNamed(path.join(LIB, bookId));
  assert.deepEqual(named.map((v) => v.auto), ['restore']);
  assert.match(named[0].name, /^Before restoring Chapter 1/);
  // the version named is the chapter as it was
  const was = await js(`window.neo.history.text(book.id, { named: ${JSON.stringify(named[0].file)} }, ${JSON.stringify(ids[0])})`);
  assert.equal(was.text, notes.before);
  await until('saved', `!Object.keys(chapterChain).length`);
  assert.equal(fs.readFileSync(path.join(LIB, bookId, 'chapters', ids[0] + '.html'), 'utf8'), now);
  assert.equal(await js(`!!document.activeElement.closest('.chapter-body')`), true, 'the caret is back in the chapter');
});

test('⌘Z, from inside the text, puts the chapter back as it was', async () => {
  await key('Z', [MOD]);
  await until('undone', `chapterHTML[${JSON.stringify(ids[0])}].includes('three times')`);
  assert.equal(await js(`chapterHTML[${JSON.stringify(ids[0])}]`), notes.before);
  // …and restored again, for the log to check below
  await openHistory(ids[0]);
  await pick((await items()).length - 1);
  await restoreReady();
  await js(`${hv('.hv-restore')}.click()`);
  await until('put back again', `!chapterHTML[${JSON.stringify(ids[0])}].includes('three times')`);
  await openHistory(ids[0]);
  // the chapter now is that version: nothing to restore
  await pick((await items()).findIndex((x) => x.kind === 'Imported'));
  assert.equal(await js(`${hv('.hv-restore')}.disabled`), true);
  await key('Escape');
});

test('a passage copied out of a version and pasted into the book: a restore', async () => {
  await openHistory(ids[0]);
  const list = await items();
  await pick(list.findIndex((x) => x.kind === 'Imported'));
  await js(`(() => {
    const page = ${hv('.hv-page')};
    const walk = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
    for (let t; (t = walk.nextNode());) {
      const i = t.data.indexOf('Gulls wheeled');
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(t, i);
      r.setEnd(t, t.data.length);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      return;
    }
  })()`);
  await js(`${hv('.hv-copy')}.click()`);
  await tick(200);
  assert.equal(await js(`!!(slogClips()[0] && slogClips()[0].history)`), true);
  assert.match(await js(`document.querySelector('#hint').textContent`), /Copied/);
  await key('Escape');
  await caretEnd(1, 0);
  await type(' ');
  wc.paste();
  await until('pasted', `chapterHTML[${JSON.stringify(ids[1])}].includes('Gulls wheeled over the empty slips.')`);
  await pause();
  await js(`slogSaveAll()`);
});

test('a line all in italics copies out of a version in italics', async () => {
  await openHistory(ids[0]);
  await pick((await items()).findIndex((x) => x.kind === 'Imported'));
  // (the import has no italics: one line of the page is set in them, as a version with them shows it)
  await js(`(() => {
    const p = [...${hv('.hv-page')}.querySelectorAll('p')].find((x) => x.textContent === 'Nets hung drying on the wall.');
    p.innerHTML = '<i>Nets hung drying on the wall.</i>';
    const r = document.createRange();
    r.selectNodeContents(p.querySelector('i').firstChild);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  })()`);
  await js(`${hv('.hv-copy')}.click()`);
  await tick(200);
  const { clipboard } = require('electron');
  assert.equal(clipboard.readText(), 'Nets hung drying on the wall.');
  assert.match(clipboard.readHTML(), /<i>Nets hung drying on the wall\.<\/i>/);
  await key('Escape');
  await caretEnd(1, 0);
  await type(' ');
  wc.paste();
  await until('pasted', `chapterHTML[${JSON.stringify(ids[1])}].includes('<i>Nets hung drying on the wall.</i>')`);
  await pause();
  await js(`slogSaveAll()`);
});

test('Restore as New Chapter: a deleted chapter back in its old place', async () => {
  await openHistory(ids[2]);
  await pick(0); // its last version before it was deleted
  await restoreReady();
  assert.equal(await js(`${hv('.hv-restore')}.textContent`), 'Restore as New Chapter');
  await js(`${hv('.hv-restore')}.click()`);
  await until('back in the book', `book.chapterOrder.includes(${JSON.stringify(ids[2])})`);
  assert.deepEqual(await js(`book.chapterOrder.slice()`), ids, 'after the chapter it followed');
  assert.ok((await js(`chapterHTML[${JSON.stringify(ids[2])}]`)).includes('The lighthouse kept its watch, and more'));
  assert.match(await js(`document.querySelector('#hint').textContent`), /is back in the book/);
  await until('saved', `!Object.keys(chapterChain).length`);
  assert.ok(fs.readFileSync(path.join(LIB, bookId, 'chapters', ids[2] + '.html'), 'utf8').includes('and more'));
  // and its history carries on: it's a chapter of the book again
  await openHistory(ids[2]);
  const groups = await js(`[...${hv('.hv-chapter')}.querySelectorAll('optgroup')].map((g) => g.label)`);
  assert.deepEqual(groups, ['In the book']);
  await key('Escape');
});

test('the log: every restore is one, and the words keep their origins', async () => {
  await js(`slogSaveAll()`);
  await tick(500);
  const dir = path.join(LIB, bookId);
  const res = checkBook(dir);
  assert.deepEqual(res.problems, []);
  const d = res.devices[res.devices.length - 1];
  assert.deepEqual(d.problems, []);
  assert.equal(d.sources.unlogged || 0, 0, 'nothing unlogged');
  const restores = d.chainEntries.filter((e) => e.kind === 'edit' && e.cause === 'restore');
  assert.ok(restores.length >= 4, 'two restores, the paste, the chapter put back: ' + restores.length);
  assert.ok(restores.every((e) => e.src === 'move' || e.src === 'typed'));
  const slog = require('../slog.js');
  const origin = (doc, needle) => {
    const t = d.traced[doc];
    const at = t.text.indexOf(needle);
    assert.ok(at >= 0, needle);
    return [...new Set(slog.originsAt(t, at, needle.length).map(([, o]) => o))];
  };
  assert.deepEqual(origin(slog.chapterDoc(ids[0]), 'Mara counted the boats twice.'), ['import']);
  assert.deepEqual(origin(slog.chapterDoc(ids[1]), 'Gulls wheeled over the empty slips.'), ['import']);
  assert.deepEqual(origin(slog.chapterDoc(ids[2]), 'The lighthouse kept its watch'), ['import']);
  assert.deepEqual(origin(slog.chapterDoc(ids[2]), ', and more'), ['typed']);
});

test('the log still checks, and the window wrote nothing into the book but the names', async () => {
  await js(`backToShelf()`);
  await tick(1000);
  const dir = path.join(LIB, bookId);
  const res = checkBook(dir);
  assert.deepEqual(res.problems, []);
  for (const d of res.devices) assert.deepEqual(d.problems, []);
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(path.join(tmp, 'app', 'slog', 'history')), 'checkpoints in userData');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => /history|\.gz$/.test(f)), []);
  assert.deepEqual(H.listNamed(dir).map((v) => v.auto), ['restore', 'restore'], 'the only versions written: before each restore');
  let errors = '';
  try { errors = fs.readFileSync(path.join(LIB, 'neo-errors.log'), 'utf8'); } catch { /* none */ }
  assert.equal(errors, '');
});

/* ---------- runner ---------- */

async function main() {
  await app.whenReady();
  let failed = 0;
  try {
    let win;
    while (!(win = BrowserWindow.getAllWindows()[0])) await tick(50);
    wc = win.webContents;
    while (!(await js(`typeof library !== 'undefined' && !!library`).catch(() => false))) await tick(50);
    await tick(300);
    const md = path.join(tmp, 'harbor.md');
    fs.writeFileSync(md, ['# The Harbor', ...PARAS, '# The Second', 'The second chapter begins.', '# Lighthouse', 'The lighthouse kept its watch'].join('\n\n'));
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
    ids = await js(`book.chapterOrder.slice()`);
    // session 1 was the import; session 2: words typed
    await reopen();
    await caretEnd(0, 0);
    await type(' The wind rose.');
    await caretEnd(2, 0);
    await type(', and more');
    await pause();
    await reopen();
    // session 3: the book named, a word changed, more typed, a chapter deleted
    await js(`(async () => { await slogSaveAll(); await window.neo.history.mark(book.id, 'Midway'); })()`);
    await tick(300);
    await selectText(0, 'twice');
    await type('three times');
    await pause();
    await caretEnd(0, PARAS.length - 1);
    await type(' Later still.');
    await pause();
    await js(`deleteChapterToDarlings(${JSON.stringify(ids[2])}, true)`);
    await tick(800);
    await js(`slogSaveAll()`);
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
