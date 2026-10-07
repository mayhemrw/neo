#!/usr/bin/env node
// Checks a book's Scribe's Log, for development (the writer's verifier
// comes later):
//
//   node scripts/slog-check.js "<book folder>"
//
// Every device's chain is checked (numbering, links, commitments, words),
// replayed from empty, and compared with the documents on disk. The chain
// written last should end in exactly what's on disk. Also counts entries by
// where their text came from: "unlogged" should be rare ("while off" is
// what changed while the log was switched off, and is expected).
//
// Exit code 0 when every chain is intact and the newest one matches the
// disk, 1 otherwise.

'use strict';
const fs = require('fs');
const path = require('path');
const slog = require('../slog.js');

function checkBook(dir) {
  const logDir = path.join(dir, slog.LOG_DIR);
  const out = { ok: false, problems: [], devices: [], disk: null };
  let info = null;
  try { info = JSON.parse(fs.readFileSync(path.join(logDir, slog.LOG_INFO), 'utf8')); } catch (err) {
    out.problems.push('no readable log.json: ' + err.message);
    return out;
  }
  const key = Buffer.from(String(info.key || ''), 'base64');
  const byDev = new Map();
  for (const name of fs.readdirSync(logDir).sort()) {
    if (!slog.isChunkName(name)) continue;
    const parsed = slog.parseChunk(fs.readFileSync(path.join(logDir, name), 'utf8'));
    const open = parsed.entries[0];
    const dev = open && open.kind === 'open' ? open.dev : 'unknown-' + name.split('-')[1].slice(0, 8);
    if (open && open.log !== info.logId) out.problems.push(`${name}: belongs to another log (${open.log})`);
    if (!byDev.has(dev)) byDev.set(dev, []);
    byDev.get(dev).push({ name, ...parsed });
  }
  const disk = slog.readBookDocs(dir).docs;
  out.disk = disk;
  for (const [dev, chunks] of byDev) {
    const v = slog.verifyChain(chunks, { key });
    const byName = new Map(chunks.map((c) => [c.name, c]));
    const entries = v.chunks.flatMap((n) => byName.get(n).entries);
    const r = slog.replay(entries);
    const sources = {};
    const kinds = {};
    for (const e of entries) {
      kinds[e.kind] = (kinds[e.kind] || 0) + 1;
      // changes made while the log was switched off are counted on their own:
      // they're expected, where any other unlogged entry is a gap
      const src = e.src === 'unlogged' && e.cause === 'off' ? 'while off' : e.src;
      if (src) sources[src] = (sources[src] || 0) + 1;
    }
    const docs = Object.fromEntries(Object.entries(r.docs).filter(([, t]) => t !== null));
    const differ = [...new Set([...Object.keys(docs), ...Object.keys(disk)])]
      .filter((d) => docs[d] !== disk[d]).sort();
    const last = entries[entries.length - 1];
    out.devices.push({
      dev, ok: v.ok, problems: [...v.problems, ...r.problems], notes: v.notes,
      chunks: v.chunks.length, entries: entries.length, lastTs: last ? last.ts : 0,
      kinds, sources, differ, docs
    });
  }
  out.devices.sort((a, b) => a.lastTs - b.lastTs);
  const newest = out.devices[out.devices.length - 1];
  if (!newest) out.problems.push('no chunks');
  out.ok = !out.problems.length && out.devices.every((d) => d.ok && !d.problems.length) && !!newest && !newest.differ.length;
  return out;
}

function report(dir, res) {
  const lines = [`Scribe's Log: ${dir}`];
  for (const p of res.problems) lines.push('  problem: ' + p);
  res.devices.forEach((d, i) => {
    const newest = i === res.devices.length - 1;
    lines.push(`device ${d.dev.slice(0, 8)}${newest ? ' (wrote last)' : ''}: ${d.chunks} chunk(s), ${d.entries} entries, ${d.ok && !d.problems.length ? 'intact' : 'DAMAGED'}`);
    lines.push('  kinds:   ' + Object.entries(d.kinds).map(([k, n]) => `${k} ${n}`).join(', '));
    lines.push('  sources: ' + (Object.entries(d.sources).map(([k, n]) => `${k} ${n}`).join(', ') || '(none)'));
    for (const p of d.problems.slice(0, 20)) lines.push('  problem: ' + JSON.stringify(p));
    for (const n of d.notes) lines.push('  note: ' + JSON.stringify(n));
    lines.push(d.differ.length
      ? `  replay differs from disk in: ${d.differ.join(', ')}`
      : '  replay matches the disk exactly');
  });
  lines.push(res.ok ? 'OK' : 'NOT OK');
  return lines.join('\n');
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node scripts/slog-check.js "<book folder>"');
    process.exit(2);
  }
  const res = checkBook(path.resolve(dir));
  console.log(report(dir, res));
  process.exit(res.ok ? 0 : 1);
}

module.exports = { checkBook, report };
