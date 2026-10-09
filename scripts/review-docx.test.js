'use strict';

// Reading an editor's Word file (review-docx.js, phase 6): tracked changes,
// comments, replies and resolved threads, on hand-written OOXML covering
// each kind of markup, and on a file LibreOffice wrote with change tracking
// (scripts/fixtures/review/lo-tracked.docx, made from lo-tracked.fodt by
// `soffice --headless --convert-to docx`, an outside tool, like
// screenplain's .fdx).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { describe, test } = require('node:test');
const R = require('../review-docx.js');
const Z = require('../slog-zip.js');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"';
const doc = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`;
const run = (t, rpr = '') => `<w:r>${rpr ? '<w:rPr>' + rpr + '</w:rPr>' : ''}<w:t xml:space="preserve">${t}</w:t></w:r>`;
const delRun = (t, rpr = '') => `<w:r>${rpr ? '<w:rPr>' + rpr + '</w:rPr>' : ''}<w:delText xml:space="preserve">${t}</w:delText></w:r>`;
const who = (id, author = 'Dana', date = '2026-10-01T10:00:00Z') => `w:id="${id}" w:author="${author}" w:date="${date}"`;
const parse = (body, more = {}) => R.parse(Object.assign({ 'word/document.xml': doc(body) }, more));

describe('the tokenizer', () => {
  test('reads elements, attributes in either quote, entities, CDATA and comments', () => {
    const toks = R.tokens(`<?xml version="1.0"?><!-- a > b --><w:p ${W} w14:paraId='0A1B'><w:t>a &amp; b &lt;c&gt; &#x2014; &#233;</w:t><x a="1 &gt; 0"/><![CDATA[<raw>]]></w:p>`);
    assert.deepEqual(toks.map((t) => t.t === 'text' ? t.text : t.t + ':' + t.name), ['open:w:p', 'open:w:t', 'a & b <c> — é', 'close:w:t', 'open:x', '<raw>', 'close:w:p']);
    assert.equal(toks[0].attrs['w14:paraId'], '0A1B');
    assert.equal(toks[4].attrs.a, '1 > 0');
    assert.equal(toks[4].empty, true);
  });

  test('names follow the namespace, whatever prefix the file chose', () => {
    const toks = R.tokens('<x:p xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><x:r/></x:p><p xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><r/></p>');
    assert.deepEqual(toks.map((t) => t.name), ['w:p', 'w:r', 'w:p', 'w:p', 'w:r', 'w:p']);
  });

  test('a > inside an attribute does not end the tag', () => {
    const toks = R.tokens('<w:t a="x>y" b=\'p>q\'>hi</w:t>');
    assert.equal(toks[0].attrs.a, 'x>y');
    assert.equal(toks[0].attrs.b, 'p>q');
    assert.equal(toks[1].text, 'hi');
  });
});

