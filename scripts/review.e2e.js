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
// M4: the Review tab (each change inline, in its reviewer's color), Accept
// (A) and Reject, ⌘Z, out-of-date passages, Accept All with its version,
// the log (the editor's words as theirs, numbered, never named) and the
// Verification Report.
// M5: comments in the margin beside their words, a reply (⌘Enter), Resolve,
// Resolve and Delete (Deleted comments, ⌘Z, Put back), the threads sent back
// in the next file as Word comments with replies and done, and read back
// from it as the same threads.
// M6: two editors sent the book side by side (one passage, two wordings,
// picked or the writer's own), the reviewer filter, a file passed from one
// editor to the next (each one's changes under their name, accepted in
// any order), a reviewer's color, and the log.
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
const ReviewMatchPARA = '\u2029';

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

// ---- M4: the Review tab, accepting and rejecting, the log ----
const R = `document.getElementById('review-view')`;
const tabN = () => js(`document.querySelector('.tab[data-tab="review"] .rv-tab-n').textContent`);
const items = () => js(`[...${R}.querySelectorAll('.rv-item')].map((el) => el.dataset.sid)`);
const sug = async (pred) => (await reviewJson()).suggestions.filter(pred);
const keyDown = (key, more = '') => js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true${more} })); 0`);
const ch = async (i) => (await js(`book.chapterOrder`))[i];

test('the Review tab opens after an import and shows what waits; the writing page shows none of it', async () => {
  assert.equal(await js(`currentTab`), 'review');
  assert.equal(await js(`document.querySelector('.tab[data-tab="review"]').hidden`), false);
  // the file from somewhere else: its changes go (one undoable step)
  const review = await reviewJson();
  const lo = review.imports[2].id;
  await js(`reviewDecide(rvs.data.suggestions.filter((s) => s.import === ${JSON.stringify(lo)}), 'reject')`);
  const open = (await reviewJson()).suggestions.filter((s) => s.status === 'open');
  const threads = (await reviewJson()).threads.filter((th) => !th.resolved);
  assert.equal(+(await tabN()), open.length + threads.length);
  assert.deepEqual((await items()).sort(), open.map((s) => s.id).sort());
  // the change inline, in Dana's color
  const s = open.find((x) => x.del === 'lumbered');
  const mark = await js(`(() => { const m = ${R}.querySelector('.rv-page [data-sid="${s.id}"]'); return m && [m.querySelector('del').textContent, m.querySelector('ins').textContent, m.style.getPropertyValue('--rv')]; })()`);
  assert.deepEqual(mark, ['lumbered', 'laboured', review.reviewers[0].color]);
  assert.equal(await js(`document.querySelectorAll('#chapters .rv-s, #chapters del, #chapters ins').length`), 0, 'nothing on the writing page');
  await js(`reviewSelect(${JSON.stringify(s.id)}); $('#paper-scroll').scrollTop = 0`);
  await tick(200);
  await shot('review-tab');
});

test('Accept (A) puts the editor’s words in; ⌘Z takes them out and the change waits again', async () => {
  const [s] = await sug((x) => x.del === 'lumbered');
  const c2 = await ch(1);
  const before = await js(`chapterHTML[${JSON.stringify(c2)}]`);
  await js(`reviewSelect(${JSON.stringify(s.id)}); reviewFocus()`);
  await keyDown('a');
  await until(async () => (await sug((x) => x.id === s.id))[0].status === 'accepted');
  const after = await js(`chapterHTML[${JSON.stringify(c2)}]`);
  assert.ok(after.includes('as it laboured up Shooter'), after);
  assert.ok(!after.includes('lumbered'));
  assert.equal(after, before.replace('lumbered', 'laboured'), 'only that word changed');
  assert.ok(!(await items()).includes(s.id));
  // ⌘Z, from the Review tab
  await js(`document.activeElement && document.activeElement.blur && document.activeElement.blur(); 0`);
  await keyDown('z', ', ctrlKey: true');
  await until(async () => (await sug((x) => x.id === s.id))[0].status === 'open');
  await until(() => js(`chapterHTML[${JSON.stringify(c2)}] === ${JSON.stringify(before)}`));
  assert.ok((await items()).includes(s.id));
  // and the button does it too
  await js(`${R}.querySelector('.rv-item[data-sid="${s.id}"] [data-act="accept"]').click()`);
  await until(async () => (await sug((x) => x.id === s.id))[0].status === 'accepted');
  assert.ok((await js(`chapterHTML[${JSON.stringify(c2)}]`)).includes('laboured'));
});

test('Reject leaves the book as it is', async () => {
  const [s] = await sug((x) => x.ins === '\u2029Nobody tracked this line.' && x.status === 'open');
  const before = await js(`JSON.stringify(chapterHTML)`);
  await js(`${R}.querySelector('.rv-item[data-sid="${s.id}"] [data-act="reject"]').click()`);
  await until(async () => (await sug((x) => x.id === s.id))[0].status === 'rejected');
  assert.equal(await js(`JSON.stringify(chapterHTML)`), before);
});

test('a passage rewritten since is out of date: the editor’s wording beside today’s, no Accept', async () => {
  const [s] = await sug((x) => x.del === 'plain' && x.status === 'open');
  const c1 = await ch(0);
  // the writer changes the passage on the page first
  await js(`(() => {
    const body = document.querySelector('.chapter[data-id="${c1}"] .chapter-body');
    const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) if (n.data.includes('a queen with a plain face')) n.data = n.data.replace('a large jaw and a queen with a plain face', 'a narrow jaw and a queen with a sour face');
    slogWith({ src: 'typed' }, () => syncChapter(body, ${JSON.stringify(c1)}));
    reviewRender();
  })()`);
  const it = `${R}.querySelector('.rv-item[data-sid="${s.id}"]')`;
  assert.equal(await js(`${it}.querySelector('.rv-stale').textContent`), 'out of date');
  assert.equal(await js(`${it}.querySelector('[data-act="accept"]').disabled`), true);
  assert.match(await js(`${it}.querySelector('.rv-staleboth').textContent`), /homely.*Today.*sour face/);
  await js(`reviewSelect(${JSON.stringify(s.id)}); $('#paper-scroll').scrollTop = 0`);
  await tick(150);
  await shot('review-out-of-date');
  const before = await js(`chapterHTML[${JSON.stringify(c1)}]`);
  await js(`reviewDecideOne(${JSON.stringify(s.id)}, 'accept')`);
  assert.equal((await sug((x) => x.id === s.id))[0].status, 'open');
  assert.equal(await js(`chapterHTML[${JSON.stringify(c1)}]`), before);
  await js(`${it}.querySelector('[data-act="reject"]').click()`);
  await until(async () => (await sug((x) => x.id === s.id))[0].status === 'rejected');
});

test('Accept All names a version first; formatting, a new paragraph and a join go through the page', async () => {
  const c2 = await ch(1);
  // three more of Dana's, made the way an import keeps them
  await js(`(() => {
    const text = reviewChapterText(${JSON.stringify(c2)});
    const at = (w) => text.indexOf(w);
    const P = ReviewMatch.PARA;
    const mk = (kind, o, len, more) => Object.assign({ id: reviewNewId('s'), round: null, import: null, status: 'open', kind, reviewer: 'Dana Editor', date: '', chapter: ${JSON.stringify(c2)}, anchor: ReviewMatch.anchorIn(text, o, len) }, more);
    const first = text.indexOf(P);
    rvs.data.suggestions.push(
      mk('format', at('Friday night'), 'Friday night'.length, { text: 'Friday night', was: { b: false, i: false }, now: { b: false, i: true } }),
      mk('insert', first, 0, { del: '', ins: P + 'The night was cold.' }),
      mk('delete', at('mail, as it laboured') + 'mail, as it laboured up Shooter’s Hill.'.length, 1, { del: P, ins: '' })
    );
    reviewRender();
    $('#paper-scroll').scrollTop = 0;
  })()`);
  await tick(150);
  await shot('review-before-accept-all');
  const open = await js(`reviewOpen(rvs.data).length`);
  await js(`${R}.querySelector('[data-act="accept-all"]').click()`);
  await until(() => js(`reviewOpen(rvs.data).length === 0 && !rvs.busy`));
  const html = await js(`chapterHTML[${JSON.stringify(c2)}]`);
  assert.match(html, /<i>Friday night<\/i>/);
  const paras = await js(`ReviewMatch.htmlParas(chapterHTML[${JSON.stringify(c2)}])`);
  assert.equal(paras[1], 'The night was cold.');
  assert.ok(paras[2].startsWith('The Dover road lay') && paras[2].includes('Shooter’s Hill.He walked uphill'), paras[2]);
  assert.equal(paras.length, 3);
  const named = await js(`window.neo.history.named(book.id)`);
  const v = named.find((x) => x.auto === 'review');
  assert.ok(v && /^Before accepting all changes \(/.test(v.name), JSON.stringify(named.map((x) => x.name)));
  assert.match(await js(`$('#hint').textContent`), new RegExp('^' + (open) + ' accepted\\.'));
  // nothing left: the tab goes once the writer leaves it
  const threads = (await reviewJson()).threads.filter((th) => !th.resolved).length;
  assert.equal(await tabN(), String(threads)); // (the comments wait: M5)
  assert.ok(threads > 0);
  await js(`goToTab('manuscript')`);
  await tick(100);
  assert.equal(await js(`document.querySelector('.tab[data-tab="review"]').hidden`), false, 'comments still wait');
});

test('the log says the accepted words are the editor’s, numbered, never named; nothing unlogged', async () => {
  await js(`slogSaveAll()`);
  await tick(600);
  const dir = path.join(await bookDirOf(), 'scribes-log');
  const slog = require('../slog.js');
  const entries = fs.readdirSync(dir).filter(slog.isChunkName).sort().flatMap((n) => slog.parseChunk(fs.readFileSync(path.join(dir, n), 'utf8')).entries);
  const ed = entries.filter((e) => e.src === 'editor');
  assert.ok(ed.length >= 2, 'editor entries: ' + ed.length);
  assert.ok(ed.every((e) => e.by === 'Reviewer 1' && e.cause === 'review'), JSON.stringify(ed.map((e) => [e.by, e.cause])));
  const unlogged = entries.filter((e) => e.src === 'unlogged');
  assert.deepEqual(unlogged.map((e) => e.doc), []);
  for (const n of fs.readdirSync(dir)) {
    if (!fs.statSync(path.join(dir, n)).isFile()) continue;
    assert.ok(!fs.readFileSync(path.join(dir, n), 'utf8').includes('Dana'), n + ' names no one');
  }
});

test('the Verification Report counts the editor’s text, and names them only when asked', async () => {
  const file = path.join(tmp, 'report.html');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  const res = await js(`window.neo.slog.report(book.id, { privacy: 'dates' })`);
  assert.equal(res.path, file, JSON.stringify(res));
  const page = fs.readFileSync(file, 'utf8');
  assert.ok(page.includes('From an editor (Reviewer 1)'), 'counted');
  assert.ok(!page.includes('Dana'), 'not named');
  const named = path.join(tmp, 'report-named.html');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: named });
  await js(`window.neo.slog.report(book.id, { privacy: 'dates', nameEditors: true })`);
  assert.ok(fs.readFileSync(named, 'utf8').includes('From an editor (Dana Editor)'));
  let errors = '';
  try { errors = fs.readFileSync(path.join(LIB, 'neo-errors.log'), 'utf8'); } catch { /* none */ }
  assert.equal(errors, '');
});

// ---- M5: comments in the margin, replies, resolved, deleted, sent back ----
const card = (id) => `${R}.querySelector('.rv-margin .rv-thread[data-tid="${id}"]')`;
const thread = async (pred) => (await reviewJson()).threads.find(pred);
let hillId = null;
const extra = {};

test('comments sit in the margin beside their words, lit on the page', async () => {
  await js(`goToTab('review')`);
  await tick(300);
  // two more of Dana's on chapter 1, made the way an import keeps them
  const c1 = await ch(0);
  const ids = await js(`(async () => {
    const text = reviewChapterText(${JSON.stringify(c1)});
    const mk = (words, say) => ({ id: reviewNewId('t'), round: null, import: null, chapter: ${JSON.stringify(c1)}, anchor: ReviewMatch.anchorIn(text, text.indexOf(words), words.length), resolved: false, fileResolved: false, comments: [{ by: 'Dana Editor', at: '2026-10-09T11:00:00Z', text: say }] });
    const a = mk('the age of wisdom', 'Lovely.');
    const b = mk('a king with a large jaw', 'Cut?');
    rvs.data.threads.push(a, b);
    await reviewSave(book.id, rvs.data);
    reviewTabShow();
    reviewRender();
    return [a.id, b.id];
  })()`);
  [extra.lovely, extra.cut] = ids;
  const review = await reviewJson();
  const open = review.threads.filter((th) => !th.deleted);
  const cards = await js(`[...${R}.querySelectorAll('.rv-margin .rv-thread')].map((c) => c.dataset.tid)`);
  assert.deepEqual(cards.slice().sort(), open.map((th) => th.id).sort());
  hillId = review.threads.find((th) => th.comments[0].text === 'Which hill?').id;
  // the words it's about, lit, and the card beside them
  const lit = await js(`[...${R}.querySelectorAll('.rv-page .rv-c')].filter((e) => e.dataset.tid.split(' ').includes(${JSON.stringify(hillId)})).map((e) => e.textContent).join('')`);
  assert.equal(lit, sent.b);
  for (const [id, words] of [[hillId, sent.b], [extra.lovely, 'the age of wisdom'], [extra.cut, 'a king with a large jaw']]) {
    const where = await js(`(() => {
      const c = ${card(id)}.getBoundingClientRect().top;
      const m = [...${R}.querySelectorAll('.rv-page [data-tid]')].find((e) => e.dataset.tid.split(' ').includes(${JSON.stringify(id)})).getBoundingClientRect().top;
      return [c, m];
    })()`);
    assert.ok(Math.abs(where[0] - where[1]) < 140, words + ': card at ' + where[0] + ', words at ' + where[1]);
  }
  assert.equal(await js(`${card(extra.lovely)}.querySelector('.rv-cm-text').textContent`), 'Lovely.');
  assert.equal(+(await tabN()), open.length, 'each open thread counts');
  assert.equal(await js(`document.querySelectorAll('#chapters .rv-c, #chapters .rv-cpt, #chapters .rv-thread').length`), 0, 'nothing on the writing page');
  await js(`reviewSelectThread(${JSON.stringify(extra.lovely)}); $('#paper-scroll').scrollTop = 0`);
  await tick(250);
  await shot('review-comments');
});

test('a reply is typed in the margin: ⌘Enter sends it, as the writer’s; a draft survives a redraw', async () => {
  await js(`reviewSelectThread(${JSON.stringify(hillId)}, { focus: true })`);
  assert.equal(await js(`document.activeElement === ${card(hillId)}.querySelector('.rv-replybox')`), true);
  // a draft in another thread, kept while the margin redraws
  await js(`(() => { const b = ${card(extra.cut)}.querySelector('.rv-replybox'); b.value = 'Half a thought'; b.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await js(`(() => {
    const box = ${card(hillId)}.querySelector('.rv-replybox');
    box.value = 'Shooter’s Hill, near Blackheath.';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  })()`);
  await until(async () => (await thread((th) => th.id === hillId)).comments.length === 2);
  const th = await thread((x) => x.id === hillId);
  assert.deepEqual(th.comments.map((c) => [c.by, c.text, !!c.mine]), [['Dana Editor', 'Which hill?', false], ['Charles Dickens', 'Shooter’s Hill, near Blackheath.', true]]);
  assert.match(th.comments[1].at, /^\d{4}-\d\d-\d\dT/);
  await tick(100);
  assert.deepEqual(await js(`[...${card(hillId)}.querySelectorAll('.rv-cm-text')].map((e) => e.textContent)`), ['Which hill?', 'Shooter’s Hill, near Blackheath.']);
  assert.equal(await js(`${card(hillId)}.querySelector('.rv-replybox').value`), '', 'the box empties');
  assert.equal(await js(`${card(extra.cut)}.querySelector('.rv-replybox').value`), 'Half a thought', 'the other draft kept');
  // an empty reply sends nothing
  await js(`(() => { const box = ${card(hillId)}.querySelector('.rv-replybox'); box.value = '   '; box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); })()`);
  await tick(200);
  assert.equal((await thread((x) => x.id === hillId)).comments.length, 2);
  // nothing in the book or the log for it
  assert.equal(await js(`Object.values(chapterHTML).some((h) => h.includes('Blackheath'))`), false);
});

