'use strict';

// slog-diff.js: the log's diff, moved out of slog.js unchanged (checked
// against a frozen copy of the old code on random edits), and the History
// window's compare: paragraphs matched, words within them, folds, and
// markup built fresh from the text.

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const D = require('../slog-diff.js');
const slog = require('../slog.js');

// The diff as slog.js had it before phase 3 (frozen here: the log's ops
// must never change because the code moved)
const old = (() => {
const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

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

// Myers' O(ND) diff over tokens. Returns [aStart, aEnd, bStart, bEnd] char
// ranges of each changed stretch, or null when the two differ in more than
// MAX_EDITS tokens (then the caller treats the middle as one replacement).
function tokenHunks(am, bm) {
  const ta = am.match(TOKEN_RE) || [];
  const tb = bm.match(TOKEN_RE) || [];
  const N = ta.length;
  const M = tb.length;
  const off = MAX_EDITS + 1;
  const v = new Int32Array(2 * off + 1);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= MAX_EDITS && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && ta[x] === tb[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { found = d; break; }
    }
  }
  if (found < 0) return null;
  // walk back from the end, collecting the matched runs
  const matches = []; // [x, y] of each token that is the same in both
  let x = N;
  let y = M;
  for (let d = found; d > 0; d--) {
    const vp = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && vp[off + k - 1] < vp[off + k + 1])) ? k + 1 : k - 1;
    const px = vp[off + prevK];
    const py = px - prevK;
    while (x > px && y > py) { x--; y--; matches.push([x, y]); }
    x = px;
    y = py;
  }
  while (x > 0 && y > 0) { x--; y--; matches.push([x, y]); }
  matches.reverse();
  // char offsets of every token boundary
  const ca = [0];
  for (const t of ta) ca.push(ca[ca.length - 1] + t.length);
  const cb = [0];
  for (const t of tb) cb.push(cb[cb.length - 1] + t.length);
  const hunks = [];
  let ia = 0;
  let ib = 0;
  for (const [mx, my] of [...matches, [N, M]]) {
    if (mx > ia || my > ib) hunks.push([ca[ia], ca[mx], cb[ib], cb[my]]);
    ia = mx + 1;
    ib = my + 1;
  }
  return hunks;
}

  return { diff, tokenHunks };
})();

// a small random generator, the same every run
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const WORDS = ['the', 'harbor', 'was', 'quiet', 'Mara', 'counted', 'boats', ' ', '  ', '\n', '<p>', '</p>', '<i>', '</i>', 'é', '😀', ',', '.', '<', 'gulls'];
function randomText(r, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += WORDS[Math.floor(r() * WORDS.length)] + (r() < 0.6 ? ' ' : '');
  return s;
}
function mutate(r, s) {
  let out = s;
  const k = 1 + Math.floor(r() * 40);
  for (let i = 0; i < k; i++) {
    const at = Math.floor(r() * (out.length + 1));
    const del = r() < 0.5 ? Math.floor(r() * 12) : 0;
    out = out.slice(0, at) + (r() < 0.7 ? randomText(r, Math.floor(r() * 4)) : '') + out.slice(at + del);
  }
  return out;
}

describe('the log\'s diff, moved', () => {
  test('gives exactly the old ops, on thousands of random edits', () => {
    const r = rng(7);
    for (let i = 0; i < 3000; i++) {
      const a = randomText(r, Math.floor(r() * 120));
      const b = r() < 0.1 ? randomText(r, Math.floor(r() * 120)) : mutate(r, a);
      assert.deepEqual(D.diff(a, b), old.diff(a, b), JSON.stringify([a, b]));
      assert.deepEqual(D.tokenHunks(a, b), old.tokenHunks(a, b));
    }
  });
  test('is the one slog.js exports', () => {
    assert.equal(slog.diff, D.diff);
    assert.equal(slog.tokenHunks, D.tokenHunks);
  });
  test('matchSeq finds a longest common run, and gives up past its cap', () => {
    const a = 'abcabba'.split('');
    const b = 'cbabac'.split('');
    const m = D.matchSeq(a, b, 100);
    assert.equal(m.length, 4);
    for (const [x, y] of m) assert.equal(a[x], b[y]);
    for (let i = 1; i < m.length; i++) assert.ok(m[i][0] > m[i - 1][0] && m[i][1] > m[i - 1][1]);
    assert.equal(D.matchSeq('aaaa'.split(''), 'bbbb'.split(''), 3), null);
    assert.deepEqual(D.matchSeq([], [], 0), []);
  });
});

