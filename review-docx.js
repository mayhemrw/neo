// Reading an editor's Word file (phase 6, the Word round-trip): the tracked
// changes, comments and replies Word keeps in a .docx, as data the window
// can match to the version the book was sent from. Nothing here touches a
// chapter: `parse` only says what the file holds.
//
// Plain JavaScript with no Node or browser APIs, so it runs in NEO's main
// process, in the window, in scripts/ and in a browser. The XML is read by a
// small tokenizer of its own (`tokens`), never by regular expressions over
// `<w:p>`, because review markup nests (an insertion inside a comment's
// range, one editor's deletion inside another's insertion, a paragraph's
// mark inserted on its own) and a pattern can't follow that.
//
// What a paragraph gives (`parse(parts).paragraphs[i]`):
//   after   its text as the editor left it (every change accepted)
//   before  its text before their changes (every change rejected)
//   segs    the text in pieces, each { text, ins, del, b, i, fmt, a, o }:
//           ins/del the change that put it in or took it out (an index into
//           `changes`, or -1), b/i bold and italic as it now stands, fmt the
//           formatting change on it (-1 if none), a/o where it starts in
//           `after` and `before` (a piece that's only in one of them still
//           has a place in the other, where it would be)
//   mark    the paragraph's own mark: { ins, del } changes (-1 if none). A
//           mark inserted means the editor split the paragraph here (before
//           their changes it ran on into the next); a mark deleted means
//           they joined it to the next. `joined(model, 'after'|'before')`
//           gives the paragraphs as each side reads them.
//   style, styleName, heading, title, paraId, bookmarks [{ name, a, o }],
//   pfmt    a change to the paragraph's own formatting (-1 if none)
//
// `changes[n]` is { n, wid, type, author, date, p, move } with type one of
// ins, del, moveFrom, moveTo, format (a run's bold or italic), para (a
// paragraph's properties), markIns, markDel. `move` names the move a
// moveFrom and its moveTo share. `moves` pairs them: { name, from: [n],
// to: [n] }.
//
// `comments[k]` is { id, author, initials, date, dateUtc, text, paraId,
// parent, done, durableId, start, end, ref } with start/end/ref as
// { p, a, o } (paragraph and offsets in after/before), or null where the
// file has no range for it. `parent` is the id of the comment it answers
// (commentsExtended.xml's paraIdParent), `done` whether it was resolved.
//
// Sending (M2): `forReview(entries, { round })` makes NEO's own Word export
// a file for an editor (an id on every paragraph, the round's id, Track
// Changes on); `withBookmark` and `chapterMark` mark where chapters start.
//
// Also: `round` (NEO's round id, `NEO.ReviewRound` in docProps/custom.xml),
// `people` (people.xml: { name: { providerId, userId } }), `props` (every
// custom property), and `notes`: what was in the file but isn't read (text
// boxes, footnotes, table cell changes), counted, so the import can say so.

'use strict';