test('Resolve folds a thread; Resolve and Delete moves it to Deleted comments; ⌘Z and Put back bring it back', async () => {
  const n0 = +(await tabN());
  await js(`${card(extra.lovely)}.querySelector('[data-tact="resolve"]').click()`);
  await until(async () => (await thread((x) => x.id === extra.lovely)).resolved === true);
  await until(() => js(`!!${card(extra.lovely)} && ${card(extra.lovely)}.classList.contains('rv-folded')`));
  assert.equal(+(await tabN()), n0 - 1);
  // a click unfolds it: Reopen, Delete
  await js(`${card(extra.lovely)}.click()`);
  await until(() => js(`!${card(extra.lovely)}.classList.contains('rv-folded')`));
  assert.deepEqual(await js(`[...${card(extra.lovely)}.querySelectorAll('[data-tact]')].map((b) => b.dataset.tact)`), ['reopen', 'delete']);
  // Resolve and Delete
  await js(`${card(extra.cut)}.querySelector('[data-tact="delete"]').click()`);
  await until(async () => !!(await thread((x) => x.id === extra.cut)).deleted);
  await until(() => js(`!${card(extra.cut)}`));
  assert.match(await js(`$('#hint').textContent`), /under Deleted comments/);
  assert.equal(await js(`${R}.querySelector('.rv-deleted summary').textContent`), 'Deleted comments (1)');
  assert.equal(+(await tabN()), n0 - 2);
  await js(`${R}.querySelector('.rv-deleted').open = true`);
  await tick(250);
  await shot('review-comments-deleted');
  // ⌘Z puts it back
  await js(`document.activeElement && document.activeElement.blur && document.activeElement.blur(); 0`);
  await keyDown('z', ', ctrlKey: true');
  await until(async () => !(await thread((x) => x.id === extra.cut)).deleted);
  await until(() => js(`!!${card(extra.cut)}`));
  assert.equal((await thread((x) => x.id === extra.cut)).resolved, false);
  assert.equal(await js(`${card(extra.cut)}.querySelector('.rv-replybox').value`), 'Half a thought', 'the draft still there');
  // deleted again, and Put back
  await js(`${card(extra.cut)}.querySelector('[data-tact="delete"]').click()`);
  await until(async () => !!(await thread((x) => x.id === extra.cut)).deleted);
  await until(() => js(`!!${R}.querySelector('.rv-gone [data-tact="restore"]')`));
  await js(`${R}.querySelector('.rv-gone [data-tact="restore"]').click()`);
  await until(async () => !(await thread((x) => x.id === extra.cut)).deleted);
  assert.equal((await thread((x) => x.id === extra.cut)).resolved, true, 'back, resolved');
  // and deleted for good, for the file below
  await until(() => js(`!!${card(extra.cut)}`));
  await js(`${card(extra.cut)}.click()`);
  await until(() => js(`!!${card(extra.cut)}.querySelector('[data-tact="delete"]')`));
  await js(`${card(extra.cut)}.querySelector('[data-tact="delete"]').click()`);
  await until(async () => !!(await thread((x) => x.id === extra.cut)).deleted);
});

