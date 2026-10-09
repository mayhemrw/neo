// End-to-end test for the Word round-trip (phase 6), on a throwaway
// library. M2, sending: File → Export → Word for an Editor… is in the
// palette; its dialog asks for the editor's name (and won't go on without
// one); Cancel writes nothing; the .docx has the round's id, a bookmark at
// each chapter, an id on every paragraph and Track Changes on; a version
// "Sent to Dana (…)" is named and review.json keeps the round; the file,
// edited the way a reviewer would, reads back with review-docx.js and
// finds its chapters; NEO's own import still reads it; a second round to
// another editor remembers both names.
// Run with `npm run test:review` (under xvfb-run without a display).
// NEO_TEST_SHOTS=<folder> saves pictures, and the sample file for review.

'use strict';

process.env.NEO_SLOG_STAMPS = process.env.NEO_SLOG_STAMPS || 'off';

const { app, BrowserWindow, dialog } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

for (const name of fs.readdirSync(os.tmpdir())) {
  const pid = /^neo-review-test-(\d+)-/.exec(name);
  if (!pid || +pid[1] === process.pid) continue;
  try { process.kill(+pid[1], 0); continue; } catch (err) { if (err.code === 'EPERM') continue; }
  fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `neo-review-test-${process.pid}-`));
app.setPath('userData', path.join(tmp, 'app'));
app.setPath('documents', tmp);
const LIB = path.join(tmp, 'NEO Library');
fs.mkdirSync(LIB);
fs.writeFileSync(path.join(LIB, 'library.json'), JSON.stringify({
  authorName: 'Charles Dickens', penNames: [], firstRunDone: true, pageTheme: 'night', hintShown: true,
  shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: [] }]
}));
const loadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function (file, opts) {
  return loadFile.call(this, path.resolve(__dirname, '..', file), opts);
};
require('../main.js');
const JSZip = require('jszip');
const RD = require('../review-docx.js');
const RM = require('../review-match.js');
const Z = require('../slog-zip.js');

let wc;
const js = (code) => wc.executeJavaScript(code, true);
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(cond, ms = 20000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting: ' + cond);
    await tick(80);
  }
}
const D = `document.getElementById('review-send-dialog')`;
async function shot(name) {
  if (!process.env.NEO_TEST_SHOTS) return;
  const img = await wc.capturePage();
  fs.writeFileSync(path.join(process.env.NEO_TEST_SHOTS, name + '.png'), img.toPNG());
}
const readDocx = (file) => RD.readDocx(new Uint8Array(fs.readFileSync(file)), Z, (b) => zlib.inflateRawSync(b));
const reviewJson = async () => {
  const dir = await bookDirOf();
  return JSON.parse(fs.readFileSync(path.join(dir, 'review.json'), 'utf8'));
};
async function bookDirOf() {
  const id = await js('book.id');
  const dirs = fs.readdirSync(LIB).filter((d) => d.startsWith('book-') && d.endsWith(id));
  if (dirs.length !== 1) throw new Error('the book folder: ' + dirs.join(', '));
  return path.join(LIB, dirs[0]);
}

// public-domain text (A Tale of Two Cities, 1859), never a writer's own
const CH1 = [
  'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness, it was the epoch of belief, it was the epoch of incredulity, it was the season of Light, it was the season of Darkness, it was the spring of hope, it was the winter of despair.',
  'There were a king with a large jaw and a queen with a plain face, on the throne of England; there were a king with a large jaw and a queen with a fair face, on the throne of France.',
  'It was the year of Our Lord one thousand seven hundred and seventy-five. Spiritual revelations were conceded to England at that favoured period, as at this.'
];
const CH2 = [
  'It was the Dover road that lay, on a Friday night late in November, before the first of the persons with whom this history has business.',
  'The Dover road lay, as to him, beyond the Dover mail, as it lumbered up Shooter’s Hill.',
  'He walked uphill in the mire by the side of the mail, as the rest of the passengers did; not because they had the least relish for walking exercise, under the circumstances, but because the hill, and the harness, and the mud, and the mail, were all so heavy.'
];

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
let sent = null;

test('File → Export → Word for an Editor… is in the palette', async () => {
  const items = await js(`window.neo.palette.items()`);
  const it = items.find((x) => x.label === 'Word for an Editor…');
  assert.ok(it, 'listed');
  assert.deepEqual(it.path, ['File', 'Export']);
  assert.equal(it.enabled, true);
});

