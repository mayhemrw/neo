'use strict';

// Find's pattern and matching from app.js, run on their own: Match case,
// Whole word (Unicode letters, apostrophes inside a word), and the words
// found as typed, never as a regular expression. The page side (a phrase
// across italics, chapter titles, the toggles) is in find.e2e.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(app.slice(app.indexOf('const FIND_WORD'), app.indexOf('// A root\'s text as Find reads it')), context);
vm.runInContext('this.api = { findPattern, findIn };', context);
const { findPattern } = context.api;
// the context's arrays aren't this realm's, so they're copied before comparing
const findIn = (text, re) => JSON.parse(JSON.stringify(context.api.findIn(text, re)));

const found = (text, q, opts) => findIn(text, findPattern(q, opts)).map(([s, e]) => text.slice(s, e));
const at = (text, q, opts) => findIn(text, findPattern(q, opts)).map(([s]) => s);

test('nothing to find, nothing found', () => {
  assert.equal(findPattern('', {}), null);
  assert.deepEqual(findIn('anything', null), []);
});

test('any case, unless Match case', () => {
  const text = 'Colour, colour and COLOUR.';
  assert.deepEqual(found(text, 'colour'), ['Colour', 'colour', 'COLOUR']);
  assert.deepEqual(found(text, 'colour', { matchCase: true }), ['colour']);
  assert.deepEqual(found(text, 'COLOUR', { matchCase: true }), ['COLOUR']);
  // beyond ASCII too
  assert.deepEqual(found('Éclair, éclair', 'éclair'), ['Éclair', 'éclair']);
  assert.deepEqual(found('Éclair, éclair', 'éclair', { matchCase: true }), ['éclair']);
});

test('Whole word: not inside a longer word', () => {
  const text = 'The cat scattered the cats; a cat.';
  assert.deepEqual(at(text, 'cat'), [4, 9, 22, 30]);
  assert.deepEqual(at(text, 'cat', { wholeWord: true }), [4, 30]);
  // the start and end of the text count as edges
  assert.deepEqual(found('cat', 'cat', { wholeWord: true }), ['cat']);
  // a phrase is whole at its two ends
  assert.deepEqual(found('the old house, the older house', 'the old', { wholeWord: true }), ['the old']);
});

test('Whole word: letters beyond ASCII are letters', () => {
  assert.deepEqual(found('café cafés', 'café', { wholeWord: true }), ['café']);
  assert.deepEqual(found('naïve naïveté', 'naïve', { wholeWord: true }), ['naïve']);
  assert.deepEqual(found('Straße Straßen', 'Straße', { wholeWord: true }), ['Straße']);
  assert.deepEqual(found('кот котик', 'кот', { wholeWord: true }), ['кот']);
  // a combining accent belongs to its letter: "cafe" isn't whole in "café"
  assert.deepEqual(found('café cafe', 'cafe', { wholeWord: true }).length, 1);
  // digits are part of a word
  assert.deepEqual(found('R2 R2D2', 'R2', { wholeWord: true }), ['R2']);
});

test('Whole word: an apostrophe inside a word joins it', () => {
  // "don" isn't a word in "don't", either apostrophe
  assert.deepEqual(found("don't don’t don", 'don', { wholeWord: true }), ['don']);
  assert.deepEqual(found("o'clock clock", 'clock', { wholeWord: true }), ['clock']);
  assert.deepEqual(found('o’clock clock', 'clock', { wholeWord: true }), ['clock']);
  // the whole word with its apostrophe is found
  assert.deepEqual(found("I don't know", "don't", { wholeWord: true }), ["don't"]);
  // a quotation mark at a word's edge isn't part of it
  assert.deepEqual(found("'cat' said she", 'cat', { wholeWord: true }), ['cat']);
  assert.deepEqual(found('the cats’ toys, the cat’s', 'cats', { wholeWord: true }), ['cats']);
});

test('Whole word: hyphens and dashes end a word', () => {
  assert.deepEqual(found('well-known, well', 'well', { wholeWord: true }), ['well', 'well']);
  assert.deepEqual(found('now—then', 'now', { wholeWord: true }), ['now']);
});

