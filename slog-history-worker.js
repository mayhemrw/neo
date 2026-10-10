'use strict';

// The History window's reading of a book's past, in its own process: the
// first look at a long book's log takes seconds (every session replayed),
// and NEO's window must never wait on that. main.js forks this with
// Electron's utilityProcess (as it does spell-worker.js) and asks it, one
// message at a time:
//
//   { id, type: 'list', home, dir }            History.list
//   { id, type: 'text', home, dir, ref, chapter }  versionText
//   { id, type: 'titles', home, dir, ref }      versionTitles
//   { id, type: 'restore', home, dir, ref, chapter, me, at, logged }
//                                              restoreSource
//   { id, type: 'playback', home, dir, chapter, from }  playback (data)
//   { id, type: 'scan', home, dir, budget }    origin tracing before an
//                                              export or a report
//                                              (slog-relink.js): the
//                                              relinks to write
//
// and gets back { id, ok: true, value } or { id, ok: false, error }, with
// any trouble the reading reported along the way in `notes`. Nothing here
// writes to the book; checkpoints and the index cache go in `home`
// (userData/slog/history), this computer's own.

const { History } = require('./slog-history.js');

let history = null;
function reply(msg) {
  const notes = [];
  try {
    if (!msg || typeof msg.home !== 'string' || typeof msg.dir !== 'string') throw new Error('no book');
    if (!history || history.home !== msg.home) history = new History({ home: msg.home });
    history.onError = (where, err) => notes.push(where + ': ' + ((err && err.message) || err));
    let value;
    if (msg.type === 'list') value = history.list(msg.dir);
    else if (msg.type === 'text') value = history.versionText(msg.dir, msg.ref, msg.chapter);
    else if (msg.type === 'titles') value = history.versionTitles(msg.dir, msg.ref);
    else if (msg.type === 'restore') value = history.restoreSource(msg.dir, msg.ref, msg.chapter, { me: msg.me, at: msg.at, logged: msg.logged });
    else if (msg.type === 'playback') value = history.playback(msg.dir, msg.chapter, { from: msg.from });
    else if (msg.type === 'scan') value = scanBook(msg.dir, msg.budget);
    else throw new Error('unknown request: ' + msg.type);
    return { id: msg.id, ok: true, value, notes };
  } catch (err) {
    return { id: msg && msg.id, ok: false, error: (err && err.message) || String(err), notes };
  }
}

// A book's whole log read (archives too) and scanned: { relinks, skipped, cut }
function scanBook(dir, budget) {
  const V = require('./slog-verify.js');
  const F = require('./slog-files.js');
  const paths = V.logPaths(F.loadLog(dir));
  const log = Object.keys(paths).some(V.isArchiveName)
    ? V.readLog(paths, { expanded: V.expandArchivesSync(paths, (b) => require('zlib').inflateRawSync(b)) })
    : V.readLog(paths);
  return require('./slog-relink.js').scanLog(log, { budget: Number.isFinite(budget) ? budget : 0 });
}

if (process.parentPort) process.parentPort.on('message', (e) => process.parentPort.postMessage(reply(e.data)));

module.exports = { reply };