test('the next file for an editor carries the threads back: replies, done, nothing deleted', async () => {
  const to = path.join(tmp, 'two-cities-dana-2.docx');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: to });
  await js(`(() => { window.__rv = doExport('review'); })()`);
  await until(() => js(`!!${D}`));
  await js(`${D}.querySelector('.rv-name').value = 'Dana Editor'; ${D}.querySelector('.rv-go').click()`);
  await js(`window.__rv`);
  assert.ok(fs.existsSync(to));
  if (process.env.NEO_TEST_SHOTS) fs.copyFileSync(to, path.join(process.env.NEO_TEST_SHOTS, 'sent-back-with-comments.docx'));
  const m = await readDocx(to);
  const by = (text) => m.comments.find((c) => c.text === text);
  const hill = by('Which hill?');
  const reply = by('Shooter’s Hill, near Blackheath.');
  assert.ok(hill && reply, m.comments.map((c) => c.text).join(' | '));
  assert.deepEqual([hill.author, hill.parent, hill.done], ['Dana Editor', null, false]);
  assert.deepEqual([reply.author, reply.parent, reply.done], ['Charles Dickens', hill.id, false]);
  assert.equal(m.paragraphs[hill.start.p].after.slice(hill.start.a, hill.end.a), sent.b, 'over the same words');
  const lovely = by('Lovely.');
  assert.equal(lovely.done, true, 'resolved goes back marked done');
  assert.equal(m.paragraphs[lovely.start.p].after.slice(lovely.start.a, lovely.end.a), 'the age of wisdom');
  assert.equal(by('Cut?'), undefined, 'a deleted thread stays home');
  assert.equal(hill.dateUtc, '2026-10-09T10:01:00Z');
  // the text itself is as NEO sends it: the comments add no words
  assert.ok(m.paragraphs.some((p) => p.after === CH1[0]));
  assert.equal(m.changes.length, 0);
  // the file opens in LibreOffice, an outside reader
  const review = await reviewJson();
  const th = review.threads.find((x) => x.id === hillId);
  assert.ok(th.comments.every((c) => (c.sent || []).length === 1), 'the ids it went with, kept');
  sent.back2 = { to, round: review.rounds[review.rounds.length - 1], m };
});