test('the dialog asks who it is for; Cancel writes nothing', async () => {
  await js(`(() => { window.__rv = doExport('review'); })()`);
  await until(() => js(`!!${D}`));
  assert.equal(await js(`${D}.querySelector('.rv-name').value`), '');
  assert.equal(await js(`document.activeElement === ${D}.querySelector('.rv-name')`), true);
  // no name, no file: it says why and stays
  await js(`${D}.querySelector('.rv-go').click()`);
  assert.equal(await js(`!${D}.querySelector('.rv-why').hidden`), true);
  assert.equal(await js(`!!${D}`), true);
  await shot('review-send-empty');
  // the menu again, under the open dialog: no second one
  await js(`(() => { doExport('review'); })()`);
  await tick(200);
  assert.equal(await js(`document.querySelectorAll('#review-send-dialog').length`), 1);
  await js(`${D}.querySelector('.m-cancel').click()`);
  await js(`window.__rv`);
  assert.equal(await js(`!!${D}`), false);
  assert.equal(fs.existsSync(path.join(await bookDirOf(), 'review.json')), false);
});

test('a cancelled save names no version and keeps no round', async () => {
  dialog.showSaveDialog = async () => ({ canceled: true });
  await js(`(() => { window.__rv = doExport('review'); })()`);
  await until(() => js(`!!${D}`));
  await js(`${D}.querySelector('.rv-name').value = 'Dana'; ${D}.querySelector('.rv-go').click()`);
  await js(`window.__rv`);
  assert.equal(fs.existsSync(path.join(await bookDirOf(), 'review.json')), false);
  const versions = path.join(await bookDirOf(), 'versions');
  assert.equal(fs.existsSync(versions) ? fs.readdirSync(versions).filter((f) => f.endsWith('.json')).length : 0, 0);
});

test('Save: the .docx carries the round, chapter bookmarks, paragraph ids and Track Changes', async () => {
  const to = path.join(tmp, 'two-cities-dana.docx');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: to });
  await js(`(() => { window.__rv = doExport('review'); })()`);
  await until(() => js(`!!${D}`));
  await js(`${D}.querySelector('.rv-name').value = 'Dana Editor'`);
  await tick(200);
  await shot('review-send-dialog');
  await js(`${D}.querySelector('.rv-go').click()`);
  await js(`window.__rv`);
  assert.ok(fs.existsSync(to), 'saved');
  assert.match(await js(`$('#hint').textContent`), /^Saved two-cities-dana\.docx for Dana Editor\. The book as it was sent is the version “Sent to Dana Editor \(\w+ \d+\)” in Chapter History\.$/);

  const review = await reviewJson();
  assert.deepEqual(review.editors, ['Dana Editor']);
  assert.equal(review.rounds.length, 1);
  const round = review.rounds[0];
  assert.match(round.id, /^r\d{8}-[0-9a-f]{6}$/);
  assert.equal(round.to, 'Dana Editor');
  assert.equal(round.file, 'two-cities-dana.docx');
  assert.match(round.version.name, /^Sent to Dana Editor \(/);
  assert.ok(round.version.n > 0 && /^[0-9a-f]{64}$/.test(round.version.h), 'the log’s place');
  const order = await js(`book.chapterOrder`);
  assert.deepEqual(round.chapters.map((c) => c.id), order);
  assert.deepEqual(round.chapters.map((c) => [c.num, c.kind, c.title]), [[1, 'chapter', await js(`chapterHeading(book.chapterOrder[0])`)], [2, 'chapter', await js(`chapterHeading(book.chapterOrder[1])`)]]);

  // the version, as Chapter History lists it
  const named = await js(`window.neo.history.named(book.id)`);
  assert.equal(named.length, 1);
  assert.equal(named[0].auto, 'word');
  assert.equal(named[0].name, round.version.name);

  const zip = await JSZip.loadAsync(fs.readFileSync(to));
  assert.match(await zip.file('word/settings.xml').async('string'), /<w:trackRevisions\/>/);
  assert.match(await zip.file('docProps/custom.xml').async('string'), new RegExp('name="NEO.ReviewRound"><vt:lpwstr>' + round.id + '<'));
  assert.match(await zip.file('[Content_Types].xml').async('string'), /PartName="\/docProps\/custom.xml"/);
  assert.match(await zip.file('_rels/.rels').async('string'), /Target="docProps\/custom.xml"/);

  const m = await readDocx(to);
  assert.equal(m.round, round.id);
  const ids = m.paragraphs.map((p) => p.paraId);
  assert.ok(ids.every((x) => /^[0-7][0-9A-F]{7}$/.test(x)), 'every paragraph has an id');
  assert.equal(new Set(ids).size, ids.length, 'all different');
  // each chapter's bookmark is on its heading
  for (const c of round.chapters) {
    const p = m.paragraphs.find((x) => x.bookmarks.some((b) => b.name === RD.chapterMark(c.num)));
    assert.ok(p, 'bookmark for ' + c.num);
    assert.equal(p.heading, true);
    assert.equal(p.after, c.title);
  }
  // the words as sent: no change marks in a fresh file
  assert.equal(m.changes.length, 0);
  const text = m.paragraphs.map((p) => p.after);
  for (const line of [...CH1, ...CH2]) assert.ok(text.includes(line), line.slice(0, 30));
  sent = { to, round, model: m };
  if (process.env.NEO_TEST_SHOTS) fs.copyFileSync(to, path.join(process.env.NEO_TEST_SHOTS, 'sample-for-review.docx'));
});