const P = (...xs) => xs.map((x) => `<p>${x}</p>`).join('');

describe('a chapter as paragraphs', () => {
  test('styles, breaks and entities, read like the manuscript', () => {
    const ps = D.paragraphs('<p>One <i>quick</i> <b style="font-style: italic">bold</b> fox&nbsp;&amp; co.</p>' +
      '<p class="scene-break">***</p><p class="poetry" style="text-align: center">a line<br>and another</p><p>  </p>' +
      '<p>a <span class="ph-mark" data-sid="x">TK</span> note<span class="darling-anchor" data-id="d1"></span></p>');
    const { I, B, NOTE } = D.STYLE;
    assert.equal(ps.length, 4);
    assert.deepEqual(ps[0].runs, [{ t: 'One ', f: 0 }, { t: 'quick', f: I }, { t: ' ', f: 0 }, { t: 'bold', f: B | I }, { t: ' fox & co.', f: 0 }]);
    assert.equal(ps[1].brk, true);
    assert.deepEqual([ps[2].kind, ps[2].align, ps[2].runs[0].t], ['poetry', 'center', 'a line\nand another']);
    assert.deepEqual(ps[3].runs, [{ t: 'a ', f: 0 }, { t: 'TK', f: NOTE }, { t: ' note', f: 0 }]);
  });
  test('unwritten outline sections and their breaks stay out', () => {
    const ps = D.paragraphs('<p>Before.</p><p class="scene-break" data-sec-brk="s1">***</p><p class="ghost" data-sec-id="s1">Write the storm</p><p>After.</p>');
    assert.deepEqual(ps.map((p) => p.runs.map((r) => r.t).join('')), ['Before.', 'After.']);
  });
  test('viewHtml is markup built from the text, never the saved HTML', () => {
    const h = D.viewHtml('<p onclick="x()">Hi <img src=x onerror=alert(1)><script>alert(2)</script> &lt;b&gt;</p><p style="text-align:url(x)">Two</p>');
    assert.equal(h, '<p>Hi alert(2) &lt;b&gt;</p><p>Two</p>');
    assert.ok(!/onclick|onerror|<script|<img|url\(/.test(h));
  });
});

describe('comparing two versions of a chapter', () => {
  test('the same chapter has no changes', () => {
    const c = D.compare(P('One.', 'Two.'), P('One.', 'Two.'));
    assert.equal(c.same, true);
    assert.equal(c.added + c.removed, 0);
  });
  test('a reworded phrase: the old words struck, then the new, in one paragraph', () => {
    const c = D.compare(P('The harbor was quiet before the storm.'), P('The harbor was still and dark before the storm.'));
    assert.equal(c.blocks.length, 1);
    assert.equal(c.blocks[0].type, 'mod');
    assert.equal(D.toHtml(c.blocks), '<p>The harbor was <del>quiet</del><ins>still and dark</ins> before the storm.</p>');
    assert.deepEqual([c.added, c.removed], [3, 1]);
  });
  test('two words replaced, with a space between them, read as one change', () => {
    const c = D.compare(P('a quick brown fox'), P('a slow red fox'));
    assert.equal(D.toHtml(c.blocks), '<p>a <del>quick brown</del><ins>slow red</ins> fox</p>');
  });
  test('punctuation changes on its own', () => {
    const c = D.compare(P('She left, quietly.'), P('She left quietly!'));
    assert.equal(D.toHtml(c.blocks), '<p>She left<del>,</del> quietly<del>.</del><ins>!</ins></p>');
  });
  test('a word made italic shows as changed', () => {
    const c = D.compare(P('a quiet harbor'), P('a <i>quiet</i> harbor'));
    assert.equal(D.toHtml(c.blocks), '<p>a <del>quiet</del><ins><i>quiet</i></ins> harbor</p>');
  });
  test('paragraphs added and deleted whole, and unchanged ones folded', () => {
    const body = Array.from({ length: 10 }, (_, i) => `Paragraph number ${i} stays as it was.`);
    const before = P(...body, 'An old ending nobody liked.');
    const after = P('A brand new opening line here.', ...body, 'The real ending, at last.');
    const c = D.compare(before, after);
    assert.deepEqual(c.blocks.map((b) => b.type), ['ins', 'same', 'fold', 'same', 'del', 'ins']);
    assert.equal(c.blocks[2].ps.length, 8);
    const h = D.toHtml(c.blocks, { foldLabel: (n) => `${n} unchanged` });
    assert.ok(h.startsWith('<p class="hv-new"><ins>A brand new opening line here.</ins></p><p>Paragraph number 0 stays as it was.</p>'));
    assert.ok(h.includes('<button type="button" class="hv-fold" aria-expanded="false">8 unchanged</button><div class="hv-folded" hidden><p>Paragraph number 1'));
    assert.ok(h.endsWith('<p class="hv-gone"><del>An old ending nobody liked.</del></p><p class="hv-new"><ins>The real ending, at last.</ins></p>'));
  });
  test('an edited paragraph among new ones pairs with the one it was', () => {
    const c = D.compare(P('Mara counted the boats twice.', 'One was missing.'),
      P('A gull cried.', 'Mara counted the boats three times.', 'Then the wind came.', 'One was missing.'));
    assert.deepEqual(c.blocks.map((b) => b.type), ['ins', 'mod', 'ins', 'same']);
    assert.equal(D.toHtml([c.blocks[1]]), '<p>Mara counted the boats <del>twice</del><ins>three times</ins>.</p>');
  });
  test('a paragraph recentred keeps its words unmarked and says it changed shape', () => {
    const c = D.compare(P('Chapter end.'), '<p style="text-align: center">Chapter end.</p>');
    assert.equal(D.toHtml(c.blocks), '<p class="hv-reshaped" style="text-align:center">Chapter end.</p>');
    assert.equal(c.same, false);
  });
  test('a whole rewrite of a long chapter stays quick and complete', () => {
    const r = rng(3);
    const a = P(...Array.from({ length: 400 }, () => randomText(r, 60).replace(/[<>]/g, '')));
    const b = P(...Array.from({ length: 400 }, () => randomText(r, 60).replace(/[<>]/g, '')));
    const t0 = Date.now();
    const c = D.compare(a, b);
    assert.ok(Date.now() - t0 < 5000, 'took ' + (Date.now() - t0) + ' ms');
    // every word of both is in the result, once
    const text = (html) => D.paragraphs(html).map((p) => p.runs.map((x) => x.t).join('')).join('');
    let olds = '';
    let news = '';
    for (const blk of c.blocks) {
      if (blk.type === 'del') olds += blk.p.runs.map((x) => x.t).join('');
      else if (blk.type === 'ins') news += blk.p.runs.map((x) => x.t).join('');
      else if (blk.type === 'mod') for (const w of blk.pieces) { if (w.op !== '+') olds += w.t; if (w.op !== '-') news += w.t; }
      else for (const p of blk.ps || [blk.p]) { const s = p.runs.map((x) => x.t).join(''); olds += s; news += s; }
    }
    assert.equal(olds, text(a));
    assert.equal(news, text(b));
  });
  test('random edits: the old side and the new side both come back whole', () => {
    const r = rng(11);
    const text = (html) => D.paragraphs(html).map((p) => p.runs.map((x) => x.t).join(''));
    for (let i = 0; i < 300; i++) {
      const paras = Array.from({ length: 1 + Math.floor(r() * 12) }, () => randomText(r, 1 + Math.floor(r() * 25)).replace(/[<>]/g, '').trim() || 'x');
      const next = paras.slice();
      for (let k = Math.floor(r() * 5); k >= 0; k--) {
        const at = Math.floor(r() * next.length);
        const what = r();
        if (what < 0.3) next.splice(at, 1);
        else if (what < 0.6) next.splice(at, 0, randomText(r, 8).replace(/[<>]/g, '').trim() || 'y');
        else next[at] = mutate(r, next[at] || '').replace(/[<>]/g, '').trim() || 'z';
      }
      const a = P(...paras.map((x) => x.replace(/&/g, '&amp;')));
      const b = P(...next.filter(Boolean).map((x) => x.replace(/&/g, '&amp;')));
      const c = D.compare(a, b, { context: 0, minFold: 1 });
      const olds = [];
      const news = [];
      for (const blk of c.blocks) {
        if (blk.type === 'del') olds.push(blk.p.runs.map((x) => x.t).join(''));
        else if (blk.type === 'ins') news.push(blk.p.runs.map((x) => x.t).join(''));
        else if (blk.type === 'mod') {
          olds.push(blk.pieces.filter((w) => w.op !== '+').map((w) => w.t).join(''));
          news.push(blk.pieces.filter((w) => w.op !== '-').map((w) => w.t).join(''));
        } else for (const p of blk.ps || [blk.p]) { const s = p.runs.map((x) => x.t).join(''); olds.push(s); news.push(s); }
      }
      assert.deepEqual(olds, text(a));
      assert.deepEqual(news, text(b));
    }
  });
});
