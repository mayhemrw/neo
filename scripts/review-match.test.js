'use strict';

// Matching an editor's Word file to the book (review-match.js, phase 6):
// chapters by bookmark, title and text (reordered, renamed), tracked
// changes into suggestions, changes made without Track Changes, comments
// into threads, and anchors found again after the text was edited.

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const RD = require('../review-docx.js');
const M = require('../review-match.js');

const P = M.PARA;
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const run = (t) => `<w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const del = (t, id, by = 'Dana') => `<w:del w:id="${id}" w:author="${by}" w:date="2026-10-09T10:00:00Z"><w:r><w:delText xml:space="preserve">${esc(t)}</w:delText></w:r></w:del>`;
const ins = (t, id, by = 'Dana') => `<w:ins w:id="${id}" w:author="${by}" w:date="2026-10-09T10:00:00Z">${run(t)}</w:ins>`;
const para = (inner, ppr = '') => `<w:p><w:pPr>${ppr}</w:pPr>${inner}</w:p>`;
const heading = (title, num) => `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${num ? `<w:bookmarkStart w:id="${num}" w:name="_NEO_ch_${num}"/><w:bookmarkEnd w:id="${num}"/>` : ''}${typeof title === 'string' ? run(title) : title.xml}</w:p>`;
// a file as NEO sends it: the title page, then each chapter's heading, a
// blank line and its paragraphs (each given as XML or as plain text)
function file(chapters, { marks = true, extra = {} } = {}) {
  let body = para(run('A Tale'), '<w:pStyle w:val="Title"/>') + para(run('C. Dickens'));
  chapters.forEach((ch, i) => {
    body += heading(ch.title, marks ? i + 1 : 0) + para('');
    for (const p of ch.paras) body += typeof p === 'string' ? para(run(p)) : p.xml;
  });
  return RD.parse(Object.assign({ 'word/document.xml': `<w:document ${W}><w:body>${body}</w:body></w:document>` }, extra));
}
const sent = (list) => list.map((c, i) => ({ num: i + 1, id: c.id, title: c.title, kind: c.kind || 'chapter', text: c.paras.join(P) }));

const ONE = ['It was the best of times, it was the worst of times.', 'It was the age of wisdom, it was the age of foolishness.'];
const TWO = ['It was the Dover road that lay before him.', 'The mail lumbered up Shooter’s Hill.'];
const THREE = ['There was a steaming mist in all the hollows.', 'The guard suspected the passengers.'];

describe('the book side', () => {
  test('a chapter’s HTML as one string: paragraphs, scene breaks, line breaks; ghosts and empty lines left out', () => {
    const html = '<p>One <em>two</em>.</p><p class="scene-break"></p><p>Line<br>two</p><p class="ghost" data-sec-id="x">A note</p><p></p>';
    assert.deepEqual(M.htmlParas(html), ['One two.', '***', 'Line\ntwo']);
    assert.equal(M.htmlText(html), 'One two.' + P + '***' + P + 'Line\ntwo');
  });
});

describe('chapters', () => {
  const book = [{ id: 'c1', title: 'Chapter 1', paras: ONE }, { id: 'c2', title: 'Chapter 2', paras: TWO }, { id: 'c3', title: 'Chapter 3', paras: THREE }];

  test('by bookmark: renamed by the editor, and reordered in the book since, each still finds its chapter', () => {
    const m = file([{ title: 'Chapter 1', paras: ONE }, { title: { xml: del('Chapter 2', 1) + ins('The Road', 2) }, paras: TWO }, { title: 'Chapter 3', paras: THREE }]);
    // the book's order now: 3, 1, 2 (the round's numbers say which was which)
    const chapters = sent(book);
    const r = M.match(m, [chapters[2], chapters[0], chapters[1]], { fallback: 'Dana' });
    assert.equal(r.how, 'bookmarks');
    assert.deepEqual(r.chapters.map((c) => [c.id, c.by]), [['c1', 'bookmark'], ['c2', 'bookmark'], ['c3', 'bookmark']]);
    const t = r.suggestions.find((s) => s.kind === 'title');
    assert.deepEqual([t.chapter, t.del, t.ins, t.reviewer], ['c2', 'Chapter 2', 'The Road', 'Dana']);
    assert.equal(r.suggestions.length, 1, 'nothing else changed');
  });

  test('without bookmarks (a file not from NEO): by title, and a renamed one by its text', () => {
    const m = file([{ title: 'Chapter 3', paras: THREE }, { title: 'The Road', paras: TWO }, { title: 'Chapter 1', paras: ONE }], { marks: false });
    const r = M.match(m, sent(book).map((c) => ({ ...c, num: null })), { fallback: 'Dana' });
    assert.equal(r.how, 'headings');
    assert.deepEqual(r.chapters.map((c) => [c.id, c.by]), [['c3', 'title'], ['c2', 'text'], ['c1', 'title']]);
    assert.equal(r.unplaced, 0);
    assert.deepEqual(r.suggestions, []);
  });

  test('a section like none of the chapters is left unplaced', () => {
    const m = file([{ title: 'Appendix', paras: ['Nothing like any chapter at all, about gardening and bees.'] }], { marks: false });
    const r = M.match(m, sent(book).map((c) => ({ ...c, num: null })));
    assert.deepEqual(r.chapters.map((c) => c.id), [null]);
    assert.equal(r.unplaced, 1);
  });

  test('closeness: the version the file was sent from is the closest', () => {
    const m = file([{ title: 'Chapter 1', paras: ONE }, { title: 'Chapter 2', paras: TWO }]);
    const near = M.closeness(m, sent(book.slice(0, 2)));
    const far = M.closeness(m, sent([{ id: 'x', title: 'X', paras: ['Something else entirely, in other words, about the sea.'] }]));
    assert.ok(near > 0.9 && far < 0.2, near + ' ' + far);
  });
});

describe('tracked changes into suggestions', () => {
  const one = (paras, more) => M.match(file([{ title: 'Chapter 1', paras }], more), sent([{ id: 'c1', title: 'Chapter 1', paras: ONE }]), { fallback: 'Dana' });

  test('a replacement, an insertion and a deletion, each one suggestion with its anchor', () => {
    const r = one([
      { xml: para(run('It was the ') + del('best', 1) + ins('finest', 2) + run(' of times, it was the worst of times.') + ins(' Truly.', 3)) },
      { xml: para(run('It was the age of wisdom') + del(', it was the age of foolishness', 4) + run('.')) }
    ]);
    assert.deepEqual(r.suggestions.map((s) => [s.kind, s.del, s.ins, s.reviewer, s.chapter, !!s.untracked]), [
      ['replace', 'best', 'finest', 'Dana', 'c1', false],
      ['insert', '', ' Truly.', 'Dana', 'c1', false],
      ['delete', ', it was the age of foolishness', '', 'Dana', 'c1', false]
    ]);
    const a = r.suggestions[0].anchor;
    assert.deepEqual([a.exact, a.pre, a.post.slice(0, 10), a.o, a.p], ['best', 'It was the ', ' of times,', 11, 0]);
    assert.equal(r.suggestions[2].anchor.p, 1);
    assert.deepEqual(r.counts, { Dana: { changes: 3, comments: 0, untracked: 0, formatting: 0 } });
  });

  test('two people side by side are two suggestions; one person’s deletion of another’s insertion makes none', () => {
    const r = one([
      { xml: para(run('It was the ') + del('best', 1, 'Dana') + ins('finest', 2, 'Sam') + run(' of times, it was the worst of times.')) },
      { xml: para(run('It was the age of wisdom, it was the age of foolishness.') + `<w:ins w:id="5" w:author="Dana"><w:del w:id="6" w:author="Sam"><w:r><w:delText> Gone.</w:delText></w:r></w:del></w:ins>`) }
    ]);
    assert.deepEqual(r.suggestions.map((s) => [s.kind, s.del, s.ins, s.reviewer]), [['delete', 'best', '', 'Dana'], ['insert', '', 'finest', 'Sam']]);
    assert.equal(r.cancelled, 1);
  });

  test('a paragraph split and two joined are changes to the paragraph mark', () => {
    const split = one([
      { xml: `<w:p><w:pPr><w:rPr><w:ins w:id="1" w:author="Dana"/></w:rPr></w:pPr>${run('It was the best of times,')}</w:p>` },
      { xml: para(run(' it was the worst of times.')) },
      ONE[1]
    ]);
    assert.deepEqual(split.suggestions.map((s) => [s.kind, s.del, s.ins]), [['insert', '', P]]);
    assert.equal(split.suggestions[0].anchor.o, 'It was the best of times,'.length);
    const join = one([{ xml: `<w:p><w:pPr><w:rPr><w:del w:id="1" w:author="Dana"/></w:rPr></w:pPr>${run(ONE[0])}</w:p>` }, ONE[1]]);
    assert.deepEqual(join.suggestions.map((s) => [s.kind, s.del, s.ins]), [['delete', P, '']]);
  });

  test('a move is one suggestion: the words, where from and where to', () => {
    const r = one([
      { xml: para(`<w:moveFromRangeStart w:id="1" w:name="mv" w:author="Dana"/><w:moveFrom w:id="2" w:author="Dana">${'<w:r><w:delText xml:space="preserve">It was the best of times, </w:delText></w:r>'}</w:moveFrom><w:moveFromRangeEnd w:id="1"/>` + run('it was the worst of times.')) },
      { xml: para(run(ONE[1]) + `<w:moveToRangeStart w:id="3" w:name="mv" w:author="Dana"/><w:moveTo w:id="4" w:author="Dana">${run(' It was the best of times, ')}</w:moveTo><w:moveToRangeEnd w:id="3"/>`) }
    ]);
    assert.equal(r.suggestions.length, 1);
    const s = r.suggestions[0];
    assert.equal(s.kind, 'move');
    assert.equal(s.del, 'It was the best of times, ');
    assert.equal(s.anchor.o, 0);
    assert.equal(s.to.p, 1);
    assert.equal(r.counts.Dana.changes, 1);
  });

  test('italics turned on is a formatting suggestion over the words it covers', () => {
    const r = one([{ xml: para(run('It was the ') + `<w:r><w:rPr><w:i/><w:rPrChange w:id="1" w:author="Dana"><w:rPr/></w:rPrChange></w:rPr><w:t>best</w:t></w:r>` + run(' of times, it was the worst of times.')) }, ONE[1]]);
    assert.deepEqual(r.suggestions.map((s) => [s.kind, s.text, s.anchor.exact, s.was, s.now]), [['format', 'best', 'best', { b: false, i: false }, { b: false, i: true }]]);
    assert.equal(r.counts.Dana.formatting, 1);
  });
});

describe('changes made without Track Changes', () => {
  test('the file’s text before its tracked changes, against what was sent', () => {
    const r = M.match(file([{ title: 'Chapter 1', paras: [
      'It was the best of times, it was the very worst of times.',
      { xml: para(run('It was the age of ') + del('wisdom', 1) + ins('reason', 2) + run(', it was the age of foolishness.')) },
      'A new paragraph nobody tracked.'
    ] }]), sent([{ id: 'c1', title: 'Chapter 1', paras: ONE }]), { fallback: 'Dana Editor' });
    assert.deepEqual(r.suggestions.map((s) => [s.kind, s.del, s.ins, !!s.untracked, s.reviewer]), [
      ['replace', 'wisdom', 'reason', false, 'Dana'],
      ['insert', '', 'very ', true, 'Dana Editor'],
      ['insert', '', P + 'A new paragraph nobody tracked.', true, 'Dana Editor']
    ]);
    // an untracked change is anchored in the text as it was sent
    assert.equal(r.suggestions[1].anchor.pre.slice(-8), 'was the ');
    assert.deepEqual(r.counts['Dana Editor'], { changes: 0, comments: 0, untracked: 2, formatting: 0 });
  });

  test('a part’s title, set on its heading, is not taken for a deleted line', () => {
    const m = file([{ title: { xml: run('Part One') + '<w:r><w:br/><w:br/></w:r>' + run('The Golden Thread') }, paras: ['A quote to open the part.'] }]);
    const r = M.match(m, [{ num: 1, id: 'p1', title: 'Part One', kind: 'part', text: ['The Golden Thread', 'A quote to open the part.'].join(P) }]);
    assert.deepEqual(r.suggestions, []);
  });

  test('textHunks: paragraphs matched first, words inside the ones that differ', () => {
    const a = ['Alpha beta gamma.', 'Same here.', 'Delta epsilon.'].join(P);
    const b = ['Alpha BETA gamma.', 'Same here.', 'Delta epsilon zeta.'].join(P);
    assert.deepEqual(M.textHunks(a, b).map(([a0, a1, b0, b1]) => [a.slice(a0, a1), b.slice(b0, b1)]), [['beta', 'BETA'], ['', ' zeta']]);
    assert.deepEqual(M.textHunks(a, a), []);
  });
});

describe('comments into threads', () => {
  test('a thread per first comment, replies in order, resolved, anchored on the words', () => {
    const W14 = 'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"';
    const comments = `<w:comments ${W} ${W14}>` +
      `<w:comment w:id="0" w:author="Dana" w:date="2026-10-09T10:00:00Z"><w:p w14:paraId="00000A01">${run('Too famous?')}</w:p></w:comment>` +
      `<w:comment w:id="1" w:author="Ryan" w:date="2026-10-09T11:00:00Z"><w:p w14:paraId="00000A02">${run('On purpose.')}</w:p></w:comment>` +
      `<w:comment w:id="2" w:author="Dana" w:date="2026-10-09T12:00:00Z"><w:p w14:paraId="00000A03">${run('Fine.')}</w:p></w:comment>` +
      `<w:comment w:id="3" w:author="Dana" w:date="2026-10-09T12:30:00Z"><w:p w14:paraId="00000A04">${run('Lovely title.')}</w:p></w:comment></w:comments>`;
    const ext = `<w15:commentsEx ${W14}><w15:commentEx w15:paraId="00000A01" w15:done="1"/><w15:commentEx w15:paraId="00000A02" w15:paraIdParent="00000A01"/><w15:commentEx w15:paraId="00000A03" w15:paraIdParent="00000A01"/><w15:commentEx w15:paraId="00000A04"/></w15:commentsEx>`;
    const p2 = para(run('It was the age of wisdom, ') + '<w:commentRangeStart w:id="0"/>' + run('it was the age of foolishness') + '<w:commentRangeEnd w:id="0"/>' + run('.') + '<w:r><w:commentReference w:id="0"/></w:r>');
    const title = '<w:commentRangeStart w:id="3"/>' + run('Chapter 1') + '<w:commentRangeEnd w:id="3"/>';
    const m = file([{ title: { xml: title }, paras: [ONE[0], { xml: p2 }] }], { extra: { 'word/comments.xml': comments, 'word/commentsExtended.xml': ext } });
    const r = M.match(m, sent([{ id: 'c1', title: 'Chapter 1', paras: ONE }]));
    assert.equal(r.threads.length, 2);
    const [t, onTitle] = r.threads;
    assert.equal(t.chapter, 'c1');
    assert.equal(t.resolved, true);
    assert.equal(t.anchor.exact, 'it was the age of foolishness');
    assert.equal(t.anchor.p, 1);
    assert.deepEqual(t.comments.map((c) => [c.by, c.text]), [['Dana', 'Too famous?'], ['Ryan', 'On purpose.'], ['Dana', 'Fine.']]);
    assert.deepEqual([onTitle.chapter, onTitle.anchor, onTitle.resolved], ['c1', null, false]);
    assert.deepEqual(r.counts.Dana.comments, 3);
  });

  test('a comment on the title page says so: on no chapter, marked front', () => {
    const comments = `<w:comments ${W}><w:comment w:id="5" w:author="Dana" w:date="2026-10-09T10:00:00Z"><w:p>${run('Better title?')}</w:p></w:comment></w:comments>`;
    const body = para('<w:commentRangeStart w:id="5"/>' + run('A Tale') + '<w:commentRangeEnd w:id="5"/>', '<w:pStyle w:val="Title"/>') + para(run('C. Dickens')) + heading('Chapter 1', 1) + para('') + ONE.map((x) => para(run(x))).join('');
    const m = RD.parse({ 'word/document.xml': `<w:document ${W}><w:body>${body}</w:body></w:document>`, 'word/comments.xml': comments });
    const r = M.match(m, sent([{ id: 'c1', title: 'Chapter 1', paras: ONE }]));
    assert.deepEqual(r.threads.map((th) => [th.chapter, !!th.front, th.comments[0].text]), [[null, true, 'Better title?']]);
  });
});

describe('anchors found again in today’s text', () => {
  const was = ['It was the best of times, it was the worst of times.', 'It was the age of wisdom, it was the age of foolishness.'].join(P);
  const at = (text, word) => M.anchorIn(text, text.indexOf(word), word.length);

  test('after the writer edited elsewhere: a paragraph added before, words changed after', () => {
    const a = at(was, 'wisdom');
    const now = ['A new first paragraph.', 'It was the best of times, it was the worst of times.', 'It was the age of wisdom, it was the age of folly.'].join(P);
    const f = M.findAnchor(now, a);
    assert.equal(now.slice(f.o, f.o + f.len), 'wisdom');
    assert.equal(f.sure, false, 'the words after it changed a little');
  });

  test('the same words twice: the place whose surroundings agree', () => {
    const a = at(was, 'worst');
    const now = 'The worst was yet to come.' + P + was;
    const f = M.findAnchor(now, a);
    assert.equal(f.o, now.indexOf('the worst of times') + 4);
    assert.equal(f.sure, true);
  });

  test('an insertion is placed by the words either side', () => {
    const a = M.anchorIn(was, was.indexOf(' it was the worst'), 0);
    const now = 'Prologue.' + P + was;
    const f = M.findAnchor(now, a);
    assert.equal(f.o, now.indexOf(' it was the worst'));
    assert.equal(f.len, 0);
  });

  test('a passage the writer rewrote is out of date', () => {
    assert.equal(M.findAnchor(was.replace('wisdom', 'learning'), at(was, 'wisdom')), null);
    // a short word with nothing around it that agrees isn't guessed at
    assert.equal(M.findAnchor('The best laid plans.', at(was, 'best')), null);
    assert.equal(M.findAnchor('Nothing alike here.', M.anchorIn(was, 25, 0)), null);
  });
});

describe('threads that come back (a second round)', () => {
  const c = (by, text, paraId = '', more = {}) => Object.assign({ by, at: '2026-10-09T10:00:00Z', text, paraId }, more);
  const known = () => [
    { id: 't1', chapter: 'c1', anchor: { exact: 'hill' }, resolved: false, fileResolved: false, comments: [c('Dana', 'Which hill?', 'AAAA0001'), c('Charles', 'Shooter’s.', '', { mine: true, sent: ['0000B002'] })] },
    { id: 't2', chapter: 'c1', anchor: null, resolved: true, fileResolved: false, comments: [c('Dana', 'Cut this?', 'AAAA0002')] },
    { id: 't3', chapter: 'c2', anchor: null, resolved: false, deleted: true, comments: [c('Dana', 'Too long.', 'AAAA0003')] }
  ];

  test('the same thread by its paragraph ids; a new answer added once; the file’s anchor taken', () => {
    const k = known();
    const back = [
      { chapter: 'c1', anchor: { exact: 'the hill' }, resolved: false, comments: [c('Dana', 'Which hill?', '0000B001'), c('Charles', 'Shooter’s.', '0000B002'), c('Dana', 'Thanks!', '0000B003')] },
      { chapter: 'c2', anchor: null, resolved: false, comments: [c('Sam', 'New one.', '0000B004')] }
    ];
    const r = M.mergeThreads(k, back);
    assert.equal(r.merged, 1);
    assert.deepEqual(r.added.map((t) => t.comments[0].text), ['New one.']);
    assert.deepEqual(r.repeats, { Dana: 1, Charles: 1 });
    assert.deepEqual(k[0].comments.map((x) => x.text), ['Which hill?', 'Shooter’s.', 'Thanks!']);
    assert.deepEqual(k[0].anchor, { exact: 'the hill' });
    assert.ok(k[0].comments[0].sent.includes('0000B001'), 'Word’s new id kept for next time');
    // read again: nothing more
    const again = M.mergeThreads(k, [back[0]]);
    assert.equal(again.merged, 1);
    assert.equal(k[0].comments.length, 3);
  });

  test('by its first comment when the ids are new; resolved as the editor left it, else as the writer did', () => {
    const k = known();
    // t2: resolved by the writer after it went out open; the file still says open
    M.mergeThreads(k, [{ chapter: 'c1', anchor: null, resolved: false, comments: [c('dana', ' Cut  this? ', 'FFFF0001')] }]);
    assert.equal(k[1].resolved, true, 'the writer’s resolve stands');
    // the editor resolves it in the next file
    M.mergeThreads(k, [{ chapter: 'c1', anchor: null, resolved: true, comments: [c('Dana', 'Cut this?', 'FFFF0001')] }]);
    assert.equal(k[1].resolved, true);
    // and reopens it
    M.mergeThreads(k, [{ chapter: 'c1', anchor: null, resolved: false, comments: [c('Dana', 'Cut this?', 'FFFF0001')] }]);
    assert.equal(k[1].resolved, false);
    assert.equal(k[1].comments.length, 1);
  });

  test('the same words on another passage are a new thread: never hidden in a deleted one, never two into one', () => {
    const k = known();
    // "Too long." again, on new words (t3 was deleted by the writer)
    let r = M.mergeThreads(k, [{ chapter: 'c2', anchor: { exact: 'a new passage' }, resolved: false, comments: [c('Dana', 'Too long.', 'EEEE0001')] }]);
    assert.deepEqual([r.merged, r.added.length], [0, 1]);
    assert.equal(k[2].deleted, true);
    // "Cut this?" on other words in another chapter, and twice in one file
    k[1].anchor = { exact: 'the stones' };
    r = M.mergeThreads(k, [
      { chapter: 'c1', anchor: { exact: 'the stones' }, resolved: true, comments: [c('Dana', 'Cut this?', 'EEEE0002')] },
      { chapter: 'c1', anchor: { exact: 'the gulls' }, resolved: false, comments: [c('Dana', 'Cut this?', 'EEEE0003')] },
      { chapter: 'c2', anchor: { exact: 'the stones' }, resolved: false, comments: [c('Dana', 'Cut this?', 'EEEE0004')] }
    ]);
    assert.deepEqual([r.merged, r.added.length], [1, 2]);
    assert.deepEqual(k[1].anchor, { exact: 'the stones' });
  });

  test('a deleted thread that gets an answer comes back; one without stays deleted', () => {
    const k = known();
    M.mergeThreads(k, [{ chapter: 'c2', anchor: null, resolved: false, comments: [c('Dana', 'Too long.', 'AAAA0003')] }]);
    assert.equal(k[2].deleted, true);
    M.mergeThreads(k, [{ chapter: 'c2', anchor: null, resolved: false, comments: [c('Dana', 'Too long.', 'AAAA0003'), c('Dana', 'Still too long.', 'AAAA0009')] }]);
    assert.equal(k[2].deleted, undefined);
    assert.equal(k[2].resolved, false);
  });
});

describe('a file NEO sent with comments, saved again by LibreOffice (an outside tool)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const zlib = require('node:zlib');
  const Z = require('../slog-zip.js');
  const read = () => RD.readDocx(new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'review', 'lo-resaved-comments.docx'))), Z, (b) => zlib.inflateRawSync(b));

  test('its threads read whole, the first comment first, and are the threads that went out', async () => {
    const m = await read();
    const { sections } = M.sectionsOf(m);
    const chapters = sections.map((s, k) => ({ id: 'c' + (k + 1), num: s.num, title: s.title, kind: 'chapter', text: M.streamOf(s).before }));
    const r = M.match(m, chapters);
    const hill = r.threads.find((th) => th.comments[0].text === 'Which hill?');
    assert.ok(hill, JSON.stringify(r.threads.map((th) => th.comments.map((c) => c.text))));
    assert.deepEqual(hill.comments.map((c) => [c.by, c.text]), [['Dana Editor', 'Which hill?'], ['Charles Dickens', 'Shooter’s Hill, near Blackheath.']]);
    assert.equal(hill.anchor.exact, ' up Shooter’s Hill.');
    const lovely = r.threads.find((th) => th.comments[0].text === 'Lovely.');
    assert.deepEqual([lovely.resolved, lovely.anchor.exact], [true, 'the age of wisdom']);
    // the threads as review.json had them when they went out (other ids)
    const known = [
      { id: 't1', resolved: false, fileResolved: false, comments: [{ by: 'Dana Editor', text: 'Which hill?', paraId: '7AAA0001' }, { by: 'Charles Dickens', text: 'Shooter’s Hill, near Blackheath.', mine: true }] },
      { id: 't2', resolved: true, fileResolved: true, comments: [{ by: 'Dana Editor', text: 'Lovely.' }] }
    ];
    const back = M.mergeThreads(known, r.threads);
    assert.deepEqual([back.merged, back.added.length], [2, 0]);
    assert.equal(known[0].comments.length, 2);
  });
});

describe('more than one editor (M6)', () => {
  test('a file passed from one editor to the next: each person’s changes under their name, in the file’s order, at one point side by side', () => {
    const insdel = (t, a, b) => `<w:ins w:id="80" w:author="${a}" w:date="2026-10-09T10:00:00Z"><w:del w:id="81" w:author="${b}" w:date="2026-10-10T10:00:00Z"><w:r><w:delText xml:space="preserve">${t}</w:delText></w:r></w:del></w:ins>`;
    const p1 = para(run('It was the ') + ins('bright ', 70, 'Ann') + insdel('and ', 'Ann', 'Bo') + ins('early ', 71, 'Bo') + run('spring of hope.'));
    const p2 = para(run('The mail ') + del('lumbered', 72, 'Bo') + ins('laboured', 73, 'Bo') + run(' up Shooter’s Hill.'));
    const m = file([{ title: 'Chapter 1', paras: [{ xml: p1 }, { xml: p2 }] }]);
    const r = M.match(m, sent([{ id: 'c1', title: 'Chapter 1', paras: ['It was the spring of hope.', 'The mail lumbered up Shooter’s Hill.'] }]), { fallback: 'Ann' });
    assert.deepEqual(r.suggestions.map((s) => [s.kind, s.reviewer, s.del, s.ins]), [
      ['insert', 'Ann', '', 'bright '],
      ['insert', 'Bo', '', 'early '],
      ['replace', 'Bo', 'lumbered', 'laboured']
    ]);
    assert.equal(r.cancelled, 1, 'Ann’s "and " that Bo took out');
    // the two insertions are at one point; which goes first is the file's order
    assert.equal(r.suggestions[0].anchor.o, r.suggestions[1].anchor.o);
    assert.deepEqual(Object.keys(r.counts).sort(), ['Ann', 'Bo']);
    assert.equal(r.suggestions.filter((s) => s.untracked).length, 0, 'nothing untracked');
  });
});

describe('review.json from two computers at once (mergeReview)', () => {
  const blank = () => ({ v: 1, editors: [], rounds: [], imports: [], reviewers: [], suggestions: [], threads: [] });
  const S = (id, status = 'open') => ({ id, status, del: 'a', ins: 'b' });
  test('each side keeps what it added; a change made here wins, an untouched item takes the file’s', () => {
    const base = Object.assign(blank(), { suggestions: [S('s1'), S('s2')], reviewers: [{ name: 'Dana', num: 1 }] });
    const local = JSON.parse(JSON.stringify(base));
    local.suggestions[0].status = 'accepted'; // accepted here
    const remote = JSON.parse(JSON.stringify(base));
    remote.suggestions[1].status = 'rejected'; // rejected there
    remote.suggestions.push(S('s3')); // an import there
    remote.rounds.push({ id: 'r1', to: 'Lee' });
    remote.editors = ['Lee'];
    const m = M.mergeReview(base, local, remote);
    assert.deepEqual(m.suggestions.map((s) => [s.id, s.status]), [['s1', 'accepted'], ['s2', 'rejected'], ['s3', 'open']]);
    assert.deepEqual(m.rounds.map((r) => r.id), ['r1']);
    assert.deepEqual(m.editors, ['Lee']);
  });
  test('undone here stays undone; a thread keeps both sides’ comments', () => {
    const th = { id: 't1', comments: [{ by: 'Dana', at: '1', text: 'Hm?', paraId: 'A1' }] };
    const base = Object.assign(blank(), { suggestions: [S('s1', 'accepted')], threads: [th] });
    const local = JSON.parse(JSON.stringify(base));
    local.suggestions[0].status = 'open'; // Ctrl+Z here
    local.threads[0].comments.push({ by: 'Me', at: '2', text: 'Yes.', mine: true });
    const remote = JSON.parse(JSON.stringify(base));
    remote.threads[0].comments.push({ by: 'Dana', at: '3', text: 'And?', paraId: 'A2' });
    const m = M.mergeReview(base, local, remote);
    assert.equal(m.suggestions[0].status, 'open');
    assert.deepEqual(m.threads[0].comments.map((c) => c.text), ['Hm?', 'Yes.', 'And?']);
  });
  test('two editors given one number on two computers are numbered apart, the same way on both', () => {
    const base = blank();
    const a = Object.assign(blank(), { reviewers: [{ name: 'Dana', num: 1 }] });
    const b = Object.assign(blank(), { reviewers: [{ name: 'Lee', num: 1 }] });
    const onA = M.mergeReview(base, a, b).reviewers;
    const onB = M.mergeReview(base, b, a).reviewers;
    const nums = (list) => Object.fromEntries(list.map((r) => [r.name, r.num]));
    assert.deepEqual(nums(onA), { Dana: 1, Lee: 2 });
    assert.deepEqual(nums(onB), nums(onA));
  });
});

describe('a paragraph moved in Word', () => {
  test('one move, the paragraph whole: its own marks go with it, never a ¶ of their own', () => {
    const A = (id) => `w:id="${id}" w:author="Dana" w:date="2026-10-09T10:00:00Z"`;
    const moved = 'Mr. Williams shakes his head.';
    const to = { xml: `<w:p><w:pPr><w:rPr><w:moveTo ${A(1)}/></w:rPr></w:pPr><w:moveToRangeStart ${A(2)} w:name="move1"/><w:moveTo ${A(3)}>${run(moved)}</w:moveTo><w:moveToRangeEnd w:id="2"/></w:p>` };
    const from = { xml: `<w:p><w:pPr><w:rPr><w:moveFrom ${A(4)}/></w:rPr></w:pPr><w:moveFromRangeStart ${A(5)} w:name="move1"/><w:moveFrom ${A(6)}><w:r><w:delText xml:space="preserve">${moved}</w:delText></w:r></w:moveFrom><w:moveFromRangeEnd w:id="5"/></w:p>` };
    const paras = ['“I wish I knew.”', 'Sam just nods.', moved, 'The last line.'];
    const m = file([{ title: 'Chapter 1', paras: [paras[0], to, paras[1], from, paras[3]] }]);
    const r = M.match(m, sent([{ id: 'c1', title: 'Chapter 1', paras }]), { fallback: 'Dana' });
    assert.deepEqual(r.suggestions.map((s) => [s.kind, s.del, s.ins, !!s.untracked]), [['move', moved + P, moved + P, false]]);
    const s = r.suggestions[0];
    const text = paras.join(P);
    const f = M.findAnchor(text, s.anchor);
    const t = M.findAnchor(text, s.to);
    assert.ok(f && t);
    // applied: taken out, then put in where it went
    const out = text.slice(0, f.o) + text.slice(f.o + f.len);
    const at = t.o < f.o ? t.o : t.o - f.len;
    assert.equal(out.slice(0, at) + s.ins + out.slice(at), [paras[0], moved, paras[1], paras[3]].join(P));
  });

  const A = (id) => `w:id="${id}" w:author="Dana" w:date="2026-10-09T10:00:00Z"`;
  const toP = (t) => ({ xml: `<w:p><w:pPr><w:rPr><w:moveTo ${A(1)}/></w:rPr></w:pPr><w:moveToRangeStart ${A(2)} w:name="move1"/><w:moveTo ${A(3)}>${run(t)}</w:moveTo><w:moveToRangeEnd w:id="2"/></w:p>` });
  const fromP = (t) => ({ xml: `<w:p><w:pPr><w:rPr><w:moveFrom ${A(4)}/></w:rPr></w:pPr><w:moveFromRangeStart ${A(5)} w:name="move1"/><w:moveFrom ${A(6)}><w:r><w:delText xml:space="preserve">${t}</w:delText></w:r></w:moveFrom><w:moveFromRangeEnd w:id="5"/></w:p>` });
  const apply = (text, s) => {
    const f = M.findAnchor(text, s.anchor);
    const t = M.findAnchor(text, s.to);
    assert.ok(f && t, 'both ends found');
    const out = text.slice(0, f.o) + text.slice(f.o + f.len);
    const at = t.o < f.o ? t.o : t.o - f.len;
    return out.slice(0, at) + s.ins + out.slice(at);
  };
  test('to the end of a chapter, and from it: still a paragraph of its own, nothing run together', () => {
    const paras = ['One.', 'Two.', 'Three.'];
    let m = file([{ title: 'Chapter 1', paras: [paras[0], fromP('Two.'), paras[2], toP('Two.')] }]);
    let r = M.match(m, sent([{ id: 'c1', title: 'Chapter 1', paras }]), { fallback: 'Dana' });
    assert.deepEqual(r.suggestions.map((s) => s.kind), ['move']);
    assert.equal(apply(paras.join(P), r.suggestions[0]), ['One.', 'Three.', 'Two.'].join(P));
    m = file([{ title: 'Chapter 1', paras: [toP('Three.'), paras[0], paras[1], fromP('Three.')] }]);
    r = M.match(m, sent([{ id: 'c1', title: 'Chapter 1', paras }]), { fallback: 'Dana' });
    assert.deepEqual(r.suggestions.map((s) => s.kind), ['move']);
    assert.equal(apply(paras.join(P), r.suggestions[0]), ['Three.', 'One.', 'Two.'].join(P));
  });
  test('a paragraph added at the end of a chapter is its own paragraph, and nothing else changed', () => {
    const paras = ['One.', 'Two.'];
    const added = { xml: `<w:p><w:pPr><w:rPr><w:ins ${A(7)}/></w:rPr></w:pPr>${ins('Three.', 8)}</w:p>` };
    const m = file([{ title: 'Chapter 1', paras: [...paras, added] }, { title: 'Chapter 2', paras: ['Next.'] }]);
    const r = M.match(m, sent([{ id: 'c1', title: 'Chapter 1', paras }, { id: 'c2', title: 'Chapter 2', paras: ['Next.'] }]), { fallback: 'Dana' });
    assert.deepEqual(r.suggestions.map((s) => [s.kind, s.ins, !!s.untracked]), [['insert', P + 'Three.', false]]);
    const text = paras.join(P);
    const f = M.findAnchor(text, r.suggestions[0].anchor);
    assert.equal(text.slice(0, f.o) + r.suggestions[0].ins + text.slice(f.o), ['One.', 'Two.', 'Three.'].join(P));
  });
});

describe('the right book', () => {
  test('overlap: an edited copy shares most of its passages with its book, another book by the same writer next to none', () => {
    const mine = ['It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness.', 'It was the epoch of belief, it was the epoch of incredulity, it was the season of Light, it was the season of Darkness.'];
    const other = ['The harbor was quiet before the storm and the gulls wheeled over the empty slips while the boats rocked.', 'Mara counted the boats twice and found that one of them was missing from the end of the pier.'];
    const edited = file([{ title: 'Chapter 1', paras: [mine[0].replace('wisdom', 'insight'), mine[1]] }]);
    assert.ok(M.overlap(edited, sent([{ id: 'c1', title: 'Chapter 1', paras: mine }])) > 0.6);
    assert.ok(M.overlap(edited, sent([{ id: 'c1', title: 'Chapter 1', paras: other }])) < 0.05);
    assert.equal(M.overlap(file([{ title: 'Chapter 1', paras: ['Too short.'] }]), sent([{ id: 'c1', title: 'Chapter 1', paras: other }])), null, 'too short to tell');
  });
});