test('a second round reads them back as the same threads, with the editor’s new reply', async () => {
  const { to, m } = sent.back2;
  const zip = await JSZip.loadAsync(fs.readFileSync(to));
  const root = m.comments.find((c) => c.text === 'Which hill?');
  let cx = await zip.file('word/comments.xml').async('string');
  cx = cx.replace('</w:comments>', '<w:comment w:id="99" w:author="Dana Editor" w:date="2026-10-10T09:00:00Z"><w:p w14:paraId="7BBB0001"><w:r><w:t>Perfect, thanks.</w:t></w:r></w:p></w:comment></w:comments>');
  zip.file('word/comments.xml', cx);
  let ex = await zip.file('word/commentsExtended.xml').async('string');
  ex = ex.replace('</w15:commentsEx>', `<w15:commentEx w15:paraId="7BBB0001" w15:paraIdParent="${root.paraId}" w15:done="0"/></w15:commentsEx>`);
  zip.file('word/commentsExtended.xml', ex);
  const back = path.join(tmp, 'two-cities-dana-2-back.docx');
  fs.writeFileSync(back, await zip.generateAsync({ type: 'nodebuffer' }));
  const before = await reviewJson();
  await js(`(() => { window.__ri = importReview(${JSON.stringify(back)}); })()`);
  await until(() => js(`!!${S}`));
  const lines = await summaryLines();
  assert.equal(lines[0], 'Dana Editor: 1 comment', lines.join(' | '));
  assert.ok(lines.some((l) => /comment threads you sent back are the same threads/.test(l)), lines.join(' | '));
  await tick(150);
  await shot('review-comments-second-round');
  await js(`${S}.querySelector('.m-ok').click()`);
  await js(`window.__ri`);
  const after = await reviewJson();
  assert.equal(after.threads.length, before.threads.length, 'no new threads');
  const th = after.threads.find((x) => x.id === hillId);
  assert.deepEqual(th.comments.map((c) => c.text), ['Which hill?', 'Shooter’s Hill, near Blackheath.', 'Perfect, thanks.']);
  assert.equal(after.threads.find((x) => x.id === extra.lovely).resolved, true);
  assert.ok(after.threads.find((x) => x.id === extra.cut).deleted, 'still deleted');
  assert.deepEqual(after.reviewers.map((r) => r.name), before.reviewers.map((r) => r.name), 'the writer is not a reviewer');
  await until(() => js(`currentTab === 'review' && !!${card(hillId)}`));
  assert.equal(await js(`${card(hillId)}.querySelectorAll('.rv-cm').length`), 3);
  let errors = '';
  try { errors = fs.readFileSync(path.join(LIB, 'neo-errors.log'), 'utf8'); } catch { /* none */ }
  assert.equal(errors, '');
});

// ---- M6: more than one editor ----
let wid = 3000;
const W = (who) => `w:id="${wid++}" w:author="${who}" w:date="2026-10-10T10:00:00Z"`;
const INS = (who, text) => `<w:ins ${W(who)}><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:ins>`;
const DEL = (who, text) => `<w:del ${W(who)}><w:r><w:delText xml:space="preserve">${text}</w:delText></w:r></w:del>`;
// one person's insertion that the next person took out (a file passed on)
const INSDEL = (a, b, text) => `<w:ins ${W(a)}><w:del ${W(b)}><w:r><w:delText xml:space="preserve">${text}</w:delText></w:r></w:del></w:ins>`;
// `find`, in one run's text, replaced by tracked changes (as Word writes them)
function splice(doc, find, xml) {
  const i = doc.indexOf(find);
  assert.ok(i >= 0, 'in the file: ' + find);
  const open = doc.lastIndexOf('<w:t', i);
  assert.ok(doc.lastIndexOf('</w:t>', i) < open && doc.indexOf('</w:t>', i) >= i + find.length, 'in one run: ' + find);
  return doc.slice(0, i) + '</w:t></w:r>' + xml + '<w:r><w:t xml:space="preserve">' + doc.slice(i + find.length);
}
async function sendTo(name, file) {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  await js(`(() => { window.__rv = doExport('review'); })()`);
  await until(() => js(`!!${D}`));
  await js(`${D}.querySelector('.rv-name').value = ${JSON.stringify(name)}; ${D}.querySelector('.rv-go').click()`);
  await js(`window.__rv`);
  assert.ok(fs.existsSync(file), file);
}
async function edited(file, out, edit) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  zip.file('word/document.xml', edit(await zip.file('word/document.xml').async('string')));
  fs.writeFileSync(out, await zip.generateAsync({ type: 'nodebuffer' }));
  return out;
}
async function importIt(file) {
  await js(`(() => { window.__ri = importReview(${JSON.stringify(file)}); })()`);
  await until(() => js(`!!${S}`));
  // (the comment threads sent back with every file come back the same)
  const lines = (await summaryLines()).filter((l) => !/are the same threads/.test(l));
  const notes = await summaryNotes();
  await js(`${S}.querySelector('.m-ok').click()`);
  await js(`window.__ri`);
  await until(() => js(`currentTab === 'review' && !rvs.busy`));
  return { lines, notes };
}
const c1Text = async () => js(`ReviewMatch.htmlText(chapterHTML[book.chapterOrder[0]])`);
const groupId = () => js(`(${R}.querySelector('.rv-group') || {}).dataset?.sid || null`);
const m6 = {};

