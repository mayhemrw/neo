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
// a chapter's paragraph as markup
const para = (ch, p) => js(`document.querySelectorAll('.chapter-body')[${ch}].querySelectorAll('p')[${p}].innerHTML`);
// the book's named versions, as main.js lists them
const versionsNamed = () => js(`window.neo.history.named(${JSON.stringify(bookId)})`);
// the dialog on top (the first-run one is in the page too, hidden)
const TOP = `[...document.querySelectorAll('.modal-backdrop:not([hidden])')].pop()`;
async function until(cond, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting: ' + cond);
    await tick(50);
  }
}
// a letter key as typed (e.code KeyK), with Shift when it's a capital asked for
async function keyCode(k, shift = false) {
  const modifiers = shift ? ['shift'] : [];
  wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers });
  await tick(80);
}

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

// ---- the results list (milestone 2)
const key = async (keyCode, n = 1) => {
  for (let i = 0; i < n; i++) {
    wc.sendInputEvent({ type: 'keyDown', keyCode });
    wc.sendInputEvent({ type: 'keyUp', keyCode });
    await tick(30);
  }
  await tick(60);
};
// the rows drawn now: heads and hits, as the writer reads them
const listRows = () => js(`[...document.querySelectorAll('#find-results .fr-space > div')].map((d) => ({
  head: d.classList.contains('fr-group'),
  text: [...d.childNodes].filter((c) => !(c.classList && c.classList.contains('fr-acts'))).map((c) => c.textContent).join(''),
  html: d.querySelector('.fr-line') ? d.querySelector('.fr-line').innerHTML : '',
  at: d.classList.contains('at'),
  cur: d.classList.contains('cur'),
  k: +d.id.slice(7)
}))`);
const listPlace = () => js(`(() => {
  const el = $('#find-results');
  const pane = $('#side-pane');
  return {
    shown: !!el && !el.hidden,
    parent: el && el.parentElement.id,
    pressed: $('#search-list').getAttribute('aria-pressed'),
    paneOpen: pane.classList.contains('open'),
    panePinned: pane.dataset.pinned,
    sidePinned: $('#editor-view').classList.contains('side-pinned'),
    notesShown: getComputedStyle($('#sticky-list')).display !== 'none',
    dock: el ? el.querySelector('.fr-dock').textContent : '',
    kept: JSON.parse(localStorage.getItem('neo-device-look') || '{}').findDock
  };
})()`);

test('the list is hidden until asked for; List opens it below the bar, as wide as the page', async () => {
  await find('colour');
  let p = await listPlace();
  assert.equal(p.shown, false, 'no list until asked');
  assert.equal(p.pressed, 'false');
  await press('search-list');
  p = await listPlace();
  assert.equal(p.shown, true);
  assert.equal(p.parent, 'searchbar');
  assert.equal(p.pressed, 'true');
  assert.equal(p.dock, 'Dock');
  const box = await js(`(() => {
    const r = $('#find-results').getBoundingClientRect();
    const bar = $('#searchbar').getBoundingClientRect();
    const page = document.querySelector('.chapter.sheet').getBoundingClientRect();
    return { top: r.top, barBottom: bar.bottom, w: r.width, pageW: page.width, mid: r.left + r.width / 2, pageMid: page.left + page.width / 2 };
  })()`);
  assert.ok(box.top >= box.barBottom, 'below the bar');
  assert.ok(Math.abs(box.w - box.pageW) < 40, `as wide as the page (${box.w} vs ${box.pageW})`);
  await shot('list-below');
});

