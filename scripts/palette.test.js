'use strict';

// The command palette's parts that don't need a window: how a command is
// matched and ordered (app.js, COMMAND PALETTE) and how the menu is walked
// into commands with their shortcuts (main.js). The palette itself, on the
// real menu, is in palette.e2e.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const slice = (file, from, to) => {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${file}: ${from} … ${to}`);
  return src.slice(a, b);
};
const plain = (x) => JSON.parse(JSON.stringify(x));

const win = vm.createContext({});
vm.runInContext(slice('app.js', '// a string\'s words without accents', 'const PALETTE_RECENT ='), win);
vm.runInContext('this.api = { paletteScore, paletteFilter, paletteId, paletteWords, paletteGroups };', win);
const { paletteScore, paletteId } = win.api;
const filter = (...a) => plain(win.api.paletteFilter(...a)).map((x) => x.label);

const main = vm.createContext({ Menu: { getApplicationMenu: () => null }, process: { platform: 'linux' } });
vm.runInContext(slice('main.js', 'const ACCEL_MAC', '// One command chosen'), main);
vm.runInContext('this.api = { accelText, paletteItems };', main);
const { accelText } = main.api;
const paletteItems = (...a) => plain(main.api.paletteItems(...a));

const C = (label, path = [], extra = {}) => ({ label, path, enabled: true, ...extra });
const ITEMS = [
  C('Export for Verification…', ['File', 'Scribe\'s Log']),
  C('Name This Version…', ['File']),
  C('Undo', ['Edit']),
  C('Find & Replace', ['Edit']),
  C('Chapter History…', ['View'], { enabled: false }),
  C('Chapter History Notes', ['Help']),
  C('Paragraph', ['View', 'Focus Mode']),
  C('Café Lights', ['Format'])
];

test('words: typed words start words of the name first, then of its place, then anywhere', () => {
  assert.deepEqual(filter(ITEMS, 'ch hi'), ['Chapter History Notes', 'Chapter History…'], 'the greyed one after');
  assert.deepEqual(filter(ITEMS, 'hist'), ['Chapter History Notes', 'Chapter History…']);
  // a word of the place: "focus par" is Paragraph under Focus Mode
  assert.deepEqual(filter(ITEMS, 'focus par'), ['Paragraph']);
  // the name's own words before its place's
  assert.deepEqual(filter(ITEMS, 'log'), ['Export for Verification…']);
  assert.ok(paletteScore(ITEMS[0], 'export') < paletteScore(ITEMS[0], 'log'));
  // inside a word, last
  assert.deepEqual(filter(ITEMS, 'ersion'), ['Name This Version…']);
  // nothing found, nothing listed
  assert.deepEqual(filter(ITEMS, 'zebra'), []);
  assert.equal(paletteScore(ITEMS[2], 'undo zebra'), null);
});

test('words in order before out of order; a name matched further in after', () => {
  assert.ok(paletteScore(C('Name This Version…'), 'name version') < paletteScore(C('Name This Version…'), 'version name'));
  assert.ok(paletteScore(C('Version Notes'), 'version') < paletteScore(C('Name This Version…'), 'version'));
});

test('accents and case don\'t matter', () => {
  assert.deepEqual(filter(ITEMS, 'CAFE'), ['Café Lights']);
  assert.deepEqual(filter(ITEMS, 'café l'), ['Café Lights']);
});

test('nothing typed: the last used first, then the menu in order', () => {
  const recent = [paletteId(ITEMS[3]), 'Gone › Not In The Menu', paletteId(ITEMS[1])];
  assert.deepEqual(filter(ITEMS, '', recent).slice(0, 4), ['Find & Replace', 'Name This Version…', 'Export for Verification…', 'Undo']);
  assert.equal(filter(ITEMS, '  ', recent).length, ITEMS.length);
  assert.equal(paletteId(ITEMS[0]), 'File › Scribe\'s Log › Export for Verification…');
});

test('shortcuts as each platform shows them', () => {
  assert.equal(accelText('CmdOrCtrl+Shift+H', 'darwin'), '⇧⌘H');
  assert.equal(accelText('CmdOrCtrl+Shift+H', 'win32'), 'Ctrl+Shift+H');
  assert.equal(accelText('CmdOrCtrl+Alt+Right', 'darwin'), '⌥⌘→');
  assert.equal(accelText('CmdOrCtrl+Alt+Right', 'linux'), 'Ctrl+Alt+→');
  assert.equal(accelText('CmdOrCtrl-Plus', 'win32'), 'Ctrl++');
  assert.equal(accelText('CmdOrCtrl-Minus', 'darwin'), '⌘−');
  assert.equal(accelText('CmdOrCtrl+,', 'linux'), 'Ctrl+,');
  assert.equal(accelText('CmdOrCtrl+/', 'darwin'), '⌘/');
  assert.equal(accelText('Shift+CmdOrCtrl+Z', 'darwin'), '⇧⌘Z');
  assert.equal(accelText('', 'linux'), '');
  assert.equal(accelText(undefined, 'linux'), '');
});