describe('tracked changes', () => {
  test('an insertion and a deletion give the two texts and their pieces', () => {
    const m = parse(`<w:p w14:paraId="11111111">${run('It was ')}<w:del ${who(1)}>${delRun('very ')}</w:del>${run('late')}<w:ins ${who(2)}>${run(' at night')}</w:ins>${run('.')}</w:p>`);
    const p = m.paragraphs[0];
    assert.equal(p.paraId, '11111111');
    assert.equal(p.before, 'It was very late.');
    assert.equal(p.after, 'It was late at night.');
    assert.deepEqual(p.segs.map((s) => [s.text, s.ins, s.del, s.a, s.o]), [
      ['It was ', -1, -1, 0, 0], ['very ', -1, 0, 7, 7], ['late', -1, -1, 7, 12], [' at night', 1, -1, 11, 16], ['.', -1, -1, 20, 16]
    ]);
    assert.deepEqual(m.changes.map((c) => [c.type, c.wid, c.author, c.date, c.p]), [
      ['del', '1', 'Dana', '2026-10-01T10:00:00Z', 0], ['ins', '2', 'Dana', '2026-10-01T10:00:00Z', 0]
    ]);
  });

  test('one wrapper over several runs is one change; an empty wrapper is none', () => {
    const m = parse(`<w:p><w:ins ${who(1)}>${run('one ')}${run('two', '<w:i/>')}</w:ins><w:del ${who(2)}></w:del></w:p>`);
    assert.equal(m.changes.length, 1);
    assert.deepEqual(m.paragraphs[0].segs.map((s) => [s.text, s.ins, s.i]), [['one ', 0, false], ['two', 0, true]]);
  });

  test('one editor deleting what another inserted: in neither text, both changes kept', () => {
    const m = parse(`<w:p>${run('A')}<w:ins ${who(1, 'Dana')}><w:del ${who(2, 'Sam', '2026-10-03T08:00:00Z')}>${delRun('B')}</w:del></w:ins>${run('C')}</w:p>`);
    const p = m.paragraphs[0];
    assert.equal(p.before, 'AC');
    assert.equal(p.after, 'AC');
    const b = p.segs.find((s) => s.text === 'B');
    assert.equal(m.changes[b.ins].author, 'Dana');
    assert.equal(m.changes[b.del].author, 'Sam');
    assert.equal(R.summary(m).authors.Sam.changes, 1);
  });

  test('tabs, line breaks, no-break hyphens and symbols are text; page breaks and field codes are not', () => {
    const m = parse(`<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t><w:noBreakHyphen/><w:t>d</w:t><w:br w:type="page"/><w:sym w:font="Symbol" w:char="F061"/></w:r>` +
      `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>7</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`);
    assert.equal(m.paragraphs[0].after, 'a\tb\nc‑da7');
  });

  test("Word's own wrappers: hyperlinks, content controls, smart tags, simple fields, proofing marks", () => {
    const m = parse(`<w:p w:rsidR="00A1" w:rsidRDefault="00A1"><w:pPr><w:rPr><w:b/><w:rPrChange ${who(1)}><w:rPr/></w:rPrChange></w:rPr></w:pPr><w:proofErr w:type="spellStart"/>${run('Wrod')}<w:proofErr w:type="spellEnd"/>` +
      `<w:hyperlink r:id="rId5" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:ins ${who(2)}>${run(' link')}</w:ins></w:hyperlink>` +
      `<w:sdt><w:sdtPr/><w:sdtContent>${run(' sdt')}</w:sdtContent></w:sdt><w:smartTag w:uri="x" w:element="place">${run(' Paris')}</w:smartTag>` +
      `<w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>9</w:t></w:r></w:fldSimple><w:r><w:lastRenderedPageBreak/><w:t/></w:r><w:bookmarkEnd w:id="0"/></w:p>`);
    const p = m.paragraphs[0];
    assert.equal(p.after, 'Wrod link sdt Paris9');
    assert.equal(p.before, 'Wrod sdt Paris9');
    // the paragraph mark's own formatting change is not a change to the text
    assert.deepEqual(m.changes.map((c) => c.type), ['ins']);
  });

  test('a page break alone in a paragraph marks it, and text boxes and footnotes stay out (counted)', () => {
    const m = parse(`<w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p>${run('Body')}<w:r><w:drawing><w:txbxContent><w:p>${run('BOX')}</w:p></w:txbxContent></w:drawing></w:r>` +
      `<w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="wps"><w:drawing/></mc:Choice><mc:Fallback><w:pict><w:txbxContent><w:p>${run('OLD')}</w:p></w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r>` +
      `<w:r><w:footnoteReference w:id="1"/></w:r>${run(' text')}</w:p>`);
    assert.equal(m.paragraphs.length, 2);
    assert.equal(m.paragraphs[0].pageBreak, true);
    assert.equal(m.paragraphs[1].after, 'Body text');
    assert.equal(m.notes.footnotes, 1);
    assert.equal(m.notes.textBoxes, 1);
  });

  test('a paragraph mark inserted splits a paragraph; one deleted joins two', () => {
    const split = parse(`<w:p><w:pPr><w:rPr><w:ins ${who(1)}/></w:rPr></w:pPr>${run('First half.')}</w:p><w:p>${run(' Second half.')}</w:p>`);
    assert.equal(split.paragraphs[0].mark.ins, 0);
    assert.equal(split.changes[0].type, 'markIns');
    assert.deepEqual(R.joined(split, 'before').map((p) => p.text), ['First half. Second half.']);
    assert.deepEqual(R.joined(split, 'after').map((p) => p.text), ['First half.', ' Second half.']);

    const join = parse(`<w:p><w:pPr><w:rPr><w:del ${who(1)}/></w:rPr></w:pPr>${run('One.')}<w:ins ${who(2)}>${run(' ')}</w:ins></w:p><w:p>${run('Two.')}</w:p><w:p>${run('Three.')}</w:p>`);
    assert.deepEqual(R.joined(join, 'after').map((p) => [p.text, p.from]), [['One. Two.', [0, 1]], ['Three.', [2]]]);
    assert.deepEqual(R.joined(join, 'before').map((p) => p.text), ['One.', 'Two.', 'Three.']);
  });

  test('a whole paragraph inserted or deleted leaves no line on the other side', () => {
    const m = parse(`<w:p>${run('Kept.')}</w:p><w:p><w:pPr><w:rPr><w:ins ${who(1)}/></w:rPr></w:pPr><w:ins ${who(2)}>${run('New paragraph.')}</w:ins></w:p>` +
      `<w:p><w:pPr><w:rPr><w:del ${who(3)}/></w:rPr></w:pPr><w:del ${who(4)}>${delRun('Gone paragraph.')}</w:del></w:p><w:p>${run('End.')}</w:p>`);
    assert.deepEqual(R.joined(m, 'after').map((p) => p.text), ['Kept.', 'New paragraph.', 'End.']);
    assert.deepEqual(R.joined(m, 'before').map((p) => p.text), ['Kept.', 'Gone paragraph.', 'End.']);
  });

  test('a move is one move: its from and to share a name, and counts once', () => {
    const m = parse(`<w:p><w:moveFromRangeStart w:id="10" w:name="move1" w:author="Dana" w:date="2026-10-01T10:00:00Z"/><w:moveFrom ${who(11)}>${delRun('Moved words. ')}</w:moveFrom><w:moveFromRangeEnd w:id="10"/>${run('Stays.')}</w:p>` +
      `<w:p>${run('Here: ')}<w:moveToRangeStart w:id="12" w:name="move1" w:author="Dana" w:date="2026-10-01T10:00:00Z"/><w:moveTo ${who(13)}>${run('Moved words. ')}</w:moveTo><w:moveToRangeEnd w:id="12"/></w:p>`);
    assert.equal(m.paragraphs[0].before, 'Moved words. Stays.');
    assert.equal(m.paragraphs[0].after, 'Stays.');
    assert.equal(m.paragraphs[1].after, 'Here: Moved words. ');
    assert.deepEqual(m.moves, [{ name: 'move1', from: [0], to: [1] }]);
    assert.deepEqual(m.changes.map((c) => [c.type, c.move]), [['moveFrom', 'move1'], ['moveTo', 'move1']]);
    const s = R.summary(m);
    assert.equal(s.changes, 1);
    assert.equal(s.moves, 1);
  });

  test('a move range that spans paragraphs names every piece in it', () => {
    const m = parse(`<w:p><w:moveFromRangeStart w:id="1" w:name="m" w:author="D"/><w:moveFrom ${who(2)}>${delRun('A')}</w:moveFrom></w:p><w:p><w:moveFrom ${who(3)}>${delRun('B')}</w:moveFrom><w:moveFromRangeEnd w:id="1"/></w:p>` +
      `<w:p><w:moveToRangeStart w:id="4" w:name="m" w:author="D"/><w:moveTo ${who(5)}>${run('A')}</w:moveTo></w:p><w:p><w:moveTo ${who(6)}>${run('B')}</w:moveTo><w:moveToRangeEnd w:id="4"/></w:p>`);
    assert.deepEqual(m.moves, [{ name: 'm', from: [0, 1], to: [2, 3] }]);
  });
});

