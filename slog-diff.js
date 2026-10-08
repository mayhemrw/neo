'use strict';

// DIFFS, shared by the Scribe's Log and the History window.
//
//   diff / tokenHunks   what changed between two versions of a document,
//                       as the log records it (moved here from slog.js,
//                       which still exports them; nothing about them changed)
//   paragraphs          a chapter's saved HTML read as paragraphs of styled
//                       text, the way the manuscript sees it
//   compare             two versions of a chapter side by side in one
//                       column: paragraphs matched, then words within the
//                       paragraphs that changed, with unchanged stretches
//                       folded away
//   toHtml / viewHtml   what the History window shows: clean markup built
//                       from that reading, never the saved HTML itself
//
// Plain JavaScript with no dependencies: main.js and the tests require it,
// the window loads it with a <script> tag (globalThis.SlogDiff), and the
// verifier can inline it.

(function (api) {
  const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
  const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

  /* ---------------------------------------------------------------- */
  /*  Myers' diff                                                      */
  /* ---------------------------------------------------------------- */

  // Myers' O(ND) diff over two lists. Returns the [x, y] index pairs of
  // the items that are the same in both (in order), or null when the two
  // differ in more than `max` edits. Each step keeps only the stretch of
  // diagonals it reached, so a long comparison needs memory in proportion
  // to the square of its edits, not of `max`.
  function matchSeq(ta, tb, max, same = (p, q) => p === q) {
    const N = ta.length;
    const M = tb.length;
    const limit = Math.min(max, N + M);
    const off = limit + 1;
    const v = new Int32Array(2 * off + 1);
    const trace = []; // trace[d]: v's diagonals -d-1..d+1 as step d began
    let found = -1;
    for (let d = 0; d <= limit && found < 0; d++) {
      trace.push(v.slice(off - d - 1, off + d + 2));
      for (let k = -d; k <= d; k += 2) {
        let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < N && y < M && same(ta[x], tb[y])) { x++; y++; }
        v[off + k] = x;
        if (x >= N && y >= M) { found = d; break; }
      }
    }
    if (found < 0) return null;
    // walk back from the end, collecting the matched runs
    const matches = [];
    let x = N;
    let y = M;
    for (let d = found; d > 0; d--) {
      const vp = trace[d];
      const at = (k) => vp[k + d + 1];
      const k = x - y;
      const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
      const px = at(prevK);
      const py = px - prevK;
      while (x > px && y > py) { x--; y--; matches.push([x, y]); }
      x = px;
      y = py;
    }
    while (x > 0 && y > 0) { x--; y--; matches.push([x, y]); }
    return matches.reverse();
  }

  /* ---------------------------------------------------------------- */
  /*  What the log records                                             */
  /* ---------------------------------------------------------------- */

  // Ops are [at, del, ins] in UTF-16 units of the document's saved HTML,
  // applied in order, each `at` measured after the ops before it. The
  // inserted strings travel separately (an entry's x.ins), one per op.

  // Tokens for the word-level pass: a tag, a word, or a run of spaces.
  const TOKEN_RE = /<[^>]*>|[^\s<]+|\s+|</g;
  const MAX_EDITS = 256;      // tokens; past this a burst is one replacement
  const SPLIT_FROM = 32;      // a middle shorter than this is one op anyway

  // Two edits far apart in one burst (typing here, then a click and a word
  // there) must not become one replacement of everything between them: that
  // would claim the untouched text was retyped. So past the shared start and
  // end, the middles are compared word by word (Myers' algorithm, capped).
  function diff(a, b) {
    if (a === b) return { ops: [], ins: [] };
    const max = Math.min(a.length, b.length);
    let pre = 0;
    while (pre < max && a.charCodeAt(pre) === b.charCodeAt(pre)) pre++;
    if (pre > 0 && isHigh(a.charCodeAt(pre - 1))) pre--; // never split a surrogate pair
    let suf = 0;
    while (suf < max - pre && a.charCodeAt(a.length - 1 - suf) === b.charCodeAt(b.length - 1 - suf)) suf++;
    if (suf > 0 && isLow(a.charCodeAt(a.length - suf))) suf--;
    const am = a.slice(pre, a.length - suf);
    const bm = b.slice(pre, b.length - suf);
    let hunks = null;
    if (Math.min(am.length, bm.length) >= SPLIT_FROM) hunks = tokenHunks(am, bm);
    if (!hunks) hunks = [[0, am.length, 0, bm.length]];
    const ops = [];
    const ins = [];
    let delta = pre;
    for (const [a0, a1, b0, b1] of hunks) {
      let gone = am.slice(a0, a1);
      let put = bm.slice(b0, b1);
      let at = a0;
      // tighten to the letters that changed ("cat" → "cats" is one letter)
      let p = 0;
      while (p < gone.length && p < put.length && gone.charCodeAt(p) === put.charCodeAt(p)) p++;
      if (p > 0 && isHigh(gone.charCodeAt(p - 1))) p--;
      let s = 0;
      while (s < gone.length - p && s < put.length - p && gone.charCodeAt(gone.length - 1 - s) === put.charCodeAt(put.length - 1 - s)) s++;
      if (s > 0 && isLow(gone.charCodeAt(gone.length - s))) s--;
      gone = gone.slice(p, gone.length - s);
      put = put.slice(p, put.length - s);
      at += p;
      if (!gone.length && !put.length) continue;
      ops.push([at + delta, gone.length, put.length]);
      ins.push(put);
      delta += put.length - gone.length;
    }
    return { ops, ins };
  }

  // [aStart, aEnd, bStart, bEnd] char ranges of each changed stretch, or
  // null when the two differ in more than `max` tokens (then the caller
  // treats the middle as one replacement)
  function tokenHunks(am, bm, max = MAX_EDITS) {
    const ta = am.match(TOKEN_RE) || [];
    const tb = bm.match(TOKEN_RE) || [];
    const matches = matchSeq(ta, tb, max);
    if (!matches) return null;
    // char offsets of every token boundary
    const ca = [0];
    for (const t of ta) ca.push(ca[ca.length - 1] + t.length);
    const cb = [0];
    for (const t of tb) cb.push(cb[cb.length - 1] + t.length);
    const hunks = [];
    let ia = 0;
    let ib = 0;
    for (const [mx, my] of [...matches, [ta.length, tb.length]]) {
      if (mx > ia || my > ib) hunks.push([ca[ia], ca[mx], cb[ib], cb[my]]);
      ia = mx + 1;
      ib = my + 1;
    }
    return hunks;
  }

  /* ---------------------------------------------------------------- */
  /*  A chapter as paragraphs                                          */
  /* ---------------------------------------------------------------- */

  // Styles a run of text can carry
  const I = 1;
  const B = 2;
  const U = 4;
  const S = 8;
  const NOTE = 16; // inside a placeholder note (⌘⇧X)

  const VOID_TAGS = new Set(['br', 'img', 'hr', 'wbr', 'input', 'col', 'area', 'embed', 'source', 'track', 'meta', 'link', 'base', 'param']);
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: '\u00a0' };
  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      const v = ENTITIES[e.toLowerCase()];
      return v === undefined ? m : v;
    });
  }
  function attrOf(attrs, name) {
    const m = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(attrs);
    return m ? decodeEntities(m[1] ?? m[2] ?? m[3]) : null;
  }
  const classesOf = (attrs) => new Set((attrOf(attrs, 'class') || '').split(/\s+/).filter(Boolean));
  function styleOf(name, attrs, cls) {
    let f = 0;
    if (name === 'i' || name === 'em') f |= I;
    if (name === 'b' || name === 'strong') f |= B;
    if (name === 'u') f |= U;
    if (name === 's' || name === 'strike' || name === 'del') f |= S;
    const st = attrOf(attrs, 'style') || '';
    if (/font-style\s*:\s*italic/i.test(st)) f |= I;
    if (/font-weight\s*:\s*(?:bold|[6-9]00)/i.test(st)) f |= B;
    if (/text-decoration[^;]*underline/i.test(st)) f |= U;
    if (/text-decoration[^;]*line-through/i.test(st)) f |= S;
    if (cls.has('ph-mark')) f |= NOTE;
    return f;
  }
  const ALIGNS = new Set(['center', 'right', 'justify']);

  // A chapter's paragraphs: [{ brk, kind, align, runs: [{ t, f }] }], where
  // brk is a scene break, kind 'poetry', 'flush' or '', and each run is text
  // in one style (f: I | B | U | S | NOTE; '\n' is a line break). What the
  // manuscript leaves out of the writing stays out here too: unwritten
  // outline sections and the breaks planted for them, Darlings anchors, and
  // paragraphs with no words. Placeholder notes stay, marked NOTE.
  function paragraphs(html) {
    const src = String(html || '');
    const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;
    const ghosts = new Set();
    for (const m of src.matchAll(TAG)) {
      if (m[2] && !m[1] && m[2].toLowerCase() === 'p' && classesOf(m[3]).has('ghost')) {
        const id = attrOf(m[3], 'data-sec-id');
        if (id !== null) ghosts.add(id);
      }
    }
    const out = [];
    const stack = []; // open elements: { name, f, out }
    let para = null;
    const style = () => { let f = 0; for (const e of stack) f |= e.f; return f; };
    const hidden = () => stack.some((e) => e.out);
    const add = (t, f) => {
      const last = para.runs[para.runs.length - 1];
      if (last && last.f === f) last.t += t;
      else para.runs.push({ t, f });
    };
    const endPara = () => {
      if (!para) return;
      if (!para.out && (para.brk || para.runs.some((r) => /\S/.test(r.t)))) {
        const p = { brk: para.brk, kind: para.kind, align: para.align, runs: para.brk ? [] : para.runs };
        out.push(p);
      }
      para = null;
    };
    for (const m of src.matchAll(TAG)) {
      const tok = m[0];
      if (tok.startsWith('<!--')) continue;
      if (!m[2]) { if (para && !hidden()) add(decodeEntities(tok), style()); continue; }
      const name = m[2].toLowerCase();
      if (!m[1]) {
        const cls = classesOf(m[3]);
        if (name === 'p') {
          endPara(); // a <p> left open ends where the next begins
          stack.length = 0;
          const brk = cls.has('scene-break');
          const align = ((/text-align\s*:\s*([a-z]+)/i.exec(attrOf(m[3], 'style') || '') || [])[1] || '').toLowerCase();
          para = {
            brk, runs: [],
            kind: cls.has('poetry') ? 'poetry' : cls.has('flush') ? 'flush' : '',
            align: ALIGNS.has(align) && !brk ? align : '',
            out: (brk && ghosts.has(attrOf(m[3], 'data-sec-brk'))) || cls.has('ghost')
          };
          stack.push({ name, f: styleOf(name, m[3], cls), out: false });
          continue;
        }
        if (VOID_TAGS.has(name) || /\/\s*$/.test(m[3])) {
          if (name === 'br' && para && !hidden()) add('\n', style());
          continue;
        }
        stack.push({ name, f: styleOf(name, m[3], cls), out: cls.has('darling-anchor') || cls.has('ghost') });
        continue;
      }
      // a closing tag closes back to its own opening tag, if it has one
      let i = stack.length - 1;
      while (i >= 0 && stack[i].name !== name) i--;
      if (i < 0) continue;
      stack.length = i;
      if (name === 'p') endPara();
    }
    endPara();
    // a line break at a paragraph's very end shows nothing
    for (const p of out) {
      const last = p.runs[p.runs.length - 1];
      if (last && last.t.endsWith('\n')) { last.t = last.t.replace(/\n+$/, ''); if (!last.t) p.runs.pop(); }
    }
    return out;
  }

  // Words for comparing: a word (letters and digits, with apostrophes or
  // hyphens inside), a run of spaces, one ideograph or kana, or any other
  // single character (punctuation changes on its own)
  const WORD_RE = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]|[\p{L}\p{N}\p{M}]+(?:['’-][\p{L}\p{N}\p{M}]+)*|\s+|[\s\S]/gu;
  function words(p) {
    const out = [];
    for (const r of p.runs) for (const t of r.t.match(WORD_RE) || []) out.push({ t, f: r.f });
    return out;
  }
  const isSpace = (t) => /^\s+$/.test(t);
  // two words are the same when their letters and their style are (a
  // space's style can't be seen)
  const sameWord = (a, b) => a.t === b.t && (a.f === b.f || isSpace(a.t));
  // (as a writer counts them: punctuation isn't a word)
  const isWord = (t) => /[\p{L}\p{N}]/u.test(t);
  const countWords = (list) => list.reduce((n, w) => n + (isWord(w.t) ? 1 : 0), 0);
  const paraKey = (p) => (p.brk ? '\u0001***' : p.kind + '|' + p.align + '|' + p.runs.map((r) => r.f + ':' + r.t).join('\u0002'));

  /* ---------------------------------------------------------------- */
  /*  Comparing two versions of a chapter                              */
  /* ---------------------------------------------------------------- */

  const PARA_EDITS = 3000;  // paragraphs; past this the middle is one change
  const WORD_EDITS = 3000;  // words within one paragraph
  const PAIR_WORK = 4000;   // past this many paragraph pairs, pair in order

  // How alike two paragraphs' words are, 0 to 1
  function bag(p) {
    if (p._bag) return p._bag;
    const m = new Map();
    let n = 0;
    for (const w of words(p)) if (isWord(w.t)) { m.set(w.t, (m.get(w.t) || 0) + 1); n++; }
    Object.defineProperty(p, '_bag', { value: { m, n } });
    return p._bag;
  }
  function likeness(a, b) {
    if (a.brk || b.brk) return a.brk && b.brk ? 1 : 0;
    const x = bag(a);
    const y = bag(b);
    if (!x.n || !y.n) return 0;
    let common = 0;
    for (const [w, c] of x.m) common += Math.min(c, y.m.get(w) || 0);
    return (2 * common) / (x.n + y.n);
  }
  const ALIKE = 0.5;

  // One paragraph's words, old against new: pieces [{ op, t, f }], op '='
  // (in both), '-' (only in the old) or '+' (only in the new). Within each
  // change the old words come first, and a lone space between two changes
  // goes with them, so a reworded phrase reads as one struck phrase and
  // one new one.
  function wordPieces(a, b) {
    const wa = words(a);
    const wb = words(b);
    const matches = matchSeq(wa, wb, WORD_EDITS, sameWord);
    const raw = [];
    if (!matches) {
      for (const w of wa) raw.push({ op: '-', t: w.t, f: w.f });
      for (const w of wb) raw.push({ op: '+', t: w.t, f: w.f });
    } else {
      let ia = 0;
      let ib = 0;
      for (const [mx, my] of [...matches, [wa.length, wb.length]]) {
        while (ia < mx) { const w = wa[ia++]; raw.push({ op: '-', t: w.t, f: w.f }); }
        while (ib < my) { const w = wb[ib++]; raw.push({ op: '+', t: w.t, f: w.f }); }
        if (mx < wa.length) { raw.push({ op: '=', t: wb[my].t, f: wb[my].f }); ia++; ib++; }
      }
    }
    // a lone space between two changes joins them
    for (let i = 1; i < raw.length - 1; i++) {
      if (raw[i].op !== '=' || !isSpace(raw[i].t)) continue;
      if (raw[i - 1].op === '=' || raw[i + 1].op === '=') continue;
      const t = raw[i].t;
      raw.splice(i, 1, { op: '-', t, f: 0 }, { op: '+', t, f: 0 });
    }
    // within each run of changes: the old words, then the new
    // (a space both sides have at a change's edge stays outside it)
    const pieces = [];
    let run = [];
    const flush = () => {
      const dels = run.filter((w) => w.op === '-');
      const ins = run.filter((w) => w.op === '+');
      const lead = [];
      const trail = [];
      while (dels.length && ins.length && isSpace(dels[0].t) && dels[0].t === ins[0].t) { lead.push({ op: '=', t: ins[0].t, f: 0 }); dels.shift(); ins.shift(); }
      while (dels.length && ins.length && isSpace(dels[dels.length - 1].t) && dels[dels.length - 1].t === ins[ins.length - 1].t) {
        trail.unshift({ op: '=', t: ins[ins.length - 1].t, f: 0 });
        dels.pop();
        ins.pop();
      }
      for (const w of [...lead, ...dels, ...ins, ...trail]) push(w);
      run = [];
    };
    const push = (w) => {
      const last = pieces[pieces.length - 1];
      if (last && last.op === w.op && last.f === w.f) last.t += w.t;
      else pieces.push({ op: w.op, t: w.t, f: w.f });
    };
    for (const w of raw) {
      if (w.op === '=') { flush(); push(w); } else run.push(w);
    }
    flush();
    return pieces;
  }

  // The paragraphs of a replaced stretch, old against new: alike ones
  // paired (and compared word by word), the rest deleted or inserted, in
  // reading order
  function pairUp(olds, news, items) {
    const k = olds.length;
    const m = news.length;
    if (k * m > PAIR_WORK) {
      // too many to weigh each against each: in order, alike or not
      for (let i = 0; i < Math.max(k, m); i++) {
        const a = olds[i];
        const b = news[i];
        if (a && b && likeness(a, b) >= ALIKE) items.push({ type: 'mod', a, b });
        else { if (a) items.push({ type: 'del', a }); if (b) items.push({ type: 'ins', b }); }
      }
      return;
    }
    let i = 0;
    let j = 0;
    const firstAlike = (p, list, from) => { for (let x = from; x < list.length; x++) if (likeness(p, list[x]) >= ALIKE) return x; return -1; };
    while (i < k && j < m) {
      const s = likeness(olds[i], news[j]);
      if (s >= ALIKE) { items.push({ type: 'mod', a: olds[i++], b: news[j++] }); continue; }
      const later = firstAlike(olds[i], news, j + 1); // old i is a later new paragraph
      const sooner = firstAlike(news[j], olds, i + 1); // new j is a later old paragraph
      if (later >= 0 && (sooner < 0 || later - j <= sooner - i)) items.push({ type: 'ins', b: news[j++] });
      else if (sooner >= 0) items.push({ type: 'del', a: olds[i++] });
      else if (s >= ALIKE / 2) items.push({ type: 'mod', a: olds[i++], b: news[j++] });
      else { items.push({ type: 'del', a: olds[i++] }); items.push({ type: 'ins', b: news[j++] }); }
    }
    while (i < k) items.push({ type: 'del', a: olds[i++] });
    while (j < m) items.push({ type: 'ins', b: news[j++] });
  }

  // Two versions of a chapter's HTML, the older first. Returns { blocks,
  // added, removed, same }: blocks in reading order, each one of
  //   { type: 'same', p }           a paragraph in both
  //   { type: 'fold', ps }          unchanged paragraphs folded away
  //   { type: 'del', p }            a paragraph only the older has
  //   { type: 'ins', p }            a paragraph only the newer has
  //   { type: 'mod', p, pieces }    a paragraph changed word by word (p is
  //                                 the newer, for its shape)
  // added and removed count words; `context` unchanged paragraphs stay in
  // view beside each change, and a fold hides at least `minFold`.
  function compare(oldHtml, newHtml, { context = 1, minFold = 3 } = {}) {
    const A = paragraphs(oldHtml);
    const Bs = paragraphs(newHtml);
    const ka = A.map(paraKey);
    const kb = Bs.map(paraKey);
    let pre = 0;
    while (pre < A.length && pre < Bs.length && ka[pre] === kb[pre]) pre++;
    let suf = 0;
    while (suf < A.length - pre && suf < Bs.length - pre && ka[A.length - 1 - suf] === kb[Bs.length - 1 - suf]) suf++;
    const mid = matchSeq(ka.slice(pre, A.length - suf), kb.slice(pre, Bs.length - suf), PARA_EDITS) || [];
    const items = [];
    for (let x = 0; x < pre; x++) items.push({ type: 'same', p: Bs[x] });
    let ia = pre;
    let ib = pre;
    for (const [mx, my] of [...mid.map(([x, y]) => [x + pre, y + pre]), [A.length - suf, Bs.length - suf]]) {
      if (mx > ia || my > ib) pairUp(A.slice(ia, mx), Bs.slice(ib, my), items);
      if (mx < A.length - suf) items.push({ type: 'same', p: Bs[my] });
      ia = mx + 1;
      ib = my + 1;
    }
    for (let y = Bs.length - suf; y < Bs.length; y++) items.push({ type: 'same', p: Bs[y] });
    // words, and what changed in all
    let added = 0;
    let removed = 0;
    const blocks0 = items.map((it) => {
      if (it.type === 'del') { removed += countWords(words(it.a)); return { type: 'del', p: it.a }; }
      if (it.type === 'ins') { added += countWords(words(it.b)); return { type: 'ins', p: it.b }; }
      if (it.type === 'mod') {
        const pieces = wordPieces(it.a, it.b);
        for (const w of pieces) {
          if (w.op === '-') removed += countWords(w.t.match(WORD_RE).map((t) => ({ t })));
          if (w.op === '+') added += countWords(w.t.match(WORD_RE).map((t) => ({ t })));
        }
        // a paragraph whose words are the same but whose shape changed
        // (centered, made poetry): the newer shape, its words unmarked
        return { type: 'mod', p: it.b, was: it.a, pieces };
      }
      return it;
    });
    // fold long unchanged stretches, keeping `context` beside each change
    const blocks = [];
    for (let x = 0; x < blocks0.length;) {
      if (blocks0[x].type !== 'same') { blocks.push(blocks0[x++]); continue; }
      let y = x;
      while (y < blocks0.length && blocks0[y].type === 'same') y++;
      const before = x > 0 ? context : 0;
      const after = y < blocks0.length ? context : 0;
      if (y - x - before - after >= minFold) {
        for (let z = x; z < x + before; z++) blocks.push(blocks0[z]);
        blocks.push({ type: 'fold', ps: blocks0.slice(x + before, y - after).map((b) => b.p) });
        for (let z = y - after; z < y; z++) blocks.push(blocks0[z]);
      } else for (let z = x; z < y; z++) blocks.push(blocks0[z]);
      x = y;
    }
    const same = !blocks0.some((b) => b.type !== 'same');
    return { blocks, added, removed, same };
  }

  /* ---------------------------------------------------------------- */
  /*  Markup for the window                                            */
  /* ---------------------------------------------------------------- */

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function runHtml(t, f) {
    let h = esc(t).replace(/\n/g, '<br>');
    if (f & S) h = '<s>' + h + '</s>';
    if (f & U) h = '<u>' + h + '</u>';
    if (f & I) h = '<i>' + h + '</i>';
    if (f & B) h = '<b>' + h + '</b>';
    if (f & NOTE) h = '<span class="hv-note">' + h + '</span>';
    return h;
  }
  function openP(p, extra) {
    const cls = [p.brk ? 'scene-break' : p.kind, extra].filter(Boolean).join(' ');
    return `<p${cls ? ` class="${cls}"` : ''}${p.align ? ` style="text-align:${p.align}"` : ''}>`;
  }
  const runsHtml = (p) => (p.brk ? '***' : p.runs.map((r) => runHtml(r.t, r.f)).join(''));
  const paraHtml = (p, extra = '', wrap = '') => openP(p, extra) + (wrap ? `<${wrap}>${runsHtml(p)}</${wrap}>` : runsHtml(p)) + '</p>';

  // A chapter as clean prose (what View shows)
  function viewHtml(html) {
    return paragraphs(html).map((p) => paraHtml(p)).join('');
  }

  // compare()'s blocks as markup: deletions in <del>, insertions in <ins>,
  // each fold a button (labelled by foldLabel(count)) with its paragraphs
  // hidden after it
  function toHtml(blocks, { foldLabel = (n) => n + ' unchanged paragraphs' } = {}) {
    return blocks.map((b) => {
      if (b.type === 'same') return paraHtml(b.p);
      if (b.type === 'del') return paraHtml(b.p, 'hv-gone', 'del');
      if (b.type === 'ins') return paraHtml(b.p, 'hv-new', 'ins');
      if (b.type === 'fold') {
        return `<div class="hv-fold-wrap"><button type="button" class="hv-fold" aria-expanded="false">${esc(foldLabel(b.ps.length))}</button>` +
          `<div class="hv-folded" hidden>${b.ps.map((p) => paraHtml(p)).join('')}</div></div>`;
      }
      // mod
      const shape = b.was && (b.was.kind !== b.p.kind || b.was.align !== b.p.align) ? 'hv-reshaped' : '';
      const inner = b.pieces.map((w) => {
        const h = runHtml(w.t, w.f);
        return w.op === '-' ? '<del>' + h + '</del>' : w.op === '+' ? '<ins>' + h + '</ins>' : h;
      }).join('');
      return openP(b.p, shape) + inner + '</p>';
    }).join('');
  }

  Object.assign(api, {
    TOKEN_RE, MAX_EDITS, SPLIT_FROM, matchSeq, diff, tokenHunks,
    STYLE: { I, B, U, S, NOTE }, paragraphs, words, compare, toHtml, viewHtml
  });
})(typeof module !== 'undefined' && module.exports ? module.exports : (globalThis.SlogDiff = {}));
