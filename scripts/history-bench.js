'use strict';

// Timing for versions (slog-history.js) on a long book: a synthetic log
// the size of a novel written over about 300 hours (by default 600
// sessions, 200,000 entries, 30 chapters), written with the log's own
// Chain so every link and commitment is real. Prints how long the first
// index, a second one, one after a new session, and rebuilds at the far end
// of a checkpoint take, and how much room the checkpoints use.
//
//   node scripts/history-bench.js [sessions] [entries per session]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const slog = require('../slog.js');
const { History } = require('../slog-history.js');

const SESSIONS = +process.argv[2] || 600;
const PER = +process.argv[3] || 333;
const CHAPTERS = 30;

let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (n) => Math.floor(rnd() * n);
const WORDS = 'the a light door she he waited river under quiet glass morning before never stone told kept hand window long road'.split(' ');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-history-bench-'));
const dir = path.join(root, 'book-a');
const logDir = path.join(dir, slog.LOG_DIR);
fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
fs.mkdirSync(logDir, { recursive: true });
const info = slog.newLogInfo();
fs.writeFileSync(path.join(logDir, slog.LOG_INFO), JSON.stringify(info));
const key = Buffer.from(info.key, 'base64');
const dev = slog.newDeviceId();
let clock = Date.UTC(2025, 0, 6, 9, 0, 0);
const chain = new slog.Chain({ dev, key, now: () => clock });
const ids = Array.from({ length: CHAPTERS }, (_, i) => 'ch-' + (i + 1));
const docs = Object.fromEntries(ids.map((id) => [id, '']));

const t0 = Date.now();
let prevChunk = null;
let entries = 0;
for (let s = 0; s < SESSIONS; s++) {
  clock += (16 + pick(48)) * 3600e3; // a day or so between sessions
  const name = slog.chunkName(clock, dev);
  const lines = [];
  const put = (kind, fields, ins) => { lines.push(chain.entry(kind, fields, ins).line); entries++; };
  put('open', { v: 2, log: info.logId, dev, prevChunk, app: 'bench+slog1' });
  if (s === 0) for (const id of ids) put('doc', { doc: id, act: 'new' });
  // most of a session goes to one or two chapters
  const focus = [ids[pick(CHAPTERS)], ids[pick(CHAPTERS)]];
  for (let k = 0; k < PER; k++) {
    clock += 1000 + pick(9000);
    const doc = rnd() < 0.98 ? focus[pick(2)] : ids[pick(CHAPTERS)];
    const t = docs[doc];
    const ends = [];
    for (let i = t.indexOf('</p>'); i >= 0; i = t.indexOf('</p>', i + 1)) ends.push(i);
    let op;
    let ins = '';
    if (!ends.length || rnd() < 0.04) { ins = '<p>' + WORDS[pick(WORDS.length)] + '</p>'; op = [t.length, 0, ins.length, [[0, 3], [ins.length - 4, 4]]]; }
    else {
      const at = ends[pick(ends.length)];
      const para = t.lastIndexOf('<p>', at) + 3;
      if (rnd() < 0.2 && at - para > 12) op = [at - 1 - pick(6), 0, 0];
      else { ins = ' ' + WORDS[pick(WORDS.length)] + (rnd() < 0.15 ? '.' : ''); op = [at, 0, ins.length]; }
      if (op[2] === 0) op[1] = Math.min(at - op[0], 1 + pick(5));
    }
    docs[doc] = t.slice(0, op[0]) + ins + t.slice(op[0] + op[1]);
    put('edit', { doc, src: 'typed', ops: [op], dur: 1500, ev: ins.length || 1 }, ins ? [ins] : null);
  }
  put('close', { why: 'close', ms: slog.manuscriptHash(ids.map((id) => docs[id]).join('')) });
  fs.writeFileSync(path.join(logDir, name), lines.join('\n') + '\n');
  prevChunk = name;
}
const meta = { id: 'book-a', title: 'Bench', chapterOrder: ids, chapterTitles: {} };
fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify(meta));
for (const id of ids) fs.writeFileSync(path.join(dir, 'chapters', id + '.html'), docs[id]);
const logBytes = fs.readdirSync(logDir).reduce((a, f) => a + fs.statSync(path.join(logDir, f)).size, 0);
const chars = ids.reduce((a, id) => a + docs[id].length, 0);
console.log(`book: ${SESSIONS} sessions, ${entries} entries, ${(logBytes / 1e6).toFixed(1)} MB of log, ${chars} characters at the end (written in ${((Date.now() - t0) / 1000).toFixed(1)} s)`);

