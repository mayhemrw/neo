// Drives the standalone verifier page (verifier.html) in an Electron window,
// for the e2e tests (verifier.e2e.js, slog.e2e.js): opened from a file,
// as someone double-clicking it would, in its own session with every
// network request stopped and noted unless a test answers it. Files go in
// through the page's own file input, as when they're chosen.

'use strict';

const { BrowserWindow, session } = require('electron');

let seq = 0;
// opts: { answer (url → { status, body } or null to stop it) }
async function openVerifier(file, { answer = null } = {}) {
  const partition = 'verifier-test-' + process.pid + '-' + (++seq);
  const ses = session.fromPartition(partition);
  const requests = [];
  ses.protocol.handle('https', async (req) => {
    requests.push(req.url);
    const a = answer ? await answer(req.url) : null;
    if (!a) return new Response('', { status: 503 });
    return new Response(a.body, { status: a.status || 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'text/plain' } });
  });
  ses.protocol.handle('http', (req) => { requests.push(req.url); return new Response('', { status: 503 }); });
  const win = new BrowserWindow({ show: false, width: 1000, height: 900, webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  win.webContents.on('preload-error', (e, p, err) => errors.push(String(err)));
  await win.loadFile(file);
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((err) => {
    throw new Error(`in the verifier page: ${err.message}\n  ${code.slice(0, 120)}\n  page errors: ${errors.join(' | ')}`);
  });
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  const waitDone = async (before) => {
    for (let i = 0; i < 600; i++) {
      if ((await js('window.verifierRuns()')) !== before) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('the verifier didn\'t finish');
  };
  const v = {
    win, requests, errors, js,
    // choose files with the page's own input
    async choose(paths, selector = '#files') {
      const before = await js('window.verifierRuns()');
      const { root } = await dbg.sendCommand('DOM.getDocument', { depth: 1 });
      const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector });
      await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files: paths });
      await waitDone(before);
      return v.read();
    },
    // as a dropped folder: [{ name (its path), bytes }] (base64 across)
    async drop(items) {
      const before = await js('window.verifierRuns()');
      const list = JSON.stringify(items.map((it) => ({ name: it.name, b64: Buffer.from(it.bytes).toString('base64') })));
      await js(`(() => { const items = ${list}.map((x) => ({ name: x.name, bytes: Uint8Array.from(atob(x.b64), (c) => c.charCodeAt(0)) })); window.verifierTake(items); })()`);
      await waitDone(before);
      return v.read();
    },
    async click(id) {
      const before = await js('window.verifierRuns()');
      await js(`document.getElementById(${JSON.stringify(id)}).click()`);
      await waitDone(before);
      return v.read();
    },
    async privacy(value) {
      await js(`(() => { const s = document.getElementById('privacy'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); })()`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return v.read();
    },
    // what the page shows: the verdict, each item, the report's text
    async read() {
      // (the report's frame loads a moment after the page shows the results)
      for (let i = 0; i < 50 && !(await js(`(() => { const d = document.getElementById('report').contentDocument; return document.getElementById('results').hidden || !!(d && d.body && d.body.innerText.trim()); })()`)); i++) await new Promise((resolve) => setTimeout(resolve, 100));
      return v.readNow();
    },
    readNow: () => js(`(() => {
      const f = document.getElementById('report');
      return {
        verdict: document.body.dataset.verdict || null,
        note: document.getElementById('note').hidden ? '' : document.getElementById('note').textContent,
        source: document.getElementById('source').textContent,
        items: [...document.querySelectorAll('#items li')].map((li) => ({ key: li.dataset.key, status: li.dataset.status, title: li.querySelector('.t').textContent, text: li.querySelector('.d').textContent })),
        bitcoinButton: !!document.getElementById('check-bitcoin'),
        report: f.contentDocument && f.contentDocument.body ? f.contentDocument.body.innerText : ''
      };
    })()`),
    close() { try { dbg.detach(); } catch { /* gone */ } win.destroy(); }
  };
  return v;
}

module.exports = { openVerifier };
