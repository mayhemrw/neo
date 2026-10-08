#!/usr/bin/env node
// Checks a book's Scribe's Log, for development (the writer's verifier is
// verifier.html, built from the same slog-verify.js):
//
//   node scripts/slog-check.js "<book folder>" [--bitcoin]
//
// Every device's chain is checked (numbering, links, commitments, words),
// replayed from empty, and compared with the documents on disk. The chain
// written last should end in exactly what's on disk. Also counts entries by
// where their text came from: "unlogged" should be rare ("while off" is
// what changed while the log was switched off, and is expected). Every
// moved stretch's `from` is followed and checked, text that arrived from
// another device is traced to that device's chain, and the manuscript is
// counted by where each letter first came from ("move" there is text moved
// within NEO whose place wasn't recorded, which should be rare too).
//
// Then the outside timestamps: every receipt checked against its entry
// and its authority (FreeTSA's root, in certs/), every stamp entry matched
// to its receipt, what the receipts cover, and the clock check. With
// --bitcoin, finished OpenTimestamps proofs are checked against their
// blocks at a public explorer (mempool.space, then blockstream.info).
//
// Exit code 0 when every chain is intact, the newest one matches the disk
// and no receipt fails, 1 otherwise.

'use strict';
const fs = require('fs');
const path = require('path');
const slog = require('../slog.js');
const V = require('../slog-verify.js');
const tsa = require('../stamp-tsa.js');
const ots = require('../stamp-ots.js');

// A book's scribes-log folder as the checker takes it: { path: text or bytes }
function loadLog(dir) {
  const logDir = path.join(dir, slog.LOG_DIR);
  const files = {};
  const take = (rel, bytes = false) => {
    try { files[rel] = bytes ? new Uint8Array(fs.readFileSync(path.join(logDir, rel))) : fs.readFileSync(path.join(logDir, rel), 'utf8'); } catch { /* gone meanwhile */ }
  };
  let names = [];
  try { names = fs.readdirSync(logDir); } catch { return files; }
  for (const n of names) if (n === slog.LOG_INFO || slog.isChunkName(n)) take(n);
  let stamps = [];
  try { stamps = fs.readdirSync(path.join(logDir, 'stamps')); } catch { /* none */ }
  for (const n of stamps) if (V.RECEIPT_RE.test(n)) take('stamps/' + n);
  let certs = [];
  try { certs = fs.readdirSync(path.join(logDir, 'stamps', 'certs')); } catch { /* none */ }
  for (const n of certs) if (/^[0-9a-f]{64}\.der$/.test(n)) take('stamps/certs/' + n, true);
  return files;
}

// The trusted roots and the certificates NEO ships (certs/)
function shippedCerts() {
  const pem = (f) => tsa.pemToDer(fs.readFileSync(path.join(__dirname, '..', 'certs', f), 'utf8'));
  return { anchors: [pem('freetsa-root.pem')], certs: [pem('freetsa-tsa.pem')] };
}

// The core's result, with each device compared to the disk
function withDisk(dir, files, res) {
  const out = { ...res, problems: res.problems.slice(), disk: slog.readBookDocs(dir).docs };
  if (!(slog.LOG_INFO in files)) {
    out.problems = ['no readable log.json'];
    out.ok = false;
    out.devices = [];
    return out;
  }
  out.devices = res.devices.map((d) => {
    const docs = Object.fromEntries(Object.entries(d.docs).filter(([, t]) => t !== null));
    const differ = [...new Set([...Object.keys(docs), ...Object.keys(out.disk)])].filter((k) => docs[k] !== out.disk[k]).sort();
    return { ...d, chainEntries: d.entries, docs, chunks: d.chunks.length, entries: d.entries.length, lastTs: d.last || 0, differ };
  });
  const newest = out.devices[out.devices.length - 1];
  out.ok = res.ok && !!newest && !newest.differ.length;
  return out;
}

// The chains only: synchronous, no receipts
function checkBook(dir) {
  const files = loadLog(dir);
  const log = V.readLog(files);
  return withDisk(dir, files, V.checkChains(log));
}

// Everything, receipts included
async function checkBookFull(dir, { bitcoin = false, fetch = globalThis.fetch } = {}) {
  const files = loadLog(dir);
  const { anchors, certs } = shippedCerts();
  const res = await V.checkLog(V.readLog(files), {
    anchors, certs, bitcoin: bitcoin ? (att) => ots.checkBlock(fetch, att) : null
  });
  return withDisk(dir, files, res);
}

const when = (ms) => (ms == null ? '?' : new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z'));
const span = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
};

