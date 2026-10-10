// End-to-end test for the guides (Help → How-To Guide… and Help → FAQ…)
// on NEO's real menu: every menu name docs/HOW-TO.md and docs/FAQ.md give
// is a real menu item at that place, the Help items open the guides in a
// window (sections down the side, links between the guides, Esc puts the
// caret back), the command palette has them, and nothing from a guide
// reaches the page as markup.
// Run with `npm run test:guide` (under xvfb-run without a display).

'use strict';

process.env.NEO_SLOG_STAMPS = process.env.NEO_SLOG_STAMPS || 'off';

const { app, BrowserWindow, Menu } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../guide.js');

for (const name of fs.readdirSync(os.tmpdir())) {
  const pid = /^neo-guide-test-(\d+)-/.exec(name);
  if (!pid || +pid[1] === process.pid) continue;
  try { process.kill(+pid[1], 0); continue; } catch (err) { if (err.code === 'EPERM') continue; }
  fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `neo-guide-test-${process.pid}-`));
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

let wc;
const js = (code) => wc.executeJavaScript(code, true);
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(cond, ms = 6000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting: ' + cond);
    await tick(40);
  }
}
async function key(keyCode, modifiers = []) {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (!modifiers.length || modifiers.every((m) => m === 'shift')) wc.sendInputEvent({ type: 'char', keyCode, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await tick(60);
}
async function shot(name) {
  if (!process.env.NEO_TEST_SHOTS) return;
  const img = await wc.capturePage();
  fs.writeFileSync(path.join(process.env.NEO_TEST_SHOTS, name + '.png'), img.toPNG());
}
// a menu item's name as the menu shows it: no && for &, no shortcut after a tab
const shown = (label) => String(label || '').replace(/&&/g, '&').split('\t')[0].trim();
function menuItem(names) {
  let items = Menu.getApplicationMenu().items;
  let item = null;
  for (const name of names) {
    item = items.find((it) => it.type !== 'separator' && it.visible !== false && shown(it.label) === name);
    if (!item) return null;
    items = item.submenu ? item.submenu.items : [];
  }
  return item;
}
const isOpen = () => js(`!!document.getElementById('neo-guide')`);
const state = () => js(`(() => {
  const bd = document.getElementById('neo-guide');
  if (!bd) return null;
  return {
    guide: bd.dataset.guide,
    tab: (bd.querySelector('.guide-tabs [aria-selected="true"]') || {}).textContent,
    h1: (bd.querySelector('.guide-content h1') || {}).textContent,
    toc: [...bd.querySelectorAll('.guide-toc a')].map((a) => a.textContent),
    scroll: bd.querySelector('.guide-content').scrollTop,
    focus: document.activeElement.className
  };
})()`);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

for (const file of ['HOW-TO.md', 'FAQ.md']) {
  test(`${file}: every menu name it gives is a real menu item, at that place`, async () => {
    const paths = G.menuPaths(fs.readFileSync(path.join(__dirname, '..', 'docs', file), 'utf8'));
    assert.ok(paths.length >= 10);
    for (const p of paths) assert.ok(menuItem(p), `no menu item ${p.join(' → ')}`);
  });
}

test('Help → How-To Guide… opens the how-to, its sections down the side', async () => {
  menuItem(['Help', 'How-To Guide…']).click();
  await until(isOpen);
  await until(async () => (await state()).h1 === 'How-To Guide');
  const s = await state();
  assert.equal(s.guide, 'how-to');
  assert.equal(s.tab, 'How-To Guide');
  assert.ok(s.toc.includes('Prove you wrote your book'));
  assert.ok(s.toc.includes('Send your book to an editor and bring it back'));
  assert.equal(s.focus, 'guide-content');
  assert.equal(await js(`document.querySelectorAll('#neo-guide .guide-content script, #neo-guide .guide-content img').length`), 0);
  await tick(400);
  await shot('guide-how-to');
});

test('a section on the side scrolls to it; the guide keeps the keys', async () => {
  await js(`[...document.querySelectorAll('#neo-guide .guide-toc a')].find((a) => a.textContent === 'Export in manuscript format').click()`);
  await tick(100);
  assert.ok((await state()).scroll > 200, 'scrolled down');
  await shot('guide-how-to-section');
  // Tab stays inside the window
  for (let i = 0; i < 40; i++) {
    await key('Tab');
    assert.ok(await js(`!!document.activeElement.closest('#neo-guide')`), 'focus left the guide');
  }
});

test('the FAQ link and tab switch guides; Help → FAQ… does too', async () => {
  await js(`document.querySelector('#neo-guide .guide-content a[data-guide="faq"]').click()`);
  await until(async () => (await state()).guide === 'faq');
  let s = await state();
  assert.equal(s.h1, 'FAQ');
  assert.equal(s.tab, 'FAQ');
  assert.ok(s.toc.includes('Can it prove I didn\'t use AI?'));
  assert.equal(await js(`document.querySelector('#neo-guide .guide-toc').scrollTop`), 0, 'its contents from the top');
  await tick(300);
  await shot('guide-faq');
  await js(`document.querySelector('#neo-guide .guide-tabs [data-guide="how-to"]').click()`);
  await until(async () => (await state()).guide === 'how-to');
  menuItem(['Help', 'FAQ…']).click();
  await until(async () => (await state()).guide === 'faq');
  s = await state();
  assert.equal(s.scroll, 0, 'a guide opens at its top');
  assert.equal(await js(`document.querySelectorAll('#neo-guide').length`), 1, 'never two');
});

test('Esc closes it; so does Done', async () => {
  await key('Escape');
  await until(async () => !(await isOpen()));
  menuItem(['Help', 'FAQ…']).click();
  await until(isOpen);
  await js(`document.querySelector('#neo-guide .m-ok').click()`);
  await tick(300);
  assert.equal(await isOpen(), false, 'Done closes the window (it used to open it again)');
});

test('the command palette lists both, under Help', async () => {
  await js(`togglePalette()`);
  await until(() => js(`!!document.getElementById('command-palette')`));
  await tick(100);
  const rows = await js(`[...document.querySelectorAll('#command-palette .pal-item')].map((el) => ({
    name: el.querySelector('.pal-name').firstChild.textContent,
    path: (el.querySelector('.pal-path') || {}).textContent || ''
  }))`);
  assert.deepEqual(rows.filter((r) => r.path === 'Help').map((r) => r.name).filter((n) => n !== 'About NEO' && n !== 'Check for Update…'),
    ['NEO Shortcuts', 'How-To Guide…', 'FAQ…']);
  await key('Escape');
  await until(async () => !(await js(`!!document.getElementById('command-palette')`)));
});

test('a book open: the guide comes and goes, the caret back where it was', async () => {
  const md = path.join(tmp, 'tide.md');
  fs.writeFileSync(md, ['# The Harbor', 'The tide came in over the stones.'].join('\n\n'));
  await js(`(async () => {
    document.getElementById('firstrun').hidden = true;
    const results = await window.neo.importFiles([${JSON.stringify(md)}]);
    await addImportedBooks(results, library.shelves[0]);
    const ids = library.shelves[0].bookIds;
    await openBook(ids[ids.length - 1]);
  })()`);
  await tick(800);
  // the caret at the end of the first paragraph
  await js(`(() => {
    const body = document.querySelector('.chapter-body');
    body.focus();
    const p = body.querySelector('p');
    const r = document.createRange();
    r.selectNodeContents(p);
    r.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  })()`);
  await tick(100);
  menuItem(['Help', 'How-To Guide…']).click();
  await until(isOpen);
  await tick(200);
  await shot('guide-over-book');
  await key('a'); // keys go to the guide, not the page
  await key('Escape');
  await until(async () => !(await isOpen()));
  await key('!');
  await tick(200);
  const text = await js(`document.querySelector('.chapter-body p').textContent`);
  assert.equal(text, 'The tide came in over the stones.!', 'the caret was put back, nothing reached the page');
});

app.whenReady().then(async () => {
  let failed = 0;
  try {
    await until(() => BrowserWindow.getAllWindows().length > 0, 15000);
    const win = BrowserWindow.getAllWindows()[0];
    wc = win.webContents;
    await until(() => !wc.isLoading(), 15000);
    await until(() => js(`typeof showGuide === 'function' && typeof library !== 'undefined' && !!library`).catch(() => false), 15000);
    await tick(800);
    win.focus();
    for (const { name, fn } of tests) {
      try {
        await fn();
        console.log('ok - ' + name);
      } catch (err) {
        failed++;
        console.log('not ok - ' + name + '\n  ' + (err && err.stack || err).split('\n').slice(0, 6).join('\n  '));
      }
    }
  } catch (err) {
    failed++;
    console.log('not ok - setup\n  ' + (err && err.stack || err));
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* left for the next run */ }
  app.exit(failed ? 1 : 0);
});
