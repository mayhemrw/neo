// End-to-end test for the Scribe's Log across two computers sharing one
// library, the way Google Drive or Dropbox would: NEO runs as computer A,
// quits, runs as computer B on the same folder (its own app data, so its
// own device id), quits, and runs as A again. Each run is its own Electron
// process. A imports a manuscript and writes; B writes and moves A's words;
// A sees B's changes arrive, writes more, merges the log into an archive,
// and exports for verification both ways plus NEO's own .txt and .docx.
// The verifier page then checks the exports and matches the manuscripts.
// The first run quits by closing its window with the book open (Windows'
// close button), the second by File → Quit with the book open, the third
// by File → Quit from the shelf; each session's last hash must be stamped
// as NEO goes (or, live, queued for the next start), and NEO must exit.
//
//   node scripts/devices.e2e.js          the timestamp services faked here
//   node scripts/devices.e2e.js --live   FreeTSA and the OpenTimestamps calendars
//
// (Under xvfb-run on a machine without a display.)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const STEP = process.env.NEO_DEVICES_STEP;
const TMP = process.env.NEO_DEVICES_TMP;
const LIVE = process.env.NEO_DEVICES_LIVE === '1';

const WIND = 'The wind rose.';
const OUTSIDE = 'A line from somewhere else entirely.';
const LAPTOP = 'Seen from the laptop.';
const DESK = 'Back at the desk.';

if (!process.versions.electron) runAll();
else if (STEP === 'V') verifierStep();
else deviceStep();

/* ---- the run, from plain Node ---- */

