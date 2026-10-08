// The verifier page's own part: what's dropped or chosen goes to check.js,
// and what comes back is shown. Built into verifier.html with the checker
// (scripts/build-verifier.js). Everything shown from a log goes in as text
// (textContent), never as markup; the report is slog-report.js's page,
// which escapes everything it shows.

'use strict';

(function () {
  const C = globalThis.SlogVerifier;
  const R = globalThis.SlogReport;
  const TSA = globalThis.StampTsa;
  const OTS = globalThis.StampOts;
  const CFG = globalThis.VERIFIER_CONFIG || { version: '?', anchors: [], certs: [], canShow: [] };
  const $ = (id) => document.getElementById(id);

  const trust = {
    anchors: CFG.anchors.map((p) => TSA.pemToDer(p)),
    certs: CFG.certs.map((p) => TSA.pemToDer(p))
  };
  let tz = 'UTC';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { /* UTC */ }
  // the browser's language, as Intl takes it (some systems report "en-US@posix")
  const locale = (() => {
    for (const l of [...(navigator.languages || []), navigator.language]) {
      try { if (l && Intl.getCanonicalLocales(String(l).replace(/[@.].*$/, '').replace(/_/g, '-')).length) return Intl.getCanonicalLocales(String(l).replace(/[@.].*$/, '').replace(/_/g, '-'))[0]; } catch { /* the next */ }
    }
    return 'en';
  })();

  // what's been checked: { log (as sortInput gave it), check, matches, manuscripts }
  const state = { log: null, check: null, manuscripts: [], matches: [], ignored: [] };
  let runs = 0; // checks finished (for the tests)

  /* ---------------- reading what's dropped or chosen ---------------- */

  const readFile = (file, name) => file.arrayBuffer().then((b) => ({ name, bytes: new Uint8Array(b) }));
  // a dropped folder, entry by entry (readEntries hands them out in batches)
  function readEntry(entry, out) {
    if (entry.isFile) return new Promise((resolve, reject) => entry.file((f) => readFile(f, entry.fullPath.replace(/^\/+/, '')).then((x) => { out.push(x); resolve(); }, reject), reject));
    if (!entry.isDirectory) return Promise.resolve();
    const reader = entry.createReader();
    return new Promise((resolve, reject) => {
      const batch = () => reader.readEntries((list) => {
        if (!list.length) { resolve(); return; }
        Promise.all(list.map((e) => readEntry(e, out))).then(batch, reject);
      }, reject);
      batch();
    });
  }
  async function fromDrop(dt) {
    const out = [];
    const entries = [...(dt.items || [])].map((it) => (it.kind === 'file' && it.webkitGetAsEntry ? it.webkitGetAsEntry() : null));
    if (entries.length && entries.every(Boolean)) {
      for (const e of entries) await readEntry(e, out);
      return out;
    }
    for (const f of dt.files || []) out.push(await readFile(f, f.name));
    return out;
  }
  async function fromInput(input) {
    const out = [];
    for (const f of input.files || []) out.push(await readFile(f, f.webkitRelativePath || f.name));
    input.value = '';
    return out;
  }

  /* ---------------- checking ---------------- */

  const busy = (text) => {
    $('busy').hidden = !text;
    $('busy').textContent = text || '';
    for (const b of document.querySelectorAll('button')) b.disabled = !!text;
  };
  const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 30));
  const note = (text) => { $('note').hidden = !text; $('note').textContent = text || ''; };

  async function take(items) {
    if (!items.length) return;
    busy('Reading…');
    await nextFrame();
    try {
      const sorted = await C.sortInput(items);
      const notes = [];
      if (sorted.logs.length) {
        state.log = sorted.logs[0];
        state.matches = [];
        if (sorted.logs.length > 1) notes.push(`More than one log was dropped; this checks ${state.log.label}. Drop the others one at a time.`);
      }
      if (sorted.ignored.length) notes.push('Left aside: ' + sorted.ignored.join(', ') + '.');
      // a new log starts afresh; a manuscript on its own is added to what's checked
      if (sorted.logs.length) state.manuscripts = sorted.manuscripts;
      else state.manuscripts = [...state.manuscripts.filter((m) => !sorted.manuscripts.some((x) => x.name === m.name)), ...sorted.manuscripts];
      if (!state.log) {
        note([...notes, state.manuscripts.length ? 'Now drop the Scribe\'s Log export to check the manuscript against.' : 'That isn\'t a Scribe\'s Log. Drop the export (.zip) NEO made with File → Scribe\'s Log → Export for Verification….'].join(' '));
        return;
      }
      note(notes.join(' '));
      if (sorted.logs.length) {
        busy('Checking the log… (a long book can take a little while)');
        await nextFrame();
        state.check = await C.checkInput(state.log, trust);
      }
      state.matches = [];
      for (const m of state.manuscripts) state.matches.push(await C.matchFile(state.check, m));
      show();
    } catch (err) {
      note('Something went wrong reading that: ' + (err && err.message ? err.message : String(err)));
      console.error(err);
    } finally {
      busy('');
      runs++;
    }
  }

  async function checkBitcoin() {
    busy('Checking against Bitcoin…');
    await nextFrame();
    try {
      const fetchFn = (url, opts) => fetch(url, { ...opts, credentials: 'omit', referrerPolicy: 'no-referrer' });
      state.check = await C.checkInput(state.log, { ...trust, bitcoin: (att) => OTS.checkBlock(fetchFn, att) });
      show();
    } catch (err) {
      note('Couldn\'t check against Bitcoin: ' + (err && err.message ? err.message : String(err)));
    } finally {
      busy('');
      runs++;
    }
  }

  /* ---------------- showing ---------------- */

  const privacy = () => $('privacy').value;
  function whenFn() {
    const cal = R.calendar(tz, locale);
    const p = privacy();
    return (ms) => {
      if (!Number.isSafeInteger(ms)) return '?';
      if (p === 'exact') return cal.exact(ms);
      if (p === 'dates') return cal.date(cal.dayKey(ms));
      return 'week of ' + cal.date(cal.weekKey(ms));
    };
  }
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const MARK = { ok: '✓', warn: '!', bad: '✕', info: 'i' };
  const VERDICT = {
    ok: 'Everything here checks.',
    warn: 'Everything that could be checked checks, but not everything could be. See below.',
    bad: 'Something here doesn\'t check. See below.'
  };

  function sourceLine(ck) {
    const m = ck.manifest;
    const s = ck.stats;
    const title = s.title ? `“${s.title}”${s.author ? ' by ' + s.author : ''}` : 'An untitled book';
    if (ck.kind === 'export' && m) {
      const made = Number.isSafeInteger(m.exported) ? R.calendar(tz, locale).date(R.calendar(tz, locale).dayKey(m.exported)) : '?';
      return `${title}: an export ${m.text === 'full' ? 'with the text' : 'without the text'}, made ${made} by NEO ${m.app || '?'} (${ck.label}).`;
    }
    if (ck.kind === 'archive') return `${title}: an archive (${ck.label}).`;
    return `${title}: a Scribe's Log folder (${ck.label}).`;
  }

  function show() {
    const ck = state.check;
    if (!ck) return;
    const items = C.summarize(ck, { matches: state.matches, when: whenFn() });
    const v = C.verdict(items);
    $('results').hidden = false;
    $('verdict').className = 'verdict ' + v;
    $('verdict').textContent = VERDICT[v];
    $('source').textContent = sourceLine(ck);
    const list = $('items');
    list.textContent = '';
    for (const it of items) {
      const li = el('li');
      li.dataset.key = it.key;
      li.dataset.status = it.status;
      const mk = el('span', 'mark ' + it.status, MARK[it.status]);
      mk.setAttribute('aria-label', { ok: 'checks', warn: 'couldn\'t be checked', bad: 'doesn\'t check', info: 'note' }[it.status]);
      li.append(mk, el('div', 't', it.title));
      const d = el('div', 'd');
      for (const line of it.lines) d.append(el('p', null, line));
      li.append(d);
      if (it.key === 'bitcoin' && !ck.bitcoinChecked) {
        const act = el('div', 'act');
        const b = el('button', null, 'Check against Bitcoin');
        b.type = 'button';
        b.id = 'check-bitcoin';
        b.addEventListener('click', checkBitcoin);
        act.append(b, el('span', 'muted small', 'Fetches each block\'s header from mempool.space (or blockstream.info). Nothing from the log is sent.'));
        li.append(act);
      }
      if (it.key === 'manuscript' || it.key.startsWith('ms-')) {
        if (!list.querySelector('#pick-manuscript')) {
          const act = el('div', 'act');
          const b = el('button', null, state.matches.length ? 'Check another manuscript…' : 'Check a manuscript…');
          b.type = 'button';
          b.id = 'pick-manuscript';
          b.addEventListener('click', () => $('files').click());
          act.append(b);
          li.append(act);
        }
      }
      list.append(li);
    }
    showReport();
    document.body.dataset.verdict = v;
  }

  function reportHtml() {
    const ck = state.check;
    const mt = state.matches.find((m) => !m.error);
    return R.renderReport(ck.stats, {
      privacy: privacy(), tz, locale, canShow: CFG.canShow,
      generator: 'the verifier from NEO ' + CFG.version, generated: Date.now(),
      manuscriptCheck: mt ? { matched: mt.matched, name: mt.name } : null
    });
  }
  function fitReport() {
    const f = $('report');
    try {
      const doc = f.contentDocument;
      if (doc && doc.documentElement) f.style.height = (doc.documentElement.scrollHeight + 4) + 'px';
    } catch { /* not ours to measure */ }
  }
  function showReport() {
    const f = $('report');
    f.onload = () => { fitReport(); setTimeout(fitReport, 200); };
    f.srcdoc = reportHtml();
  }
  function saveReport() {
    if (!state.check) return;
    const html = reportHtml();
    const title = [...String(state.check.stats.title || 'Untitled')].filter((c) => c >= ' ' && !'\\/:*?"<>|'.includes(c)).join('').trim().slice(0, 80) || 'Untitled';
    const d = new Date();
    const day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const level = { exact: ' (exact times)', weeks: ' (weeks only)' }[privacy()] || '';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    a.download = `${title} - Scribe's Log report ${day}${level}.html`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  /* ---------------- wiring ---------------- */

  const drop = $('drop');
  for (const ev of ['dragenter', 'dragover']) {
    document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  }
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (!e.dataTransfer) return;
    let items;
    try { items = await fromDrop(e.dataTransfer); } catch (err) { note('That couldn\'t be read: ' + (err && err.message)); return; }
    await take(items);
  });
  $('pick-files').addEventListener('click', () => $('files').click());
  $('pick-folder').addEventListener('click', () => $('folder').click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('files').click(); } });
  $('files').addEventListener('change', async () => take(await fromInput($('files'))));
  $('folder').addEventListener('change', async () => take(await fromInput($('folder'))));
  $('privacy').addEventListener('change', () => { if (state.check) show(); });
  $('save-report').addEventListener('click', saveReport);
  window.addEventListener('resize', fitReport);
  // once something's checked, the drop zone steps back
  const observer = new MutationObserver(() => drop.classList.toggle('compact', !$('results').hidden));
  observer.observe($('results'), { attributes: true, attributeFilter: ['hidden'] });

  if (!(globalThis.crypto && globalThis.crypto.subtle)) {
    note('This browser won\'t check signatures on a page opened this way (no WebCrypto), so the outside timestamps will show as unchecked. Open the page as a file (double-click it) in a current browser.');
  }
  if (typeof DecompressionStream !== 'function') note('This browser can\'t open zip files (no DecompressionStream). Use a current Chrome, Edge, Firefox or Safari.');

  // for the tests: the same path as a drop
  globalThis.verifierTake = take;
  globalThis.verifierState = state;
  globalThis.verifierRuns = () => runs;
})();
