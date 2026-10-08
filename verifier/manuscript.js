// THE SCRIBE'S LOG, MATCHED: a manuscript someone holds (.txt or .docx)
// checked against the fingerprint a log ends on. Plain JavaScript with no
// Node or Electron APIs, so the verifier page and the tests run the same file.
//
// The fingerprint is SHA-256 of the manuscript's prose, normalized (see
// normalizeManuscript in slog-verify.js): every paragraph of every chapter
// in order, scene breaks as ***, whitespace runs as one space. NEO's own
// .txt and .docx exports add lines the fingerprint doesn't cover (the title
// page, chapter headings, a contents page). An export's manifest carries
// the SHA-256 of each such line (`manuscript.added`), so those lines are
// dropped here by their hashes, without the export ever holding them.
//
//   textLines(bytes)            a .txt's lines (UTF-8, or UTF-16 with a BOM)
//   docxLines(bytes, inflate)   a .docx's paragraphs, a line break inside
//                               one splitting it into lines
//   readManuscript(name, bytes, inflate)   either, by the file's name
//   matchManuscript(lines, opts)           the check

'use strict';

(function (exports) {
  const hasRequire = typeof require === 'function';
  const V = hasRequire ? require('../slog-verify.js') : globalThis.SlogVerify;
  const Z = hasRequire ? require('../slog-zip.js') : globalThis.SlogZip;

  // A text file's lines. A byte-order mark says UTF-16 (Notepad's
  // "Unicode"); anything else is read as UTF-8.
  function textLines(bytes) {
    let text;
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le').decode(bytes.subarray(2));
    else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be').decode(bytes.subarray(2));
    else text = new TextDecoder('utf-8').decode(bytes).replace(/^\ufeff/, '');
    return text.split(/\r\n|[\r\n\f\u2028\u2029\u0085]/);
  }

  const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };
  function decodeXml(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] !== '#') return XML_ENTITIES[e.toLowerCase()] ?? m;
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    });
  }

  // The paragraphs of word/document.xml as lines: the text of its runs
  // (w:t), a tab as a tab, a line or page break (w:br, w:cr) as a new
  // line. Deleted text (w:delText under tracked changes), field codes and
  // a text box's fallback copy aren't text of the paragraph.
  function documentXmlLines(xml) {
    const lines = [];
    let cur = null;
    const depth = []; // open paragraphs (a text box can hold paragraphs inside one)
    let inText = false;
    let skip = 0; // inside mc:Fallback
    const TOK = /<(\/?)([\w:.-]+)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
    for (const m of xml.matchAll(TOK)) {
      if (m[4] !== undefined) {
        if (inText && !skip && cur) cur.push(decodeXml(m[4]));
        continue;
      }
      const close = m[1] === '/';
      const name = m[2];
      const selfClosing = /\/\s*$/.test(m[3]);
      if (name === 'mc:Fallback') {
        if (!close && !selfClosing) skip++;
        else if (close) skip = Math.max(0, skip - 1);
        continue;
      }
      if (skip) continue;
      if (name === 'w:p') {
        if (selfClosing) { lines.push(''); continue; }
        if (!close) { if (cur) depth.push(cur); cur = []; } else if (cur) {
          lines.push(...cur.join('').split('\n'));
          cur = depth.length ? depth.pop() : null;
        }
        continue;
      }
      if (name === 'w:t') { inText = !close && !selfClosing; continue; }
      if (!cur || close) continue;
      if (name === 'w:tab') cur.push('\t');
      else if (name === 'w:br' || name === 'w:cr') cur.push('\n');
      else if (name === 'w:noBreakHyphen') cur.push('-');
    }
    return lines;
  }

  // A .docx's lines. inflate: as SlogZip.unzip takes it (the browser's
  // DecompressionStream by default)
  async function docxLines(bytes, inflate) {
    const z = await Z.unzip(bytes, inflate);
    const doc = z.files['word/document.xml'];
    if (!doc) throw new Error('not a Word document (no word/document.xml)');
    return documentXmlLines(new TextDecoder('utf-8').decode(doc));
  }

  // A manuscript file by its name: { kind: 'txt' | 'docx', lines }
  async function readManuscript(name, bytes, inflate) {
    if (/\.docx$/i.test(name)) return { kind: 'docx', lines: await docxLines(bytes, inflate) };
    if (/\.(txt|text)$/i.test(name)) return { kind: 'txt', lines: textLines(bytes) };
    throw new Error('a manuscript is a .txt or .docx file');
  }

  // A line as the fingerprint normalizes text, and its hash (as the
  // manifest's `added` lists them)
  const norm = (s) => V.normalizeManuscript(s);
  const lineHash = (s) => V.sha256hex(s);

  // lines: the manuscript's lines. opts: { hashes (the fingerprints it may
  // match: the log's last, the export's), added (hashes of the lines NEO's
  // exports add), expected (the manuscript's own lines, when the log has its
  // words) }. Returns { matched, hash (the one matched), dropped (lines
  // left out as NEO's own), as ('without NEO's lines' | 'as it is'),
  // computed (this file's fingerprint with NEO's lines left out), partTitles
  // (headings of titled parts found, which a .txt sets in capitals), diff
  // (when not matched and expected is given: the first line that differs) }.
  function matchManuscript(lines, { hashes = [], added = [], expected = null } = {}) {
    const want = new Set(hashes.filter((h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)));
    const addedSet = new Set(added);
    const all = lines.map(norm).filter(Boolean);
    const kept = [];
    let dropped = 0;
    let partTitles = 0;
    for (const line of all) {
      if (addedSet.has(lineHash(line))) { dropped++; continue; }
      // "PART I: THE TITLE": a titled part's heading, which the .txt sets
      // as one line in capitals; its title is in the manuscript as written
      const colon = line.indexOf(': ');
      if (colon > 0 && addedSet.size && addedSet.has(lineHash(line.slice(0, colon)))) partTitles++;
      kept.push(line);
    }
    const tries = [
      { as: 'without NEO\'s lines', lines: kept },
      { as: 'as it is', lines: all }
    ];
    const out = { matched: false, hash: null, dropped, partTitles, as: null, computed: V.manuscriptHash(kept.join('\n')), diff: null, lines: kept.length };
    for (const tr of tries) {
      const h = V.manuscriptHash(tr.lines.join('\n'));
      if (want.has(h)) {
        out.matched = true;
        out.hash = h;
        out.as = tr.as;
        out.dropped = tr.lines === kept ? dropped : 0;
        return out;
      }
    }
    if (Array.isArray(expected)) out.diff = firstDifference(kept, expected.map(norm).filter(Boolean));
    return out;
  }

  // Where two manuscripts' lines first part ways: { line (1-based, in the
  // manuscript's lines), theirs, ours } with a little of each, or
  // { extra / missing } when one simply runs on past the other
  function firstDifference(theirs, ours) {
    const n = Math.min(theirs.length, ours.length);
    for (let i = 0; i < n; i++) {
      if (theirs[i] === ours[i]) continue;
      let at = 0;
      while (at < theirs[i].length && theirs[i][at] === ours[i][at]) at++;
      const clip = (s) => (at > 30 ? '…' : '') + s.slice(Math.max(0, at - 30), at + 50) + (s.length > at + 50 ? '…' : '');
      return { line: i + 1, theirs: clip(theirs[i]), ours: clip(ours[i]) };
    }
    if (theirs.length > ours.length) return { line: n + 1, extra: theirs.length - n, theirs: theirs[n].slice(0, 80) };
    if (ours.length > theirs.length) return { line: n + 1, missing: ours.length - n, ours: ours[n].slice(0, 80) };
    return null;
  }

  // The manuscript's lines from a log's words: the documents as a device's
  // chain left them ({ doc: text or null })
  function expectedLines(docs) {
    const text = {};
    for (const [k, v] of Object.entries(docs || {})) if (typeof v === 'string') text[k] = v;
    return V.manuscriptText(text).split('\n');
  }

  Object.assign(exports, { textLines, documentXmlLines, docxLines, readManuscript, matchManuscript, firstDifference, expectedLines, decodeXml });
})(typeof module !== 'undefined' && module.exports ? module.exports : (globalThis.SlogManuscript = {}));
