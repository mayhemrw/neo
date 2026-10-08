// End-to-end test for the standalone verifier page (verifier.html): built
// as NEO builds it (trusting the test authority as well), opened as a file
// in a window whose network is stopped, and given exports, a folder, an
// archive and manuscripts through its own file input and drop path. The
// one network use, Check against Bitcoin, is answered by a fake explorer.
// Run with `npm run test:verifier` (under xvfb-run on a machine without a
// display). NEO's own .txt and .docx are matched in slog.e2e.js.

'use strict';

const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildVerifier } = require('../verifier/build.js');
const { openVerifier } = require('./verifier-page.js');
const F = require('./verifier-fixtures.js');
const fakes = require('./stamp-fakes.js');
const Z = require('../slog-zip.js');
const zlib = require('zlib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `neo-verifier-test-${process.pid}-`));
app.setPath('userData', path.join(tmp, 'app'));
const enc = (s) => new TextEncoder().encode(s);
const write = (name, bytes) => { const p = path.join(tmp, name); fs.writeFileSync(p, bytes); return p; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await app.whenReady();
  const page = write('verifier.html', buildVerifier({ extraAnchors: [fs.readFileSync(fakes.ROOT_PEM, 'utf8')], built: 'test' }));
  const log = F.bookLog({ bitcoin: 912345 });
  const noText = write('Harbor - Scribe\'s Log (no text).zip', await F.exportOf(log));
  const full = write('Harbor - Scribe\'s Log (with text).zip', await F.exportOf(log, { kind: 'full' }));
  const txt = write('Harbor.txt', enc(F.bookTxt()));
  const docx = write('Harbor.docx', F.bookDocx());
  const changed = write('Harbor changed.txt', enc(F.bookTxt({ change: ['One was missing.', 'None was missing.'] })));
  // a chunk with one byte changed, the manifest left as it was
  const un = (await Z.unzip(new Uint8Array(fs.readFileSync(noText)), async (b) => zlib.inflateRawSync(b))).files;
  const chunk = Object.keys(un).find((k) => k.startsWith('chunks/'));
  const tampered = write('tampered.zip', Z.zip(Object.entries({ ...un, [chunk]: enc(new TextDecoder().decode(un[chunk]).replace('"kind":"open"', '"kind":"open" ')) }).map(([name, data]) => ({ name, data }))));

  // the explorers: mempool.space answers 503 (down), blockstream.info has the block
  const explorer = (url) => {
    const u = new URL(url);
    if (u.hostname !== 'blockstream.info') return null;
    if (u.pathname === `/api/block-height/${log.block.height}`) return { body: log.block.id };
    if (u.pathname === `/api/block/${log.block.id}/header`) return { body: log.block.header };
    return null;
  };

  const notes = {};
  let failed = 0;
  try {
    const v = await openVerifier(page, { answer: explorer });
    notes.start = await v.readNow();
    // the page's own rules keep everything else in: a fetch anywhere else is refused before it leaves
    notes.elsewhere = await v.js(`fetch('https://example.com/x').then(() => 'went out', () => 'refused')`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    notes.refusal = v.errors.splice(0).join(' ');
    notes.noText = await v.choose([noText]);
    notes.watchNoText = await v.js(`(() => ({ shown: !document.getElementById('watch').hidden, pick: !document.getElementById('watch-pick').hidden, note: document.getElementById('watch-note').textContent }))()`);
    notes.beforeBitcoin = v.requests.slice();
    notes.bitcoin = await v.click('check-bitcoin');
    notes.afterBitcoin = v.requests.slice();
    notes.weeks = await v.privacy('weeks');
    notes.exact = await v.privacy('exact');
    // the report saved: a download of the page as it's shown
    const saved = new Promise((resolve) => v.win.webContents.session.once('will-download', (e, item) => {
      const to = path.join(tmp, 'saved-' + item.getFilename());
      item.setSavePath(to);
      item.once('done', (ev, state) => resolve({ name: item.getFilename(), state, html: state === 'completed' ? fs.readFileSync(to, 'utf8') : '' }));
    }));
    await v.js('document.getElementById(\'save-report\').click()');
    notes.saved = await saved;
    // manuscripts: NEO-style .txt and .docx, and a changed one
    notes.manuscripts = await v.choose([txt, docx, changed]);
    // with the text: where the changed one first differs
    notes.full = await v.choose([full, changed]);
    // …and a chapter watched being written
    notes.watch = await v.js(`(() => ({ pick: !document.getElementById('watch-pick').hidden, chapters: [...document.getElementById('watch-chapter').options].map((o) => o.textContent) }))()`);
    await v.js(`(() => { const s = document.getElementById('watch-chapter'); s.value = s.options[1].value; document.getElementById('watch-start').click(); })()`);
    for (let i = 0; i < 50 && !(await v.js('!!window.verifierPlayer()')); i++) await sleep(100);
    const pl = (body) => v.js(`(() => { const root = document.querySelector('#player .pb'); const page = root.querySelector('.pb-page'); const status = root.querySelector('.pb-status').textContent; ${body} })()`);
    const key = (k, shift = false) => pl(`page.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, shiftKey: ${shift}, bubbles: true, cancelable: true })); return root.dataset.pos;`);
    notes.playStart = await pl(`return { pos: root.dataset.pos, status, page: page.innerText, focus: document.activeElement.className, back: root.querySelector('.pb-back').disabled }`);
    await key('ArrowRight');
    notes.step1 = await pl(`return { pos: root.dataset.pos, status, page: page.innerText, fresh: [...page.querySelectorAll('.pb-new')].map((e) => e.textContent).join('|'), session: root.querySelector('.pb-session').textContent }`);
    await key('ArrowRight');
    notes.step2 = await pl(`return { pos: root.dataset.pos, status, page: page.innerText, fresh: [...page.querySelectorAll('.pb-new')].map((e) => e.textContent).join('|') }`);
    await pl(`root.querySelector('.pb-origins input').click(); return 1`);
    notes.colored = await pl(`return { legend: !root.querySelector('.pb-legend').hidden, typed: [...page.querySelectorAll('.pb-o-typed')].map((e) => e.textContent).join('|'), imported: [...page.querySelectorAll('.pb-o-imported')].map((e) => e.textContent).join('|') }`);
    await key('Home');
    // played at 600×: every step, then it stops at the end
    await pl(`const s = root.querySelector('.pb-speed'); s.value = '600'; s.dispatchEvent(new Event('change')); root.querySelector('.pb-play').click(); return 1`);
    notes.playing = await pl(`return root.classList.contains('pb-playing')`);
    for (let i = 0; i < 100 && (await pl('return root.classList.contains(\'pb-playing\')')); i++) await sleep(100);
    notes.played = await pl(`return { pos: root.dataset.pos, playing: root.classList.contains('pb-playing'), page: page.innerText, play: root.querySelector('.pb-play').getAttribute('aria-label'), fwd: root.querySelector('.pb-fwd').disabled }`);
    notes.watchRequests = v.requests.slice();
    // a byte changed in the export
    notes.tampered = await v.choose([tampered]);
    // a scribes-log folder from before NEO stamped, dropped whole
    const v1 = F.bookLog({ v: 1 });
    notes.v1 = await v.drop(Object.entries(v1.files).map(([k, b]) => ({ name: 'book-harbor/scribes-log/' + k, bytes: typeof b === 'string' ? enc(b) : b })));
    // a manuscript on its own first, then not a log at all
    const w = await openVerifier(page);
    notes.alone = await w.choose([txt]);
    notes.notALog = await w.choose([write('photo.jpg', enc('jpeg'))]);
    notes.quiet = w.requests.slice();
    notes.errors = [...v.errors, ...w.errors];
    v.close();
    w.close();
  } catch (err) {
    failed++;
    console.error(err);
  }

  const item = (r, key) => (r && r.items.find((i) => i.key === key)) || {};
  const checks = [
    ['the page opens with nothing to show but where to drop', () => {
      assert.equal(notes.start.verdict, null);
      assert.equal(notes.start.items.length, 0);
      assert.equal(notes.elsewhere, 'refused');
      assert.match(notes.refusal, /Content Security Policy/);
    }],
    ['an export without the text: every check, and the Bitcoin block left for the button', () => {
      const r = notes.noText;
      assert.equal(r.verdict, 'warn', JSON.stringify(r.items));
      assert.deepEqual(r.items.map((i) => [i.key, i.status]), [['files', 'ok'], ['chains', 'ok'], ['stamps', 'ok'], ['bitcoin', 'warn'], ['clock', 'ok'], ['manuscript', 'info']]);
      assert.match(r.source, /“The Harbor Book” by Ann Writer: an export without the text/);
      assert.ok(r.bitcoinButton);
      assert.match(item(r, 'bitcoin').text, /Block 912345: merkle root [0-9a-f]{64}/);
      assert.match(r.report, /Where the text came from/);
      assert.deepEqual(notes.beforeBitcoin, [], 'nothing went out before the button');
    }],
    ['Check against Bitcoin: mempool.space down, blockstream.info has the block, and nothing else asked', () => {
      const r = notes.bitcoin;
      assert.equal(item(r, 'bitcoin').status, 'ok', JSON.stringify(item(r, 'bitcoin')));
      assert.match(item(r, 'bitcoin').text, /matches the block/);
      assert.equal(r.verdict, 'ok');
      assert.ok(!r.bitcoinButton);
      assert.deepEqual(notes.afterBitcoin, [
        'https://mempool.space/api/block-height/912345',
        'https://blockstream.info/api/block-height/912345',
        `https://blockstream.info/api/block/${log.block.id}/header`
      ]);
      assert.match(r.report, /Confirmed in Bitcoin: 1/);
    }],
    ['the report\'s times follow the setting: weeks show no day or time of day', () => {
      assert.match(notes.weeks.report, /week of/);
      assert.doesNotMatch(notes.weeks.report, /\d{1,2}:\d{2}/);
      assert.match(notes.exact.report, /\d{1,2}:\d{2}/);
    }],
    ['Save report… downloads the report as shown, dated by name', () => {
      assert.equal(notes.saved.state, 'completed');
      assert.match(notes.saved.name, /^The Harbor Book - Scribe's Log report \d{4}-\d{2}-\d{2} \(exact times\)\.html$/);
      assert.match(notes.saved.html, /<h1>The Harbor Book<\/h1>/);
    }],
    ['NEO\'s .txt and .docx match; a changed one doesn\'t, and the report says the first matched', () => {
      const r = notes.manuscripts;
      assert.equal(item(r, 'ms-Harbor.txt').status, 'ok');
      assert.equal(item(r, 'ms-Harbor.docx').status, 'ok');
      assert.equal(item(r, 'ms-Harbor changed.txt').status, 'bad');
      assert.equal(r.verdict, 'bad');
      assert.match(r.report, /Harbor\.txt matches it exactly/);
    }],
    ['with the text, a changed manuscript says where it first differs', () => {
      const it = item(notes.full, 'ms-Harbor changed.txt');
      assert.equal(it.status, 'bad');
      assert.match(it.text, /first differ at line 5: the file has "None was missing\.", the log "One was missing\."/);
      assert.match(notes.full.source, /an export with the text/);
    }],
    ['without the text there\'s nothing to watch, and the page says so', () => {
      assert.equal(notes.watchNoText.shown, true);
      assert.equal(notes.watchNoText.pick, false);
      assert.match(notes.watchNoText.note, /doesn't have the text, so there are no words to play/);
    }],
    ['with the text, a chapter plays back: step by step, colored by origin, and through to the end', () => {
      assert.equal(notes.watch.pick, true);
      assert.deepEqual(notes.watch.chapters, ['1. The Quiet', '2. The Count']);
      assert.equal(notes.playStart.pos, '0');
      assert.match(notes.playStart.status, /^Start · 2 steps$/);
      assert.match(notes.playStart.page, /hasn't been started yet/);
      assert.equal(notes.playStart.focus, 'pb-play');
      assert.equal(notes.playStart.back, true);
      assert.equal(notes.step1.pos, '1');
      assert.match(notes.step1.status, /Device 1 · Imported · 5 words · Step 1 of 2$/);
      assert.equal(notes.step1.fresh, 'Mara counted the boats twice.|***');
      assert.match(notes.step1.session, /^Session of .+, Device 1$/);
      assert.equal(notes.step2.pos, '2');
      assert.match(notes.step2.status, /Typed · 8 words · Step 2 of 2$/);
      assert.equal(notes.step2.fresh, 'One was missing.');
      assert.equal(notes.colored.legend, true);
      assert.equal(notes.colored.typed, 'One was missing.');
      assert.equal(notes.colored.imported, 'Mara counted the boats twice.|***');
      assert.equal(notes.playing, true);
      assert.deepEqual(notes.played, { pos: '2', playing: false, page: 'Mara counted the boats twice.\n\n***\n\nOne was missing.', play: 'Play', fwd: true });
      assert.deepEqual(notes.watchRequests, notes.afterBitcoin, 'watching asked nothing of the network');
    }],
    ['a changed byte is caught', () => {
      assert.equal(notes.tampered.verdict, 'bad');
      assert.equal(item(notes.tampered, 'files').status, 'bad');
      assert.match(item(notes.tampered, 'files').text, /not the file the manifest lists/);
    }],
    ['a v1 folder dropped whole checks, words and all, with no outside timestamps', () => {
      const r = notes.v1;
      assert.equal(item(r, 'chains').status, 'ok', JSON.stringify(r.items));
      assert.match(item(r, 'chains').text, /every word matches the seal/);
      assert.match(item(r, 'stamps').title, /No outside timestamps/);
      assert.match(r.source, /a Scribe's Log folder \(book-harbor\/scribes-log\)/);
      assert.equal(r.verdict, 'warn');
    }],
    ['a manuscript alone waits for the export; something else is left aside; nothing went out', () => {
      assert.match(notes.alone.note, /Now drop the Scribe's Log export/);
      assert.equal(notes.alone.verdict, null);
      assert.match(notes.notALog.note, /Left aside: photo\.jpg/);
      assert.deepEqual(notes.quiet, []);
      assert.deepEqual(notes.errors, []);
    }]
  ];
  for (const [name, fn] of checks) {
    try { fn(); console.log('ok   ' + name); } catch (err) {
      failed++;
      console.log('FAIL ' + name + '\n     ' + String(err.message).replace(/\n/g, '\n     '));
    }
  }
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
}
main();