test('the menu walked: commands with their place, what the menu hides or greys', () => {
  const item = (o) => ({ type: 'normal', visible: true, enabled: true, ...o });
  const sub = (label, items, o = {}) => item({ label, submenu: { items }, ...o });
  const menu = {
    items: [
      sub('File', [
        item({ label: 'Email Draft to Myself', accelerator: 'CmdOrCtrl+E' }),
        item({ type: 'separator' }),
        sub('Scribe\'s Log', [
          item({ label: 'Log This Book', type: 'checkbox', checked: true }),
          item({ id: 'info-slog-stamp', label: 'Last timestamp: today', enabled: false }),
          item({ label: 'Verification Report…' })
        ]),
        sub('Greyed', [item({ label: 'Hidden inside' })], { enabled: false }),
        item({ label: 'Not for scripts', visible: false })
      ]),
      sub('Edit', [
        item({ label: 'Undo', role: 'undo', getDefaultRoleAccelerator: () => 'CommandOrControl+Z' }),
        item({ label: 'Find && Replace', accelerator: 'CmdOrCtrl+F' }),
        item({ label: 'Flush Paragraph\tShift+Enter', type: 'checkbox', checked: false })
      ]),
      sub('View', [
        item({ id: 'palette', label: 'Command Palette…', accelerator: 'CmdOrCtrl+K' }),
        item({ label: 'Chapter History…', accelerator: 'CmdOrCtrl+Shift+H', enabled: false })
      ])
    ]
  };
  assert.deepEqual(paletteItems(menu, 'win32'), [
    { key: '0.0', label: 'Email Draft to Myself', path: ['File'], shortcut: 'Ctrl+E', enabled: true, checked: null },
    { key: '0.2.0', label: 'Log This Book', path: ['File', 'Scribe\'s Log'], shortcut: '', enabled: true, checked: true },
    { key: '0.2.2', label: 'Verification Report…', path: ['File', 'Scribe\'s Log'], shortcut: '', enabled: true, checked: null },
    { key: '1.0', label: 'Undo', path: ['Edit'], shortcut: 'Ctrl+Z', enabled: true, checked: null },
    { key: '1.1', label: 'Find & Replace', path: ['Edit'], shortcut: 'Ctrl+F', enabled: true, checked: null },
    { key: '1.2', label: 'Flush Paragraph', path: ['Edit'], shortcut: 'Shift+Enter', enabled: true, checked: false },
    { key: '2.1', label: 'Chapter History…', path: ['View'], shortcut: 'Ctrl+Shift+H', enabled: false, checked: null }
  ]);
  assert.deepEqual(paletteItems(null), []);
});

test('a command chosen after the menu was rebuilt: found again by its name and place, never by name alone', () => {
  const clicked = [];
  const item = (label, o = {}) => ({ type: 'normal', visible: true, enabled: true, label, click: () => clicked.push(label + (o.tag || '')), ...o });
  const menus = {
    items: [
      { label: 'File', type: 'normal', visible: true, enabled: true, submenu: { items: [item('Name This Version…'), item('Undo', { tag: ' (a chapter so titled)' })] } },
      { label: 'Edit', type: 'normal', visible: true, enabled: true, submenu: { items: [item('Undo', { tag: ' (Edit)' }), item('Greyed', { enabled: false })] } }
    ]
  };
  const ctx = vm.createContext({ Menu: { getApplicationMenu: () => menus }, process: { platform: 'linux' }, logError: () => {} });
  vm.runInContext(slice('main.js', 'const ACCEL_MAC', "ipcMain.handle('palette:items'"), ctx);
  const run = (...a) => vm.runInContext('paletteRun', ctx)(null, ...a);
  // where it was, named the same: clicked
  assert.equal(run('1.0', 'Undo', ['Edit']), true);
  assert.deepEqual(clicked.splice(0), ['Undo (Edit)']);
  // the menu moved: found by name and place, not the first "Undo" anywhere
  assert.equal(run('0.0', 'Undo', ['Edit']), true);
  assert.deepEqual(clicked.splice(0), ['Undo (Edit)']);
  // a name in no place it's known by, or no place given: nothing runs
  assert.equal(run('0.0', 'Undo', ['View']), false);
  assert.equal(run('0.0', 'Undo'), false);
  assert.deepEqual(clicked, []);
  // greyed: never clicked
  assert.equal(run('1.1', 'Greyed', ['Edit']), false);
  assert.deepEqual(clicked, []);
});

test('hidden commands: out of the list as it opens, recent ones too, but still found by typing', () => {
  const hidden = [paletteId(ITEMS[2]), paletteId(ITEMS[6])]; // Undo, Paragraph
  const recent = [paletteId(ITEMS[2]), paletteId(ITEMS[3])];
  const empty = filter(ITEMS, '', recent, hidden);
  assert.deepEqual(empty.slice(0, 2), ['Find & Replace', 'Export for Verification…']);
  assert.ok(!empty.includes('Undo') && !empty.includes('Paragraph'));
  assert.equal(empty.length, ITEMS.length - 2);
  assert.deepEqual(filter(ITEMS, 'undo', recent, hidden), ['Undo']);
  assert.deepEqual(filter(ITEMS, 'focus par', recent, hidden), ['Paragraph']);
});

test('groups for choosing what\'s listed: by place, in the menu\'s order', () => {
  const g = plain(win.api.paletteGroups(ITEMS)).map((x) => [x.key, x.items.map((i) => i.label)]);
  assert.deepEqual(g, [
    ['File › Scribe\'s Log', ['Export for Verification…']],
    ['File', ['Name This Version…']],
    ['Edit', ['Undo', 'Find & Replace']],
    ['View', ['Chapter History…']],
    ['Help', ['Chapter History Notes']],
    ['View › Focus Mode', ['Paragraph']],
    ['Format', ['Café Lights']]
  ]);
});