test('two editors at once: their changes to one passage are one item, the wordings side by side', async () => {
  const fd = await sendTo('Dana Editor', path.join(tmp, 'm6-dana.docx')).then(() => path.join(tmp, 'm6-dana.docx'));
  const fl = await sendTo('Lee Copyeditor', path.join(tmp, 'm6-lee.docx')).then(() => path.join(tmp, 'm6-lee.docx'));
  const back1 = await edited(fd, path.join(tmp, 'm6-dana-back.docx'), (doc) => {
    doc = splice(doc, 'conceded', DEL('Dana Editor', 'conceded') + INS('Dana Editor', 'granted'));
    return splice(doc, 'favoured', DEL('Dana Editor', 'favoured') + INS('Dana Editor', 'favored'));
  });
  const back2 = await edited(fl, path.join(tmp, 'm6-lee-back.docx'), (doc) => {
    doc = splice(doc, 'conceded to England', DEL('Lee Copyeditor', 'conceded') + INS('Lee Copyeditor', 'vouchsafed') + '<w:r><w:t xml:space="preserve"> to England</w:t></w:r>');
    return splice(doc, 'Our Lord', DEL('Lee Copyeditor', 'Our') + INS('Lee Copyeditor', 'our') + '<w:r><w:t xml:space="preserve"> Lord</w:t></w:r>');
  });
  assert.deepEqual((await importIt(back1)).lines, ['Dana Editor: 2 changes']);
  assert.deepEqual((await importIt(back2)).lines, ['Lee Copyeditor: 2 changes']);
  const review = await reviewJson();
  const lee = review.reviewers.find((r) => r.name === 'Lee Copyeditor');
  assert.ok(lee && new Set(review.reviewers.map((r) => r.color)).size === review.reviewers.length, 'every reviewer has a color of their own');
  // the list: Dana's "favored", Lee's "our", and the passage both changed
  const gid = await groupId();
  assert.ok(gid, 'a passage two editors changed');
  assert.equal((await items()).length, 3);
  const alts = await js(`[...${R}.querySelectorAll('.rv-group .rv-alt')].map((a) => [a.querySelector('.rv-alt-by').textContent, a.querySelector('ins').textContent, a.querySelector('del').textContent])`);
  assert.deepEqual(alts, [['Dana Editor', 'granted', 'conceded'], ['Lee Copyeditor', 'vouchsafed', 'conceded']]);
  // on the page: today's words, marked in both colors
  const mark = await js(`(() => { const m = ${R}.querySelector('.rv-page .rv-clash[data-sid="${gid}"]'); return m && [m.textContent, m.style.getPropertyValue('--rv'), m.style.getPropertyValue('--rv2')]; })()`);
  assert.deepEqual(mark, ['conceded', review.reviewers.find((r) => r.name === 'Dana Editor').color, lee.color]);
  await js(`reviewSelect(${JSON.stringify(gid)}); $('#paper-scroll').scrollTop = 0`);
  await tick(200);
  await shot('review-two-editors');
  m6.gid = gid;
});

test('the reviewer filter: a chip hides or shows its editor; Alt-click shows only theirs', async () => {
  const chip = (name) => `${R}.querySelector('.rv-who[data-who="${name}"] [data-act="filter"]')`;
  await js(`${chip('Lee Copyeditor')}.click()`);
  assert.equal(await groupId(), null, 'one editor shown: no passage to pick between');
  let shown = await js(`[...${R}.querySelectorAll('.rv-item .rv-by')].map((x) => x.textContent)`);
  assert.deepEqual(shown, ['Dana Editor', 'Dana Editor']);
  assert.equal(await js(`${R}.querySelector('[data-act="accept-all"]').textContent`), 'Accept Shown');
  assert.match(await js(`${R}.querySelector('.rv-sum').textContent`), /\(2 hidden\)/);
  assert.equal(await js(`${R}.querySelector('.rv-who[data-who="Lee Copyeditor"]').classList.contains('rv-off')`), true);
  await tick(150);
  await shot('review-filter');
  // Alt-click: only Lee's
  await js(`${chip('Lee Copyeditor')}.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))`);
  shown = await js(`[...${R}.querySelectorAll('.rv-item .rv-by')].map((x) => x.textContent)`);
  assert.deepEqual(shown, ['Lee Copyeditor', 'Lee Copyeditor']);
  // only Dana's comment threads go with her
  assert.equal(await js(`[...${R}.querySelectorAll('.rv-thread')].length`), 0);
  await js(`${R}.querySelector('[data-act="show-all"]').click()`);
  assert.equal(await groupId(), m6.gid);
  assert.ok(await js(`${R}.querySelectorAll('.rv-thread').length > 0`));
});

test('Accept All leaves the passage two editors changed for the writer to pick', async () => {
  await js(`${R}.querySelector('[data-act="accept-all"]').click()`);
  await until(() => js(`!rvs.busy && ${R}.querySelectorAll('.rv-item').length === 1`));
  const text = await c1Text();
  assert.ok(text.includes('our Lord') && text.includes('that favored period') && text.includes('were conceded to England'), text);
  assert.match(await js(`$('#hint').textContent`), /^2 accepted\. 1 passages two editors both changed wait/);
  assert.equal(await groupId(), m6.gid);
});

test('picking one: 2 takes Lee’s wording and sets Dana’s aside; ⌘Z puts both back', async () => {
  await js(`reviewSelect(${JSON.stringify(m6.gid)}); reviewFocus()`);
  await keyDown('2');
  await until(async () => (await sug((x) => x.ins === 'vouchsafed'))[0].status === 'accepted');
  assert.equal((await sug((x) => x.ins === 'granted'))[0].status, 'rejected');
  assert.ok((await c1Text()).includes('were vouchsafed to England'));
  assert.equal(await groupId(), null);
  await js(`document.activeElement && document.activeElement.blur && document.activeElement.blur(); 0`);
  await keyDown('z', ', ctrlKey: true');
  await until(async () => (await sug((x) => x.ins === 'granted'))[0].status === 'open');
  assert.equal((await sug((x) => x.ins === 'vouchsafed'))[0].status, 'open');
  await until(async () => (await c1Text()).includes('were conceded to England'));
  await until(async () => (await groupId()) === m6.gid);
});