describe('formatting', () => {
  const styles = `<w:styles ${W}><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
    `<w:style w:type="paragraph" w:styleId="berschrift1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style>` +
    `<w:style w:type="character" w:styleId="Emph"><w:name w:val="Emphasis"/><w:rPr><w:i/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:pPr><w:rPr><w:b/></w:rPr></w:pPr><w:rPr><w:i/></w:rPr></w:style></w:styles>`;

  test('bold and italic come from the run, its character style, then its paragraph style', () => {
    const m = parse(`<w:p><w:pPr><w:pStyle w:val="berschrift1"/></w:pPr>${run('Title')}</w:p><w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr>${run('q')}${run('r', '<w:i w:val="0"/>')}</w:p><w:p>${run('e', '<w:rStyle w:val="Emph"/>')}${run('n')}</w:p>`, { 'word/styles.xml': styles });
    const [h, q, e] = m.paragraphs;
    assert.equal(h.heading, true);
    assert.equal(h.styleName, 'heading 1');
    assert.deepEqual(h.segs.map((s) => [s.b, s.i]), [[true, false]]);
    // the paragraph mark's own bold (pPr/rPr) is not the text's
    assert.deepEqual(q.segs.map((s) => [s.text, s.b, s.i]), [['q', false, true], ['r', false, false]]);
    assert.deepEqual(e.segs.map((s) => [s.text, s.i]), [['e', true], ['n', false]]);
  });

  test('italics turned on or off is a format change, with what it was', () => {
    const m = parse(`<w:p>${run('plain ')}${run('now italic', `<w:i/><w:rPrChange ${who(5)}><w:rPr/></w:rPrChange>`)}${run(' was bold', `<w:rPrChange ${who(6)}><w:rPr><w:b/></w:rPr></w:rPrChange>`)}</w:p>`);
    const p = m.paragraphs[0];
    assert.equal(p.after, 'plain now italic was bold');
    assert.equal(p.before, p.after);
    assert.deepEqual(m.changes.map((c) => [c.type, c.was, c.now]), [
      ['format', { b: false, i: false }, { b: false, i: true }],
      ['format', { b: true, i: false }, { b: false, i: false }]
    ]);
    assert.deepEqual(p.segs.map((s) => s.fmt), [-1, 0, 1]);
    assert.equal(R.summary(m).formatting, 2);
    assert.equal(R.summary(m).changes, 0);
  });

  test("a format change's old properties don't leak into the run (nested rPr)", () => {
    const m = parse(`<w:p>${run('x', `<w:b/><w:rPrChange ${who(1)}><w:rPr><w:i/></w:rPr></w:rPrChange>`)}${run('y')}</w:p>`);
    assert.deepEqual(m.paragraphs[0].segs.map((s) => [s.text, s.b, s.i]), [['x', true, false], ['y', false, false]]);
    assert.deepEqual(m.changes[0].was, { b: false, i: true });
  });

  test('a paragraph formatting change is noted, and its old pPr does not change the style', () => {
    const m = parse(`<w:p><w:pPr><w:pStyle w:val="berschrift1"/><w:pPrChange ${who(1)}><w:pPr><w:pStyle w:val="Normal"/></w:pPr></w:pPrChange></w:pPr>${run('Heading now')}</w:p>`, { 'word/styles.xml': styles });
    const p = m.paragraphs[0];
    assert.equal(p.style, 'berschrift1');
    assert.equal(p.heading, true);
    assert.equal(m.changes[p.pfmt].type, 'para');
  });

  test('a run deleted while its formatting changed keeps both', () => {
    const m = parse(`<w:p><w:del ${who(1)}>${delRun('gone', `<w:i/><w:rPrChange ${who(2)}><w:rPr/></w:rPrChange>`)}</w:del></w:p>`);
    const s = m.paragraphs[0].segs[0];
    assert.equal(m.changes[s.del].type, 'del');
    assert.equal(m.changes[s.fmt].type, 'format');
  });
});

