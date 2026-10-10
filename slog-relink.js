// THE SCRIBE'S LOG, TRACED FURTHER: before an export or a report, NEO looks
// again at the words whose origin the log couldn't place as they were
// written, and matches them to earlier writing in the book.
//
//   what it looks at   edits labeled `move` whose place wasn't recorded,
//                      pastes and drops from outside NEO, and text that
//                      reached the disk without a label (unlogged, or
//                      changed while the log was off): the units no `from`
//                      piece (or earlier relink) covers
//   where it looks     every deletion earlier in that chain, and every
//                      document as it stood just before the edit (chapters,
//                      notes, outline, Darlings…), so only writing that came
//                      before; each with the origins the checker traces
//   how close          exact runs of at least MIN units of text outside tags,
//                      typography aside (V.looseOf: spaces, quotes, dashes,
//                      ellipses); no fuzzy matching
//   which wins         the earliest writing: where several places hold the
//                      same words, the one first written; where that doesn't
//                      improve on the label (a paste matched to an earlier
//                      paste), nothing is placed there at all
//
// What it finds goes into the log as `relink` entries (SLOG-FORMAT.md), so
// the report and every checker read the same thing. Plain JavaScript that
// also runs in a browser (globalThis.SlogRelink); NEO runs it in the main
// process (main.js, slogScan).

'use strict';