test('edited as a reviewer would, it reads back and finds its chapters', async () => {
  const zip = await JSZip.loadAsync(fs.readFileSync(sent.to));
  let doc = await zip.file('word/document.xml').async('string');
  const who = (id) => `w:id="${id}" w:author="Dana Editor" w:date="2026-10-09T10:00:00Z"`;
  // in chapter 2's second paragraph: "lumbered" → "laboured", and a comment
  const old = '<w:t xml:space="preserve">' + CH2[1] + '</w:t>';
  assert.ok(doc.includes(old), 'the paragraph as NEO wrote it');
  const [a, b] = CH2[1].split('lumbered');
  doc = doc.replace(old, `<w:t xml:space="preserve">${a}</w:t></w:r><w:del ${who(901)}><w:r><w:delText>lumbered</w:delText></w:r></w:del><w:ins ${who(902)}><w:r><w:t>laboured</w:t></w:r></w:ins>` +
    `<w:commentRangeStart w:id="0"/><w:r><w:t xml:space="preserve">${b}</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r><w:r><w:t></w:t>`);
  zip.file('word/document.xml', doc);
  zip.file('word/comments.xml', `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:comment w:id="0" w:author="Dana Editor" w:date="2026-10-09T10:01:00Z"><w:p w14:paraId="7AAA0001"><w:r><w:t>Which hill?</w:t></w:r></w:p></w:comment></w:comments>`);
  const back = path.join(tmp, 'two-cities-dana-edited.docx');
  fs.writeFileSync(back, await zip.generateAsync({ type: 'nodebuffer' }));
  sent.edited = back;
  sent.b = b;

  const m = await readDocx(back);
  assert.equal(m.round, sent.round.id, 'the round id came back');
  const i = m.paragraphs.findIndex((p) => p.before === CH2[1]);
  assert.ok(i >= 0, 'the paragraph before the change is the one sent');
  assert.equal(m.paragraphs[i].after, CH2[1].replace('lumbered', 'laboured'));
  assert.equal(m.paragraphs[i].paraId, sent.model.paragraphs[i].paraId, 'its id kept');
  // which chapter: the last chapter bookmark at or before it
  let num = null;
  for (let k = 0; k <= i; k++) for (const bm of m.paragraphs[k].bookmarks) { const n = /^_NEO_ch_(\d+)$/.exec(bm.name); if (n) num = +n[1]; }
  const ch = sent.round.chapters.find((c) => c.num === num);
  assert.equal(ch.id, (await js(`book.chapterOrder`))[1], 'chapter 2');
  assert.deepEqual(RD.summary(m).authors['Dana Editor'], { changes: 2, comments: 1, formatting: 0 });
  const c = m.comments[0];
  assert.equal(m.paragraphs[c.start.p].after.slice(c.start.a, c.end.a), b);
});

test("NEO's own import still reads the file", async () => {
  const back = await js(`window.neo.importFiles([${JSON.stringify(sent.to)}])`);
  const text = JSON.stringify(back);
  assert.ok(text.includes('It was the best of times'), text.slice(0, 200));
  assert.ok(text.includes('as it lumbered up Shooter'));
});