describe('comments', () => {
  const comments = `<w:comments ${W}>` +
    `<w:comment w:id="0" w:author="Dana" w:initials="D" w:date="2026-10-01T11:00:00Z"><w:p w14:paraId="AAAA0001"><w:r><w:annotationRef/></w:r>${run('Is this too famous?')}</w:p></w:comment>` +
    `<w:comment w:id="1" w:author="Ryan" w:initials="R" w:date="2026-10-02T09:00:00Z"><w:p w14:paraId="AAAA0002">${run('It is meant to be.')}</w:p><w:p w14:paraId="AAAA0003">${run('Second line, ')}${run('italic', '<w:i/>')}</w:p></w:comment>` +
    `<w:comment w:id="2" w:author="Dana" w:date="2026-10-01T11:30:00Z"><w:p w14:paraId="AAAA0004">${run('Fixed the comma.')}</w:p></w:comment>` +
    `</w:comments>`;
  const ext = `<w15:commentsEx ${W}><w15:commentEx w15:paraId="AAAA0001" w15:done="0"/><w15:commentEx w15:paraId="AAAA0003" w15:paraIdParent="AAAA0001" w15:done="0"/><w15:commentEx w15:paraId="AAAA0004" w15:done="1"/></w15:commentsEx>`;
  const ids = '<w16cid:commentsIds xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid"><w16cid:commentId w16cid:paraId="AAAA0001" w16cid:durableId="1D2E3F40"/></w16cid:commentsIds>';
  const cex = '<w16cex:commentsExtensible xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex"><w16cex:commentExtensible w16cex:durableId="1D2E3F40" w16cex:dateUtc="2026-10-01T18:00:00Z"/></w16cex:commentsExtensible>';
  const people = `<w15:people ${W}><w15:person w15:author="Dana"><w15:presenceInfo w15:providerId="None" w15:userId="Dana"/></w15:person><w15:person w15:author="Ryan"/></w15:people>`;
  const body = `<w:p>${run('It was ')}<w:commentRangeStart w:id="0"/><w:commentRangeStart w:id="1"/>${run('the best')}<w:ins ${who(9)}>${run(' of all')}</w:ins>${run(' of times')}<w:commentRangeEnd w:id="0"/><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="0"/></w:r><w:r><w:commentReference w:id="1"/></w:r>${run('.')}</w:p>` +
    `<w:commentRangeStart w:id="2"/><w:p>${run('Second, paragraph.')}</w:p><w:p>${run('Third')}<w:commentRangeEnd w:id="2"/><w:r><w:commentReference w:id="2"/></w:r></w:p>`;
  const m = parse(body, { 'word/comments.xml': comments, 'word/commentsExtended.xml': ext, 'word/commentsIds.xml': ids, 'word/commentsExtensible.xml': cex, 'word/people.xml': people });

  test('each comment with its text, author, dates and range in both texts', () => {
    const c = m.comments[0];
    assert.equal(c.text, 'Is this too famous?');
    assert.equal(c.author, 'Dana');
    assert.equal(c.initials, 'D');
    assert.equal(c.date, '2026-10-01T11:00:00Z');
    assert.equal(c.dateUtc, '2026-10-01T18:00:00Z');
    assert.equal(c.durableId, '1D2E3F40');
    const p = m.paragraphs[0];
    assert.equal(p.after.slice(c.start.a, c.end.a), 'the best of all of times');
    assert.equal(p.before.slice(c.start.o, c.end.o), 'the best of times');
    assert.deepEqual([c.start.p, c.end.p], [0, 0]);
  });

  test('a reply knows the comment it answers; a resolved one says so', () => {
    assert.equal(m.comments[1].parent, '0');
    assert.equal(m.comments[1].text, 'It is meant to be.\nSecond line, italic');
    assert.equal(m.comments[1].paraId, 'AAAA0003');
    assert.equal(m.comments[0].parent, null);
    assert.equal(m.comments[2].done, true);
    assert.equal(m.comments[0].done, false);
  });

  test('a range that starts between paragraphs starts the next one; ranges cross paragraphs', () => {
    const c = m.comments[2];
    assert.deepEqual(c.start, { p: 1, a: 0, o: 0 });
    assert.deepEqual(c.end, { p: 2, a: 5, o: 5 });
  });

  test('people.xml, and the summary by author', () => {
    assert.deepEqual(m.people, { Dana: { providerId: 'None', userId: 'Dana' }, Ryan: { providerId: '', userId: '' } });
    const s = R.summary(m);
    assert.deepEqual(s.authors.Dana, { changes: 1, comments: 2, formatting: 0 });
    assert.deepEqual(s.authors.Ryan, { changes: 0, comments: 1, formatting: 0 });
    assert.equal(s.comments, 3);
  });

  test('a file with no comment parts has none', () => {
    assert.deepEqual(parse(`<w:p>${run('x')}</w:p>`).comments, []);
  });
});

