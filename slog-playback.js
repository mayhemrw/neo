'use strict';

// PLAYBACK: one chapter written again, entry by entry, from the Scribe's
// Log (phase 3). Shared by NEO's History window and the standalone
// verifier (for an export with the text). Plain JavaScript with no Node or
// Electron APIs; only the player (mount) needs a page to draw on.
//
//   build(chains, doc)     the chapter's steps: every entry that changed it
//                          on the computer that made the change (text that
//                          only arrived from another computer is that
//                          computer's own step), every chain merged by time
//   playback.frame(pos)    the chapter after `pos` steps, as that step's
//                          computer had it: clean markup (SlogDiff.viewHtml)
//                          with what the step put in marked, what it took
//                          out marked in the text before, and optionally
//                          every stretch colored by where it came from
//   playback.delays(opts)  how long each step waits at a speed, with long
//                          pauses shortened; times/positionAt for a scrubber
//   mount(host, playback)  the player: play, pause, step, speed, skip
//                          pauses, a scrubber by time, color by origin
//
// Origins are the checker's own (slog-verify.js's Tracer, with detail), so
// playback colors text exactly as the report counts it.

(function (api) {
  const hasRequire = typeof require === 'function';
  const V = hasRequire ? require('./slog-verify.js') : globalThis.SlogVerify;
  const D = hasRequire ? require('./slog-diff.js') : globalThis.SlogDiff;

  const PAUSE = 10e3;          // a gap longer than this is a pause…
  const PAUSE_SHOWN = 500;     // …and plays as this long when pauses are skipped
  const SESSION_SHOWN = 1500;  // a new session's date shows this long when skipping
  const SPEEDS = [1, 10, 60, 600];
  const EVERY = 64;            // each computer's text is kept whole every this many changes

  const ABSENT = undefined;    // a frame's text when the chapter isn't there
  // (null: there, but the log doesn't have its words)

  /* ------------------------------------------------------------------ */
  /*  Where text came from                                               */
  /* ------------------------------------------------------------------ */

  // The colors playback offers, from the checker's detailed origins: a
  // paste stays a paste wherever it's moved; text from a file or from
  // before the log began is imported; typed text moved within the book is
  // moved; what's left (arrived and never traced, unlabeled, changed while
  // the log was off) is other
  const ORIGINS = ['typed', 'pasted', 'moved', 'imported', 'other'];
  const groupCache = new Map();
  function originGroup(o) {
    if (o == null) return 'other';
    let g = groupCache.get(o);
    if (g) return g;
    const p = V.parseOrigin(o);
    if (p.cat === 'paste' || p.cat === 'drop') g = 'pasted';
    else if (p.cat === 'import' || p.cat === 'baseline' || p.cat === 'other book') g = 'imported';
    else if (p.moved || p.cat === 'move') g = 'moved';
    else if (p.cat === 'typed') g = 'typed';
    else g = 'other';
    if (groupCache.size > 5000) groupCache.clear();
    groupCache.set(o, g);
    return g;
  }
  // a document's runs as origin groups, neighbors joined
  function groupRuns(runs) {
    const out = [];
    for (const [len, o] of runs) {
      if (!len) continue;
      const g = originGroup(o);
      const last = out[out.length - 1];
      if (last && last[1] === g) last[0] += len;
      else out.push([len, g]);
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /*  What an entry put in and took out                                  */
  /* ------------------------------------------------------------------ */

  // ops applied to a text of length `len`: the stretches they took out, as
  // [at, len] in the text before, and the stretches they put in, as [at,
  // len] in the text after (an op's `at` is in the text as the ops before
  // it left it). Text put in by one op and taken out by a later one shows
  // in neither.
  function changes(len, ops) {
    let segs = len ? [{ o: 0, len }] : []; // the text after, as pieces: o is its start in the text before, -1 for new
    for (const op of ops) {
      const [at, del, ins] = op;
      const out = [];
      let pos = 0;
      let placed = false;
      const place = () => { if (!placed) { if (ins) out.push({ o: -1, len: ins }); placed = true; } };
      for (const s of segs) {
        const a = pos;
        const b = pos + s.len;
        pos = b;
        // before the op, the deleted stretch, after it
        const keepA = Math.min(b, at) - a;
        if (keepA > 0) out.push({ o: s.o < 0 ? -1 : s.o, len: keepA });
        if (b >= at) place();
        const cutTo = at + del;
        const keepB = b - Math.max(a, cutTo);
        if (keepB > 0) out.push({ o: s.o < 0 ? -1 : s.o + (s.len - keepB), len: keepB });
      }
      place();
      // neighbors that continue each other join up
      segs = [];
      for (const s of out) {
        const last = segs[segs.length - 1];
        if (last && ((last.o < 0 && s.o < 0) || (last.o >= 0 && s.o === last.o + last.len))) last.len += s.len;
        else segs.push({ ...s });
      }
    }
    const added = [];
    const kept = [];
    let pos = 0;
    for (const s of segs) {
      if (s.o < 0) added.push([pos, s.len]);
      else kept.push([s.o, s.len]);
      pos += s.len;
    }
    kept.sort((x, y) => x[0] - y[0]);
    const taken = [];
    let from = 0;
    for (const [o, l] of kept) {
      if (o > from) taken.push([from, o - from]);
      from = Math.max(from, o + l);
    }
    if (len > from) taken.push([from, len - from]);
    return { added, taken };
  }

  // A marker for SlogDiff.paragraphs: the key of every offset, from
  // stretches ([[at, len]] → one class) and origin runs ([[len, group]]),
  // asked in rising order (a fall starts it over)
  function marker(stretches, cls, runs) {
    let si = 0;
    let ri = 0;
    let rEnd = runs && runs.length ? runs[0][0] : 0;
    let last = -1;
    return (at) => {
      if (at < last) { si = 0; ri = 0; rEnd = runs && runs.length ? runs[0][0] : 0; }
      last = at;
      while (si < stretches.length && stretches[si][0] + stretches[si][1] <= at) si++;
      const inStretch = si < stretches.length && stretches[si][0] <= at;
      let group = '';
      if (runs) {
        while (ri < runs.length && rEnd <= at) { ri++; if (ri < runs.length) rEnd += runs[ri][0]; }
        group = ri < runs.length ? 'pb-o-' + runs[ri][1] : '';
      }
      const key = (inStretch ? cls : '') + (inStretch && group ? ' ' : '') + group;
      return key || null;
    };
  }

  const WORDISH = /[\p{L}\p{N}]/u;
  function countWords(html) {
    let n = 0;
    for (const p of D.paragraphs(html)) if (!p.brk) for (const w of D.words(p)) if (WORDISH.test(w.t)) n++;
    return n;
  }

  /* ------------------------------------------------------------------ */
  /*  One chapter's steps                                                */
  /* ------------------------------------------------------------------ */

  // A computer's changes to the chapter, in its chain's order (its own and
  // what arrived from others): { n, ts, kind, ops, ins, reset, runs }, the
  // text kept whole every EVERY changes
  function applyTo(text, le) {
    if (le.reset === 'new') return '';
    if (le.reset === 'del') return ABSENT;
    if (le.kind === 'base') return le.ins ? V.applyOps('', le.ops, le.ins) : null;
    if (text === ABSENT) return ABSENT;
    if (le.ins && text !== null) return V.applyOps(text, le.ops, le.ins);
    if (text !== null && le.ops.every((op) => op[2] === 0)) return V.applyOps(text, le.ops, le.ops.map(() => ''));
    return null;
  }

  class Lane {
    constructor(dev) {
      this.dev = dev;
      this.list = [];
      this.whole = new Map(); // index → text
      this.at = -1;           // the index…
      this.text = ABSENT;     // …and text last worked out
    }
    // the chapter after change i (ABSENT before the first)
    textAt(i) {
      if (i < 0) return ABSENT;
      if (i === this.at) return this.text;
      let from = i - (i % EVERY);
      let text = this.whole.get(from);
      if (this.at > from && this.at < i) { from = this.at; text = this.text; }
      for (let k = from + 1; k <= i; k++) {
        try { text = applyTo(text, this.list[k]); } catch { text = null; }
      }
      this.at = i;
      this.text = text;
      return text;
    }
    // the last change at or before entry n, or -1
    indexAt(n) {
      let lo = 0;
      let hi = this.list.length - 1;
      let best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (this.list[mid].n <= n) { best = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return best;
    }
  }

  // chains: [{ dev, entries }] (checkLog's devices will do), with the words.
  // doc: the chapter's document id. opts: { links (checkLog's, for text
  // matched across computers), names (Map dev → what to call it), from,
  // to ({ dev, n }: from just after that entry of that chain, to it) }.
  function build(chains, doc, { links = null, names = null, from = null, to = null } = {}) {
    const lanes = new Map();
    const session = new Map(); // dev → the open entry of the chunk being read
    const hooks = (dev) => ({
      step(e, tracer) {
        if (e.kind === 'open') { session.set(dev, e.n); return; }
        if (e.doc !== doc || !(e.kind === 'edit' || e.kind === 'base' || e.kind === 'doc')) return;
        let lane = lanes.get(dev);
        if (!lane) { lane = new Lane(dev); lanes.set(dev, lane); }
        const d = tracer.docs[doc];
        const le = {
          n: e.n, ts: e.ts, kind: e.kind, ops: Array.isArray(e.ops) ? e.ops : [], ins: e.x && Array.isArray(e.x.ins) ? e.x.ins : null,
          reset: e.kind === 'doc' ? (e.act === 'new' ? 'new' : 'del') : null,
          runs: d ? groupRuns(d.runs) : [],
          src: e.src, cause: e.cause, dur: e.dur, session: session.get(dev) || 0,
          step: (e.kind === 'edit' || e.kind === 'base') && e.src !== 'arrived'
        };
        const i = lane.list.push(le) - 1;
        if (i % EVERY === 0) lane.whole.set(i, d ? d.text : ABSENT);
      }
    });
    // (only the category and whether it was moved: the report's full detail
    // splits text by the hour it was written, which costs far more)
    const traced = V.traceAll(chains, { links, detail: 'moved', hooks });
    const problems = [];
    for (const [dev, t] of traced) for (const p of t.problems) if (p.doc === doc) problems.push({ dev, ...p });

    const devNames = names || V.deviceNames(chains.map((c) => ({ dev: c.dev, first: c.entries.length ? c.entries[0].ts : null })));
    const rank = new Map(chains.map((c) => [c.dev, 0]));
    [...devNames.keys()].forEach((dev, i) => rank.set(dev, i));
    const keyOf = (dev, n, ts) => [ts, rank.get(dev) ?? 0, n];
    const before = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    const tsOf = (dev, n) => {
      const c = chains.find((x) => x.dev === dev);
      if (!c) return null;
      let lo = 0;
      let hi = c.entries.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const m = c.entries[mid].n;
        if (m === n) return c.entries[mid].ts;
        if (m < n) lo = mid + 1; else hi = mid - 1;
      }
      return null;
    };
    const fromKey = from && tsOf(from.dev, from.n) !== null ? keyOf(from.dev, from.n, tsOf(from.dev, from.n)) : null;
    const toKey = to && tsOf(to.dev, to.n) !== null ? keyOf(to.dev, to.n, tsOf(to.dev, to.n)) : null;

    const steps = [];
    for (const lane of lanes.values()) {
      lane.list.forEach((le, i) => {
        if (!le.step) return;
        const key = keyOf(lane.dev, le.n, le.ts);
        if (fromKey && before(key, fromKey) <= 0) return;
        if (toKey && before(key, toKey) > 0) return;
        steps.push({
          dev: lane.dev, name: devNames.get(lane.dev) || lane.dev.slice(0, 8), n: le.n, ts: le.ts, dur: le.dur,
          kind: le.kind, src: le.src, cause: le.cause, session: lane.dev + ':' + le.session, key, li: i
        });
      });
    }
    steps.sort((a, b) => before(a.key, b.key));
    steps.forEach((s, i) => { s.newSession = i === 0 || s.session !== steps[i - 1].session; delete s.key; });

    // where it starts: the version it plays from, or before the chapter was
    let start = { lane: null, li: -1 };
    if (from) {
      const lane = lanes.get(from.dev);
      if (lane) start = { lane, li: lane.indexAt(from.n) };
    }
    return new Playback(doc, steps, lanes, start, problems);
  }

  class Playback {
    constructor(doc, steps, lanes, start, problems) {
      this.doc = doc;
      this.steps = steps;
      this.lanes = lanes;
      this.start = start;
      this.problems = problems;
      this._delays = null;
    }
    get length() { return this.steps.length; }
    // whether there are words to show (a log shared without its text has none)
    get words() {
      for (const lane of this.lanes.values()) for (const le of lane.list) if (le.ins) return true;
      return false;
    }

    // The chapter after `pos` steps (0: where it starts). opts: { origins
    // (color every stretch by where it came from) }. Returns { pos, step,
    // text, html, goneHtml (the text before, what this step took out
    // marked; null if nothing visible went), added (whether anything
    // visible came in), words, absent, blind (no words) }.
    frame(pos, { origins = false } = {}) {
      pos = Math.max(0, Math.min(this.steps.length, pos | 0));
      const step = pos ? this.steps[pos - 1] : null;
      let lane;
      let li;
      if (step) { lane = this.lanes.get(step.dev); li = step.li; } else { lane = this.start.lane; li = this.start.li; }
      const text = lane ? lane.textAt(li) : ABSENT;
      const out = { pos, step, text, html: '', goneHtml: null, added: false, words: 0, absent: text === ABSENT, blind: text === null };
      if (typeof text !== 'string') return out;
      const le = lane.list[li];
      let ch = { added: [], taken: [] };
      if (step) {
        const prev = lane.textAt(li - 1);
        lane.textAt(li); // (back where it was, for the next step)
        if (le.kind === 'base') ch = { added: text.length ? [[0, text.length]] : [], taken: [] };
        else if (typeof prev === 'string') ch = changes(prev.length, le.ops);
        if (ch.taken.length && typeof prev === 'string') {
          const gone = D.viewHtml(prev, marker(ch.taken, 'pb-gone', null));
          if (gone.includes('pb-gone')) out.goneHtml = gone;
        }
      }
      out.html = D.viewHtml(text, marker(ch.added, 'pb-new', origins && le ? le.runs : null));
      out.added = ch.added.length > 0 && out.html.includes('pb-new');
      out.words = countWords(text);
      return out;
    }

    // Real milliseconds waited before each position is shown (index 0 is
    // the start, 0). opts: { speed (1, 10, 60, 600…), skip (pauses over
    // ten seconds play as half a second; a new session waits a moment so
    // its date can be read) }
    delays({ speed = 10, skip = true } = {}) {
      const k = speed + '|' + skip;
      if (this._delays && this._delays.k === k) return this._delays.d;
      const d = new Float64Array(this.steps.length + 1);
      for (let i = 1; i <= this.steps.length; i++) {
        const s = this.steps[i - 1];
        const gap = i === 1 ? 0 : Math.max(0, s.ts - this.steps[i - 2].ts);
        let wait = skip && gap > PAUSE ? PAUSE_SHOWN : gap / speed;
        if (skip && s.newSession && i > 1) wait = Math.max(wait, SESSION_SHOWN);
        d[i] = wait;
      }
      this._delays = { k, d };
      return d;
    }
    // where each position falls on the time line (real ms from the start)
    times(opts) {
      const d = this.delays(opts);
      const t = new Float64Array(d.length);
      for (let i = 1; i < d.length; i++) t[i] = t[i - 1] + d[i];
      return t;
    }
    // the last position shown by `ms` into the playback
    positionAt(ms, opts, times = this.times(opts)) {
      let lo = 0;
      let hi = times.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (times[mid] <= ms) lo = mid; else hi = mid - 1;
      }
      return lo;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  The player                                                         */
  /* ------------------------------------------------------------------ */

  const plainT = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);

  // A step as words: what made the change
  function stepLabel(step, added, t) {
    const CAUSES = {
      undo: t('Undo'), redo: t('Redo'), replace: t('Replace'), spell: t('Spelling'), restore: t('Restored from a version'),
      split: t('Chapter split'), join: t('Chapters joined'), outline: t('Outline'), darling: t('Darlings'), placeholder: t('Placeholder'),
      off: t('Changed while the log was off')
    };
    if (step.cause && CAUSES[step.cause]) return CAUSES[step.cause];
    if (!added && step.kind === 'edit') return t('Taken out');
    const SRCS = {
      typed: t('Typed'), paste: t('Pasted'), drop: t('Dropped in'), move: t('Moved within the book'), import: t('Imported'),
      baseline: t('In the book when the log began'), unlogged: t('Saved without a label')
    };
    return SRCS[step.src] || step.src || '';
  }

  // host: an element to fill. opts: { t (translations, with {name}
  // placeholders), when(ms) and day(ms) (how to show a time and a date),
  // speed, skip, origins (to start with), start (position), onKey
  // (handed every key the player doesn't use) }. Returns { el, play,
  // pause, seek(pos), step(by), playing, pos, destroy }.
  function mount(host, pb, opts = {}) {
    const t = opts.t || plainT;
    const when = opts.when || ((ms) => new Date(ms).toLocaleString());
    const day = opts.day || ((ms) => new Date(ms).toLocaleDateString());
    const doc = host.ownerDocument;
    const el = (tag, cls, text) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    };
    const button = (cls, text, label) => {
      const b = el('button', cls, text);
      b.type = 'button';
      if (label) { b.setAttribute('aria-label', label); b.title = label; }
      return b;
    };
    let speed = SPEEDS.includes(opts.speed) ? opts.speed : 10;
    let skip = opts.skip !== false;
    let origins = !!opts.origins;
    let pos = 0;
    let playing = false;
    let timer = null;
    let flashTimer = null;
    let times = pb.times({ speed, skip });

    host.textContent = '';
    const root = el('div', 'pb');
    const bar = el('div', 'pb-bar');
    const back = button('pb-back', '⏮', t('Step back'));
    const playB = button('pb-play', '▶', t('Play'));
    const fwd = button('pb-fwd', '⏭', t('Step forward'));
    const speedSel = el('select', 'pb-speed');
    speedSel.setAttribute('aria-label', t('Speed'));
    speedSel.title = t('Speed');
    for (const s of SPEEDS) {
      const o = el('option', null, s + '×');
      o.value = String(s);
      speedSel.append(o);
    }
    speedSel.value = String(speed);
    const check = (cls, label, on) => {
      const lab = el('label', cls);
      const box = el('input');
      box.type = 'checkbox';
      box.checked = on;
      lab.append(box, doc.createTextNode(' ' + label));
      return { lab, box };
    };
    const skipC = check('pb-skip', t('Skip pauses'), skip);
    const origC = check('pb-origins', t('Color by origin'), origins);
    bar.append(back, playB, fwd, speedSel, skipC.lab, origC.lab);
    const scrub = el('input', 'pb-scrub');
    scrub.type = 'range';
    scrub.min = '0';
    scrub.step = 'any';
    scrub.setAttribute('aria-label', t('Position'));
    const status = el('div', 'pb-status');
    const sessionLine = el('div', 'pb-session');
    const legend = el('div', 'pb-legend');
    const LEGEND = { typed: t('Typed'), pasted: t('Pasted'), moved: t('Moved'), imported: t('Imported'), other: t('Other') };
    for (const g of ORIGINS) {
      const item = el('span', 'pb-key pb-o-' + g, LEGEND[g]);
      legend.append(item);
    }
    const page = el('div', 'pb-page');
    page.tabIndex = 0;
    page.setAttribute('aria-label', t('The chapter as it was'));
    root.append(bar, scrub, status, sessionLine, legend, page);
    host.append(root);

    const setScrub = () => {
      scrub.max = String(times[times.length - 1] || 0);
      scrub.value = String(times[pos] || 0);
      scrub.disabled = !pb.length;
    };
    const fmtN = (n) => { try { return n.toLocaleString(); } catch { return String(n); } };
    // the change in view: the page scrolls only when it's out of sight
    const reveal = () => {
      const target = page.querySelector('.pb-new, .pb-gone');
      if (!target) return;
      const top = target.offsetTop;
      if (top < page.scrollTop || top > page.scrollTop + page.clientHeight - 40) page.scrollTop = Math.max(0, top - page.clientHeight / 3);
    };
    const draw = (f) => {
      if (f.absent) {
        page.textContent = '';
        page.append(el('p', 'pb-empty', f.step ? t('The chapter isn\'t in the book at this point.') : t('The chapter hasn\'t been started yet.')));
      } else if (f.blind) {
        page.textContent = '';
        page.append(el('p', 'pb-empty', t('This can\'t be shown: the log doesn\'t have these words.')));
      } else {
        page.innerHTML = f.html; // SlogDiff.viewHtml: markup built from the text, never the saved HTML
      }
      reveal();
    };
    const show = (to, { flash = false } = {}) => {
      clearTimeout(flashTimer);
      pos = Math.max(0, Math.min(pb.length, to));
      const f = pb.frame(pos, { origins });
      const s = f.step;
      status.textContent = s
        ? [when(s.ts), s.name, stepLabel(s, f.added, t), t('{n} words', { n: fmtN(f.words) }), t('Step {n} of {total}', { n: fmtN(pos), total: fmtN(pb.length) })].join(' · ')
        : [t('Start'), f.absent ? '' : t('{n} words', { n: fmtN(f.words) }), t('{total} steps', { total: fmtN(pb.length) })].filter(Boolean).join(' · ');
      sessionLine.textContent = s ? t('Session of {date}, {device}', { date: day(s.ts), device: s.name }) : '';
      sessionLine.classList.toggle('pb-fresh', !!(s && s.newSession && flash));
      legend.hidden = !origins;
      root.classList.toggle('pb-colored', origins);
      if (flash && f.goneHtml) {
        // what goes, shown going, then the page as it's left
        page.innerHTML = f.goneHtml;
        reveal();
        const next = playing && pos < pb.length ? pb.delays({ speed, skip })[pos + 1] : 400;
        flashTimer = setTimeout(() => draw(f), Math.max(60, Math.min(300, next / 2)));
      } else draw(f);
      scrub.value = String(times[pos] || 0);
      back.disabled = pos === 0;
      fwd.disabled = pos >= pb.length;
      root.dataset.pos = String(pos);
    };
    const setPlaying = (on) => {
      playing = on;
      playB.textContent = on ? '⏸' : '▶';
      playB.setAttribute('aria-label', on ? t('Pause') : t('Play'));
      playB.title = on ? t('Pause') : t('Play');
      root.classList.toggle('pb-playing', on);
    };
    const schedule = () => {
      clearTimeout(timer);
      if (!playing) return;
      if (pos >= pb.length) { setPlaying(false); return; }
      const wait = pb.delays({ speed, skip })[pos + 1];
      timer = setTimeout(() => { show(pos + 1, { flash: true }); schedule(); }, wait);
    };
    const play = () => {
      if (!pb.length) return;
      if (pos >= pb.length) show(0);
      setPlaying(true);
      schedule();
    };
    const pause = () => { clearTimeout(timer); setPlaying(false); };
    const seek = (p) => { show(p); if (playing) schedule(); };
    const stepBy = (by) => { pause(); show(pos + by, { flash: by === 1 }); };

    back.addEventListener('click', () => stepBy(-1));
    fwd.addEventListener('click', () => stepBy(1));
    playB.addEventListener('click', () => (playing ? pause() : play()));
    speedSel.addEventListener('change', () => {
      speed = Number(speedSel.value) || 10;
      times = pb.times({ speed, skip });
      setScrub();
      if (playing) schedule();
    });
    skipC.box.addEventListener('change', () => {
      skip = skipC.box.checked;
      times = pb.times({ speed, skip });
      setScrub();
      if (playing) schedule();
    });
    origC.box.addEventListener('change', () => { origins = origC.box.checked; show(pos); });
    scrub.addEventListener('input', () => seek(pb.positionAt(Number(scrub.value), { speed, skip }, times)));
    // Space or K plays and pauses, ← → step (Shift: ten at a time), Home
    // and End go to either end. A control keeps its own keys (Space on a
    // button presses it, arrows move the scrubber or the speed).
    root.addEventListener('keydown', (e) => {
      const tag = e.target && e.target.tagName;
      const own = tag === 'SELECT' || tag === 'INPUT' || (tag === 'BUTTON' && (e.key === ' ' || e.key === 'Enter'));
      let used = false;
      if (!own && !e.metaKey && !e.ctrlKey && !e.altKey) {
        used = true;
        if (e.key === ' ' || e.key === 'k') { if (playing) pause(); else play(); } else if (e.key === 'ArrowRight' || e.key === '.') stepBy(e.shiftKey ? 10 : 1);
        else if (e.key === 'ArrowLeft' || e.key === ',') stepBy(e.shiftKey ? -10 : -1);
        else if (e.key === 'Home') { pause(); show(0); } else if (e.key === 'End') { pause(); show(pb.length); } else used = false;
      }
      if (used) { e.preventDefault(); e.stopPropagation(); } else if (opts.onKey) opts.onKey(e);
    });

    setScrub();
    show(Number.isSafeInteger(opts.start) ? opts.start : 0);
    return {
      el: root, play, pause, seek, step: stepBy,
      get playing() { return playing; },
      get pos() { return pos; },
      destroy() { clearTimeout(timer); clearTimeout(flashTimer); playing = false; root.remove(); }
    };
  }

  Object.assign(api, {
    PAUSE, PAUSE_SHOWN, SESSION_SHOWN, SPEEDS, ORIGINS,
    originGroup, groupRuns, changes, marker, countWords, build, Playback, stepLabel, mount
  });
})(typeof module !== 'undefined' && module.exports ? module.exports : (globalThis.SlogPlayback = {}));