(function (exports) {
  // -------------------------------------------------------------------------
  // The tokenizer
  // -------------------------------------------------------------------------

  // Namespaces by URI, so a file that names them differently still reads
  const NS = {
    'http://schemas.openxmlformats.org/wordprocessingml/2006/main': 'w',
    'http://purl.oclc.org/ooxml/wordprocessingml/main': 'w',
    'http://schemas.microsoft.com/office/word/2010/wordml': 'w14',
    'http://schemas.microsoft.com/office/word/2012/wordml': 'w15',
    'http://schemas.microsoft.com/office/word/2016/wordml/cid': 'w16cid',
    'http://schemas.microsoft.com/office/word/2018/wordml/cex': 'w16cex',
    'http://schemas.openxmlformats.org/markup-compatibility/2006': 'mc',
    'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties': 'cp',
    'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes': 'vt',
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r'
  };

  function decode(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try { return String.fromCodePoint(code); } catch { return m; }
      }
      return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e];
    });
  }

  // Every element start, end and stretch of text in `xml`, in order:
  // { t: 'open', name, attrs, empty } | { t: 'close', name } | { t: 'text', text },
  // each with where it starts and ends in `xml` (s, e).
  // Names come back with the prefix their namespace's URI gives (w:, w14:…),
  // whatever the file called it; attribute names likewise.
  function tokens(xml) {
    const out = [];
    const scopes = [{ '': '', xml: 'xml', xmlns: 'xmlns' }];
    const canon = (qname, scope, isAttr) => {
      const c = qname.indexOf(':');
      if (c < 0) {
        if (isAttr) return qname;
        const uri = scope[''];
        const p = uri && NS[uri];
        return p ? p + ':' + qname : qname;
      }
      const pre = qname.slice(0, c);
      const uri = scope[pre];
      const p = uri !== undefined ? (NS[uri] || pre) : pre;
      return p + ':' + qname.slice(c + 1);
    };
    let i = 0;
    const n = xml.length;
    while (i < n) {
      const lt = xml.indexOf('<', i);
      if (lt < 0) { out.push({ t: 'text', text: decode(xml.slice(i)), s: i, e: n }); break; }
      if (lt > i) out.push({ t: 'text', text: decode(xml.slice(i, lt)), s: i, e: lt });
      if (xml.startsWith('<!--', lt)) {
        const e = xml.indexOf('-->', lt + 4);
        i = e < 0 ? n : e + 3;
        continue;
      }
      if (xml.startsWith('<![CDATA[', lt)) {
        const e = xml.indexOf(']]>', lt + 9);
        out.push({ t: 'text', text: xml.slice(lt + 9, e < 0 ? n : e), s: lt, e: e < 0 ? n : e + 3, cdata: true });
        i = e < 0 ? n : e + 3;
        continue;
      }
      if (xml[lt + 1] === '?' || xml[lt + 1] === '!') {
        const e = xml.indexOf('>', lt + 1);
        i = e < 0 ? n : e + 1;
        continue;
      }
      // the tag's end: the first > outside quotes
      let j = lt + 1;
      let q = '';
      for (; j < n; j++) {
        const ch = xml[j];
        if (q) { if (ch === q) q = ''; } else if (ch === '"' || ch === "'") q = ch; else if (ch === '>') break;
      }
      const body = xml.slice(lt + 1, j);
      i = j + 1;
      if (body[0] === '/') {
        const scope = scopes.length > 1 ? scopes.pop() : scopes[0];
        out.push({ t: 'close', name: canon(body.slice(1).trim(), scope, false), s: lt, e: i });
        continue;
      }
      const empty = body.endsWith('/');
      const inner = empty ? body.slice(0, -1) : body;
      const sp = inner.search(/\s/);
      const qname = sp < 0 ? inner : inner.slice(0, sp);
      const raw = [];
      if (sp >= 0) {
        const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
        let m;
        const rest = inner.slice(sp);
        while ((m = re.exec(rest))) raw.push([m[1], decode(m[3] !== undefined ? m[3] : m[4])]);
      }
      const parent = scopes[scopes.length - 1];
      let scope = parent;
      for (const [k, v] of raw) {
        if (k === 'xmlns' || k.startsWith('xmlns:')) {
          if (scope === parent) scope = Object.assign({}, parent);
          scope[k === 'xmlns' ? '' : k.slice(6)] = v;
        }
      }
      const attrs = {};
      for (const [k, v] of raw) if (k !== 'xmlns' && !k.startsWith('xmlns:')) attrs[canon(k, scope, true)] = v;
      const name = canon(qname, scope, false);
      out.push({ t: 'open', name, attrs, empty, s: lt, e: i });
      if (!empty) scopes.push(scope);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Styles: bold and italic a style gives, and its name
  // -------------------------------------------------------------------------

  // Is <w:b>/<w:i> on? true, false (Word writes w:val="0" to cancel a
  // style's italics), or undefined when nothing says.
  const onOff = (attrs) => {
    const v = attrs['w:val'];
    return v === undefined || /^(true|1|on)$/i.test(v);
  };

  function readStyles(xml) {
    const raw = {};
    if (xml) {
      const toks = tokens(xml);
      let cur = null;
      let inRpr = 0;
      let inPpr = 0;
      for (const tk of toks) {
        if (tk.t === 'open') {
          if (tk.name === 'w:style') {
            cur = { id: tk.attrs['w:styleId'], name: '', basedOn: '', b: undefined, i: undefined };
            if (cur.id) raw[cur.id] = cur;
            if (tk.empty) cur = null;
          } else if (cur) {
            if (tk.name === 'w:name') cur.name = tk.attrs['w:val'] || '';
            else if (tk.name === 'w:basedOn') cur.basedOn = tk.attrs['w:val'] || '';
            else if (tk.name === 'w:pPr' && !tk.empty) inPpr++;
            else if (tk.name === 'w:rPr' && !tk.empty && !inPpr) inRpr++;
            else if (inRpr && tk.name === 'w:b') cur.b = onOff(tk.attrs);
            else if (inRpr && tk.name === 'w:i') cur.i = onOff(tk.attrs);
          }
        } else if (tk.t === 'close') {
          if (tk.name === 'w:style') cur = null;
          else if (tk.name === 'w:pPr' && inPpr) inPpr--;
          else if (tk.name === 'w:rPr' && inRpr) inRpr--;
        }
      }
    }
    const out = {};
    const resolve = (id, depth) => {
      if (out[id]) return out[id];
      const st = raw[id];
      if (!st || depth > 8) return { name: '', b: false, i: false };
      const base = st.basedOn ? resolve(st.basedOn, depth + 1) : { b: false, i: false };
      out[id] = { name: st.name, b: st.b === undefined ? base.b : st.b, i: st.i === undefined ? base.i : st.i };
      return out[id];
    };
    for (const id of Object.keys(raw)) resolve(id, 0);
    return out;
  }

  // -------------------------------------------------------------------------
  // The document
  // -------------------------------------------------------------------------

  // Subtrees whose text isn't the story's: drawings and text boxes (their own
  // paragraphs would land inside this one), the fallback copy of anything
  // under mc:AlternateContent, field instructions, deleted field
  // instructions. Counted in `notes` where it matters.
  const SKIP = new Set(['w:drawing', 'w:pict', 'w:object', 'mc:Fallback', 'w:txbxContent', 'w:instrText', 'w:delInstrText', 'w:footnoteReference', 'w:endnoteReference']);

  function readDocument(xml, styles) {
    const toks = tokens(xml);
    const paragraphs = [];
    const changes = [];
    const ranges = {};          // comment id → { start, end, ref }
    const notes = { textBoxes: 0, footnotes: 0, tableChanges: 0, sectionChanges: 0 };
    const openMoves = { from: [], to: [] };
    const pendingMarks = [];    // bookmarks and comment starts seen between paragraphs

    const addChange = (type, attrs, p, extra) => {
      const c = { n: changes.length, wid: attrs['w:id'] || '', type, author: attrs['w:author'] || '', date: attrs['w:date'] || '', p };
      if (extra) Object.assign(c, extra);
      changes.push(c);
      return c.n;
    };

    // the paragraph being read
    let P = null;
    // the wrappers around the current point: w:ins / w:del / w:moveFrom /
    // w:moveTo, each with the change it made (made when the first text
    // inside it is met, so an empty wrapper makes no change)
    const wraps = [];
    let skip = 0;
    let skipName = '';
    // the run being read
    let R = null;
    // depth inside pPr / rPr / rPrChange / pPrChange
    let inPpr = 0;
    let inRpr = 0;
    let inRprChange = 0;
    let inPprChange = 0;
    let markRpr = false;        // the rPr inside pPr: the paragraph mark's own

    const where = () => ({ p: P ? P.index : paragraphs.length, a: P ? P.after.length : 0, o: P ? P.before.length : 0 });

    const startParagraph = (attrs) => {
      P = {
        index: paragraphs.length,
        paraId: attrs['w14:paraId'] || '',
        style: '', styleName: '', heading: false, title: false,
        after: '', before: '', segs: [],
        mark: { ins: -1, del: -1 }, pfmt: -1, bookmarks: [], pageBreak: false
      };
      // what came between paragraphs belongs at this one's start
      for (const m of pendingMarks.splice(0)) {
        if (m.bookmark) P.bookmarks.push({ name: m.bookmark, a: 0, o: 0 });
        else if (m.comment) ranges[m.comment][m.which] = { p: P.index, a: 0, o: 0 };
      }
    };

    const wrapChange = (w) => {
      if (w.n < 0) {
        const extra = w.move ? { move: w.move } : null;
        w.n = addChange(w.type, w.attrs, P ? P.index : paragraphs.length, extra);
      }
      return w.n;
    };

    const addText = (text) => {
      if (!P || !text) return;
      let ins = -1;
      let del = -1;
      for (const w of wraps) {
        if (w.type === 'ins' || w.type === 'moveTo') ins = wrapChange(w);
        else del = wrapChange(w);
      }
      if (R) {
        if (R.ins) ins = R.ins.n >= 0 ? R.ins.n : (R.ins.n = addChange('ins', R.ins.attrs, P.index));
        if (R.del) del = R.del.n >= 0 ? R.del.n : (R.del.n = addChange('del', R.del.attrs, P.index));
      }
      const b = R ? R.b : false;
      const i = R ? R.i : false;
      let fmt = -1;
      if (R && R.fmt) {
        if (R.fmt.n < 0) {
          // what the old properties don't say, their style (or, with none,
          // the paragraph's) gave; a run's rPr always comes before its text
          const base = (R.fmt.style ? styles[R.fmt.style] : R.pBase) || { b: false, i: false };
          const was = { b: R.fmt.b === undefined ? !!base.b : R.fmt.b, i: R.fmt.i === undefined ? !!base.i : R.fmt.i };
          R.fmt.n = addChange('format', R.fmt.attrs, P.index, { was, now: { b, i } });
        }
        fmt = R.fmt.n;
      }
      const last = P.segs[P.segs.length - 1];
      if (last && last.ins === ins && last.del === del && last.b === b && last.i === i && last.fmt === fmt) last.text += text;
      else P.segs.push({ text, ins, del, b, i, fmt, a: P.after.length, o: P.before.length });
      if (del < 0) P.after += text;
      if (ins < 0) P.before += text;
    };

    for (let k = 0; k < toks.length; k++) {
      const tk = toks[k];
      if (skip) {
        // a text box inside a drawing (not the fallback copy of one)
        if (tk.t === 'open' && tk.name === 'w:txbxContent' && skipName !== 'mc:Fallback') notes.textBoxes++;
        if (tk.t === 'open' && !tk.empty && tk.name === skipName) skip++;
        else if (tk.t === 'close' && tk.name === skipName) skip--;
        continue;
      }
      if (tk.t === 'text') {
        if (R && R.textTag) addText(tk.text);
        continue;
      }
      const name = tk.name;
      if (tk.t === 'close') {
        // inside a change's old properties, only its own end counts
        if (inRprChange && name !== 'w:rPrChange') continue;
        if (inPprChange && name !== 'w:pPrChange') continue;
        switch (name) {
          case 'w:p':
            if (P) {
              // a paragraph that holds only a page break is NEO's page turn
              paragraphs.push(P);
              P = null;
            }
            break;
          case 'w:r': R = null; break;
          case 'w:t': case 'w:delText': if (R) R.textTag = false; break;
          case 'w:ins': case 'w:del': case 'w:moveFrom': case 'w:moveTo':
            if (!inRpr && !inPpr) wraps.pop();
            break;
          case 'w:pPr': if (inPpr) inPpr--; break;
          case 'w:rPr':
            if (inRpr) inRpr--;
            if (!inRpr) markRpr = false;
            break;
          case 'w:rPrChange': if (inRprChange) inRprChange--; break;
          case 'w:pPrChange': if (inPprChange) inPprChange--; break;
        }
        continue;
      }
      // an element opens
      if (SKIP.has(name)) {
        if (name === 'w:txbxContent') notes.textBoxes++;
        if (name === 'w:footnoteReference' || name === 'w:endnoteReference') notes.footnotes++;
        if (!tk.empty) { skip = 1; skipName = name; }
        continue;
      }
      const a = tk.attrs;
      // inside a formatting change: the old properties, read only for b/i
      if (inRprChange) {
        if (R && R.fmt) {
          if (name === 'w:b') R.fmt.b = onOff(a);
          else if (name === 'w:i') R.fmt.i = onOff(a);
          else if (name === 'w:rStyle') R.fmt.style = a['w:val'] || '';
        }
        if (!tk.empty && name === 'w:rPrChange') inRprChange++;
        continue;
      }
      if (inPprChange) {
        if (!tk.empty && name === 'w:pPrChange') inPprChange++;
        continue;
      }
      switch (name) {
        case 'w:p':
          startParagraph(a);
          if (tk.empty) { paragraphs.push(P); P = null; }
          break;
        case 'w:pPr':
          if (!tk.empty) inPpr++;
          break;
        case 'w:pStyle':
          if (P && inPpr && !inRpr) {
            P.style = a['w:val'] || '';
            const st = styles[P.style];
            P.styleName = st ? st.name : '';
            P.heading = /^heading\s*\d*$/i.test(P.style) || /^heading\s*\d*$/i.test(P.styleName);
            P.title = /^title$/i.test(P.style) || /^title$/i.test(P.styleName);
          }
          break;
        case 'w:pageBreakBefore':
          if (P && inPpr && onOff(a)) P.pageBreak = true;
          break;
        case 'w:pPrChange':
          if (P) P.pfmt = addChange('para', a, P.index);
          if (!tk.empty) inPprChange++;
          break;
        case 'w:sectPrChange':
          notes.sectionChanges++;
          break;
        case 'w:r': {
          // a run's bold and italic start from its paragraph's style
          const pst = (P && styles[P.style]) || { b: false, i: false };
          R = { b: !!pst.b, i: !!pst.i, textTag: false, fmt: null, ins: null, del: null, style: '', bSet: undefined, iSet: undefined, pBase: pst };
          if (tk.empty) R = null;
          break;
        }
        case 'w:rPr':
          if (!tk.empty) {
            inRpr++;
            if (inPpr && !R) markRpr = true;
          }
          break;
        case 'w:rStyle':
          if (R && inRpr) {
            R.style = a['w:val'] || '';
            const st = styles[R.style];
            if (st) {
              if (R.bSet === undefined) R.b = !!st.b;
              if (R.iSet === undefined) R.i = !!st.i;
            }
          }
          break;
        case 'w:b':
          if (R && inRpr) { R.bSet = onOff(a); R.b = R.bSet; }
          break;
        case 'w:i':
          if (R && inRpr) { R.iSet = onOff(a); R.i = R.iSet; }
          break;
        case 'w:rPrChange':
          if (markRpr) { if (!tk.empty) inRprChange++; break; }
          if (R) R.fmt = { attrs: a, n: -1, b: undefined, i: undefined, style: '' };
          if (!tk.empty) inRprChange++;
          break;
        case 'w:ins': case 'w:del': case 'w:moveFrom': case 'w:moveTo':
          if (inRpr && markRpr) {
            // the paragraph mark itself was inserted or deleted
            if (P) {
              if (name === 'w:ins' || name === 'w:moveTo') P.mark.ins = addChange('markIns', a, P.index);
              else P.mark.del = addChange('markDel', a, P.index);
            }
          } else if (inRpr && R) {
            // a run marked inserted or deleted in its own properties
            if (name === 'w:ins' || name === 'w:moveTo') R.ins = { attrs: a, n: -1 };
            else R.del = { attrs: a, n: -1 };
          } else if (inPpr) {
            // (a numbering change's own w:ins, inside w:numPr)
          } else if (!tk.empty) {
            const kind = name.slice(2);
            const open = kind === 'moveFrom' ? openMoves.from : kind === 'moveTo' ? openMoves.to : null;
            const move = open && open.length ? open[open.length - 1].name : (open ? a['w:name'] || '' : '');
            wraps.push({ type: kind, attrs: a, n: -1, move: open ? move : '' });
          }
          break;
        case 'w:moveFromRangeStart': case 'w:moveToRangeStart': {
          const which = name === 'w:moveFromRangeStart' ? 'from' : 'to';
          const mn = a['w:name'] || ('move' + a['w:id']);
          openMoves[which].push({ id: a['w:id'], name: mn });
          break;
        }
        case 'w:moveFromRangeEnd': case 'w:moveToRangeEnd': {
          const which = name === 'w:moveFromRangeEnd' ? 'from' : 'to';
          const list = openMoves[which];
          const at = list.findIndex((m) => m.id === a['w:id']);
          if (at >= 0) list.splice(at, 1); else list.pop();
          break;
        }
        case 'w:t': case 'w:delText':
          if (R && !tk.empty) R.textTag = true;
          break;
        case 'w:tab': if (R && !inRpr && !inPpr) addText('\t'); break;
        case 'w:br': case 'w:cr':
          if (R && !inRpr) {
            const ty = a['w:type'];
            if (ty === 'page' || ty === 'column') { if (P && !P.after && !P.before) P.pageBreak = true; } else addText('\n');
          }
          break;
        case 'w:noBreakHyphen': if (R && !inRpr) addText('‑'); break;
        case 'w:softHyphen': if (R && !inRpr) addText('­'); break;
        case 'w:sym':
          if (R && !inRpr) {
            const code = parseInt(a['w:char'] || '', 16);
            // symbol fonts map their letters into the private area (F0xx)
            if (code >= 0xF020 && code <= 0xF0FF) addText(String.fromCharCode(code - 0xF000));
            else if (code) addText(String.fromCodePoint(code));
          }
          break;
        case 'w:bookmarkStart': {
          const bn = a['w:name'] || '';
          if (!bn || bn === '_GoBack') break;
          if (P) P.bookmarks.push({ name: bn, a: P.after.length, o: P.before.length });
          else pendingMarks.push({ bookmark: bn });
          break;
        }
        case 'w:commentRangeStart': case 'w:commentRangeEnd': {
          const id = a['w:id'];
          if (id === undefined) break;
          const rg = ranges[id] || (ranges[id] = { start: null, end: null, ref: null });
          const which = name === 'w:commentRangeStart' ? 'start' : 'end';
          if (P) rg[which] = where();
          else if (which === 'start') pendingMarks.push({ comment: id, which });
          else rg.end = paragraphs.length ? { p: paragraphs.length - 1, a: paragraphs[paragraphs.length - 1].after.length, o: paragraphs[paragraphs.length - 1].before.length } : null;
          break;
        }
        case 'w:commentReference': {
          const id = a['w:id'];
          if (id === undefined) break;
          const rg = ranges[id] || (ranges[id] = { start: null, end: null, ref: null });
          rg.ref = where();
          break;
        }
        case 'w:cellIns': case 'w:cellDel': case 'w:cellMerge':
          notes.tableChanges++;
          break;
        case 'w:tblPrChange': case 'w:trPrChange': case 'w:tcPrChange': case 'w:tblGridChange':
          notes.tableChanges++;
          if (!tk.empty) { skip = 1; skipName = name; }
          break;
      }
    }

    const moves = {};
    for (const c of changes) {
      if ((c.type === 'moveFrom' || c.type === 'moveTo') && c.move) {
        const m = moves[c.move] || (moves[c.move] = { name: c.move, from: [], to: [] });
        (c.type === 'moveFrom' ? m.from : m.to).push(c.n);
      }
    }
    return { paragraphs, changes, ranges, moves: Object.values(moves), notes };
  }

  // -------------------------------------------------------------------------
  // Comments and the parts around them
  // -------------------------------------------------------------------------

  // comments.xml: { id, author, initials, date, text, paraId (its last
  // paragraph's, which commentsExtended.xml points at), paraIds }
  function readComments(xml) {
    const out = [];
    if (!xml) return out;
    const toks = tokens(xml);
    let c = null;
    let para = null;
    let inT = false;
    let skip = 0;
    let skipName = '';
    for (const tk of toks) {
      if (skip) {
        if (tk.t === 'open' && !tk.empty && tk.name === skipName) skip++;
        else if (tk.t === 'close' && tk.name === skipName) skip--;
        continue;
      }
      if (tk.t === 'open') {
        if (SKIP.has(tk.name)) { if (!tk.empty) { skip = 1; skipName = tk.name; } continue; }
        if (tk.name === 'w:comment') {
          c = { id: tk.attrs['w:id'], author: tk.attrs['w:author'] || '', initials: tk.attrs['w:initials'] || '', date: tk.attrs['w:date'] || '', paras: [], paraIds: [] };
          if (tk.empty) { out.push(finishComment(c)); c = null; }
        } else if (c && tk.name === 'w:p') {
          para = '';
          if (tk.attrs['w14:paraId']) c.paraIds.push(tk.attrs['w14:paraId']);
          if (tk.empty) { c.paras.push(''); para = null; }
        } else if (c && para !== null) {
          if ((tk.name === 'w:t' || tk.name === 'w:delText') && !tk.empty) inT = tk.name === 'w:t';
          else if (tk.name === 'w:tab') para += '\t';
          else if (tk.name === 'w:br' || tk.name === 'w:cr') para += '\n';
          else if (tk.name === 'w:noBreakHyphen') para += '‑';
        }
      } else if (tk.t === 'close') {
        if (tk.name === 'w:t' || tk.name === 'w:delText') inT = false;
        else if (c && tk.name === 'w:p') { c.paras.push(para || ''); para = null; }
        else if (c && tk.name === 'w:comment') { out.push(finishComment(c)); c = null; }
      } else if (inT && c && para !== null) para += tk.text;
    }
    return out;
  }
  function finishComment(c) {
    return {
      id: c.id, author: c.author, initials: c.initials, date: c.date,
      text: c.paras.join('\n').replace(/\n+$/, ''),
      paraId: c.paraIds.length ? c.paraIds[c.paraIds.length - 1] : '',
      paraIds: c.paraIds
    };
  }

  // commentsExtended.xml: paraId → { parent (a paraId), done }
  function readCommentsExtended(xml) {
    const out = {};
    if (!xml) return out;
    for (const tk of tokens(xml)) {
      if (tk.t === 'open' && tk.name === 'w15:commentEx') {
        const id = tk.attrs['w15:paraId'];
        if (id) out[id] = { parent: tk.attrs['w15:paraIdParent'] || '', done: tk.attrs['w15:done'] === '1' || tk.attrs['w15:done'] === 'true' };
      }
    }
    return out;
  }

  // commentsIds.xml: paraId → durableId
  function readCommentsIds(xml) {
    const out = {};
    if (!xml) return out;
    for (const tk of tokens(xml)) {
      if (tk.t === 'open' && tk.name === 'w16cid:commentId' && tk.attrs['w16cid:paraId']) out[tk.attrs['w16cid:paraId']] = tk.attrs['w16cid:durableId'] || '';
    }
    return out;
  }

  // commentsExtensible.xml: durableId → the date in UTC (w:date is the
  // editor's local time with no zone)
  function readCommentsExtensible(xml) {
    const out = {};
    if (!xml) return out;
    for (const tk of tokens(xml)) {
      if (tk.t === 'open' && tk.name === 'w16cex:commentExtensible' && tk.attrs['w16cex:durableId']) out[tk.attrs['w16cex:durableId']] = tk.attrs['w16cex:dateUtc'] || '';
    }
    return out;
  }

  // people.xml: author → { providerId, userId }
  function readPeople(xml) {
    const out = {};
    if (!xml) return out;
    let cur = null;
    for (const tk of tokens(xml)) {
      if (tk.t === 'open' && tk.name === 'w15:person') {
        cur = tk.attrs['w15:author'] || '';
        out[cur] = { providerId: '', userId: '' };
        if (tk.empty) cur = null;
      } else if (tk.t === 'open' && cur !== null && tk.name === 'w15:presenceInfo') {
        out[cur] = { providerId: tk.attrs['w15:providerId'] || '', userId: tk.attrs['w15:userId'] || '' };
      } else if (tk.t === 'close' && tk.name === 'w15:person') cur = null;
    }
    return out;
  }

  // docProps/custom.xml: { name: value }
  function readCustomProps(xml) {
    const out = {};
    if (!xml) return out;
    let cur = null;
    let inVal = false;
    for (const tk of tokens(xml)) {
      if (tk.t === 'open' && tk.name === 'cp:property') { cur = tk.attrs.name || ''; out[cur] = ''; if (tk.empty) cur = null; }
      else if (tk.t === 'open' && cur !== null && tk.name.startsWith('vt:')) inVal = !tk.empty;
      else if (tk.t === 'close' && tk.name.startsWith('vt:')) inVal = false;
      else if (tk.t === 'close' && tk.name === 'cp:property') cur = null;
      else if (tk.t === 'text' && inVal && cur !== null) out[cur] += tk.text;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // parse: the whole file
  // -------------------------------------------------------------------------

  const PART_NAMES = {
    document: 'word/document.xml',
    styles: 'word/styles.xml',
    comments: 'word/comments.xml',
    commentsExtended: 'word/commentsExtended.xml',
    commentsIds: 'word/commentsIds.xml',
    commentsExtensible: 'word/commentsExtensible.xml',
    people: 'word/people.xml',
    custom: 'docProps/custom.xml'
  };

  // `parts` is { 'word/document.xml': text, … } (any of the PART_NAMES; the
  // rest are left out). Throws if there's no document.
  function parse(parts) {
    const get = (k) => {
      const v = parts[PART_NAMES[k]];
      if (v === undefined || v === null) return '';
      return typeof v === 'string' ? v : utf8(v);
    };
    const docXml = get('document');
    if (!docXml) throw new Error('Not a Word document: it has no word/document.xml');
    const styles = readStyles(get('styles'));
    const doc = readDocument(docXml, styles);

    const ext = readCommentsExtended(get('commentsExtended'));
    const ids = readCommentsIds(get('commentsIds'));
    const utc = readCommentsExtensible(get('commentsExtensible'));
    const raw = readComments(get('comments'));
    const byPara = {};
    for (const c of raw) if (c.paraId) byPara[c.paraId] = c;
    const comments = raw.map((c) => {
      const e = ext[c.paraId] || { parent: '', done: false };
      const parentC = e.parent ? byPara[e.parent] : null;
      const rg = doc.ranges[c.id] || { start: null, end: null, ref: null };
      const durableId = ids[c.paraId] || '';
      return {
        id: c.id, author: c.author, initials: c.initials, date: c.date,
        dateUtc: durableId ? (utc[durableId] || '') : '',
        text: c.text, paraId: c.paraId, durableId,
        parent: parentC ? parentC.id : null, done: e.done,
        start: rg.start, end: rg.end, ref: rg.ref
      };
    });

    const props = readCustomProps(get('custom'));
    return {
      round: props['NEO.ReviewRound'] || '',
      props,
      people: readPeople(get('people')),
      paragraphs: doc.paragraphs,
      changes: doc.changes,
      moves: doc.moves,
      comments,
      notes: doc.notes
    };
  }

  function utf8(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(s));
  }

  // -------------------------------------------------------------------------
  // Views of the result
  // -------------------------------------------------------------------------

  // The paragraphs as one side reads them: 'after' (the editor's file with
  // every change accepted) or 'before' (every change rejected). A paragraph
  // whose mark the editor deleted runs on into the next on the 'after'
  // side; one whose mark they inserted runs on on the 'before' side. Each
  // is { text, from: [paragraph indexes], heading, title, bookmarks }.
  // Paragraphs that are empty on that side and were wholly inserted (or
  // deleted) leave no line.
  function joined(model, side) {
    const out = [];
    let cur = null;
    const after = side === 'after';
    for (const p of model.paragraphs) {
      const text = after ? p.after : p.before;
      const gone = after ? p.mark.del >= 0 : p.mark.ins >= 0;
      // a whole paragraph that only exists on the other side
      const absent = !text && p.segs.length > 0 && p.segs.every((s) => after ? s.del >= 0 : s.ins >= 0) && gone;
      if (!cur) cur = { text: '', from: [], heading: p.heading, title: p.title, bookmarks: [] };
      if (!absent) {
        for (const b of p.bookmarks) cur.bookmarks.push({ name: b.name, at: cur.text.length + (after ? b.a : b.o) });
        cur.text += text;
        cur.from.push(p.index);
      } else {
        for (const b of p.bookmarks) cur.bookmarks.push({ name: b.name, at: cur.text.length });
      }
      if (!gone) { out.push(cur); cur = null; }
    }
    if (cur && (cur.from.length || cur.text)) out.push(cur);
    return out;
  }

  // How many of each kind, for an import's summary: { authors: { name:
  // { changes, comments } }, changes, comments, formatting, moves }. A
  // move counts once; a paragraph mark counts with the text change beside it.
  function summary(model) {
    const authors = {};
    const who = (n) => authors[n] || (authors[n] = { changes: 0, comments: 0, formatting: 0 });
    let changes = 0;
    let formatting = 0;
    for (const c of model.changes) {
      if (c.type === 'format' || c.type === 'para') { formatting++; who(c.author).formatting++; continue; }
      if (c.type === 'markIns' || c.type === 'markDel') continue;
      if (c.type === 'moveTo' && c.move) continue;
      changes++;
      who(c.author).changes++;
    }
    for (const c of model.comments) who(c.author).comments++;
    return { authors, changes, comments: model.comments.length, formatting, moves: model.moves.length };
  }

  // Read a .docx's bytes: unzip (SlogZip's, inflate handed in or the
  // browser's own) and parse. Returns the parse with `problems` from the zip.
  async function readDocx(bytes, zipLib, inflateRaw) {
    const Z = zipLib || (typeof globalThis !== 'undefined' && globalThis.SlogZip);
    if (!Z) throw new Error('No zip reader');
    const { files, problems } = await Z.unzip(bytes, inflateRaw);
    const parts = {};
    for (const k of Object.keys(PART_NAMES)) if (files[PART_NAMES[k]]) parts[PART_NAMES[k]] = files[PART_NAMES[k]];
    const model = parse(parts);
    model.problems = problems;
    return model;
  }

  // -------------------------------------------------------------------------
  // Sending: what a review export adds to NEO's own Word file
  // -------------------------------------------------------------------------

  // A round's id: "r20261009-1a2b3c" (the day it was sent, then six random
  // hex digits). `rand` is a number in [0, 1), for tests.
  function roundId(at, rand) {
    const d = new Date(at);
    const pad = (n) => String(n).padStart(2, '0');
    const r = Math.floor((rand === undefined ? Math.random() : rand) * 0x1000000).toString(16).padStart(6, '0');
    return 'r' + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + '-' + r;
  }

  // Paragraph ids as Word makes them: eight hex digits below 0x80000000,
  // each different. `start` is where to begin (random, so two exports don't
  // share ids); they count up from there.
  function paraIds(start) {
    let n = (start === undefined ? Math.floor(Math.random() * 0x40000000) : start) >>> 0;
    return () => {
      n = (n + 1) % 0x7FFFFFFF || 1;
      return n.toString(16).toUpperCase().padStart(8, '0');
    };
  }

  const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // The bookmark NEO puts at a section's first paragraph, so the file finds
  // its chapters again whatever the editor did to the headings
  const chapterMark = (num) => '_NEO_ch_' + num;
  // inside a paragraph NEO wrote (<w:p><w:pPr>…</w:pPr>…), after its
  // properties, where the schema has it
  function withBookmark(pXml, id, name) {
    const mark = '<w:bookmarkStart w:id="' + id + '" w:name="' + escAttr(name) + '"/><w:bookmarkEnd w:id="' + id + '"/>';
    const at = pXml.indexOf('</w:pPr>');
    if (at >= 0) return pXml.slice(0, at + 8) + mark + pXml.slice(at + 8);
    const open = pXml.indexOf('>');
    return pXml.slice(0, open + 1) + mark + pXml.slice(open + 1);
  }

  // NEO's Word export's parts (`entries`: [{ path, content }]) made into a
  // file for an editor: every paragraph given a w14:paraId, the round's id
  // in docProps/custom.xml (NEO.ReviewRound), and Track Changes switched on
  // in word/settings.xml, so the editor's changes are tracked from the
  // first keystroke. Returns new entries; `entries` is left as it was.
  function forReview(entries, { round, start } = {}) {
    if (!round) throw new Error('a review export needs its round');
    const next = paraIds(start);
    const out = entries.map((e) => ({ path: e.path, content: e.content }));
    const get = (p) => out.find((e) => e.path === p);
    const doc = get('word/document.xml');
    if (!doc) throw new Error('no word/document.xml to send');
    doc.content = doc.content
      .replace(/<w:document\b([^>]*)>/, (m, attrs) => {
        let a = attrs;
        if (!/xmlns:w14=/.test(a)) a += ' xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';
        if (!/xmlns:mc=/.test(a)) a += ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
        if (!/mc:Ignorable=/.test(a)) a += ' mc:Ignorable="w14"';
        return '<w:document' + a + '>';
      })
      .replace(/<w:p>/g, () => '<w:p w14:paraId="' + next() + '">');
    const settings = get('word/settings.xml');
    const TRACK = '<w:trackRevisions/>';
    if (settings) {
      if (!settings.content.includes(TRACK)) settings.content = settings.content.replace(/(<w:settings\b[^>]*>)/, '$1' + TRACK);
    } else {
      out.push({ path: 'word/settings.xml', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' + TRACK + '</w:settings>' });
      addRel(get('word/_rels/document.xml.rels'), 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings', 'settings.xml');
      addType(get('[Content_Types].xml'), '/word/settings.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml');
    }
    out.push({
      path: 'docProps/custom.xml',
      content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
        '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="NEO.ReviewRound"><vt:lpwstr>' + escAttr(round) + '</vt:lpwstr></property></Properties>'
    });
    addRel(get('_rels/.rels'), 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties', 'docProps/custom.xml');
    addType(get('[Content_Types].xml'), '/docProps/custom.xml', 'application/vnd.openxmlformats-officedocument.custom-properties+xml');
    return out;
  }
  // -------------------------------------------------------------------------
  // Sending comments back (M5): the threads as Word keeps them
  // -------------------------------------------------------------------------

  // Where each character of a paragraph is in document.xml, for NEO's own
  // export (no review markup in it): [{ s, e, open, close, rPr, items }]
  // runs per paragraph index, items being [{ cs, len, text?: { s, e, open } }]
  // (a w:t's content, or a tab or a line break as one character). Paragraphs
  // count as readDocument counts them.
  function docRuns(xml) {
    const toks = tokens(xml);
    const paras = [];
    let P = null;
    let R = null;
    let T = null;
    let skip = 0;
    let skipName = '';
    let rPrAt = -1;
    for (const tk of toks) {
      if (skip) {
        if (tk.t === 'open' && !tk.empty && tk.name === skipName) skip++;
        else if (tk.t === 'close' && tk.name === skipName) skip--;
        continue;
      }
      if (tk.t === 'open' && SKIP.has(tk.name)) { if (!tk.empty) { skip = 1; skipName = tk.name; } continue; }
      if (tk.t === 'open') {
        if (tk.name === 'w:p') {
          P = { index: paras.length, s: tk.s, open: tk.e, empty: tk.empty, pPrEnd: -1, close: tk.e, runs: [], len: 0 };
          paras.push(P);
          if (tk.empty) P = null;
        } else if (P && tk.name === 'w:r' && !tk.empty) {
          R = { s: tk.s, e: -1, rPr: '', items: [], cs: P.len };
          P.runs.push(R);
        } else if (R && tk.name === 'w:rPr' && !tk.empty) rPrAt = tk.s;
        else if (R && tk.name === 'w:t' && !tk.empty) T = { s: tk.e, e: tk.e, cs: P.len, len: 0 };
        else if (R && rPrAt < 0 && (tk.name === 'w:tab' || (tk.name === 'w:br' && tk.attrs['w:type'] !== 'page' && tk.attrs['w:type'] !== 'column') || tk.name === 'w:cr' || tk.name === 'w:noBreakHyphen' || tk.name === 'w:softHyphen' || tk.name === 'w:sym')) {
          R.items.push({ cs: P.len, len: 1 });
          P.len += 1;
        }
      } else if (tk.t === 'close') {
        if (tk.name === 'w:p' && P) { P.close = tk.s; P = null; } else if (tk.name === 'w:r' && R) { R.e = tk.e; R.ce = P ? P.len : R.cs; R = null; } else if (tk.name === 'w:rPr' && R && rPrAt >= 0) { R.rPr = xml.slice(rPrAt, tk.e); rPrAt = -1; } else if (tk.name === 'w:pPr' && P && !R) P.pPrEnd = tk.e;
        else if (tk.name === 'w:t' && T) {
          T.e = tk.s;
          R.items.push({ cs: T.cs, len: T.len, text: { s: T.s, e: T.e } });
          T = null;
        }
      } else if (T && P) {
        T.len += tk.text.length;
        P.len += tk.text.length;
      }
    }
    return paras;
  }
  // where the k-th character of a w:t's content is in its raw XML
  function rawOffset(xml, s, e, k) {
    let i = s;
    let n = 0;
    while (i < e && n < k) {
      if (xml[i] === '&') {
        const semi = xml.indexOf(';', i);
        n += decode(xml.slice(i, semi + 1)).length;
        i = semi + 1;
      } else { n++; i++; }
    }
    return i;
  }
  // A place in a paragraph, as { at, split? }: `at` a position in the XML
  // between runs, or, with `split` (the run), inside a w:t's content, where
  // the run is cut in two. `side` 'start' keeps to what follows, 'end' to
  // what comes before.
  function placeAt(xml, P, k, side) {
    const runs = P.runs.filter((r) => r.items.length);
    if (!runs.length) return { at: P.pPrEnd >= 0 ? P.pPrEnd : P.open };
    if (side === 'start') {
      for (const r of runs) {
        if (k <= r.cs) return { at: r.s };
        if (k >= r.ce) continue;
        for (let j = 0; j < r.items.length; j++) {
          const it = r.items[j];
          if (k < it.cs || k >= it.cs + it.len) continue;
          if (it.text) return k === it.cs && j === 0 ? { at: r.s } : { at: rawOffset(xml, it.text.s, it.text.e, k - it.cs), split: r };
          const prev = r.items[j - 1];
          if (prev && prev.text) return { at: prev.text.e, split: r };
          return { at: r.s };
        }
      }
      return { at: runs[runs.length - 1].e };
    }
    for (let q = runs.length - 1; q >= 0; q--) {
      const r = runs[q];
      if (k > r.ce || (k === r.ce && r.cs < k)) return { at: r.e };
      if (k <= r.cs) continue;
      for (let j = r.items.length - 1; j >= 0; j--) {
        const it = r.items[j];
        if (k <= it.cs || k > it.cs + it.len) continue;
        if (it.text) return k === it.cs + it.len && j === r.items.length - 1 ? { at: r.e } : { at: rawOffset(xml, it.text.s, it.text.e, k - it.cs), split: r };
        const next = r.items[j + 1];
        if (next && next.text) return { at: next.text.s, split: r };
        return { at: r.e };
      }
    }
    return { at: runs[0].s };
  }

  const durable = () => (Math.floor(Math.random() * 0x7FFFFFFE) + 1).toString(16).toUpperCase().padStart(8, '0');
  const isoDate = (d) => {
    const t = Date.parse(d);
    return (Number.isFinite(t) ? new Date(t) : new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  };
  const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // The comment threads going back to an editor, put into a file for review
  // (`entries` from forReview). Each thread is { start: { p, o }, end:
  // { p, o }, resolved, comments: [{ author, initials, date, text }] }: p a
  // paragraph index as the file reads (`parse(...).paragraphs`), o a
  // character in it. The first comment starts the thread, the rest answer
  // it (commentsExtended.xml's paraIdParent), every one over the same words
  // as Word does; a resolved thread's comments are marked done. Writes
  // comments.xml, commentsExtended.xml, commentsIds.xml,
  // commentsExtensible.xml (each date in UTC) and people.xml. Returns
  // { entries, paraIds } (paraIds[i]: the ids the i-th thread's comments got,
  // so the next import knows them).
  function withComments(entries, threads, { start } = {}) {
    const out = entries.map((e) => ({ path: e.path, content: e.content }));
    const get = (p) => out.find((e) => e.path === p);
    const doc = get('word/document.xml');
    if (!doc) throw new Error('no word/document.xml to send');
    const list = (threads || []).filter((th) => th && th.comments && th.comments.length && th.start);
    if (!list.length) return { entries: out, paraIds: [] };
    const xml = doc.content;
    const paras = docRuns(xml);
    // comment paragraphs' ids: past every one the document has
    let top = 0;
    for (const m of xml.matchAll(/w14:paraId="([0-9A-Fa-f]{8})"/g)) top = Math.max(top, parseInt(m[1], 16));
    const next = paraIds(start === undefined ? top : start);
    // the marks, by where they go
    const at = new Map(); // position → { split, marks: [{ order, xml }] }
    const put = (pl, order, x) => {
      const key = pl.at + (pl.split ? 's' : '');
      if (!at.has(key)) at.set(key, { at: pl.at, split: pl.split || null, marks: [] });
      at.get(key).marks.push({ order, xml: x });
    };
    const firstUsable = (p) => {
      for (let q = Math.max(0, p); q < paras.length; q++) if (!paras[q].empty) return q;
      for (let q = Math.min(p, paras.length - 1); q >= 0; q--) if (!paras[q].empty) return q;
      return -1;
    };
    let id = 0;
    const comments = [];
    const ids = [];
    for (const th of list) {
      const ps = firstUsable(th.start.p);
      if (ps < 0) { ids.push([]); continue; }
      let os = ps === th.start.p ? th.start.o : 0;
      let pe = th.end ? firstUsable(th.end.p) : ps;
      let oe = th.end && pe === th.end.p ? th.end.o : os;
      if (pe < ps || (pe === ps && oe < os)) { pe = ps; oe = os; }
      os = Math.max(0, Math.min(os, paras[ps].len));
      oe = Math.max(0, Math.min(oe, paras[pe].len));
      const point = ps === pe && os === oe;
      const a = placeAt(xml, paras[ps], os, 'start');
      const b = point ? a : placeAt(xml, paras[pe], oe, 'end');
      const mine = [];
      const root = { pid: null };
      th.comments.forEach((c, i) => {
        const cid = id++;
        const lines = String(c.text || '').split('\n');
        const pids = lines.map(() => next());
        const pid = pids[pids.length - 1];
        if (i === 0) root.pid = pid;
        mine.push(pid);
        comments.push({ cid, c, lines, pids, pid, parent: i ? root.pid : '', done: !!th.resolved, durable: durable() });
        put(a, 1, '<w:commentRangeStart w:id="' + cid + '"/>');
        put(b, point ? 2 : 0, '<w:commentRangeEnd w:id="' + cid + '"/><w:r><w:commentReference w:id="' + cid + '"/></w:r>');
      });
      ids.push(mine);
    }
    // into the XML, from the end back
    let s = xml;
    for (const k of [...at.values()].sort((x, y) => y.at - x.at)) {
      const marks = k.marks.sort((x, y) => x.order - y.order).map((m) => m.xml).join('');
      const ins = k.split ? '</w:t></w:r>' + marks + '<w:r>' + k.split.rPr + '<w:t xml:space="preserve">' : marks;
      s = s.slice(0, k.at) + ins + s.slice(k.at);
    }
    doc.content = s.replace(/<w:document\b([^>]*)>/, (m, attrs) => {
      let x = attrs;
      if (!/xmlns:w14=/.test(x)) x += ' xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';
      return '<w:document' + x + '>';
    });

    const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const MC = 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
    const W14 = 'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';
    const W15 = 'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"';
    const CID = 'xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid"';
    const CEX = 'xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex"';
    const initials = (n) => String(n || '').split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 4).toUpperCase();
    const parts = {
      'word/comments.xml': HEAD + '<w:comments ' + W + ' ' + MC + ' ' + W14 + ' mc:Ignorable="w14">' + comments.map((x) =>
        '<w:comment w:id="' + x.cid + '" w:author="' + escAttr(x.c.author || '') + '" w:date="' + isoDate(x.c.date) + '" w:initials="' + escAttr(x.c.initials || initials(x.c.author)) + '">' +
        x.lines.map((line, i) => '<w:p w14:paraId="' + x.pids[i] + '" w14:textId="77777777">' +
          (i === 0 ? '<w:r><w:annotationRef/></w:r>' : '') +
          (line ? '<w:r><w:t xml:space="preserve">' + escText(line) + '</w:t></w:r>' : '') + '</w:p>').join('') +
        '</w:comment>').join('') + '</w:comments>',
      'word/commentsExtended.xml': HEAD + '<w15:commentsEx ' + MC + ' ' + W15 + ' mc:Ignorable="w15">' + comments.map((x) =>
        '<w15:commentEx w15:paraId="' + x.pid + '"' + (x.parent ? ' w15:paraIdParent="' + x.parent + '"' : '') + ' w15:done="' + (x.done ? 1 : 0) + '"/>').join('') + '</w15:commentsEx>',
      'word/commentsIds.xml': HEAD + '<w16cid:commentsIds ' + MC + ' ' + CID + ' mc:Ignorable="w16cid">' + comments.map((x) =>
        '<w16cid:commentId w16cid:paraId="' + x.pid + '" w16cid:durableId="' + x.durable + '"/>').join('') + '</w16cid:commentsIds>',
      'word/commentsExtensible.xml': HEAD + '<w16cex:commentsExtensible ' + MC + ' ' + CEX + ' mc:Ignorable="w16cex">' + comments.map((x) =>
        '<w16cex:commentExtensible w16cex:durableId="' + x.durable + '" w16cex:dateUtc="' + isoDate(x.c.date) + '"/>').join('') + '</w16cex:commentsExtensible>',
      'word/people.xml': HEAD + '<w15:people ' + MC + ' ' + W15 + ' mc:Ignorable="w15">' + [...new Set(comments.map((x) => x.c.author || ''))].filter(Boolean).map((n) =>
        '<w15:person w15:author="' + escAttr(n) + '"><w15:presenceInfo w15:providerId="None" w15:userId="' + escAttr(n) + '"/></w15:person>').join('') + '</w15:people>'
    };
    const TYPES = {
      'word/comments.xml': ['http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments', 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml'],
      'word/commentsExtended.xml': ['http://schemas.microsoft.com/office/2011/relationships/commentsExtended', 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml'],
      'word/commentsIds.xml': ['http://schemas.microsoft.com/office/2016/09/relationships/commentsIds', 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsIds+xml'],
      'word/commentsExtensible.xml': ['http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible', 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtensible+xml'],
      'word/people.xml': ['http://schemas.microsoft.com/office/2011/relationships/people', 'application/vnd.openxmlformats-officedocument.wordprocessingml.people+xml']
    };
    const rels = get('word/_rels/document.xml.rels');
    for (const [path, content] of Object.entries(parts)) {
      const had = get(path);
      if (had) { had.content = content; continue; }
      out.push({ path, content });
      if (rels && !rels.content.includes('Target="' + path.slice(5) + '"')) addRel(rels, TYPES[path][0], path.slice(5));
      addType(get('[Content_Types].xml'), '/' + path, TYPES[path][1]);
    }
    return { entries: out, paraIds: ids };
  }
  function addRel(entry, type, target) {
    if (!entry) return;
    const ids = [...entry.content.matchAll(/Id="rId(\d+)"/g)].map((m) => +m[1]);
    const id = 'rId' + ((ids.length ? Math.max(...ids) : 0) + 1);
    entry.content = entry.content.replace('</Relationships>', '<Relationship Id="' + id + '" Type="' + type + '" Target="' + target + '"/>\n</Relationships>');
  }
  function addType(entry, part, type) {
    if (!entry || entry.content.includes('PartName="' + part + '"')) return;
    entry.content = entry.content.replace('</Types>', '<Override PartName="' + part + '" ContentType="' + type + '"/>\n</Types>');
  }

  exports.roundId = roundId;
  exports.paraIds = paraIds;
  exports.chapterMark = chapterMark;
  exports.withBookmark = withBookmark;
  exports.forReview = forReview;
  exports.withComments = withComments;

  exports.tokens = tokens;
  exports.parse = parse;
  exports.joined = joined;
  exports.summary = summary;
  exports.readDocx = readDocx;
  exports.readStyles = readStyles;
  exports.PART_NAMES = PART_NAMES;
})(typeof module !== 'undefined' && module.exports ? module.exports : (globalThis.ReviewDocx = {}));