test('the words are found as typed, never as a pattern', () => {
  assert.deepEqual(found('a.b axb', 'a.b'), ['a.b']);
  assert.deepEqual(found('(see) see', '(see)'), ['(see)']);
  assert.deepEqual(found('1+1=2 11=2', '1+1'), ['1+1']);
  assert.deepEqual(found('$5 or [5] or {5} or 5^2 or a|b or c\\d or /e/', '$5'), ['$5']);
  for (const q of ['[5]', '{5}', '5^2', 'a|b', 'c\\d', '/e/', '?', '*']) {
    assert.deepEqual(found(`x ${q} y`, q), [q], q);
  }
  // and Whole word still works around punctuation: an edge that isn't a letter needs no gap
  assert.deepEqual(found('see (see) seen', '(see)', { wholeWord: true }), ['(see)']);
});

test('matches never overlap and the pattern can be used again', () => {
  assert.deepEqual(at('aaaa', 'aa'), [0, 2]);
  const re = findPattern('a', {});
  assert.deepEqual(findIn('a a', re), [[0, 1], [2, 3]]);
  assert.deepEqual(findIn('a a', re), [[0, 1], [2, 3]]);
});

// ---- the results list: a hit's line of context, the rows, and which of
// them to draw (app.js, the results list)
const listCtx = vm.createContext({});
vm.runInContext(app.slice(app.indexOf('const FIND_ROW_H'), app.indexOf('// a chapter\'s heading in the list')), listCtx);
vm.runInContext('this.api = { findContext, findRows, findWindow };', listCtx);
const plain = (x) => JSON.parse(JSON.stringify(x));
const findContext = (...a) => plain(listCtx.api.findContext(...a));
const findRows = (...a) => plain(listCtx.api.findRows(...a));
const findWindow = (...a) => plain(listCtx.api.findWindow(...a));
const line = (text, q) => {
  const s = text.indexOf(q);
  const c = findContext(text, s, s + q.length);
  return (c.before ? '…' : '') + text.slice(c.a, c.z) + (c.after ? '…' : '');
};

test('a hit\'s line: about 40 characters each side, cut between words', () => {
  assert.equal(line('A short one with the word.', 'word'), 'A short one with the word.');
  const long = 'In the beginning of the long summer the harbor was quiet and the boats rocked at their moorings while the gulls slept.';
  assert.equal(line(long, 'quiet'), '…of the long summer the harbor was quiet and the boats rocked at their moorings…');
  // never half a word at either cut
  const c = findContext(long, long.indexOf('quiet'), long.indexOf('quiet') + 5);
  assert.ok(/\s/.test(long[c.a - 1]) && /\s/.test(long[c.z]));
  // a word longer than the room is cut where it must be
  const run = 'x'.repeat(60) + ' hit ' + 'y'.repeat(60);
  const r = findContext(run, 61, 64);
  assert.equal(r.a, 21);
  assert.ok(r.before && r.after);
  assert.equal(r.z, 104);
});

test('the rows: hits across formatting first, then each chapter\'s under its heading', () => {
  const m = (chId, crosses = false, title = false) => ({ chId, crosses, title });
  const rows = findRows([m('a', false, true), m('a'), m('a', true), m('b'), m('c', true), m('c')], true);
  assert.deepEqual(rows, [
    { head: 'crosses', n: 2 }, { i: 2, cross: true }, { i: 4, cross: true },
    { head: 'chapter', chId: 'a', n: 2 }, { i: 0 }, { i: 1 },
    { head: 'chapter', chId: 'b', n: 1 }, { i: 3 },
    { head: 'chapter', chId: 'c', n: 1 }, { i: 5 }
  ]);
  // no crossing hits, no such heading
  assert.equal(findRows([m('a'), m('b')], true)[0].head, 'chapter');
  // outside the manuscript one heading holds every hit, in order
  assert.deepEqual(findRows([m(null), m(null, true)], false), [{ head: 'tab', n: 2 }, { i: 0 }, { i: 1 }]);
  assert.deepEqual(findRows([], true), []);
});

test('which rows to draw: those in view and a few each side, however long the list', () => {
  const tops = Array.from({ length: 5000 }, (_, k) => k * 26);
  assert.deepEqual(findWindow(tops, 0, 260), [0, 18]);
  assert.deepEqual(findWindow(tops, 26 * 1000 + 5, 260), [992, 1019]);
  assert.deepEqual(findWindow(tops, 26 * 4995, 260), [4987, 5000]);
  assert.deepEqual(findWindow([], 0, 260), [0, 0]);
  // rows of two heights (headings and hits)
  assert.deepEqual(findWindow([0, 30, 56, 82, 112], 60, 30, 0), [2, 4]);
});
