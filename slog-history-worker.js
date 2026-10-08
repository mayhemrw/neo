'use strict';

// The History window's reading of a book's past, in its own process: the
// first look at a long book's log takes seconds (every session replayed),
// and NEO's window must never wait on that. main.js forks this with
// Electron's utilityProcess (as it does spell-worker.js) and asks it, one
// message at a time:
//
//   { id, type: 'list', home, dir }            History.list
//   { id, type: 'text', home, dir, ref, chapter }  versionText
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
    else throw new Error('unknown request: ' + msg.type);
    return { id: msg.id, ok: true, value, notes };
  } catch (err) {
    return { id: msg && msg.id, ok: false, error: (err && err.message) || String(err), notes };
  }
}

if (process.parentPort) process.parentPort.on('message', (e) => process.parentPort.postMessage(reply(e.data)));

module.exports = { reply };