(function (exports) {
  const V = typeof require === 'function' ? require('./slog-verify.js') : globalThis.SlogVerify;

  const MIN = 20;    // units of text outside tags, as the Recorder's MOVE_MIN
  const GRAM = 12;   // index keys this long…
  const STEP = 8;    // …taken every STEP units of a source, so any match of GRAM + STEP - 1 or more is found
  const HITS = 64;   // places looked at per key, newest first
  const WORDY = /[\p{L}\p{N}]/u;
  const OP_MAX = 200000; // units of one inserted string looked at, at most
  const whole = (v) => Number.isSafeInteger(v) && v >= 0;

  // What a match can make of words whose label is `target`. A paste or drop
  // is only placed where the earlier writing was the writer's own (typed,
  // imported, there before the log, an editor's, another book's); words
  // without a place take anything recorded, a paste included.
  const OWN = new Set(['typed', 'import', 'baseline', 'other book']);
  function improves(target, cat) {
    if (OWN.has(cat) || V.editorOf(cat) !== null) return true;
    return target !== 'paste' && target !== 'drop' && (cat === 'paste' || cat === 'drop');
  }

  // How many units before each position are outside tags (as slog.js)
  function textBefore(s, html) {
    const out = new Uint32Array(s.length + 1);
    let inTag = false;
    if (html) {
      const gt = s.indexOf('>');
      const lt = s.indexOf('<');
      inTag = gt >= 0 && (lt < 0 || gt < lt);
    }
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 60) inTag = true;
      out[i + 1] = out[i] + (inTag ? 0 : 1);
      if (c === 62) inTag = false;
    }
    return out;
  }

  // A source: its text as V.looseOf reads it, and what a from piece calls
  // it ({ n, op } for a deletion; a document's paragraph says { doc } and
  // finds its place when it's used)
  function sourceOf(text, json, ref) {
    const v = V.looseOf(text, json);
    return { text: v.text, at: Uint32Array.from(v.at), raw: text, ref, json, dead: false };
  }
  function indexInto(index, rec) {
    const t = rec.text;
    for (let p = 0; p + GRAM <= t.length; p += STEP) {
      const g = t.slice(p, p + GRAM);
      const list = index.get(g);
      if (list) list.push(rec, p);
      else index.set(g, [rec, p]);
    }
  }

  // A match on a source cut where the source's writing changes age or
  // kind: [{ k, len, hour, good }] in view characters from the match's
  // start, each with the hour its text was first written (UTC hours since
  // 1970; Infinity when it isn't known) and whether that writing gains the
  // target's label anything. Markup goes with the text before it (or, at
  // the start, the text after it). A character is judged by its first unit.
  function segments(rec, w, src, len, target) {
    const a = w.off + rec.at[src];
    const runs = V.runsSlice(w.runs, a, w.off + rec.at[src + len] - a);
    const out = [];
    let ri = 0;
    let left = runs.length ? runs[0][0] : 0;
    let raw = a;
    let cur = null;
    for (let k = 0; k < len; k++) {
      const r0 = w.off + rec.at[src + k];
      while (raw < r0 && ri < runs.length) {
        const step = Math.min(left, r0 - raw);
        raw += step;
        left -= step;
        if (left <= 0) { ri++; left = ri < runs.length ? runs[ri][0] : 0; }
      }
      const o = ri < runs.length ? V.parseOrigin(runs[ri][1]) : null;
      const tag = !o || o.tag;
      const hour = !o || o.hour === null ? Infinity : o.hour;
      const good = !!o && improves(target, o.cat);
      if (!cur) { cur = { k, len: 0, hour, good, open: tag }; out.push(cur); }
      else if (!tag) {
        if (cur.open) { cur.hour = hour; cur.good = good; cur.open = false; }
        else if (cur.hour !== hour || cur.good !== good) { cur = { k, len: 0, hour, good, open: false }; out.push(cur); }
      }
      cur.len = k + 1 - cur.k;
    }
    return out;
  }

  // One op's inserted string (as its loose view `t`, with `vis`), matched in
  // the sources (indexes: lists of [rec, pos] by key), filling only what
  // `covered` (view characters a piece already places) leaves: the
  // stretches to place, [{ at, len, rec, src, off }] in view characters
  // (`off`: where a paragraph's text starts in its document now). A match
  // holds at least MIN units of text (counting what's already placed, so a
  // short gap beside placed words is filled from the same match); the
  // earliest writing is taken first, then the longest; a match whose
  // writing gains nothing (a paste matched to an earlier paste) holds its
  // place empty. Each part of a match is judged by its own writing
  // (segments). Only places near the gaps are looked at. `where(rec)` gives
  // a source's place and origins now: { off, runs }, or null. Returns null
  // once `deadline` (a Date.now() time) has passed.
  function matchStretch(t, vis, indexes, target, covered, where, deadline = Infinity) {
    const n = t.text.length;
    const look = new Uint8Array(n);
    for (let k = 0; k < n;) {
      if (covered[k]) { k++; continue; }
      const a = k;
      while (k < n && !covered[k]) k++;
      look.fill(1, Math.max(0, a - GRAM - STEP), Math.min(n, k + STEP));
    }
    const cands = [];
    const seen = new Set();
    let id = 0;
    const ids = new Map();
    const idOf = (rec) => { let v = ids.get(rec); if (v === undefined) ids.set(rec, (v = ++id)); return v; };
    for (let p = 0; p + GRAM <= n; p++) {
      if (!look[p]) continue;
      if ((p & 255) === 0 && Date.now() > deadline) return null;
      const g = t.text.slice(p, p + GRAM);
      for (const index of indexes) {
        const list = index.get(g);
        if (!list) continue;
        let looked = 0;
        for (let h = list.length - 2; h >= 0 && looked < HITS; h -= 2) {
          const rec = list[h];
          if (rec.dead) continue;
          const sp = list[h + 1];
          looked++;
          // one alignment of the string on a source is one match
          const key = idOf(rec) + ':' + (sp - p);
          if (seen.has(key)) continue;
          seen.add(key);
          const s = rec.text;
          let b = 0;
          while (p - b > 0 && sp - b > 0 && t.text.charCodeAt(p - b - 1) === s.charCodeAt(sp - b - 1)) b++;
          let f = GRAM;
          while (p + f < n && sp + f < s.length && t.text.charCodeAt(p + f) === s.charCodeAt(sp + f)) f++;
          const at = p - b;
          const len = b + f;
          if (vis[at + len] - vis[at] < MIN) continue;
          let open = false;
          for (let k = at; k < at + len && !open; k++) open = !covered[k];
          if (!open) continue;
          const w = where(rec);
          if (!w) continue;
          const src = sp - b;
          for (const g2 of segments(rec, w, src, len, target)) {
            cands.push({ at: at + g2.k, len: g2.len, rec, src: src + g2.k, off: w.off, hour: g2.hour, good: g2.good });
          }
        }
      }
    }
    cands.sort((x, y) => (x.hour === y.hour ? 0 : x.hour < y.hour ? -1 : 1) || (y.len - x.len) || (x.at - y.at));
    const taken = covered.slice();
    const out = [];
    for (const c of cands) {
      // the parts of this match nothing before it has
      let k = c.at;
      const end = c.at + c.len;
      while (k < end) {
        while (k < end && taken[k]) k++;
        const a = k;
        while (k < end && !taken[k]) k++;
        if (k > a) {
          taken.fill(1, a, k);
          // earliest writing that gains nothing still holds its place
          if (c.good) out.push({ at: a, len: k - a, rec: c.rec, src: c.src + (a - c.at), off: c.off });
        }
      }
    }
    return out.sort((x, y) => x.at - y.at);
  }

  // A match in view characters as from pieces of raw units: stretches
  // written the same on both sides are one piece; a character written two
  // ways (a curly quote and a straight one, two spaces and one) is a piece
  // of its own, with the source's own length when it differs
  function rawPieces(op, tv, m) {
    const out = [];
    let run = null;
    for (let k = 0; k < m.len; k++) {
      const t0 = tv.at[m.at + k];
      const t1 = tv.at[m.at + k + 1];
      const s0 = m.rec.at[m.src + k];
      const s1 = m.rec.at[m.src + k + 1];
      const same = t1 - t0 === s1 - s0 && tv.raw.slice(t0, t1) === m.rec.raw.slice(s0, s1);
      if (same && run && run.same && run.t + run.l === t0 && run.s + run.sl === s0) {
        run.l += t1 - t0;
        run.sl += s1 - s0;
        continue;
      }
      run = { same, t: t0, l: t1 - t0, s: s0, sl: s1 - s0 };
      out.push(run);
    }
    return out.map((r) => {
      const source = { ...m.rec.ref, at: m.off + r.s };
      if (r.sl !== r.l) source.len = r.sl;
      return [op, r.t, r.l, source];
    });
  }

  // A document's text as the records the scan indexes: a chapter's (or the
  // notes', the outline's) paragraphs, each with its closing tag; a JSON
  // document's lines (Darlings and the rest are written two-space indented,
  // one passage to a line)
  const parasOf = (text, json) => text.split(json ? /(?<=\n)/ : /(?<=<\/p>)/);

  // Every chain's edits looked at again: { relinks: [{ dev, of, from }], one
  // per edit that gains pieces (dev: the chain the edit is on), cut }.
  // devices: [{ dev, entries }] with their words; links as checkChains gives
  // them. budget: ms to spend looking, at most (an enormous book's later
  // edits are left as they are, and `cut` says so; what was found holds).
  function scan(devices, { links = null, budget = 0 } = {}) {
    const found = [];
    const deadline = budget > 0 ? Date.now() + budget : Infinity;
    let cut = false;
    const hooks = (dev) => {
      const graves = new Map(); // key → [rec, pos, …]: this chain's deletions so far
      // the documents as their paragraphs (or lines), kept up to date as
      // they change: only paragraphs that changed are indexed again. A
      // paragraph found twice in a document is two records, the second
      // finding its place as the second occurrence (rec.k). doc → { d, v,
      // len, paras: Map text → [rec, …] }
      const paras = new Map();
      let live = 0;
      let dead = 0;
      let index = new Map();
      const kill = (rec) => { if (!rec.dead) { rec.dead = true; dead += rec.text.length; live -= rec.text.length; } };
      const reindex = () => {
        index = new Map();
        for (const st of paras.values()) for (const list of st.paras.values()) for (const rec of list) if (!rec.dead) indexInto(index, rec);
        dead = 0;
      };
      const refresh = (docs) => {
        for (const [doc, st] of paras) {
          if (docs[doc] && typeof docs[doc].text === 'string') continue;
          for (const list of st.paras.values()) for (const rec of list) kill(rec);
          paras.delete(doc);
        }
        for (const [doc, d] of Object.entries(docs)) {
          if (!d || typeof d.text !== 'string') continue;
          let st = paras.get(doc);
          if (st && st.d === d && st.v === (d.v || 0) && st.len === d.len) continue;
          const json = V.isJsonDocName(doc);
          const counts = new Map();
          for (const t of parasOf(d.text, json)) if (t.length >= MIN) counts.set(t, (counts.get(t) || 0) + 1);
          const had = st ? st.paras : new Map();
          const now = new Map();
          for (const [t, list] of had) {
            const want = counts.get(t) || 0;
            for (let k = want; k < list.length; k++) kill(list[k]);
            if (want) now.set(t, list.slice(0, want));
          }
          for (const [t, c] of counts) {
            const list = now.get(t) || [];
            for (let k = list.length; k < c; k++) {
              const r = sourceOf(t, json, { doc });
              r.k = k;
              if (textBefore(r.text, !json)[r.text.length] < MIN) r.dead = true;
              else { indexInto(index, r); live += r.text.length; }
              list.push(r);
            }
            now.set(t, list);
          }
          st = { d, v: d.v || 0, len: d.len, paras: now };
          paras.set(doc, st);
        }
        if (dead > Math.max(live, 1 << 20)) reindex();
      };
      return {
        buried(key, g) {
          if (typeof g.text !== 'string' || g.text.length < MIN) return;
          const [n, op] = key.split(':').map(Number);
          const json = V.isJsonDocName(g.doc);
          if (textBefore(g.text, !json)[g.text.length] < MIN) return;
          const rec = sourceOf(g.text, json, { n, op });
          rec.runs = g.runs;
          indexInto(graves, rec);
        },
        pre(e, tracer) {
          if (e.kind !== 'edit' || !V.RELINKABLE.has(e.src) || !e.x || !Array.isArray(e.x.ins)) return;
          if (!e.ops.some((op) => op[2] >= MIN)) return;
          if (cut || Date.now() > deadline) { cut = true; return; }
          const target = V.originOf(e);
          const { pieces } = tracer.piecesOf(e);
          if (!Array.isArray(pieces)) return;
          // the documents as they stand just before this edit
          refresh(tracer.docs);
          const places = new Map();
          const where = (rec) => {
            if (rec.runs) return { off: 0, runs: rec.runs };
            if (places.has(rec)) return places.get(rec);
            const d = tracer.docs[rec.ref.doc];
            let off = -1;
            if (d && typeof d.text === 'string') {
              for (let k = 0; k <= (rec.k || 0); k++) {
                off = d.text.indexOf(rec.raw, off + 1);
                if (off < 0) break;
              }
            }
            const w = off >= 0 ? { off, runs: d.runs } : null;
            places.set(rec, w);
            return w;
          };
          const json = V.isJsonDocName(e.doc);
          const add = [];
          e.ops.forEach((op, i) => {
            const len = op[2];
            const put = e.x.ins[i];
            if (len < MIN || len > OP_MAX || typeof put !== 'string' || put.length !== len) return;
            const held = pieces.filter((p) => Array.isArray(p) && p[0] === i && whole(p[1]) && Number.isSafeInteger(p[2]));
            const tv = V.looseOf(put, json);
            tv.at = Uint32Array.from(tv.at);
            const vn = tv.text.length;
            // view characters a piece already places (any of its raw units)
            const covered = new Uint8Array(vn);
            if (held.length) {
              const rawHeld = new Uint8Array(len);
              for (const p of held) rawHeld.fill(1, p[1], Math.min(len, p[1] + p[2]));
              for (let k = 0; k < vn; k++) {
                for (let r = tv.at[k]; r < tv.at[k + 1]; r++) if (rawHeld[r]) { covered[k] = 1; break; }
              }
            }
            const vis = textBefore(tv.text, !json);
            // something left to place, with text in it (in a JSON document,
            // with a letter or digit in it: what's left of a passage sent to
            // Darlings is often only the list's own commas and quotes)
            let open = 0;
            for (let k = 0; k < vn; k++) {
              if (covered[k] || vis[k + 1] === vis[k]) continue;
              if (!json || WORDY.test(tv.text[k])) open++;
            }
            if (!open) return;
            const got = matchStretch(tv, vis, [graves, index], target, covered, where, deadline);
            if (!got) { cut = true; return; }
            for (const m of got) add.push(...rawPieces(i, tv, m));
          });
          if (add.length && !cut) found.push({ dev, of: e.n, from: add.sort((x, y) => (x[0] - y[0]) || (x[1] - y[1])) });
        }
      };
    };
    V.traceAll(devices, { links, detail: true, hooks });
    return { relinks: found, cut };
  }

  // A log as readLog gives it, scanned: { relinks, skipped, cut } (skipped:
  // why nothing was looked at, when it wasn't: no words, or a chain that
  // doesn't check, which a relink mustn't build on; cut: as for scan)
  function scanLog(log, { budget = 0 } = {}) {
    const devices = [];
    for (const { dev, chunks } of log.chains) {
      const v = V.verifyChain(chunks, { key: log.key });
      if (!v.ok) return { relinks: [], skipped: 'damaged', cut: false };
      const byName = new Map(chunks.map((c) => [c.name, c]));
      devices.push({ dev, entries: v.chunks.flatMap((n) => byName.get(n).entries) });
    }
    if (!devices.some((d) => d.entries.some((e) => e.x))) return { relinks: [], skipped: 'no words', cut: false };
    const links = devices.length > 1 ? V.matchArrivals(devices) : new Map();
    // (the trace must already be clean: a relink never papers over damage)
    const check = V.traceAll(devices, { links });
    for (const t of check.values()) if (t.problems.length) return { relinks: [], skipped: 'damaged', cut: false };
    return { ...scan(devices, { links, budget }), skipped: null };
  }

  Object.assign(exports, { MIN, improves, matchStretch, scan, scanLog });
})(typeof module !== 'undefined' && module.exports ? module.exports : (globalThis.SlogRelink = {}));
