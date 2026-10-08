// THE SCRIBE'S LOG, VERIFIED: what the standalone verifier page does with
// what it's given, apart from the page itself (page.js). Plain JavaScript
// with no Node, Electron or DOM APIs, so the tests run this same file.
//
//   sortInput(items)     what was dropped, sorted: the log (an export, a
//                        scribes-log folder, an archive) and any manuscripts
//   checkInput(log)      the log checked (slog-verify.js checkLog) and
//                        counted for the report (slog-report.js reportStats)
//   bitcoinBlocks(check) the Bitcoin attestations, for the button and by hand
//   matchFile(check, f)  a manuscript matched against the log's fingerprint
//   summarize(check)     what checked, what couldn't be checked and why, in
//                        plain words: [{ status, title, lines }]
//
// items: [{ name, bytes }], name being the path as dropped ("a/b/c.slog",
// or just "c.slog"), bytes a Uint8Array.

'use strict';

(function (exports) {
  const hasRequire = typeof require === 'function';
  const V = hasRequire ? require('../slog-verify.js') : globalThis.SlogVerify;
  const Z = hasRequire ? require('../slog-zip.js') : globalThis.SlogZip;
  const R = hasRequire ? require('../slog-report.js') : globalThis.SlogReport;
  const M = hasRequire ? require('./manuscript.js') : globalThis.SlogManuscript;

  const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
  const isManuscriptName = (p) => /\.(txt|text|docx)$/i.test(p);
  // what a computer leaves in a folder by itself
  const isJunk = (p) => /(^|\/)(\.[^/]*|desktop\.ini|Thumbs\.db|__MACOSX\/.*)$/i.test(p) || p.includes('__MACOSX/');

  // The files under `root` ("" or "a/b/"), at paths relative to it
  function under(files, root) {
    const out = {};
    for (const [p, b] of Object.entries(files)) if (p.startsWith(root) && !isJunk(p.slice(root.length))) out[p.slice(root.length)] = b;
    return out;
  }
  // Where a log starts in a set of paths: the folder holding manifest.json
  // (an export, unzipped) or log.json (a scribes-log folder), the shallowest
  function findRoot(paths) {
    const roots = paths.filter((p) => !isJunk(p) && (baseOf(p) === 'manifest.json' || baseOf(p) === 'log.json'))
      .map((p) => ({ dir: dirOf(p), kind: baseOf(p) === 'manifest.json' ? 'export' : 'folder' }))
      .sort((a, b) => a.dir.split('/').length - b.dir.split('/').length || (a.kind === 'export' ? -1 : 1));
    return roots[0] || null;
  }

  // Dropped files sorted into { logs: [{ kind: 'export' | 'folder' |
  // 'archive', label, files, zipProblems }], manuscripts: [{ name, bytes }],
  // ignored: [name] }. A zip is opened to see what it is. inflate: as
  // SlogZip.unzip takes it.
  async function sortInput(items, { inflate } = {}) {
    const out = { logs: [], manuscripts: [], ignored: [] };
    const loose = {};
    for (const it of items) {
      const p = it.name.replace(/\\/g, '/').replace(/^\/+/, '');
      if (isJunk(p)) continue;
      if (/\.zip$/i.test(p) && !V.isArchiveName(baseOf(p))) {
        let z;
        try { z = await Z.unzip(it.bytes, inflate); } catch (err) { out.ignored.push(`${baseOf(p)} (it can't be opened as a zip: ${err.message})`); continue; }
        const root = findRoot(Object.keys(z.files));
        if (!root) { out.ignored.push(`${baseOf(p)} (no Scribe's Log in it)`); continue; }
        out.logs.push({ kind: root.kind, label: baseOf(p), files: under(z.files, root.dir), zipProblems: z.problems });
        continue;
      }
      loose[p] = it.bytes;
    }
    // files dropped one by one, or folders: the logs in them first
    const paths = Object.keys(loose);
    const taken = new Set();
    for (;;) {
      const root = findRoot(paths.filter((p) => !taken.has(p)));
      if (!root) break;
      const mine = paths.filter((p) => !taken.has(p) && p.startsWith(root.dir));
      for (const p of mine) taken.add(p);
      const files = under(Object.fromEntries(mine.map((p) => [p, loose[p]])), root.dir);
      const label = root.dir ? root.dir.replace(/\/$/, '') : (root.kind === 'export' ? 'the files dropped' : 'scribes-log');
      if (root.kind === 'export') { out.logs.push({ kind: 'export', label, files, zipProblems: [] }); continue; }
      // a folder's receipts and certificates are where readLog wants them
      // already; dropped one by one, they're put there
      const placed = {};
      for (const [q, b] of Object.entries(files)) {
        const name = baseOf(q);
        if (!q.includes('/') && V.RECEIPT_RE.test(name)) placed['stamps/' + name] = b;
        else if (!q.includes('/') && /^[0-9a-f]{64}\.der$/.test(name)) placed['stamps/certs/' + name] = b;
        else placed[q] = b;
      }
      out.logs.push({ kind: Object.keys(placed).some((q) => V.isArchiveName(q)) && !Object.keys(placed).some((q) => V.isChunkName(q)) ? 'archive' : 'folder', label, files: placed, zipProblems: [] });
    }
    for (const p of paths) {
      if (taken.has(p)) continue;
      const name = baseOf(p);
      if (isManuscriptName(name)) out.manuscripts.push({ name, bytes: loose[p] });
      else if (V.isArchiveName(name)) out.logs.push({ kind: 'archive', label: name, files: { [name]: loose[p] }, zipProblems: [] });
      else if (V.isChunkName(name) || V.RECEIPT_RE.test(name)) out.logs.push({ kind: 'folder', label: name, files: { [name]: loose[p] }, zipProblems: [] });
      else out.ignored.push(name);
    }
    // loose chunks and archives without their log.json: one log
    const bits = out.logs.filter((l) => !l.files['log.json'] && !l.files['manifest.json']);
    if (bits.length > 1) {
      out.logs = out.logs.filter((l) => !bits.includes(l));
      out.logs.push({ kind: 'folder', label: 'the files dropped', files: Object.assign({}, ...bits.map((b) => b.files)), zipProblems: [] });
    }
    return out;
  }

  // A log checked: { kind, label, manifest, exportProblems, res, stats }.
  // opts: { anchors, certs (the authorities trusted), inflate, bitcoin
  // (att → { ok, time, block } or null: blocks aren't checked) }
  async function checkInput(log, { anchors = [], certs = [], inflate, bitcoin = null } = {}) {
    let manifest = null;
    let exportProblems = [];
    let files = log.files;
    if (log.kind === 'export') {
      const ex = V.readExportFiles(log.files, log.zipProblems || []);
      manifest = ex.manifest;
      exportProblems = ex.problems;
      files = ex.files;
    } else if (log.zipProblems && log.zipProblems.length) exportProblems = log.zipProblems.slice();
    const res = await V.checkLog(files, { anchors, certs, inflate, bitcoin });
    res.problems = [...exportProblems, ...res.problems];
    res.ok = res.ok && !exportProblems.length;
    const stats = R.reportStats(res, { manifest });
    return { kind: log.kind, label: log.label, manifest, exportProblems, res, stats, bitcoinChecked: !!bitcoin };
  }

  // The Bitcoin attestations in a checked log, one per block: { height,
  // msg (the merkle root the block must hold, as the explorer shows it),
  // proofs, checked ({ ok, time, error } once looked up) }
  function bitcoinBlocks(check) {
    const by = new Map();
    for (const r of check.res.receipts.results) {
      for (const att of r.bitcoin || []) {
        const k = att.height + ':' + att.msg;
        if (!by.has(k)) by.set(k, { height: att.height, msg: att.msg, root: rootAsShown(att.msg), proofs: 0, checked: att.checked || null });
        by.get(k).proofs++;
      }
    }
    return [...by.values()].sort((a, b) => a.height - b.height);
  }
  // A block explorer shows the merkle root byte-reversed (as block ids are)
  const rootAsShown = (hex) => (typeof hex === 'string' ? hex.match(/../g).reverse().join('') : '');

  // A manuscript file matched against the log: { name, kind, ...matchManuscript's }
  // or { name, error }
  async function matchFile(check, file, { inflate } = {}) {
    let read;
    try { read = await M.readManuscript(file.name, file.bytes, inflate); } catch (err) { return { name: file.name, error: err.message }; }
    const m = check.manifest && check.manifest.manuscript;
    const hashes = [check.stats.manuscript && check.stats.manuscript.hash, m && m.hash].filter(Boolean);
    const newest = check.res.newest;
    const expected = check.res.words && newest ? M.expectedLines(newest.docs) : null;
    const r = M.matchManuscript(read.lines, { hashes, added: (m && Array.isArray(m.added)) ? m.added : [], expected });
    return { name: file.name, kind: read.kind, ...r, fingerprints: hashes.length };
  }

  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const fmt = (n) => Number(n || 0).toLocaleString('en');
  const svcName = (svc) => (svc === 'ots' ? 'OpenTimestamps' : svc === 'freetsa' ? 'FreeTSA' : svc);

  // What checked, in plain words. Each item: { key, status: 'ok' | 'bad' |
  // 'warn' (couldn't be checked, or not covered) | 'info', title, lines }.
  // opts: { matches (matchFile's results), when (ms → text, as the
  // privacy setting allows) }
  function summarize(check, { matches = [], when = (ms) => new Date(ms).toISOString().slice(0, 10) } = {}) {
    const { res, stats, manifest } = check;
    const items = [];
    const item = (key, status, title, lines = []) => items.push({ key, status, title, lines: lines.filter(Boolean) });

    // the export's own files
    if (check.kind === 'export') {
      const listed = manifest && Array.isArray(manifest.files) ? manifest.files.length : 0;
      if (check.exportProblems.length) item('files', 'bad', 'The export\'s files don\'t match its manifest', check.exportProblems.slice(0, 12).concat(check.exportProblems.length > 12 ? [`…and ${check.exportProblems.length - 12} more`] : []));
      else item('files', 'ok', `All ${fmt(listed)} files are exactly the ones its manifest lists`, ['Each file\'s size and SHA-256 match manifest.json.']);
    } else if (check.exportProblems.length) item('files', 'bad', 'Some files couldn\'t be read', check.exportProblems.slice(0, 12));

    // the chains
    const devs = res.devices;
    const damaged = devs.filter((d) => !d.ok);
    const logProblems = res.problems.filter((p) => !check.exportProblems.includes(p));
    if (!devs.length) item('chains', 'bad', 'There\'s no log here to check', logProblems.slice(0, 12));
    else if (damaged.length || logProblems.length) {
      item('chains', 'bad', 'Something in the log doesn\'t check', [
        ...logProblems.slice(0, 8).map(String),
        ...damaged.flatMap((d) => d.problems.slice(0, 8).map((p) => `${d.name}: ${typeof p === 'string' ? p : (p.problem || JSON.stringify(p))}${p && p.n ? ' (entry ' + p.n + ')' : ''}`))
      ]);
    } else {
      const entries = devs.reduce((a, d) => a + d.entries.length, 0);
      const sessions = devs.reduce((a, d) => a + d.chunks.length, 0);
      item('chains', 'ok', devs.length === 1 ? 'The log is complete and unaltered' : `All ${devs.length} devices' logs are complete and unaltered`, [
        `${plural(sessions, 'session', 'sessions')}, ${fmt(entries)} entries${devs.length > 1 ? ' on ' + devs.length + ' devices' : ''}: each entry is linked to the one before it by its hash, none missing, none changed.`,
        res.words
          ? 'Replayed from the first entry to the last, the changes rebuild the book step by step, and every word matches the seal it was recorded with.'
          : 'Replayed from the first entry to the last, the changes fit together step by step. (This log was shared without its text, so the words themselves aren\'t here to check.)',
        stats.archives.length ? `Read with ${plural(stats.archives.length, 'archive', 'archives')} (Merge Log into Archive).` : ''
      ]);
    }
    for (const d of devs) {
      if (d.copiedFrom && d.copiedFrom.length) item('copied-' + d.dev, 'info', `${d.name}: the book began as a copy of another book`, [`Copied from the book whose log is ${d.copiedFrom.join(', ')}; that text counts as another book's, not as typed.`]);
    }

    // text from another device
    if (devs.length > 1) {
      const a = devs.reduce((x, d) => ({ recorded: x.recorded + d.arrivals.recorded, matched: x.matched + d.arrivals.matched, unlinked: x.unlinked + d.arrivals.unlinked }), { recorded: 0, matched: 0, unlinked: 0 });
      if (a.recorded + a.matched + a.unlinked) {
        item('arrivals', a.unlinked ? 'warn' : 'ok', a.unlinked ? 'Some text that came from another device couldn\'t be traced' : 'Text that came from another device was traced to it', [
          `${fmt(a.recorded)} recorded when it arrived${a.matched ? ', ' + fmt(a.matched) + ' matched by its words' : ''}${a.unlinked ? ', ' + fmt(a.unlinked) + ' not traced (it counts as "arrived from another device")' : ''}.`
        ]);
      }
    }

    // outside timestamps
    const results = res.receipts.results;
    // (counted as the report counts them: a pending proof whose finished
    // copy came later isn't waiting any more)
    const by = stats.receipts.bySvc;
    const superseded = stats.receipts.superseded || 0;
    const st = res.receipts.stampEntries;
    if (!results.length && !(st.missing && st.missing.length)) {
      item('stamps', 'warn', 'No outside timestamps', ['Every time in this log is as the computer reported it. (Logs written before NEO stamped them, or never online, have none.)']);
    } else {
      const failed = results.filter((r) => r.status === 'failed');
      const unchecked = results.filter((r) => r.status === 'unchecked');
      const ok = results.filter((r) => r.status === 'ok' && r.kind === 'rfc3161').length;
      const lines = [];
      for (const [svc, s] of Object.entries(by)) {
        lines.push(`${svcName(svc)}: ` + Object.entries(s).map(([k, v]) => `${fmt(v)} ${({ ok: 'checked', bitcoin: 'in a Bitcoin block', pending: 'waiting for Bitcoin', unchecked: 'couldn\'t be checked', failed: 'failed' })[k] || k}`).join(', '));
      }
      if (st.matched || st.missing.length) lines.push(`Stamp entries in the log: ${fmt(st.matched)} matched to their receipts${st.missing.length ? ', ' + fmt(st.missing.length) + ' whose receipt is missing' : ''}.`);
      if (superseded) lines.push(`${plural(superseded, 'earlier OpenTimestamps receipt is', 'earlier OpenTimestamps receipts are')} the pending copy of a proof since confirmed in Bitcoin, so not counted again.`);
      const pending = stats.receipts.pending;
      if (pending) lines.push('"Waiting for Bitcoin" is an OpenTimestamps proof that NEO hadn\'t yet collected from Bitcoin when this was made (that takes hours, and NEO keeps asking for two weeks); FreeTSA\'s receipt dates those stretches.');
      if (failed.length || st.missing.length || res.receipts.problems.length) {
        item('stamps', 'bad', 'Some outside timestamps don\'t check', [...lines, ...res.receipts.problems.slice(0, 8).map((p) => p.problem + (p.n ? ' (entry ' + p.n + ')' : ''))]);
      } else if (unchecked.length) {
        const why = [...new Set(unchecked.flatMap((r) => r.problems))];
        item('stamps', 'warn', `${fmt(ok)} outside timestamps check; ${fmt(unchecked.length)} couldn't be checked here`, [...lines, 'Why: ' + why.slice(0, 3).join('; ') + (why.some((w) => /trusted root|certificate/.test(w)) ? ' (signed by an authority this verifier doesn\'t trust)' : '')]);
      } else item('stamps', 'ok', `${fmt(ok)} outside timestamps check`, [...lines, 'Each receipt is signed by a timestamping authority whose certificate this verifier carries (never one taken from the log), for exactly the fingerprint of the entry it names.']);
      const rc = stats.receipts;
      for (const tl of rc.tails) {
        const a = when(tl.firstTs);
        const b = when(tl.lastTs);
        item('tail-' + tl.dev, 'warn', `${tl.name}: the last stretch isn't covered by an outside timestamp`, [`The writing after the last receipt (${a === b ? a : a + ' to ' + b}) is dated only by the computer's clock.`]);
      }
    }

    // Bitcoin
    const blocks = bitcoinBlocks(check);
    if (blocks.length) {
      const checked = blocks.filter((b) => b.checked);
      const good = checked.filter((b) => b.checked.ok);
      const lines = blocks.map((b) => `Block ${b.height}: merkle root ${b.root}${b.checked ? (b.checked.ok ? ' — matches the block (' + when(b.checked.time) + ')' : ' — ' + b.checked.error) : ''}`);
      if (!checked.length) item('bitcoin', 'warn', `${plural(blocks.length, 'Bitcoin block', 'Bitcoin blocks')} to check`, ['The OpenTimestamps proofs lead to these blocks. Checking them needs the block headers, from a public block explorer: press Check against Bitcoin, or look each block up yourself (any explorer shows a block\'s merkle root).', ...lines]);
      else if (good.length === blocks.length) item('bitcoin', 'ok', `Confirmed in ${plural(blocks.length, 'Bitcoin block', 'Bitcoin blocks')}`, lines);
      else {
        // a block that doesn't hold the root is a failure; an explorer that
        // couldn't be reached only means it wasn't checked
        const wrong = checked.some((b) => !b.checked.ok && /header|merkle root|80 bytes/.test(b.checked.error || ''));
        item('bitcoin', wrong ? 'bad' : 'warn', wrong ? 'A Bitcoin block doesn\'t hold what its proof says' : 'Not every Bitcoin block could be checked', lines);
      }
    }

    // the clock
    const clock = stats.flags.clock;
    if (clock.length) item('clock', 'warn', `The clock check flagged ${plural(clock.length, 'moment', 'moments')}`, clock.slice(0, 8).map((c) => `${c.name}, ${c.ts ? when(c.ts) : '?'}: ${({ back: 'the clock went back', forward: 'the clock jumped ahead, not on waking', 'receipt-skew': 'an outside timestamp and the computer\'s clock far apart', 'receipt-before-entry': 'an outside timestamp earlier than the entry it covers' })[c.kind] || c.kind} (${Math.round(Math.abs(c.ms) / 60000)} min)`));
    else item('clock', 'ok', 'The clock check found nothing', ['The computer\'s clock never jumped back or ahead (except on waking), and every outside timestamp agrees with it.']);
    if (stats.flags.unclosed.length) item('unclosed', 'info', `${plural(stats.flags.unclosed.length, 'session', 'sessions')} ended without closing`, ['NEO quit unexpectedly or the computer lost power. Nothing is lost: the next session carries on from the last entry.']);

    // the manuscript
    const fp = stats.manuscript;
    if (!matches.length) {
      item('manuscript', 'info', 'No manuscript checked', [fp ? 'Drop the manuscript (.txt or .docx) here to check it against the fingerprint the log ends on.' : 'The log has no manuscript fingerprint yet: no session has closed.']);
    }
    for (const mt of matches) {
      if (mt.error) { item('ms-' + mt.name, 'bad', `${mt.name} couldn't be read`, [mt.error]); continue; }
      if (mt.matched) {
        item('ms-' + mt.name, 'ok', `${mt.name} matches the manuscript exactly`, [
          mt.dropped ? `With the ${fmt(mt.dropped)} lines NEO's own export adds (the title page and headings) left out, its text's fingerprint is the log's: ${mt.hash}.` : `Its text's fingerprint is the log's: ${mt.hash}.`
        ]);
        continue;
      }
      const why = [];
      if (!mt.fingerprints) why.push('The log has no manuscript fingerprint to match: no session has closed.');
      else why.push(`Its fingerprint (with ${fmt(mt.dropped)} of NEO's own lines left out) is ${mt.computed}; the log ends on ${(fp && fp.hash) || '?'}.`);
      if (mt.diff) {
        if (mt.diff.extra) why.push(`It has ${fmt(mt.diff.extra)} more line(s) than the manuscript, from line ${mt.diff.line}: "${mt.diff.theirs}"`);
        else if (mt.diff.missing) why.push(`It stops ${fmt(mt.diff.missing)} line(s) short of the manuscript; the next would be "${mt.diff.ours}"`);
        else why.push(`They first differ at line ${mt.diff.line}: the file has "${mt.diff.theirs}", the log "${mt.diff.ours}".`);
      }
      if (mt.partTitles && mt.kind === 'txt') why.push('This book has titled parts, which NEO\'s .txt export sets in capitals. Try the .docx export instead.');
      if (check.kind !== 'export' && mt.fingerprints) why.push('A .txt or .docx exported from NEO carries a title page and headings; the export lists them (manifest.json), so check it against the export rather than a folder.');
      why.push('Any change at all, even one letter or a paragraph moved, changes the fingerprint. Whitespace and line breaks don\'t.');
      item('ms-' + mt.name, 'bad', `${mt.name} doesn't match the manuscript`, why);
    }
    return items;
  }

  // The verdict over everything: 'ok', 'warn' (all that could be checked
  // checks, but something couldn't be, or isn't covered) or 'bad'
  function verdict(items) {
    if (items.some((i) => i.status === 'bad')) return 'bad';
    if (items.some((i) => i.status === 'warn')) return 'warn';
    return 'ok';
  }

  Object.assign(exports, { sortInput, checkInput, bitcoinBlocks, rootAsShown, matchFile, summarize, verdict, findRoot, isJunk });
})(typeof module !== 'undefined' && module.exports ? module.exports : (globalThis.SlogVerifier = {}));
