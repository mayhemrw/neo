// THE SCRIBE'S LOG, REPORTED: the verification report, from a log the
// checker has been through (slog-verify.js checkLog). Plain JavaScript with
// no Node or Electron APIs, like the checker, so NEO (File → Scribe's Log →
// Verification Report…) and the standalone verifier make the same report.
//
//   reportStats(res, opts)     the numbers: origins overall and by chapter,
//                              revision, sessions, the timeline, timestamps,
//                              flags. Times stay UTC milliseconds.
//   renderReport(stats, opts)  one self-contained HTML page, with the times
//                              shown exactly, as dates, or as weeks
//
// Counting: a character of the manuscript is a unit of a chapter's text
// outside tags and outside what the manuscript hash leaves out (proseMask).
// A log without its words still knows which units were tags (every op
// lists the markup it inserted), so it counts too, a little less exactly:
// it can't see scene breaks, unwritten outline sections or placeholder
// marks, and a character reference (`&nbsp;`) counts as several.

'use strict';

(function (exports) {
  const V = typeof require === 'function' ? require('./slog-verify.js') : globalThis.SlogVerify;

  const IDLE = 10 * 60e3; // a pause longer than this ends a run of writing
  const HOUR = 3600e3;

  // Where text came from, in the order the report lists them
  const CATS = ['typed', 'paste', 'paste revised', 'import', 'baseline', 'arrived', 'other book', 'move', 'while off', 'unlogged'];
  // …and the few the timeline draws, everything else folded into "other"
  const GROUPS = ['typed', 'paste', 'paste revised', 'import', 'baseline', 'other'];
  const groupOf = (cat) => (GROUPS.includes(cat) ? cat : 'other');

  const isChapter = (doc) => typeof doc === 'string' && V.docChapter(doc) !== null;
  const add = (o, k, n) => { if (n) o[k] = (o[k] || 0) + n; };

  // Prose units inserted by an op, from its length and markup list
  function opProse(op) {
    let n = op[2] || 0;
    if (Array.isArray(op[3])) for (const m of op[3]) if (Array.isArray(m) && m[1] > 0) n -= m[1];
    return Math.max(0, n);
  }
  // Prose units in detailed runs (markup flagged), without the words
  const runsProse = (runs) => runs.reduce((a, [len, o]) => a + (V.parseOrigin(o).tag ? 0 : len), 0);

  // A traced document's units counted by detailed origin: Map origin → n.
  // With its text, the units of writing are proseMask's; without, the runs'
  // markup flags. Cached while the document stays the same.
  function docCounter() {
    const cache = new WeakMap();
    return function count(d) {
      const had = cache.get(d);
      if (had && had.v === (d.v || 0)) return had.counts;
      const counts = new Map();
      if (typeof d.text === 'string') {
        const mask = V.proseMask(d.text);
        let pos = 0;
        for (const [len, o] of d.runs) {
          let n = 0;
          for (let k = pos; k < pos + len && k < mask.length; k++) n += mask[k];
          if (n) counts.set(o, (counts.get(o) || 0) + n);
          pos += len;
        }
      } else {
        for (const [len, o] of d.runs) if (!V.parseOrigin(o).tag) counts.set(o, (counts.get(o) || 0) + len);
      }
      cache.set(d, { v: d.v || 0, counts });
      return counts;
    };
  }

  // A detailed origin's category, a paste split by whether it was revised
  function catOf(o, revised) {
    const p = V.parseOrigin(o);
    if (p.cat === 'paste' && p.paste && revised.has(p.paste)) return 'paste revised';
    return CATS.includes(p.cat) ? p.cat : 'unlogged';
  }

  // The book's chapters in order, with titles: from the book's own record
  // when the words are there, else from the export's manifest, else in the
  // order the log first touched them
  function chapterList(docs, entries, manifest) {
    let meta = null;
    if (docs.book && typeof docs.book.text === 'string') { try { meta = JSON.parse(docs.book.text); } catch { /* not readable */ } }
    if (meta && Array.isArray(meta.chapterOrder)) {
      const kinds = meta.chapterKinds || {};
      const titles = meta.chapterTitles || {};
      return meta.chapterOrder.filter((id) => kinds[id] !== 'contents' && docs[V.chapterDoc(id)])
        .map((id) => ({ doc: V.chapterDoc(id), title: typeof titles[id] === 'string' && titles[id].trim() ? titles[id].trim() : null }));
    }
    if (manifest && Array.isArray(manifest.chapters)) {
      return manifest.chapters.filter((id) => typeof id === 'string' && docs[V.chapterDoc(id)]).map((id) => ({ doc: V.chapterDoc(id), title: null }));
    }
    const seen = [];
    for (const e of entries) if (isChapter(e.doc) && docs[e.doc] && !seen.includes(e.doc)) seen.push(e.doc);
    return seen.map((doc) => ({ doc, title: null }));
  }

  /* ------------------------------------------------------------------ */
  /*  The numbers                                                        */
  /* ------------------------------------------------------------------ */

  // res: checkLog's result. opts: { manifest (an export's), meta ({ title,
  // author } from the book, in NEO) }. Everything the report shows.
  function reportStats(res, { manifest = null, meta = null } = {}) {
    const devices = res.devices || [];
    const names = new Map(devices.map((d) => [d.dev, d.name]));
    const count = docCounter();

    // revision: prose deleted from chapters and not put back elsewhere in
    // the book (a move isn't a deletion), by chapter and by hour
    const deleted = { total: 0, byDoc: {}, byHour: {} };
    // …and each entry's own, for the sessions: prose added (not moved) and deleted
    const perEntry = new Map();
    const mine = (dev, e) => {
      const k = dev + '|' + e.n;
      if (!perEntry.has(k)) perEntry.set(k, { added: 0, deleted: 0 });
      return perEntry.get(k);
    };
    const cut = (doc, ts, n) => {
      deleted.total += n;
      add(deleted.byDoc, doc, n);
      if (Number.isSafeInteger(ts)) add(deleted.byHour, Math.floor(ts / HOUR), n);
    };
    // the timeline: the manuscript counted at the end of every session
    const samples = [];
    const sample = (dev, ts, tracer) => {
      const list = chapterList(tracer.docs, [], manifest);
      const docs = list.length ? list.map((c) => c.doc) : Object.keys(tracer.docs).filter(isChapter);
      const groups = {};
      for (const doc of docs) {
        const d = tracer.docs[doc];
        if (!d) continue;
        for (const [o, n] of count(d)) add(groups, groupOf(catOf(o, tracer.revised)), n);
      }
      samples.push({ ts, dev, groups, total: Object.values(groups).reduce((a, n) => a + n, 0) });
    };
    const lastN = new Map(devices.map((d) => [d.dev, d.entries.length ? d.entries[d.entries.length - 1].n : null]));
    const hooks = (dev) => ({
      step(e, tracer) {
        if ((e.kind === 'close' || e.n === lastN.get(dev)) && Number.isSafeInteger(e.ts)) sample(dev, e.ts, tracer);
      },
      cut(e, gone) {
        // another device's changes, arriving here, are counted on that device's chain
        if (e.src === 'arrived' || !isChapter(e.doc)) return;
        const n = runsProse(gone);
        cut(e.doc, e.ts, n);
        mine(dev, e).deleted += n;
      },
      // text put into a chapter from elsewhere in the book: from another
      // chapter (a move, whether its deletion is logged before or after) or
      // from Darlings (a passage restored) it's taken back off what was
      // deleted; from the notes or the outline it's new to the manuscript
      back(e, take, source, src) {
        if (!isChapter(e.doc)) return;
        const n = runsProse(take);
        mine(dev, e).added -= n; // moved, not new
        const grave = Number.isSafeInteger(source.n);
        const fromDoc = grave ? src.doc : source.doc;
        if (!(isChapter(fromDoc) || fromDoc === 'darlings')) return;
        cut(isChapter(fromDoc) ? fromDoc : e.doc, grave && Number.isSafeInteger(src.ts) ? src.ts : e.ts, -n);
        mine(dev, e).deleted -= n;
      }
    });
    const traced = devices.length ? V.traceAll(devices, { links: res.links || null, detail: true, hooks }) : new Map();
    const revised = new Set();
    for (const t of traced.values()) for (const p of t.revised) revised.add(p);

    // the manuscript as the device that wrote last has it
    const newest = res.newest || devices[devices.length - 1] || null;
    const final = newest ? traced.get(newest.dev).docs : {};
    const chapters = chapterList(final, newest ? newest.entries : [], manifest).map((c, i) => {
      const counts = {};
      const byHour = {};
      let moved = 0;
      for (const [o, n] of count(final[c.doc])) {
        add(counts, catOf(o, revised), n);
        const p = V.parseOrigin(o);
        if (p.hour !== null) add(byHour, p.hour, n);
        if (p.moved) moved += n;
      }
      const total = Object.values(counts).reduce((a, n) => a + n, 0);
      return { ...c, index: i + 1, counts, total, moved, byHour, deleted: Math.max(0, deleted.byDoc[c.doc] || 0) };
    });
    const counts = {};
    const survivingByHour = {};
    let moved = 0;
    for (const c of chapters) {
      for (const [k, n] of Object.entries(c.counts)) add(counts, k, n);
      for (const [h, n] of Object.entries(c.byHour)) add(survivingByHour, h, n);
      moved += c.moved;
    }
    const total = Object.values(counts).reduce((a, n) => a + n, 0);

    // sessions: one chunk of one device, with writing in it (not only text
    // arriving from another device); active time is each run of changes
    // from its first to its last, pauses over IDLE left out
    const sessions = [];
    for (const d of devices) {
      let s = null;
      const flush = () => {
        if (!s) return;
        if (s.spans.length) {
          let active = 0;
          let a = s.spans[0][0];
          let b = s.spans[0][1];
          for (const [x, y] of s.spans.slice(1)) {
            if (x - b > IDLE) { active += b - a; a = x; }
            b = Math.max(b, y);
          }
          active += b - a;
          active = Math.max(active, 1); // (a single quick change is still some writing)
          sessions.push({ dev: d.dev, name: d.name, start: s.start, end: s.end, active, added: Math.max(0, s.added), removed: Math.max(0, s.removed), changes: s.spans.length });
        }
        s = null;
      };
      for (const e of d.entries) {
        if (e.kind === 'open') { flush(); s = { start: e.ts, end: e.ts, spans: [], added: 0, removed: 0 }; continue; }
        if (!s) s = { start: e.ts, end: e.ts, spans: [], added: 0, removed: 0 };
        if (Number.isSafeInteger(e.ts)) s.end = Math.max(s.end, e.ts);
        if ((e.kind === 'edit' || e.kind === 'base') && e.src !== 'arrived' && Array.isArray(e.ops) && Number.isSafeInteger(e.ts)) {
          s.spans.push([e.ts, e.ts + (Number.isSafeInteger(e.dur) && e.dur > 0 ? e.dur : 0)]);
          if (e.kind === 'edit' && isChapter(e.doc)) {
            for (const op of e.ops) s.added += opProse(op);
            const own = perEntry.get(d.dev + '|' + e.n);
            if (own) { s.added += own.added; s.removed += own.deleted; }
          }
        }
      }
      flush();
    }
    sessions.sort((a, b) => a.start - b.start);

    // the outside timestamps
    const results = (res.receipts && res.receipts.results) || [];
    const bySvc = {};
    let bitcoin = 0;
    let pending = 0;
    // a pending proof whose finished copy came later (NEO keeps both) isn't waiting any more
    const finished = new Set(results.filter((r) => r.kind === 'ots' && (r.status === 'bitcoin' || r.status === 'ok')).map((r) => r.dev + '|' + r.n));
    let superseded = 0;
    for (const r of results) {
      if (r.kind === 'ots' && r.status === 'pending' && finished.has(r.dev + '|' + r.n)) { superseded++; continue; }
      if (!bySvc[r.svc]) bySvc[r.svc] = {};
      add(bySvc[r.svc], r.status, 1);
      if (r.kind === 'ots' && (r.status === 'bitcoin' || r.status === 'ok')) bitcoin++;
      if (r.kind === 'ots' && r.status === 'pending') pending++;
    }
    const stamps = [];
    let longest = null;
    const tails = [];
    for (const d of devices) {
      const cov = res.coverage && res.coverage.get(d.dev);
      if (!cov) continue;
      for (const s of cov.stamps) stamps.push({ dev: d.dev, n: s.n, time: s.time, svcs: s.svcs });
      if (cov.longest && (!longest || cov.longest.ms > longest.ms)) longest = { ...cov.longest, dev: d.dev, name: d.name };
      if (cov.tail) tails.push({ ...cov.tail, dev: d.dev, name: d.name });
    }
    stamps.sort((a, b) => a.time - b.time);

    // flags: the clock, sessions that didn't close, damage
    const tsOf = (dev, n) => {
      const d = devices.find((x) => x.dev === dev);
      const e = d && d.entries.find((x) => x.n === n);
      return e ? e.ts : null;
    };
    const clock = (res.clock || []).map((f) => ({ ...f, name: names.get(f.dev) || '?', ts: tsOf(f.dev, f.n) }));
    const unclosed = [];
    for (const d of devices) {
      for (const note of d.notes || []) {
        if (note.note !== 'session ended without closing') continue;
        const i = d.chunks.indexOf(note.chunk);
        const opens = d.entries.filter((e) => e.kind === 'open');
        unclosed.push({ name: d.name, chunk: note.chunk, ts: opens[i] ? opens[i].ts : null });
      }
    }
    const damage = [
      ...(res.problems || []).map((p) => (typeof p === 'string' ? p : JSON.stringify(p))),
      ...devices.flatMap((d) => (d.problems || []).map((p) => d.name + ': ' + (p.problem || JSON.stringify(p)) + (p.n ? ' (#' + p.n + ')' : ''))),
      ...((res.receipts && res.receipts.problems) || []).map((p) => (names.get(p.dev) || '?') + ': ' + p.problem + (p.n ? ' (#' + p.n + ')' : ''))
    ];

    // the manuscript's fingerprint: from the words when they're here, else
    // the last close of the device that wrote last
    let manuscript = null;
    if (newest) {
      const close = newest.entries.slice().reverse().find((e) => e.kind === 'close' && typeof e.ms === 'string');
      if (close) manuscript = { hash: close.ms, at: close.ts, from: 'close' };
      if (res.words) {
        const text = {};
        for (const [id, d] of Object.entries(final)) if (typeof d.text === 'string') text[id] = d.text;
        const h = V.manuscriptHash(V.manuscriptText(text));
        if (!manuscript || manuscript.hash !== h) manuscript = { hash: h, at: newest.last, from: 'words' };
      }
    }
    if (manifest && manifest.manuscript && manifest.manuscript.hash && !manuscript) manuscript = { hash: manifest.manuscript.hash, at: manifest.exported, from: 'manifest' };

    const versions = [...new Set(devices.flatMap((d) => d.entries.filter((e) => e.kind === 'open' && typeof e.app === 'string').map((e) => e.app.replace(/\+slog\d+$/, ''))))];
    const all = devices.flatMap((d) => [d.first, d.last]).filter(Number.isSafeInteger);
    return {
      ok: !!res.ok && !damage.length,
      logId: res.logId || (manifest && manifest.logId) || null,
      words: !!res.words,
      title: (meta && meta.title) || (manifest && manifest.title) || '',
      author: (meta && meta.author) || (manifest && manifest.author) || '',
      exported: manifest ? manifest.exported : null,
      versions,
      period: all.length ? { first: Math.min(...all), last: Math.max(...all) } : null,
      devices: devices.slice().sort((a, b) => (a.first ?? 0) - (b.first ?? 0)).map((d) => ({
        name: d.name, dev8: d.dev.slice(0, 8), chunks: d.chunks.length, entries: d.entries.length, first: d.first, last: d.last, ok: d.ok, arrivals: d.arrivals
      })),
      counts, total, moved, chapters,
      deleted: Math.max(0, deleted.total), deletedByHour: deleted.byHour, survivingByHour,
      samples: samples.sort((a, b) => a.ts - b.ts),
      sessions,
      receipts: { total: results.length, bySvc, bitcoin, pending, superseded, stamped: stamps.length, stamps, longest, tails },
      flags: { clock, unclosed, damage },
      manuscript,
      archives: res.archives || []
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Time, as the report shows it                                       */
  /* ------------------------------------------------------------------ */

  // A time zone's calendar: day, week (from Monday) and month keys for a
  // UTC time, and labels. tz is an IANA name; a bad one is UTC.
  function calendar(tz, locale) {
    let zoneName = tz || 'UTC';
    let parts;
    try { parts = new Intl.DateTimeFormat('en-US', { timeZone: zoneName, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch {
      zoneName = 'UTC';
      parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }
    const offsets = new Map();
    // the zone's offset, looked up once per UTC hour
    const offset = (ms) => {
      const h = Math.floor(ms / HOUR);
      let o = offsets.get(h);
      if (o === undefined) {
        const p = {};
        for (const x of parts.formatToParts(new Date(h * HOUR))) p[x.type] = x.value;
        o = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - h * HOUR;
        offsets.set(h, o);
      }
      return o;
    };
    const local = (ms) => new Date(ms + offset(ms));
    const pad = (n) => String(n).padStart(2, '0');
    const keyOf = (d) => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    const dayKey = (ms) => keyOf(local(ms));
    const weekKey = (ms) => {
      const d = local(ms);
      const back = (d.getUTCDay() + 6) % 7;
      return keyOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)));
    };
    const monthKey = (ms) => dayKey(ms).slice(0, 7);
    const keyDate = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d || 1)); };
    const loc = locale || 'en';
    const mk = (opts) => { try { return new Intl.DateTimeFormat(loc, opts); } catch { return new Intl.DateTimeFormat('en', opts); } };
    const exact = mk({ timeZone: zoneName, dateStyle: 'medium', timeStyle: 'short' });
    const dateF = mk({ timeZone: 'UTC', dateStyle: 'medium' });
    const monthF = mk({ timeZone: 'UTC', year: 'numeric', month: 'long' });
    const shortF = mk({ timeZone: 'UTC', month: 'short', day: 'numeric' });
    const timeF = mk({ timeZone: zoneName, timeStyle: 'short' });
    const monShort = mk({ timeZone: 'UTC', month: 'short' });
    const wdF = mk({ timeZone: 'UTC', weekday: 'short' });
    return {
      zone: zoneName, dayKey, weekKey, monthKey, keyDate,
      exact: (ms) => exact.format(new Date(ms)),
      time: (ms) => timeF.format(new Date(ms)),
      date: (key) => dateF.format(keyDate(key)),
      short: (key) => shortF.format(keyDate(key)),
      month: (key) => monthF.format(keyDate(key)),
      monthShort: (key) => monShort.format(keyDate(key)),
      weekday: (key) => wdF.format(keyDate(key))
    };
  }

  /* ------------------------------------------------------------------ */
  /*  The page                                                           */
  /* ------------------------------------------------------------------ */

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
  const plainT = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);

  // Series colors: the timeline's groups, in a fixed order (checked for
  // color-blind separation between neighbors), and a blue ramp for the calendar
  const COLORS = { typed: '#2a78d6', paste: '#eb6834', 'paste revised': '#1baf7a', import: '#eda100', baseline: '#e87ba4', other: '#008300' };
  const RAMP = ['#ebeae6', '#b7d3f6', '#6da7ec', '#2a78d6', '#1c5cab', '#0d366b'];

  // stats: reportStats'. opts: { privacy: 'exact' | 'dates' | 'weeks', tz,
  // locale, t (NEO's translator; English otherwise), generator ("NEO 1.4.3",
  // "the verifier from NEO 1.4.3"), generated (ms), canShow ([paragraphs]),
  // manuscriptCheck ({ matched, name }, from the verifier), note (a line
  // under the title) }
  function renderReport(stats, opts = {}) {
    const privacy = ['exact', 'dates', 'weeks'].includes(opts.privacy) ? opts.privacy : 'exact';
    const t = opts.t || plainT;
    const cal = calendar(opts.tz, opts.locale);
    const num = (() => { try { return new Intl.NumberFormat(opts.locale || 'en'); } catch { return new Intl.NumberFormat('en'); } })();
    const n = (v) => num.format(Math.round(v || 0));
    const pct = (part, whole) => (whole ? (Math.round(1000 * part / whole) / 10).toFixed(1) + '%' : '–');
    const ratio = (a, b) => (b ? (Math.round(100 * a / b) / 100).toFixed(2) : '–');
    // a time, as the privacy setting allows
    const when = (ms) => {
      if (!Number.isSafeInteger(ms)) return '?';
      if (privacy === 'exact') return cal.exact(ms);
      if (privacy === 'dates') return cal.date(cal.dayKey(ms));
      return t('week of {date}', { date: cal.date(cal.weekKey(ms)) });
    };
    const dur = (ms) => {
      const m = Math.round((ms || 0) / 60000);
      if (ms > 0 && m < 1) return t('under a minute');
      if (m < 60) return t('{m} min', { m });
      if (m < 48 * 60) return t('{h} h {m} min', { h: Math.floor(m / 60), m: m % 60 });
      return t('{d} days', { d: Math.round(m / 1440) });
    };
    const LABEL = {
      typed: t('Typed in NEO'),
      paste: t('Pasted from outside'),
      'paste revised': t('Pasted from outside, then revised'),
      import: t('Imported'),
      baseline: t('Already there when the log began'),
      arrived: t('Arrived from another device, not traced'),
      'other book': t('Copied from another book'),
      move: t('Moved within the book, place not recorded'),
      'while off': t('Changed while the log was off'),
      unlogged: t('Not logged'),
      other: t('Everything else')
    };
    const s = stats;
    const chTitle = (c) => c.title || t('Chapter {n}', { n: c.index });

    /* -------- the timeline -------- */
    function timeline() {
      // the samples, at most one per day (dates) or week (weeks): the last of each
      let pts = s.samples.map((p) => ({ ...p, key: cal.dayKey(p.ts) }));
      if (privacy !== 'exact') {
        // the last count of each day (week), placed at the end of its writing
        const key = privacy === 'dates' ? cal.dayKey : cal.weekKey;
        const by = new Map();
        for (const p of pts) by.set(key(p.ts), { ...p, key: key(p.ts) });
        pts = [...by.values()];
      }
      if (!pts.length) return `<p class="muted">${esc(t('Nothing written yet.'))}</p>`;
      const W = 720;
      const H = 220;
      const L = 56;
      const R = 12;
      const T = 10;
      const B = 26;
      const x0 = pts[0].ts;
      const x1 = Math.max(pts[pts.length - 1].ts, x0 + 1);
      const ymax = Math.max(1, ...pts.map((p) => p.total));
      const step = niceStep(ymax / 4);
      const top = Math.ceil(ymax / step) * step;
      const X = (ts) => L + (W - L - R) * (pts.length === 1 ? 0.5 : (ts - x0) / (x1 - x0));
      const Y = (v) => T + (H - T - B) * (1 - v / top);
      const used = GROUPS.filter((g) => pts.some((p) => p.groups[g]));
      let svg = '';
      for (let v = 0; v <= top + 1e-9; v += step) {
        svg += `<line x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="grid"/>`;
        svg += `<text x="${L - 6}" y="${(Y(v) + 4).toFixed(1)}" class="axis" text-anchor="end">${esc(n(v))}</text>`;
      }
      // stacked areas, a 2px gap of the page between them
      const base = pts.map(() => 0);
      for (const g of used) {
        const lo = base.slice();
        const hi = pts.map((p, i) => (base[i] += p.groups[g] || 0));
        const xs = pts.map((p) => X(p.ts));
        if (pts.length === 1) { xs.unshift(L); xs.push(W - R); lo.unshift(lo[0]); lo.push(lo[lo.length - 1]); hi.unshift(hi[0]); hi.push(hi[hi.length - 1]); }
        const upper = xs.map((x, i) => `${x.toFixed(1)},${Y(hi[i]).toFixed(1)}`);
        const lower = xs.map((x, i) => `${x.toFixed(1)},${Y(lo[i]).toFixed(1)}`).reverse();
        svg += `<polygon points="${upper.join(' ')} ${lower.join(' ')}" fill="${COLORS[g]}" fill-opacity="0.85" stroke="#fcfcfb" stroke-width="1" stroke-linejoin="round"/>`;
      }
      // x labels: first and last, and the middle when there's room
      const xl = [[pts[0], 'start'], [pts[pts.length - 1], 'end']];
      if (x1 - x0 > 14 * 24 * HOUR) {
        const mid = (x0 + x1) / 2;
        xl.push([pts.reduce((a, p) => (Math.abs(p.ts - mid) < Math.abs(a.ts - mid) ? p : a)), 'middle']);
      }
      if (pts.length === 1 || pts[0].key === pts[pts.length - 1].key) xl.length = 1;
      // all on one day, shown exactly: the times
      const oneDay = privacy === 'exact' && pts[0].key === pts[pts.length - 1].key && pts.length > 1;
      if (oneDay) xl.splice(0, xl.length, [pts[0], 'start'], [pts[pts.length - 1], 'end']);
      for (const [p, a] of xl) svg += `<text x="${X(p.ts).toFixed(1)}" y="${H - 8}" class="axis" text-anchor="${xl.length === 1 ? 'start' : a}">${esc(oneDay ? (a === 'start' ? cal.short(p.key) + ', ' : '') + cal.time(p.ts) : cal.short(p.key))}</text>`;
      svg += `<line x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}" class="baseline"/>`;
      // under it: the outside timestamps, and what only the computer's clock dates
      const S = 34;
      let strip = `<line x1="${L}" x2="${W - R}" y1="14" y2="14" class="grid"/>`;
      for (const st of s.receipts.stamps) {
        if (st.time < x0 - 24 * HOUR || st.time > x1 + 24 * HOUR) continue;
        const x = Math.min(W - R, Math.max(L, X(st.time)));
        strip += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="6" y2="22" class="tick"/>`;
      }
      for (const tl of s.receipts.tails) {
        if (!Number.isSafeInteger(tl.firstTs)) continue;
        const a = Math.max(L, Math.min(W - R, X(tl.firstTs)));
        const b = Math.max(a + 3, Math.min(W - R, X(tl.lastTs)));
        strip += `<rect x="${a.toFixed(1)}" y="6" width="${(b - a).toFixed(1)}" height="16" fill="url(#hatch)" class="tail"/>`;
      }
      const legend = used.map((g) => `<span class="key"><i style="background:${COLORS[g]}"></i>${esc(LABEL[g])}</span>`).join('');
      const data = JSON.stringify({
        x: pts.map((p) => +X(p.ts).toFixed(1)),
        label: pts.map((p) => (privacy === 'exact' ? cal.exact(p.ts) : privacy === 'dates' ? cal.date(p.key) : t('week of {date}', { date: cal.date(p.key) }))),
        rows: pts.map((p) => used.map((g) => p.groups[g] || 0)),
        total: pts.map((p) => p.total),
        names: used.map((g) => LABEL[g]), colors: used.map((g) => COLORS[g]), totalName: t('All'),
        fmt: opts.locale || 'en', W
      }).replace(/</g, '\\u003c');
      return `<div class="legend">${legend}</div>
<div class="chart" data-chart>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('Characters in the manuscript over time, by where they came from'))}">${svg}<line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/></svg>
<div class="tip" hidden></div>
<script type="application/json">${data}</script>
</div>
<svg viewBox="0 0 ${W} ${S - 6}" class="strip" aria-hidden="true"><defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#fcfcfb"/><line x1="0" y1="0" x2="0" y2="6" stroke="#8f8d86" stroke-width="2"/></pattern></defs>${strip}</svg>
<div class="legend small"><span class="key"><i class="tickkey"></i>${esc(t('Outside timestamp'))}</span>${s.receipts.tails.length ? `<span class="key"><i class="hatchkey"></i>${esc(t('Not yet timestamped: times as the computer reported them'))}</span>` : ''}</div>`;
    }

    /* -------- origins -------- */
    const cats = CATS.filter((c) => s.counts[c]);
    function originTable() {
      if (!s.total) return `<p class="muted">${esc(t('The manuscript is empty.'))}</p>`;
      const rows = cats.map((c) => {
        const w = Math.max(0.5, 100 * s.counts[c] / s.total);
        return `<tr><td><i class="sw" style="background:${COLORS[groupOf(c)]}"></i>${esc(LABEL[c])}</td><td class="num">${n(s.counts[c])}</td><td class="num">${pct(s.counts[c], s.total)}</td><td class="barcell"><span class="bar" style="width:${w.toFixed(1)}%;background:${COLORS[groupOf(c)]}"></span></td></tr>`;
      }).join('');
      return `<table class="origins"><thead><tr><th>${esc(t('Where it came from'))}</th><th class="num">${esc(t('Characters'))}</th><th class="num">${esc(t('Share'))}</th><th></th></tr></thead><tbody>${rows}</tbody>
<tfoot><tr><td>${esc(t('The manuscript'))}</td><td class="num">${n(s.total)}</td><td class="num">100%</td><td></td></tr></tfoot></table>`;
    }
    function chapterTable() {
      if (!s.chapters.length) return '';
      const cols = cats.slice(0, 6);
      const rest = cats.slice(6);
      const head = cols.map((c) => `<th class="num" title="${esc(LABEL[c])}"><i class="sw" style="background:${COLORS[groupOf(c)]}"></i>${esc(LABEL[c])}</th>`).join('') + (rest.length ? `<th class="num">${esc(t('Everything else'))}</th>` : '');
      const rows = s.chapters.map((c) => {
        const cells = cols.map((k) => `<td class="num">${c.counts[k] ? pct(c.counts[k], c.total) : ''}</td>`).join('') +
          (rest.length ? `<td class="num">${pct(rest.reduce((a, k) => a + (c.counts[k] || 0), 0), c.total)}</td>` : '');
        return `<tr><td>${esc(chTitle(c))}</td><td class="num">${n(c.total)}</td>${cells}<td class="num">${ratio(c.deleted, c.total)}</td></tr>`;
      }).join('');
      return `<div class="wide"><table class="chapters"><thead><tr><th>${esc(t('Chapter'))}</th><th class="num">${esc(t('Characters'))}</th>${head}<th class="num">${esc(t('Deleted per character'))}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }

    /* -------- revision by month -------- */
    function monthTable() {
      const months = new Map();
      const get = (k) => { if (!months.has(k)) months.set(k, { written: 0, deleted: 0 }); return months.get(k); };
      for (const [h, v] of Object.entries(s.survivingByHour)) get(cal.monthKey(+h * HOUR)).written += v;
      for (const [h, v] of Object.entries(s.deletedByHour)) get(cal.monthKey(+h * HOUR)).deleted += v;
      const rows = [...months.entries()].sort().map(([k, m]) => `<tr><td>${esc(cal.month(k))}</td><td class="num">${n(m.written)}</td><td class="num">${n(Math.max(0, m.deleted))}</td><td class="num">${ratio(Math.max(0, m.deleted), m.written)}</td></tr>`).join('');
      return rows ? `<table><thead><tr><th>${esc(t('Month'))}</th><th class="num">${esc(t('Written then, still in the manuscript'))}</th><th class="num">${esc(t('Deleted then'))}</th><th class="num">${esc(t('Deleted per character'))}</th></tr></thead><tbody>${rows}</tbody></table>` : '';
    }

    /* -------- sessions and the calendar -------- */
    const activeTotal = s.sessions.reduce((a, x) => a + x.active, 0);
    function calendarGrid() {
      const unit = privacy === 'weeks' ? 'week' : 'day';
      const key = unit === 'week' ? cal.weekKey : cal.dayKey;
      const by = new Map();
      for (const x of s.sessions) {
        const k = key(x.start);
        const v = by.get(k) || { active: 0, sessions: 0, added: 0 };
        v.active += x.active; v.sessions++; v.added += x.added;
        by.set(k, v);
      }
      if (!by.size) return '';
      const keys = [...by.keys()].sort();
      const max = Math.max(...[...by.values()].map((v) => v.active), 1);
      const shade = (v) => (!v || !v.active ? RAMP[0] : RAMP[Math.min(5, 1 + Math.floor(4.999 * v.active / max))]);
      const C = 12;
      const G = 2;
      const tipOf = (k, v) => `${unit === 'week' ? t('week of {date}', { date: cal.date(k) }) : cal.date(k)}: ${v ? t('{time} writing, {n} characters added', { time: dur(v.active), n: n(v.added) }) : t('no writing')}`;
      let out = '';
      if (unit === 'day') {
        // weeks as columns, Monday at the top, 52 to a row
        const first = cal.keyDate(cal.weekKey(cal.keyDate(keys[0]).getTime() + 12 * HOUR));
        const last = cal.keyDate(keys[keys.length - 1]);
        const weeks = Math.floor((last - first) / (7 * 24 * HOUR)) + 1;
        for (let w0 = 0; w0 < weeks; w0 += 52) {
          const cols = Math.min(52, weeks - w0);
          let cells = '';
          let months = '';
          let lastMonth = '';
          for (let w = 0; w < cols; w++) {
            for (let d = 0; d < 7; d++) {
              const day = new Date(first.getTime() + ((w0 + w) * 7 + d) * 24 * HOUR);
              const k = day.toISOString().slice(0, 10);
              if (day > last) continue;
              const v = by.get(k);
              cells += `<rect x="${28 + w * (C + G)}" y="${14 + d * (C + G)}" width="${C}" height="${C}" rx="2" fill="${shade(v)}"><title>${esc(tipOf(k, v))}</title></rect>`;
              if (d === 0 && k.slice(0, 7) !== lastMonth) {
                lastMonth = k.slice(0, 7);
                months += `<text x="${28 + w * (C + G)}" y="10" class="axis">${esc(cal.monthShort(lastMonth))}</text>`;
              }
            }
          }
          // (1 January 2024 was a Monday)
          const days = [0, 2, 4].map((d) => `<text x="0" y="${14 + d * (C + G) + 10}" class="axis">${esc(cal.weekday('2024-01-0' + (1 + d)))}</text>`).join('');
          out += `<svg class="cal" viewBox="0 0 ${28 + cols * (C + G)} ${14 + 7 * (C + G)}" width="${28 + cols * (C + G)}" role="img" aria-label="${esc(t('Writing calendar'))}">${months}${days}${cells}</svg>`;
        }
      } else {
        const first = cal.keyDate(keys[0]);
        const last = cal.keyDate(keys[keys.length - 1]);
        const weeks = Math.round((last - first) / (7 * 24 * HOUR)) + 1;
        for (let w0 = 0; w0 < weeks; w0 += 52) {
          const cols = Math.min(52, weeks - w0);
          let cells = '';
          for (let w = 0; w < cols; w++) {
            const k = new Date(first.getTime() + (w0 + w) * 7 * 24 * HOUR).toISOString().slice(0, 10);
            const v = by.get(k);
            cells += `<rect x="${w * (C + G)}" y="0" width="${C}" height="${C * 2}" rx="2" fill="${shade(v)}"><title>${esc(tipOf(k, v))}</title></rect>`;
          }
          out += `<svg class="cal" viewBox="0 0 ${cols * (C + G)} ${C * 2}" width="${cols * (C + G)}" role="img" aria-label="${esc(t('Writing calendar'))}">${cells}</svg>`;
        }
      }
      const scale = RAMP.map((c) => `<i style="background:${c}"></i>`).join('');
      return out + `<div class="legend small"><span class="key">${esc(t('Less'))} <span class="ramp">${scale}</span> ${esc(t('More'))}</span><span class="key">${esc(unit === 'week' ? t('Each square is a week; its shade, the time spent writing.') : t('Each square is a day; its shade, the time spent writing.'))}</span></div>`;
    }
    function sessionTable() {
      if (!s.sessions.length) return '';
      if (privacy === 'exact') {
        const multi = s.devices.length > 1;
        const rows = s.sessions.map((x) => `<tr><td>${esc(cal.exact(x.start))}</td><td>${esc(cal.dayKey(x.start) === cal.dayKey(x.end) ? cal.time(x.end) : cal.exact(x.end))}</td>${multi ? `<td>${esc(x.name)}</td>` : ''}<td class="num">${esc(dur(x.active))}</td><td class="num">${n(x.added)}</td><td class="num">${n(x.removed)}</td></tr>`).join('');
        return `<table class="sessions"><thead><tr><th>${esc(t('Began'))}</th><th>${esc(t('Ended'))}</th>${multi ? `<th>${esc(t('Device'))}</th>` : ''}<th class="num">${esc(t('Writing time'))}</th><th class="num">${esc(t('Added'))}</th><th class="num">${esc(t('Deleted'))}</th></tr></thead><tbody>${rows}</tbody></table>`;
      }
      const key = privacy === 'dates' ? cal.dayKey : cal.weekKey;
      const by = new Map();
      for (const x of s.sessions) {
        const k = key(x.start);
        const v = by.get(k) || { active: 0, sessions: 0, added: 0, removed: 0 };
        v.active += x.active; v.sessions++; v.added += x.added; v.removed += x.removed;
        by.set(k, v);
      }
      const rows = [...by.entries()].sort().map(([k, v]) => `<tr><td>${esc(privacy === 'dates' ? cal.date(k) : t('week of {date}', { date: cal.date(k) }))}</td><td class="num">${n(v.sessions)}</td><td class="num">${esc(dur(v.active))}</td><td class="num">${n(v.added)}</td><td class="num">${n(v.removed)}</td></tr>`).join('');
      return `<table class="sessions"><thead><tr><th>${esc(privacy === 'dates' ? t('Day') : t('Week'))}</th><th class="num">${esc(t('Sessions'))}</th><th class="num">${esc(t('Writing time'))}</th><th class="num">${esc(t('Added'))}</th><th class="num">${esc(t('Deleted'))}</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    /* -------- timestamps, flags, manuscript, details -------- */
    const rc = s.receipts;
    const svcName = (svc) => (svc === 'ots' ? 'OpenTimestamps' : svc === 'freetsa' ? 'FreeTSA' : svc);
    const statusName = { ok: t('checked'), bitcoin: t('in a Bitcoin block'), pending: t('waiting for Bitcoin'), unchecked: t('couldn\'t be checked here'), failed: t('failed') };
    function stampSection() {
      if (!rc.total) return `<p>${esc(t('No outside timestamps: every time in this log is as the computer reported it.'))}</p>`;
      const svcs = Object.entries(rc.bySvc).map(([svc, st]) => `<li>${esc(svcName(svc))}: ${Object.entries(st).map(([k, v]) => esc(n(v) + ' ' + (statusName[k] || k))).join(', ')}</li>`).join('');
      const lines = [
        `<li>${esc(t('Stamped entries: {n}', { n: n(rc.stamped) }))}${rc.stamps.length ? esc(' (' + t('first {a}, last {b}', { a: when(rc.stamps[0].time), b: when(rc.stamps[rc.stamps.length - 1].time) }) + ')') : ''}</li>`,
        `<li>${esc(t('Confirmed in Bitcoin: {n}', { n: n(rc.bitcoin) }))}${rc.pending ? esc('; ' + t('still waiting: {n} (OpenTimestamps confirms within hours; NEO collects the proofs)', { n: n(rc.pending) })) : ''}</li>`
      ];
      if (rc.longest && rc.longest.ms) lines.push(`<li>${esc(t('Longest stretch of writing between two outside timestamps: {time}', { time: dur(rc.longest.ms) }))}${rc.longest.firstTs ? esc(' (' + when(rc.longest.firstTs) + ')') : ''}</li>`);
      for (const tl of rc.tails) {
        lines.push(`<li>${esc(t('{device}: the writing after the last outside timestamp ({from} to {to}) is dated only by the computer\'s clock.', { device: tl.name, from: when(tl.firstTs), to: when(tl.lastTs) }))}</li>`);
      }
      return `<ul>${svcs}${lines.join('')}</ul>`;
    }
    function flagSection() {
      const f = s.flags;
      const items = [];
      const kindName = { back: t('the clock went back {time}'), forward: t('the clock jumped ahead {time}, not on waking'), 'receipt-skew': t('an outside timestamp and the computer\'s clock {time} apart'), 'receipt-before-entry': t('an outside timestamp {time} earlier than the entry it covers (the computer\'s clock was ahead)') };
      for (const c of f.clock) items.push(`<li>${esc(c.name + ', ' + when(c.ts) + ': ' + plainT(kindName[c.kind] || c.kind, { time: dur(Math.abs(c.ms)) }))}</li>`);
      for (const u of f.unclosed) items.push(`<li>${esc(t('{device}, {when}: a session ended without closing (NEO quit unexpectedly, or the computer lost power)', { device: u.name, when: when(u.ts) }))}</li>`);
      for (const d of f.damage) items.push(`<li class="bad">${esc(d)}</li>`);
      return items.length ? `<ul>${items.join('')}</ul>` : `<p>${esc(t('None. The clock never jumped, every session closed, and nothing is damaged.'))}</p>`;
    }
    function manuscriptSection() {
      const m = s.manuscript;
      if (!m) return `<p>${esc(t('No manuscript fingerprint yet: no session has closed.'))}</p>`;
      let out = `<p>${esc(t('The manuscript\'s fingerprint (SHA-256 of its text, as SLOG-FORMAT.md sets out), as of {when}:', { when: when(m.at) }))}</p><p class="hash">${esc(m.hash)}</p>`;
      const mc = opts.manuscriptCheck;
      if (mc) {
        out += mc.matched
          ? `<p class="good">${esc(t('{name} matches it exactly.', { name: mc.name }))}</p>`
          : `<p class="bad">${esc(t('{name} doesn\'t match it.', { name: mc.name }))}</p>`;
      } else out += `<p class="muted">${esc(t('Anyone holding the manuscript can check it against this with the verifier that comes with every export.'))}</p>`;
      return out;
    }
    function detailSection() {
      const rows = s.devices.map((d) => `<tr><td>${esc(d.name)}</td><td class="num">${n(d.chunks)}</td><td class="num">${n(d.entries)}</td><td>${esc(when(d.first))}</td><td>${esc(when(d.last))}</td><td>${esc(d.ok ? t('intact') : t('damaged'))}</td></tr>`).join('');
      const facts = [
        [t('Log'), s.logId || '?'],
        [t('Written with'), s.versions.length ? s.versions.map((v) => 'NEO ' + v).join(', ') : '?'],
        [t('Outside timestamps'), n(rc.total)],
        ...(s.archives.length ? [[t('Archives'), s.archives.map((a) => a.name).join(', ')]] : [])
      ];
      return `<table><thead><tr><th>${esc(t('Device'))}</th><th class="num">${esc(t('Sessions'))}</th><th class="num">${esc(t('Entries'))}</th><th>${esc(t('First entry'))}</th><th>${esc(t('Last entry'))}</th><th>${esc(t('Chain'))}</th></tr></thead><tbody>${rows}</tbody></table>
<dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
<p class="muted">${esc(t('Devices are numbered in the order they first wrote to this book. Nothing about the computers themselves is recorded.'))}</p>`;
    }

    const privacyLine = {
      exact: t('Times are shown exactly, in {zone}.', { zone: cal.zone }),
      dates: t('Times are shown as dates only, in {zone}.', { zone: cal.zone }),
      weeks: t('Times are shown as weeks only (from Monday), in {zone}.', { zone: cal.zone })
    }[privacy];
    const canShow = (opts.canShow || []).map((p) => `<p>${esc(p)}</p>`).join('');
    const generated = Number.isSafeInteger(opts.generated) ? opts.generated : Date.now();
    const status = s.ok
      ? t('Every chain in this log checks: nothing has been changed, added or taken out since it was written.')
      : t('Something in this log doesn\'t check. See Flags below.');
    const tile = (label, value) => `<div class="tile"><div class="tl">${esc(label)}</div><div class="tv">${esc(value)}</div></div>`;
    const counted = s.words
      ? t('Counts are of characters of the manuscript\'s prose (not formatting, scene breaks or notes), each put where it was first written: text moved within the book keeps the origin it had.')
      : t('This log was shared without its text, so characters are counted from what each change recorded about its formatting: scene-break marks, unwritten outline sections and placeholders count as prose here, and a few special characters count as more than one.');

    const html = `<!doctype html>
<html lang="${esc((opts.locale || 'en').split('-')[0])}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t('Scribe\'s Log report: {title}, {date}', { title: s.title || t('Untitled'), date: cal.date(cal.dayKey(generated)) }))}</title>
<style>
:root { color-scheme: light; --surface: #fcfcfb; --surface-2: #f3f2ef; --line: #e2e1dc; --text: #0b0b0b; --text-2: #52514e; --muted: #75736d; --good: #0a7a3a; --bad: #b42318; }
* { box-sizing: border-box; }
html { background: var(--surface); }
body { margin: 0 auto; max-width: 780px; padding: 32px 20px 48px; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: var(--text); background: var(--surface); }
h1 { font-size: 26px; line-height: 1.2; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 32px 0 10px; padding-top: 14px; border-top: 1px solid var(--line); break-after: avoid; }
h3 { font-size: 14px; margin: 18px 0 6px; }
p { margin: 0 0 10px; }
.byline { font-size: 16px; color: var(--text-2); margin-bottom: 14px; }
.meta { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; color: var(--text-2); font-size: 13px; }
.meta dt { color: var(--muted); }
.meta dd, .facts dd { margin: 0; overflow-wrap: anywhere; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; font-size: 13px; margin: 12px 0; }
.facts dt { color: var(--muted); }
.can { background: var(--surface-2); border-radius: 8px; padding: 12px 14px 4px; margin: 18px 0; color: var(--text-2); }
.status { font-weight: 600; margin: 14px 0; }
.status.good, .good { color: var(--good); }
.status.bad, .bad { color: var(--bad); }
.muted { color: var(--muted); font-size: 13px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 14px 0; }
.tile { background: var(--surface-2); border-radius: 8px; padding: 10px 12px; }
.tl { color: var(--text-2); font-size: 12px; }
.tv { font-size: 20px; font-weight: 600; margin-top: 2px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; margin: 8px 0 12px; }
th, td { text-align: left; padding: 5px 8px 5px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--text-2); font-weight: 500; }
tfoot td { font-weight: 600; border-bottom: none; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.wide { overflow-x: auto; }
table.chapters th { font-size: 12px; white-space: normal; min-width: 72px; }
table.chapters td:first-child { min-width: 120px; }
.barcell { width: 32%; }
.bar { display: block; height: 10px; border-radius: 0 4px 4px 0; }
.sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 12px; color: var(--text-2); margin: 8px 0; }
.legend.small { font-size: 11px; }
.key i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
.key i.tickkey { width: 2px; height: 12px; background: var(--text-2); border-radius: 0; }
.key i.hatchkey { width: 14px; background: repeating-linear-gradient(45deg, #8f8d86 0 2px, transparent 2px 5px); }
.ramp i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin: 0 1px; vertical-align: -1px; }
.chart { position: relative; }
svg { display: block; max-width: 100%; height: auto; }
svg .grid { stroke: var(--line); stroke-width: 1; }
svg .baseline { stroke: #b8b6af; stroke-width: 1; }
svg .axis { fill: var(--muted); font-size: 11px; }
svg .tick { stroke: var(--text-2); stroke-width: 1.5; }
svg .cross { stroke: var(--text); stroke-width: 1; }
svg.cal { margin: 6px 0; }
.tip { position: absolute; top: 0; pointer-events: none; background: #fff; border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; font-size: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.08); min-width: 170px; }
.tip .row { display: flex; gap: 8px; align-items: center; }
.tip .row b { margin-left: auto; font-variant-numeric: tabular-nums; }
.tip .k { display: inline-block; width: 10px; height: 2px; }
.hash { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; background: var(--surface-2); padding: 6px 8px; border-radius: 6px; }
ul { margin: 0 0 10px; padding-left: 20px; }
li { margin: 2px 0; }
footer { margin-top: 36px; color: var(--muted); font-size: 12px; }
@media print { html, body { background: #fff; } body { padding: 0; max-width: none; } h2, h3 { break-after: avoid; } tr, .tiles, svg { break-inside: avoid; } .tip { display: none; } }
@media (max-width: 560px) { body { padding: 20px 16px 36px; } .barcell { display: none; } }
</style>
</head>
<body>
<header>
<h1>${esc(s.title || t('Untitled'))}</h1>
${s.author ? `<div class="byline">${esc(t('by {author}', { author: s.author }))}</div>` : ''}
<div class="muted" style="margin-bottom:8px">${esc(t('Scribe\'s Log report'))}${opts.note ? ' · ' + esc(opts.note) : ''}</div>
<dl class="meta">
<dt>${esc(t('Writing logged'))}</dt><dd>${s.period ? esc(when(s.period.first) === when(s.period.last) ? when(s.period.first) : when(s.period.first) + ' – ' + when(s.period.last)) : '–'}</dd>
<dt>${esc(t('Report made'))}</dt><dd>${esc(cal.date(cal.dayKey(generated)))}${opts.generator ? esc(' · ' + opts.generator) : ''}</dd>
<dt>${esc(t('Times'))}</dt><dd>${esc(privacyLine)}</dd>
</dl>
</header>

<section class="can">
<p><strong>${esc(t('What this can and can\'t show'))}</strong></p>
${canShow}
<p>${esc(t('This report is a summary. What someone can check for themselves is the log, exported with File → Scribe\'s Log → Export for Verification…, which carries its own verifier.'))}</p>
</section>

<p class="status ${s.ok ? 'good' : 'bad'}">${esc(status)}</p>
<div class="tiles">
${tile(t('Writing sessions'), n(s.sessions.length))}
${tile(t('Time spent writing'), dur(activeTotal))}
${tile(t('Characters in the manuscript'), n(s.total))}
${tile(t('Outside timestamps'), n(rc.total))}
</div>

<h2>${esc(t('The manuscript over time'))}</h2>
<p class="muted">${esc(privacy === 'exact' ? t('Counted at the end of every session.') : privacy === 'dates' ? t('Counted at the end of each day\'s writing.') : t('Counted at the end of each week\'s writing.'))}</p>
${timeline()}

<h2>${esc(t('Where the text came from'))}</h2>
${originTable()}
${s.moved ? `<p>${esc(t('{n} characters were moved within the book at some point; they\'re counted above under where they were first written.', { n: n(s.moved) }))}</p>` : ''}
${s.counts['paste revised'] ? `<p class="muted">${esc(t('“Then revised” is pasted text that later had words put in or taken out inside it. Its characters still count as pasted; what was typed into it counts as typed.'))}</p>` : ''}
<p class="muted">${esc(counted)}</p>
${s.chapters.length ? `<h3>${esc(t('By chapter'))}</h3>${chapterTable()}` : ''}

<h2>${esc(t('Revision'))}</h2>
<p>${esc(t('Characters deleted for every character in the manuscript: {r}', { r: ratio(s.deleted, s.total) }))} <span class="muted">(${esc(t('{d} deleted, {n} remaining', { d: n(s.deleted), n: n(s.total) }))})</span></p>
<p class="muted">${esc(t('Deleted means taken out of the chapters and not put back elsewhere in the book: a move isn\'t a deletion, and a passage sent to Darlings is.'))}</p>
${monthTable()}

<h2>${esc(t('Sessions'))}</h2>
<p class="muted">${esc(t('A session is one sitting on one device. Writing time runs from the first change of each stretch of writing to its last; a pause over 10 minutes ends the stretch.'))}</p>
${calendarGrid()}
${sessionTable()}

<h2>${esc(t('Outside timestamps'))}</h2>
<p class="muted">${esc(t('While the book was written, NEO sent the log\'s latest fingerprint (never any text) to FreeTSA, a timestamping authority, and to OpenTimestamps, which anchors it in Bitcoin. Each receipt shows that everything written up to that point existed by then.'))}</p>
${stampSection()}

<h2>${esc(t('Flags'))}</h2>
${flagSection()}

<h2>${esc(t('Manuscript'))}</h2>
${manuscriptSection()}

<h2>${esc(t('Details'))}</h2>
${detailSection()}

<footer>${esc(t('Made from the Scribe\'s Log by {generator}.', { generator: opts.generator || 'NEO' }))}</footer>
<script>
(function () {
  document.querySelectorAll('[data-chart]').forEach(function (box) {
    var d; try { d = JSON.parse(box.querySelector('script[type="application/json"]').textContent); } catch (e) { return; }
    var svg = box.querySelector('svg'), cross = svg.querySelector('.cross'), tip = box.querySelector('.tip');
    var nf = new Intl.NumberFormat(d.fmt);
    function show(ev) {
      var r = svg.getBoundingClientRect(), x = (ev.clientX - r.left) * d.W / r.width, best = 0;
      for (var i = 1; i < d.x.length; i++) if (Math.abs(d.x[i] - x) < Math.abs(d.x[best] - x)) best = i;
      cross.setAttribute('x1', d.x[best]); cross.setAttribute('x2', d.x[best]); cross.setAttribute('visibility', 'visible');
      tip.textContent = '';
      var h = document.createElement('div'); h.textContent = d.label[best]; h.style.color = '#52514e'; h.style.marginBottom = '4px'; tip.appendChild(h);
      for (var j = d.names.length - 1; j >= 0; j--) {
        var row = document.createElement('div'); row.className = 'row';
        var k = document.createElement('span'); k.className = 'k'; k.style.background = d.colors[j];
        var nm = document.createElement('span'); nm.textContent = d.names[j];
        var v = document.createElement('b'); v.textContent = nf.format(d.rows[best][j]);
        row.appendChild(k); row.appendChild(nm); row.appendChild(v); tip.appendChild(row);
      }
      var tr = document.createElement('div'); tr.className = 'row'; var tn = document.createElement('span'); tn.textContent = d.totalName; var tv = document.createElement('b'); tv.textContent = nf.format(d.total[best]);
      tr.appendChild(tn); tr.appendChild(tv); tr.style.borderTop = '1px solid #e2e1dc'; tr.style.marginTop = '4px'; tr.style.paddingTop = '3px'; tip.appendChild(tr);
      tip.hidden = false;
      var px = d.x[best] * r.width / d.W, w = tip.offsetWidth;
      tip.style.left = (px + 12 + w > r.width ? Math.max(0, px - 12 - w) : px + 12) + 'px';
    }
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerleave', function () { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
  });
})();
</script>
</body>
</html>
`;
    return html;
  }

  // A round step for an axis: 1, 2 or 5 times a power of ten
  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  Object.assign(exports, { CATS, GROUPS, IDLE, reportStats, renderReport, calendar, niceStep, opProse });
})(typeof module !== 'undefined' && module.exports ? module.exports : (globalThis.SlogReport = {}));
