// Matching an editor's Word file to the book it came from (phase 6, the
// Word round-trip): which chapter each part of the file is, what the
// editor changed with Track Changes on (and without it), and their comments,
// as suggestions and threads anchored in the text. Nothing here touches a
// chapter; the window keeps what this gives in review.json.
//
// A chapter is read as one string: its paragraphs joined by U+2029 (PARA),
// so a paragraph split or joined is a change like any other, and a line
// break inside a paragraph ("\n") stays one. Anchors are quotes from that
// string, { exact, pre, post, o, p }: the text a change replaces (empty for
// an insertion), up to 32 characters each side, and where it was (offset
// and paragraph, hints only). `findAnchor` finds one again in the text as
// it is today, or says it can't (the writer has rewritten the passage).
//
// Plain JavaScript with no Node or browser APIs; SlogDiff (slog-diff.js) is
// required in Node and found on globalThis in the window.

'use strict';

(function (exports) {
  const SD = typeof module !== 'undefined' && module.exports ? require('./slog-diff.js') : globalThis.SlogDiff;
  const RD = typeof module !== 'undefined' && module.exports ? require('./review-docx.js') : globalThis.ReviewDocx;

  const PARA = '\u2029';
  const CONTEXT = 32;
  const MARK_RE = /^_NEO_ch_(\d+)$/;

  // -------------------------------------------------------------------------
  // The book's side: a chapter's saved HTML as one string
  // -------------------------------------------------------------------------

  // Paragraphs as the manuscript has them (SlogDiff's reading: no ghosts,
  // no empty lines), a scene break as the *** NEO's Word file writes
  function htmlParas(html) {
    return SD.paragraphs(html || '').map((p) => (p.brk ? '***' : p.runs.map((r) => r.t).join('')));
  }
  function htmlText(html) { return htmlParas(html).join(PARA); }

  // -------------------------------------------------------------------------
  // The file's side: its chapters
  // -------------------------------------------------------------------------

  const blank = (s) => !/\S/.test(s || '');
  const changed = (s) => s.ins >= 0 || s.del >= 0 || s.fmt >= 0;

  // The file's paragraphs cut into sections. A NEO file has a bookmark at
  // each section's first paragraph (_NEO_ch_<num>, num as the round's
  // `chapters` list it) and others where something that isn't a chapter
  // starts (the contents page). A file without them is cut at its headings.
  // Returns { how: 'bookmarks' | 'headings' | 'none', sections: [{ num,
  // title, heading (the paragraph), paras: [paragraph] }] }, the paragraphs
  // before the first section (a title page) left out.
  function sectionsOf(model) {
    const marked = model.paragraphs.some((p) => p.bookmarks.some((b) => MARK_RE.test(b.name)));
    const sections = [];
    let cur = null;
    for (const p of model.paragraphs) {
      if (marked) {
        const mk = p.bookmarks.find((b) => b.name.startsWith('_NEO_'));
        if (mk) {
          const m = MARK_RE.exec(mk.name);
          cur = m ? { num: +m[1], heading: null, paras: [] } : null;
          if (cur) sections.push(cur);
        }
      } else if (p.heading) {
        cur = { num: null, heading: null, paras: [] };
        sections.push(cur);
      }
      if (!cur) continue;
      if (p.heading && !cur.heading && !cur.paras.length) { cur.heading = p; continue; }
      cur.paras.push(p);
    }
    if (!marked && !sections.length) {
      // no headings at all: the whole file is one stretch of text
      sections.push({ num: null, heading: null, paras: model.paragraphs.slice() });
    }
    for (const s of sections) {
      s.title = s.heading ? s.heading.after.replace(/\s+/g, ' ').trim() : '';
      s.titleBefore = s.heading ? s.heading.before.replace(/\s+/g, ' ').trim() : '';
      // the paragraphs that are the section's text: not the blank one NEO
      // puts under a heading, unless the editor wrote in it
      s.paras = s.paras.filter((p) => !(blank(p.after) && blank(p.before) && !p.segs.some(changed)));
    }
    return { how: marked ? 'bookmarks' : model.paragraphs.some((p) => p.heading) ? 'headings' : 'none', sections };
  }

  // One section as a stream of pieces: each paragraph's pieces, then its
  // mark (PARA) between it and the next. Returns { pieces, before, after,
  // starts } where starts[i] is where the section's i-th paragraph starts in
  // `before` (and paraAt maps a file paragraph index to i).
  function streamOf(section) {
    const pieces = [];
    const startsB = [];
    const startsA = [];
    const paraAt = new Map();
    let before = '';
    let after = '';
    section.paras.forEach((p, i) => {
      paraAt.set(p.index, i);
      startsB.push(before.length);
      startsA.push(after.length);
      for (const s of p.segs) {
        pieces.push({ text: s.text, ins: s.ins, del: s.del, fmt: s.fmt, b: s.b, i: s.i, o: before.length, a: after.length, para: p.index });
        if (s.del < 0) after += s.text;
        if (s.ins < 0) before += s.text;
      }
      if (i < section.paras.length - 1) {
        pieces.push({ text: PARA, ins: p.mark.ins, del: p.mark.del, fmt: -1, mark: true, o: before.length, a: after.length, para: p.index });
        if (p.mark.del < 0) after += PARA;
        if (p.mark.ins < 0) before += PARA;
      }
    });
    return { pieces, before, after, startsB, startsA, paraAt };
  }

  // -------------------------------------------------------------------------
  // Anchors
  // -------------------------------------------------------------------------

  function anchorIn(text, o, len) {
    const p = paraIndexAt(text, o);
    return {
      exact: text.slice(o, o + len),
      pre: text.slice(Math.max(0, o - CONTEXT), o),
      post: text.slice(o + len, o + len + CONTEXT),
      o, p
    };
  }
  function paraIndexAt(text, o) {
    let n = 0;
    for (let i = text.indexOf(PARA); i >= 0 && i < o; i = text.indexOf(PARA, i + 1)) n++;
    return n;
  }
  // how many characters two strings share at the end (a) and start (b)
  function sharedEnd(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
  }
  function sharedStart(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  }

  // Where an anchor is in `text` now: { o, len, sure } or null. The exact
  // words must be there; of the places they are, the one whose words around
  // agree best (and, between equals, nearest where it was) wins. An
  // insertion (no exact words) needs its context on both sides. `sure` is
  // whether the context agreed in full.
  function findAnchor(text, anchor) {
    if (!anchor) return null;
    const exact = anchor.exact || '';
    const pre = anchor.pre || '';
    const post = anchor.post || '';
    const hint = Number.isFinite(anchor.o) ? anchor.o : 0;
    let best = null;
    const consider = (o) => {
      const before = text.slice(Math.max(0, o - pre.length), o);
      const after = text.slice(o + exact.length, o + exact.length + post.length);
      const score = sharedEnd(before, pre) + sharedStart(after, post);
      const dist = Math.abs(o - hint);
      if (!best || score > best.score || (score === best.score && dist < best.dist)) best = { o, score, dist };
    };
    if (exact) {
      for (let i = text.indexOf(exact); i >= 0; i = text.indexOf(exact, i + 1)) consider(i);
    } else {
      // an insertion: the join of its two sides (as much of each as can be had)
      const seam = pre.slice(-Math.min(pre.length, 12)) + post.slice(0, Math.min(post.length, 12));
      if (!seam) return text.length === 0 ? { o: 0, len: 0, sure: true } : null;
      const back = Math.min(pre.length, 12);
      for (let i = text.indexOf(seam); i >= 0; i = text.indexOf(seam, i + 1)) consider(i + back);
    }
    if (!best) return null;
    const full = pre.length + post.length;
    // without its exact words an insertion is placed only by its context;
    // a short exact phrase needs some context too, or any "the" would do
    const enough = exact ? (exact.length >= 12 || best.score >= Math.min(full, 8)) : best.score >= Math.min(full, 8);
    if (!enough) return null;
    return { o: best.o, len: exact.length, sure: best.score === full };
  }

  // -------------------------------------------------------------------------
  // Tracked changes into suggestions
  // -------------------------------------------------------------------------

  // Consecutive changed pieces by one person become one suggestion: what
  // they took out, what they put in. Moves are one suggestion each (where
  // the words went from, and to). A piece one person put in and another
  // took out (a file passed on) is in neither text and makes none; it's
  // counted. Formatting changes on text that was otherwise left are their
  // own suggestions (kind 'format').
  function trackedSuggestions(stream, model) {
    const { pieces, before } = stream;
    const out = [];
    const changes = model.changes;
    const who = (n) => (n >= 0 && changes[n] ? changes[n].author : '');
    const when = (n) => (n >= 0 && changes[n] ? changes[n].date : '');
    let cancelled = 0;
    let run = null;
    const flush = () => {
      if (!run) return;
      const del = run.del;
      const ins = run.ins;
      if (del || ins) {
        out.push({
          kind: del && ins ? 'replace' : del ? 'delete' : 'insert',
          reviewer: run.author, date: run.date, del, ins,
          anchor: anchorIn(before, run.o, del.length)
        });
      }
      run = null;
    };
    const moves = new Map();
    for (const pc of pieces) {
      const c = pc.ins >= 0 ? changes[pc.ins] : pc.del >= 0 ? changes[pc.del] : null;
      if (pc.ins >= 0 && pc.del >= 0) { cancelled++; continue; }
      if (c && (c.type === 'moveFrom' || c.type === 'moveTo') && c.move) {
        flush();
        const m = moves.get(c.move) || { from: '', fromAt: -1, to: '', toAt: -1, author: c.author, date: c.date };
        if (c.type === 'moveFrom') { if (m.fromAt < 0) m.fromAt = pc.o; m.from += pc.text; } else { if (m.toAt < 0) m.toAt = pc.o; m.to += pc.text; }
        moves.set(c.move, m);
        continue;
      }
      if (!c) {
        // unchanged text ends a run; a formatting change on it is its own
        flush();
        if (pc.fmt >= 0) {
          const f = changes[pc.fmt];
          const last = out[out.length - 1];
          if (last && last.kind === 'format' && last._fmt === pc.fmt && last.anchor.o + last.anchor.exact.length === pc.o) {
            last.anchor = anchorIn(before, last.anchor.o, last.anchor.exact.length + pc.text.length);
            last.text += pc.text;
          } else {
            out.push({ kind: 'format', reviewer: f.author, date: f.date, text: pc.text, was: f.was || null, now: f.now || null, anchor: anchorIn(before, pc.o, pc.text.length), _fmt: pc.fmt });
          }
        }
        continue;
      }
      const author = who(pc.ins >= 0 ? pc.ins : pc.del);
      if (run && run.author !== author) flush();
      if (!run) run = { author, date: when(pc.ins >= 0 ? pc.ins : pc.del), o: pc.o, del: '', ins: '' };
      if (pc.del >= 0) run.del += pc.text; else run.ins += pc.text;
    }
    flush();
    for (const m of moves.values()) {
      const from = m.fromAt >= 0 ? anchorIn(before, m.fromAt, m.from.length) : null;
      const to = m.toAt >= 0 ? anchorIn(before, m.toAt, 0) : null;
      out.push({ kind: 'move', reviewer: m.author, date: m.date, del: m.from, ins: m.to, anchor: from || to, to });
    }
    for (const s of out) delete s._fmt;
    return { suggestions: out, cancelled };
  }

  // -------------------------------------------------------------------------
  // Changes made without Track Changes: the file's "before" against the
  // text as it was sent
  // -------------------------------------------------------------------------

  const TOKEN = /\u2029|[\p{L}\p{N}\p{M}]+(?:['’-][\p{L}\p{N}\p{M}]+)*|[^\S\u2029]+|[\s\S]/gu;
  const PARA_EDITS = 3000;
  const WORD_EDITS = 3000;

  // [aStart, aEnd, bStart, bEnd] of each changed stretch between two
  // chapter strings: paragraphs matched first, then words inside the
  // stretches that differ. A space alone between two changes joins them.
  function textHunks(a, b) {
    if (a === b) return [];
    const pa = a.split(PARA);
    const pb = b.split(PARA);
    const offs = (ps) => { const o = [0]; for (const p of ps) o.push(o[o.length - 1] + p.length + 1); return o; };
    const oa = offs(pa);
    const ob = offs(pb);
    const matched = SD.matchSeq(pa, pb, PARA_EDITS) || [];
    const hunks = [];
    let ia = 0;
    let ib = 0;
    for (const [mx, my] of [...matched, [pa.length, pb.length]]) {
      if (mx > ia || my > ib) {
        // the stretch's text, with the paragraph marks inside it
        let a0 = oa[ia];
        const a1 = Math.min(a.length, oa[mx]);
        let b0 = ob[ib];
        const b1 = Math.min(b.length, ob[my]);
        // paragraphs added (or taken) at the very end bring the mark before
        // them, not after
        if (mx === pa.length && my === pb.length && (ia === mx || ib === my) && ia > 0 && ib > 0) { a0--; b0--; }
        for (const h of wordHunks(a.slice(a0, a1), b.slice(b0, b1))) hunks.push([h[0] + a0, h[1] + a0, h[2] + b0, h[3] + b0]);
      }
      ia = mx + 1;
      ib = my + 1;
    }
    return hunks;
  }
  function wordHunks(a, b) {
    const ta = a.match(TOKEN) || [];
    const tb = b.match(TOKEN) || [];
    const m = SD.matchSeq(ta, tb, WORD_EDITS);
    if (!m) return [[0, a.length, 0, b.length]];
    const ca = [0];
    for (const t of ta) ca.push(ca[ca.length - 1] + t.length);
    const cb = [0];
    for (const t of tb) cb.push(cb[cb.length - 1] + t.length);
    let hunks = [];
    let ia = 0;
    let ib = 0;
    for (const [mx, my] of [...m, [ta.length, tb.length]]) {
      if (mx > ia || my > ib) hunks.push([ca[ia], ca[mx], cb[ib], cb[my]]);
      ia = mx + 1;
      ib = my + 1;
    }
    // a lone space (or a mark) between two changes joins them
    const joined = [];
    for (const h of hunks) {
      const last = joined[joined.length - 1];
      if (last && h[0] - last[1] <= 1 && h[2] - last[3] <= 1 && /^\s?$/.test(a.slice(last[1], h[0])) && a.slice(last[1], h[0]) === b.slice(last[3], h[2])) {
        last[1] = h[1];
        last[3] = h[3];
      } else joined.push(h.slice());
    }
    hunks = joined;
    return hunks;
  }

  function untrackedSuggestions(sent, before, reviewer) {
    return textHunks(sent, before).map(([a0, a1, b0, b1]) => {
      const del = sent.slice(a0, a1);
      const ins = before.slice(b0, b1);
      return { kind: del && ins ? 'replace' : del ? 'delete' : 'insert', reviewer, date: '', del, ins, untracked: true, anchor: anchorIn(sent, a0, a1 - a0) };
    });
  }

  // -------------------------------------------------------------------------
  // Chapters: which of the book's is each of the file's
  // -------------------------------------------------------------------------

  function wordBag(text) {
    const m = new Map();
    let n = 0;
    for (const w of String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) { m.set(w, (m.get(w) || 0) + 1); n++; }
    return { m, n };
  }
  // how alike two texts' words are, 0 to 1
  function likeness(a, b) {
    const x = typeof a === 'string' ? wordBag(a) : a;
    const y = typeof b === 'string' ? wordBag(b) : b;
    if (!x.n || !y.n) return 0;
    let common = 0;
    for (const [w, c] of x.m) common += Math.min(c, y.m.get(w) || 0);
    return (2 * common) / (x.n + y.n);
  }
  const normTitle = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();

  // `chapters`: the book's as sent, [{ id, num, title, kind, text }] (num as
  // the round listed it, if it did). Returns, for each section, the id of the
  // book's chapter it is (or null) and how it was found.
  function assignChapters(secs, chapters) {
    const byNum = new Map(chapters.filter((c) => c.num != null).map((c) => [c.num, c]));
    const taken = new Set();
    const out = secs.map((s) => {
      if (s.num != null && byNum.has(s.num)) {
        const c = byNum.get(s.num);
        taken.add(c.id);
        return { id: c.id, by: 'bookmark' };
      }
      return null;
    });
    // by title, then by text
    secs.forEach((s, i) => {
      if (out[i]) return;
      const t = normTitle(s.titleBefore || s.title);
      if (!t) return;
      const c = chapters.find((x) => !taken.has(x.id) && normTitle(x.title) === t);
      if (c) { taken.add(c.id); out[i] = { id: c.id, by: 'title' }; }
    });
    secs.forEach((s, i) => {
      if (out[i]) return;
      const bag = wordBag(streamOf(s).before);
      let best = null;
      for (const c of chapters) {
        if (taken.has(c.id)) continue;
        const l = likeness(bag, wordBag(c.text));
        if (!best || l > best.l) best = { c, l };
      }
      if (best && best.l >= 0.5) { taken.add(best.c.id); out[i] = { id: best.c.id, by: 'text' }; } else out[i] = { id: null, by: 'none' };
    });
    return out;
  }

  // -------------------------------------------------------------------------
  // The whole file
  // -------------------------------------------------------------------------

  // model: review-docx's parse of the file. chapters: the book's chapters as
  // the file was sent from them ([{ id, num, title, kind, text }], text as
  // htmlText gives it). fallback: the name for changes nobody's name is on
  // (made without Track Changes: the editor the round went to). Returns
  // { how, chapters: [{ id, by, title, titleBefore }], suggestions, threads,
  // counts: { reviewer: { changes, comments, untracked, formatting } },
  // cancelled, unplaced (sections that matched no chapter) }. Suggestions
  // and threads carry `chapter` (an id, or null) but no ids of their own.
  // an ordinary object from a prototype-free map, every key its own (even
  // __proto__, a name a file could give)
  const plain = (d) => {
    const o = {};
    for (const k of Object.keys(d)) Object.defineProperty(o, k, { value: d[k], enumerable: true, writable: true, configurable: true });
    return o;
  };

  function match(model, chapters, { fallback = '' } = {}) {
    const { how, sections } = sectionsOf(model);
    const ids = assignChapters(sections, chapters);
    const byId = new Map(chapters.map((c) => [c.id, c]));
    const suggestions = [];
    const counts = Object.create(null);
    const count = (name, k) => { const c = counts[name] || (counts[name] = { changes: 0, comments: 0, untracked: 0, formatting: 0 }); c[k]++; };
    let cancelled = 0;
    let unplaced = 0;
    const where = new Map(); // file paragraph → { chapter, stream, i }
    const out = sections.map((s, k) => {
      const chId = ids[k].id;
      const stream = streamOf(s);
      s.paras.forEach((p, i) => where.set(p.index, { chId, stream, i }));
      if (s.heading) where.set(s.heading.index, { chId, stream: null, i: -1 });
      if (!chId) unplaced++;
      const tracked = trackedSuggestions(stream, model);
      cancelled += tracked.cancelled;
      for (const sg of tracked.suggestions) {
        sg.chapter = chId;
        suggestions.push(sg);
        count(sg.reviewer, sg.kind === 'format' ? 'formatting' : 'changes');
      }
      // the title, changed on its heading
      if (s.heading && s.heading.segs.some((x) => x.ins >= 0 || x.del >= 0) && s.title !== s.titleBefore) {
        const c = s.heading.segs.find((x) => x.ins >= 0 || x.del >= 0);
        const ch = model.changes[c.ins >= 0 ? c.ins : c.del];
        suggestions.push({ kind: 'title', reviewer: ch.author, date: ch.date, del: s.titleBefore, ins: s.title, chapter: chId, anchor: null });
        count(ch.author, 'changes');
      }
      // without Track Changes: what the file had before the editor's
      // tracked changes, against what was sent
      const sent = chId && byId.get(chId);
      if (sent) {
        // a part's title is set on its heading, under the part's label; NEO
        // keeps it as the part page's first line
        let sentText = sent.text;
        if (sent.kind === 'part' && s.heading) {
          const lines = s.heading.before.split('\n').map((x) => x.trim()).filter(Boolean);
          const first = sentText.split(PARA)[0];
          if (lines.length > 1 && lines[lines.length - 1] === first.trim()) sentText = sentText.slice(first.length + 1);
        }
        for (const sg of untrackedSuggestions(sentText, stream.before, fallback)) {
          sg.chapter = chId;
          suggestions.push(sg);
          count(fallback, 'untracked');
        }
      }
      return { id: chId, by: ids[k].by, title: s.title, titleBefore: s.titleBefore };
    });

    // comments: a thread per first comment, its replies in order
    const threads = [];
    const byCid = new Map();
    const placeOf = (pos) => {
      if (!pos) return null;
      const w = where.get(pos.p);
      if (!w) return null;
      // (on a heading: the chapter, with no place in its text)
      return { chId: w.chId, stream: w.stream, o: w.stream ? w.stream.startsB[w.i] + pos.o : 0 };
    };
    const rootOf = (c) => {
      let r = c;
      for (let k = 0; k < 20 && r.parent != null && byCid.has(r.parent); k++) r = byCid.get(r.parent);
      return r;
    };
    for (const c of model.comments) byCid.set(c.id, c);
    const threadOf = new Map();
    const taken = new Set();
    const add = (th, c) => {
      if (taken.has(c)) return;
      taken.add(c);
      th.comments.push({ by: c.author, at: c.dateUtc || c.date, text: c.text, paraId: c.paraId || '' });
      count(c.author, 'comments');
    };
    // (a reply can come before what it answers in the file: LibreOffice
    // writes them so; the first comment is always the thread's own)
    for (const c of model.comments) {
      const root = rootOf(c);
      let th = threadOf.get(root.id);
      if (!th) {
        const s = placeOf(root.start || root.ref);
        const e = placeOf(root.end || root.ref);
        let anchor = null;
        if (s && s.stream) {
          const end = e && e.stream === s.stream && e.o >= s.o ? e.o : s.o;
          anchor = anchorIn(s.stream.before, s.o, end - s.o);
        }
        th = { chapter: s ? s.chId : null, anchor, resolved: !!root.done, fileResolved: !!root.done, comments: [], paraId: root.paraId || '' };
        threadOf.set(root.id, th);
        threads.push(th);
        add(th, root);
      }
      add(th, c);
    }
    return { how, chapters: out, suggestions, threads, counts: plain(counts), cancelled, unplaced };
  }

  // -------------------------------------------------------------------------
  // Threads that come back (M5): a thread sent to an editor and returned is
  // the same thread, not a second one
  // -------------------------------------------------------------------------

  const said = (c) => String((c && c.by) || '').trim().toLowerCase() + '\u0000' + String((c && c.text) || '').replace(/\s+/g, ' ').trim();
  const idsOf = (c) => [c.paraId, ...(Array.isArray(c.sent) ? c.sent : [])].filter(Boolean);

  // `known`: review.json's threads; `found`: an import's (match()'s
  // threads). A found thread is a known one when one of its comments has a
  // paragraph id a known comment had (Word's own, or the one NEO sent it
  // with), or its first comment is a known thread's first (the same person,
  // the same words). Its comments that aren't in the known thread already
  // are added in order; resolved or not follows the file where the editor
  // changed it (`fileResolved`: what the last file said); a deleted thread
  // that gets an answer comes back. Changes `known` in place. Returns
  // { added: [found threads that are new], merged: n, repeats: { name: n }
  // (comments already known, by who wrote them) }.
  function mergeThreads(known, found) {
    const byId = new Map();
    const byFirst = new Map();
    for (const th of known) {
      for (const c of th.comments || []) for (const id of idsOf(c)) byId.set(id, th);
      if (th.comments && th.comments[0]) byFirst.set(said(th.comments[0]), th);
    }
    const added = [];
    const repeats = Object.create(null);
    let merged = 0;
    // by the words alone (a file whose ids were all renewed) only over the
    // same words, in the same chapter, once per import, and never into a
    // thread the writer deleted: editors say "Cut?" more than once
    const norm = (a) => String((a && a.exact) || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const samePlace = (th, f) => {
      if (th.chapter && f.chapter && th.chapter !== f.chapter) return false;
      const a = norm(th.anchor);
      const b = norm(f.anchor);
      return !a || !b || a === b || a.includes(b) || b.includes(a);
    };
    const paired = new Set();
    for (const f of found) {
      let th = null;
      for (const c of f.comments) { const hit = c.paraId && byId.get(c.paraId); if (hit) { th = hit; break; } }
      if (!th && f.comments[0]) {
        const k = byFirst.get(said(f.comments[0])) || null;
        if (k && !paired.has(k) && !k.deleted && samePlace(k, f)) th = k;
      }
      if (!th) { added.push(f); continue; }
      paired.add(th);
      merged++;
      let fresh = 0;
      for (const c of f.comments) {
        const ids = new Set(th.comments.flatMap(idsOf));
        const has = th.comments.find((k) => (c.paraId && ids.has(c.paraId) && idsOf(k).includes(c.paraId)) || said(k) === said(c));
        if (has) {
          if (c.paraId && !idsOf(has).includes(c.paraId)) has.sent = [...(has.sent || []), c.paraId];
          repeats[c.by] = (repeats[c.by] || 0) + 1;
          continue;
        }
        th.comments.push(c);
        fresh++;
      }
      // resolved or not: the editor's say when the file differs from what
      // NEO last knew it to say (sent or read), else the writer's since
      const was = th.fileResolved === undefined ? !!th.resolved : !!th.fileResolved;
      if (!!f.resolved !== was) th.resolved = !!f.resolved;
      th.fileResolved = !!f.resolved;
      if (fresh && th.deleted) { delete th.deleted; th.resolved = false; }
      // where it is now, from the file just read (a later version's text)
      if (f.anchor) { th.anchor = f.anchor; th.chapter = f.chapter; }
    }
    return { added, merged, repeats: plain(repeats) };
  }

  // How close a file is to a version of the book, 0 to 1 (for choosing which
  // version a file with no round of NEO's was sent from)
  function closeness(model, chapters) {
    const file = RD.joined(model, 'before').map((p) => p.text).join(' ');
    return likeness(file, chapters.map((c) => c.text).join(' '));
  }

  // -------------------------------------------------------------------------
  // How the Scribe's Log names a reviewer (decision 2, kept in this one
  // place so it's easy to change): never by name, only "Reviewer 1",
  // "Reviewer 2", numbered per book in the order they were first imported
  // (review.json's `reviewers`, each with its `num`). The names stay in
  // review.json; the Verification Report shows them only when asked.
  // -------------------------------------------------------------------------

  const numOf = (reviewers, r) => (Number.isSafeInteger(r.num) && r.num > 0 ? r.num : reviewers.indexOf(r) + 1);
  function reviewerTag(reviewers, name) {
    const list = Array.isArray(reviewers) ? reviewers : [];
    const r = list.find((x) => x && x.name === name);
    return r ? 'Reviewer ' + numOf(list, r) : null;
  }
  // { "Reviewer 1": "Dana", … }
  function reviewerNames(reviewers) {
    const list = Array.isArray(reviewers) ? reviewers : [];
    const out = {};
    for (const r of list) if (r && typeof r.name === 'string' && r.name.trim()) out['Reviewer ' + numOf(list, r)] = r.name.trim();
    return out;
  }
  // the next reviewer's number
  const nextNum = (reviewers) => (Array.isArray(reviewers) ? reviewers : []).reduce((m, r, i) => Math.max(m, r && Number.isSafeInteger(r.num) ? r.num : i + 1), 0) + 1;

  // -------------------------------------------------------------------------
  // review.json from two places at once: this window's copy and the file
  // as another computer (or another of this window's own steps) left it.
  // `base` is what this copy was read as. Nothing in review.json is ever
  // taken out, only added or changed, so the two are put together item by
  // item: one only one side has stays; one both have is this copy's if it
  // changed it since `base`, else the file's; a thread keeps every comment
  // either side has. Two editors numbered alike on two computers are
  // numbered apart again, the same way on both (by name).
  // -------------------------------------------------------------------------
  const REVIEW_LISTS = { rounds: 'id', imports: 'id', suggestions: 'id', threads: 'id', reviewers: 'name' };
  const commentKey = (c) => (c && c.paraId) || [(c && c.by) || '', (c && c.at) || '', (c && c.text) || ''].join('\u0000');
  function mergeReview(base, local, remote) {
    const J = (x) => JSON.stringify(x);
    const out = Object.assign({}, local);
    for (const [list, idk] of Object.entries(REVIEW_LISTS)) {
      const L = Array.isArray(local && local[list]) ? local[list] : [];
      const R = Array.isArray(remote && remote[list]) ? remote[list] : [];
      const B = new Map((Array.isArray(base && base[list]) ? base[list] : []).filter((e) => e && e[idk] != null).map((e) => [e[idk], J(e)]));
      const byR = new Map(R.filter((e) => e && e[idk] != null).map((e) => [e[idk], e]));
      const inL = new Set();
      const merged = L.map((e) => {
        if (!e || e[idk] == null) return e;
        inL.add(e[idk]);
        const r = byR.get(e[idk]);
        if (!r || J(r) === J(e)) return e;
        if (B.has(e[idk]) && B.get(e[idk]) === J(e)) return r; // untouched here: the file's
        if (list === 'threads') {
          const have = new Set((e.comments || []).map(commentKey));
          const more = (r.comments || []).filter((c) => !have.has(commentKey(c)));
          return more.length ? Object.assign({}, e, { comments: [...(e.comments || []), ...more] }) : e;
        }
        return e;
      });
      for (const r of R) if (r && r[idk] != null && !inL.has(r[idk])) merged.push(r);
      out[list] = merged;
    }
    const eds = [...(Array.isArray(local && local.editors) ? local.editors : [])];
    for (const n of Array.isArray(remote && remote.editors) ? remote.editors : []) if (!eds.includes(n)) eds.push(n);
    out.editors = eds.slice(0, 12);
    // one number, one editor
    const seen = new Map();
    const again = [];
    const revs = out.reviewers.map((r) => Object.assign({}, r));
    revs.forEach((r, i) => { if (!Number.isSafeInteger(r.num) || r.num < 1) r.num = i + 1; });
    for (const r of [...revs].sort((a, b) => a.num - b.num || String(a.name).localeCompare(String(b.name)))) {
      if (seen.has(r.num)) again.push(r); else seen.set(r.num, r);
    }
    let top = Math.max(0, ...seen.keys());
    for (const r of again) r.num = ++top;
    out.reviewers = revs;
    return out;
  }

  exports.reviewerTag = reviewerTag;
  exports.mergeReview = mergeReview;
  exports.reviewerNames = reviewerNames;
  exports.nextNum = nextNum;
  exports.PARA = PARA;
  exports.htmlParas = htmlParas;
  exports.htmlText = htmlText;
  exports.sectionsOf = sectionsOf;
  exports.streamOf = streamOf;
  exports.anchorIn = anchorIn;
  exports.findAnchor = findAnchor;
  exports.textHunks = textHunks;
  exports.likeness = likeness;
  exports.assignChapters = assignChapters;
  exports.match = match;
  exports.closeness = closeness;
  exports.mergeThreads = mergeThreads;
})(typeof module !== 'undefined' && module.exports ? module.exports : (globalThis.ReviewMatch = {}));