async function runAll() {
  const { spawn } = require('child_process');
  const http = require('http');
  const assert = require('node:assert/strict');
  const fakes = require('./stamp-fakes.js');
  const live = process.argv.includes('--live');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-devices-test-'));
  const LIB = path.join(tmp, 'NEO Library');
  fs.mkdirSync(LIB);
  fs.writeFileSync(path.join(LIB, 'library.json'), JSON.stringify({
    authorName: '', penNames: [], firstRunDone: true, pageTheme: 'night', hintShown: true,
    shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: [] }]
  }));
  fs.writeFileSync(path.join(tmp, 'harbor.txt'), [
    'The harbor was quiet before the storm.',
    'Gulls wheeled over the empty slips.',
    '***',
    'Mara counted the boats twice.',
    'One was missing.'
  ].join('\n\n'));

  const calls = [];
  let server = null;
  let stamps = null; // (live: NEO's own services)
  if (!live) {
    server = http.createServer((req, res) => {
      const parts = [];
      req.on('data', (c) => parts.push(c));
      req.on('end', () => {
        const body = Buffer.concat(parts);
        calls.push(req.method + ' ' + req.url + ' ' + body.length);
        let out = null;
        if (req.method === 'POST' && req.url === '/tsr') out = fakes.tokenFor(body, Date.now());
        const m = /^\/(a|b)\/digest$/.exec(req.url);
        if (req.method === 'POST' && m) out = fakes.calendarAnswer(m[1], body);
        res.writeHead(out ? 200 : 404);
        res.end(out || '');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    stamps = JSON.stringify({
      services: [{ svc: 'freetsa', url: base + '/tsr' }], calendars: [base + '/a', base + '/b'],
      anchors: [fakes.ROOT_PEM], certs: [fakes.SIGNER_PEM]
    });
  }
  const electron = require('electron'); // (the binary's path, from Node)
  const step = (name) => new Promise((resolve) => {
    const args = [__filename];
    if (process.getuid && process.getuid() === 0) args.push('--no-sandbox');
    const env = { ...process.env, NEO_DEVICES_STEP: name, NEO_DEVICES_TMP: tmp, NEO_DEVICES_LIVE: live ? '1' : '0' };
    if (stamps) env.NEO_SLOG_STAMPS = stamps;
    else delete env.NEO_SLOG_STAMPS;
    const child = spawn(electron, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    const limit = setTimeout(() => { err += '\n(stopped after 4 minutes)'; child.kill('SIGKILL'); }, 240000);
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => {
      clearTimeout(limit);
      const out = path.join(tmp, 'step-' + name + '.json');
      const res = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
      if (!res || res.error) console.log(`step ${name} failed (exit ${code}):\n${res ? res.error : ''}\n${err.split('\n').filter((l) => !/Fontconfig|dbus|gpu|GPU|viz_main|ERROR:viz/.test(l)).slice(-15).join('\n')}`);
      resolve(res || { error: 'no result' });
    });
  });

  const notes = {};
  for (const name of ['A1', 'B1', 'A2', 'V']) {
    const t0 = Date.now();
    notes[name] = await step(name);
    console.log(`step ${name}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (notes[name].error) break;
  }
  if (server) server.close();

  let failed = 0;
  const { checkBookFull, checkZip, report } = require('./slog-check.js');
  const slog = require('../slog.js');
  const files = require('../slog-files.js');
  const { readReceipts } = require('../slog-stamp.js');
  const bookDir = notes.A1 && notes.A1.bookDir;
  let res = null;
  const zips = {};
  try {
    res = await checkBookFull(bookDir);
    console.log(report(bookDir, res));
    for (const kind of ['none', 'full']) zips[kind] = await checkZip(notes.A2.exports[kind]);
  } catch (err) {
    failed++;
    console.error(err);
  }
  const devA = notes.A1 && notes.A1.dev;
  const devB = notes.B1 && notes.B1.dev;
  const byDev = (dev) => res && res.devices.find((d) => d.dev === dev);
  const listing = bookDir ? files.listLog(bookDir) : null;
  // each chunk: { dev8 (from its name), entries }
  const entries = listing ? files.chunkNames(listing).map((n) => ({ dev8: slog.CHUNK_RE.exec(path.basename(n))[2], entries: slog.parseChunk(listing.files.get(n).read().toString('utf8')).entries })) : [];
  const receipts = bookDir ? readReceipts(bookDir).map((r) => r.line) : [];
  const originsOf = (d, needle) => {
    for (const doc of Object.values(d.traced)) {
      const at = doc.text === null ? -1 : doc.text.indexOf(needle);
      if (at >= 0) return [...new Set(slog.originsAt(doc, at, needle.length).map(([, o]) => o))];
    }
    return null;
  };
  const item = (r, k) => (r && r.items.find((i) => i.key === k)) || {};
  const checks = [
    ['every step ran', () => {
      for (const n of ['A1', 'B1', 'A2', 'V']) assert.ok(notes[n] && !notes[n].error, n);
    }],
    ['NEO exits by itself: window closed, File → Quit with a book open, File → Quit from the shelf', () => {
      for (const n of ['A1', 'B1', 'A2']) assert.ok(!notes[n].quitHeld, n + ' was still running 8 s after it was told to quit');
    }],
    ['two computers, two device ids, one log', () => {
      assert.ok(devA && devB && devA !== devB);
      assert.equal(notes.A2.dev, devA, 'A kept its id between runs');
      assert.equal(res.devices.length, 2);
    }],
    ['both chains are intact and the log ends in what\'s on disk', () => {
      assert.equal(res.ok, true, JSON.stringify(res.problems));
      for (const d of res.devices) assert.deepEqual(d.problems || [], [], d.dev);
    }],
    ['B\'s first look at A\'s book names A\'s chain', () => {
      const a = byDev(devB).arrivals;
      assert.ok(a.recorded >= 1, JSON.stringify(a));
      assert.equal(a.unlinked, 0, JSON.stringify(a));
    }],
    ['A sees B\'s writing arrive, named as B\'s', () => {
      const a = byDev(devA).arrivals;
      assert.ok(a.recorded >= 1, JSON.stringify(a));
      assert.equal(a.unlinked, 0, JSON.stringify(a));
    }],
    ['words keep the origin from the computer that wrote them', () => {
      const d = byDev(devA);
      assert.deepEqual(originsOf(d, WIND), ['typed'], 'typed on A, moved on B');
      assert.deepEqual(originsOf(d, LAPTOP), ['typed'], 'typed on B');
      assert.deepEqual(originsOf(d, DESK), ['typed'], 'typed on A, after');
      assert.deepEqual(originsOf(d, OUTSIDE), ['paste']);
      assert.deepEqual(originsOf(d, 'Mara counted the boats twice.'), ['import']);
    }],
    ['B\'s move of A\'s words is traced', () => {
      const moved = entries.filter((c) => c.dev8 === devB.slice(0, 8)).flatMap((c) => c.entries).find((e) => e.src === 'move' && e.x && e.x.ins.join('').includes(WIND));
      assert.ok(moved && moved.from, 'a move with its source');
      assert.equal((byDev(devB).made || {}).move || 0, 0, 'nothing untraced');
      assert.equal((byDev(devA).made || {}).move || 0, 0, 'nothing untraced');
    }],
    ['every session\'s end on both computers was stamped by both services', () => {
      const closes = entries.flatMap((c) => c.entries.filter((e) => e.kind === 'close').map((e) => ({ e, dev: c.dev8 === devA.slice(0, 8) ? devA : devB })));
      assert.ok(closes.length >= 3, 'closes');
      assert.deepEqual(closes.map(({ e }) => e.why), ['quit', 'quit', 'close'], 'A1 and B1 quit with the book open; A2 closed it');
      // (live, a quit's hash that took longer than NEO waits is queued for
      // its next start: in that computer's waiting work, not lost)
      const queued = (dev, n) => {
        const who = dev === devA ? 'A' : 'B';
        try { return Object.values(JSON.parse(fs.readFileSync(path.join(tmp, 'app-' + who, 'slog', 'stamps.json'), 'utf8')).queue || {}).some((q) => q.n === n); } catch { return false; }
      };
      for (const { e, dev } of closes) {
        for (const svc of ['freetsa', 'ots']) {
          const got = receipts.some((l) => l.svc === svc && l.dev === dev && l.n === e.n && l.h === slog.entryHash(e));
          assert.ok(got || (live && e.why === 'quit' && queued(dev, e.n)), `${svc} for ${dev.slice(0, 8)} #${e.n}`);
        }
      }
    }],
    ['every stamp entry has its receipt; the clock check is clean', () => {
      const se = res.receipts.stampEntries;
      assert.ok(se.matched >= 2, JSON.stringify(se)); // (A1's, in A2's first chunk; the rest wait for a next chunk)
      assert.deepEqual(se.missing, []);
      assert.deepEqual(res.clock || [], [], JSON.stringify(res.clock));
    }],
    [live ? 'FreeTSA\'s receipts check against its root' : 'the receipts check against the test authority', () => {
      const c = res.receipts.counts;
      if (live) {
        assert.ok(c['freetsa ok'] >= 3, JSON.stringify(c));
        assert.ok(!Object.keys(c).some((k) => /bad|fail/.test(k)), JSON.stringify(c));
      } else assert.ok(Object.keys(c).some((k) => /^freetsa/.test(k)), JSON.stringify(c));
    }],
    ['A\'s merge took B\'s closed chunks too, and both carried on', () => {
      assert.match(notes.A2.archiveToast, /^Merged \d+ files into archive-/);
      assert.equal(listing.archives.length, 1);
      const zipped = [...listing.files.entries()].filter(([, f]) => f.archive).map(([n]) => n);
      assert.ok(zipped.some((n) => n.includes(devB.slice(0, 8))), 'one of B\'s chunks is in the archive');
      assert.ok(zipped.some((n) => n.includes(devA.slice(0, 8))), 'one of A\'s');
      assert.ok(notes.A2.typedAfterMerge, 'A wrote after merging');
    }],
    ['both exports check, carry both computers, and end on a stamp', () => {
      for (const kind of ['none', 'full']) {
        const z = zips[kind];
        assert.equal(z.ok, true, kind + ' ' + JSON.stringify(z.problems));
        assert.equal(z.manifest.text, kind);
        assert.equal(z.manifest.devices, 2, kind);
        assert.equal(z.manifest.stamped && z.manifest.stamped.tsa, true, kind);
        assert.equal(z.devices.length, 2, kind);
      }
      assert.match(notes.A2.exportToasts[0], /ends on an outside timestamp/);
    }],
    ['the export without the text holds none of the words', () => {
      const zip = require('../slog-zip.js').unzipSync(new Uint8Array(fs.readFileSync(notes.A2.exports.none)), require('zlib').inflateRawSync).files;
      const all = Object.entries(zip).filter(([n]) => /^(chunks|stamps)\//.test(n) || n === 'log.json').map(([, b]) => Buffer.from(b).toString()).join('');
      for (const w of [WIND, LAPTOP, DESK, 'Mara counted']) assert.ok(!all.includes(w), w);
      assert.ok(!all.includes('"x"') && !all.includes('"key"'));
    }],
    ['the verifier: no text plus .docx, everything checks and the manuscript matches', () => {
      const r = notes.V.noText;
      assert.equal(r.verdict, 'ok', JSON.stringify(r.items));
      assert.equal(item(r, 'files').status, 'ok');
      assert.equal(item(r, 'chains').status, 'ok');
      assert.equal(item(r, 'ms-book.docx').status, 'ok', JSON.stringify(r.items));
      assert.match(r.report, /Device 2/);
    }],
    ['the verifier: with the text plus .txt, the same', () => {
      const r = notes.V.withText;
      assert.equal(r.verdict, 'ok', JSON.stringify(r.items));
      assert.equal(item(r, 'ms-book.txt').status, 'ok', JSON.stringify(r.items));
    }],
    ['the verifier says which computer text arrived from', () => {
      const r = notes.V.noText;
      const arr = r.items.find((i) => /another device|other computer|arrived/i.test(i.title + ' ' + i.text));
      assert.ok(arr && arr.status !== 'bad', JSON.stringify(r.items));
    }],
    ['the verifier sent nothing anywhere', () => {
      assert.deepEqual(notes.V.requests, []);
      assert.deepEqual(notes.V.errors, []);
    }],
    ...(live ? [] : [['only hashes went out, to the services named', () => {
      assert.ok(calls.length >= 3 * 3, calls.length + ' calls');
      for (const c of calls) assert.match(c, /^POST \/(tsr \d{2,3}|(a|b)\/digest 32)$/);
    }]])
  ];
  for (const [name, fn] of checks) {
    try { fn(); console.log('ok   ' + name); } catch (err) {
      failed++;
      console.log('FAIL ' + name + '\n     ' + String(err.message).replace(/\n/g, '\n     '));
    }
  }
  console.log(`\n${checks.length - failed} passed, ${failed} failed${live ? ' (live services)' : ''}`);
  if (!failed && !process.env.NEO_DEVICES_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
  else console.log('kept ' + tmp);
  process.exit(failed ? 1 : 0);
}

/* ---- one computer's run of NEO, in Electron ---- */

function deviceStep() {
  const { app, BrowserWindow, clipboard, dialog } = require('electron');
  const who = STEP[0]; // A or B
  app.setPath('userData', path.join(TMP, 'app-' + who));
  app.setPath('documents', TMP);
  const LIB = path.join(TMP, 'NEO Library');
  const loadFile = BrowserWindow.prototype.loadFile;
  BrowserWindow.prototype.loadFile = function (file, opts) {
    return loadFile.call(this, path.resolve(__dirname, '..', file), opts);
  };
  require('../main.js');
  const slog = require('../slog.js');
  const { readReceipts } = require('../slog-stamp.js');
  const out = { step: STEP };
  let wc;
  const js = (code) => wc.executeJavaScript(code, true);
  const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
  const pause = () => tick(1400);
  async function type(text) {
    for (const k of text) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: k });
      wc.sendInputEvent({ type: 'char', keyCode: k });
      wc.sendInputEvent({ type: 'keyUp', keyCode: k });
      await tick(25);
    }
    await tick(300);
  }
  async function caretEnd(ch, p) {
    await js(`(() => {
      const body = document.querySelectorAll('.chapter-body')[${ch}];
      body.focus();
      const ps = body.querySelectorAll('p:not(.scene-break)');
      const para = ps[${p} < 0 ? ps.length + ${p} : ${p}];
      const r = document.createRange();
      r.selectNodeContents(para);
      r.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    })()`);
    await tick(100);
  }
  async function selectText(needle) {
    const ok = await js(`(() => {
      const walk = document.createTreeWalker(document.querySelector('.chapter-body'), NodeFilter.SHOW_TEXT);
      for (let t; (t = walk.nextNode());) {
        const i = t.data.indexOf(${JSON.stringify(needle)});
        if (i < 0) continue;
        t.parentElement.closest('.chapter-body').focus();
        const r = document.createRange();
        r.setStart(t, i);
        r.setEnd(t, i + ${needle.length});
        getSelection().removeAllRanges();
        getSelection().addRange(r);
        return true;
      }
      return false;
    })()`);
    if (!ok) throw new Error('couldn\'t find "' + needle + '" to select');
    await tick(100);
  }
  const hint = () => js(`document.getElementById('hint').textContent`);
  // the session's last line, and both services' receipts for it
  async function closeAndWaitForStamps(bookDir) {
    await js('backToShelf()');
    await tick(1500);
    const dev = out.dev;
    const files = require('../slog-files.js');
    const listing = files.listLog(bookDir);
    const mine = files.chunkNames(listing).filter((n) => slog.CHUNK_RE.exec(path.basename(n))[2] === dev.slice(0, 8)).sort()
      .map((n) => slog.parseChunk(listing.files.get(n).read().toString('utf8')));
    const close = mine.flatMap((c) => c.entries).filter((e) => e.kind === 'close').pop();
    if (!close) throw new Error('no close line');
    const h = slog.entryHash(close);
    for (let i = 0; i < 300; i++) {
      const lines = readReceipts(bookDir).map((r) => r.line);
      if (['freetsa', 'ots'].every((svc) => lines.some((l) => l.svc === svc && l.dev === dev && l.n === close.n && l.h === h))) return;
      await tick(100);
    }
    throw new Error('the session\'s end wasn\'t stamped within 30 s');
  }
  const save = (to) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: to }); };
  async function main() {
    await app.whenReady();
    try {
      let win;
      while (!(win = BrowserWindow.getAllWindows()[0])) await tick(50);
      wc = win.webContents;
      while (!(await js(`typeof library !== 'undefined' && !!library`).catch(() => false))) await tick(50);
      await tick(300);
      let bookId;
      if (STEP === 'A1') {
        bookId = await js(`(async () => {
          document.getElementById('firstrun').hidden = true;
          const results = await window.neo.importFiles([${JSON.stringify(path.join(TMP, 'harbor.txt'))}]);
          await addImportedBooks(results, library.shelves[0]);
          const ids = library.shelves[0].bookIds;
          await openBook(ids[ids.length - 1]);
          return book.id;
        })()`);
      } else {
        bookId = await js(`(async () => {
          document.getElementById('firstrun').hidden = true;
          await openBook(library.shelves[0].bookIds[0]);
          return book.id;
        })()`);
      }
      const bookDir = path.join(LIB, bookId);
      out.bookDir = bookDir;
      await tick(800);
      win.focus();
      if (STEP === 'A1') {
        await caretEnd(0, 0);
        await type(' ' + WIND);
        await pause();
        clipboard.writeText(OUTSIDE);
        await caretEnd(0, 1);
        await type(' ');
        wc.paste();
        await tick(300);
        await pause();
      } else if (STEP === 'B1') {
        // B writes, and moves A's words to the end
        await caretEnd(0, 1);
        await type(' ' + LAPTOP);
        await pause();
        await selectText(' ' + WIND);
        wc.cut();
        await tick(300);
        await pause();
        await caretEnd(0, -1);
        wc.paste();
        await tick(300);
        await pause();
      } else if (STEP === 'A2') {
        out.sawLaptop = (await js(`chapterHTML[book.chapterOrder[0]]`)).includes(LAPTOP);
        await caretEnd(0, 0);
        await type(' ' + DESK);
        await pause();
        // File → Scribe's Log → Merge Log into Archive
        await js(`(() => { slogArchive({ type: 'slogArchive', bookId: book.id }); })()`);
        await tick(2000);
        out.archiveToast = await hint();
        await caretEnd(0, 0);
        await type(' Again.');
        await pause();
        out.typedAfterMerge = true;
        // File → Scribe's Log → Export for Verification…, both ways
        out.exports = { none: path.join(TMP, 'book-no-text.zip'), full: path.join(TMP, 'book-with-text.zip') };
        out.exportToasts = [];
        const screen = `[...document.querySelectorAll('.modal-backdrop')].pop()`;
        for (const [kind, n] of [['none', 0], ['full', 1]]) {
          save(out.exports[kind]);
          await js(`(() => { slogExport({ type: 'slogExport', bookId: book.id }); })()`);
          for (let i = 0; i < 100 && !(await js(`!!(${screen} && ${screen}.querySelector('.fr-choice'))`)); i++) await tick(50);
          await js(`${screen}.querySelectorAll('.fr-choice')[${n}].click()`);
          for (let i = 0; i < 400 && !fs.existsSync(out.exports[kind]); i++) await tick(100);
          await tick(800);
          out.exportToasts.push(await hint());
        }
        // NEO's own File → Export, nothing written since
        for (const [format, to] of [['txt', 'book.txt'], ['docx', 'book.docx']]) {
          save(path.join(TMP, to));
          await js(`doExport(${JSON.stringify(format)})`);
          for (let i = 0; i < 100 && !fs.existsSync(path.join(TMP, to)); i++) await tick(50);
        }
      }
      out.dev = JSON.parse(fs.readFileSync(path.join(TMP, 'app-' + who, 'slog', 'device.json'), 'utf8')).dev;
      if (STEP === 'A2') await closeAndWaitForStamps(bookDir);
    } catch (err) {
      out.error = err.stack || String(err);
    }
    fs.writeFileSync(path.join(TMP, 'step-' + STEP + '.json'), JSON.stringify(out, null, 2));
    // A1: the window's close button with the book open; B1: File → Quit
    // with the book open; A2: File → Quit from the shelf. NEO has to exit
    // by itself; if it hasn't in 8 s, the step says so and leaves.
    if (STEP === 'A1') BrowserWindow.getAllWindows()[0].close();
    else app.quit();
    setTimeout(() => {
      out.quitHeld = true;
      fs.writeFileSync(path.join(TMP, 'step-' + STEP + '.json'), JSON.stringify(out, null, 2));
      app.exit(0);
    }, 8000);
  }
  main();
}