describe('the file as a whole', () => {
  test("NEO's round id from docProps/custom.xml, and bookmarks where chapters start", () => {
    const custom = '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="NEO.ReviewRound"><vt:lpwstr>r-20261009-ab12</vt:lpwstr></property></Properties>';
    const m = parse(`<w:bookmarkStart w:id="0" w:name="_NEO_ch_1"/><w:p>${run('Chapter One')}</w:p><w:bookmarkEnd w:id="0"/><w:p>${run('Text ')}<w:bookmarkStart w:id="1" w:name="mid"/>${run('more')}<w:bookmarkStart w:id="2" w:name="_GoBack"/></w:p>`, { 'docProps/custom.xml': custom });
    assert.equal(m.round, 'r-20261009-ab12');
    assert.deepEqual(m.paragraphs[0].bookmarks, [{ name: '_NEO_ch_1', a: 0, o: 0 }]);
    assert.deepEqual(m.paragraphs[1].bookmarks, [{ name: 'mid', a: 5, o: 5 }]);
  });

  test('paragraphs in a table are read in order; a table change is counted', () => {
    const m = parse(`<w:tbl><w:tr><w:trPr><w:ins ${who(1)}/></w:trPr><w:tc><w:tcPr><w:cellIns ${who(2)}/></w:tcPr><w:p>${run('cell')}</w:p></w:tc></w:tr></w:tbl><w:p>${run('after')}</w:p>`);
    assert.deepEqual(m.paragraphs.map((p) => p.after), ['cell', 'after']);
    assert.equal(m.notes.tableChanges, 1);
    assert.equal(m.changes.length, 0);
  });

  test('no document part is an error', () => {
    assert.throws(() => R.parse({}), /no word\/document\.xml/);
  });

  test('a file LibreOffice wrote with change tracking', async () => {
    const bytes = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures/review/lo-tracked.docx')));
    const m = await R.readDocx(bytes, Z, (b) => zlib.inflateRawSync(b));
    assert.deepEqual(m.problems, []);
    assert.deepEqual(m.paragraphs.map((p) => p.after), [
      'Chapter One',
      'It was the best of times, it was the worst of times. And so it went.',
      'It was the age of wisdom.',
      'It was the epoch of belief.'
    ]);
    assert.equal(m.paragraphs[1].before, 'It was the best of times, it was the very worst of times.');
    assert.equal(m.paragraphs[2].before, 'It was the age of wisdom.It was the age of foolishness.');
    assert.equal(m.paragraphs[0].heading, true);
    assert.deepEqual(m.changes.map((c) => [c.type, c.author]), [['del', 'Dana Editor'], ['ins', 'Dana Editor'], ['del', 'Sam Proofreader']]);
    assert.equal(m.comments.length, 1);
    assert.equal(m.comments[0].text, 'Is this too famous?');
    const c = m.comments[0];
    assert.equal(m.paragraphs[c.start.p].after.slice(c.start.a, c.end.a), 'It was the epoch of belief.');
    assert.deepEqual(R.summary(m).authors['Sam Proofreader'], { changes: 1, comments: 0, formatting: 0 });
  });

  test('readDocx works with the zip reader NEO writes (a round trip through SlogZip)', async () => {
    const bytes = Z.zip([{ name: 'word/document.xml', data: doc(`<w:p><w:ins ${who(1)}>${run('Hello')}</w:ins></w:p>`) }], { deflateRawSync: (b) => zlib.deflateRawSync(b) });
    const m = await R.readDocx(bytes, Z, (b) => zlib.inflateRawSync(b));
    assert.equal(m.paragraphs[0].after, 'Hello');
    assert.equal(m.paragraphs[0].before, '');
  });
});