test('a second round: the last name first, the names to pick from, another round id', async () => {
  const to = path.join(tmp, 'two-cities-sam.docx');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: to });
  await js(`(() => { window.__rv = doExport('review'); })()`);
  await until(() => js(`!!${D}`));
  assert.equal(await js(`${D}.querySelector('.rv-name').value`), 'Dana Editor');
  assert.deepEqual(await js(`[...${D}.querySelectorAll('.rv-chip')].map((b) => b.textContent)`), ['Dana Editor']);
  await js(`${D}.querySelector('.rv-name').value = 'Sam Proofreader'`);
  await tick(200);
  await shot('review-send-second');
  await js(`(() => { const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }); ${D}.querySelector('.rv-name').dispatchEvent(e); })()`);
  await js(`window.__rv`);
  assert.ok(fs.existsSync(to));
  const review = await reviewJson();
  assert.deepEqual(review.editors, ['Sam Proofreader', 'Dana Editor']);
  assert.equal(review.rounds.length, 2);
  assert.notEqual(review.rounds[0].id, review.rounds[1].id);
  assert.equal((await readDocx(to)).round, review.rounds[1].id);
  assert.equal((await js(`window.neo.history.named(book.id)`)).filter((v) => v.auto === 'word').length, 2);
  let errors = '';
  try { errors = fs.readFileSync(path.join(LIB, 'neo-errors.log'), 'utf8'); } catch { /* none */ }
  assert.equal(errors, '');
});

const S = `document.getElementById('review-summary')`;
const summaryLines = () => js(`[...${S}.querySelectorAll('.rv-lines li')].map((li) => li.textContent)`);
const summaryNotes = () => js(`[...${S}.querySelectorAll('.rv-notes li')].map((li) => li.textContent)`);