/* ---- the verifier page, in Electron ---- */

function verifierStep() {
  const { app } = require('electron');
  app.setPath('userData', path.join(TMP, 'app-V'));
  app.on('window-all-closed', () => {}); // (closing one page isn't the end)
  const out = { step: 'V' };
  (async () => {
    await app.whenReady();
    try {
      const { openVerifier } = require('./verifier-page.js');
      const zip = require('../slog-zip.js');
      const A2 = JSON.parse(fs.readFileSync(path.join(TMP, 'step-A2.json'), 'utf8'));
      // live: the no-text export's own copy of the page; faked: one built to
      // trust the test authority as well
      const page = path.join(TMP, 'verifier.html');
      if (LIVE) {
        const files = zip.unzipSync(new Uint8Array(fs.readFileSync(A2.exports.none)), require('zlib').inflateRawSync).files;
        fs.writeFileSync(page, Buffer.from(files['verifier.html']));
      } else {
        const fakes = require('./stamp-fakes.js');
        fs.writeFileSync(page, require('../verifier/build.js').buildVerifier({ extraAnchors: [fs.readFileSync(fakes.ROOT_PEM, 'utf8')] }));
      }
      const v = await openVerifier(page);
      out.noText = await v.choose([A2.exports.none, path.join(TMP, 'book.docx')]);
      out.requests = v.requests.slice();
      out.errors = v.errors.slice();
      v.close();
      const page2 = path.join(TMP, 'verifier-2.html');
      fs.copyFileSync(page, page2);
      const w = await openVerifier(page2);
      out.withText = await w.choose([A2.exports.full, path.join(TMP, 'book.txt')]);
      out.requests.push(...w.requests);
      out.errors.push(...w.errors);
      w.close();
    } catch (err) {
      out.error = err.stack || String(err);
    }
    fs.writeFileSync(path.join(TMP, 'step-V.json'), JSON.stringify(out, null, 2));
    app.exit(0);
  })();
}