test('hits grouped under their chapters, with a count and the match in bold', async () => {
  await find('colour');
  const rows = await listRows();
  const heads = rows.filter((r) => r.head).map((r) => r.text);
  const labels = await js(`book.chapterOrder.map(findChapterLabel)`);
  assert.deepEqual(heads, [labels[0] + '2', labels[1] + '1']);
  assert.match(labels[1], /The Old Mill$/);
  const hits = rows.filter((r) => !r.head);
  assert.equal(hits.length, 3);
  assert.equal(hits[0].html, '<b>Colour</b> ran off the walls. The colour was gone.');
  // about 40 characters each side, cut between words, … where it goes on
  assert.equal(hits[2].text, 'Nobody had seen the colour of its water since the old house…');
  assert.ok(hits[2].html.includes('<b>colour</b>'));
});

test('hits that cross formatting come first, under their own heading, in their formatting', async () => {
  await find('the old house');
  const rows = await listRows();
  assert.deepEqual(rows.map((r) => r.head), [true, false, true, false]);
  assert.equal(rows[0].text, 'Crosses formatting1');
  // it says which chapter, and shows the italic word in italics
  assert.match(rows[1].text, /^Chapter 1.*She came back to the old house at dusk\.$/);
  assert.ok(rows[1].html.includes('<mark>the </mark><mark><i>old</i></mark><mark> house</mark>'), rows[1].html);
  assert.match(rows[2].text, /The Old Mill1$/);
  assert.ok(rows[3].html.includes('<b>the old house</b>'));
});

test('a title is listed first under its chapter, marked Title', async () => {
  await press('find-titles');
  await find('mill');
  const rows = await listRows();
  assert.deepEqual(rows.map((r) => r.head), [true, false, false]);
  assert.match(rows[1].text, /^Title/);
  assert.ok(rows[1].html.includes('<b>Mill</b>'));
  await press('find-titles');
});

test('a click on a line goes there, like the arrows', async () => {
  await find('colour');
  await js(`document.querySelectorAll('#find-results .fr-hit')[2].click()`);
  await tick(100);
  assert.equal(await js(`searchState.idx`), 2);
  assert.equal(await js(`$('#search-count').textContent`), '3 of 3');
  assert.equal(await js(`[...CSS.highlights.get('neo-search-current')][0].toString()`), 'colour');
  const rows = await listRows();
  assert.equal(rows.filter((r) => r.at).length, 1);
  assert.equal(rows.find((r) => r.at).text, 'Nobody had seen the colour of its water since the old house…');
  // and ↑ in the bar moves the mark in the list
  await js(`$('#search-prev').click()`);
  await tick(60);
  assert.equal(await js(`searchState.idx`), 1);
  assert.equal((await listRows()).find((r) => r.at).html, 'Colour ran off the walls. The <b>colour</b> was gone.');
});

test('the keyboard: ↓ from the Find box into the list, ↑ ↓ move, Enter goes, Esc back to the box', async () => {
  await find('colour');
  await js(`$('#search-input').focus()`);
  await key('Down');
  assert.equal(await js(`document.activeElement.className`), 'fr-scroll');
  let rows = await listRows();
  assert.equal(rows.filter((r) => r.cur).length, 1, 'a line is picked');
  assert.match(rows.find((r) => r.cur).html, /^<b>Colour<\/b>/);
  await key('Down', 2);
  rows = await listRows();
  assert.equal(rows.find((r) => r.cur).text, 'Nobody had seen the colour of its water since the old house…', 'the heading skipped');
  assert.equal(await js(`searchState.idx`), -1, 'moving alone goes nowhere');
  await key('Return');
  assert.equal(await js(`searchState.idx`), 2);
  await key('Home');
  await key('Return');
  assert.equal(await js(`searchState.idx`), 0);
  await key('End');
  assert.equal((await listRows()).find((r) => r.cur).k, await js(`findList.rows.length - 1`));
  await key('Escape');
  assert.equal(await js(`document.activeElement.id`), 'search-input');
  assert.equal(await js(`$('#searchbar').hidden`), false, 'the bar stays open');
});