const ms = (f) => { const t = process.hrtime.bigint(); const r = f(); return [Number(process.hrtime.bigint() - t) / 1e6, r]; };
const h = new History({ home: path.join(root, 'history') });
const [cold, ix] = ms(() => h.index(dir));
const versions = Object.values(ix.chapters).reduce((a, c) => a + c.versions.length, 0);
console.log(`index, first time: ${cold.toFixed(0)} ms (${versions} versions, problems: ${ix.problems.length})`);
const [warm] = ms(() => h.index(dir));
console.log(`index, nothing new: ${warm.toFixed(0)} ms`);
// a new session appended
clock += 20 * 3600e3;
{
  const name = slog.chunkName(clock, dev);
  const lines = [chain.entry('open', { v: 2, log: info.logId, dev, prevChunk, app: 'bench+slog1' }).line];
  const doc = ids[0];
  const ins = ' fresh';
  const at = docs[doc].lastIndexOf('</p>');
  docs[doc] = docs[doc].slice(0, at) + ins + docs[doc].slice(at);
  lines.push(chain.entry('edit', { doc, src: 'typed', ops: [[at, 0, ins.length]] }, [ins]).line);
  lines.push(chain.entry('close', { why: 'close', ms: '' }).line);
  fs.writeFileSync(path.join(logDir, name), lines.join('\n') + '\n');
}
const [inc, ix2] = ms(() => h.index(dir));
console.log(`index, one new session: ${inc.toFixed(0)} ms (${Object.values(ix2.chapters).reduce((a, c) => a + c.versions.length, 0)} versions)`);
// rebuilds: the newest version, the one just before a checkpoint (the
// longest replay), and the oldest
const all = Object.values(ix2.chapters).flatMap((c) => c.versions).sort((a, b) => a.n - b.n);
const cache = JSON.parse(fs.readFileSync(path.join(root, 'history', ix2.logId, 'index.json'), 'utf8')).chains[dev];
const cpN = cache.checkpoints.map((c) => c.n);
const beforeCp = cpN.length ? all.filter((v) => v.n < cpN[cpN.length - 1]).pop() : all[all.length - 1];
for (const [label, v] of [['newest version', all[all.length - 1]], ['farthest from a checkpoint', beforeCp], ['oldest version', all[0]]]) {
  const [t, r] = ms(() => h.text(dir, v.dev, v.n, 'ch-1'));
  console.log(`rebuild, ${label} (entry ${v.n}): ${t.toFixed(0)} ms${r.error && !/didn't exist/.test(r.error) ? ' ERROR ' + r.error : ''}`);
}
const last = h.text(dir, dev, chain.n, ids[0]);
console.log(`newest rebuild matches the disk: ${last.text === docs[ids[0]]}`);
const cpDir = path.join(root, 'history', ix2.logId);
const cpFiles = fs.readdirSync(cpDir);
const cpBytes = cpFiles.reduce((a, f) => a + fs.statSync(path.join(cpDir, f)).size, 0);
console.log(`checkpoints: ${cpN.length} plus the tail, ${(cpBytes / 1e6).toFixed(2)} MB with the index (${cpFiles.length} files)`);
fs.rmSync(root, { recursive: true, force: true });