test('or the writer’s own words: W opens a box with the passage; ⌘Enter puts them in, logged as typed', async () => {
  await js(`reviewSelect(${JSON.stringify(m6.gid)}); reviewFocus()`);
  await keyDown('w');
  const box = `${R}.querySelector('.rv-ownbox')`;
  await until(() => js(`!!${box}`));
  assert.equal(await js(`${box}.value`), 'conceded');
  assert.equal(await js(`document.activeElement === ${box}`), true);
  await js(`${box}.value = 'granted, by grace,'; ${box}.dispatchEvent(new Event('input', { bubbles: true }))`);
  await tick(100);
  await shot('review-own-words');
  // a redraw keeps what's typed
  await js(`reviewRender()`);
  assert.equal(await js(`${box}.value`), 'granted, by grace,');
  await js(`${box}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))`);
  await until(async () => (await sug((x) => x.ins === 'granted'))[0].status === 'rejected');
  assert.equal((await sug((x) => x.ins === 'vouchsafed'))[0].status, 'rejected');
  assert.ok((await c1Text()).includes('were granted, by grace, to England'), await c1Text());
  assert.equal(await groupId(), null);
});

test('a file passed from one editor to the next: each person’s changes under their own name, taken in any order', async () => {
  const f = path.join(tmp, 'm6-ann.docx');
  await sendTo('Ann Editor', f);
  const back = await edited(f, path.join(tmp, 'm6-ann-bo.docx'), (doc) => {
    // Ann put in "bright and ", Bo took her "and " out and put in "early "
    doc = splice(doc, 'spring of hope', INS('Ann Editor', 'bright ') + INSDEL('Ann Editor', 'Bo Proofreader', 'and ') + INS('Bo Proofreader', 'early ') + '<w:r><w:t xml:space="preserve">spring of hope</w:t></w:r>');
    return splice(doc, 'winter of despair', DEL('Bo Proofreader', 'winter') + INS('Bo Proofreader', 'season') + '<w:r><w:t xml:space="preserve"> of despair</w:t></w:r>');
  });
  const want = (await readDocx(back)).paragraphs.find((p) => p.after.includes('bright early spring')).after;
  const { lines, notes } = await importIt(back);
  assert.deepEqual(lines, ['Ann Editor: 1 change', 'Bo Proofreader: 2 changes']);
  assert.ok(notes.some((n) => /took back/.test(n)), notes.join(' | '));
  assert.equal(await groupId(), null, 'one file, not two editors side by side');
  const ann = (await sug((x) => x.reviewer === 'Ann Editor' && x.status === 'open'))[0];
  const [early, season] = ['early ', 'season'].map(async (w) => (await sug((x) => x.reviewer === 'Bo Proofreader' && x.ins === w))[0]);
  const bo1 = await early;
  const bo2 = await season;
  assert.deepEqual([ann.ins, bo1.ins], ['bright ', 'early ']);
  // Bo's first: Ann's, right beside it, still has its place
  await js(`reviewSelect(${JSON.stringify(bo1.id)}); reviewFocus()`);
  await keyDown('a');
  await until(async () => (await sug((x) => x.id === bo1.id))[0].status === 'accepted');
  assert.ok((await c1Text()).includes('the early spring of hope'));
  assert.equal(await js(`!!${R}.querySelector('.rv-item[data-sid="${ann.id}"] .rv-stale')`), false, 'not out of date');
  await js(`reviewSelect(${JSON.stringify(ann.id)}); reviewFocus()`);
  await keyDown('a');
  await until(async () => (await sug((x) => x.id === ann.id))[0].status === 'accepted');
  await js(`reviewDecideOne(${JSON.stringify(bo2.id)}, 'accept')`);
  const text = await c1Text();
  assert.ok(text.split(ReviewMatchPARA).includes(want), text);
  // ⌘Z three times, then all at once: the same
  await js(`document.activeElement && document.activeElement.blur && document.activeElement.blur(); 0`);
  for (const id of [bo2.id, ann.id, bo1.id]) {
    await keyDown('z', ', ctrlKey: true');
    await until(async () => (await sug((x) => x.id === id))[0].status === 'open');
  }
  await until(async () => (await c1Text()).includes('the spring of hope, it was the winter'));
  await js(`${R}.querySelector('.rv-who[data-who="Bo Proofreader"] [data-act="accept-who"]').click()`);
  await until(async () => (await sug((x) => x.id === bo2.id))[0].status === 'accepted');
  await js(`${R}.querySelector('.rv-item[data-sid="${ann.id}"] [data-act="accept"]').click()`);
  await until(async () => (await sug((x) => x.id === ann.id))[0].status === 'accepted');
  assert.ok((await c1Text()).split(ReviewMatchPARA).includes(want), await c1Text());
});

test('a reviewer’s color is theirs to change: the dot on their chip', async () => {
  // something of Lee's waiting, so Lee has a chip
  await js(`(() => { const s = rvs.data.suggestions.find((x) => x.ins === 'vouchsafed'); s.status = 'open'; reviewRender(); })()`);
  await js(`${R}.querySelector('.rv-who[data-who="Lee Copyeditor"] [data-act="color"]').click()`);
  const sw = await js(`[...${R}.querySelectorAll('.rv-swatch')].map((b) => b.dataset.color)`);
  assert.equal(sw.length, 8);
  const was = (await reviewJson()).reviewers.find((r) => r.name === 'Lee Copyeditor').color;
  const pick = sw.find((c) => c !== was);
  await js(`${R}.querySelector('.rv-swatch[data-color="${pick}"]').click()`);
  await until(async () => (await reviewJson()).reviewers.find((r) => r.name === 'Lee Copyeditor').color === pick);
  assert.equal(await js(`${R}.querySelector('.rv-who[data-who="Lee Copyeditor"]').style.getPropertyValue('--rv')`), pick);
  assert.equal(await js(`${R}.querySelectorAll('.rv-swatch').length`), 0, 'the swatches close');
  await js(`(() => { const s = rvs.data.suggestions.find((x) => x.ins === 'vouchsafed'); s.status = 'rejected'; reviewSave(book.id, rvs.data); reviewRender(); })()`);
});