test('Dock moves the list into the right-hand pane, over the notes; Undock puts the pane back', async () => {
  await find('colour');
  let p = await listPlace();
  assert.equal(p.panePinned === '1', false, 'the pane starts unpinned');
  await js(`$('#find-results .fr-dock').click()`);
  await tick(250);
  p = await listPlace();
  assert.equal(p.parent, 'side-pane');
  assert.equal(p.paneOpen, true);
  assert.equal(p.sidePinned, true, 'the page moves over, as for a pinned pane');
  assert.equal(p.notesShown, false, 'over the notes');
  assert.equal(p.dock, 'Undock');
  assert.equal(p.kept, true, 'kept for this computer');
  const box = await js(`(() => { const r = $('#find-results').getBoundingClientRect(); return { h: r.height, win: innerHeight }; })()`);
  assert.ok(box.h > box.win * 0.75, 'as tall as the window');
  assert.equal((await listRows()).filter((r) => !r.head).length, 3);
  // three lines a hit in the narrower pane
  assert.equal(await js(`document.querySelector('#find-results .fr-hit').offsetHeight`), 60);
  // the pane stays while the pointer is elsewhere
  await js(`closeUnpinnedPanes()`);
  assert.equal((await listPlace()).paneOpen, true);
  // the bar moves over with the page, clear of the pane
  const clear = await js(`(() => {
    const bar = $('#searchbar').getBoundingClientRect();
    const pane = $('#side-pane').getBoundingClientRect();
    const sum = $('#find-results .fr-sum').getBoundingClientRect();
    return { bar: bar.right, pane: pane.left, sumBelow: sum.top >= bar.bottom || sum.left >= bar.right };
  })()`);
  assert.ok(clear.bar <= clear.pane, `the bar (to ${clear.bar}) clear of the pane (from ${clear.pane})`);
  assert.ok(clear.sumBelow);
  await tick(300);
  await shot('list-docked');
  await js(`$('#find-results .fr-dock').click()`);
  await tick(250);
  p = await listPlace();
  assert.equal(p.parent, 'searchbar');
  assert.equal(p.panePinned, '0');
  assert.equal(p.sidePinned, false);
  assert.equal(p.notesShown, true);
  assert.equal(p.kept, false);
});

test('a pinned pane stays pinned after the list leaves it; closing Find undocks too', async () => {
  await js(`pinPane('side', true)`);
  await js(`$('#find-results .fr-dock').click()`);
  await tick(200);
  assert.equal((await listPlace()).parent, 'side-pane');
  await js(`closeSearch()`);
  await tick(200);
  const p = await listPlace();
  assert.equal(p.shown, false);
  assert.equal(p.panePinned, '1');
  assert.equal(p.sidePinned, true);
  assert.equal(p.paneOpen, true);
  assert.equal(p.notesShown, true);
  await js(`pinPane('side', false)`);
  // the next Find: hidden until asked, then where it was last (docked)
  await js(`openSearch()`);
  await find('colour');
  assert.equal((await listPlace()).shown, false);
  await press('search-list');
  assert.equal((await listPlace()).parent, 'side-pane');
});