function report(dir, res) {
  const lines = [`Scribe's Log: ${dir}`];
  for (const p of res.problems) lines.push('  problem: ' + p);
  res.devices.forEach((d, i) => {
    const newest = i === res.devices.length - 1;
    lines.push(`${d.name} (${d.dev.slice(0, 8)})${newest ? ', wrote last' : ''}: ${d.chunks} chunk(s), ${d.entries} entries, ${d.ok && !d.problems.length ? 'intact' : 'DAMAGED'}`);
    lines.push('  kinds:   ' + Object.entries(d.kinds).map(([k, n]) => `${k} ${n}`).join(', '));
    lines.push('  sources: ' + (Object.entries(d.sources).map(([k, n]) => `${k} ${n}`).join(', ') || '(none)'));
    if (d.copiedFrom.length) lines.push('  copied from the book with log ' + d.copiedFrom.join(', '));
    lines.push(`  moves traced: ${d.moves} entr${d.moves === 1 ? 'y' : 'ies'}`);
    const a = d.arrivals;
    if (a && a.recorded + a.matched + a.unlinked) {
      lines.push(`  arrived from another device: ${a.recorded} recorded, ${a.matched} matched by text, ${a.unlinked} unlinked` +
        (Object.keys(a.from).length ? ' (' + Object.entries(a.from).map(([k, n]) => `${k} ${n}`).join(', ') + ')' : ''));
    }
    if (d.made) {
      const all = Object.values(d.made).reduce((x, n) => x + n, 0);
      lines.push('  manuscript: ' + (Object.entries(d.made).sort((x, y) => y[1] - x[1])
        .map(([k, n]) => `${k} ${n} (${Math.round(1000 * n / all) / 10}%)`).join(', ') || '(empty)'));
    }
    for (const p of d.problems.slice(0, 20)) lines.push('  problem: ' + JSON.stringify(p));
    for (const n of d.notes) lines.push('  note: ' + JSON.stringify(n));
    lines.push(d.differ.length
      ? `  replay differs from disk in: ${d.differ.join(', ')}`
      : '  replay matches the disk exactly');
    const cov = res.coverage && res.coverage.get(d.dev);
    if (cov) {
      const last = cov.stamps[cov.stamps.length - 1];
      lines.push(`  timestamps: ${cov.stamps.length} stamped entr${cov.stamps.length === 1 ? 'y' : 'ies'}` +
        (last ? `, last #${last.n} at ${when(last.time)} (${last.svcs.join(', ')})` : ''));
      if (cov.longest && cov.longest.ms) lines.push(`  longest writing between stamps: ${span(cov.longest.ms)} (#${cov.longest.from}–#${cov.longest.to})`);
      if (cov.tail) lines.push(`  not yet stamped: #${cov.tail.from}–#${cov.tail.to}, ${cov.tail.edits} edit(s), times as the computer reported them (${when(cov.tail.firstTs)} to ${when(cov.tail.lastTs)})`);
    }
  });
  for (const n of res.notes || []) lines.push('note: ' + JSON.stringify(n));
  if (res.receipts) {
    const rc = Object.entries(res.receipts.counts);
    lines.push('receipts: ' + (rc.map(([k, n]) => `${k} ${n}`).join(', ') || '(none)'));
    const se = res.receipts.stampEntries;
    lines.push(`stamp entries: ${se.matched} matched to receipts, ${se.missing.length} missing`);
    for (const r of res.receipts.results) {
      if (r.status === 'bitcoin') for (const b of r.bitcoin) lines.push(`  ${r.dev.slice(0, 8)} #${r.n}: Bitcoin block ${b.height}, merkle root ${b.root} (not checked; --bitcoin checks it)`);
      if (r.kind === 'ots' && r.status === 'ok') lines.push(`  ${r.dev.slice(0, 8)} #${r.n}: Bitcoin block ${r.bitcoin.map((b) => b.height).join(', ')} at ${when(r.time)}`);
      if (r.status === 'unchecked') lines.push(`  ${r.file}: #${r.n} ${r.svc} couldn't be checked: ${r.problems.join('; ')}`);
    }
    for (const p of res.receipts.problems) lines.push('  problem: ' + JSON.stringify(p));
  }
  if (res.clock) {
    lines.push(res.clock.length ? 'clock:' : 'clock: nothing flagged');
    const say = { back: 'clock went back', forward: 'clock jumped ahead (not a wake)', 'receipt-skew': 'receipt time and request differ', 'receipt-before-entry': 'receipt dated before its entry' };
    for (const f of res.clock) lines.push(`  ${f.dev.slice(0, 8)} #${f.n}: ${say[f.kind] || f.kind} by ${span(Math.abs(f.ms))}${f.svc ? ' (' + f.svc + ')' : ''}`);
  }
  lines.push(res.ok ? 'OK' : 'NOT OK');
  return lines.join('\n');
}

if (require.main === module) {
  // (PowerShell's Tab completion ends a folder with \, and \" before the
  // closing quote reaches here as a quote of its own)
  const args = process.argv.slice(2);
  const dir = (args.find((a) => !a.startsWith('--')) || '').replace(/"+$/, '');
  if (!dir) {
    console.error('usage: node scripts/slog-check.js "<book folder>" [--bitcoin]');
    process.exit(2);
  }
  checkBookFull(path.resolve(dir), { bitcoin: args.includes('--bitcoin') }).then((res) => {
    console.log(report(dir, res));
    process.exit(res.ok ? 0 : 1);
  }, (err) => {
    console.error(err);
    process.exit(2);
  });
}

module.exports = { checkBook, checkBookFull, loadLog, report };