test('the log: each editor’s words numbered, the writer’s own typed; nothing unlogged, no names', async () => {
  await js(`slogSaveAll()`);
  await tick(600);
  const dir = path.join(await bookDirOf(), 'scribes-log');
  const slog = require('../slog.js');
  const entries = fs.readdirSync(dir).filter(slog.isChunkName).sort().flatMap((n) => slog.parseChunk(fs.readFileSync(path.join(dir, n), 'utf8')).entries);
  const review = await reviewJson();
  const tag = (name) => RM.reviewerTag(review.reviewers, name);
  const by = new Set(entries.filter((e) => e.src === 'editor').map((e) => e.by));
  for (const name of ['Dana Editor', 'Lee Copyeditor', 'Ann Editor', 'Bo Proofreader']) assert.ok(by.has(tag(name)), name + ' as ' + tag(name) + ': ' + [...by]);
  assert.ok(entries.some((e) => e.src === 'typed' && e.cause === 'review'), 'the writer’s own wording, typed');
  assert.deepEqual(entries.filter((e) => e.src === 'unlogged').map((e) => e.doc), []);
  for (const n of fs.readdirSync(dir)) {
    if (!fs.statSync(path.join(dir, n)).isFile()) continue;
    const body = fs.readFileSync(path.join(dir, n), 'utf8');
    for (const name of ['Dana', 'Lee', 'Ann', 'Bo Proof']) assert.ok(!body.includes(name), n + ' names no one');
  }
  let errors = '';
  try { errors = fs.readFileSync(path.join(LIB, 'neo-errors.log'), 'utf8'); } catch { /* none */ }
  assert.equal(errors, '');
});

test('a paragraph moved in Word (here to the chapter’s end) is one change, and accepting it moves the paragraph whole', async () => {
  const c2 = await ch(1);
  const parasNow = () => js(`ReviewMatch.htmlParas(chapterHTML[${JSON.stringify(c2)}])`);
  const before = await parasNow();
  const X = 'The night was cold.';
  const at = before.indexOf(X);
  assert.ok(at >= 0 && at < before.length - 1, JSON.stringify(before));
  const last = before[before.length - 1].slice(-20);
  const file = path.join(tmp, 'moved.docx');
  await sendTo('Dana Editor', file);
  const out = await edited(file, path.join(tmp, 'moved-back.docx'), (doc) => {
    const span = (needle) => {
      const i = doc.indexOf(needle);
      assert.ok(i >= 0, needle);
      return [doc.lastIndexOf('<w:p ', i), doc.indexOf('</w:p>', i) + 6];
    };
    const [ws, we] = span(X);
    const p = doc.slice(ws, we);
    const open = p.slice(0, p.indexOf('>') + 1).replace(/ w14:paraId="[^"]*"/, '');
    let inner = p.slice(p.indexOf('>') + 1, -6);
    let ppr = '';
    const pe = inner.indexOf('</w:pPr>');
    if (inner.startsWith('<w:pPr') && pe > 0) { ppr = inner.slice(0, pe + 8); inner = inner.slice(pe + 8); }
    const A = (id) => `w:id="${id}" w:author="Dana Editor" w:date="2026-10-10T10:00:00Z"`;
    const mark = (kind, id) => (ppr ? ppr.replace('</w:pPr>', `<w:rPr><w:${kind} ${A(id)}/></w:rPr></w:pPr>`) : `<w:pPr><w:rPr><w:${kind} ${A(id)}/></w:rPr></w:pPr>`);
    const fromP = open + mark('moveFrom', 7001) + `<w:moveFromRangeStart ${A(7002)} w:name="move9"/><w:moveFrom ${A(7003)}>` + inner.replace(/<w:t(\s|>)/g, '<w:delText$1').replace(/<\/w:t>/g, '</w:delText>') + '</w:moveFrom><w:moveFromRangeEnd w:id="7002"/></w:p>';
    const toP = open + mark('moveTo', 7004) + `<w:moveToRangeStart ${A(7005)} w:name="move9"/><w:moveTo ${A(7006)}>` + inner + '</w:moveTo><w:moveToRangeEnd w:id="7005"/></w:p>';
    const d = doc.slice(0, ws) + fromP + doc.slice(we);
    const i = d.indexOf(last);
    const e = d.indexOf('</w:p>', i) + 6;
    return d.slice(0, e) + toP + d.slice(e);
  });
  await importIt(out);
  const imp = (await reviewJson()).imports.slice(-1)[0].id;
  const mine = await sug((x) => x.import === imp && x.status === 'open');
  assert.deepEqual(mine.map((x) => [x.kind, x.del.replace(/\u2029/g, '¶'), x.ins.replace(/\u2029/g, '¶')]), [['move', X + '¶', '¶' + X]], 'one move, no ¶ of its own, nothing untracked');
  await js(`reviewDecideOne(${JSON.stringify(mine[0].id)}, 'accept')`);
  await until(async () => (await sug((x) => x.id === mine[0].id))[0].status === 'accepted');
  const want = before.filter((x) => x !== X).concat(X);
  assert.deepEqual(await parasNow(), want);
});

test('review.json written by another computer meanwhile: taken in, and never written over', async () => {
  const dir = await bookDirOf();
  const file = path.join(dir, 'review.json');
  const there = JSON.parse(fs.readFileSync(file, 'utf8'));
  const open = there.suggestions.find((s) => s.status === 'open' && !s.group);
  // the other computer: a round sent, a reply in a thread, and a change rejected
  there.rounds.push({ id: 'r-elsewhere', at: Date.now(), to: 'Someone Else', imports: [] });
  const th = there.threads.find((x) => !x.deleted);
  th.comments.push({ by: 'Charles Dickens', at: new Date().toISOString(), text: 'Typed on the laptop.', mine: true });
  const other = there.suggestions.find((s) => s.status === 'open' && s !== open);
  if (other) other.status = 'rejected';
  fs.writeFileSync(file, JSON.stringify(there));
  // this window, before it has looked: a change taken here
  if (open) {
    await js(`reviewDecideOne(${JSON.stringify(open.id)}, 'reject')`);
    await until(() => js(`!rvs.busy`));
  }
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(after.rounds.some((r) => r.id === 'r-elsewhere'), 'the other computer\'s round kept');
  assert.ok(after.threads.find((x) => x.id === th.id).comments.some((c) => c.text === 'Typed on the laptop.'), 'its reply kept');
  if (open) assert.equal(after.suggestions.find((s) => s.id === open.id).status, 'rejected', 'and this window\'s own step');
  if (other) assert.equal(after.suggestions.find((s) => s.id === other.id).status, 'rejected');
  // what's in the window has it too (and a refresh changes nothing more)
  await js(`reviewRefresh()`);
  assert.ok(await js(`rvs.data.rounds.some((r) => r.id === 'r-elsewhere')`));
  // a change made only on the other computer, taken in by a refresh
  const later = JSON.parse(fs.readFileSync(file, 'utf8'));
  later.editors = ['From the laptop', ...later.editors];
  fs.writeFileSync(file, JSON.stringify(later));
  await js(`reviewRefresh()`);
  assert.equal(await js(`rvs.data.editors.includes('From the laptop')`), true);
});