test('Import Review: the editor’s change and comment are kept; nothing in the book changes', async () => {
  const order = await js(`book.chapterOrder`);
  const before = await js(`JSON.stringify(chapterHTML)`);
  await js(`(() => { window.__ri = importReview(${JSON.stringify(sent.edited)}); })()`);
  await until(() => js(`!!${S}`));
  assert.equal(await js(`${S}.querySelector('.rv-file').textContent`), 'two-cities-dana-edited.docx');
  assert.deepEqual(await summaryLines(), ['Dana Editor: 1 change, 1 comment']);
  assert.deepEqual(await summaryNotes(), []);
  await tick(150);
  await shot('review-import-summary');
  await js(`${S}.querySelector('.m-ok').click()`);
  await js(`window.__ri`);
  assert.equal(await js(`JSON.stringify(chapterHTML)`), before, 'the book as it was');

  const review = await reviewJson();
  assert.equal(review.imports.length, 1);
  const imp = review.imports[0];
  assert.equal(imp.round, sent.round.id);
  assert.equal(imp.how, 'bookmarks');
  assert.equal(imp.file, 'two-cities-dana-edited.docx');
  assert.equal(imp.copy, sent.round.id + '-Dana-Editor.docx');
  assert.ok(fs.existsSync(path.join(await bookDirOf(), 'reviews', imp.copy)), 'the copy kept');
  assert.deepEqual(review.rounds[0].imports, [imp.id]);
  assert.deepEqual(review.reviewers.map((r) => r.name), ['Dana Editor']);
  assert.match(review.reviewers[0].color, /^#[0-9a-f]{6}$/);
  assert.equal(review.suggestions.length, 1);
  const s = review.suggestions[0];
  assert.deepEqual([s.kind, s.del, s.ins, s.reviewer, s.chapter, s.round, s.import, s.status, !!s.untracked], ['replace', 'lumbered', 'laboured', 'Dana Editor', order[1], sent.round.id, imp.id, 'open', false]);
  assert.equal(s.anchor.exact, 'lumbered');
  assert.ok(s.anchor.pre.endsWith('as it '));
  assert.equal(review.threads.length, 1);
  const th = review.threads[0];
  assert.equal(th.chapter, order[1]);
  assert.equal(th.anchor.exact, sent.b);
  assert.deepEqual(th.comments.map((c) => [c.by, c.text]), [['Dana Editor', 'Which hill?']]);
  // the anchor is found in the chapter as it is today
  const today = await js(`ReviewMatch.htmlText(chapterHTML[${JSON.stringify(order[1])}])`);
  const f = RM.findAnchor(today, s.anchor);
  assert.equal(today.slice(f.o, f.o + f.len), 'lumbered');
  assert.equal(f.sure, true);
});

test('changes made without Track Changes are found against the version sent', async () => {
  const sam = path.join(tmp, 'two-cities-sam.docx');
  const zip = await JSZip.loadAsync(fs.readFileSync(sam));
  let doc = await zip.file('word/document.xml').async('string');
  // typed straight in, untracked: one word changed, one paragraph added
  assert.ok(doc.includes('a large jaw and a queen with a plain face'));
  doc = doc.replace('a queen with a plain face', 'a queen with a homely face');
  const last = CH2[2];
  const i = doc.indexOf(last);
  const pEnd = doc.indexOf('</w:p>', i) + 6;
  doc = doc.slice(0, pEnd) + '<w:p><w:r><w:t>Nobody tracked this line.</w:t></w:r></w:p>' + doc.slice(pEnd);
  zip.file('word/document.xml', doc);
  const back = path.join(tmp, 'two-cities-sam-back.docx');
  fs.writeFileSync(back, await zip.generateAsync({ type: 'nodebuffer' }));
  await js(`(() => { window.__ri = importReview(${JSON.stringify(back)}); })()`);
  await until(() => js(`!!${S}`));
  assert.deepEqual(await summaryLines(), ['Sam Proofreader: 2 made without Track Changes']);
  await js(`${S}.querySelector('.m-ok').click()`);
  await js(`window.__ri`);
  const review = await reviewJson();
  const mine = review.suggestions.filter((x) => x.round === review.rounds[1].id);
  assert.deepEqual(mine.map((x) => [x.kind, x.del, x.ins, x.untracked, x.reviewer]), [
    ['replace', 'plain', 'homely', true, 'Sam Proofreader'],
    ['insert', '', '\u2029Nobody tracked this line.', true, 'Sam Proofreader']
  ]);
  assert.deepEqual(review.reviewers.map((r) => r.name), ['Dana Editor', 'Sam Proofreader']);
  assert.notEqual(review.reviewers[0].color, review.reviewers[1].color);
});

test('a file not from NEO: it asks which version, the closest first', async () => {
  const lo = path.join(__dirname, 'fixtures', 'review', 'lo-tracked.docx');
  await js(`(() => { window.__ri = importReview(${JSON.stringify(lo)}); })()`);
  await js(`window.LAST = () => [...document.querySelectorAll('.modal-backdrop:not([hidden])')].pop(); 0`);
  await until(() => js(`!!LAST() && !!LAST().querySelector('.fr-choice')`));
  const labels = await js(`[...LAST().querySelectorAll('.fr-choice strong')].map((b) => b.textContent)`);
  assert.equal(labels.length, 3, labels.join(' | '));
  assert.ok(labels.includes('The book as it is now'));
  assert.ok(labels.some((l) => /^Sent to Sam Proofreader \(/.test(l)));
  assert.equal(await js(`LAST().querySelector('.fr-choice span').textContent`), 'Closest to the file');
  await tick(150);
  await shot('review-import-which');
  await js(`LAST().querySelector('.fr-choice').click()`);
  await until(() => js(`!!${S}`));
  const lines = await summaryLines();
  assert.ok(lines.includes('Sam Proofreader: 1 change'), lines.join(' | '));
  assert.ok(lines.some((l) => l.startsWith('Dana Editor: 2 changes, 1 comment')), lines.join(' | '));
  await js(`${S}.querySelector('.m-ok').click()`);
  await js(`window.__ri`);
  const review = await reviewJson();
  assert.equal(review.imports.length, 3);
  assert.equal(review.imports[2].how, 'headings');
  assert.ok(fs.readdirSync(path.join(await bookDirOf(), 'reviews')).length === 3);
  let errors = '';
  try { errors = fs.readFileSync(path.join(LIB, 'neo-errors.log'), 'utf8'); } catch { /* none */ }
  assert.equal(errors, '');
});

test('Import Review… is in the palette, and does nothing on the shelf', async () => {
  const items = await js(`window.neo.palette.items()`);
  const it = items.find((x) => x.label === 'Import Review…');
  assert.ok(it, 'listed');
  assert.deepEqual(it.path, ['File']);
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
    const md = path.join(tmp, 'two-cities.md');
    fs.writeFileSync(md, ['# Chapter 1', ...CH1, '# Chapter 2', ...CH2].join('\n\n'));
    await js(`(async () => {
      document.getElementById('firstrun').hidden = true;
      const results = await window.neo.importFiles([${JSON.stringify(md)}]);
      await addImportedBooks(results, library.shelves[0]);
      const ids = library.shelves[0].bookIds;
      await openBook(ids[ids.length - 1]);
      book.title = 'A Tale of Two Cities';
      book.author = 'Charles Dickens';
      await saveMeta();
    })()`);
    await tick(1200);
    win.focus();
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