test('docked in the Notes tab: the list says it searches the Notes tab', async () => {
  await js(`switchTab('notes')`);
  await tick(400);
  await js(`(() => { const ed = $('#aux-editor'); ed.focus(); const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
  wc.insertText('The colour of the sea.');
  await tick(1200);
  await find('colour');
  const rows = await listRows();
  assert.deepEqual(rows.map((r) => r.head ? r.text : r.html), ['Notes1', 'The <b>colour</b> of the sea.']);
  assert.equal(await js(`!$('#find-results .fr-note').hidden`), true);
  assert.match(await js(`$('#find-results .fr-note').textContent`), /Notes tab/);
  await js(`switchTab('manuscript')`);
  await tick(400);
  assert.equal(await js(`$('#find-results .fr-note').hidden`), true);
  assert.equal((await listRows()).filter((r) => !r.head).length, 3, 'the list follows the tab');
  await js(`$('#find-results .fr-dock').click()`);
  await tick(200);
});

test('the list keeps up with the page, and keeps its place', async () => {
  await find('colour');
  await js(`gotoMatch(1)`);
  // a new "colour" typed at the end of chapter 2
  await js(`(() => {
    const ps = document.querySelectorAll('.chapter-body')[1].querySelectorAll('p');
    const p = ps[ps.length - 1];
    p.closest('.chapter-body').focus();
    const r = document.createRange(); r.selectNodeContents(p); r.collapse(false);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  })()`);
  wc.insertText(' A colour.');
  await tick(1300);
  const r = await js(`({ n: searchState.matches.length, idx: searchState.idx, count: $('#search-count').textContent })`);
  assert.equal(r.n, 4);
  assert.equal(r.idx, 1, 'still on the hit it was on');
  assert.equal(r.count, '2 of 4');
  assert.equal((await listRows()).filter((x) => !x.head).length, 4);
  await js(`$('#search-list').click()`);
  assert.equal((await listPlace()).shown, false);
});

test('Include chapter titles: found when asked, first in its chapter', async () => {
  assert.equal((await find('mill')).found.filter((m) => m.title).length, 0);
  await press('find-titles');
  assert.deepEqual(await pressed(), ['false', 'false', 'true']);
  const r = await find('mill');
  assert.deepEqual(r.found.map((m) => [m.text, m.title, m.ch]), [['Mill', true, 1], ['mill', false, 1]]);
  // Replace on a title changes it, the heading and the nav with it; ⌘Z puts it back
  await js(`(async () => { gotoMatch(0); $('#replace-input').value = 'Forge'; await replaceCurrent(); })()`);
  await tick(300);
  assert.equal(await js(`book.chapterTitles[book.chapterOrder[1]]`), 'The Old Forge');
  assert.equal(await js(`document.querySelectorAll('.ch-title')[1].textContent`), 'The Old Forge');
  assert.ok(await js(`[...document.querySelectorAll('.nav-item')].some((n) => /The Old Forge/.test(n.textContent))`));
  await js(`structuralUndo()`);
  await tick(500);
  assert.equal(await js(`book.chapterTitles[book.chapterOrder[1]]`), 'The Old Mill');
  assert.equal(await js(`document.querySelectorAll('.ch-title')[1].textContent`), 'The Old Mill');
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

test('Replace on a phrase across italics asks how: Cancel leaves it, Keep formatting goes word by word', async () => {
  await find('the old house');
  const choices = () => js(`[...${TOP}.querySelectorAll('.fr-choice strong')].map((b) => b.textContent)`);
  await js(`(() => { gotoMatch(0); $('#replace-input').value = 'the new home'; replaceCurrent(); })()`);
  await tick(150);
  assert.deepEqual(await choices(), ['Keep formatting', 'Plain']);
  assert.equal(await js(`document.activeElement.textContent.trim().startsWith('Keep formatting')`), true, 'the first choice has the focus');
  await js(`${TOP}.querySelector('.m-cancel').click()`);
  await tick(150);
  assert.ok((await bodyText(0)).includes('the old house'), 'nothing changed');
  await js(`(() => { gotoMatch(0); replaceCurrent(); })()`);
  await tick(150);
  await js(`${TOP}.querySelector('.fr-choice').click()`);
  await tick(300);
  assert.ok((await para(0, 1)).includes('the <i>new</i> home at dusk'), await para(0, 1));
  await js(`structuralUndo()`);
  await tick(500);
  assert.ok((await para(0, 1)).includes('the <i>old</i> house at dusk'), await para(0, 1));
  // a plain one is replaced with no question
  await find('dusk');
  await js(`(async () => { gotoMatch(0); $('#replace-input').value = 'dawn'; await replaceCurrent(); })()`);
  await tick(200);
  assert.ok((await bodyText(0)).includes('at dawn.'));
  assert.equal(await js(`document.querySelectorAll('.modal-backdrop:not([hidden])').length`), 0);
});

test('Replace All honors Match case and Whole word, and leaves what crosses italics', async () => {
  await press('find-case');
  await press('find-word');
  await find('cat');
  await js(`(async () => { $('#replace-input').value = 'dog'; await replaceAllMatches(); })()`);
  await tick(300);
  const one = await bodyText(0);
  assert.ok(one.includes('The dog scattered the other cats. A dog watched.'), one);
  assert.match(await toastText(), /^2 replaced across the whole book\. .+ to undo, or the version “Before replacing ‘cat’ \(\w+ \d+\)” in Chapter History\.$/);
  // the version was named first, as NEO's own (auto: replace)
  const named = await versionsNamed();
  assert.deepEqual(named.map((v) => [v.auto, /^Before replacing ‘cat’ \(/.test(v.name)]), [['replace', true]]);
  await press('find-case');
  await press('find-word');
  // across chapters: the plain one replaced, the one across italics left alone
  const before = { one: await bodyText(0), two: await bodyText(1), titles: await js(`JSON.stringify(book.chapterTitles)`) };
  notes.before = before;
  const r = await find('the old house');
  assert.deepEqual(r.found.map((m) => [m.ch, m.crosses]), [[0, true], [1, false]]);
  await js(`(async () => { $('#replace-input').value = 'the new home'; await replaceAllMatches(); })()`);
  await tick(300);
  const toast = await toastText();
  assert.match(toast, /^1 replaced across the whole book\./);
  assert.match(toast, /1 left: they cross italics or bold \(see the list\)\./);
  assert.equal((await versionsNamed()).length, 2, 'a version every time');
  // the list opens on the one left, under Crosses formatting
  const rows = await listRows();
  assert.equal(rows[0].text.startsWith('Crosses formatting'), true, rows[0].text);
  assert.equal(rows.find((x) => x.cur).k, 1);
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
  await js(`(async () => { $('#replace-input').value = 'water wheel'; await replaceAllMatches(); })()`);
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

test('in the list: K keeps formatting, P goes plain, each one step; the heading does them all', async () => {
  // a second phrase across italics, in chapter 2
  await js(`(() => {
    const body = document.querySelectorAll('.chapter-body')[1];
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
  await js(`openSearch()`);
  await find('the old house');
  if (!(await listPlace()).shown) await press('search-list');
  await js(`$('#replace-input').value = 'the new home'; findListFocus()`);
  let rows = await listRows();
  assert.deepEqual(rows.filter((r) => r.head).map((r) => r.text), ['Crosses formatting2']);
  // the buttons are there on the line the keyboard is on
  assert.equal(await js(`getComputedStyle(document.querySelector('#find-results .fr-hit.cur .fr-acts')).display`), 'flex');
  await shot('list-crossing');
  // K on the first: word by word, the italic word stays italic
  await keyCode('K');
  await tick(200);
  assert.ok((await para(0, 1)).includes('the <i>new</i> home at dawn'), await para(0, 1));
  rows = await listRows();
  assert.equal(rows.filter((r) => !r.head).length, 1, 'that hit left the list');
  assert.equal(rows.find((r) => r.cur).k, 1, 'on the next one');
  // P on the next: no italics in the new words
  await keyCode('P');
  await tick(200);
  assert.ok((await para(1, 1)).includes('since the new home burned.'), await para(1, 1));
  assert.ok(!/<(i|em)>/.test(await para(1, 1)), await para(1, 1));
  assert.equal(await js(`searchState.matches.length`), 0);
  // each was one step: ⌘Z twice brings both back
  await js(`structuralUndo()`);
  await tick(500);
  await js(`structuralUndo()`);
  await tick(500);
  await find('the old house');
  assert.deepEqual(await js(`searchState.matches.map((m) => m.crosses)`), [true, true]);
  // the heading's Plain: both at once, one step
  await js(`document.querySelector('#find-results .fr-group.fr-crosses .fr-acts [data-how="plain"]').click()`);
  await tick(300);
  assert.ok((await para(0, 1)).includes('to the new home at dawn'), await para(0, 1));
  assert.ok((await para(1, 1)).includes('since the new home burned.'));
  assert.match(await toastText(), /^2 replaced, as plain text\./);
  await js(`structuralUndo()`);
  await tick(500);
  assert.ok((await para(0, 1)).includes('the <i>old</i> house'), await para(0, 1));
  assert.ok((await para(1, 1)).includes('the <i>old</i> house'), await para(1, 1));
});

test('Replace All with titles included: the title and the text, and the version keeps the titles', async () => {
  await press('find-titles');
  await find('mill');
  await js(`(async () => { $('#replace-input').value = 'Forge'; await replaceAllMatches(); })()`);
  await tick(400);
  assert.match(await toastText(), /^2 replaced across the whole book \(1 in chapter titles\)\./);
  assert.equal(await js(`book.chapterTitles[book.chapterOrder[1]]`), 'The Old Forge');
  assert.ok((await bodyText(1)).startsWith('The Forge wheel was still.'), await bodyText(1));
  await press('find-titles');
  await js(`closeSearch()`);
  // as after a restart: no ⌘Z to go back with
  await js(`undoStack = []; slogSaveAll()`);
  await tick(600);
});

test('Chapter History: the version shows its title, and Restore This Version puts it back too', async () => {
  const ch2 = await js(`book.chapterOrder[1]`);
  await js(`showHistory({ chapterId: ${JSON.stringify(ch2)} })`);
  await until(() => js(`!!document.querySelector('#chapter-history .hv-item.named')`));
  await js(`[...document.querySelectorAll('#chapter-history .hv-item.named')].find((x) => /Before replacing ‘mill’/.test(x.textContent)).click()`);
  await until(() => js(`!document.querySelector('#chapter-history .hv-titleline').hidden`));
  assert.equal(await js(`document.querySelector('#chapter-history .hv-titleline').textContent`), 'Title The Old Mill (now: The Old Forge)');
  await js(`document.querySelector('#chapter-history [data-mode="compare"]').click()`);
  await until(() => js(`!!document.querySelector('#chapter-history .hv-titleline del')`));
  assert.equal(await js(`document.querySelector('#chapter-history .hv-titleline del').textContent`), 'The Old Mill');
  assert.equal(await js(`document.querySelector('#chapter-history .hv-titleline ins').textContent`), 'The Old Forge');
  await shot('history-title');
  await until(() => js(`!document.querySelector('#chapter-history .hv-restore').disabled`));
  await js(`document.querySelector('#chapter-history .hv-restore').click()`);
  await until(() => js(`!document.querySelector('#chapter-history')`));
  await tick(600);
  assert.equal(await js(`book.chapterTitles[book.chapterOrder[1]]`), 'The Old Mill');
  assert.ok((await bodyText(1)).startsWith('The mill wheel was still.'), await bodyText(1));
  assert.match(await toastText(), /Its title is back to “The Old Mill” too\./);
  // one step: ⌘Z takes the text and the title back together
  await js(`structuralUndo()`);
  await tick(500);
  assert.equal(await js(`book.chapterTitles[book.chapterOrder[1]]`), 'The Old Forge');
  assert.ok((await bodyText(1)).startsWith('The Forge wheel'));
  await js(`undoStack = []`);
});

test('Restore Titles on a named version sets every title back as it was then', async () => {
  const ch2 = await js(`book.chapterOrder[1]`);
  await js(`showHistory({ chapterId: ${JSON.stringify(ch2)} })`);
  await until(() => js(`!!document.querySelector('#chapter-history .hv-item.named')`));
  await js(`[...document.querySelectorAll('#chapter-history .hv-item.named')].find((x) => /Before replacing ‘mill’/.test(x.textContent)).click()`);
  await until(() => js(`!document.querySelector('#chapter-history .hv-named-tools').hidden`));
  await js(`document.querySelector('#chapter-history .hv-titles').click()`);
  await until(() => js(`!document.querySelector('#chapter-history')`));
  await tick(600);
  assert.equal(await js(`book.chapterTitles[book.chapterOrder[1]]`), 'The Old Mill');
  assert.equal(await js(`book.chapterTitles[book.chapterOrder[0]]`), 'The House', 'a title that hadn\'t changed stays');
  assert.ok((await bodyText(1)).startsWith('The Forge wheel'), 'the text stays as it is');
  assert.match(await toastText(), /^1 chapter title is back as it was in “Before replacing ‘mill’/);
  // on disk too
  assert.equal(JSON.parse(fs.readFileSync(path.join(LIB, bookId, 'book.json'), 'utf8')).chapterTitles[ch2], 'The Old Mill');
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
  assert.ok(d.chainEntries.some((e) => e.kind === 'edit' && e.doc === 'book' && e.cause === 'replace' && (e.keys || []).includes('chapterTitles')), 'a title replaced, as a book edit');
  assert.ok(d.chainEntries.some((e) => e.kind === 'edit' && e.doc === 'book' && e.cause === 'restore' && (e.keys || []).includes('chapterTitles')), 'titles restored, as a book edit');
  assert.ok((await versionsNamed()).filter((v) => v.auto === 'replace').length >= 3);
  let errors = '';
  try { errors = fs.readFileSync(path.join(LIB, 'neo-errors.log'), 'utf8'); } catch { /* none */ }
  assert.equal(errors, '');
});

test('a long book: 5,000 hits, and only the lines on screen are drawn', async () => {
  const md = path.join(tmp, 'long.md');
  const para = 'The tide came in over the stones, and the gulls rose. The harbor light turned. The boats knocked together.';
  const chapters = [];
  for (let c = 0; c < 10; c++) chapters.push(`# Tide ${c + 1}`, ...Array.from({ length: 84 }, () => para));
  fs.writeFileSync(md, chapters.join('\n\n'));
  await js(`(async () => {
    const results = await window.neo.importFiles([${JSON.stringify(md)}]);
    await addImportedBooks(results, library.shelves[0]);
    const ids = library.shelves[0].bookIds;
    await openBook(ids[ids.length - 1]);
  })()`);
  await tick(1500);
  await js(`openSearch()`);
  const took = await js(`(() => {
    $('#search-input').value = 'the';
    const t0 = performance.now();
    runSearch();
    if (!findList.open) toggleFindList(true);
    return { ms: performance.now() - t0, n: searchState.matches.length };
  })()`);
  assert.ok(took.n >= 5000, `${took.n} hits`);
  await tick(100);
  const drawn = () => js(`document.querySelectorAll('#find-results .fr-space > div').length`);
  assert.ok(await drawn() < 80, `${await drawn()} rows drawn`);
  // the list is as tall as every row would be
  assert.equal(await js(`$('#find-results .fr-space').offsetHeight`), await js(`findList.total`));
  console.log(`     (${took.n} hits found and listed in ${Math.round(took.ms)} ms)`);
  // to the end and back: the lines there are drawn, and Enter goes to the last
  await js(`$('#find-results .fr-scroll').focus()`);
  await key('End');
  await key('Return');
  assert.equal(await js(`searchState.idx`), took.n - 1);
  assert.ok(await drawn() < 80);
  const last = await js(`[...document.querySelectorAll('#find-results .fr-hit')].pop().textContent`);
  assert.match(last, /boats knocked together\.$/);
  await js(`$('#find-results .fr-scroll').scrollTop = findList.total / 2`);
  await tick(150);
  const mid = await listRows();
  assert.ok(mid.length > 5 && mid.length < 80);
  assert.ok(mid.some((r) => r.head && /^Chapter 6/.test(r.text)), mid.filter((r) => r.head).map((r) => r.text).join(', '));
  await shot('list-long');
  await js(`closeSearch(); backToShelf()`);
  await tick(500);
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