test('on the Review tab the left edge doesn’t slide the Chapters pane over the list', async () => {
  const hover = (tab) => js(`(() => {
    goToTab(${JSON.stringify(tab)});
    const pane = $('#nav-pane');
    pane.classList.remove('open');
    $('#nav-hotzone').dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    const open = pane.classList.contains('open');
    pane.classList.remove('open');
    return open;
  })()`);
  assert.equal(await hover('review'), false);
  assert.equal(await hover('manuscript'), true, 'the page still has it');
});

test('Import Review… is in the palette, and does nothing on the shelf', async () => {
  const items = await js(`window.neo.palette.items()`);
  const it = items.find((x) => x.label === 'Import Review…');
  assert.ok(it, 'listed');
  assert.deepEqual(it.path, ['File']);
});

test('a file from another book: NEO says which book it’s from and imports it there; one that isn’t this book’s is asked about', async () => {
  const twoCities = await js('book.id');
  const reviewsBefore = JSON.stringify((await reviewJson()).imports);
  // a second book, sent to an editor
  const md = path.join(tmp, 'harbor.md');
  fs.writeFileSync(md, ['# Chapter 1', 'The harbor was quiet before the storm, and the gulls wheeled over the empty slips while the boats rocked at their moorings.', 'Mara counted the boats twice and found that one of them was missing from the far end of the long stone pier.'].join('\n\n'));
  const harbor = await js(`(async () => {
    const results = await window.neo.importFiles([${JSON.stringify(md)}]);
    await addImportedBooks(results, library.shelves[0]);
    const ids = library.shelves[0].bookIds;
    await openBook(ids[ids.length - 1]);
    return book.id;
  })()`);
  await tick(800);
  const sentFile = path.join(tmp, 'renamed-by-the-editor.docx');
  await sendTo('Dana Editor', sentFile);
  const edited2 = await edited(sentFile, path.join(tmp, 'final-FINAL-v3.docx'), (doc) => splice(doc, 'quiet', DEL('Dana Editor', 'quiet') + INS('Dana Editor', 'still')));
  // back to A Tale of Two Cities, and the harbor's file imported there by mistake
  await js(`openBook(${JSON.stringify(twoCities)})`);
  await until(() => js(`book.id === ${JSON.stringify(twoCities)}`));
  await tick(600);
  await js(`(() => { window.__ri = importReview(${JSON.stringify(edited2)}); })()`);
  await js(`window.LAST = () => [...document.querySelectorAll('.modal-backdrop:not([hidden])')].pop(); 0`);
  await until(() => js(`!!LAST() && /another book/.test(LAST().textContent)`));
  assert.match(await js(`LAST().textContent`), /was sent from “harbor”|was sent from “The Harbor”|was sent from “/);
  await tick(150);
  await shot('review-wrong-book');
  assert.deepEqual(await js(`[...LAST().querySelectorAll('.fr-choice strong')].map((b) => b.textContent)`).then((l) => l.map((x) => x.replace(/“.*”/, '“…”'))), ['Open “…” and import it there', 'Import it into this book anyway']);
  await js(`LAST().querySelector('.fr-choice').click()`);
  await until(() => js(`!!${S}`));
  assert.equal(await js('book.id'), harbor, 'the harbor book opened');
  assert.deepEqual(await summaryLines(), ['Dana Editor: 1 change']);
  await js(`${S}.querySelector('.m-ok').click()`);
  await js(`window.__ri`);
  assert.equal((await reviewJson()).imports.length, 1, 'in the harbor book');
  // the same file with NEO's marks taken out (as if from somewhere else),
  // into A Tale of Two Cities: it doesn't look like this book
  const bare = path.join(tmp, 'bare.docx');
  {
    const zip = await JSZip.loadAsync(fs.readFileSync(edited2));
    zip.remove('docProps/custom.xml');
    fs.writeFileSync(bare, await zip.generateAsync({ type: 'nodebuffer' }));
  }
  await js(`openBook(${JSON.stringify(twoCities)})`);
  await until(() => js(`book.id === ${JSON.stringify(twoCities)}`));
  await tick(600);
  await js(`(() => { window.__ri = importReview(${JSON.stringify(bare)}); })()`);
  await until(() => js(`!!LAST() && /Which version/.test(LAST().textContent)`));
  await js(`LAST().querySelector('.fr-choice').click()`);
  await until(() => js(`!!LAST() && /doesn’t look like this book/.test(LAST().textContent)`));
  assert.match(await js(`LAST().textContent`), /Only \d+% of bare\.docx is in “A Tale of Two Cities”/);
  await js(`LAST().querySelector('.m-cancel').click()`);
  await js(`window.__ri`);
  assert.equal(JSON.stringify((await reviewJson()).imports), reviewsBefore, 'nothing imported into the wrong book');
  // a file from a book no longer in this library (say, this book's own,
  // duplicated since): said so, and it can still come in here
  const gone = path.join(tmp, 'from-a-gone-book.docx');
  {
    const sentHere = path.join(tmp, 'this-book.docx');
    await sendTo('Dana Editor', sentHere);
    const zip = await JSZip.loadAsync(fs.readFileSync(sentHere));
    const props = await zip.file('docProps/custom.xml').async('string');
    zip.file('docProps/custom.xml', props.replace(/(name="NEO.Book"><vt:lpwstr>)[^<]*/, '$1book-gone-000000').replace(/(name="NEO.ReviewRound"><vt:lpwstr>)[^<]*/, '$1r20200101-000000'));
    let doc = await zip.file('word/document.xml').async('string');
    doc = splice(doc, 'foolishness', DEL('Dana Editor', 'foolishness') + INS('Dana Editor', 'folly'));
    zip.file('word/document.xml', doc);
    fs.writeFileSync(gone, await zip.generateAsync({ type: 'nodebuffer' }));
  }
  await js(`(() => { window.__ri = importReview(${JSON.stringify(gone)}); })()`);
  await until(() => js(`!!LAST() && /another book/.test(LAST().textContent)`));
  assert.match(await js(`LAST().textContent`), /isn’t in this library/);
  assert.deepEqual(await js(`[...LAST().querySelectorAll('.fr-choice strong')].map((b) => b.textContent)`), ['Import it into this book anyway']);
  await js(`LAST().querySelector('.fr-choice').click()`);
  await until(() => js(`!!LAST() && /Which version/.test(LAST().textContent)`));
  await js(`LAST().querySelector('.fr-choice').click()`);
  await until(() => js(`!!${S}`));
  assert.ok((await summaryLines()).some((l) => /^Dana Editor: /.test(l)), (await summaryLines()).join(' | '));
  await js(`${S}.querySelector('.m-ok').click()`);
  await js(`window.__ri`);
  const after = (await reviewJson()).suggestions.filter((x) => x.del === 'foolishness' && x.ins === 'folly');
  assert.equal(after.length, 1, 'imported here');
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