describe('sending (a file for an editor)', () => {
  const entries = () => [
    { path: '[Content_Types].xml', content: '<?xml version="1.0"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n<Override PartName="/word/document.xml" ContentType="x"/>\n</Types>' },
    { path: '_rels/.rels', content: '<?xml version="1.0"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n<Relationship Id="rId1" Type="t" Target="word/document.xml"/>\n</Relationships>' },
    { path: 'word/_rels/document.xml.rels', content: '<?xml version="1.0"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n<Relationship Id="rId1" Type="s" Target="styles.xml"/>\n</Relationships>' },
    { path: 'word/document.xml', content: '<?xml version="1.0"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      R.withBookmark('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>One</w:t></w:r></w:p>', 1, R.chapterMark(1)) +
      '<w:p><w:pPr></w:pPr><w:r><w:t>Text.</w:t></w:r></w:p>' + R.withBookmark('<w:p><w:r><w:t>Two</w:t></w:r></w:p>', 2, R.chapterMark(2)) + '</w:body></w:document>' }
  ];

  test('a round id is the day and six hex digits', () => {
    assert.equal(R.roundId(Date.UTC(2026, 9, 9, 23), 0.5), 'r20261009-800000');
    assert.match(R.roundId(Date.now()), /^r\d{8}-[0-9a-f]{6}$/);
  });

  test('paragraph ids count up below 0x80000000 and wrap past zero', () => {
    const next = R.paraIds(0x7FFFFFFD);
    assert.deepEqual([next(), next(), next()], ['7FFFFFFE', '00000001', '00000002']);
  });

  test('forReview: ids on every paragraph, the round, Track Changes on; the parts named; the input untouched', async () => {
    const before = entries();
    const out = R.forReview(before, { round: 'r20261009-abcdef', start: 0x100 });
    assert.equal(before.length, 4, 'not changed in place');
    assert.ok(!before[3].content.includes('paraId'));
    const parts = {};
    for (const e of out) parts[e.path] = e.content;
    assert.match(parts['word/settings.xml'], /<w:trackRevisions\/>/);
    assert.match(parts['[Content_Types].xml'], /PartName="\/word\/settings.xml"/);
    assert.match(parts['[Content_Types].xml'], /PartName="\/docProps\/custom.xml"/);
    assert.match(parts['word/_rels/document.xml.rels'], /Id="rId2" Type="[^"]+\/settings" Target="settings.xml"/);
    assert.match(parts['_rels/.rels'], /Id="rId2" Type="[^"]+\/custom-properties" Target="docProps\/custom.xml"/);
    const m = R.parse(parts);
    assert.equal(m.round, 'r20261009-abcdef');
    assert.deepEqual(m.paragraphs.map((p) => p.paraId), ['00000101', '00000102', '00000103']);
    assert.deepEqual(m.paragraphs.map((p) => p.bookmarks.map((b) => b.name)), [['_NEO_ch_1'], [], ['_NEO_ch_2']]);
    assert.equal(m.paragraphs[0].heading, true);
    // and it zips and reads back
    const bytes = Z.zip(out.map((e) => ({ name: e.path, data: e.content })), { deflateRawSync: (b) => zlib.deflateRawSync(b) });
    assert.equal((await R.readDocx(bytes, Z, (b) => zlib.inflateRawSync(b))).round, 'r20261009-abcdef');
  });

  // NEO's own runs: bold in the middle, a line break, a character that's escaped
  const sendDoc = () => {
    const e = entries();
    e[3].content = '<?xml version="1.0"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      R.withBookmark('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>One</w:t></w:r></w:p>', 1, R.chapterMark(1)) +
      '<w:p><w:pPr></w:pPr><w:r><w:t xml:space="preserve">It was the </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">best &amp; worst</w:t></w:r><w:r><w:t xml:space="preserve"> of times,</w:t><w:br/><w:t xml:space="preserve">said he.</w:t></w:r></w:p>' +
      '<w:p/><w:p><w:r><w:t xml:space="preserve">Last line.</w:t></w:r></w:p></w:body></w:document>';
    return R.forReview(e, { round: 'r1', start: 0x200 });
  };
  const partsOf = (out) => { const o = {}; for (const e of out) o[e.path] = e.content; return o; };

  test('withComments: threads with replies and done, over the right words, read back as they were', () => {
    const threads = [
      { start: { p: 1, o: 11 }, end: { p: 1, o: 25 }, resolved: false, comments: [
        { author: 'Dana Editor', date: '2026-10-09T10:01:00Z', text: 'Too famous?' },
        { author: 'Charles Dickens', date: '2026-10-09T12:00:00.123Z', text: 'It stays.\nSecond line.' }] },
      { start: { p: 1, o: 3 }, end: { p: 1, o: 3 }, resolved: true, comments: [{ author: 'Dana Editor', date: '2026-10-09T10:02:00Z', text: 'A point.' }] },
      { start: { p: 1, o: 37 }, end: { p: 3, o: 4 }, resolved: false, comments: [{ author: 'Sam <Proof>', date: 'x', text: 'Across & over' }] }
    ];
    const { entries: out, paraIds } = R.withComments(sendDoc(), threads, { start: 0x900 });
    const parts = partsOf(out);
    for (const n of ['comments', 'commentsExtended', 'commentsIds', 'commentsExtensible', 'people']) {
      assert.ok(parts['word/' + n + '.xml'], n);
      assert.match(parts['[Content_Types].xml'], new RegExp('PartName="/word/' + n + '.xml"'));
      assert.match(parts['word/_rels/document.xml.rels'], new RegExp('Target="' + n + '.xml"'));
    }
    const m = R.parse(parts);
    // the text is as it was: nothing put in the story
    assert.equal(m.paragraphs[1].after, 'It was the best & worst of times,\nsaid he.');
    assert.equal(m.paragraphs.length, 4);
    assert.equal(m.paragraphs[1].segs.find((x) => x.text.includes('best')).b, true);
    assert.equal(m.comments.length, 4);
    const [a, b, c, d] = m.comments;
    assert.deepEqual([a.author, a.text, a.parent, a.done], ['Dana Editor', 'Too famous?', null, false]);
    assert.deepEqual([b.author, b.text, b.parent, b.done], ['Charles Dickens', 'It stays.\nSecond line.', a.id, false]);
    assert.equal(b.dateUtc, '2026-10-09T12:00:00Z');
    // over "best & worst", split inside the bold run and the plain one
    assert.deepEqual([a.start.p, a.start.o, a.end.p, a.end.o], [1, 11, 1, 25]);
    assert.equal(m.paragraphs[1].after.slice(a.start.o, a.end.o), 'best & worst o');
    assert.deepEqual([b.start.o, b.end.o], [11, 25]);
    assert.deepEqual([c.start.o, c.end.o, c.done, c.parent], [3, 3, true, null]);
    assert.deepEqual([d.start.p, d.start.o, d.end.p, d.end.o, d.author, d.text], [1, 37, 3, 4, 'Sam <Proof>', 'Across & over']);
    assert.deepEqual(paraIds.map((x) => x.length), [2, 1, 1]);
    assert.equal(paraIds[0][0], a.paraId);
    assert.equal(b.paraId, paraIds[0][1]);
    // every paragraph id different, in the story and the comments
    const all = [...parts['word/document.xml'].matchAll(/w14:paraId="(\w+)"/g), ...parts['word/comments.xml'].matchAll(/w14:paraId="(\w+)"/g)].map((x) => x[1]);
    assert.equal(new Set(all).size, all.length);
    assert.match(parts['word/people.xml'], /w15:author="Sam &lt;Proof&gt;"/);
  });

  test('withComments: a range at a run edge, at a paragraph start, and nothing to send', () => {
    const { entries: out } = R.withComments(sendDoc(), [
      { start: { p: 1, o: 0 }, end: { p: 1, o: 11 }, comments: [{ author: 'A', date: '', text: 'x' }] },
      { start: { p: 0, o: 0 }, end: { p: 0, o: 3 }, comments: [{ author: 'A', date: '', text: 'title' }] },
      { start: { p: 2, o: 0 }, end: { p: 2, o: 0 }, comments: [{ author: 'A', date: '', text: 'on an empty line' }] }
    ]);
    const m = R.parse(partsOf(out));
    assert.deepEqual(m.comments.map((c) => [c.start.p, c.start.o, c.end.p, c.end.o]), [[1, 0, 1, 11], [0, 0, 0, 3], [3, 0, 3, 0]]);
    assert.equal(m.paragraphs[0].bookmarks[0].name, '_NEO_ch_1');
    const same = R.withComments(sendDoc(), []);
    assert.equal(same.entries.some((e) => e.path === 'word/comments.xml'), false);
  });

  test('forReview keeps a settings part that is there, and needs a round', () => {
    const e = entries();
    e.push({ path: 'word/settings.xml', content: '<w:settings xmlns:w="w"><w:zoom w:percent="100"/></w:settings>' });
    const out = R.forReview(e, { round: 'r1' });
    assert.equal(out.find((x) => x.path === 'word/settings.xml').content, '<w:settings xmlns:w="w"><w:trackRevisions/><w:zoom w:percent="100"/></w:settings>');
    assert.throws(() => R.forReview(entries(), {}), /round/);
  });
});
